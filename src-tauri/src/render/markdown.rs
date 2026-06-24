//! Markdown renderer — pulldown-cmark driver with custom wikilink/embed
//! preprocessor and task-list rewrite. Mirrors the markdown-it pipeline in
//! `server/src/render/markdown.js`.

use std::path::Path;
use std::sync::OnceLock;

use pulldown_cmark::{Event, Options, Parser};
use regex::Regex;
use serde::Serialize;

use super::manifest::{self, Entry};

const IN_SCOPE_PREFIXES: &[&str] = &[
    "Infrastructure/Schemas/",
    "Infrastructure/Conventions/",
    "Infrastructure/Glossaries/",
    "Infrastructure/Reference/",
];

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];

#[derive(Debug)]
struct ResolveResult {
    resolved: bool,
    path: Option<String>,
    scope: Option<&'static str>, // "internal" | "external"
    display: String,
    anchor: Option<String>,
    ambiguous: Option<Vec<String>>,
}

fn resolve_wikilink(raw_target: &str) -> ResolveResult {
    let mut target = raw_target.to_string();
    let mut display: Option<String> = None;
    let mut anchor: Option<String> = None;
    if let Some(pipe) = target.find('|') {
        display = Some(target[pipe + 1..].trim().to_string());
        target = target[..pipe].trim().to_string();
    }
    if let Some(hash) = target.find('#') {
        anchor = Some(target[hash + 1..].trim().to_string());
        target = target[..hash].trim().to_string();
    }
    if target.is_empty() {
        return ResolveResult {
            resolved: false,
            path: None,
            scope: None,
            display: display.unwrap_or_else(|| raw_target.to_string()),
            anchor,
            ambiguous: None,
        };
    }
    let normalized = target.trim_end_matches(".md").to_string();
    let basename = Path::new(&normalized)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&normalized)
        .to_string();

    manifest::with_state(|s| {
        let mut entry: Option<Entry> = s.path_index.get(&normalized).cloned();
        let mut ambiguous: Option<Vec<String>> = None;
        if entry.is_none() {
            if let Some(arr) = s.basename_index.get(&basename.to_lowercase()) {
                if arr.len() == 1 {
                    entry = Some(arr[0].clone());
                } else if arr.len() > 1 {
                    ambiguous = Some(arr.iter().map(|e| e.path.clone()).collect());
                }
            }
        }
        if entry.is_none() {
            if let Some(arr) = s.alias_index.get(&normalized.to_lowercase()) {
                if arr.len() == 1 {
                    entry = Some(arr[0].clone());
                } else if arr.len() > 1 && ambiguous.is_none() {
                    ambiguous = Some(arr.iter().map(|e| e.path.clone()).collect());
                }
            }
        }
        let display_text = display.clone().unwrap_or(basename);
        match entry {
            None => ResolveResult {
                resolved: false,
                path: None,
                scope: None,
                display: display_text,
                anchor,
                ambiguous,
            },
            Some(e) => {
                let path = e.path.trim_end_matches(".md").to_string();
                let in_scope = IN_SCOPE_PREFIXES.iter().any(|p| e.path.starts_with(p));
                ResolveResult {
                    resolved: true,
                    path: Some(path),
                    scope: Some(if in_scope { "internal" } else { "external" }),
                    display: display_text,
                    anchor,
                    ambiguous: None,
                }
            }
        }
    })
}

/// Result of `resolve_link` — serialized to the frontend (Live Preview editor).
#[derive(Serialize)]
pub struct ResolveLinkOut {
    pub resolved: bool,
    pub path: Option<String>,
    pub kind: &'static str,          // "note" | "asset" | "unresolved"
    pub scope: Option<&'static str>, // "internal" | "external"
    pub display: String,
    pub anchor: Option<String>,
    pub ambiguous: Option<Vec<String>>,
}

