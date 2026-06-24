//! Whisper model registry, cache, and SHA-verified fetch-on-demand (Voice Transcription).
//!
//! The SF2 seam (cache-path resolution) grown into the SF3 model registry + downloader.
//! A `load_model {name}` resolves `name` against the static [`REGISTRY`] table (the
//! single source of truth for both this downloader and Phase 5's Settings picker), then
//! ensures the model file is present + SHA256-verified under the XDG data-dir cache
//! (`~/.local/share/iskariel/models/whisper/<name>.bin`), fetching it on first use.
//!
//! Integrity contract (SF3): download to a temp file IN THE CACHE DIR → hash the bytes
//! as they stream → verify against the published HuggingFace git-LFS SHA256 OID → only
//! THEN atomically rename into place. A missing OR hash-mismatched cache file is
//! (re)downloaded; a verified file is never re-downloaded. Any download/verify failure
//! deletes the temp and surfaces a retryable error — never a corrupt load. Models are
//! NEVER bundled (binary packaging is SF4); they always arrive via this path.
#![allow(dead_code)] // `multilingual` + `DEFAULT_MODEL` are seeded for the Phase 5 picker.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::protocol::CachedModelInfo;

/// A registry entry: where to fetch the ggml model, the SHA256 to verify it against, its
/// exact byte size, and whether it is multilingual (vs English-only). `sha256` +
/// `size_bytes` are the file's published HuggingFace git-LFS OID + size.
pub struct ModelInfo {
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
    pub multilingual: bool,
}

/// Default model when a caller specifies none — the registry's seed default (the
/// multilingual `small`). SF3's `load_model` always passes an explicit name; this is
/// consumed by Phase 5's Settings picker.
pub const DEFAULT_MODEL: &str = "small";

/// The static model registry — single source of truth for the downloader and the
/// (Phase 5) Settings picker. URLs resolve the ggml `.bin` from whisper.cpp's HF repo;
/// `sha256` is that file's git-LFS OID. Seeded 2026-06-16 from the HF LFS pointers
/// (`/raw/main/`), cross-verified against the staged `base.en.bin` (both its SHA256 and
/// the whisper.cpp `models/README.md` SHA1 matched the on-disk file).
static REGISTRY: &[ModelInfo] = &[
    ModelInfo {
        name: "base.en",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        size_bytes: 147_964_211,
        multilingual: false,
    },
    ModelInfo {
        name: "small",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        size_bytes: 487_601_967,
        multilingual: true,
    },
    ModelInfo {
        name: "small.en",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
        sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
        size_bytes: 487_614_201,
        multilingual: false,
    },
    ModelInfo {
        name: "large-v3-turbo-q5_0",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        size_bytes: 574_041_195,
        multilingual: true,
    },
    // Silero VAD model (whisper.cpp's built-in VAD via whisper-rs `WhisperVadContext`).
    // NOT a speech model and NOT multilingual — `multilingual` is inapplicable to a VAD
    // model; kept `false` because the struct has no VAD/`kind` discriminant and nothing
    // branches on it. Fetched-on-demand + SHA256-verified through the SAME `ensure_model`
    // path as the speech models (name-keyed, kind-agnostic), and NEVER bundled. Loaded by
    // `daemon::dictation` on `start_dictation` (not the whisper worker). SHA256 + size are
    // the file's published HF git-LFS OID + byte size.
    ModelInfo {
        name: "silero-v5.1.2",
        url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
        sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
        size_bytes: 885_098,
        multilingual: false,
    },
];

/// Look up a model by exact registry name. `None` ⇒ unknown name (→ `bad_request`,
/// never a fetch attempt).
pub fn lookup(name: &str) -> Option<&'static ModelInfo> {
    REGISTRY.iter().find(|m| m.name == name)
}

/// The model cache dir. Windows: `%LOCALAPPDATA%\iskariel\models\whisper` (non-roaming
/// — models are multi-GB). Linux: `~/.local/share/iskariel/models/whisper` (honoring
/// `$XDG_DATA_HOME`).
///
/// The standalone sidecar has no Tauri path API, so the per-OS base dir is resolved
/// directly — mirroring how `daemon/socket.rs` resolves its per-OS endpoint.
#[cfg(target_os = "windows")]
pub fn model_cache_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("iskariel")
        .join("models")
        .join("whisper")
}

/// Linux/other: prefer a non-empty `$XDG_DATA_HOME`, else `$HOME/.local/share`, else
/// the current dir (see the Windows arm above).
#[cfg(not(target_os = "windows"))]
pub fn model_cache_dir() -> PathBuf {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local")
                .join("share")
        });
    data.join("iskariel").join("models").join("whisper")
}

