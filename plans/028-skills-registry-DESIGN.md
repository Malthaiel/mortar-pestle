# Skills Registry — Design Spike (Plan 028 deliverable)

> Spike output, not shipped code. Defines the index schema, the fetch-command
> contract, and the (non-negotiable) security control for turning the Skills
> Browser's static 3-entry demo file into a real, curated, fetchable registry.
> No fetching code ships from this spike. Two decisions are left to the
> maintainer (Open Questions). Stamped against repo HEAD after commit `57a6c80`;
> citations re-verified live (line numbers current as of this writing).

## Threat — why security is a requirement, not a nice-to-have

An installed skill is **not passive markdown**. Running one spawns a real local
agent process. `src-tauri/src/commands/skills.rs`:

- `skills_run` (L240) builds the prompt from the skill file:
  `compose_invocation(&skill, &args)` (L261).
- It then spawns a PTY child: `CommandBuilder::new("claude")` (L292),
  `cmd.cwd(vault_root())` (L295), inheriting the full process env.

So a fetched-and-installed skill becomes an **instruction to a local coding
agent (`claude -p <invocation>`) running in the vault root with the user's
environment and vault write access.** The trust boundary is: *a remote author's
markdown becomes a local agent instruction on the user's machine.* Therefore
"curated" must mean *provenance-gated* (allowlist / signature / hash), never
"we put it in a JSON file." The existing overwrite/uninstall confirm modals in
`SkillsBrowserTab.jsx` are UX, not security — they do not attest authorship.

## Current state (what "registry" means today)

- `modules/core/skills-browser/registry.json` — the entire registry: a static
  array of **3 entries**, bundled in the app, every one `"category": "demo"`
  (`hello`, `timestamp`, `vault-stats`), with the skill body **inlined** as a
  `content` string. No URL, hash, signature, or source field.
- `modules/core/skills-browser/api.js` — install is **vault-only**, no network:
  `install(id, content)` → `vault_write_file` to
  `Infrastructure/Skills/Slash/{id}.md`. It writes the inlined `content`
  straight from `registry.json`.
- `manifest.json:4` promises "Browse, install, **and update** skills from the
  bundled registry" — the update/fetch half does not exist.
  `"permissions": ["vault.read", "vault.write"]` — **no network permission
  declared**; a real fetch must add one.
- `Knowledge/Mortar & Pestle/Reference/PRODUCT.md:98` (product brief):
  "install **curated** skills from the registry" — "curated" is the word this
  design gives a mechanism to.

## Record correction — the fetch seam

An earlier audit lead pointed at `self_update.rs` as the reqwest exemplar.
**That is WRONG.** `self_update.rs` fetches nothing over the network — it
SHA-256-hashes the local on-disk binary and compares. The real shared
reqwest HTTP-JSON pattern to mirror is **`src-tauri/src/commands/feedback.rs`**:

- `client()` (L248): `reqwest::Client::builder().timeout(20s)
  .user_agent("mortar-pestle-feedback/1.0").build()`.
- `handle_json` (L276): read `resp.text()`, error-map non-2xx,
  `serde_json::from_str`.

