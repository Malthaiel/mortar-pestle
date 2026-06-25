//! Password Vault — a Bitwarden-like encrypted credential store, Phase 1.
//!
//! A master password is run through Argon2id to derive a 32-byte key that
//! seals the ENTIRE store with XChaCha20-Poly1305 (AEAD). The sealed blob lives
//! at `<app_config>/credentials.enc` (outside the synced vault). The master
//! password is never persisted; an opt-in "stay unlocked" caches the *derived
//! key* (not the master) in the OS keyring, salt-bound so it self-invalidates
//! when the master changes.
//!
//! Security posture: zero-knowledge (no recovery — export is the only backup),
//! `creds_list`/`creds_match_host` return summaries with NO password/notes so
//! they physically can't leak, the in-memory key is `Zeroizing` and the
//! decrypted store is scrubbed on lock via `Unlocked`'s `Drop`, and an idle
//! safety-floor self-locks on the next command if the frontend timer dies.
//!
//! Phase 2 (in-page autofill bridge) is intentionally NOT here — it lives in
//! `commands/browser.rs`'s `UserContentManager` path and is deferred.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize, Serializer};
use tauri::AppHandle;
use zeroize::{Zeroize, Zeroizing};

use crate::commands::vault::{self, VaultError};

// ── File-format constants ────────────────────────────────────────────────
const MAGIC: &[u8; 4] = b"ACVN"; // Agentic Credentials VaultN
const FORMAT_VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
const AEAD_XCHACHA: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
const STORE_FILE: &str = "credentials.enc";

// Argon2id interactive-desktop profile (OWASP). Stored in the file header so a
// future bump doesn't break existing vaults — readers honor the header values.
const ARGON_M_COST: u32 = 65_536; // KiB = 64 MiB
const ARGON_T_COST: u32 = 3;
const ARGON_P_COST: u32 = 1;

// Keyring (libsecret on Linux) — same service as design.rs/qbit.rs, new account.
const KR_SERVICE: &str = "iskariel";
const KR_ACCOUNT: &str = "credentials";

// ── Error type (mirrors design.rs DesignError → {code,message}) ───────────
#[derive(Debug)]
pub enum CredError {
    NotInit,
    AlreadyInit,
    Locked,
    BadPassword,
    Corrupt(String),
    NotFound(String),
    Invalid(String),
    Io(String),
    Keyring(String),
}

impl Serialize for CredError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let (code, msg): (&str, String) = match self {
            CredError::NotInit => ("NOT_INIT", "No vault yet — set a master password.".into()),
            CredError::AlreadyInit => ("EXISTS", "A vault already exists.".into()),
            CredError::Locked => ("LOCKED", "Vault is locked.".into()),
            CredError::BadPassword => ("BAD_PASSWORD", "Incorrect master password.".into()),
            CredError::Corrupt(m) => ("CORRUPT", m.clone()),
            CredError::NotFound(m) => ("NOT_FOUND", m.clone()),
            CredError::Invalid(m) => ("INVALID", m.clone()),
            CredError::Io(m) => ("IO", m.clone()),
            CredError::Keyring(m) => ("KEYRING", m.clone()),
        };
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("code", code)?;
        m.serialize_entry("message", &msg)?;
        m.end()
    }
}

impl From<std::io::Error> for CredError {
    fn from(e: std::io::Error) -> Self {
        CredError::Io(e.to_string())
    }
}

impl From<VaultError> for CredError {
    fn from(e: VaultError) -> Self {
        match e {
            VaultError::Invalid(m) => CredError::Invalid(m),
            VaultError::NotFound(m) | VaultError::Io(m) => CredError::Io(m),
            other => CredError::Io(format!("{other:?}")),
        }
    }
}

// ── Cleartext store schema (this is what gets sealed) ─────────────────────
fn schema_default() -> u32 {
    1
}

#[derive(Serialize, Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct CredStore {
    #[zeroize(skip)]
    #[serde(default = "schema_default")]
    pub schema: u32,
    #[zeroize(skip)]
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub entries: Vec<CredEntry>,
    #[zeroize(skip)]
    #[serde(default)]
    pub settings: CredSettings,
}

