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
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            out.push(path);
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

        let mut total = Bucket::default();
        let mut daily: BTreeMap<String, Bucket> = BTreeMap::new();
        let mut by_model: BTreeMap<String, Bucket> = BTreeMap::new();
        let mut sessions: BTreeMap<String, SessionRow> = BTreeMap::new();

        for path in &files {
            let Ok(file) = fs::File::open(path) else { continue };
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                // Fast path: only assistant messages carry a usage object.
                if !line.contains("\"usage\"") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(u) = v.get("message").and_then(|m| m.get("usage")) else { continue };
                if !u.is_object() {
                    continue;
                }

                total.add(u);

                let ts = v.get("timestamp").and_then(Value::as_str).unwrap_or("");
                let date = if ts.len() >= 10 { ts[..10].to_string() } else { "unknown".to_string() };
                daily.entry(date.clone()).or_default().add(u);

                let model = v
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                by_model.entry(model.clone()).or_default().add(u);

                let sid = v.get("sessionId").and_then(Value::as_str).unwrap_or("unknown").to_string();
                let row = sessions.entry(sid.clone()).or_insert_with(|| SessionRow {
                    id: sid,
                    date: date.clone(),
                    model: model.clone(),
                    b: Bucket::default(),
                });
                row.b.add(u);
                if date < row.date {
                    row.date = date;
                }
                row.model = model;
            }
        }

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
