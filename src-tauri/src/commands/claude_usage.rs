// Local Claude Code usage stats for the Token Dashboard (Terminal module).
//
// Walks ~/.claude/projects/**/*.jsonl session transcripts and aggregates the
// per-assistant-message `message.usage` token counts (input / output / cache
// create / cache read, plus the 1h-vs-5m ephemeral cache-write split) by day,
// model, and session. Returns AGGREGATES ONLY — never raw transcript lines.
//
// Security: the command takes NO arguments and only ever reads the hardcoded
// <home>/.claude/projects directory, so there is no user-supplied path to
// traverse — that is the narrow guard (we deliberately do NOT widen the general
// media/vault allow-list to reach ~/.claude).

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Serialize, Default, Clone)]
pub struct Bucket {
    pub input: u64,
    pub output: u64,
    pub cache_create: u64,
    pub cache_read: u64,
    pub eph_1h: u64,
    pub eph_5m: u64,
    pub messages: u64,
}

impl Bucket {
    fn add(&mut self, u: &Value) {
        self.input += u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
        self.output += u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
        self.cache_create += u.get("cache_creation_input_tokens").and_then(Value::as_u64).unwrap_or(0);
        self.cache_read += u.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0);
        if let Some(cc) = u.get("cache_creation") {
            self.eph_1h += cc.get("ephemeral_1h_input_tokens").and_then(Value::as_u64).unwrap_or(0);
            self.eph_5m += cc.get("ephemeral_5m_input_tokens").and_then(Value::as_u64).unwrap_or(0);
        }
        self.messages += 1;
    }
}

#[derive(Serialize)]
pub struct DayRow {
    pub date: String,
    #[serde(flatten)]
    pub b: Bucket,
}

#[derive(Serialize)]
pub struct ModelRow {
    pub model: String,
    #[serde(flatten)]
    pub b: Bucket,
}

#[derive(Serialize)]
pub struct SessionRow {
    pub id: String,
    pub date: String,
    pub model: String,
    #[serde(flatten)]
    pub b: Bucket,
}

#[derive(Serialize)]
pub struct TokenStats {
    pub total: Bucket,
    pub daily: Vec<DayRow>,
    pub by_model: Vec<ModelRow>,
    pub sessions: Vec<SessionRow>,
    pub file_count: usize,
    pub root: String,
    pub available: bool,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        // `DirEntry::file_type` does NOT follow symlinks (unlike `Path::is_dir`).
        // A directory symlink or junction pointing at an ancestor otherwise makes
        // this recurse the cycle: measured at 64 levels before Windows' path-length
        // limit stopped it, yielding the SAME transcript 64 times and multiplying
        // its tokens into every bucket. On a shallower root, or on a platform
        // without that limit, it is unbounded recursion instead. A symlink reports
        // neither is_dir nor is_file here, so it falls through both arms; junctions
        // carry the name-surrogate reparse tag and are skipped the same way.
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            collect_jsonl(&path, out);
        } else if ft.is_file() && path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            out.push(path);
        }
    }
}

/// The running aggregate. Extracted out of the command body so the per-line
/// fold is testable without touching the real ~/.claude directory.
#[derive(Default)]
struct Fold {
    total: Bucket,
    daily: BTreeMap<String, Bucket>,
    by_model: BTreeMap<String, Bucket>,
    sessions: BTreeMap<String, SessionRow>,
}

