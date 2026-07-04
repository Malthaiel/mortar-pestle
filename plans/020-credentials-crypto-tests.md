# Plan 020: Add crypto roundtrip + idle-lock tests for the credentials vault

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that index file exists — otherwise skip it (the
> advisor maintains the index separately; do not create it).
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/credentials.rs`
> This plan's excerpts were verified byte-identical between `57a6c80` and the
> working tree. If that diff is now non-empty, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline-and-ci.md` (must land first — it establishes the one-command Rust test invocation this plan relies on)
- **Category**: tests
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

`src-tauri/src/commands/credentials.rs` is the Password Vault — a Bitwarden-like
store that seals the user's entire credential set with XChaCha20-Poly1305 (AEAD)
under an Argon2id-derived key. It has **zero tests today** (confirmed:
`grep -c '#\[test\]' src-tauri/src/commands/credentials.rs` returns `0`). A silent
regression in `seal`/`open`, in the header-as-AAD binding, or in wrong-master
rejection would corrupt or expose every stored password with no test to catch it.
The idle safety-floor (`enforce_idle`) is the last line of defense that scrubs the
decrypted store from memory if the frontend lock timer dies — also untested. This
plan adds a small, fast, deterministic unit-test module covering exactly those
security-critical paths.

## Current state

- `src-tauri/src/commands/credentials.rs` (1472 lines) — the whole Password Vault
  Phase 1. The security-sensitive core is a set of **private free functions over
  byte slices and plain structs — none take a Tauri `AppHandle`**, so they are
  directly unit-testable in-process. Relevant items and their exact signatures:

  - Crypto core (all module-private `fn`s):
    ```rust
    // credentials.rs:396
    fn parse_file(bytes: &[u8]) -> Result<VaultFile, CredError>
    // credentials.rs:442
    fn derive_key(master: &[u8], salt: &[u8], m: u32, t: u32, p: u32)
        -> Result<Zeroizing<[u8; KEY_LEN]>, CredError>
    // credentials.rs:459 — generates a RANDOM nonce internally (OsRng); returns
    // the full on-disk blob: header bytes || AEAD ciphertext.
    fn seal(key: &[u8; KEY_LEN], salt: &[u8], m: u32, t: u32, p: u32, store: &CredStore)
        -> Result<Vec<u8>, CredError>
    // credentials.rs:488 — returns CredError::BadPassword on any AEAD failure.
    fn open(vf: &VaultFile, key: &[u8; KEY_LEN]) -> Result<CredStore, CredError>
    // credentials.rs:550 — sets *slot = None (dropping Unlocked, which scrubs) when idle.
    fn enforce_idle(slot: &mut Option<Unlocked>)
    ```

  - `open`'s failure branch (this is the exact line the wrong-key / tamper tests
    assert against):
    ```rust
    // credentials.rs:490-498
    let pt = cipher
        .decrypt(
            XNonce::from_slice(&vf.nonce),
            Payload { msg: &vf.ciphertext[..], aad: &vf.header },
        )
        .map_err(|_| CredError::BadPassword)?;
    ```

  - The on-disk header layout `seal` writes and `parse_file` reads back
    (`build_header`, credentials.rs:379-394). Byte offsets that matter for the
    tamper test: `[0..4]`=MAGIC `b"ACVN"`, `[4]`=version, `[5]`=KDF id, `[6]`=AEAD
    id, **`[7]`=reserved flags byte (always `0`, and `parse_file` does NOT validate
    it)**, `[8..12]`=m_cost, `[12..16]`=t_cost, `[16]`=p_cost, `[17]`=salt_len,
    then salt, then a nonce_len byte, then the 24-byte nonce. `parse_file` uses
    `header = bytes[0..nonce_end]` (the whole header, nonce included) verbatim as
    the AEAD AAD.

  - `enforce_idle` body (credentials.rs:550-561) — expiry uses
    `idle_timeout_secs.max(1)` as a floor and compares `last_active.elapsed()`:
    ```rust
    fn enforce_idle(slot: &mut Option<Unlocked>) {
        let expired = slot.as_ref().map(|u| {
            let secs = u.store.settings.idle_timeout_secs.max(1);
            u.last_active.elapsed() > Duration::from_secs(secs)
        }).unwrap_or(false);
        if expired { *slot = None; } // drops Unlocked → scrubs key + store
    }
    ```

  - `Unlocked` (credentials.rs:349-357) — the struct the idle test constructs.
    All fields are module-private but reachable from a child `mod tests`:
    ```rust
    struct Unlocked {
        key: Zeroizing<[u8; KEY_LEN]>,
        salt: Vec<u8>,
        m_cost: u32, t_cost: u32, p_cost: u32,
        store: CredStore,
        last_active: Instant,
    }
    ```
    Its `Drop` (credentials.rs:359-364) calls `self.store.zeroize()` — harmless
    in tests; dropping it just scrubs.

  - Helpers/consts you will reference, all defined in this module:
    `CredStore::new_empty()` (credentials.rs:128), the entry struct `CredEntry`
    (credentials.rs:147, all fields `pub`), consts `KEY_LEN=32`, `SALT_LEN=16`,
    `NONCE_LEN=24`, `ARGON_M_COST`, `ARGON_T_COST`, `ARGON_P_COST`
    (credentials.rs:40-49), and the error enum `CredError` (credentials.rs:56,
    `#[derive(Debug)]` — **no `PartialEq`**, so assert variants with `matches!`,
    never `assert_eq!`).

