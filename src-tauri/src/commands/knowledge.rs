//! Sub-feature 4 — Knowledge browser, manifest-backed search, root counts.
//!
//! Ports `server/src/vault/knowledge.js` to Tauri IPC. All four commands read
//! the in-memory manifest exposed by `crate::render::manifest`. The body-search
//! cache (Index summaries scraped from `Infrastructure/Indexes/<Domain> Index.md`)
//! is mtime-keyed via `OnceLock<RwLock<…>>`, mirroring `manifest::ensure_loaded`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{LazyLock, OnceLock, RwLock};
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::commands::vault::vault_root;
use crate::render::manifest;

const KNOWLEDGE_PREFIX: &str = "Knowledge/";

// ── slugify ────────────────────────────────────────────────────────────────
// Mirrors Node's `name.normalize('NFC').toLowerCase().replace(/\s+/g, '-')`.

static RE_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

pub fn slugify(name: &str) -> String {
    let nfc: String = name.nfc().collect();
    let lower = nfc.to_lowercase();
    RE_WS.replace_all(&lower, "-").into_owned()
}

/// The active vault's Knowledge-root prefix ("Knowledge/" by default, or the
/// SF4 adapter mapping's `knowledgeRoot`). Domain enumeration + title search
/// key off this so a foreign vault's mapped folder lights up the Knowledge UI.
/// (Body-search keeps the literal `KNOWLEDGE_PREFIX` — its `Infrastructure/
/// Indexes/` dependency is a separately-deferred Citadel-ism.)
fn knowledge_prefix() -> String {
    format!("{}/", crate::commands::vaults::knowledge_root())
}

// ── knowledge_list_domains ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Domain {
    pub slug: String,
    pub name: String,
    pub count: u32,
    pub mtime: Option<String>,
}

#[derive(Serialize)]
pub struct DomainsOut {
    pub domains: Vec<Domain>,
}

fn leaf_title(entry: &manifest::Entry) -> String {
    if let Some(t) = entry.title.as_deref() {
        if !t.is_empty() {
            return t.to_string();
        }
    }
    let stem = entry.path.trim_end_matches(".md");
    Path::new(stem)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn knowledge_list_domains() -> DomainsOut {
    let entries = manifest::all_entries();
    let prefix = knowledge_prefix();

    // Group by domain (parts[1] under the Knowledge root).
    // Preserve insertion order so ties in `count` resolve the same way Node's
    // `Map` iteration does.
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<manifest::Entry>> = HashMap::new();

    for e in entries {
        if !e.path.starts_with(prefix.as_str()) {
            continue;
        }
        let parts: Vec<&str> = e.path.split('/').collect();
        if parts.len() < 3 {
            continue;
        }
        let domain = parts[1].to_string();
        if !groups.contains_key(&domain) {
            order.push(domain.clone());
        }
        groups.entry(domain).or_default().push(e);
    }

    let mut domains: Vec<Domain> = order
        .into_iter()
        .map(|name| {
            let group = groups.remove(&name).unwrap_or_default();
            let mut max_mtime: Option<String> = None;
            for e in &group {
                if let Some(m) = &e.mtime {
                    match &max_mtime {
                        None => max_mtime = Some(m.clone()),
                        Some(cur) if m > cur => max_mtime = Some(m.clone()),
                        _ => {}
                    }
                }
            }
            Domain {
                slug: slugify(&name),
                count: group.len() as u32,
                mtime: max_mtime,
                name,
            }
        })
        .collect();

    // Stable sort by count desc — ties preserve insertion order.
    domains.sort_by(|a, b| b.count.cmp(&a.count));
    DomainsOut { domains }
}

// ── knowledge_search ───────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub path: String,
    pub domain: String,
    pub slug: String,
    #[serde(rename = "matchedField")]
    pub matched_field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Serialize)]
pub struct SearchOut {
    pub results: Vec<SearchResult>,
}

