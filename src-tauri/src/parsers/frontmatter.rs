//! YAML-subset frontmatter parser. Logic ported from the now-removed Node sidecar (`server/src/skills/frontmatter.js`).
//!
//! Handles the surface area the vault uses: top-level scalars, inline arrays
//! (`Tags: [a, b]`), flat lists (`aliases:\n  - foo`), and list-of-mappings
//! (`Arguments:\n  - name: value\n    description: …`). A full YAML parser
//! would be over-built — the schema is small and stable.
//!
//! Sub-feature 4 of the Desktop-Only Migration. Used by `parsers::frontmatter_cache`
//! and the folder reader for field projection.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Map, Value};

static RE_INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?\d+$").unwrap());
static RE_FLOAT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?\d*\.\d+$").unwrap());
static RE_LIST_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z][\w \-]*):\s*$").unwrap());
static RE_BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s+-\s").unwrap());
static RE_FLAT_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*-\s+(.+)$").unwrap());
static RE_FIRST_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*-\s+(.*)$").unwrap());
static RE_MAP_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*-\s+([A-Za-z][\w \-]*):\s*(.*)$").unwrap());
static RE_CONT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{4,}([A-Za-z][\w \-]*):\s*(.*)$").unwrap());
static RE_TOP_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z][\w \-]*:").unwrap());
static RE_SCALAR_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z][\w \-]*):\s*(.*)$").unwrap());
static RE_SUBKEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z][\w \-]*:\s*(.*)$").unwrap());

/// Parse a scalar YAML value into a JSON Value. Mirrors Node's `parseScalar`:
/// `true`/`false` → bool, integer literal → number, float literal → number,
/// quoted string → unquoted string, anything else → string-as-is.
fn parse_scalar(raw: &str) -> Value {
    let s = raw.trim();
    if s == "true" {
        return Value::Bool(true);
    }
    if s == "false" {
        return Value::Bool(false);
    }
    if RE_INT.is_match(s) {
        if let Ok(n) = s.parse::<i64>() {
            return json!(n);
        }
    }
    if RE_FLOAT.is_match(s) {
        if let Ok(n) = s.parse::<f64>() {
            return json!(n);
        }
    }
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return Value::String(s[1..s.len() - 1].to_string());
        }
    }
    Value::String(s.to_string())
}

fn parse_inline_array(raw: &str) -> Value {
    // `[a, b, c]` → Vec<Value>, filtering empty items (matches Node's `.filter(x => x !== '')`).
    let inner = &raw[1..raw.len() - 1];
    let items: Vec<Value> = inner
        .split(',')
        .map(|x| parse_scalar(x.trim()))
        .filter(|v| match v {
            Value::String(s) => !s.is_empty(),
            _ => true,
        })
        .collect();
    Value::Array(items)
}