/// Resolve a registry model `name` (e.g. `base.en`) to its cached file path
/// `<cache>/<name>.bin`. The fetch-on-demand step in [`ensure_model`] lands the file
/// here; this is the path the whisper worker loads from.
pub fn resolve_model_path(name: &str) -> PathBuf {
    model_cache_dir().join(format!("{name}.bin"))
}

/// A model proven present + SHA256-verified at `path`. `sha256` is the verified hash
/// (the registry OID), surfaced into `model_loaded.sha`.
pub struct EnsuredModel {
    pub path: PathBuf,
    pub sha256: &'static str,
}

/// Why a model couldn't be made available. `UnknownModel` ⇒ `bad_request` (no fetch
/// attempted); `Download` ⇒ `model_download_failed` (retryable — a network, IO, or hash
/// failure; the partial temp is already cleaned up).
pub enum ModelError {
    UnknownModel(String),
    Download(String),
}

/// Ensure `name`'s model file is present + SHA256-verified in the cache, fetching on
/// demand. `on_progress(pct)` is invoked with `0..=100` during a download (never for an
/// already-verified cache hit). Returns the resolved path + verified hash.
///
/// - unknown name → `UnknownModel` (caller maps to `bad_request`; NO network touched)
/// - cache file present + hash matches → returned immediately (never re-downloaded)
/// - cache file missing OR hash-mismatched → (re)download → verify → atomic rename
/// - any download/verify failure → temp deleted, `Download` returned (no corrupt file)
///
/// An existing file is re-hashed every load — this is what catches a single-byte
/// corruption that a size check would miss (the SF3 gate's corruption test), at the cost
/// of a one-time stream-hash (~0.5s for `base.en`, ~2s for the 574 MB model).
pub fn ensure_model<F: FnMut(f64)>(name: &str, mut on_progress: F) -> Result<EnsuredModel, ModelError> {
    let info = lookup(name).ok_or_else(|| ModelError::UnknownModel(name.to_string()))?;
    let path = resolve_model_path(name);

    if path.exists() {
        match sha256_file(&path) {
            Ok(hash) if hash == info.sha256 => {
                log::info!("model `{name}` present + SHA256-verified at {} — no download", path.display());
                return Ok(EnsuredModel { path, sha256: info.sha256 });
            }
            Ok(bad) => log::warn!(
                "model `{name}` on disk failed SHA256 (got {bad}, want {}) — re-downloading",
                info.sha256
            ),
            Err(e) => log::warn!("model `{name}` hash check failed ({e}) — re-downloading"),
        }
    }

    // Loads are not mid-download cancellable (a never-set flag); only the Phase 5
    // download-only path ([`download_model`]) threads a real cancel. The `Ok(false)`
    // (cancelled) arm is therefore unreachable here.
    let never = AtomicBool::new(false);
    download_and_verify(info, &path, &never, &mut on_progress)?;
    log::info!("model `{name}` downloaded + SHA256-verified → {}", path.display());
    Ok(EnsuredModel { path, sha256: info.sha256 })
}

/// All user-selectable speech models in the registry, each with its cache status —
/// the Phase 5 Settings model picker (`list_models`). The VAD model (`silero-*`) is
/// excluded (an internal dependency, never a picker choice). `cached` is a cheap
/// presence+size check (a full re-hash is the load path's job), so listing is fast
/// and never touches the network.
pub fn list_cached_models() -> Vec<CachedModelInfo> {
    REGISTRY
        .iter()
        .filter(|m| !m.name.starts_with("silero"))
        .map(|m| {
            let path = resolve_model_path(m.name);
            let cached = std::fs::metadata(&path).map(|md| md.len() == m.size_bytes).unwrap_or(false);
            CachedModelInfo {
                name: m.name.to_string(),
                multilingual: m.multilingual,
                size_bytes: m.size_bytes,
                cached,
            }
        })
        .collect()
}

/// Delete a cached model file (Phase 5 Settings "Delete"). Idempotent: a missing
/// file is success. An unknown registry name → `UnknownModel` (`bad_request`); any
/// other IO failure → `Download` (surfaced as `internal`). NO recycle bin — a
/// registry model is re-downloadable, so deletion is a trivial revert.
pub fn delete_cached_model(name: &str) -> Result<(), ModelError> {
    lookup(name).ok_or_else(|| ModelError::UnknownModel(name.to_string()))?;
    let path = resolve_model_path(name);
    match std::fs::remove_file(&path) {
        Ok(()) => {
            log::info!("model `{name}` deleted from cache ({})", path.display());
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ModelError::Download(format!("delete {}: {e}", path.display()))),
    }
}

