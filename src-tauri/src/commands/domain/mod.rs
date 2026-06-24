//! Domain Builder — atomic scaffolder for a new Research-type knowledge domain.
//!
//! `scaffold_domain` takes a `DomainConfig` (built by the app's Domain Builder
//! wizard) and either returns a dry-run `ScaffoldPlan` (preview) or commits it.
//!
//! SF1 scope: config types + plan builder (folders + Domain Index + Glossary +
//! persisted config page) + commit with new-file/new-dir rollback. Later
//! sub-features extend the plan + journal: the `/transcript` sub-spec (SF2), the
//! daily-log + Update Queue appends (SF3), and the structure-aware
//! convention-doc edits (SF4 — populate `ScaffoldPlan.edits`).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize, Serializer};
use tauri::AppHandle;

use crate::commands::vault::atomic_write;

mod subspec;

// ─────────────────────────── Config schema ───────────────────────────
// Typed mirror of the wizard's DomainConfig (serde camelCase). Fields not yet
// consumed by the backend (extraction, boldRules, authoring, lastBuild, …) are
// accepted and ignored here; the persisted config page is written from the RAW
// JSON value (see `scaffold_domain`) so nothing the wizard sends is dropped.

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folders {
    #[serde(default = "bool_true")]
    pub concepts: bool,
    #[serde(default = "bool_true")]
    pub entities: bool,
    #[serde(default = "bool_true")]
    pub topics: bool,
    #[serde(default = "bool_true")]
    pub assets: bool,
}