fn search_titles(q: &str, limit: usize) -> Vec<SearchResult> {
    let entries = manifest::all_entries();
    let prefix = knowledge_prefix();
    let mut out: Vec<SearchResult> = Vec::new();
    for e in entries {
        if out.len() >= limit {
            break;
        }
        if !e.path.starts_with(prefix.as_str()) {
            continue;
        }
        let parts: Vec<&str> = e.path.split('/').collect();
        if parts.len() < 3 {
            continue;
        }
        let domain_name = parts[1].to_string();
        let title = leaf_title(&e);
        let title_lower = title.to_lowercase();
        if title_lower.contains(q) {
            out.push(SearchResult {
                title,
                path: e.path.clone(),
                domain: domain_name.clone(),
                slug: slugify(&domain_name),
                matched_field: "title".to_string(),
                snippet: None,
            });
            continue;
        }
        let mut matched_alias: Option<String> = None;
        for a in &e.aliases {
            if a.to_lowercase().contains(q) {
                matched_alias = Some(a.clone());
                break;
            }
        }
        if let Some(a) = matched_alias {
            out.push(SearchResult {
                title,
                path: e.path.clone(),
                domain: domain_name.clone(),
                slug: slugify(&domain_name),
                matched_field: "alias".to_string(),
                snippet: Some(a),
            });
        }
    }
    out
}

// Body-Index summaries: scraped from `Infrastructure/Indexes/<Domain> Index.md`
// lines matching `^- \[\[(.+?)\]\]\s+(?:—|--)\s+(.+)$`. Mtime-keyed cache.

struct IndexSummaries {
    entries: Vec<IndexEntry>,
    loaded_max_mtime_ms: f64,
}

#[derive(Clone)]
struct IndexEntry {
    path: String,
    snippet: String,
    domain_name: String,
}

fn index_state() -> &'static RwLock<IndexSummaries> {
    static S: OnceLock<RwLock<IndexSummaries>> = OnceLock::new();
    S.get_or_init(|| {
        RwLock::new(IndexSummaries {
            entries: Vec::new(),
            loaded_max_mtime_ms: 0.0,
        })
    })
}

static RE_INDEX_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^- \[\[([^\]]+)\]\]\s+(?:—|--)\s+(.+)$").unwrap());

fn ensure_index_loaded() {
    let index_dir = format!("{}/Infrastructure/Indexes", vault_root());
    let read = match fs::read_dir(&index_dir) {
        Ok(r) => r,
        Err(_) => {
            let mut s = index_state().write().unwrap();
            s.entries.clear();
            s.loaded_max_mtime_ms = 0.0;
            return;
        }
    };

    let mut files: Vec<(String, String, f64)> = Vec::new();
    let mut max_mtime = 0.0_f64;
    for ent in read.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if !name.ends_with(" Index.md") || name == "Index.md" {
            continue;
        }
        let full = ent.path();
        let meta = match fs::metadata(&full) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mt = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        if mt > max_mtime {
            max_mtime = mt;
        }
        files.push((name, full.to_string_lossy().into_owned(), mt));
    }

    {
        let s = index_state().read().unwrap();
        if (s.loaded_max_mtime_ms - max_mtime).abs() < 0.5 && max_mtime > 0.0 {
            return;
        }
    }

    let mut entries: Vec<IndexEntry> = Vec::new();
    for (name, full, _) in &files {
        let domain_name = name.trim_end_matches(" Index.md").to_string();
        let body = match fs::read_to_string(full) {
            Ok(b) => b,
            Err(_) => continue,
        };
        for raw in body.split('\n') {
            if let Some(caps) = RE_INDEX_LINE.captures(raw) {
                let target = caps.get(1).unwrap().as_str();
                let summary = caps.get(2).unwrap().as_str().trim().to_string();
                // Strip alias suffix `…|alias`.
                let target_clean = target.split('|').next().unwrap_or("").trim().to_string();
                if target_clean.is_empty() || summary.is_empty() {
                    continue;
                }
                let mut path = target_clean;
                if !path.ends_with(".md") {
                    path.push_str(".md");
                }
                if !path.starts_with(KNOWLEDGE_PREFIX) {
                    continue;
                }
                entries.push(IndexEntry {
                    path,
                    snippet: summary,
                    domain_name: domain_name.clone(),
                });
            }
        }
    }

    let mut s = index_state().write().unwrap();
    s.entries = entries;
    s.loaded_max_mtime_ms = max_mtime;
}

fn search_bodies(q: &str, limit: usize) -> Vec<SearchResult> {
    ensure_index_loaded();
    let snapshot = {
        let s = index_state().read().unwrap();
        s.entries.clone()
    };
    let mut out: Vec<SearchResult> = Vec::new();
    for e in snapshot {
        if out.len() >= limit {
            break;
        }
        if !e.snippet.to_lowercase().contains(q) {
            continue;
        }
        let title = Path::new(&e.path)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.trim_end_matches(".md").to_string())
            .unwrap_or_default();
        out.push(SearchResult {
            title,
            path: e.path.clone(),
            slug: slugify(&e.domain_name),
            domain: e.domain_name.clone(),
            matched_field: "body".to_string(),
            snippet: Some(e.snippet.clone()),
        });
    }
    out
}