impl CredStore {
    fn new_empty() -> Self {
        CredStore {
            schema: 1,
            folders: Vec::new(),
            entries: Vec::new(),
            settings: CredSettings::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct CredEntry {
    #[zeroize(skip)]
    pub id: String,
    #[zeroize(skip)]
    #[serde(default)]
    pub folder: Option<String>,
    #[zeroize(skip)]
    #[serde(default)]
    pub tags: Vec<String>,
    #[zeroize(skip)]
    #[serde(default)]
    pub title: String,
    #[zeroize(skip)]
    #[serde(default)]
    pub origin: Option<String>,
    #[zeroize(skip)]
    #[serde(default)]
    pub host: Option<String>,
    #[zeroize(skip)]
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub custom_fields: Vec<CustomField>,
    #[zeroize(skip)]
    #[serde(default)]
    pub created: String,
    #[zeroize(skip)]
    #[serde(default)]
    pub updated: String,
}

#[derive(Serialize, Deserialize, Clone, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    #[zeroize(skip)]
    pub name: String,
    pub value: String,
    #[zeroize(skip)]
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct CredSettings {
    pub idle_timeout_secs: u64,
    pub clipboard_clear_secs: u64,
    pub reveal_remask_secs: u64,
    pub lock_on_blur: bool,
}

impl Default for CredSettings {
    fn default() -> Self {
        CredSettings {
            idle_timeout_secs: 900,
            clipboard_clear_secs: 30,
            reveal_remask_secs: 20,
            lock_on_blur: true,
        }
    }
}

// ── DTOs (the wire contract; summaries carry NO secrets) ──────────────────
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub keyring_enabled: bool,
    pub idle_timeout_secs: u64,
    pub clipboard_clear_secs: u64,
    pub reveal_remask_secs: u64,
    pub lock_on_blur: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredSummary {
    pub id: String,
    pub title: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub username: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub updated: String,
}

impl From<&CredEntry> for CredSummary {
    fn from(e: &CredEntry) -> Self {
        CredSummary {
            id: e.id.clone(),
            title: e.title.clone(),
            host: e.host.clone(),
            origin: e.origin.clone(),
            username: e.username.clone(),
            folder: e.folder.clone(),
            tags: e.tags.clone(),
            updated: e.updated.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredEntryFull {
    pub id: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub title: String,
    pub origin: Option<String>,
    pub host: Option<String>,
    pub username: String,
    pub password: String,
    pub notes: String,
    pub custom_fields: Vec<CustomField>,
    pub created: String,
    pub updated: String,
}

impl From<&CredEntry> for CredEntryFull {
    fn from(e: &CredEntry) -> Self {
        CredEntryFull {
            id: e.id.clone(),
            folder: e.folder.clone(),
            tags: e.tags.clone(),
            title: e.title.clone(),
            origin: e.origin.clone(),
            host: e.host.clone(),
            username: e.username.clone(),
            password: e.password.clone(),
            notes: e.notes.clone(),
            custom_fields: e.custom_fields.clone(),
            created: e.created.clone(),
            updated: e.updated.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredEntryInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub custom_fields: Vec<CustomField>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenOpts {
    pub length: usize,
    #[serde(default)]
    pub lower: bool,
    #[serde(default)]
    pub upper: bool,
    #[serde(default)]
    pub digits: bool,
    #[serde(default)]
    pub symbols: bool,
    #[serde(default)]
    pub avoid_ambiguous: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub data: String,
    pub encrypted: bool,
    pub format: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: u32,
    pub updated: u32,
    pub skipped: u32,
    pub skipped_items: Vec<SkipInfo>,
}

// ── In-memory unlocked state ──────────────────────────────────────────────
struct Unlocked {
    key: Zeroizing<[u8; KEY_LEN]>,
    salt: Vec<u8>,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    store: CredStore,
    last_active: Instant,
}

impl Drop for Unlocked {
    fn drop(&mut self) {
        // Scrub the decrypted store's secret fields; the key zeroizes via Zeroizing.
        self.store.zeroize();
    }
}

static VAULT: Mutex<Option<Unlocked>> = Mutex::new(None);

// ── Crypto core ───────────────────────────────────────────────────────────
struct VaultFile {
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: Vec<u8>,
    nonce: Vec<u8>,
    header: Vec<u8>, // exact on-disk header bytes [0..ciphertext) — used verbatim as AAD
    ciphertext: Vec<u8>,
}

fn build_header(m: u32, t: u32, p: u32, salt: &[u8], nonce: &[u8]) -> Vec<u8> {
    let mut h = Vec::with_capacity(18 + salt.len() + 1 + nonce.len());
    h.extend_from_slice(MAGIC);
    h.push(FORMAT_VERSION);
    h.push(KDF_ARGON2ID);
    h.push(AEAD_XCHACHA);
    h.push(0u8); // flags (reserved)
    h.extend_from_slice(&m.to_le_bytes());
    h.extend_from_slice(&t.to_le_bytes());
    h.push(p as u8);
    h.push(salt.len() as u8);
    h.extend_from_slice(salt);
    h.push(nonce.len() as u8);
    h.extend_from_slice(nonce);
    h
}

fn parse_file(bytes: &[u8]) -> Result<VaultFile, CredError> {
    const FIXED: usize = 18; // through salt_len
    if bytes.len() < FIXED {
        return Err(CredError::Corrupt("vault file truncated".into()));
    }
    if &bytes[0..4] != &MAGIC[..] {
        return Err(CredError::Corrupt("not a credential vault (bad magic)".into()));
    }
    if bytes[4] != FORMAT_VERSION {
        return Err(CredError::Corrupt(format!("unsupported vault version {}", bytes[4])));
    }
    if bytes[5] != KDF_ARGON2ID {
        return Err(CredError::Corrupt("unsupported key-derivation id".into()));
    }
    if bytes[6] != AEAD_XCHACHA {
        return Err(CredError::Corrupt("unsupported cipher id".into()));
    }
    let m_cost = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    let t_cost = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);
    let p_cost = bytes[16] as u32;
    let salt_len = bytes[17] as usize;
    let salt_end = 18 + salt_len;
    if bytes.len() < salt_end + 1 {
        return Err(CredError::Corrupt("vault file truncated (salt)".into()));
    }
    let salt = bytes[18..salt_end].to_vec();
    let nonce_len = bytes[salt_end] as usize;
    let nonce_start = salt_end + 1;
    let nonce_end = nonce_start + nonce_len;
    if bytes.len() < nonce_end {
        return Err(CredError::Corrupt("vault file truncated (nonce)".into()));
    }
    let nonce = bytes[nonce_start..nonce_end].to_vec();
    let header = bytes[0..nonce_end].to_vec();
    let ciphertext = bytes[nonce_end..].to_vec();
    Ok(VaultFile {
        m_cost,
        t_cost,
        p_cost,
        salt,
        nonce,
        header,
        ciphertext,
    })
}

fn derive_key(
    master: &[u8],
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>, CredError> {
    let params = Params::new(m, t, p, Some(KEY_LEN))
        .map_err(|e| CredError::Io(format!("argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(master, salt, &mut key[..])
        .map_err(|e| CredError::Io(format!("argon2: {e}")))?;
    Ok(key)
}

fn seal(
    key: &[u8; KEY_LEN],
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
    store: &CredStore,
) -> Result<Vec<u8>, CredError> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let header = build_header(m, t, p, salt, &nonce);
    let plaintext = Zeroizing::new(
        serde_json::to_vec(store).map_err(|e| CredError::Io(format!("serialize store: {e}")))?,
    );
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext[..],
                aad: &header,
            },
        )
        .map_err(|_| CredError::Io("encryption failed".into()))?;
    let mut out = header;
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(vf: &VaultFile, key: &[u8; KEY_LEN]) -> Result<CredStore, CredError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let pt = cipher
        .decrypt(
            XNonce::from_slice(&vf.nonce),
            Payload {
                msg: &vf.ciphertext[..],
                aad: &vf.header,
            },
        )
        .map_err(|_| CredError::BadPassword)?;
    let pt = Zeroizing::new(pt);
    serde_json::from_slice::<CredStore>(&pt)
        .map_err(|e| CredError::Corrupt(format!("vault decoded but unreadable: {e}")))
}

// ── Small utilities (hex avoids a base64 dependency) ──────────────────────
fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Normalize a URL or host to a bare lowercase host (drop scheme/path/port and a
/// leading `www.`). Used to match stored entries against the active tab's host.
fn normalize_host(input: &str) -> String {
    let lower = input.trim().to_ascii_lowercase();
    let no_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(lower.as_str());
    let host = no_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    host.strip_prefix("www.").unwrap_or(host).to_string()
}

fn store_path(app: &AppHandle) -> Result<PathBuf, CredError> {
    Ok(crate::commands::sidebar::app_config_root(app)?.join(STORE_FILE))
}

// ── Lock lifecycle helpers (idle safety-floor + access guards) ────────────
fn enforce_idle(slot: &mut Option<Unlocked>) {
    let expired = slot
        .as_ref()
        .map(|u| {
            let secs = u.store.settings.idle_timeout_secs.max(1);
            u.last_active.elapsed() > Duration::from_secs(secs)
        })
        .unwrap_or(false);
    if expired {
        *slot = None; // drops Unlocked → scrubs key + store
    }
}

fn read_unlocked<T>(f: impl FnOnce(&CredStore) -> Result<T, CredError>) -> Result<T, CredError> {
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    enforce_idle(&mut guard);
    let u = guard.as_mut().ok_or(CredError::Locked)?;
    u.last_active = Instant::now();
    f(&u.store)
}

fn mutate_and_save<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut CredStore) -> Result<T, CredError>,
) -> Result<T, CredError> {
    let path = store_path(app)?;
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    enforce_idle(&mut guard);
    let u = guard.as_mut().ok_or(CredError::Locked)?;
    u.last_active = Instant::now();
    let result = f(&mut u.store)?;
    let bytes = seal(&u.key, &u.salt, u.m_cost, u.t_cost, u.p_cost, &u.store)?;
    vault::atomic_write(&path, &bytes)?;
    Ok(result)
}

// ── Keyring opt-in (caches the derived key, salt-bound) ───────────────────
#[derive(Serialize, Deserialize)]
struct KeyringPayload {
    salt: String,
    key: String,
}

fn keyring_store(salt: &[u8], key: &[u8]) -> Result<(), CredError> {
    let payload = serde_json::json!({ "salt": to_hex(salt), "key": to_hex(key) }).to_string();
    let entry = keyring::Entry::new(KR_SERVICE, KR_ACCOUNT)
        .map_err(|e| CredError::Keyring(format!("open: {e}")))?;
    entry
        .set_password(&payload)
        .map_err(|e| CredError::Keyring(format!("set: {e}")))
}

fn keyring_load() -> Option<KeyringPayload> {
    let entry = keyring::Entry::new(KR_SERVICE, KR_ACCOUNT).ok()?;
    let s = entry.get_password().ok()?;
    serde_json::from_str(&s).ok()
}

fn keyring_delete() {
    if let Ok(entry) = keyring::Entry::new(KR_SERVICE, KR_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

// ── Password generator (stateless; OsRng rejection sampling) ──────────────
const AMBIGUOUS: &str = "Il1O0oB8S5Z2G6";

fn rand_below(n: usize) -> usize {
    debug_assert!(n > 0);
    let n = n as u64;
    let reject = n.wrapping_neg() % n; // 2^64 mod n — the low values to reject
    let mut buf = [0u8; 8];
    loop {
        OsRng.fill_bytes(&mut buf);
        let v = u64::from_le_bytes(buf);
        if v >= reject {
            return (v % n) as usize;
        }
    }
}

fn generate(opts: &GenOpts) -> Result<String, CredError> {
    let pick = |s: &str| -> Vec<char> {
        s.chars()
            .filter(|c| !(opts.avoid_ambiguous && AMBIGUOUS.contains(*c)))
            .collect()
    };
    let mut classes: Vec<Vec<char>> = Vec::new();
    if opts.lower {
        classes.push(pick("abcdefghijklmnopqrstuvwxyz"));
    }
    if opts.upper {
        classes.push(pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
    }
    if opts.digits {
        classes.push(pick("0123456789"));
    }
    if opts.symbols {
        classes.push(pick("!@#$%^&*()-_=+[]{};:,.?/"));
    }
    classes.retain(|c| !c.is_empty());
    if classes.is_empty() {
        return Err(CredError::Invalid("select at least one character set".into()));
    }
    if opts.length < classes.len().max(4) {
        return Err(CredError::Invalid(format!(
            "length must be at least {}",
            classes.len().max(4)
        )));
    }
    if opts.length > 256 {
        return Err(CredError::Invalid("length must be 256 or less".into()));
    }
    let pool: Vec<char> = classes.iter().flatten().copied().collect();
    let mut out: Vec<char> = Vec::with_capacity(opts.length);
    for class in &classes {
        out.push(class[rand_below(class.len())]);
    }
    while out.len() < opts.length {
        out.push(pool[rand_below(pool.len())]);
    }
    // Fisher-Yates shuffle so the guaranteed-class chars aren't always leading.
    for i in (1..out.len()).rev() {
        out.swap(i, rand_below(i + 1));
    }
    Ok(out.into_iter().collect())
}

// ── Import parsing ────────────────────────────────────────────────────────
/// One import entry that was not brought in, with a human-readable reason.
/// Non-secret (a name/label + reason) — safe to surface to the frontend.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkipInfo {
    pub name: String,
    pub reason: String,
}

struct Imported {
    entries: Vec<CredEntry>,
    folders: Vec<Folder>,
    skipped_items: Vec<SkipInfo>,
}

fn parse_import(data: &str, format: &str, password: Option<&str>) -> Result<Imported, CredError> {
    match format {
        "agentic" | "agentic-json" => {
            let store: CredStore = serde_json::from_str(data)
                .map_err(|e| CredError::Invalid(format!("invalid Agentic JSON: {e}")))?;
            Ok(Imported {
                entries: store.entries.clone(),
                folders: store.folders.clone(),
                skipped_items: Vec::new(),
            })
        }
        "acvn" | "encrypted" | "acvn-hex" => {
            let pw = password
                .ok_or_else(|| CredError::Invalid("password required for encrypted import".into()))?;
            let bytes =
                from_hex(data).ok_or_else(|| CredError::Invalid("malformed encrypted blob".into()))?;
            let vf = parse_file(&bytes)?;
            let key = derive_key(pw.as_bytes(), &vf.salt, vf.m_cost, vf.t_cost, vf.p_cost)?;
            let store = open(&vf, &key)?;
            Ok(Imported {
                entries: store.entries.clone(),
                folders: store.folders.clone(),
                skipped_items: Vec::new(),
            })
        }
        "bitwarden" => parse_bitwarden(data),
        "csv" => parse_csv(data),
        other => Err(CredError::Invalid(format!("unknown import format: {other}"))),
    }
}

fn parse_bitwarden(data: &str) -> Result<Imported, CredError> {
    let v: serde_json::Value = serde_json::from_str(data)
        .map_err(|e| CredError::Invalid(format!("invalid Bitwarden JSON: {e}")))?;
    let mut folders = Vec::new();
    if let Some(arr) = v.get("folders").and_then(|f| f.as_array()) {
        for f in arr {
            if let (Some(id), Some(name)) = (
                f.get("id").and_then(|x| x.as_str()),
                f.get("name").and_then(|x| x.as_str()),
            ) {
                folders.push(Folder {
                    id: id.to_string(),
                    name: name.to_string(),
                    parent: None,
                });
            }
        }
    }
    let mut entries = Vec::new();
    let mut skipped_items: Vec<SkipInfo> = Vec::new();
    if let Some(items) = v.get("items").and_then(|i| i.as_array()) {
        for it in items {
            let typ = it.get("type").and_then(|t| t.as_u64()).unwrap_or(0);
            let title = it.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let notes = it.get("notes").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let folder = it.get("folderId").and_then(|x| x.as_str()).map(String::from);
            let mut custom_fields = Vec::new();
            if let Some(fields) = it.get("fields").and_then(|f| f.as_array()) {
                for fl in fields {
                    custom_fields.push(CustomField {
                        name: fl.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        value: fl.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        hidden: fl.get("type").and_then(|x| x.as_u64()).unwrap_or(0) == 1,
                    });
                }
            }
            match typ {
                1 => {
                    let login = it.get("login");
                    let username = login
                        .and_then(|l| l.get("username"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let password = login
                        .and_then(|l| l.get("password"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let origin = login
                        .and_then(|l| l.get("uris"))
                        .and_then(|u| u.as_array())
                        .and_then(|a| a.first())
                        .and_then(|u0| u0.get("uri"))
                        .and_then(|x| x.as_str())
                        .map(String::from);
                    let host = origin.as_deref().map(normalize_host).filter(|h| !h.is_empty());
                    entries.push(CredEntry {
                        id: String::new(),
                        folder,
                        tags: Vec::new(),
                        title,
                        origin,
                        host,
                        username,
                        password,
                        notes,
                        custom_fields,
                        created: String::new(),
                        updated: String::new(),
                    });
                }
                2 => entries.push(CredEntry {
                    id: String::new(),
                    folder,
                    tags: Vec::new(),
                    title,
                    origin: None,
                    host: None,
                    username: String::new(),
                    password: String::new(),
                    notes,
                    custom_fields,
                    created: String::new(),
                    updated: String::new(),
                }),
                _ => skipped_items.push(SkipInfo {
                    // cards / identities / SSH keys — not represented in v1
                    name: if title.is_empty() { format!("item type {typ}") } else { title.clone() },
                    reason: format!("unsupported item type {typ} (cards/identities not represented in v1)"),
                }),
            }
        }
    }
    Ok(Imported {
        entries,
        folders,
        skipped_items,
    })
}

fn parse_csv_rows(data: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut field = String::new();
    let mut row: Vec<String> = Vec::new();
    let mut in_quotes = false;
    let mut chars = data.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => row.push(std::mem::take(&mut field)),
                '\r' => {}
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn parse_csv(data: &str) -> Result<Imported, CredError> {
    let rows = parse_csv_rows(data);
    if rows.is_empty() {
        return Ok(Imported {
            entries: Vec::new(),
            folders: Vec::new(),
            skipped_items: Vec::new(),
        });
    }
    let header: Vec<String> = rows[0].iter().map(|s| s.trim().to_ascii_lowercase()).collect();
    let col = |names: &[&str]| header.iter().position(|h| names.contains(&h.as_str()));
    let c_name = col(&["name", "title"]);
    let c_url = col(&["url", "uri", "login_uri"]);
    let c_user = col(&["username", "login_username", "user"]);
    let c_pass = col(&["password", "login_password", "pass"]);
    let c_notes = col(&["notes", "note"]);
    let c_folder = col(&["folder"]);
    let get = |row: &[String], idx: Option<usize>| -> String {
        idx.and_then(|i| row.get(i)).cloned().unwrap_or_default()
    };

    let mut entries = Vec::new();
    let mut skipped_items: Vec<SkipInfo> = Vec::new();
    for (ri, row) in rows.iter().enumerate().skip(1) {
        if row.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let title = get(row, c_name);
        let origin_raw = get(row, c_url);
        let origin = if origin_raw.trim().is_empty() {
            None
        } else {
            Some(origin_raw)
        };
        let username = get(row, c_user);
        let password = get(row, c_pass);
        let notes = get(row, c_notes);
        let folder_name = get(row, c_folder);
        if title.trim().is_empty()
            && username.trim().is_empty()
            && password.trim().is_empty()
            && origin.is_none()
        {
            skipped_items.push(SkipInfo {
                name: format!("row {ri}"),
                reason: "no usable fields (empty name/username/password/url)".into(),
            });
            continue;
        }
        let host = origin.as_deref().map(normalize_host).filter(|h| !h.is_empty());
        let folder = if folder_name.trim().is_empty() {
            None
        } else {
            Some(folder_name)
        };
        entries.push(CredEntry {
            id: String::new(),
            folder,
            tags: Vec::new(),
            title,
            origin,
            host,
            username,
            password,
            notes,
            custom_fields: Vec::new(),
            created: String::new(),
            updated: String::new(),
        });
    }

    // CSV folders arrive as names — synthesize Folder rows and remap entries to ids.
    let mut folders: Vec<Folder> = Vec::new();
    let mut name_to_id: HashMap<String, String> = HashMap::new();
    for e in &mut entries {
        if let Some(fname) = e.folder.clone() {
            let id = name_to_id
                .entry(fname.clone())
                .or_insert_with(|| {
                    let id = new_uuid();
                    folders.push(Folder {
                        id: id.clone(),
                        name: fname,
                        parent: None,
                    });
                    id
                })
                .clone();
            e.folder = Some(id);
        }
    }
    Ok(Imported {
        entries,
        folders,
        skipped_items,
    })
}

// ── Commands ────────────────────────────────────────────────────────────
#[tauri::command]
pub fn creds_status(app: AppHandle) -> Result<CredStatus, CredError> {
    let initialized = store_path(&app)?.exists();
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    enforce_idle(&mut guard);
    let unlocked = guard.is_some();
    let settings = guard
        .as_ref()
        .map(|u| u.store.settings.clone())
        .unwrap_or_default();
    Ok(CredStatus {
        initialized,
        unlocked,
        keyring_enabled: keyring_load().is_some(),
        idle_timeout_secs: settings.idle_timeout_secs,
        clipboard_clear_secs: settings.clipboard_clear_secs,
        reveal_remask_secs: settings.reveal_remask_secs,
        lock_on_blur: settings.lock_on_blur,
    })
}

#[tauri::command]
pub fn creds_init_master(app: AppHandle, master: String) -> Result<(), CredError> {
    let master = Zeroizing::new(master);
    if master.trim().is_empty() {
        return Err(CredError::Invalid("master password required".into()));
    }
    let path = store_path(&app)?;
    if path.exists() {
        return Err(CredError::AlreadyInit);
    }
    let mut salt = vec![0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let key = derive_key(master.as_bytes(), &salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST)?;
    let store = CredStore::new_empty();
    let bytes = seal(&key, &salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, &store)?;
    vault::atomic_write(&path, &bytes)?;
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Unlocked {
        key,
        salt,
        m_cost: ARGON_M_COST,
        t_cost: ARGON_T_COST,
        p_cost: ARGON_P_COST,
        store,
        last_active: Instant::now(),
    });
    Ok(())
}

#[tauri::command]
pub fn creds_unlock(app: AppHandle, master: String) -> Result<(), CredError> {
    let master = Zeroizing::new(master);
    let path = store_path(&app)?;
    let bytes = std::fs::read(&path).map_err(|_| CredError::NotInit)?;
    let vf = parse_file(&bytes)?;
    let key = derive_key(master.as_bytes(), &vf.salt, vf.m_cost, vf.t_cost, vf.p_cost)?;
    let store = open(&vf, &key)?;
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Unlocked {
        key,
        salt: vf.salt,
        m_cost: vf.m_cost,
        t_cost: vf.t_cost,
        p_cost: vf.p_cost,
        store,
        last_active: Instant::now(),
    });
    Ok(())
}

#[tauri::command]
pub fn creds_unlock_via_keyring(app: AppHandle) -> Result<bool, CredError> {
    let path = store_path(&app)?;
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(false);
    };
    let vf = parse_file(&bytes)?;
    let Some(payload) = keyring_load() else {
        return Ok(false);
    };
    let Some(kr_salt) = from_hex(&payload.salt) else {
        return Ok(false);
    };
    // Salt is public (it's in the file header) — a plain compare is fine here.
    // A mismatch means the master changed / file was re-encrypted: drop the stale key.
    if kr_salt != vf.salt {
        keyring_delete();
        return Ok(false);
    }
    let Some(key_bytes) = from_hex(&payload.key) else {
        return Ok(false);
    };
    if key_bytes.len() != KEY_LEN {
        return Ok(false);
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&key_bytes);
    let store = match open(&vf, &key) {
        Ok(s) => s,
        Err(_) => {
            keyring_delete();
            return Ok(false);
        }
    };
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Unlocked {
        key,
        salt: vf.salt,
        m_cost: vf.m_cost,
        t_cost: vf.t_cost,
        p_cost: vf.p_cost,
        store,
        last_active: Instant::now(),
    });
    Ok(true)
}

#[tauri::command]
pub fn creds_lock() {
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

/// Called from the main window's focus handler when the TOPLEVEL window loses
/// focus (real app-switch — not focus moving to a child native web view in the
/// same window). Locks the vault iff the user enabled lock-on-blur. Returns
/// whether it locked, so the caller can notify the frontend to re-sync.
pub fn lock_if_blur_enabled() -> bool {
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    let should = guard
        .as_ref()
        .map(|u| u.store.settings.lock_on_blur)
        .unwrap_or(false);
    if should {
        *guard = None;
    }
    should
}

#[tauri::command]
pub fn creds_touch() {
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    enforce_idle(&mut guard);
    if let Some(u) = guard.as_mut() {
        u.last_active = Instant::now();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultList {
    pub entries: Vec<CredSummary>,
    pub folders: Vec<Folder>,
}

#[tauri::command]
pub fn creds_list() -> Result<VaultList, CredError> {
    read_unlocked(|store| {
        Ok(VaultList {
            entries: store.entries.iter().map(CredSummary::from).collect(),
            folders: store.folders.clone(),
        })
    })
}

#[tauri::command]
pub fn creds_get(id: String) -> Result<CredEntryFull, CredError> {
    read_unlocked(|store| {
        store
            .entries
            .iter()
            .find(|e| e.id == id)
            .map(CredEntryFull::from)
            .ok_or_else(|| CredError::NotFound(id.clone()))
    })
}

#[tauri::command]
pub fn creds_match_host(host: String) -> Result<Vec<CredSummary>, CredError> {
    // Exact normalized-host match only (under-match): never offer a parent
    // domain's creds on a sibling subdomain. Subdomain matching is a deliberate
    // future enhancement, not a v1 default.
    let q = normalize_host(&host);
    read_unlocked(|store| {
        Ok(store
            .entries
            .iter()
            .filter(|e| e.host.as_deref().map(normalize_host).as_deref() == Some(q.as_str()))
            .map(CredSummary::from)
            .collect())
    })
}

#[tauri::command]
pub fn creds_upsert(app: AppHandle, input: CredEntryInput) -> Result<CredEntryFull, CredError> {
    if input.title.trim().is_empty()
        && input.username.trim().is_empty()
        && input.origin.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err(CredError::Invalid("entry needs a title, username, or site".into()));
    }
    let now = now_rfc3339();
    mutate_and_save(&app, move |store| {
        let host = input
            .origin
            .as_deref()
            .map(normalize_host)
            .filter(|h| !h.is_empty());
        match input.id.as_ref().filter(|s| !s.is_empty()) {
            Some(id) => {
                let e = store
                    .entries
                    .iter_mut()
                    .find(|e| &e.id == id)
                    .ok_or_else(|| CredError::NotFound(id.clone()))?;
                e.folder = input.folder.clone();
                e.tags = input.tags.clone();
                e.title = input.title.clone();
                e.origin = input.origin.clone();
                e.host = host;
                e.username = input.username.clone();
                e.password = input.password.clone();
                e.notes = input.notes.clone();
                e.custom_fields = input.custom_fields.clone();
                e.updated = now.clone();
                Ok(CredEntryFull::from(&*e))
            }
            None => {
                let entry = CredEntry {
                    id: new_uuid(),
                    folder: input.folder.clone(),
                    tags: input.tags.clone(),
                    title: input.title.clone(),
                    origin: input.origin.clone(),
                    host,
                    username: input.username.clone(),
                    password: input.password.clone(),
                    notes: input.notes.clone(),
                    custom_fields: input.custom_fields.clone(),
                    created: now.clone(),
                    updated: now.clone(),
                };
                let full = CredEntryFull::from(&entry);
                store.entries.push(entry);
                Ok(full)
            }
        }
    })
}

#[tauri::command]
pub fn creds_delete(app: AppHandle, id: String) -> Result<(), CredError> {
    mutate_and_save(&app, |store| {
        let before = store.entries.len();
        store.entries.retain(|e| e.id != id);
        if store.entries.len() == before {
            return Err(CredError::NotFound(id.clone()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn creds_folders_set(app: AppHandle, folders: Vec<Folder>) -> Result<Vec<Folder>, CredError> {
    mutate_and_save(&app, |store| {
        store.folders = folders.clone();
        Ok(store.folders.clone())
    })
}

#[tauri::command]
pub fn creds_generate_password(opts: GenOpts) -> Result<String, CredError> {
    generate(&opts)
}

#[tauri::command]
pub fn creds_export(app: AppHandle, password: Option<String>) -> Result<ExportResult, CredError> {
    let _ = &app; // path not needed; export reads the in-memory store
    read_unlocked(|store| match password.as_deref() {
        Some(pw) if !pw.is_empty() => {
            let pw = Zeroizing::new(pw.to_string());
            let mut salt = vec![0u8; SALT_LEN];
            OsRng.fill_bytes(&mut salt);
            let key = derive_key(pw.as_bytes(), &salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST)?;
            let bytes = seal(&key, &salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, store)?;
            Ok(ExportResult {
                data: to_hex(&bytes),
                encrypted: true,
                format: "acvn-hex".into(),
            })
        }
        _ => {
            let json = serde_json::to_string_pretty(store)
                .map_err(|e| CredError::Io(format!("serialize export: {e}")))?;
            Ok(ExportResult {
                data: json,
                encrypted: false,
                format: "agentic-json".into(),
            })
        }
    })
}

/// Apply a parsed import into the unlocked store (merge dedupes on host+username;
/// replace clears first). Shared by `creds_import` (pasted text) and
/// `creds_import_file` (a file picked from disk).
fn apply_import(
    app: &AppHandle,
    imported: Imported,
    mode: &str,
) -> Result<ImportSummary, CredError> {
    let now = now_rfc3339();
    let mode = mode.to_string();
    mutate_and_save(app, move |store| {
        let mut summary = ImportSummary {
            skipped: imported.skipped_items.len() as u32,
            skipped_items: imported.skipped_items,
            ..Default::default()
        };
        if mode == "replace" {
            store.entries.clear();
            if !imported.folders.is_empty() {
                store.folders = imported.folders.clone();
            }
        } else {
            for f in &imported.folders {
                if !store.folders.iter().any(|x| x.id == f.id) {
                    store.folders.push(f.clone());
                }
            }
        }
        for mut e in imported.entries {
            let can_dedupe = !e.username.is_empty() && e.host.is_some();
            if mode == "merge" && can_dedupe {
                if let Some(existing) = store
                    .entries
                    .iter_mut()
                    .find(|x| x.host == e.host && x.username == e.username)
                {
                    existing.password = e.password.clone();
                    existing.notes = e.notes.clone();
                    if !e.custom_fields.is_empty() {
                        existing.custom_fields = e.custom_fields.clone();
                    }
                    existing.updated = now.clone();
                    summary.updated += 1;
                    continue;
                }
            }
            if e.id.is_empty() {
                e.id = new_uuid();
            }
            if e.created.is_empty() {
                e.created = now.clone();
            }
            e.updated = now.clone();
            store.entries.push(e);
            summary.added += 1;
        }
        Ok(summary)
    })
}

#[tauri::command]
pub fn creds_import(
    app: AppHandle,
    data: String,
    format: String,
    password: Option<String>,
    mode: String,
) -> Result<ImportSummary, CredError> {
    let imported = parse_import(&data, &format, password.as_deref())?;
    apply_import(&app, imported, &mode)
}

/// Import from a file the user picked via the OS dialog (the dialog IS the
/// permission grant — no vault sandboxing). The plaintext file contents stay
/// Rust-side and are zeroized after parse; only a non-secret summary returns.
#[tauri::command]
pub fn creds_import_file(
    app: AppHandle,
    path: String,
    format: String,
    password: Option<String>,
    mode: String,
) -> Result<ImportSummary, CredError> {
    let data = Zeroizing::new(
        std::fs::read_to_string(&path).map_err(|e| CredError::Io(format!("read import file: {e}")))?,
    );
    let imported = parse_import(&data, &format, password.as_deref())?;
    apply_import(&app, imported, &mode)
}

/// Delete a plaintext export file from disk after a successful import (opt-in
/// cleanup so unencrypted secrets don't linger in Downloads). A plain remove —
/// not a secure shred (overwrite passes are meaningless on SSDs).
#[tauri::command]
pub fn creds_delete_import_file(path: String) -> Result<(), CredError> {
    std::fs::remove_file(&path).map_err(|e| CredError::Io(format!("delete import file: {e}")))
}

#[tauri::command]
pub fn creds_change_master(
    app: AppHandle,
    current: String,
    next: String,
) -> Result<(), CredError> {
    let current = Zeroizing::new(current);
    let next = Zeroizing::new(next);
    if next.trim().is_empty() {
        return Err(CredError::Invalid("new master password required".into()));
    }
    let path = store_path(&app)?;
    let bytes = std::fs::read(&path).map_err(|_| CredError::NotInit)?;
    let vf = parse_file(&bytes)?;
    // Re-verify the CURRENT master even if already unlocked — prevents an
    // idle-unlocked session from silently rotating the master.
    let cur_key = derive_key(current.as_bytes(), &vf.salt, vf.m_cost, vf.t_cost, vf.p_cost)?;
    let store = open(&vf, &cur_key)?;
    let mut new_salt = vec![0u8; SALT_LEN];
    OsRng.fill_bytes(&mut new_salt);
    let new_key = derive_key(
        next.as_bytes(),
        &new_salt,
        ARGON_M_COST,
        ARGON_T_COST,
        ARGON_P_COST,
    )?;
    let out = seal(
        &new_key,
        &new_salt,
        ARGON_M_COST,
        ARGON_T_COST,
        ARGON_P_COST,
        &store,
    )?;
    // Write to disk BEFORE swapping the in-memory key, so a failed write leaves
    // the old key valid against the old (still-on-disk) file.
    vault::atomic_write(&path, &out)?;
    if keyring_load().is_some() {
        let _ = keyring_store(&new_salt, &new_key[..]);
    }
    let mut guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Unlocked {
        key: new_key,
        salt: new_salt,
        m_cost: ARGON_M_COST,
        t_cost: ARGON_T_COST,
        p_cost: ARGON_P_COST,
        store,
        last_active: Instant::now(),
    });
    Ok(())
}

#[tauri::command]
pub fn creds_set_keyring_unlock(app: AppHandle, enabled: bool) -> Result<(), CredError> {
    let _ = &app;
    if enabled {
        let guard = VAULT.lock().unwrap_or_else(|e| e.into_inner());
        let u = guard.as_ref().ok_or(CredError::Locked)?;
        keyring_store(&u.salt, &u.key[..])
    } else {
        keyring_delete();
        Ok(())
    }
}

#[tauri::command]
pub fn creds_settings_get() -> Result<CredSettings, CredError> {
    read_unlocked(|store| Ok(store.settings.clone()))
}

#[tauri::command]
pub fn creds_settings_set(
    app: AppHandle,
    settings: CredSettings,
) -> Result<CredSettings, CredError> {
    if !(60..=86_400).contains(&settings.idle_timeout_secs) {
        return Err(CredError::Invalid("idle timeout must be 60–86400 seconds".into()));
    }
    if !(5..=300).contains(&settings.clipboard_clear_secs) {
        return Err(CredError::Invalid("clipboard clear must be 5–300 seconds".into()));
    }
    if !(3..=120).contains(&settings.reveal_remask_secs) {
        return Err(CredError::Invalid("reveal remask must be 3–120 seconds".into()));
    }
    mutate_and_save(&app, move |store| {
        store.settings = settings.clone();
        Ok(store.settings.clone())
    })
}
