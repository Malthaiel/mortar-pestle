//! Sub-feature 8 — skills discovery, frontmatter projection, argv composition,
//! and log retention. Ports `server/src/skills/frontmatter.js` and the
//! `composeInvocation` / `quoteArg` helpers from `server/src/skills/runner.js`,
//! plus the daily prune pass from `server/src/skills/retention.js`.
//!
//! The Rust side normalizes argument-object keys (`Name` → `name`) at the
//! wire boundary so consumers can read `arg.name` consistently — Node's YAML
//! preserves `Name` (capital), which leaves the React form's `arg.name`
//! lookups broken on Node. Sub-feature 8 surfaces this in the Tauri path.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::commands::vault::{vault_root, SkillError};
use crate::parsers::frontmatter::parse_frontmatter;

const SKILL_CATEGORIES: &[(&str, &str)] = &[
    ("slash", "Infrastructure/Skills/Slash"),
    ("ingest", "Infrastructure/Skills/Ingest"),
    ("transcripts", "Infrastructure/Skills/Transcripts"),
];

const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub fn run_log_dir() -> PathBuf {
    PathBuf::from(vault_root()).join("Infrastructure/.cache/skill-runs")
}

#[derive(Serialize, Clone, Debug)]
pub struct SkillEntry {
    pub slug: String,
    pub command: String,
    pub description: String,
    pub destructive: bool,
    pub interactive: bool,
    pub arguments: Vec<Value>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SkillFull {
    pub category: String,
    pub slug: String,
    pub filename: String,
    pub command: String,
    pub description: String,
    pub destructive: bool,
    pub interactive: bool,
    pub arguments: Vec<Value>,
    pub body: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SkillList {
    pub slash: Vec<SkillEntry>,
    pub ingest: Vec<SkillEntry>,
    pub transcripts: Vec<SkillEntry>,
}

fn category_prefix(category: &str) -> &'static str {
    match category {
        "ingest" => "ingest-",
        "transcripts" => "transcript-",
        _ => "",
    }
}

fn slug_from_filename(category: &str, filename: &str) -> String {
    let base = filename.strip_suffix(".md").unwrap_or(filename);
    let prefix = category_prefix(category);
    if !prefix.is_empty() {
        if let Some(stripped) = base.strip_prefix(prefix) {
            return stripped.to_string();
        }
    }
    base.to_string()
}

fn command_label(category: &str, slug: &str, from_frontmatter: Option<&Value>) -> String {
    if let Some(v) = from_frontmatter {
        if let Some(s) = v.as_str() {
            let t = s.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    match category {
        "ingest" => format!("/ingest {slug}"),
        "transcripts" => format!("/transcript {slug}"),
        _ => format!("/{slug}"),
    }
}

/// Mirrors Node's `firstParagraph(body)`: skip leading blank lines + headings,
/// join the first contiguous block of non-blank lines into a single space-
/// separated string, trim. Used as the skill's description.
fn first_paragraph(body: &str) -> String {
    let lines: Vec<&str> = body.split('\n').collect();
    let mut i = 0;
    while i < lines.len() && (lines[i].trim().is_empty() || lines[i].starts_with('#')) {
        i += 1;
    }
    let mut paragraph: Vec<String> = Vec::new();
    while i < lines.len() && !lines[i].trim().is_empty() {
        paragraph.push(lines[i].trim().to_string());
        i += 1;
    }
    paragraph.join(" ").trim().to_string()
}

/// Normalize argument-object keys for the wire shape — rename `Name` → `name`
/// if `name` isn't already present. Single-pass, idempotent. Fixes the
/// long-standing mismatch between vault YAML (`Name:`) and the JS form / Rust
/// runner (`arg.name`).
fn normalize_argument_keys(arg: Value) -> Value {
    match arg {
        Value::Object(map) => {
            let mut out: Map<String, Value> = Map::new();
            let has_lower_name = map.contains_key("name");
            for (k, v) in map.into_iter() {
                if k == "Name" {
                    if !has_lower_name {
                        out.insert("name".to_string(), v);
                    }
                    // both-present case: drop the `Name` duplicate, keep `name`
                } else {
                    out.insert(k, v);
                }
            }
            Value::Object(out)
        }
        other => other,
    }
}

fn arguments_from(meta: &Map<String, Value>) -> Vec<Value> {
    meta.get("Arguments")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().cloned().map(normalize_argument_keys).collect())
        .unwrap_or_default()
}

fn meta_bool(meta: &Map<String, Value>, key: &str) -> bool {
    matches!(meta.get(key), Some(Value::Bool(true)))
}

fn read_skill_file(category: &str, filename: &str) -> Result<SkillFull, SkillError> {
    let dir = SKILL_CATEGORIES
        .iter()
        .find(|(c, _)| *c == category)
        .map(|(_, d)| *d)
        .ok_or_else(|| SkillError::Invalid(format!("Unknown skill category: {category}")))?;
    let abs = PathBuf::from(vault_root()).join(dir).join(filename);
    let text = fs::read_to_string(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => SkillError::NotFound(format!("{category}/{filename}")),
        _ => SkillError::Io(e.to_string()),
    })?;
    let (meta, body) = parse_frontmatter(&text);
    let slug = slug_from_filename(category, filename);
    let command = command_label(category, &slug, meta.get("Command"));
    Ok(SkillFull {
        category: category.to_string(),
        slug,
        filename: filename.to_string(),
        command,
        description: first_paragraph(&body),
        destructive: meta_bool(&meta, "Destructive"),
        interactive: meta_bool(&meta, "Interactive"),
        arguments: arguments_from(&meta),
        body,
    })
}

fn entry_from(full: &SkillFull) -> SkillEntry {
    SkillEntry {
        slug: full.slug.clone(),
        command: full.command.clone(),
        description: full.description.clone(),
        destructive: full.destructive,
        interactive: full.interactive,
        arguments: full.arguments.clone(),
    }
}

/// Walk the three Skill category directories and return their contents,
/// sorted by slug per category. Unreadable skills are skipped silently
/// (matches Node's `[skills] failed to read ...` log + continue behavior).
pub fn list_skills() -> SkillList {
    let mut out = SkillList::default();
    for (category, dir) in SKILL_CATEGORIES {
        let abs = PathBuf::from(vault_root()).join(dir);
        let entries: Vec<SkillEntry> = match fs::read_dir(&abs) {
            Ok(rd) => {
                let mut names: Vec<String> = rd
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                    .filter(|n| n.ends_with(".md"))
                    .collect();
                names.sort();
                names
                    .iter()
                    .filter_map(|filename| read_skill_file(category, filename).ok())
                    .map(|f| entry_from(&f))
                    .collect()
            }
            Err(_) => Vec::new(),
        };
        match *category {
            "slash" => out.slash = entries,
            "ingest" => out.ingest = entries,
            "transcripts" => out.transcripts = entries,
            _ => {}
        }
    }
    // Per-category sort by slug (locale-default; Rust's str::cmp is byte-wise
    // which matches Node's localeCompare for ASCII-only skill slugs).
    out.slash.sort_by(|a, b| a.slug.cmp(&b.slug));
    out.ingest.sort_by(|a, b| a.slug.cmp(&b.slug));
    out.transcripts.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

/// Resolve a slug back to the full skill (frontmatter + body), needed by the
/// runner to spawn the subprocess. Mirrors Node's `loadSkillBySlug`.
pub fn load_skill_by_slug(slug: &str) -> Option<SkillFull> {
    let list = list_skills();
    let categories: [(&str, &Vec<SkillEntry>); 3] = [
        ("slash", &list.slash),
        ("ingest", &list.ingest),
        ("transcripts", &list.transcripts),
    ];
    for (category, entries) in &categories {
        if entries.iter().any(|e| e.slug == slug) {
            let filename = match *category {
                "ingest" => format!("ingest-{slug}.md"),
                "transcripts" => format!("transcript-{slug}.md"),
                _ => format!("{slug}.md"),
            };
            return read_skill_file(category, &filename).ok();
        }
    }
    None
}

/// Port of `server/src/skills/runner.js::quoteArg`. Mirrors byte-faithfully:
/// empty/null → `""`; no special chars → as-is; has special chars →
/// double-quote-wrapped with `\\`, `"`, `$`, `` ` `` escaped.
fn quote_arg(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quote = s.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '"' | '\'' | '\\' | '$' | '`'));
    if !needs_quote {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '$' => out.push_str("\\$"),
            '`' => out.push_str("\\`"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Port of `server/src/skills/runner.js::composeInvocation`. Iterates the
/// skill's declared arguments in order, looks up each value in `args`,
/// shell-quotes via `quote_arg`. Missing required → SkillError::Invalid.
///
/// Argument lookup is case-tolerant: reads `arg.name` then `arg.Name`. Mirrors
/// the wire normalization in `normalize_argument_keys` so either casing works
/// (some `SkillFull` callers may bypass `list_skills` normalization).
pub fn compose_invocation(skill: &SkillFull, args: &Map<String, Value>) -> Result<String, SkillError> {
    let mut parts: Vec<String> = vec![skill.command.clone()];
    for arg in &skill.arguments {
        let arg_obj = match arg.as_object() {
            Some(o) => o,
            None => continue,
        };
        let name = arg_obj
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| arg_obj.get("Name").and_then(|v| v.as_str()))
            .unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let required = arg_obj
            .get("required")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let value_opt = args.get(name);
        let value_str = match value_opt {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            Some(Value::Null) | None => {
                if required {
                    return Err(SkillError::Invalid(format!("Missing required argument: {name}")));
                }
                continue;
            }
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Number(n)) => n.to_string(),
            Some(other) => other.to_string(),
        };
        if value_str.is_empty() {
            if required {
                return Err(SkillError::Invalid(format!("Missing required argument: {name}")));
            }
            continue;
        }
        parts.push(quote_arg(&value_str));
    }
    Ok(parts.join(" "))
}

#[derive(Serialize, Clone, Debug)]
pub struct PruneReport {
    pub scanned: usize,
    pub removed: usize,
}

/// Port of `server/src/skills/retention.js::pruneOnce`. Walks the run-log dir,
/// removes `.log` files older than 7 days by mtime. Best-effort; per-file
/// errors are swallowed. Returns counts. Called once from `lib.rs::setup`.
pub fn prune_old_logs() -> PruneReport {
    let dir = run_log_dir();
    let rd = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return PruneReport { scanned: 0, removed: 0 },
    };
    let cutoff = SystemTime::now()
        .checked_sub(RETENTION)
        .unwrap_or(UNIX_EPOCH);
    let mut scanned = 0;
    let mut removed = 0;
    for entry in rd.flatten() {
        let path = entry.path();
        let leaf = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !leaf.ends_with(".log") {
            continue;
        }
        scanned += 1;
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    if fs::remove_file(&path).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }
    PruneReport { scanned, removed }
}

