# Plan 028: Spike — a real skills registry (the cheapest slice of the distribution layer)

> **Executor instructions**: This is a SPIKE / DESIGN plan, not a build-everything
> plan. Your deliverable is a written design document (schema + command contract +
> a security decision + open questions), NOT a shipped, fetching registry. Follow
> the steps in order. Where a step says "define" or "decide", you write the
> decision down in the deliverable doc — you do not implement a network fetch of
> real skills. Run every verification. If anything in "STOP conditions" occurs,
> stop and report — do not improvise. When done, update the status row for this
> plan in `plans/README.md` if one exists (create nothing if it doesn't).
>
> **Drift check (run first)**:
> `git -C . diff --stat 57a6c80..HEAD -- modules/core/skills-browser src-tauri/src/commands/skills.rs src-tauri/src/commands/feedback.rs src-tauri/build.rs src-tauri/capabilities/default.json src-tauri/src/lib.rs`
> If any file below changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2 (opportunity — unlocks the distribution layer)
- **Effort**: S–M (coarse; the doc is S, an optional compile-checked command stub pushes it to M)
- **Risk**: LOW (spike; no user-facing behavior ships unless you opt into the optional stub)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The Skills Browser module advertises itself as a way to "Browse, install, and
update skills from the bundled registry" (`manifest.json:4`) and PRODUCT.md
promises users can "install curated skills from the registry"
(`PRODUCT.md:98`). Neither is true today: the "registry" is a static
3-entry JSON file shipped inside the app bundle, every entry is
`"category": "demo"`, and there is zero fetch/update code — install just writes
the inlined content to a vault file. Skills are the *cheapest distributable the
product has* (plain markdown, no JSX to compile, no sandbox to stand up), so a
real registry is the smallest first slice of the whole "install modules/themes
from a repo" distribution layer. This spike defines that slice — the index
schema, the fetch command, and (non-negotiable) the security control — so the
maintainer can approve a design before anyone writes fetching code. The security
angle is the whole point: an installed skill is executable shell (see Current
state), so "curated" has to mean *cryptographically or provenance-gated*, not
"we put it in a JSON file."

## Current state

Files and their role (all read first-hand at `57a6c80`):

- `modules/core/skills-browser/registry.json` — the entire "registry": a static
  array of 3 entries, bundled in the app. Every entry is a demo with its skill
  body inlined as a `content` string. First entry verbatim:
  ```json
  {
    "id": "hello",
    "name": "Hello",
    "description": "Prints a hello banner. Demo skill for the Skills Browser.",
    "category": "demo",
    "license": "MIT",
    "version": "1.0.0",
    "install": "auto",
    "content": "---\nname: hello\n...\n"
  }
  ```
  The other two (`timestamp`, `vault-stats`) are the same shape, also
  `"category": "demo"`. There is no URL, hash, signature, or source field.

- `modules/core/skills-browser/api.js:7-27` — the install path. It is
  **vault-only**; there is no network call anywhere in this module:
  ```js
  export function bindSkillsBrowserApi(api) {
    return {
      async isInstalled(id) { /* vault_read_file INSTALL_DIR/{id}.md */ },
      async install(id, content) {
        return api.invoke('vault_write_file', { path: `${INSTALL_DIR}/${id}.md`, content });
      },
      async uninstall(id) {
        return api.invoke('vault_delete_file', { path: `${INSTALL_DIR}/${id}.md` });
      },
    };
  }
  ```
  `const INSTALL_DIR = 'Infrastructure/Skills/Slash';` (line 5). Install writes
  the `content` string straight from `registry.json` to the vault — no fetch.

- `modules/core/skills-browser/SkillsBrowserTab.jsx:57` — the UI copy is honest
  about the gap: `Demo skills from the static registry.` The tab renders
  `registry.map(...)` with Install/Uninstall buttons and an overwrite/uninstall
  confirm modal. No "update" or "check for updates" affordance exists despite the
  manifest promising one.

- `modules/core/skills-browser/manifest.json:4` — the unfulfilled promise:
  `"description": "Browse, install, and update skills from the bundled registry."`
  `"permissions": ["vault.read", "vault.write"]` (line 8) — note: **no network
  permission is declared**, which a real fetch would need to add.

- `Knowledge/Mortar & Pestle/Reference/PRODUCT.md:98` (product brief, authoritative)
  — `Skills Browser module (install curated skills from the registry)`. "Curated"
  is the load-bearing word this spike must define a mechanism for.

- **THE SECURITY GATE** — `src-tauri/src/commands/skills.rs:239-304`, `skills_run`.
  A "skill" is not passive markdown; running one spawns a real agent process with
  a PTY, in the vault root:
  ```rust
  let mut cmd = CommandBuilder::new("claude");
  cmd.arg("-p");
  cmd.arg(&invocation);            // invocation composed from the skill file
  cmd.cwd(vault_root());
  // ... inherits the full process env (lines 299-304) ...
  let mut child = slave.spawn_command(cmd)?;
  ```
  `compose_invocation(&skill, &args)` (line 261) builds the prompt from the skill
  markdown. So a fetched-and-installed skill becomes an instruction to a local
  coding agent running with the user's environment and vault write access. This
  is why curation/signing is a REQUIREMENT of this design, not a nice-to-have.

- **THE REAL FETCH SEAM** — `src-tauri/src/commands/feedback.rs:248-254`.
  NOTE: an earlier audit lead pointed at `self_update.rs` as the reqwest fetch
  exemplar — that lead is WRONG. `self_update.rs` fetches nothing over the
  network; `check_inner()` (`self_update.rs:98-125`) hashes the **local on-disk
  binary** with SHA-256 and compares. The actual shared reqwest HTTP-JSON
  pattern to mirror is here:
  ```rust
  fn client() -> Result<reqwest::Client, FeedbackError> {
      reqwest::Client::builder()
          .timeout(Duration::from_secs(20))
          .user_agent("mortar-pestle-feedback/1.0")
          .build()
          .map_err(|e| FeedbackError::Network(format!("HTTP client init: {e}")))
  }
  ```
  plus `handle_json` (`feedback.rs:276-288`): read `resp.text()`, error-map on
  non-2xx, `serde_json::from_str`. `reqwest` is already a dependency
  (`src-tauri/Cargo.toml:55`: `reqwest = { version = "0.12", features = ["json",
  "stream", "rustls-tls"], default-features = false }`). `design.rs` and the
  `music_search.rs`/`anime_search.rs` command families use the same stack. A
  registry fetch command mirrors `client()` — it does NOT need a new dependency
  and does NOT route through `proxy.rs` (that is the sandboxed *browser's*
  forward proxy, a different boundary).

- **THE 3 ACL SITES** (a new Tauri command needs all three, or it will not be
  callable). Confirmed pattern for the existing `skills_run`:
  1. `src-tauri/build.rs:4` — the `.commands(&[ ... ])` allow-list; `"skills_run"`
     is at line ~171. A new command's snake_case name goes in this array.
  2. `src-tauri/capabilities/default.json:187-193` — the `allow-<kebab>` grants:
     ```json
     "allow-skills-list",
     "allow-skills-get",
     "allow-skills-run",
     ```
     A new command `skills_registry_fetch` needs `"allow-skills-registry-fetch"`.
  3. `src-tauri/src/lib.rs:609` — `tauri::generate_handler![ ... ]`; `skills_run`
     is registered as `commands::skills::skills_run` at line ~777.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust compile check | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0 (only if you build the optional stub) |
| Dev run | `npm run tauri dev` | Vite at 127.0.0.1:5173 + desktop window (only if you build the optional stub) |
| Read the security path | `cargo doc --no-deps` or just re-read `skills.rs:239-304` | you can state what an installed skill can do |

For the core deliverable (the design doc) you do not need to run anything —
verification is that the doc answers every question in the Done criteria.

## Scope

**In scope** (this spike only produces / touches):
- `plans/028-skills-registry-DESIGN.md` (CREATE) — the deliverable design doc.
- OPTIONAL, only if you choose to prove the fetch seam compiles: a stubbed
  `skills_registry_fetch` command in a new file
  `src-tauri/src/commands/skills_registry.rs` (or appended to `skills.rs`) that
  mirrors `feedback.rs::client()`, wired at the 3 ACL sites, returning a typed
  index — with NO auto-install and NO signature-bypass. Mark it clearly as a
  spike stub. This is a proof-of-seam, not a feature.

**Out of scope** (do NOT touch):
- The existing vault-write install path (`api.js`, `SkillsBrowserTab.jsx`) — this
  spike leaves it exactly as-is. A real registry keeps writing to
  `Infrastructure/Skills/Slash/` after fetch; the fetch is additive.
- Shipping an actual hosted registry, real curated skill content, or the
  `SkillsBrowserTab.jsx` "check for updates" UI. Later phases.
- **Themes and external modules.** They are later phases of the *same* backend
  (a repo of signed, fetchable artifacts). Note them in the doc's "Later phases"
  section so the schema is designed with them in mind — but do not scope any of
  their code here.
- Editing PRODUCT.md, `manifest.json` copy, or vault docs — the vault lives
  outside this repo; flag doc reconciliation as a maintainer follow-up instead.

## Steps

### Step 1: Confirm the security surface, in writing

Re-read `src-tauri/src/commands/skills.rs:239-304` and
`compose_invocation` in `src-tauri/src/parsers/skills.rs`. In the deliverable
doc, write one paragraph stating exactly what an installed-then-run skill can do
(spawns `claude -p <invocation>` in `vault_root()` with inherited env). This
paragraph is the justification for the security requirement in Step 4 — write it
first so the rest of the design is anchored to the threat, not bolted onto it.

**Verify**: the doc's "Threat" section names the process (`claude`), the cwd
(`vault_root()`), and the trust boundary (a remote author's markdown becomes a
local agent instruction).

### Step 2: Define the index schema

Design an `index.json` that a hosted registry serves. It must carry, per skill,
at minimum: `id`, `name`, `description`, `version` (semver), `category`, a
**source URL** for the skill `.md` body (skills are fetched by URL, not inlined —
that is the change from today's `content` field), and the security field(s) from
Step 4. Include a top-level `schemaVersion` and a `generatedAt`. Show the full
JSON shape in the doc, and show how one of today's demo entries (`hello`) maps
onto it. Decide: does the index pin each skill body by content hash (SHA-256 of
the `.md`), or only sign the index? State the choice and why.

**Verify**: the doc contains a complete `index.json` example plus a per-skill
entry example, and a sentence on how the client detects an *update* (version
compare vs. hash compare).

### Step 3: Specify the `skills_registry_fetch` command contract

Define a single new Tauri command (do not implement fetching of arbitrary
skills yet — just the contract, plus the OPTIONAL compile stub):
- Signature: `async fn skills_registry_fetch(index_url: String) -> Result<RegistryIndex, RegistryError>`
  (or a pinned URL constant — see the open question). Mirror
  `feedback.rs::client()` for the reqwest client and `handle_json` for parsing.
- It fetches and validates the **index** only. Skill-body fetch + hash-verify is
  a named follow-up, but specify its shape here.
- Enumerate the 3 ACL edits it requires (Step's excerpt above): `build.rs`
  array, `capabilities/default.json` `allow-skills-registry-fetch`, `lib.rs`
  `generate_handler!`.
- The command must NOT write to the vault and must NOT install anything — install
  stays behind the existing user-gated `api.js` path.

**Verify**: the doc lists the command signature, the 3 exact ACL insertion
points with file:line, and states that fetch is read-only (no vault write).
If you built the optional stub: `cargo check --manifest-path src-tauri/Cargo.toml`
→ exit 0, and the command appears in all 3 ACL sites.

### Step 4: Write the security decision as a REQUIREMENT

Given Step 1's threat, specify the control that makes "curated" real. Present
the options and pick a recommendation (leave the final call to the maintainer —
see STOP): (a) a maintainer-controlled allowlist baked into the app that the
index is checked against; (b) a detached signature over `index.json` verified
with a public key pinned in the binary; (c) per-skill body content-hash pinning
in a signed index. State what each defends against and what it costs. Make
explicit: **auto-install of a fetched skill without passing this check is
forbidden** — the existing overwrite/uninstall confirm modals are UX, not
security.

**Verify**: the doc has a "Security requirement" section with a chosen mechanism,
its threat model, and an explicit "install is blocked unless <check> passes"
sentence.

### Step 5: List open questions and later phases

Write the two maintainer decisions (Step 6 / STOP) and a short "Later phases"
list (themes, external modules ride the same signed-artifact backend; the
network permission must be added to the module manifest; PRODUCT.md +
`manifest.json` copy need reconciling once shipped).

**Verify**: the doc ends with an "Open questions" and a "Later phases" section.

## Done criteria

Machine-checkable / reviewable. ALL must hold:

- [ ] `plans/028-skills-registry-DESIGN.md` exists and contains: Threat, index
      schema (full example), command contract (with the 3 ACL sites), Security
      requirement (chosen mechanism), Open questions, Later phases.
- [ ] The doc explicitly corrects the record that the fetch seam is
      `feedback.rs::client()`, not `self_update.rs`.
- [ ] No change to `modules/core/skills-browser/api.js` or `SkillsBrowserTab.jsx`
      (`git status` clean for those two files).
- [ ] If the optional stub was built:
      `cargo check --manifest-path src-tauri/Cargo.toml` exits 0, and
      `git grep -n "skills_registry_fetch" src-tauri` shows it in `build.rs`,
      `capabilities/default.json` (as `allow-skills-registry-fetch`), and
      `lib.rs`.
- [ ] `plans/README.md` status row updated (only if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The `skills.rs:239-304` excerpt no longer matches (the command surface drifted)
  — the whole threat model depends on it.
- You find `reqwest` is no longer in `src-tauri/Cargo.toml` or `feedback.rs`'s
  `client()` builder is gone — the "reuse the existing seam" premise is void;
  re-locate the real HTTP stack and report before proceeding.
- **Hosting choice is a maintainer call.** Where the registry is hosted (a
  dedicated `mortar-pestle-skills` GitHub repo + pinned raw URL? a release
  asset? the main repo?) is not yours to decide — surface it as Open Question 1
  and do not hardcode a real URL.
- **Signing mechanism is a maintainer call.** Which of Step 4's options ships is
  the maintainer's decision — recommend one, but surface it as Open Question 2
  and stop rather than committing the app to a key-management scheme.

## Maintenance notes

- For whoever builds the real registry after this: the schema in Step 2 is the
  contract the hosted `index.json` must satisfy; version + hash fields are what
  make "update" and "verify" cheap later.
- A reviewer should scrutinize: (1) that fetch is truly read-only and install
  stays user-gated, and (2) that the security section actually blocks
  auto-install, not just warns.
- Deferred out of this spike (by design): real skill-body fetch + hash verify,
  the "check for updates" UI, the network permission grant in the module
  manifest, and the PRODUCT.md / vault-decision reconciliation (the vault is a
  separate repo the maintainer owns).