/// Resolve a wikilink target (`embed=false`) or an embed target (`embed=true`)
/// to a vault path via the manifest indices. Powers the in-app Live Preview
/// editor: wikilink click-navigation and (later) image/transclusion embeds.
/// Mirrors the resolution `render_wikilink_html` / `render_embed_html` use.
pub fn resolve_link(target: &str, embed: bool) -> ResolveLinkOut {
    if embed {
        let path_part = target
            .split('|').next().unwrap_or("")
            .split('#').next().unwrap_or("")
            .trim();
        let ext = Path::new(path_part)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if IMAGE_EXTS.contains(&ext.as_str()) {
            let basename = Path::new(path_part)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(path_part);
            let hit = manifest::with_state(|s| {
                s.basename_index
                    .get(&basename.to_lowercase())
                    .and_then(|arr| arr.first().cloned())
                    .map(|e| e.path)
            });
            let (path, resolved) = match hit {
                Some(p) => (p, true),
                None => (path_part.to_string(), path_part.contains('/')),
            };
            return ResolveLinkOut {
                resolved,
                path: Some(path),
                kind: "asset",
                scope: None,
                display: path_part.to_string(),
                anchor: None,
                ambiguous: None,
            };
        }
        // Non-image embed → note transclusion; fall through to wikilink resolution.
    }
    let r = resolve_wikilink(target);
    ResolveLinkOut {
        kind: if r.resolved { "note" } else { "unresolved" },
        resolved: r.resolved,
        path: r.path,
        scope: r.scope,
        display: r.display,
        anchor: r.anchor,
        ambiguous: r.ambiguous,
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Match JS `encodeURIComponent` more closely than `urlencoding::encode` —
/// don't escape unreserved set `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')') {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn render_wikilink_html(inner: &str) -> String {
    let r = resolve_wikilink(inner);
    let anchor_suffix = match &r.anchor {
        Some(a) => format!("#{}", encode_component(a).replace("%20", "+")),
        None => String::new(),
    };
    if !r.resolved {
        let title = match &r.ambiguous {
            Some(cands) if cands.len() > 1 => format!("Ambiguous: matches {}", cands.join(", ")),
            _ => format!("{inner} (unresolved)"),
        };
        return format!(
            "<span class=\"wikilink wikilink--broken\" title=\"{}\">{}</span>",
            escape_html(&title),
            escape_html(if r.display.is_empty() { inner } else { &r.display }),
        );
    }
    let path = r.path.unwrap();
    let data_anchor = r
        .anchor
        .as_ref()
        .map(|a| format!(" data-anchor=\"{}\"", escape_html(a)))
        .unwrap_or_default();
    if r.scope == Some("internal") {
        format!(
            "<a class=\"wikilink wikilink--internal\" data-target=\"{}\"{} href=\"#/infrastructure/reference?path={}{}\">{}</a>",
            escape_html(&path),
            data_anchor,
            encode_component(&path),
            anchor_suffix,
            escape_html(&r.display),
        )
    } else {
        format!(
            "<a class=\"wikilink wikilink--internal\" data-target=\"{}\"{} href=\"#/page/{}{}\">{}</a>",
            escape_html(&path),
            data_anchor,
            encode_component(&path),
            anchor_suffix,
            escape_html(&r.display),
        )
    }
}

fn render_embed_html(inner: &str) -> String {
    let path_part = inner.split('|').next().unwrap_or("").split('#').next().unwrap_or("").trim();
    let ext = Path::new(path_part)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        // Asset resolution: try manifest first by basename, otherwise pass through.
        // For images, server's `resolveAsset` searches the vault — we mirror by
        // finding any entry whose path ends with the basename. Acceptable since
        // image filenames are unique-by-convention in this vault.
        let basename = Path::new(path_part)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path_part);
        let resolved = manifest::with_state(|s| {
            s.basename_index
                .get(&basename.to_lowercase())
                .and_then(|arr| arr.first().cloned())
                .map(|e| e.path)
        });
        let src_path = resolved.unwrap_or_else(|| path_part.to_string());
        let parts: Vec<String> = src_path.split('/').map(encode_component).collect();
        let src = format!("/api/file/{}", parts.join("/"));
        return format!(
            "<img src=\"{}\" alt=\"{}\" class=\"wikiembed-img\" loading=\"lazy\"/>",
            src,
            escape_html(path_part),
        );
    }
    format!("<span class=\"wikiembed\">↳ {}</span>", escape_html(inner))
}