- **Why these tests MUST live inside `credentials.rs` as a `#[cfg(test)] mod tests`,
  not in `src-tauri/tests/`**: every function above is module-**private**. An
  integration test under `src-tauri/tests/` sees only the crate's `pub` surface
  (`app_lib`), which does not expose `seal`/`open`/`enforce_idle`/`Unlocked`. A
  child test module with `use super::*;` is the only thing that can reach them.

- **Proven pattern to copy** — this exact convention already exists and already
  runs under the repo's test command. `src-tauri/src/commands/self_update.rs:256-292`
  is a sibling module with an in-file test mod:
  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use std::io::Write;
      use tempfile::NamedTempFile;

      #[test]
      fn hash_file_stable_for_same_content() { /* ... */ }
  }
  ```
  It uses the `tempfile` dev-dependency and reaches `super`'s private `hash_file`.
  Mirror its structure exactly.

- Both modules are compiled: `src-tauri/src/commands/mod.rs:22` declares
  `pub mod credentials;` and `:51` `pub mod self_update;`.

- Dev-dependencies already present (`src-tauri/Cargo.toml:99-101`): `tempfile = "3"`,
  `similar = "2"`. This plan needs **no new dependency** — the crypto tests use
  fixed `[u8; 32]` keys and in-memory structs; no temp files, no `tempfile`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build + run all Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | exit 0, all pass |
| Fast iteration (this module only) | `cargo test --manifest-path src-tauri/Cargo.toml --tests credentials::tests` | exit 0, the new tests pass |
| Confirm no tests existed before | `grep -c '#\[test\]' src-tauri/src/commands/credentials.rs` | `0` before your change |

**LANDMINE — do NOT run `cargo test --lib`.** It SIGTERMs the sandbox (documented
repo gotcha). Always use `--tests`. The `--tests` target still compiles and runs
the library's unit tests (that is how `self_update.rs`'s in-file test mod runs), so
your new `mod tests` executes under it.

## Scope

**In scope** (the only file you should modify):
- `src-tauri/src/commands/credentials.rs` — append one `#[cfg(test)] mod tests` block
  at the end of the file (after line 1472).

**Out of scope** (do NOT touch):
- The crypto itself — `seal`, `open`, `derive_key`, `parse_file`, `build_header`,
  `enforce_idle`, and every struct/const. This plan only *adds tests* around the
  existing behavior; if a test reveals a bug, STOP and report it (see STOP
  conditions), do not "fix" the crypto here.
- `src-tauri/tests/` — do not create an integration-test directory; the target
  functions are private (see Current state).
- Any other command module.

## Git workflow

- Branch: `advisor/020-credentials-crypto-tests`.
- One commit. Message style is Conventional Commits with a scope (matches repo
  history, e.g. `feat(broadcast): ...`): `test(credentials): add crypto roundtrip + idle-lock unit tests`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Append the test module

