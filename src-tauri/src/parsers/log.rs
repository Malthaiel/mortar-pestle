//! Log parser — ports `server/src/vault/log-parser.js::getLogEntries`.
//! Mtime-cached: re-parses only when `Log.md`'s mtime changes.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::Serialize;

use crate::commands::vault::vault_root;
use crate::render::markdown::render_string;

#[derive(Serialize, Debug, Clone)]
pub struct LogEntry {
    pub date: String,
    pub time: String,
    pub tz: Option<String>,
    pub category: String,
    pub title: String,
    pub body: String,
    #[serde(rename = "bodyHtml")]
    pub body_html: String,
    pub files: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    pub page: u32,
    pub size: u32,
    pub total: u32,
    #[serde(rename = "totalPages")]
    pub total_pages: u32,
}

fn log_path() -> PathBuf {
    PathBuf::from(format!(
        "{}/Infrastructure/Vault State/Log.md",
        vault_root()
    ))
}

fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^## \[(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}\s+[AP]M)(?:\s+([A-Z]{2,5}))?\]\s+([A-Za-z][\w\-]*)\s*\|\s*(.+?)\s*$",
        )
        .unwrap()
    })
}

fn extract_files(body: &str) -> Vec<String> {
    static BULLET: OnceLock<Regex> = OnceLock::new();
    static HEAD: OnceLock<Regex> = OnceLock::new();
    let bullet = BULLET.get_or_init(|| Regex::new(r"^-\s+(.+?)\s*$").unwrap());
    let head = HEAD.get_or_init(|| Regex::new(r"^Files:\s*$").unwrap());

    let lines: Vec<&str> = body.split('\n').collect();
    let mut start: i32 = -1;
    for (i, l) in lines.iter().enumerate().rev() {
        if head.is_match(l.trim()) {
            start = i as i32;
            break;
        }
    }
    if start < 0 {
        return Vec::new();
    }
    let mut files = Vec::new();
    for line in lines.iter().skip((start + 1) as usize) {
        if let Some(m) = bullet.captures(line) {
            files.push(m[1].trim().to_string());
        }
    }
    files
}

fn parse_all(text: &str) -> Vec<LogEntry> {
    let re = heading_re();
    let mut entries = Vec::new();
    let mut current: Option<(String, String, Option<String>, String, String)> = None;
    let mut buf: Vec<&str> = Vec::new();

    let flush = |current: &mut Option<(String, String, Option<String>, String, String)>,
                     buf: &mut Vec<&str>,
                     entries: &mut Vec<LogEntry>| {
        if let Some((date, time, tz, category, title)) = current.take() {
            let raw_body = buf.join("\n");
            let body = raw_body
                .trim_start_matches('\n')
                .trim_end_matches('\n')
                .to_string();
            let body_html = render_string(&body);
            let files = extract_files(&body);
            entries.push(LogEntry {
                date,
                time,
                tz,
                category,
                title,
                body,
                body_html,
                files,
            });
            buf.clear();
        }
    };

    for line in text.split('\n') {
        if let Some(m) = re.captures(line) {
            flush(&mut current, &mut buf, &mut entries);
            let date = m[1].to_string();
            let time = m[2].to_string();
            let tz = m.get(3).map(|s| s.as_str().to_string());
            let category = m[4].to_string();
            let title = m[5].to_string();
            current = Some((date, time, tz, category, title));
        } else if current.is_some() {
            buf.push(line);
        }
    }
    flush(&mut current, &mut buf, &mut entries);
    entries
}

fn cache() -> &'static Mutex<Option<(f64, Vec<LogEntry>)>> {
    static C: OnceLock<Mutex<Option<(f64, Vec<LogEntry>)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

fn current_mtime(p: &PathBuf) -> f64 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn get_log_entries(page: u32, size: u32) -> LogPage {
    let p = log_path();
    let mtime = current_mtime(&p);
    let mut guard = cache().lock().unwrap();
    let need_reparse = match guard.as_ref() {
        Some((cached_mt, _)) => (*cached_mt - mtime).abs() > f64::EPSILON,
        None => true,
    };
    if need_reparse {
        let text = fs::read_to_string(&p).unwrap_or_default();
        let entries = parse_all(&text);
        *guard = Some((mtime, entries));
    }
    let entries = &guard.as_ref().unwrap().1;

    let total = entries.len() as u32;
    let size = size.max(1);
    let total_pages = total.div_ceil(size).max(1);
    let p_clamped = page.max(1).min(total_pages);
    let start = ((p_clamped - 1) * size) as usize;
    let end = (start + size as usize).min(entries.len());
    let page_entries = entries[start..end].to_vec();
    LogPage {
        entries: page_entries,
        page: p_clamped,
        size,
        total,
        total_pages,
    }
}