// Default to all-on, matching the wizard's emptyDraft. A research domain with an
// unspecified pipeline gets the standard folder set; the wizard always sends all
// four explicitly, so this only governs partial/absent configs (e.g. reopen).
impl Default for Folders {
    fn default() -> Self {
        Self { concepts: true, entities: true, topics: true, assets: true }
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    #[serde(default)]
    pub folders: Folders,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFolder {
    pub name: String,
    #[serde(default)]
    pub type_frontmatter: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityType {
    pub name: String,
    #[serde(default)]
    pub promote: bool,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityTaxonomy {
    #[serde(default)]
    pub types: Vec<EntityType>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedTerm {
    pub canonical: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub misspellings: Vec<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryCfg {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub seed_terms: Vec<SeedTerm>,
    #[serde(default)]
    pub wire_auto_correction: bool,
}

fn bool_true() -> bool {
    true
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extraction {
    #[serde(default = "bool_true")]
    pub entities: bool,
    #[serde(default = "bool_true")]
    pub concepts: bool,
    #[serde(default = "bool_true")]
    pub topics: bool,
}

impl Default for Extraction {
    fn default() -> Self {
        Self {
            entities: true,
            concepts: true,
            topics: true,
        }
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoldRules {
    #[serde(default)]
    pub preset_pack: String,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub everywhere_not_first_mention: bool,
}

fn default_mode() -> String {
    "timestamped".into()
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainConfig {
    pub domain_name: String,
    #[serde(default)]
    pub domain_frontmatter: String,
    #[serde(default)]
    pub domain_slug: String,
    #[serde(default)]
    pub transcript_slug: String,
    #[serde(default)]
    pub vault_id: String,
    #[serde(default)]
    pub pipeline: Pipeline,
    #[serde(default)]
    pub custom_folders: Vec<CustomFolder>,
    #[serde(default)]
    pub entity_taxonomy: EntityTaxonomy,
    #[serde(default)]
    pub extraction: Extraction,
    #[serde(default)]
    pub bold_rules: BoldRules,
    #[serde(default = "default_mode")]
    pub transcript_mode: String,
    #[serde(default)]
    pub glossary: GlossaryCfg,
}

// ─────────────────────────── Plan output ───────────────────────────
// Returned for both dry-run (preview) and commit. The frontend renders the
// tree from `created_dirs` + `new_files`, full file content from `new_files`,
// and convention-doc diffs from `edits` (empty until SF4).

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFile {
    pub path: String,
    pub content: String,
    /// Mounted vault: "content" (default) or "pulse" (daily log, SF3).
    pub root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedEdit {
    pub path: String,
    pub root: String,
    pub before: String,
    pub after: String,
    pub anchor_desc: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldPlan {
    pub created_dirs: Vec<String>,
    pub new_files: Vec<PlannedFile>,
    pub edits: Vec<PlannedEdit>,
    pub warnings: Vec<String>,
    pub committed: bool,
}

/// Internal edit descriptor. The `op` is re-applied to the file's CURRENT
/// content at commit time (so a concurrent external edit isn't clobbered),
/// while `before`/`after` drive the preview diff.
enum EditOp {
    /// Append a block at end of file (e.g. Update Queue entries).
    AppendEof(String),
    /// Insert a block at the end of a heading's section (e.g. the daily
    /// `## Vault Activity` bullet).
    InsertUnderHeading { heading: String, block: String },
    /// Insert `bullet` alphabetically among the `- ` bullets under `heading`.
    /// No-op if `marker` is already present (idempotent reopen).
    InsertBulletAlpha { heading: String, bullet: String, marker: String },
    /// Insert `block` right after the contract block whose first line equals
    /// `anchor_line`. No-op if `marker` already present.
    InsertAfterBlock { anchor_line: String, block: String, marker: String },
    /// Insert `block` immediately before `heading`. No-op if `marker` present.
    InsertBeforeHeading { heading: String, block: String, marker: String },
    /// Add `value` alphabetically to the backtick-delimited enum on the line
    /// containing `line_contains` (e.g. the Frontmatter `Domain:` enum line).
    EnumAdd { line_contains: String, value: String },
    /// Replace the entire file contents — a reopen regenerate of a file that
    /// already exists (sub-spec / Domain Index / Glossary / config page). The
    /// prior bytes are journaled for rollback and the preview shows a line diff,
    /// so it is never a silent clobber.
    ReplaceAll(String),
}

struct EditPlan {
    path: String,
    root: String,
    op: EditOp,
    before: String,
    after: String,
}

// ─────────────────────────── Error ───────────────────────────
#[derive(Debug)]
pub enum DomainError {
    Invalid(String),
    Collision(String),
    Io(String),
}

impl Serialize for DomainError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let (code, msg) = match self {
            DomainError::Invalid(m) => ("INVALID", m.as_str()),
            DomainError::Collision(m) => ("COLLISION", m.as_str()),
            DomainError::Io(m) => ("IO", m.as_str()),
        };
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("code", code)?;
        m.serialize_entry("message", msg)?;
        m.end()
    }
}

impl From<crate::commands::vault::VaultError> for DomainError {
    fn from(e: crate::commands::vault::VaultError) -> Self {
        DomainError::Io(format!("{e:?}"))
    }
}

// ─────────────────────────── Helpers ───────────────────────────
fn validate_name(name: &str) -> Result<(), DomainError> {
    let n = name.trim();
    if n.is_empty() {
        return Err(DomainError::Invalid("Domain name is empty".into()));
    }
    if n.starts_with('.') || n.contains('/') || n.contains('\\') || n.contains("..") {
        return Err(DomainError::Invalid(
            "Domain name has illegal path characters".into(),
        ));
    }
    Ok(())
}

/// Canonical `Domain:` frontmatter value — Title-Case words joined by hyphens
/// (e.g. "Artificial Intelligence" → "Artificial-Intelligence"). Uses the
/// wizard's explicit value when provided, else derives from the folder name.
fn frontmatter_of(cfg: &DomainConfig) -> String {
    let explicit = cfg.domain_frontmatter.trim();
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    cfg.domain_name
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

/// `/transcript` slug — defaults to `yt-<lowercased-hyphenated-domain>`.
fn transcript_slug(cfg: &DomainConfig) -> String {
    let explicit = cfg.transcript_slug.trim();
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    let kebab = cfg
        .domain_name
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    format!("yt-{kebab}")
}

/// The YouTube Pipeline subtype folders to create, in display order.
/// Transcripts is always present; Raw whenever a transcript mode is active;
/// then the toggled standard folders, promoted entity-type folders, and
/// user-named custom folders.
fn included_subfolders(cfg: &DomainConfig) -> Vec<String> {
    let mut v = vec!["Transcripts".to_string()];
    if cfg.transcript_mode != "none" {
        v.push("Raw".into());
    }
    if cfg.pipeline.folders.concepts {
        v.push("Concepts".into());
    }
    if cfg.pipeline.folders.entities {
        v.push("Entities".into());
    }
    if cfg.pipeline.folders.topics {
        v.push("Topics".into());
    }
    if cfg.pipeline.folders.assets {
        v.push("Assets".into());
    }
    for t in &cfg.entity_taxonomy.types {
        let name = t.name.trim();
        if t.promote && !name.is_empty() {
            v.push(name.to_string());
        }
    }
    for c in &cfg.custom_folders {
        let name = c.name.trim();
        if !name.is_empty() {
            v.push(name.to_string());
        }
    }
    v
}

// ─────────────────────────── File renderers ───────────────────────────
fn render_domain_index(cfg: &DomainConfig, today: &str) -> String {
    let name = cfg.domain_name.trim();
    let mut s = String::new();
    s.push_str("---\nType: Infrastructure\n---\n\n");
    s.push_str(&format!(
        "The catalog for the {name} domain. Every page in `Knowledge/{name}/` should appear under exactly one section below, with a one-line summary.\n\n"
    ));
    s.push_str("## Conventions\n\n");
    s.push_str("- Entry format: `- [[<dir>/<slug>]] — one-line summary`.\n");
    s.push_str("- Sort alphabetically within each leaf section.\n");
    s.push_str("- Subdivide a section with `####` once it exceeds ~15 entries.\n\n");
    s.push_str("## YouTube Pipeline\n\n");
    for sub in included_subfolders(cfg) {
        s.push_str(&format!("### {sub}\n\n_empty — initialized {today}_\n\n"));
    }
    s
}

fn render_glossary(cfg: &DomainConfig, today: &str) -> String {
    let name = cfg.domain_name.trim();
    let slug = transcript_slug(cfg);
    let mut s = String::new();
    s.push_str(&format!(
        "---\nType: Infrastructure\nFeature Kind: reference\nStatus: Active\nAdded: {today}\n---\n\n"
    ));
    s.push_str(&format!(
        "Canonical {name} terminology for transcription auto-correction. Consumed by `/transcript {slug}` at clean-time: each known misspelling is replaced with the canonical display name, and the vault filename drives wikilink injection.\n\n"
    ));
    s.push_str("## Terms\n\n");
    s.push_str("| Canonical Display Name | Vault Filename | Known Misspellings |\n|---|---|---|\n");
    for t in &cfg.glossary.seed_terms {
        let canonical = t.canonical.trim();
        if canonical.is_empty() {
            continue;
        }
        let filename = if t.filename.trim().is_empty() {
            canonical
        } else {
            t.filename.trim()
        };
        let miss = t
            .misspellings
            .iter()
            .map(|m| m.trim())
            .filter(|m| !m.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!("| {canonical} | {filename} | {miss} |\n"));
    }
    s
}

fn render_config_page(cfg: &DomainConfig, today: &str, cfg_json: &str) -> String {
    let fm = frontmatter_of(cfg);
    let name = cfg.domain_name.trim();
    format!(
        "---\nType: Infrastructure\nFeature Kind: domain-state\nDomain: {fm}\nStatus: Active\nCreated: {today}\nUpdated: {today}\n---\n\nMachine-managed state for the {name} knowledge domain, written by the Iskariel Domain Builder. Do not hand-edit the JSON block — re-open the builder to reconfigure.\n\n```json\n{cfg_json}\n```\n"
    )
}

// ─────────────────────────── Plan builder ───────────────────────────
fn build_plan(cfg: &DomainConfig, today: &str, cfg_json: &str) -> ScaffoldPlan {
    let name = cfg.domain_name.trim();
    let base = format!("Knowledge/{name}/YouTube Pipeline");

    let created_dirs = included_subfolders(cfg)
        .into_iter()
        .map(|sub| format!("{base}/{sub}"))
        .collect();

    let mut new_files = vec![PlannedFile {
        path: format!("Infrastructure/Indexes/{name} Index.md"),
        content: render_domain_index(cfg, today),
        root: "content".into(),
    }];
    if cfg.glossary.enabled {
        new_files.push(PlannedFile {
            path: format!("Infrastructure/Glossaries/{name} Glossary.md"),
            content: render_glossary(cfg, today),
            root: "content".into(),
        });
    }
    if cfg.transcript_mode != "none" {
        let slug = transcript_slug(cfg);
        new_files.push(PlannedFile {
            path: format!("Infrastructure/Skills/Transcripts/transcript-{slug}.md"),
            content: subspec::render_subspec(cfg, today),
            root: "content".into(),
        });
    }
    new_files.push(PlannedFile {
        path: format!("Infrastructure/Domains/{name}.md"),
        content: render_config_page(cfg, today, cfg_json),
        root: "content".into(),
    });

    ScaffoldPlan {
        created_dirs,
        new_files,
        edits: Vec::new(),
        warnings: Vec::new(),
        committed: false,
    }
}

fn root_abs(root: &str, content: &Path, pulse: Option<&Path>) -> Result<PathBuf, DomainError> {
    match root {
        "pulse" => pulse
            .map(|p| p.to_path_buf())
            .ok_or_else(|| DomainError::Io("pulse vault not available at commit".into())),
        _ => Ok(content.to_path_buf()),
    }
}

/// Best-effort rollback. Restores every edited/overwritten file to its prior
/// bytes and deletes every newly-created file. For a FRESH scaffold the whole
/// new domain tree is removed wholesale; for a REOPEN only the folders we
/// actually created this run are removed (deepest-first, empty-only) so existing
/// domain content is never destroyed.
fn rollback_all(
    created_files: &[PathBuf],
    created_dirs: &[PathBuf],
    restored: &[(PathBuf, Vec<u8>)],
    domain_root: &Path,
    reopen: bool,
) {
    for (p, prior) in restored {
        let _ = fs::write(p, prior);
    }
    for p in created_files {
        let _ = fs::remove_file(p);
    }
    if reopen {
        let mut dirs: Vec<&PathBuf> = created_dirs.iter().collect();
        dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        for d in dirs {
            let _ = fs::remove_dir(d); // empty-only; ignores non-empty/missing
        }
    } else {
        let _ = fs::remove_dir_all(domain_root);
    }
}

/// Apply an edit op to a file's current content. None when the anchor is
/// absent (caller skips at plan time / aborts at commit time).
fn apply_op(content: &str, op: &EditOp) -> Option<String> {
    match op {
        EditOp::AppendEof(block) => {
            let mut s = content.to_string();
            if !s.ends_with('\n') {
                s.push('\n');
            }
            s.push_str(block);
            if !s.ends_with('\n') {
                s.push('\n');
            }
            Some(s)
        }
        EditOp::InsertUnderHeading { heading, block } => insert_under_heading(content, heading, block),
        EditOp::InsertBulletAlpha { heading, bullet, marker } => {
            insert_bullet_alpha(content, heading, bullet, marker)
        }
        EditOp::InsertAfterBlock { anchor_line, block, marker } => {
            insert_after_block(content, anchor_line, block, marker)
        }
        EditOp::InsertBeforeHeading { heading, block, marker } => {
            insert_before_heading(content, heading, block, marker)
        }
        EditOp::EnumAdd { line_contains, value } => enum_add(content, line_contains, value),
        EditOp::ReplaceAll(new_content) => Some(new_content.clone()),
    }
}

/// Insert `block` at the end of `heading`'s section — just after its last
/// non-blank line, preserving the blank line before the next `## ` heading.
/// Heading match is case-insensitive. None if the heading is absent.
fn insert_under_heading(content: &str, heading: &str, block: &str) -> Option<String> {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let h = lines
        .iter()
        .position(|l| l.trim_end().eq_ignore_ascii_case(heading))?;
    let mut end = lines.len();
    for j in (h + 1)..lines.len() {
        if lines[j].trim_start().starts_with("## ") {
            end = j;
            break;
        }
    }
    let mut ins = end;
    while ins > h + 1 && lines[ins - 1].trim().is_empty() {
        ins -= 1;
    }
    let mut out = String::new();
    for l in &lines[..ins] {
        out.push_str(l);
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(block);
    if !block.ends_with('\n') {
        out.push('\n');
    }
    for l in &lines[ins..] {
        out.push_str(l);
    }
    Some(out)
}

/// Insert a single line/bullet at line index `at`.
fn splice(lines: &[&str], at: usize, insert: &str) -> String {
    let mut out = String::new();
    for l in &lines[..at] {
        out.push_str(l);
    }
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(insert);
    if !insert.ends_with('\n') {
        out.push('\n');
    }
    for l in &lines[at..] {
        out.push_str(l);
    }
    out
}

/// Insert a multi-line block at line index `at`, padded with a blank line on
/// each side so it reads as its own paragraph/section.
fn splice_block(lines: &[&str], at: usize, block: &str) -> String {
    let mut out = String::new();
    for l in &lines[..at] {
        out.push_str(l);
    }
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
    out.push_str(block);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.ends_with("\n\n") {
        out.push('\n');
    }
    for l in &lines[at..] {
        out.push_str(l);
    }
    out
}

/// Insert `bullet` alphabetically among the `- ` bullets under `heading`
/// (full-line lexical compare — the shared link prefix means this orders by the
/// trailing name). Idempotent via `marker`. None if the heading is absent.
fn insert_bullet_alpha(content: &str, heading: &str, bullet: &str, marker: &str) -> Option<String> {
    if content.contains(marker) {
        return Some(content.to_string());
    }
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let h = lines.iter().position(|l| l.trim_end() == heading)?;
    let mut end = lines.len();
    for j in (h + 1)..lines.len() {
        if lines[j].trim_start().starts_with("## ") {
            end = j;
            break;
        }
    }
    let mut insert_at: Option<usize> = None;
    let mut last_bullet: Option<usize> = None;
    for i in (h + 1)..end {
        if lines[i].trim_start().starts_with("- ") {
            last_bullet = Some(i);
            if insert_at.is_none() && lines[i] > bullet {
                insert_at = Some(i);
            }
        }
    }
    let at = insert_at
        .or_else(|| last_bullet.map(|i| i + 1))
        .unwrap_or(h + 1);
    Some(splice(&lines, at, bullet))
}

/// Insert `block` right after the contract block whose first line equals
/// `anchor_line` (before the next `### `/`## ` heading). Idempotent via `marker`.
fn insert_after_block(content: &str, anchor_line: &str, block: &str, marker: &str) -> Option<String> {
    if content.contains(marker) {
        return Some(content.to_string());
    }
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let a = lines.iter().position(|l| l.trim_end() == anchor_line)?;
    let mut end = lines.len();
    for j in (a + 1)..lines.len() {
        let t = lines[j].trim_start();
        if t.starts_with("### ") || t.starts_with("## ") {
            end = j;
            break;
        }
    }
    let mut ins = end;
    while ins > a + 1 && lines[ins - 1].trim().is_empty() {
        ins -= 1;
    }
    Some(splice_block(&lines, ins, block))
}

/// Insert `block` immediately before `heading`. Idempotent via `marker`.
fn insert_before_heading(content: &str, heading: &str, block: &str, marker: &str) -> Option<String> {
    if content.contains(marker) {
        return Some(content.to_string());
    }
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let h = lines.iter().position(|l| l.trim_end() == heading)?;
    Some(splice_block(&lines, h, block))
}

/// Add `value` alphabetically to the backtick-delimited enum on the first line
/// containing `line_contains` (e.g. `` `Domain`: `A | B | C` ``). Idempotent
/// (returns unchanged if already present). None if the line is absent.
fn enum_add(content: &str, line_contains: &str, value: &str) -> Option<String> {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let idx = lines.iter().position(|l| l.contains(line_contains))?;
    let line = lines[idx];
    let marker = "`: `";
    let mstart = line.find(marker)? + marker.len();
    let rest = &line[mstart..];
    let mend = rest.rfind('`')?;
    let enum_str = &rest[..mend];
    let mut parts: Vec<&str> = enum_str.split(" | ").collect();
    if parts.iter().any(|p| *p == value) {
        return Some(content.to_string());
    }
    let pos = parts.iter().position(|p| *p > value).unwrap_or(parts.len());
    parts.insert(pos, value);
    let new_enum = parts.join(" | ");
    let new_line = format!("{}{}{}", &line[..mstart], new_enum, &rest[mend..]);
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        if i == idx {
            out.push_str(&new_line);
        } else {
            out.push_str(l);
        }
    }
    Some(out)
}

/// Plan a content-vault edit: read the file, apply the op, and push an EditPlan
/// only when it actually changes the content. Missing file or missing anchor →
/// a warning (graceful degrade), never a hard failure.
fn plan_content_edit(
    root: &Path,
    rel: &str,
    op: EditOp,
    edits: &mut Vec<EditPlan>,
    warnings: &mut Vec<String>,
) {
    let abs = root.join(rel);
    if !abs.is_file() {
        warnings.push(format!("{rel} not found in target vault — edit skipped."));
        return;
    }
    let before = fs::read_to_string(&abs).unwrap_or_default();
    match apply_op(&before, &op) {
        Some(after) if after != before => {
            edits.push(EditPlan { path: rel.into(), root: "content".into(), op, before, after })
        }
        Some(_) => {} // already present — idempotent no-op
        None => warnings.push(format!("anchor not found in {rel} — edit skipped.")),
    }
}

/// The convention-doc edits (content vault) whose anchors/ops don't depend on
/// the new-files list, returned as pure `(rel, op)` pairs so `scaffold_domain`
/// and the integration test consume the EXACT same anchors (no drift). The
/// daily-log (pulse) and Update Queue (needs the Files: list) edits stay inline
/// in the command because they need extra runtime context.
fn convention_doc_ops(name: &str, fm: &str, subtypes: &str) -> Vec<(&'static str, EditOp)> {
    vec![
        // Global Index.md — Domain Indexes bullet (alphabetical).
        (
            "Infrastructure/Indexes/Index.md",
            EditOp::InsertBulletAlpha {
                heading: "## Domain Indexes".into(),
                bullet: format!("- [[Infrastructure/Indexes/{name} Index]] — {name} knowledge\n"),
                marker: format!("Indexes/{name} Index]]"),
            },
        ),
        // Infrastructure Index.md — Indexes bullet (alphabetical).
        (
            "Infrastructure/Indexes/Infrastructure Index.md",
            EditOp::InsertBulletAlpha {
                heading: "## Indexes".into(),
                bullet: format!("- [[Infrastructure/Indexes/{name} Index]] — catalog for the {name} domain\n"),
                marker: format!("Indexes/{name} Index]]"),
            },
        ),
        // Structure.md — new Knowledge/<Domain>/ contract, after the generic block.
        (
            "Infrastructure/Reference/Structure.md",
            EditOp::InsertAfterBlock {
                anchor_line: "### Knowledge/<domain>/".into(),
                block: format!(
                    "### Knowledge/{name}/\n\nPurpose: The {name} domain. Holds standard knowledge content under `YouTube Pipeline/` ({subtypes}).\nAccepts: `YouTube Pipeline/` (containing {subtypes}).\nRejects: Loose files at the domain root (→ assign to `YouTube Pipeline/<type>/`).\n"
                ),
                marker: format!("### Knowledge/{name}/\n"),
            },
        ),
        // Structure.md — first-domain Infrastructure/Domains/ contract (idempotent).
        (
            "Infrastructure/Reference/Structure.md",
            EditOp::InsertBeforeHeading {
                heading: "## Vault Ownership".into(),
                block: "### Infrastructure/Domains/\n\nPurpose: Machine-managed per-domain state written by the Iskariel Domain Builder — one `<Domain>.md` per built domain, each holding a fenced JSON `DomainConfig` block. Accepts: `<Domain>.md` state pages. Rejects: hand-authored content (re-open the builder to reconfigure).\n".into(),
                marker: "### Infrastructure/Domains/".into(),
            },
        ),
        // Frontmatter.md — add the new domain to the `Domain:` enum (the
        // normalize_frontmatter.py canonical list derives from this line).
        (
            "Infrastructure/Schemas/Frontmatter.md",
            EditOp::EnumAdd { line_contains: "`Domain`: `".into(), value: fm.to_string() },
        ),
    ]
}

/// A fresh today daily-log page (6 canonical H2 sections) seeded with the given
/// Vault Activity bullet — used only when today's page doesn't exist yet.
fn render_daily_page(ds: &str, vault_activity_bullet: &str) -> String {
    let month = ds.get(..7).unwrap_or(ds);
    format!(
        "---\nType: Daily-Log\nDate: {ds}\nMonth: {month}\n---\n\n## Focus Block\n\n## Quick Notes\n\n## Upcoming\n\n## Sessions\n\n## Plan Fence\n\n```plan\n```\n\n## Vault Activity\n\n{vault_activity_bullet}"
    )
}

/// Commit the full plan under a snapshot-and-restore journal spanning the
/// content + pulse vaults. Any failure rolls back every change.
fn do_commit(
    content: &Path,
    pulse: Option<&Path>,
    domain_root: &Path,
    created_dirs: &[String],
    new_files: &[PlannedFile],
    edits: &[EditPlan],
    reopen: bool,
) -> Result<(), DomainError> {
    let mut created_files: Vec<PathBuf> = Vec::new();
    let mut created_dir_paths: Vec<PathBuf> = Vec::new();
    let mut restored: Vec<(PathBuf, Vec<u8>)> = Vec::new();

    for rel in created_dirs {
        let abs = content.join(rel);
        let existed = abs.is_dir();
        if let Err(e) = fs::create_dir_all(&abs) {
            rollback_all(&created_files, &created_dir_paths, &restored, domain_root, reopen);
            return Err(DomainError::Io(format!("mkdir {rel}: {e}")));
        }
        if !existed {
            created_dir_paths.push(abs);
        }
    }
    for f in new_files {
        let base = match root_abs(&f.root, content, pulse) {
            Ok(b) => b,
            Err(e) => {
                rollback_all(&created_files, &created_dir_paths, &restored, domain_root, reopen);
                return Err(e);
            }
        };
        let abs = base.join(&f.path);
        if let Err(e) = atomic_write(&abs, f.content.as_bytes()) {
            rollback_all(&created_files, &created_dir_paths, &restored, domain_root, reopen);
            return Err(e.into());
        }
        created_files.push(abs);
    }
    for e in edits {
        let base = match root_abs(&e.root, content, pulse) {
            Ok(b) => b,
            Err(er) => {
                rollback_all(&created_files, &created_dir_paths, &restored, domain_root, reopen);
                return Err(er);
            }
        };
        let abs = base.join(&e.path);
        let current = fs::read_to_string(&abs).unwrap_or_default();
        let new_content = match apply_op(&current, &e.op) {
            Some(c) => c,
            None => {
                rollback_all(&created_files, &created_dir_paths, &restored, domain_root, reopen);
                return Err(DomainError::Io(format!("anchor vanished in {}", e.path)));
            }
        };
        let prior = current.into_bytes();
        if let Err(er) = atomic_write(&abs, new_content.as_bytes()) {
            rollback_all(&created_files, &created_dir_paths, &restored, domain_root, reopen);
            return Err(er.into());
        }
        restored.push((abs, prior));
    }
    Ok(())
}

// ─────────────────────────── Command ───────────────────────────
#[tauri::command]
pub fn scaffold_domain(
    app: AppHandle,
    config: serde_json::Value,
    dry_run: bool,
    reopen: bool,
) -> Result<ScaffoldPlan, DomainError> {
    let cfg: DomainConfig = serde_json::from_value(config.clone())
        .map_err(|e| DomainError::Invalid(format!("invalid DomainConfig: {e}")))?;

    validate_name(&cfg.domain_name)?;
    for c in &cfg.custom_folders {
        if c.name.contains('/') || c.name.contains('\\') || c.name.contains("..") {
            return Err(DomainError::Invalid(
                "Custom folder name has illegal path characters".into(),
            ));
        }
    }

    // Resolve the target content vault (may be non-active — the user picks it).
    let root = crate::commands::vaults::resolve_vault_path(&app, &cfg.vault_id)
        .ok_or_else(|| DomainError::Invalid(format!("No registered vault with id {}", cfg.vault_id)))?;
    let root = PathBuf::from(root);

    // One system-clock read = the audit source of truth for this scaffold.
    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let stamp = now.to_rfc3339();

    // Stamp createdAt/updatedAt into the RAW config value for the persisted page
    // (preserves every wizard field, including those the typed view ignores).
    let mut cfg_value = config;
    if let Some(obj) = cfg_value.as_object_mut() {
        let needs_created = obj
            .get("createdAt")
            .and_then(|v| v.as_str())
            .map(|s| s.is_empty())
            .unwrap_or(true);
        if needs_created {
            obj.insert("createdAt".into(), serde_json::Value::String(stamp.clone()));
        }
        obj.insert("updatedAt".into(), serde_json::Value::String(stamp.clone()));
    }
    let cfg_json = serde_json::to_string_pretty(&cfg_value)
        .map_err(|e| DomainError::Io(format!("serialize config: {e}")))?;

    let mut plan = build_plan(&cfg, &today, &cfg_json);

    let domain_root = root.join("Knowledge").join(cfg.domain_name.trim());
    // Collision guard — a FRESH scaffold never clobbers an existing domain
    // (no-git/no-undo vault). A REOPEN intentionally targets an existing domain,
    // so the guard is skipped; its writes become overwrites journaled for rollback.
    if !reopen && domain_root.exists() {
        return Err(DomainError::Collision(format!(
            "Knowledge/{} already exists",
            cfg.domain_name.trim()
        )));
    }

    // ── Close-the-loop edits (full automation: convention docs + logs) ──
    let name = cfg.domain_name.trim();
    let fm = frontmatter_of(&cfg);
    let subtypes = included_subfolders(&cfg).join(", ");
    let hhmm = now.format("%-I:%M %p").to_string();
    let pulse_root = crate::commands::vaults::pulse_vault_path().map(PathBuf::from);
    let mut edits: Vec<EditPlan> = Vec::new();

    // Only create folders that don't already exist (accurate preview; commit
    // tracks new dirs for rollback). Reclassify any planned new_file that ALREADY
    // exists into a whole-file overwrite edit — journals prior bytes for rollback
    // and shows a line diff in the preview (never a silent clobber). Fresh
    // scaffolds match nothing; reopen regenerates the sub-spec / Index / Glossary
    // / config page as visible diffs.
    plan.created_dirs.retain(|rel| !root.join(rel).is_dir());
    for f in std::mem::take(&mut plan.new_files) {
        let base = match f.root.as_str() {
            "pulse" => pulse_root.clone(),
            _ => Some(root.clone()),
        };
        let abs = base.as_ref().map(|b| b.join(&f.path));
        if abs.as_ref().map(|p| p.is_file()).unwrap_or(false) {
            let before = fs::read_to_string(abs.unwrap()).unwrap_or_default();
            edits.push(EditPlan {
                path: f.path,
                root: f.root,
                after: f.content.clone(),
                op: EditOp::ReplaceAll(f.content),
                before,
            });
        } else {
            plan.new_files.push(f);
        }
    }

    // (1) Daily-log Vault Activity bullet — in the pulse vault.
    let verb = if reopen { "Reconfigured" } else { "Created" };
    let bullet = format!(
        "- {hhmm} — {verb} the {name} knowledge domain via the Domain Builder ({} new folder(s), {} transcript pipeline).\n",
        plan.created_dirs.len(),
        cfg.transcript_mode
    );
    match pulse_root.as_deref() {
        Some(proot) => {
            let daily_rel = format!("Pulse/Daily Logs/{today}.md");
            let daily_abs = proot.join(&daily_rel);
            if daily_abs.is_file() {
                let before = fs::read_to_string(&daily_abs).unwrap_or_default();
                let op = EditOp::InsertUnderHeading {
                    heading: "## Vault Activity".into(),
                    block: bullet.clone(),
                };
                match apply_op(&before, &op) {
                    Some(after) if after != before => {
                        edits.push(EditPlan { path: daily_rel, root: "pulse".into(), op, before, after })
                    }
                    Some(_) => {}
                    None => plan
                        .warnings
                        .push("Today's daily log has no '## Vault Activity' section — bullet skipped.".into()),
                }
            } else {
                plan.new_files.push(PlannedFile {
                    path: daily_rel,
                    content: render_daily_page(&today, &bullet),
                    root: "pulse".into(),
                });
                plan.warnings
                    .push("Created today's daily page; add its Pulse Index entry manually.".into());
            }
        }
        None => plan
            .warnings
            .push("No pulse vault registered — daily-log Vault Activity bullet skipped.".into()),
    }

    // (2)–(6) Convention-doc edits (Index, Infra Index, Structure ×2,
    // Frontmatter). Anchored + idempotent; each warns+skips if its doc/anchor is
    // absent. Shared with the integration test via convention_doc_ops().
    for (rel, op) in convention_doc_ops(name, &fm, &subtypes) {
        plan_content_edit(&root, rel, op, &mut edits, &mut plan.warnings);
    }
    if root.join("Infrastructure/Reference/Structure.md").is_file() {
        plan.warnings.push(
            "Structure.md generic Knowledge block enumerates domains in prose ('Sixteen domains exist…') — update the count + list by hand.".into(),
        );
    }

    // (7) Update Queue — built last so its Files: list covers everything.
    let uq_rel = "Infrastructure/Vault State/Update Queue.md";
    if root.join(uq_rel).is_file() {
        let mut files_lines = format!(
            "  - Knowledge/{name}/ ({})\n",
            if reopen { "reconfigured domain tree" } else { "new domain tree" }
        );
        for f in &plan.new_files {
            files_lines.push_str(&format!("  - {}\n", f.path));
        }
        for e in &edits {
            files_lines.push_str(&format!("  - {} (edited)\n", e.path));
        }
        let before = fs::read_to_string(root.join(uq_rel)).unwrap_or_default();
        let tag = if reopen { "domain-reconfigure" } else { "domain-scaffold" };
        let block = format!(
            "\n- [ ] [{today} {hhmm}] {tag} — {verb} the {name} knowledge domain via the Domain Builder.\n  Files:\n{files_lines}- [ ] [{today} {hhmm}] surfaced — {name} domain {} by the app Domain Builder; confirm the generated transcript sub-spec, Domain Index, and Structure/Frontmatter edits on the next /update.\n",
            if reopen { "reconfigured" } else { "scaffolded" }
        );
        let op = EditOp::AppendEof(block);
        if let Some(after) = apply_op(&before, &op) {
            edits.push(EditPlan { path: uq_rel.into(), root: "content".into(), op, before, after });
        }
    } else {
        plan.warnings
            .push(format!("{uq_rel} not found in target vault — Update Queue entry skipped."));
    }

    // Mirror the edits onto the wire plan for the preview diff.
    plan.edits = edits
        .iter()
        .map(|e| PlannedEdit {
            path: e.path.clone(),
            root: e.root.clone(),
            before: e.before.clone(),
            after: e.after.clone(),
            anchor_desc: match &e.op {
                EditOp::AppendEof(_) => "append at end of file".into(),
                EditOp::InsertUnderHeading { heading, .. } => format!("insert under {heading}"),
                EditOp::InsertBulletAlpha { heading, .. } => format!("alphabetical bullet under {heading}"),
                EditOp::InsertAfterBlock { anchor_line, .. } => format!("contract after {anchor_line}"),
                EditOp::InsertBeforeHeading { heading, .. } => format!("block before {heading}"),
                EditOp::EnumAdd { .. } => "add to Domain enum".into(),
                EditOp::ReplaceAll(_) => "overwrite file (regenerate)".into(),
            },
        })
        .collect();

    if dry_run {
        return Ok(plan);
    }

    // Commit everything under a snapshot-and-restore journal.
    do_commit(
        &root,
        pulse_root.as_deref(),
        &domain_root,
        &plan.created_dirs,
        &plan.new_files,
        &edits,
        reopen,
    )?;

    plan.committed = true;
    Ok(plan)
}

/// Extract the first fenced ```json … ``` block's inner text, if present.
fn extract_json_block(text: &str) -> Option<String> {
    let start = text.find("```json")?;
    let after = &text[start..];
    let nl = after.find('\n')? + 1; // skip the opening ```json line
    let body = &after[nl..];
    let end = body.find("```")?;
    Some(body[..end].to_string())
}

/// Read a persisted DomainConfig back from `Infrastructure/Domains/<Domain>.md`
/// (the fenced JSON block) so the wizard can reopen + reconfigure it. Returns
/// null when the page or its JSON block is absent (e.g. a hand-created domain
/// folder with no builder state).
#[tauri::command]
pub fn read_domain_config(
    app: AppHandle,
    vault_id: String,
    domain_name: String,
) -> Result<Option<serde_json::Value>, DomainError> {
    let root = crate::commands::vaults::resolve_vault_path(&app, &vault_id)
        .ok_or_else(|| DomainError::Invalid(format!("No registered vault with id {vault_id}")))?;
    let path = PathBuf::from(root)
        .join("Infrastructure/Domains")
        .join(format!("{}.md", domain_name.trim()));
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| DomainError::Io(format!("read {}: {e}", path.display())))?;
    match extract_json_block(&text) {
        Some(j) => serde_json::from_str(&j)
            .map(Some)
            .map_err(|e| DomainError::Invalid(format!("config JSON parse: {e}"))),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_appends_at_end_of_section() {
        let doc = "---\nx: y\n---\n\n## Sessions\n\n- a\n\n## Vault Activity\n\n- 9:00 AM — old\n";
        let out = insert_under_heading(doc, "## Vault Activity", "- 10:00 AM — new\n").unwrap();
        assert!(out.contains("- 9:00 AM — old\n- 10:00 AM — new\n"), "got:\n{out}");
        assert!(out.contains("## Sessions\n\n- a"));
    }

    #[test]
    fn insert_lands_before_next_h2() {
        let doc = "## Vault Activity\n\n- a\n\n## Next\n\n- b\n";
        let out = insert_under_heading(doc, "## Vault Activity", "- c\n").unwrap();
        let c = out.find("- c").unwrap();
        let nx = out.find("## Next").unwrap();
        assert!(c < nx, "bullet must precede next heading:\n{out}");
        assert!(out.contains("- c\n\n## Next"), "blank line before heading preserved:\n{out}");
    }

    #[test]
    fn missing_heading_returns_none() {
        assert!(insert_under_heading("## Foo\n", "## Vault Activity", "- x\n").is_none());
    }

    #[test]
    fn append_eof_adds_block() {
        let out = apply_op("line\n", &EditOp::AppendEof("\n- entry\n".into())).unwrap();
        assert!(out.starts_with("line\n"));
        assert!(out.trim_end().ends_with("- entry"));
    }

    #[test]
    fn enum_add_inserts_alphabetically_and_is_idempotent() {
        let doc = "`Domain`: `Anatomy | Books | Music`\n";
        let out = enum_add(doc, "`Domain`: `", "Chess").unwrap();
        assert_eq!(out, "`Domain`: `Anatomy | Books | Chess | Music`\n");
        assert_eq!(enum_add(&out, "`Domain`: `", "Chess").unwrap(), out);
    }

    #[test]
    fn bullet_alpha_inserts_in_order_and_is_idempotent() {
        let doc = "## Domain Indexes\n\n- [[Infrastructure/Indexes/Anime Index]] — a\n- [[Infrastructure/Indexes/Chess Index]] — c\n";
        let bullet = "- [[Infrastructure/Indexes/Books Index]] — b\n";
        let marker = "Indexes/Books Index]]";
        let out = insert_bullet_alpha(doc, "## Domain Indexes", bullet, marker).unwrap();
        let (a, b, c) = (
            out.find("Anime").unwrap(),
            out.find("Books").unwrap(),
            out.find("Chess").unwrap(),
        );
        assert!(a < b && b < c, "got:\n{out}");
        assert_eq!(insert_bullet_alpha(&out, "## Domain Indexes", bullet, marker).unwrap(), out);
    }

    #[test]
    fn after_block_lands_between_anchor_and_next() {
        let doc = "## Contracts\n\n### Knowledge/<domain>/\n\nPurpose: generic.\n\n### Knowledge/Music/\n\nPurpose: music.\n";
        let out = insert_after_block(
            doc,
            "### Knowledge/<domain>/",
            "### Knowledge/Brewing/\n\nPurpose: brewing.\n",
            "### Knowledge/Brewing/\n",
        )
        .unwrap();
        let g = out.find("### Knowledge/<domain>/").unwrap();
        let brew = out.find("### Knowledge/Brewing/").unwrap();
        let m = out.find("### Knowledge/Music/").unwrap();
        assert!(g < brew && brew < m, "Brewing must land between generic and Music:\n{out}");
    }

    #[test]
    fn before_heading_inserts_block() {
        let doc = "## Contracts\n\n### X/\n\nPurpose: x.\n\n## Vault Ownership\n\ntext\n";
        let out = insert_before_heading(
            doc,
            "## Vault Ownership",
            "### Infrastructure/Domains/\n\nPurpose: state.\n",
            "### Infrastructure/Domains/",
        )
        .unwrap();
        assert!(
            out.find("### Infrastructure/Domains/").unwrap() < out.find("## Vault Ownership").unwrap(),
            "Domains contract precedes Vault Ownership:\n{out}"
        );
    }

    // SF4 integration: the REAL convention_doc_ops (the exact anchors/ops
    // scaffold_domain uses) resolve against realistic Citadel-shaped docs. The
    // Gaming E2E ran in a vault with none of these docs, so this is the proof
    // the full-automation edits actually land.
    #[test]
    fn convention_doc_ops_resolve_against_realistic_docs() {
        let index = "---\nType: Infrastructure\n---\n\n## Domain Indexes\n\n- [[Infrastructure/Indexes/Anime Index]] — Anime knowledge\n- [[Infrastructure/Indexes/Zoology Index]] — Zoology knowledge\n\n## Other\n";
        let infra = "---\nType: Infrastructure\n---\n\n## Indexes\n\n- [[Infrastructure/Indexes/Anime Index]] — catalog for the Anime domain\n\n## Schemas\n";
        let structure_src = "## Directory Contracts\n\n### Knowledge/<domain>/\n\nPurpose: generic per-domain contract.\n\n### Knowledge/Anime/\n\nPurpose: the anime domain.\n\n## Vault Ownership\n\nOwners list.\n";
        let frontmatter = "## Casing\n\n- `Domain`: `Anatomy | Anime | Zoology` — Title-Case-hyphenated, enforced enum.\n";

        let ops = convention_doc_ops("Gaming", "Gaming", "Transcripts, Raw, Concepts, Entities, Assets");
        assert_eq!(ops.len(), 5, "five convention-doc edits");

        // Apply each op against its fixture; Structure.md carries two ops so chain it.
        let mut idx_out = String::new();
        let mut infra_out = String::new();
        let mut fm_out = String::new();
        let mut structure = structure_src.to_string();
        for (rel, op) in &ops {
            match *rel {
                "Infrastructure/Indexes/Index.md" => {
                    idx_out = apply_op(index, op).unwrap_or_else(|| panic!("anchor not found in {rel}"));
                    assert_ne!(idx_out, index, "Index.md: op produced no change");
                }
                "Infrastructure/Indexes/Infrastructure Index.md" => {
                    infra_out = apply_op(infra, op).unwrap_or_else(|| panic!("anchor not found in {rel}"));
                    assert_ne!(infra_out, infra, "Infra Index: op produced no change");
                }
                "Infrastructure/Reference/Structure.md" => {
                    let after = apply_op(&structure, op).unwrap_or_else(|| panic!("anchor not found in {rel}"));
                    assert_ne!(after, structure, "Structure.md: op produced no change");
                    structure = after;
                }
                "Infrastructure/Schemas/Frontmatter.md" => {
                    fm_out = apply_op(frontmatter, op).unwrap_or_else(|| panic!("anchor not found in {rel}"));
                    assert_ne!(fm_out, frontmatter, "Frontmatter.md: op produced no change");
                }
                o => panic!("unexpected convention doc: {o}"),
            }
        }

        // Index.md — Gaming bullet inserted alphabetically (Anime < Gaming < Zoology).
        assert!(idx_out.contains("[[Infrastructure/Indexes/Gaming Index]] — Gaming knowledge"));
        let (a, g, z) = (idx_out.find("Anime Index]]").unwrap(), idx_out.find("Gaming Index]]").unwrap(), idx_out.find("Zoology Index]]").unwrap());
        assert!(a < g && g < z, "Gaming must sort between Anime and Zoology:\n{idx_out}");

        // Infrastructure Index.md — catalog bullet present.
        assert!(infra_out.contains("[[Infrastructure/Indexes/Gaming Index]] — catalog for the Gaming domain"));

        // Structure.md — both contracts landed at the right anchors.
        let generic = structure.find("### Knowledge/<domain>/").unwrap();
        let gaming = structure.find("### Knowledge/Gaming/").expect("domain contract present");
        let anime = structure.find("### Knowledge/Anime/").unwrap();
        let domains = structure.find("### Infrastructure/Domains/").expect("Domains contract present");
        let ownership = structure.find("## Vault Ownership").unwrap();
        assert!(generic < gaming && gaming < anime, "Gaming contract between generic block and Anime:\n{structure}");
        assert!(domains < ownership, "Domains contract precedes Vault Ownership:\n{structure}");

        // Frontmatter.md — Gaming added to the enum alphabetically, enum intact.
        assert!(fm_out.contains("`Domain`: `Anatomy | Anime | Gaming | Zoology`"), "enum updated:\n{fm_out}");

        // Idempotent: re-running every op against its edited content is a no-op.
        for (rel, op) in &ops {
            let edited = match *rel {
                "Infrastructure/Indexes/Index.md" => &idx_out,
                "Infrastructure/Indexes/Infrastructure Index.md" => &infra_out,
                "Infrastructure/Reference/Structure.md" => &structure,
                "Infrastructure/Schemas/Frontmatter.md" => &fm_out,
                o => panic!("unexpected: {o}"),
            };
            assert_eq!(apply_op(edited, op).as_deref(), Some(edited.as_str()), "{rel}: op not idempotent");
        }
    }

    #[test]
    fn extract_json_block_pulls_fenced_config() {
        let page = "---\nType: Infrastructure\n---\n\nPreamble.\n\n```json\n{\n  \"domainName\": \"Gaming\"\n}\n```\n";
        let j = extract_json_block(page).unwrap();
        let v: serde_json::Value = serde_json::from_str(&j).unwrap();
        assert_eq!(v["domainName"], "Gaming");
        assert!(extract_json_block("no fenced block here").is_none());
    }

    // SF7 safety: a reopen commit overwrites existing files (journaling prior
    // bytes) and, when a later edit fails, restores them WITHOUT nuking the
    // existing domain tree (the no-undo guarantee for reconfigure).
    #[test]
    fn reopen_commit_overwrites_then_rolls_back_safely() {
        let base = std::env::temp_dir().join(format!("agentic_domain_reopen_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let tdir = base.join("Knowledge/Gaming/YouTube Pipeline/Transcripts");
        fs::create_dir_all(&tdir).unwrap();
        fs::create_dir_all(base.join("Infrastructure/Domains")).unwrap();
        let cfg_file = base.join("Infrastructure/Domains/Gaming.md");
        let keep_file = tdir.join("keep.md");
        fs::write(&cfg_file, "OLD CONFIG\n").unwrap();
        fs::write(&keep_file, "user content\n").unwrap();
        let domain_root = base.join("Knowledge/Gaming");

        // Happy path: overwrite the config page + add a new folder & file.
        let new_files = vec![PlannedFile {
            path: "Knowledge/Gaming/YouTube Pipeline/Concepts/seed.md".into(),
            content: "new\n".into(),
            root: "content".into(),
        }];
        let edits_ok = vec![EditPlan {
            path: "Infrastructure/Domains/Gaming.md".into(),
            root: "content".into(),
            op: EditOp::ReplaceAll("NEW CONFIG\n".into()),
            before: "OLD CONFIG\n".into(),
            after: "NEW CONFIG\n".into(),
        }];
        do_commit(&base, None, &domain_root,
            &["Knowledge/Gaming/YouTube Pipeline/Concepts".to_string()], &new_files, &edits_ok, true).unwrap();
        assert_eq!(fs::read_to_string(&cfg_file).unwrap(), "NEW CONFIG\n", "config overwritten");
        assert!(base.join("Knowledge/Gaming/YouTube Pipeline/Concepts/seed.md").is_file(), "new file created");
        assert_eq!(fs::read_to_string(&keep_file).unwrap(), "user content\n", "user file untouched");

        // Rollback path: a doomed edit (missing anchor) must abort + restore.
        fs::write(&cfg_file, "PRIOR\n").unwrap();
        let new_files2 = vec![PlannedFile {
            path: "Knowledge/Gaming/YouTube Pipeline/Assets/a.md".into(),
            content: "x\n".into(),
            root: "content".into(),
        }];
        let edits_bad = vec![
            EditPlan {
                path: "Infrastructure/Domains/Gaming.md".into(),
                root: "content".into(),
                op: EditOp::ReplaceAll("SHOULD ROLL BACK\n".into()),
                before: "PRIOR\n".into(),
                after: "SHOULD ROLL BACK\n".into(),
            },
            EditPlan {
                path: "Infrastructure/Domains/Gaming.md".into(),
                root: "content".into(),
                op: EditOp::InsertUnderHeading { heading: "## Nope".into(), block: "z\n".into() },
                before: String::new(),
                after: String::new(),
            },
        ];
        let res = do_commit(&base, None, &domain_root,
            &["Knowledge/Gaming/YouTube Pipeline/Assets".to_string()], &new_files2, &edits_bad, true);
        assert!(res.is_err(), "doomed edit must fail the commit");
        assert_eq!(fs::read_to_string(&cfg_file).unwrap(), "PRIOR\n", "config restored on rollback");
        assert!(!base.join("Knowledge/Gaming/YouTube Pipeline/Assets/a.md").exists(), "new file removed");
        assert!(!base.join("Knowledge/Gaming/YouTube Pipeline/Assets").exists(), "new dir removed");
        assert!(domain_root.is_dir(), "existing domain tree survived rollback");
        assert_eq!(fs::read_to_string(&keep_file).unwrap(), "user content\n", "user file survived rollback");

        let _ = fs::remove_dir_all(&base);
    }
}