/// Parse the frontmatter block out of a markdown file. Returns the `meta` map
/// and the body (text after the closing `---`). If the file has no
/// frontmatter, returns an empty meta and the original body.
pub fn parse_frontmatter(text: &str) -> (Map<String, Value>, String) {
    if !text.starts_with("---") {
        return (Map::new(), text.to_string());
    }
    let end = match text[3..].find("\n---") {
        Some(idx) => idx + 3,
        None => return (Map::new(), text.to_string()),
    };
    let mut block = text[3..end].to_string();
    if block.starts_with('\n') {
        block = block[1..].to_string();
    }
    let mut body = text[end + 4..].to_string();
    if body.starts_with('\n') {
        body = body[1..].to_string();
    }

    let mut meta = Map::new();
    let lines: Vec<&str> = block.split('\n').collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }

        // List-of-mappings or flat list: `Key:` followed by `  - …` lines.
        if let Some(list_key) = RE_LIST_KEY.captures(line) {
            if i + 1 < lines.len() && RE_BULLET.is_match(lines[i + 1]) {
                let key = list_key.get(1).unwrap().as_str().trim().to_string();
                // Distinguish list-of-mappings from flat list by inspecting the first item.
                let first_item_inner = RE_FIRST_ITEM
                    .captures(lines[i + 1])
                    .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
                let is_mapping = first_item_inner
                    .as_deref()
                    .map(|s| RE_SUBKEY.is_match(s))
                    .unwrap_or(false);

                if !is_mapping {
                    let mut items: Vec<Value> = Vec::new();
                    i += 1;
                    while i < lines.len() {
                        let l = lines[i];
                        if l.trim().is_empty() {
                            i += 1;
                            continue;
                        }
                        if RE_TOP_KEY.is_match(l) {
                            break;
                        }
                        if let Some(m) = RE_FLAT_ITEM.captures(l) {
                            items.push(parse_scalar(m.get(1).unwrap().as_str()));
                            i += 1;
                            continue;
                        }
                        break;
                    }
                    meta.insert(key, Value::Array(items));
                    continue;
                }

                // list-of-mappings: each item begins `  - name: value`, with
                // optional `    continuation: value` lines (4+ spaces).
                let mut items: Vec<Value> = Vec::new();
                let mut current: Option<Map<String, Value>> = None;
                i += 1;
                while i < lines.len() {
                    let l = lines[i];
                    if l.trim().is_empty() {
                        i += 1;
                        continue;
                    }
                    if RE_TOP_KEY.is_match(l) {
                        break;
                    }
                    if let Some(c) = RE_MAP_ITEM.captures(l) {
                        if let Some(prev) = current.take() {
                            items.push(Value::Object(prev));
                        }
                        let mut m = Map::new();
                        m.insert(
                            c.get(1).unwrap().as_str().trim().to_string(),
                            parse_scalar(c.get(2).unwrap().as_str()),
                        );
                        current = Some(m);
                        i += 1;
                        continue;
                    }
                    if let Some(c) = RE_CONT.captures(l) {
                        if let Some(cur) = current.as_mut() {
                            let v = c.get(2).unwrap().as_str().trim().to_string();
                            let value = if v.starts_with('[') && v.ends_with(']') {
                                parse_inline_array(&v)
                            } else {
                                parse_scalar(&v)
                            };
                            cur.insert(c.get(1).unwrap().as_str().trim().to_string(), value);
                            i += 1;
                            continue;
                        }
                    }
                    break;
                }
                if let Some(prev) = current {
                    items.push(Value::Object(prev));
                }
                meta.insert(key, Value::Array(items));
                continue;
            }
        }

        if let Some(c) = RE_SCALAR_LINE.captures(line) {
            let key = c.get(1).unwrap().as_str().trim().to_string();
            let raw = c.get(2).unwrap().as_str().trim().to_string();
            let value = if raw.starts_with('[') && raw.ends_with(']') {
                parse_inline_array(&raw)
            } else {
                parse_scalar(&raw)
            };
            meta.insert(key, value);
        }
        i += 1;
    }

    (meta, body)
}