/// Build a hash-friendly registry key for `(category, filename)` pairs.
/// Reserved for future caching; currently unused.
#[allow(dead_code)]
fn cache_key(category: &str, filename: &str) -> String {
    let mut m: BTreeMap<&str, &str> = BTreeMap::new();
    m.insert("c", category);
    m.insert("f", filename);
    serde_json::to_string(&m).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_arg(name_key: &str, name: &str, required: bool) -> Value {
        json!({
            name_key: name,
            "type": "string",
            "required": required,
            "description": "test arg",
        })
    }

    fn make_skill(command: &str, args: Vec<Value>) -> SkillFull {
        SkillFull {
            category: "slash".to_string(),
            slug: "test".to_string(),
            filename: "test.md".to_string(),
            command: command.to_string(),
            description: String::new(),
            destructive: false,
            interactive: false,
            arguments: args,
            body: String::new(),
        }
    }

    #[test]
    fn quote_arg_empty() {
        assert_eq!(quote_arg(""), "\"\"");
    }

    #[test]
    fn quote_arg_plain() {
        assert_eq!(quote_arg("hello"), "hello");
        assert_eq!(quote_arg("ingest-hardcover-9780156012195"), "ingest-hardcover-9780156012195");
    }

    #[test]
    fn quote_arg_space() {
        assert_eq!(quote_arg("hello world"), "\"hello world\"");
    }

    #[test]
    fn quote_arg_special_chars() {
        // Single quote forces wrap; double quote inside gets escaped.
        assert_eq!(quote_arg("a'b"), "\"a'b\"");
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_arg("a$b"), "\"a\\$b\"");
        assert_eq!(quote_arg("a`b"), "\"a\\`b\"");
        assert_eq!(quote_arg("a\\b"), "\"a\\\\b\"");
    }

    #[test]
    fn compose_no_args() {
        let skill = make_skill("/check-links", vec![]);
        let args = Map::new();
        assert_eq!(compose_invocation(&skill, &args).unwrap(), "/check-links");
    }

    #[test]
    fn compose_one_optional_missing() {
        let skill = make_skill("/promote", vec![make_arg("name", "file", false)]);
        let args = Map::new();
        assert_eq!(compose_invocation(&skill, &args).unwrap(), "/promote");
    }

    #[test]
    fn compose_one_required_missing() {
        let skill = make_skill("/wikilink", vec![make_arg("name", "folder", true)]);
        let args = Map::new();
        let err = compose_invocation(&skill, &args).unwrap_err();
        match err {
            SkillError::Invalid(m) => assert!(m.contains("folder")),
            _ => panic!("expected Invalid"),
        }
    }

    #[test]
    fn compose_one_plain_value() {
        let skill = make_skill("/wikilink", vec![make_arg("name", "folder", true)]);
        let mut args = Map::new();
        args.insert("folder".to_string(), json!("Knowledge/Music"));
        assert_eq!(compose_invocation(&skill, &args).unwrap(), "/wikilink Knowledge/Music");
    }

    #[test]
    fn compose_value_with_spaces() {
        let skill = make_skill("/promote", vec![make_arg("name", "file", false)]);
        let mut args = Map::new();
        args.insert("file".to_string(), json!("a path with spaces.md"));
        assert_eq!(
            compose_invocation(&skill, &args).unwrap(),
            "/promote \"a path with spaces.md\""
        );
    }

    #[test]
    fn compose_value_with_dollar_and_backtick() {
        let skill = make_skill("/ingest hardcover", vec![make_arg("name", "query", false)]);
        let mut args = Map::new();
        args.insert("query".to_string(), json!("title $with `chars"));
        assert_eq!(
            compose_invocation(&skill, &args).unwrap(),
            "/ingest hardcover \"title \\$with \\`chars\""
        );
    }

    #[test]
    fn compose_reads_capital_name_key_for_lookup() {
        // Skill argument declared with `Name` (capital) but caller passes
        // `name` (lowercase). Lookup falls back to `Name` → finds nothing
        // because the args bag is keyed by the form-side name ("query").
        // This test exists to lock the contract: the LOOKUP key is the
        // argument's declared name, not the wire-shape key.
        let skill = make_skill("/ingest hardcover", vec![make_arg("Name", "query", false)]);
        let mut args = Map::new();
        args.insert("query".to_string(), json!("9780156012195"));
        assert_eq!(
            compose_invocation(&skill, &args).unwrap(),
            "/ingest hardcover 9780156012195"
        );
    }

    #[test]
    fn normalize_capital_name_to_lowercase() {
        let arg = json!({ "Name": "query", "type": "string", "required": false });
        let out = normalize_argument_keys(arg);
        let obj = out.as_object().unwrap();
        assert_eq!(obj.get("name"), Some(&json!("query")));
        assert!(obj.get("Name").is_none());
        assert_eq!(obj.get("type"), Some(&json!("string")));
    }

    #[test]
    fn normalize_lowercase_name_unchanged() {
        let arg = json!({ "name": "query", "type": "string" });
        let out = normalize_argument_keys(arg);
        let obj = out.as_object().unwrap();
        assert_eq!(obj.get("name"), Some(&json!("query")));
        assert!(obj.get("Name").is_none());
    }

    #[test]
    fn normalize_keeps_lowercase_when_both_present() {
        // Defensive: if YAML somehow had both, prefer lowercase, drop Name.
        let arg = json!({ "name": "lower", "Name": "upper", "type": "string" });
        let out = normalize_argument_keys(arg);
        let obj = out.as_object().unwrap();
        assert_eq!(obj.get("name"), Some(&json!("lower")));
        assert!(obj.get("Name").is_none());
    }

    #[test]
    fn first_paragraph_skips_headings_and_blanks() {
        let body = "\n\n## Heading\n\nFirst line.\nSecond line.\n\nThird (separate paragraph).";
        assert_eq!(first_paragraph(body), "First line. Second line.");
    }

    #[test]
    fn slug_from_filename_strips_category_prefix() {
        assert_eq!(slug_from_filename("ingest", "ingest-hardcover.md"), "hardcover");
        assert_eq!(slug_from_filename("transcripts", "transcript-yt-deadlock.md"), "yt-deadlock");
        assert_eq!(slug_from_filename("slash", "check-links.md"), "check-links");
    }

    #[test]
    fn command_label_defaults_per_category() {
        assert_eq!(command_label("ingest", "mal", None), "/ingest mal");
        assert_eq!(command_label("transcripts", "yt-study", None), "/transcript yt-study");
        assert_eq!(command_label("slash", "check-links", None), "/check-links");
    }

    #[test]
    fn command_label_honors_frontmatter() {
        let v = json!("/custom command");
        assert_eq!(command_label("slash", "test", Some(&v)), "/custom command");
    }
}