#[tauri::command]
pub fn knowledge_search(q: String, limit: Option<u32>) -> SearchOut {
    let limit = limit.unwrap_or(50).max(1) as usize;
    let ql = q.trim().to_lowercase();
    if ql.is_empty() {
        return SearchOut { results: Vec::new() };
    }
    let title_hits = search_titles(&ql, limit);
    let mut seen: std::collections::HashSet<String> =
        title_hits.iter().map(|r| r.path.clone()).collect();
    let body_hits = search_bodies(&ql, limit);
    let mut merged = title_hits;
    for r in body_hits {
        if seen.contains(&r.path) {
            continue;
        }
        if merged.len() >= limit {
            break;
        }
        seen.insert(r.path.clone());
        merged.push(r);
    }
    SearchOut { results: merged }
}

// ── search_pages ───────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct PageResult {
    pub title: String,
    pub path: String,
    pub root: String,
    pub folder: String,
    #[serde(rename = "fileLeaf")]
    pub file_leaf: String,
    pub mtime: Option<String>,
    pub score: u8,
}

#[derive(Serialize)]
pub struct PagesOut {
    pub results: Vec<PageResult>,
}

fn format_page(e: &manifest::Entry, score: u8) -> PageResult {
    let parts: Vec<&str> = e.path.split('/').collect();
    let root = parts.first().copied().unwrap_or("").to_string();
    let file_leaf = parts
        .last()
        .copied()
        .unwrap_or("")
        .trim_end_matches(".md")
        .to_string();
    let folder_trail = if parts.len() > 1 {
        parts[..parts.len() - 1].join(" / ")
    } else {
        String::new()
    };
    let title = leaf_title(e);
    PageResult {
        title,
        path: e.path.clone(),
        root,
        folder: folder_trail,
        file_leaf,
        mtime: e.mtime.clone(),
        score,
    }
}

#[tauri::command]
pub fn search_pages(q: String, limit: Option<u32>) -> PagesOut {
    let limit = limit.unwrap_or(30).max(1) as usize;
    let ql = q.trim().to_lowercase();
    let entries = manifest::all_entries();

    if ql.is_empty() {
        let mut filtered: Vec<manifest::Entry> = entries
            .into_iter()
            .filter(|e| e.path.ends_with(".md"))
            .collect();
        // Sort mtime desc (lexicographic on ISO strings — matches Node).
        filtered.sort_by(|a, b| {
            let am = a.mtime.as_deref().unwrap_or("");
            let bm = b.mtime.as_deref().unwrap_or("");
            bm.cmp(am)
        });
        filtered.truncate(limit);
        let results: Vec<PageResult> = filtered.iter().map(|e| format_page(e, 0)).collect();
        return PagesOut { results };
    }

    let mut scored: Vec<PageResult> = Vec::new();
    for e in &entries {
        if !e.path.ends_with(".md") {
            continue;
        }
        let title_l = leaf_title(e).to_lowercase();
        let path_l = e.path.to_lowercase();
        let score = if title_l == ql {
            5
        } else if title_l.starts_with(&ql) {
            4
        } else if title_l.contains(&ql) {
            3
        } else if e.aliases.iter().any(|a| a.to_lowercase().contains(&ql)) {
            2
        } else if path_l.contains(&ql) {
            1
        } else {
            0
        };
        if score > 0 {
            scored.push(format_page(e, score));
        }
    }
    scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.cmp(&b.title)));
    scored.truncate(limit);
    PagesOut { results: scored }
}

// ── manifest_counts ────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CountsOut {
    pub counts: HashMap<String, u32>,
}

#[tauri::command]
pub fn manifest_counts() -> CountsOut {
    let entries = manifest::all_entries();
    let mut counts: HashMap<String, u32> = HashMap::new();
    for e in entries {
        if !e.path.ends_with(".md") {
            continue;
        }
        let root = match e.path.split('/').next() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        *counts.entry(root).or_insert(0) += 1;
    }
    CountsOut { counts }
}

// ── Manifest-availability probe used by folder commands ────────────────────

/// Returns true when the manifest has at least one entry.
pub fn manifest_available() -> bool {
    !manifest::all_entries().is_empty()
}
