//! YAML-subset frontmatter parser. Logic ported from the now-removed Node sidecar (`server/src/skills/frontmatter.js`).
//!
//! Handles the surface area the vault uses: top-level scalars, inline arrays
//! (`Tags: [a, b]`), flat lists (`aliases:\n  - foo`), list-of-mappings
//! (`Arguments:\n  - name: value\n    description: …`), and nested maps
//! (`Track Sources:\n  1: https://…`). A full YAML parser would be over-built —
//! the schema is small and stable.
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
// Nested-map entry: an indented `key: value` that is NOT a bullet. Keys may be quoted, because
// the album writer emits `  "01 Track Title": https://…` — spaces and punctuation and all.
static RE_NESTED_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s+("[^"]*"|'[^']*'|[A-Za-z0-9][\w \-]*):\s*(.*)$"#).unwrap());

/// Strip one matching pair of surrounding quotes, if present.
///
/// A DOUBLE-quoted scalar also has its backslash escapes resolved, because YAML
/// says `"a\\b"` is the four characters `a\b`. Without this a Windows path in
/// frontmatter comes back with both slashes: `Local Path: "Anime\\Videos\\Hyouka"`
/// reached mpv as `...\Library\Anime\\Videos\\Hyouka\...`. Windows collapses the
/// run so playback worked, but every log line was misleading and any exact path
/// comparison against the same path built by other means would have failed.
///
/// Only `\\` and `\"` are resolved — the two a writer here actually emits.
/// Anything else is left exactly as written rather than guessed at, so a lone
/// backslash (invalid YAML, but present in hand-edited files) survives intact.
/// Single quotes are left alone: YAML gives them no escapes at all.
fn unquote(s: &str) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    let b = s.as_bytes();
    if b.len() >= 2 && b[0] == b'"' && b[b.len() - 1] == b'"' {
        let inner = &s[1..s.len() - 1];
        if !inner.contains('\\') {
            return Cow::Borrowed(inner);
        }
        let mut out = String::with_capacity(inner.len());
        let mut it = inner.chars();
        while let Some(c) = it.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match it.next() {
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                // not an escape this parser claims to understand — keep both
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        return Cow::Owned(out);
    }
    if b.len() >= 2 && b[0] == b'\'' && b[b.len() - 1] == b'\'' {
        return Cow::Borrowed(&s[1..s.len() - 1]);
    }
    Cow::Borrowed(s)
}

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
    Value::String(unquote(s).to_string())
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

            // Nested map: `Key:` followed by indented `  subkey: value` lines with no bullet.
            // Without this branch the bare `Key:` fell through to the scalar arm and landed as an
            // empty string while every sub-key was skipped — a silent WRONG parse, not a miss.
            if i + 1 < lines.len() && RE_NESTED_ITEM.is_match(lines[i + 1]) {
                let key = list_key.get(1).unwrap().as_str().trim().to_string();
                let mut m = Map::new();
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
                    let Some(c) = RE_NESTED_ITEM.captures(l) else { break };
                    let raw = c.get(2).unwrap().as_str().trim();
                    let value = if raw.starts_with('[') && raw.ends_with(']') {
                        parse_inline_array(raw)
                    } else {
                        parse_scalar(raw)
                    };
                    m.insert(unquote(c.get(1).unwrap().as_str().trim()).to_string(), value);
                    i += 1;
                }
                meta.insert(key, Value::Object(m));
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
    fn double_quoted_backslash_escapes() {
        let txt = concat!(
            "---\n",
            "Local Path: \"Anime\\\\Videos\\\\Hyouka\"\n",
            "Quoted: \"say \\\"hi\\\"\"\n",
            "Lone: \"C:\\Users\\malth\"\n",
            "Single: 'Anime\\\\Videos'\n",
            "---\n",
        );
        let (meta, _) = parse_frontmatter(txt);
        // the escape a writer here emits, resolved
        assert_eq!(meta["Local Path"], json!(r"Anime\Videos\Hyouka"));
        assert_eq!(meta["Quoted"], json!("say \"hi\""));
        // not an escape this parser claims to understand — left exactly as written
        assert_eq!(meta["Lone"], json!(r"C:\Users\malth"));
        // single quotes have no escapes in YAML
        assert_eq!(meta["Single"], json!(r"Anime\\Videos"));
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
    fn nested_map_quoted_keys() {
        // The album writer's real shape: `Track Sources:` then indented quoted track keys, one of
        // them still empty (a `--only-missing` row whose URL has not been resolved yet).
        let txt = "---\nTitle: An Album\nTrack Sources:\n  \"01 First\": https://youtu.be/aaa\n  \"02 Second\": \nGenres:\n  - rock\n---\n";
        let (meta, _) = parse_frontmatter(txt);
        assert_eq!(meta["Track Sources"]["01 First"], json!("https://youtu.be/aaa"));
        assert_eq!(meta["Track Sources"]["02 Second"], json!(""));
        // the map must not swallow the fields around it
        assert_eq!(meta["Title"], json!("An Album"));
        assert_eq!(meta["Genres"], json!(["rock"]));
    }

    #[test]
    fn nested_map_bare_keys_and_scalar_types() {
        let txt = "---\nCounts:\n  one: 1\n  flag: true\n  tags: [a, b]\n---\n";
        let (meta, _) = parse_frontmatter(txt);
        assert_eq!(meta["Counts"]["one"], json!(1));
        assert_eq!(meta["Counts"]["flag"], json!(true));
        assert_eq!(meta["Counts"]["tags"], json!(["a", "b"]));
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
