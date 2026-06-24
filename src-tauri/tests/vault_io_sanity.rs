//! Sanity tests for Sub-feature 2 vault file IO + renderer against the real
//! vault at /home/malthaiel/Documents/Citadel.
//!
//! These verify that the Rust IO commands and the markdown renderer produce
//! sensible output for known-stable vault content. They are NOT full parity
//! tests against the Node server (full Node-vs-Rust HTML diff is deferred —
//! see Update Queue entry).
//!
//! Marked `#[ignore]` so `cargo test` in CI without the vault skips them.
//! Run locally with:
//!   cargo test -p iskariel --test vault_io_sanity -- --ignored --nocapture

use app_lib::render;

#[test]
#[ignore]
fn render_claude_md_smoke() {
    let out = render::render_path("CLAUDE").expect("render CLAUDE.md");
    assert!(out.html.contains("<h2"), "expected H2 headings in rendered CLAUDE.md");
    assert!(out.mtime > 0.0);
    assert_eq!(out.path, "CLAUDE");
    // Wikilinks should resolve — CLAUDE.md links to Infrastructure/Reference/Structure
    assert!(
        out.html.contains("wikilink--internal"),
        "expected at least one resolved wikilink",
    );
}

#[test]
#[ignore]
fn render_handles_nonexistent() {
    let err = render::render_path("does-not-exist-xyz-12345").unwrap_err();
    match err {
        render::RenderError::NotFound(_) => {}
        other => panic!("expected NotFound, got {:?}", other),
    }
}

#[test]
#[ignore]
fn render_rejects_traversal() {
    let err = render::render_path("../etc/passwd").unwrap_err();
    match err {
        render::RenderError::Invalid(_) => {}
        other => panic!("expected Invalid, got {:?}", other),
    }
}

#[test]
fn frontmatter_title_parser() {
    assert_eq!(
        render::markdown::parse_frontmatter_title("---\ntitle: Hello\n---\nbody"),
        Some("Hello".into()),
    );
    assert_eq!(
        render::markdown::parse_frontmatter_title("---\ntitle: \"Quoted Title\"\n---\nbody"),
        Some("Quoted Title".into()),
    );
    assert_eq!(
        render::markdown::parse_frontmatter_title("no frontmatter here"),
        None,
    );
    assert_eq!(
        render::markdown::parse_frontmatter_title("---\nfoo: bar\n---\nbody"),
        None,
    );
}

#[test]
fn render_string_basic_markdown() {
    let html = render::markdown::render_string("# heading\n\nsome **bold** text");
    assert!(html.contains("<h1>heading</h1>"));
    assert!(html.contains("<strong>bold</strong>"));
}

#[test]
fn render_string_strips_frontmatter() {
    let html = render::markdown::render_string("---\ntitle: X\n---\n# Body");
    assert!(html.contains("<h1>Body</h1>"));
    assert!(!html.contains("title:"));
}

#[test]
fn render_string_task_list() {
    let html = render::markdown::render_string("- [ ] todo\n- [x] done");
    assert!(
        html.contains("class=\"task-checkbox\""),
        "expected task-checkbox class, got: {html}",
    );
    assert!(
        html.contains("data-line=\"0\""),
        "expected data-line=0 for first task, got: {html}",
    );
    assert!(
        html.contains("class=\"task-item\""),
        "expected task-item class on <li>, got: {html}",
    );
}

#[test]
fn render_string_wikilink_unresolved() {
    // Without the vault manifest loaded, [[Foo]] should render as broken.
    let html = render::markdown::render_string("[[ThisPageDoesNotExist12345]]");
    assert!(
        html.contains("wikilink--broken") || html.contains("wikilink--internal"),
        "expected a wikilink span/anchor, got: {html}",
    );
}

#[test]
fn render_string_code_fence_skips_wikilinks() {
    // Wikilinks inside a code fence should be preserved verbatim.
    let src = "```\n[[NotResolved]]\n```\n";
    let html = render::markdown::render_string(src);
    assert!(
        html.contains("[[NotResolved]]"),
        "wikilink inside ``` fence should remain literal, got: {html}",
    );
    assert!(!html.contains("wikilink--"), "no wikilink html should be emitted inside fence");
}

#[test]
fn render_string_inline_code_skips_wikilinks() {
    let html = render::markdown::render_string("text `[[Foo]]` text");
    assert!(html.contains("[[Foo]]"), "wikilink inside inline code should remain literal");
}

#[test]
fn render_string_autolink_filename_scrub() {
    // markdown-it would linkify "Denizen.md" as http://Denizen.md — pulldown
    // does the same with linkify-style autolinks. Our scrub strips the wrap.
    let html = render::markdown::render_string("see Denizen.md for details");
    assert!(
        !html.contains("href=\"http://Denizen.md\""),
        "filename-as-host autolink should be scrubbed, got: {html}",
    );
}