Add the following block at the very end of `src-tauri/src/commands/credentials.rs`.
Every name it uses is provided by `use super::*;` (they are defined in, or imported
by, this module — `Duration`/`Instant` via `credentials.rs:23`, `Zeroizing` via
`:31`). If any name fails to resolve, add an explicit `use` for it (do not change
the parent module).

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // A store with one real entry, so the roundtrip proves entry secrets survive.
    fn sample_store() -> CredStore {
        let mut s = CredStore::new_empty();
        s.entries.push(CredEntry {
            id: "id-1".into(),
            folder: None,
            tags: vec!["email".into()],
            title: "GitHub".into(),
            origin: Some("https://github.com/login".into()),
            host: Some("github.com".into()),
            username: "octocat".into(),
            password: "correct horse battery staple".into(),
            notes: "2fa in authenticator".into(),
            custom_fields: vec![],
            created: "2026-01-01T00:00:00Z".into(),
            updated: "2026-01-02T00:00:00Z".into(),
        });
        s
    }

    // seal() takes a raw 32-byte key, so tests skip Argon2 entirely and stay fast.
    const KEY_A: [u8; KEY_LEN] = [7u8; KEY_LEN];
    const KEY_B: [u8; KEY_LEN] = [9u8; KEY_LEN];
    const SALT: [u8; SALT_LEN] = [3u8; SALT_LEN];

    fn seal_sample(key: &[u8; KEY_LEN]) -> Vec<u8> {
        seal(key, &SALT, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, &sample_store())
            .expect("seal should succeed")
    }

    #[test]
    fn seal_open_roundtrip_is_byte_identical() {
        let store = sample_store();
        let original = serde_json::to_vec(&store).unwrap();
        let blob = seal(&KEY_A, &SALT, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, &store).unwrap();
        let vf = parse_file(&blob).unwrap();
        let decoded = open(&vf, &KEY_A).unwrap();
        // The serialized store must survive seal->parse->open unchanged.
        assert_eq!(original, serde_json::to_vec(&decoded).unwrap());
    }

    #[test]
    fn open_with_wrong_key_is_bad_password() {
        let blob = seal_sample(&KEY_A);
        let vf = parse_file(&blob).unwrap();
        assert!(matches!(open(&vf, &KEY_B), Err(CredError::BadPassword)));
    }

    #[test]
    fn tampered_aad_header_byte_is_bad_password() {
        let mut blob = seal_sample(&KEY_A);
        // Byte 7 is the reserved flags byte: part of the AAD but NOT validated by
        // parse_file, so parsing still succeeds and only the AEAD tag catches it.
        blob[7] ^= 0xFF;
        let vf = parse_file(&blob).unwrap();
        assert!(matches!(open(&vf, &KEY_A), Err(CredError::BadPassword)));
    }

    #[test]
    fn tampered_ciphertext_byte_is_bad_password() {
        let mut blob = seal_sample(&KEY_A);
        let last = blob.len() - 1; // inside the AEAD ciphertext/tag
        blob[last] ^= 0xFF;
        let vf = parse_file(&blob).unwrap();
        assert!(matches!(open(&vf, &KEY_A), Err(CredError::BadPassword)));
    }

    fn unlocked_with(idle_secs: u64, last_active: Instant) -> Unlocked {
        let mut store = CredStore::new_empty();
        store.settings.idle_timeout_secs = idle_secs;
        Unlocked {
            key: Zeroizing::new([0u8; KEY_LEN]),
            salt: vec![0u8; SALT_LEN],
            m_cost: ARGON_M_COST,
            t_cost: ARGON_T_COST,
            p_cost: ARGON_P_COST,
            store,
            last_active,
        }
    }

    #[test]
    fn enforce_idle_scrubs_when_expired() {
        // last_active 2s ago, timeout 1s -> expired. Subtraction is safe: system
        // uptime is always >> 2s. (Use checked_sub().unwrap() if you prefer.)
        let past = Instant::now() - Duration::from_secs(2);
        let mut slot = Some(unlocked_with(1, past));
        enforce_idle(&mut slot);
        assert!(slot.is_none(), "expired session must be scrubbed to None");
    }

    #[test]
    fn enforce_idle_keeps_fresh_session() {
        let mut slot = Some(unlocked_with(900, Instant::now()));
        enforce_idle(&mut slot);
        assert!(slot.is_some(), "fresh session must be retained");
    }

    #[test]
    fn derive_key_is_deterministic_and_salt_bound() {
        // Wiring check on the Argon2id KDF (one run; ~real cost is acceptable).
        let k1 = derive_key(b"master", &SALT, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST).unwrap();
        let k2 = derive_key(b"master", &SALT, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST).unwrap();
        assert_eq!(k1[..], k2[..], "same inputs -> same key");
        let other_salt = [4u8; SALT_LEN];
        let k3 = derive_key(b"master", &other_salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST).unwrap();
        assert_ne!(k1[..], k3[..], "different salt -> different key");
    }
}
```

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests credentials::tests`
→ compiles, and reports `test result: ok. 7 passed` for the credentials module
(names: `seal_open_roundtrip_is_byte_identical`, `open_with_wrong_key_is_bad_password`,
`tampered_aad_header_byte_is_bad_password`, `tampered_ciphertext_byte_is_bad_password`,
`enforce_idle_scrubs_when_expired`, `enforce_idle_keeps_fresh_session`,
`derive_key_is_deterministic_and_salt_bound`).

