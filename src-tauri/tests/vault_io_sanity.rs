//! Sanity tests for the Rust vault IO + markdown renderer.
//!
//! The real-vault smoke tests read `AGENTIC_VAULT_ROOT` (the first-precedence
//! vault root; see commands::vault::vault_root). They self-skip when it is
//! unset — so they run as no-ops in CI and as real checks when a vault root is
//! provided. The pure-function tests below always run.
//!
//! Run the smoke tests against a real vault:
//!   AGENTIC_VAULT_ROOT=<path-to-vault> cargo test --manifest-path src-tauri/Cargo.toml --test vault_io_sanity -- --nocapture

use app_lib::render;

#[test]
fn render_claude_md_smoke() {
    let Ok(_root) = std::env::var("AGENTIC_VAULT_ROOT") else {
        eprintln!("skip render_claude_md_smoke: AGENTIC_VAULT_ROOT unset");
        return;
    };
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
fn render_handles_nonexistent() {
    let Ok(_root) = std::env::var("AGENTIC_VAULT_ROOT") else {
        eprintln!("skip render_handles_nonexistent: AGENTIC_VAULT_ROOT unset");
        return;
    };
    let err = render::render_path("does-not-exist-xyz-12345").unwrap_err();
    match err {
        render::RenderError::NotFound(_) => {}
        other => panic!("expected NotFound, got {:?}", other),
    }
}

#[test]
fn render_rejects_traversal() {
    let Ok(_root) = std::env::var("AGENTIC_VAULT_ROOT") else {
        eprintln!("skip render_rejects_traversal: AGENTIC_VAULT_ROOT unset");
        return;
    };
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
