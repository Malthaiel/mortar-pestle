//! Shared answer cache for outbound JSON APIs: an in-memory LRU plus one JSON
//! file per key on disk, under `app_cache_dir()/<name>`. Each caller owns a
//! static `HttpCache` with its own folder (anime/, musicbrainz/). Lifted out of
//! `anime_search.rs` so MusicBrainz reuses it instead of a second copy.
//!
//! Entries come back regardless of freshness; callers decide what a stale entry
//! means (anime and MusicBrainz both serve it and refresh in the background).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MEM_CAP: usize = 500;

#[derive(Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    url: String,
    pub value: serde_json::Value,
    pub fetched_at: u64,
    pub ttl_secs: u64,
}

impl CacheEntry {
    pub fn is_fresh(&self) -> bool {
        now_secs().saturating_sub(self.fetched_at) < self.ttl_secs
    }
}

struct MemCache {
    map: HashMap<String, (CacheEntry, u64)>,
    seq: u64,
}

pub struct HttpCache {
    name: &'static str,
    dir: OnceLock<PathBuf>,
    mem: OnceLock<Mutex<MemCache>>,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl HttpCache {
    pub const fn new(name: &'static str) -> Self {
        Self { name, dir: OnceLock::new(), mem: OnceLock::new() }
    }

    /// Capture the per-app cache dir at startup (called from `lib.rs` setup). If
    /// the dir can't be resolved/created, the disk cache silently disables
    /// (mem-only).
    pub fn init_dir(&self, app: &tauri::AppHandle) {
        use tauri::Manager;
        match app.path().app_cache_dir() {
            Ok(dir) => {
                let sub = dir.join(self.name);
                match std::fs::create_dir_all(&sub) {
                    Ok(()) => {
                        let _ = self.dir.set(sub);
                    }
                    Err(e) => eprintln!("{} cache dir create failed: {e} — disk cache disabled", self.name),
                }
            }
            Err(e) => eprintln!("app_cache_dir unavailable: {e} — {} disk cache disabled", self.name),
        }
    }

    fn mem(&self) -> &Mutex<MemCache> {
        self.mem.get_or_init(|| Mutex::new(MemCache { map: HashMap::new(), seq: 0 }))
    }

    fn file(&self, key: &str) -> Option<PathBuf> {
        let dir = self.dir.get()?;
        let mut h = DefaultHasher::new();
        key.hash(&mut h);
        Some(dir.join(format!("{:016x}.json", h.finish())))
    }

    fn mem_insert(&self, key: &str, entry: CacheEntry) {
        let mut m = self.mem().lock().unwrap_or_else(|e| e.into_inner());
        m.seq += 1;
        let seq = m.seq;
        if !m.map.contains_key(key) && m.map.len() >= MEM_CAP {
            if let Some(victim) = m
                .map
                .iter()
                .min_by_key(|(_, (_, s))| *s)
                .map(|(k, _)| k.clone())
            {
                m.map.remove(&victim);
            }
        }
        m.map.insert(key.to_string(), (entry, seq));
    }

    /// Look up a cached entry (mem first, then disk → promoted into mem). Returns
    /// it regardless of freshness; callers decide via `is_fresh`.
    pub fn lookup(&self, key: &str) -> Option<CacheEntry> {
        {
            let mut m = self.mem().lock().unwrap_or_else(|e| e.into_inner());
            m.seq += 1;
            let seq = m.seq;
            if let Some(slot) = m.map.get_mut(key) {
                slot.1 = seq;
                return Some(slot.0.clone());
            }
        }
        let path = self.file(key)?;
        let bytes = std::fs::read(&path).ok()?;
        let entry: CacheEntry = serde_json::from_slice(&bytes).ok()?;
        self.mem_insert(key, entry.clone());
        Some(entry)
    }

    pub fn store(&self, key: &str, value: &serde_json::Value, ttl_secs: u64) {
        let entry = CacheEntry {
            url: key.to_string(),
            value: value.clone(),
            fetched_at: now_secs(),
            ttl_secs,
        };
        self.mem_insert(key, entry.clone());
        // Per-key filename → distinct files, no cross-write contention.
        if let Some(path) = self.file(key) {
            if let Ok(bytes) = serde_json::to_vec(&entry) {
                let _ = std::fs::write(&path, bytes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Live answers (ttl 0) must always read stale so every visit re-checks;
    // week answers read fresh. Mem-only: no dir was initialised.
    #[test]
    fn ttl_zero_is_always_stale_and_week_is_fresh() {
        static C: HttpCache = HttpCache::new("test");
        C.store("live", &serde_json::json!([1]), 0);
        C.store("week", &serde_json::json!([2]), 7 * 86_400);
        assert!(!C.lookup("live").unwrap().is_fresh());
        assert!(C.lookup("week").unwrap().is_fresh());
        assert_eq!(C.lookup("week").unwrap().value, serde_json::json!([2]));
        assert!(C.lookup("missing").is_none());
    }
}
