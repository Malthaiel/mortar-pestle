//! LRU-bounded frontmatter cache, ported from `server/src/vault/frontmatter-cache.js`.
//!
//! Reads only the head bytes of each file (cheap) and parses with the
//! YAML-subset parser. Keyed by absolute path + mtime_ms — stale entries
//! serve until the file changes, then auto-refresh on the next request.
//! Bulk-invalidated when the manifest reloads (Sub-feature 4 / 5).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde_json::{Map, Value};

use crate::parsers::frontmatter::parse_frontmatter;

const CACHE_CAP: usize = 4096;
const HEAD_BYTES: usize = 8192;

struct Entry {
    mtime_ms: f64,
    meta: Map<String, Value>,
    /// Insertion order for FIFO-style eviction. Mirrors Node's `Map`-based
    /// `cache.keys().next().value` first-key drop.
    seq: u64,
}

struct CacheState {
    entries: HashMap<String, Entry>,
    next_seq: u64,
}

fn state() -> &'static Mutex<CacheState> {
    static S: OnceLock<Mutex<CacheState>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(CacheState {
            entries: HashMap::new(),
            next_seq: 0,
        })
    })
}

fn read_head(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let _ = f.seek(SeekFrom::Start(0));
    let mut buf = vec![0u8; HEAD_BYTES];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn mtime_ms_of(path: &Path) -> Option<f64> {
    let meta = fs::metadata(path).ok()?;
    let m = meta.modified().ok()?;
    let d = m.duration_since(UNIX_EPOCH).ok()?;
    Some(d.as_secs_f64() * 1000.0)
}

/// Get the frontmatter map for `abs_path`. Empty map on missing/unreadable file
/// (mirrors Node's `getFrontmatter`).
pub fn get_frontmatter(abs_path: &Path) -> Map<String, Value> {
    let mtime = match mtime_ms_of(abs_path) {
        Some(v) => v,
        None => return Map::new(),
    };
    let key = abs_path.to_string_lossy().into_owned();

    {
        let s = state().lock().unwrap();
        if let Some(e) = s.entries.get(&key) {
            if (e.mtime_ms - mtime).abs() < 0.5 {
                return e.meta.clone();
            }
        }
    }

    let head = match read_head(abs_path) {
        Ok(s) => s,
        Err(_) => return Map::new(),
    };
    let (meta, _body) = parse_frontmatter(&head);

    let mut s = state().lock().unwrap();
    if s.entries.len() >= CACHE_CAP {
        // Evict the oldest insertion. Linear scan for the smallest seq is
        // acceptable at CACHE_CAP=4096 (~100µs per eviction is rare anyway).
        let oldest = s
            .entries
            .iter()
            .min_by_key(|(_, e)| e.seq)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            s.entries.remove(&k);
        }
    }
    let seq = s.next_seq;
    s.next_seq += 1;
    s.entries.insert(
        key,
        Entry {
            mtime_ms: mtime,
            meta: meta.clone(),
            seq,
        },
    );
    meta
}

/// Drop every cached entry. Called by the manifest-reload bus.
#[allow(dead_code)]
pub fn invalidate_all() {
    let mut s = state().lock().unwrap();
    s.entries.clear();
}