impl Fold {
    fn add_line(&mut self, line: &str) {
        // Fast path: only assistant messages carry a usage object.
        if !line.contains("\"usage\"") {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        let Some(u) = v.get("message").and_then(|m| m.get("usage")) else { return };
        if !u.is_object() {
            return;
        }

        self.total.add(u);

        // A message with no readable timestamp has no day. It stays in `total`
        // (it is real spend) but is kept OUT of `daily`, which is a date series
        // and cannot represent it. The old "unknown" key sorted lexicographically
        // after every real date, so it was always the last entry — and the
        // dashboard's range filter slices the TAIL, so "Last 7 days" showed a row
        // literally labelled `unknown` and silently dropped one real day.
        let ts = v.get("timestamp").and_then(Value::as_str).unwrap_or("");
        let date = if ts.len() >= 10 { ts[..10].to_string() } else { String::new() };
        if !date.is_empty() {
            self.daily.entry(date.clone()).or_default().add(u);
        }

        let model = v
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        self.by_model.entry(model.clone()).or_default().add(u);

        let sid = v.get("sessionId").and_then(Value::as_str).unwrap_or("unknown").to_string();
        let row = self.sessions.entry(sid.clone()).or_insert_with(|| SessionRow {
            id: sid,
            // Unlike `daily`, this column is a label, not a series — an undated
            // session still needs something to render, so it keeps the old
            // "unknown" text. Every real date sorts before it, so the comparison
            // below replaces it as soon as one arrives.
            date: if date.is_empty() { "unknown".to_string() } else { date.clone() },
            model: model.clone(),
            b: Bucket::default(),
        });
        row.b.add(u);
        // Keep the EARLIEST real date. An undated message must never win here.
        if !date.is_empty() && date < row.date {
            row.date = date;
        }
        // Keep the FIRST real model the session used (mirrors `date`
        // keeping the earliest). Overwriting per message would show the
        // LAST model — misleading for a session that switched mid-run.
        if row.model == "unknown" && model != "unknown" {
            row.model = model;
        }
    }
}

#[tauri::command]
pub async fn claude_token_stats() -> Result<TokenStats, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<TokenStats, String> {
        let home = home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
        let root = home.join(".claude").join("projects");
        let root_str = root.to_string_lossy().to_string();

        if !root.is_dir() {
            return Ok(TokenStats {
                total: Bucket::default(),
                daily: vec![],
                by_model: vec![],
                sessions: vec![],
                file_count: 0,
                root: root_str,
                available: false,
            });
        }

        let mut files = Vec::new();
        collect_jsonl(&root, &mut files);

        let mut fold = Fold::default();
        for path in &files {
            let Ok(file) = fs::File::open(path) else { continue };
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                fold.add_line(&line);
            }
        }
        let Fold { total, daily, by_model, sessions } = fold;

        let mut session_vec: Vec<SessionRow> = sessions.into_values().collect();
        session_vec.sort_by(|a, b| {
            let at = a.b.input + a.b.output + a.b.cache_read + a.b.cache_create;
            let bt = b.b.input + b.b.output + b.b.cache_read + b.b.cache_create;
            bt.cmp(&at)
        });

        Ok(TokenStats {
            total,
            daily: daily.into_iter().map(|(date, b)| DayRow { date, b }).collect(),
            by_model: by_model.into_iter().map(|(model, b)| ModelRow { model, b }).collect(),
            sessions: session_vec,
            file_count: files.len(),
            root: root_str,
            available: true,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg_in(sid: &str, ts: &str, input: u64) -> String {
        format!(
            r#"{{"timestamp":"{ts}","sessionId":"{sid}","message":{{"model":"claude-opus-5","usage":{{"input_tokens":{input}}}}}}}"#
        )
    }
    fn msg(ts: &str, input: u64) -> String {
        msg_in("s1", ts, input)
    }

    #[test]
    fn undated_message_counts_in_total_but_makes_no_day_row() {
        let mut f = Fold::default();
        f.add_line(&msg("2026-08-11T10:00:00Z", 100));
        f.add_line(&msg("", 25));

        // Negative probe: restore the unconditional `daily.entry(..)` insert and
        // this is 2, with the extra entry keyed "unknown" sorted last.
        assert_eq!(f.daily.len(), 1, "an undated message must not create a day row");
        assert_eq!(f.daily["2026-08-11"].input, 100);
        assert_eq!(f.total.input, 125, "undated spend must still count in the total");
        // The undated message must not blank the session's date either.
        assert_eq!(f.sessions["s1"].date, "2026-08-11");

        // A session with nothing BUT undated messages still needs a label.
        f.add_line(&msg_in("s2", "", 5));
        assert_eq!(f.sessions["s2"].date, "unknown");
        assert_eq!(f.daily.len(), 1, "still no day row for the undated session");
    }

    #[test]
    fn collect_jsonl_does_not_follow_directory_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let a = root.join("a");
        fs::create_dir(&a).unwrap();
        fs::write(a.join("x.jsonl"), "").unwrap();

        // root/a/loop -> root, i.e. a cycle back to an ancestor.
        //
        // `symlink_dir` needs Developer Mode or elevation on Windows and fails on
        // a stock box, so fall back to a junction — `mklink /J` needs neither, and
        // std sets the name-surrogate bit for IO_REPARSE_TAG_MOUNT_POINT, so a
        // junction reports `is_symlink() == true` exactly like a real symlink.
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(root, a.join("loop")).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(a.join("loop"))
                .arg(root)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(root, a.join("loop")).is_ok();

        if !linked {
            eprintln!(
                "SKIP collect_jsonl_does_not_follow_directory_symlinks: cannot create a \
                 directory symlink or junction here"
            );
            return;
        }

        // Negative probe: restore `path.is_dir()` and this recurses until the
        // stack overflows instead of returning.
        let mut out = Vec::new();
        collect_jsonl(root, &mut out);
        assert_eq!(out.len(), 1, "a symlinked directory must not be walked");
    }
}