/// Preprocess source: replace `![[X]]` and `[[X]]` with their rendered HTML
/// inline, while skipping fenced code blocks and inline code spans.
fn preprocess_wikilinks(src: &str) -> String {
    let mut out = String::with_capacity(src.len() + 256);
    let bytes = src.as_bytes();
    let mut i = 0;
    let mut in_fence: Option<String> = None; // current fence marker
    let mut at_line_start = true;

    while i < bytes.len() {
        // Detect fenced code block boundaries at line starts.
        if at_line_start {
            // Skip up to 3 leading spaces
            let mut j = i;
            let mut spaces = 0;
            while j < bytes.len() && bytes[j] == b' ' && spaces < 3 {
                j += 1;
                spaces += 1;
            }
            if j < bytes.len() && (bytes[j] == b'`' || bytes[j] == b'~') {
                let ch = bytes[j];
                let mut k = j;
                while k < bytes.len() && bytes[k] == ch {
                    k += 1;
                }
                let run = k - j;
                if run >= 3 {
                    let marker: String = std::iter::repeat(ch as char).take(run).collect();
                    match &in_fence {
                        Some(open) => {
                            if marker.starts_with(open.as_str()) || open.starts_with(&marker) {
                                // closing fence
                                in_fence = None;
                                out.push_str(&src[i..k]);
                                i = k;
                                // consume to end of line (slice-copy preserves UTF-8)
                                let nl = src[i..].find('\n').map(|p| i + p).unwrap_or(bytes.len());
                                out.push_str(&src[i..nl]);
                                i = nl;
                                if i < bytes.len() {
                                    out.push('\n');
                                    i += 1;
                                }
                                at_line_start = true;
                                continue;
                            }
                        }
                        None => {
                            in_fence = Some(marker);
                            out.push_str(&src[i..k]);
                            i = k;
                            let nl = src[i..].find('\n').map(|p| i + p).unwrap_or(bytes.len());
                            out.push_str(&src[i..nl]);
                            i = nl;
                            if i < bytes.len() {
                                out.push('\n');
                                i += 1;
                            }
                            at_line_start = true;
                            continue;
                        }
                    }
                }
            }
        }

        if in_fence.is_some() {
            // Slice-copy the next UTF-8 char to preserve multi-byte sequences.
            let ch = src[i..].chars().next().unwrap();
            let n = ch.len_utf8();
            out.push_str(&src[i..i + n]);
            at_line_start = ch == '\n';
            i += n;
            continue;
        }

        // Inline code span: backtick run, skip to matching run.
        if bytes[i] == b'`' {
            let mut k = i;
            while k < bytes.len() && bytes[k] == b'`' {
                k += 1;
            }
            let run = k - i;
            let opener_run = run;
            // find matching closer of same length
            let mut m = k;
            while m < bytes.len() {
                if bytes[m] == b'`' {
                    let mut n = m;
                    while n < bytes.len() && bytes[n] == b'`' {
                        n += 1;
                    }
                    if n - m == opener_run {
                        // emit through closer
                        out.push_str(&src[i..n]);
                        i = n;
                        at_line_start = false;
                        break;
                    }
                    m = n;
                } else {
                    m += 1;
                }
            }
            if i < m {
                // no closer found — emit literal backticks and advance
                out.push_str(&src[i..k]);
                i = k;
                at_line_start = false;
            }
            continue;
        }

        // ![[...]]
        if bytes[i] == b'!' && i + 2 < bytes.len() && bytes[i + 1] == b'[' && bytes[i + 2] == b'[' {
            if let Some(end_rel) = src[i + 3..].find("]]") {
                let inner = &src[i + 3..i + 3 + end_rel];
                if !inner.contains('\n') {
                    out.push_str(&render_embed_html(inner));
                    i = i + 3 + end_rel + 2;
                    at_line_start = false;
                    continue;
                }
            }
        }

        // [[...]]
        if bytes[i] == b'[' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            if let Some(end_rel) = src[i + 2..].find("]]") {
                let inner = &src[i + 2..i + 2 + end_rel];
                if !inner.contains('\n') {
                    out.push_str(&render_wikilink_html(inner));
                    i = i + 2 + end_rel + 2;
                    at_line_start = false;
                    continue;
                }
            }
        }

        // Default: copy the next UTF-8 char verbatim.
        let ch = src[i..].chars().next().unwrap();
        let n = ch.len_utf8();
        out.push_str(&src[i..i + n]);
        at_line_start = ch == '\n';
        i += n;
    }
    out
}

fn strip_frontmatter(text: &str) -> &str {
    if !text.starts_with("---") {
        return text;
    }
    if let Some(end) = text[3..].find("\n---") {
        let after = &text[3 + end + 4..];
        return after.strip_prefix('\n').unwrap_or(after);
    }
    text
}

pub fn parse_frontmatter_title(text: &str) -> Option<String> {
    if !text.starts_with("---") {
        return None;
    }
    let end = text[3..].find("\n---")?;
    let fm = &text[3..3 + end];
    let re = Regex::new(r"(?im)^\s*title\s*:\s*(.+?)\s*$").ok()?;
    let caps = re.captures(fm)?;
    let mut v = caps.get(1)?.as_str().to_string();
    if (v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')) {
        v = v[1..v.len() - 1].to_string();
    }
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn line_of_offset(src: &str, offset: usize) -> usize {
    src[..offset.min(src.len())].bytes().filter(|&b| b == b'\n').count()
}

fn autolink_filename_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"<a[^>]*href="https?://[^"]+\.md"[^>]*>([^<]+)</a>"#).unwrap()
    })
}