`reqwest` is already a dependency (`src-tauri/Cargo.toml:55` —
`reqwest = { version = "0.12", features = ["json","stream","rustls-tls"],
default-features = false }`). A registry fetch mirrors `client()` — **no new
dependency**, and it does **not** route through `proxy.rs` (that is the
sandboxed browser's forward proxy, a different boundary).

## Index schema

A hosted registry serves `index.json`. Skill bodies are fetched **by URL**, not
inlined — that is the change from today's `content` field. Content-hash pinning
per skill body is chosen (option (c) below): the index is signed, and each
entry pins its `.md` by SHA-256 so a body swap after signing is detected.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-09T00:00:00Z",
  "signature": "<detached ed25519 signature over the canonical bytes of `skills`>",
  "skills": [
    {
      "id": "hello",
      "name": "Hello",
      "description": "Prints a hello banner. Demo skill for the Skills Browser.",
      "version": "1.0.0",
      "category": "demo",
      "license": "MIT",
      "bodyUrl": "https://<host>/skills/hello/1.0.0/hello.md",
      "bodySha256": "<hex sha-256 of the exact .md bytes at bodyUrl>"
    }
  ]
}
```

**Mapping today's `hello` onto it**: everything is identical except the inlined
`content` string is replaced by `bodyUrl` + `bodySha256`; the install path
fetches `bodyUrl`, verifies the bytes hash to `bodySha256`, then writes them to
the vault exactly as it writes `content` today.

**Update detection**: the client compares the installed skill's `version`
(persisted alongside the installed `.md`, e.g. in frontmatter or a sidecar) to
the index entry's `version` — a higher semver = update available. `bodySha256`
is the *integrity* check at fetch time, not the update trigger; a same-version
hash mismatch is a tampering signal, not an update.

## Command contract — `skills_registry_fetch`

One new Tauri command. **Fetches and validates the INDEX only** — no vault
write, no install. Skill-body fetch + hash-verify is a named follow-up (shape
below); install stays behind the existing user-gated `api.js` path.

```rust
async fn skills_registry_fetch(index_url: String) -> Result<RegistryIndex, RegistryError>
```

- Reuse `feedback.rs::client()` for the reqwest client and the `handle_json`
  pattern for parsing.
- Verify `signature` over `skills` with a public key **pinned in the binary**
  before returning `Ok` (see Security requirement). A signature failure returns
  `Err(RegistryError::Untrusted)` and the caller must show nothing installable.
- **Read-only**: the command must NOT write the vault and must NOT install.

**The 3 ACL sites a new command needs** (verified current line numbers):

1. `src-tauri/build.rs` `.commands(&[…])` allow-list — add `"skills_registry_fetch"`
   (the `skills_*` block is L188–191, `"skills_run"` at L191).
2. `src-tauri/capabilities/default.json` — add `"allow-skills-registry-fetch"`
   (the `allow-skills-*` grants are L184–190).
3. `src-tauri/src/lib.rs` `tauri::generate_handler![…]` — add
   `commands::skills::skills_registry_fetch` (the `skills::*` handlers are
   L797–800, `skills_run` at L800).

**Follow-up (specify, do not build): `skills_registry_install(id, version)`** —
fetch `bodyUrl`, verify bytes hash to `bodySha256`, only then hand the verified
bytes to the existing `api.js` `install` path. Fetch and hash-verify live in
Rust; the vault write stays the existing user-gated command.

## Security requirement

Given the Threat, install MUST be gated. Options considered:

- **(a) Baked-in allowlist** — the app ships a list of trusted skill ids/hashes;
  the index is checked against it. Defends against a compromised host serving
  new skills. Costs: every new curated skill needs an app release. Too rigid for
  a growing registry.
- **(b) Detached signature over `index.json`** — verified with a public key
  pinned in the binary. Defends against a compromised host / MITM altering the
  index. Costs: key management (a signing key the maintainer holds). Does not by
  itself pin skill *bodies* if they are fetched separately.
- **(c) Per-skill body content-hash pinning inside a signed index** —
  **RECOMMENDED**. (b) + each entry pins `bodySha256`. The signed index attests
  the whole catalog; the hash attests each body fetched afterward. Defends
  against host compromise, MITM, and post-signing body swaps. Costs: (b)'s key
  management plus generating hashes at publish time (cheap, scriptable).

**Requirement (non-negotiable):** *auto-install of a fetched skill without a
valid index signature AND a matching `bodySha256` is forbidden.* The confirm
modals are UX, not security. `skills_registry_fetch` returns `Err(Untrusted)`
on signature failure; `skills_registry_install` refuses on hash mismatch.

## Optional compile stub — SKIPPED (recommended default)

The plan's optional `skills_registry_fetch` compile stub was **not built**.
Rationale: it is explicitly optional (a proof-of-seam, not a feature), and
building it now would churn the 3 ACL sites and force a Rust rebuild while a
concurrent `tauri dev` holds the shared `target/` lock. The seam is proven by
`feedback.rs::client()` already compiling in-tree; the 3 ACL insertion points
are enumerated above for whoever builds the real command.

## Open questions (maintainer decisions)

1. **Hosting.** Where does `index.json` live — a dedicated `mortar-pestle-skills`
   GitHub repo with a pinned raw URL? A release asset? The main repo? Not
   hardcoded here; `index_url` is a parameter (or a pinned constant once decided).
2. **Signing mechanism.** Which control ships — (a), (b), or (c)? This spike
   recommends **(c)**, but committing the app to a key-management scheme (key
   generation, rotation, where the private key is held) is the maintainer's call.

## Later phases (same signed-artifact backend)

- Real skill-body fetch + hash-verify (`skills_registry_install`).
- The "check for updates" affordance in `SkillsBrowserTab.jsx` (version compare).
- **Themes and external modules** ride the *same* backend — a repo of signed,
  fetchable artifacts. Design the schema with them in mind (a `kind` field, or a
  parallel `themes`/`modules` array under the same `schemaVersion` + signature).
- Add the `network` permission to `modules/core/skills-browser/manifest.json`
  (today it declares only `vault.read`/`vault.write`).
- **Vault doc reconciliation (maintainer, out of this repo):** PRODUCT.md:98 and
  `manifest.json:4` both promise install/update-from-registry that does not exist
  yet — reconcile once the real registry ships.