/// Set or replace a top-level scalar field in the frontmatter `head` segment
/// (the text between the opening `---` and the closing `\n---`). De-duplicates
/// by stripping any extra occurrences and updating the first one in place. If
/// the field doesn't exist, it is appended at the end of `head`.
///
/// Port of `server/src/skills/frontmatter.js::setFrontmatterField`. Used by the
/// Sub-feature 7 media writers (`mark_album_status`, `mark_album_rating`,
/// `mark_series_status`, `mark_series_rating`, `mark_episode_watched`).
pub fn set_frontmatter_field(head: &str, field: &str, value: &str) -> String {
    let prefix = format!("{field}:");
    let lines: Vec<&str> = head.split('\n').collect();
    let mut first_idx: Option<usize> = None;
    let mut result: Vec<String> = Vec::with_capacity(lines.len() + 1);
    for line in lines {
        if line.starts_with(&prefix) {
            if first_idx.is_none() {
                first_idx = Some(result.len());
                result.push(format!("{field}: {value}"));
            }
            // duplicate occurrence: silently dropped
        } else {
            result.push(line.to_string());
        }
    }
    if first_idx.is_none() {
        result.push(format!("{field}: {value}"));
    }
    result.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_frontmatter() {
        let (meta, body) = parse_frontmatter("hello\nworld");
        assert!(meta.is_empty());
        assert_eq!(body, "hello\nworld");
    }

    #[test]
    fn scalar_string_int_bool() {
        let txt = "---\nTitle: My Page\nCount: 42\nDraft: true\n---\nbody\n";
        let (meta, body) = parse_frontmatter(txt);
        assert_eq!(meta["Title"], json!("My Page"));
        assert_eq!(meta["Count"], json!(42));
        assert_eq!(meta["Draft"], json!(true));
        assert_eq!(body, "body\n");
    }

    #[test]
    fn inline_array() {
        let txt = "---\nTags: [a, b, c]\n---\n";
        let (meta, _) = parse_frontmatter(txt);
        assert_eq!(meta["Tags"], json!(["a", "b", "c"]));
    }

    #[test]
    fn flat_list_aliases() {
        let txt = "---\naliases:\n  - Allie\n  - Al\nTitle: Alice\n---\n";
        let (meta, _) = parse_frontmatter(txt);
        assert_eq!(meta["aliases"], json!(["Allie", "Al"]));
        assert_eq!(meta["Title"], json!("Alice"));
    }

    #[test]
    fn list_of_mappings() {
        let txt = "---\nArguments:\n  - name: foo\n    description: first arg\n  - name: bar\n---\n";
        let (meta, _) = parse_frontmatter(txt);
        let args = meta["Arguments"].as_array().unwrap();
        assert_eq!(args.len(), 2);
        assert_eq!(args[0]["name"], json!("foo"));
        assert_eq!(args[0]["description"], json!("first arg"));
        assert_eq!(args[1]["name"], json!("bar"));
    }

    #[test]
    fn quoted_string_strips_quotes() {
        let txt = "---\nPath: \"/a/b/c\"\n---\n";
        let (meta, _) = parse_frontmatter(txt);
        assert_eq!(meta["Path"], json!("/a/b/c"));
    }

    #[test]
    fn set_field_replaces_existing() {
        let head = "---\nTitle: Old\nStatus: Plan-to-Watch\nYear: 2024";
        let out = set_frontmatter_field(head, "Status", "Currently-Watching");
        assert_eq!(out, "---\nTitle: Old\nStatus: Currently-Watching\nYear: 2024");
    }

    #[test]
    fn set_field_appends_when_missing() {
        let head = "---\nTitle: Old\nYear: 2024";
        let out = set_frontmatter_field(head, "Status", "Plan-to-Watch");
        assert_eq!(out, "---\nTitle: Old\nYear: 2024\nStatus: Plan-to-Watch");
    }

    #[test]
    fn set_field_dedupes_repeats() {
        let head = "---\nStatus: One\nTitle: T\nStatus: Two";
        let out = set_frontmatter_field(head, "Status", "Three");
        assert_eq!(out, "---\nStatus: Three\nTitle: T");
    }

    #[test]
    fn set_field_handles_inline_array_value() {
        let head = "---\nWatched Episodes Season 1: [1, 2]\nTitle: T";
        let out = set_frontmatter_field(head, "Watched Episodes Season 1", "[1, 2, 3]");
        assert_eq!(out, "---\nWatched Episodes Season 1: [1, 2, 3]\nTitle: T");
    }

    #[test]
    fn set_field_no_collision_with_field_as_substring() {
        // `Status:` should not match `Status Season 1:`.
        let head = "---\nStatus Season 1: Currently-Watching\nTitle: T";
        let out = set_frontmatter_field(head, "Status", "Completed");
        assert_eq!(
            out,
            "---\nStatus Season 1: Currently-Watching\nTitle: T\nStatus: Completed"
        );
    }
}