/// Download + SHA256-verify a model into the cache WITHOUT loading it (Phase 5
/// Settings "Download" — download ≠ activate). `Ok(true)` = present + verified;
/// `Ok(false)` = cancelled mid-download (the shared `cancel` flag was raised; the
/// temp is discarded). An already-verified cache hit returns `Ok(true)` with no
/// fetch. Reuses [`ensure_model`]'s integrity contract but never touches the
/// resident model and is mid-download cancellable.
pub fn download_model<F: FnMut(f64)>(
    name: &str,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<bool, ModelError> {
    let info = lookup(name).ok_or_else(|| ModelError::UnknownModel(name.to_string()))?;
    let path = resolve_model_path(name);
    if path.exists() {
        if let Ok(hash) = sha256_file(&path) {
            if hash == info.sha256 {
                log::info!("model `{name}` already present + SHA256-verified — no download");
                return Ok(true);
            }
        }
    }
    download_and_verify(info, &path, cancel, &mut on_progress)
}

/// Download `info.url` to a temp file in the cache dir, hashing as it streams; verify the
/// SHA256 against `info.sha256`; atomically rename into `dest` ONLY on a match. Connect +
/// per-read timeouts catch a hung socket, but there is no total-duration cap (a 574 MB
/// model on a slow link must be allowed to finish). No auto-retry: any failure deletes
/// the temp and returns a retryable `Download` error — never a corrupt or partial file.
fn download_and_verify<F: FnMut(f64)>(
    info: &ModelInfo,
    dest: &Path,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<bool, ModelError> {
    let cache_dir = model_cache_dir();
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| ModelError::Download(format!("create cache dir {}: {e}", cache_dir.display())))?;

    // Temp in the SAME dir as dest so the commit is a true atomic rename (no cross-FS
    // copy). Clear any stale temp left by a prior crashed/cancelled fetch.
    let tmp = cache_dir.join(format!("{}.bin.part", info.name));
    let _ = std::fs::remove_file(&tmp);

    log::info!("downloading model `{}` ({} bytes) from {}", info.name, info.size_bytes, info.url);
    let agent = ureq::builder()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(30))
        .build();
    let resp = agent
        .get(info.url)
        .call()
        .map_err(|e| ModelError::Download(format!("GET {}: {e} (retryable)", info.url)))?;

    // Progress denominator: prefer the server's Content-Length, fall back to the
    // registry's known size (HF's CDN may stream the body chunked, with no length).
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(info.size_bytes);

    let mut reader = resp.into_reader();
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| fail(&tmp, format!("create temp {}: {e}", tmp.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_pct: i64 = -1;

    loop {
        // Cooperative cancellation (Phase 5 download-only path): a raised flag
        // discards the temp and reports `Ok(false)`. `ensure_model`'s load path
        // passes a never-set flag, so its behavior is unchanged.
        if cancel.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&tmp);
            log::info!("download of `{}` cancelled — temp discarded", info.name);
            return Ok(false);
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(fail(&tmp, format!("read body: {e} (retryable)"))),
        };
        if let Err(e) = file.write_all(&buf[..n]) {
            return Err(fail(&tmp, format!("write temp: {e}")));
        }
        hasher.update(&buf[..n]);
        downloaded += n as u64;
        let pct = ((downloaded.min(total) * 100) / total) as i64;
        if pct != last_pct {
            last_pct = pct;
            on_progress(pct as f64);
        }
    }

    if let Err(e) = file.sync_all() {
        return Err(fail(&tmp, format!("flush temp: {e}")));
    }
    drop(file);

    let digest = hasher.finalize();
    let got = hex_lower(&digest);
    if got != info.sha256 {
        return Err(fail(
            &tmp,
            format!(
                "SHA256 mismatch for `{}` (got {got}, want {}) — download corrupt, retry (retryable)",
                info.name, info.sha256
            ),
        ));
    }

    std::fs::rename(&tmp, dest)
        .map_err(|e| fail(&tmp, format!("atomic rename {} → {}: {e}", tmp.display(), dest.display())))?;
    Ok(true)
}

/// Delete a failed temp file and build the `Download` error in one move, so every
/// failure path leaves no partial file behind (integrity contract).
fn fail(tmp: &Path, message: String) -> ModelError {
    let _ = std::fs::remove_file(tmp);
    ModelError::Download(message)
}

/// SHA256 a file by streaming it — used to verify an existing cache file before trusting
/// it (catches a single-byte corruption a size check would miss).
fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(hex_lower(&digest))
}

/// Lowercase hex encoding (avoids a `hex` crate dependency).
fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}