pub fn render_string(markdown_src: &str) -> String {
    let stripped = strip_frontmatter(markdown_src);
    let preprocessed = preprocess_wikilinks(stripped);
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TABLES);

    let parser = Parser::new_ext(&preprocessed, opts).into_offset_iter();
    let raw: Vec<(Event, std::ops::Range<usize>)> = parser.collect();

    // Replace TaskListMarker events with raw HTML for our custom checkbox.
    let mut rewritten: Vec<Event> = Vec::with_capacity(raw.len());
    for (ev, range) in raw {
        match ev {
            Event::TaskListMarker(checked) => {
                let line = line_of_offset(&preprocessed, range.start);
                let checked_attr = if checked { " checked" } else { "" };
                rewritten.push(Event::Html(
                    format!(
                        "<input type=\"checkbox\" class=\"task-checkbox\" data-line=\"{}\"{}/> ",
                        line, checked_attr,
                    )
                    .into(),
                ));
            }
            other => rewritten.push(other),
        }
    }

    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, rewritten.into_iter());

    // Post-process: add `class="task-item"` to `<li>` elements containing a
    // task-checkbox. Regex over the rendered HTML.
    static LI_TASK_RE: OnceLock<Regex> = OnceLock::new();
    let li_re = LI_TASK_RE.get_or_init(|| {
        Regex::new(r#"<li>(\s*<input type="checkbox" class="task-checkbox")"#).unwrap()
    });
    let html = li_re.replace_all(&html, "<li class=\"task-item\">$1").into_owned();

    // Post-process: render Obsidian callouts (`> [!type] title`). pulldown emits
    // them as plain `<blockquote><p>[!type]…</p></blockquote>`; rewrite to a
    // callout box so Reading mode matches the Live Preview editor. Non-nested
    // only (first `</blockquote>` closes the match) — sufficient for vault use.
    static CALLOUT_RE: OnceLock<Regex> = OnceLock::new();
    let callout_re = CALLOUT_RE.get_or_init(|| {
        Regex::new(r"(?s)<blockquote>\s*<p>\[!(\w+)\]([+-]?)[ \t]*(.*?)</blockquote>").unwrap()
    });
    let html = callout_re
        .replace_all(&html, |caps: &regex::Captures| {
            let kind = caps[1].to_lowercase();
            let rest = &caps[3];
            let nl = rest.find('\n');
            let pc = rest.find("</p>");
            let (title_raw, body): (&str, String) = match (pc, nl) {
                // First paragraph is title-only (blank line after title).
                (Some(p), n) if n.map_or(true, |nn| p < nn) => (&rest[..p], rest[p + 4..].to_string()),
                // Title shares the paragraph with body (soft line breaks).
                (_, Some(n)) => (&rest[..n], format!("<p>{}", &rest[n + 1..])),
                _ => (rest, String::new()),
            };
            let title = title_raw.trim();
            let title_html = if title.is_empty() {
                let mut c = kind.chars();
                c.next()
                    .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                    .unwrap_or_default()
            } else {
                title.to_string()
            };
            format!(
                "<div class=\"callout callout-{k}\" data-callout=\"{k}\"><div class=\"callout-title\">{t}</div><div class=\"callout-content\">{b}</div></div>",
                k = kind,
                t = title_html,
                b = body.trim(),
            )
        })
        .into_owned();

    // Autolink scrub
    autolink_filename_re().replace_all(&html, "$1").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callout_with_title() {
        let html = render_string("> [!note] My Title\n> body text");
        assert!(html.contains("class=\"callout callout-note\""), "got: {html}");
        assert!(html.contains("data-callout=\"note\""), "got: {html}");
        assert!(html.contains("<div class=\"callout-title\">My Title</div>"), "got: {html}");
        assert!(html.contains("body text"), "got: {html}");
    }

    #[test]
    fn callout_default_title_capitalized() {
        let html = render_string("> [!warning]\n> careful");
        assert!(html.contains("class=\"callout callout-warning\""), "got: {html}");
        assert!(html.contains("<div class=\"callout-title\">Warning</div>"), "got: {html}");
        assert!(html.contains("careful"), "got: {html}");
    }

    #[test]
    fn callout_fold_marker_stripped() {
        let html = render_string("> [!tip]- Foldable\n> hidden");
        assert!(html.contains("class=\"callout callout-tip\""), "got: {html}");
        assert!(html.contains("<div class=\"callout-title\">Foldable</div>"), "got: {html}");
    }

    #[test]
    fn callout_type_lowercased() {
        let html = render_string("> [!NOTE] Mixed Case Type");
        assert!(html.contains("class=\"callout callout-note\""), "got: {html}");
    }

    #[test]
    fn plain_blockquote_unchanged() {
        let html = render_string("> just a regular quote");
        assert!(html.contains("<blockquote>"), "got: {html}");
        assert!(!html.contains("callout"), "got: {html}");
    }
}