### Step 2: Confirm the full suite is still green

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → exit 0, all
tests pass (the pre-existing `self_update` tests plus your 7 new ones). No warnings
about unused imports in the new module.

## Test plan

- New tests (all in the new `#[cfg(test)] mod tests` in `credentials.rs`):
  - `seal_open_roundtrip_is_byte_identical` — happy path: a store with a real entry
    survives `seal → parse_file → open` with the serialized bytes unchanged.
  - `open_with_wrong_key_is_bad_password` — decrypt under a different key → `BadPassword`.
  - `tampered_aad_header_byte_is_bad_password` — flipping the reserved header byte
    (AAD, but parse-valid) → `BadPassword`. Proves the header→AAD binding.
  - `tampered_ciphertext_byte_is_bad_password` — flipping a ciphertext byte →
    `BadPassword`. Proves AEAD tag integrity.
  - `enforce_idle_scrubs_when_expired` / `enforce_idle_keeps_fresh_session` — the
    idle safety-floor zeroes the session when stale and keeps it when fresh.
  - `derive_key_is_deterministic_and_salt_bound` — KDF wiring sanity.
- Structural pattern to match: `src-tauri/src/commands/self_update.rs:256-292`.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass,
  including 7 new credentials tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0.
- [ ] The 7 new tests exist and pass (`... --tests credentials::tests` shows `7 passed`).
- [ ] `grep -c '#\[test\]' src-tauri/src/commands/credentials.rs` returns `7`.
- [ ] `git status --porcelain` shows only `src-tauri/src/commands/credentials.rs`
      modified — no other file.
- [ ] `plans/README.md` status row updated **if** that file exists (skip otherwise).

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check diff (`git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/credentials.rs`)
  is non-empty and the "Current state" excerpts no longer match the live code.
- Any function signature above differs from the live code (e.g. `seal`/`open` now
  takes an `AppHandle` or a different key type) — the plan assumes they are
  `AppHandle`-free free functions. If that assumption is false, report what
  stubbing/refactor would be needed instead of guessing.
- **A test fails because the behavior is wrong** (e.g. the roundtrip is not
  byte-identical, or a tampered blob decrypts without error). That is a real
  crypto bug — report it; do NOT edit the crypto to make the test pass.
- `cargo test --tests` itself won't run (compile error unrelated to your code, or a
  SIGTERM) — that points at plan 002's baseline not being in place; report and stop.
- A name in the test module cannot be resolved even after adding an explicit `use`
  (indicates the module structure drifted).

## Maintenance notes

- These tests pin the on-disk format's security contract. If the header layout,
  AAD construction (`build_header`), or the `CredError::BadPassword` mapping in
  `open` ever changes, expect `tampered_aad_header_byte_is_bad_password` and the
  roundtrip test to need updating — that is the point, they should fail loudly.
- Byte offset `7` (reserved flags) is deliberately chosen because `parse_file` does
  not validate it. If a future format version starts using/validating that byte,
  switch the AAD-tamper test to another parse-valid-but-AAD-covered byte.
- Reviewer should scrutinize: that no test weakens Argon2 cost params in the real
  code paths (the tests use raw keys precisely to avoid needing to), and that the
  new module is `#[cfg(test)]` so it never ships in release builds.
- Deferred out of scope: forcing an `enforce_idle` expiry via real wall-clock sleep
  (flaky/slow) — the in-past `Instant` is deterministic and preferred.
