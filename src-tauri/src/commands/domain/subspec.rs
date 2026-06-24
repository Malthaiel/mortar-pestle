//! `/transcript <slug>` sub-spec generator.
//!
//! `render_subspec` emits a `transcript-<slug>.md` whose structure is matched
//! key-for-key to the hand-authored canonical specs
//! (`Infrastructure/Skills/Transcripts/transcript-yt-study.md` and
//! `transcript-yt-deadlock.md`) so the app-generated and hand-authored specs
//! never drift. Dropping the file into `Infrastructure/Skills/Transcripts/`
//! auto-registers the slug with the `/transcript` dispatcher (it globs
//! `transcript-*.md`), so no dispatcher edit is needed.
//!
//! Two modes: `timestamped` (clickable `[HH:MM]` seek links, the current
//! behaviour) and `summary` (NEW — flowing prose, no timestamps). Both run the
//! optional Glossary auto-correction pass. Extraction toggles, the entity
//! taxonomy (frontmatter value + promote-to-folder), and the bold/wikilink
//! rules all flow into the generated text.

use super::DomainConfig;

/// First-mention bolding clause built from the wizard's bold rules (falls back
/// to the generic study-domain phrasing).
fn bold_include(cfg: &DomainConfig) -> String {
    if cfg.bold_rules.include.is_empty() {
        "every entity, concept, and significant proper noun".to_string()
    } else {
        cfg.bold_rules.include.join(", ")
    }
}

fn bold_exclude(cfg: &DomainConfig) -> String {
    if cfg.bold_rules.exclude.is_empty() {
        "pronouns, common verbs, or generic adjectives".to_string()
    } else {
        cfg.bold_rules.exclude.join(", ")
    }
}

/// The `Entity Type:` enum line for the Phase 6 sub-agent template.
fn entity_type_enum(cfg: &DomainConfig) -> String {
    let names: Vec<&str> = cfg
        .entity_taxonomy
        .types
        .iter()
        .map(|t| t.name.trim())
        .filter(|n| !n.is_empty())
        .collect();
    if names.is_empty() {
        "Person|Place|Organization|Software|Product|Tool|Other".to_string()
    } else {
        names.join("|")
    }
}

pub(super) fn render_subspec(cfg: &DomainConfig, today: &str) -> String {
    let name = cfg.domain_name.trim();
    let fm = super::frontmatter_of(cfg);
    let slug = super::transcript_slug(cfg);
    let base = format!("Knowledge/{name}/YouTube Pipeline");
    let summary = cfg.transcript_mode == "summary";
    let glossary = cfg.glossary.wire_auto_correction;
    // A page type is emitted only when BOTH its extraction toggle is on AND its
    // folder is included. Folder off ⇒ no phase even if extraction stayed on,
    // else the spec would write to a folder the user opted out of (it'd be
    // silently recreated on first run). Also defends a hand-edited reopen config.
    let f = &cfg.pipeline.folders;
    let entities = cfg.extraction.entities && f.entities;
    let concepts = cfg.extraction.concepts && f.concepts;
    let topics = cfg.extraction.topics && f.topics;
    let any_pages = entities || concepts || topics;
    let inc = bold_include(cfg);
    let exc = bold_exclude(cfg);

    let mut s = String::new();

    // ───────── Frontmatter ─────────
    let desc = if summary {
        format!(
            "One-shot {name} YouTube summary ingest (no timestamps). Fetches the transcript and writes a flowing prose summary to {base}/Transcripts/ with bold+wikilinked terms on first mention{}. {}Raw/ is deleted at the end.",
            if any_pages { " linking extracted Entity/Concept/Topic pages" } else { "" },
            if glossary { format!("Auto-corrects transcription via the {name} Glossary. ") } else { String::new() },
        )
    } else {
        format!(
            "One-shot {name} YouTube transcript ingest. Fetches the transcript and writes a timestamped narrative to {base}/Transcripts/ with verbatim quotes + clickable YouTube timestamps{}. {}Raw/ is deleted at the end; Source URL is the audit trail.",
            if any_pages { " + inline wikilinks to extracted Entity/Concept/Topic pages" } else { "" },
            if glossary { format!("Auto-corrects transcription via the {name} Glossary. ") } else { String::new() },
        )
    };
    s.push_str(&format!(
        "---\nType: Infrastructure\nFeature Kind: skill\nAdded: {today}\nUpdated: {today}\nStatus: Active\nCommand: /transcript {slug}\nSkill File: ~/.claude/skills/transcript/SKILL.md\nDestructive: true\nArguments:\n  - Name: url\n    type: url\n    required: true\n    description: YouTube video URL\nDescription: {desc}\n---\n"
    ));

    // ───────── Purpose ─────────
    let read_mode = if summary {
        "The user reads the summary as a standalone narrative; no video-watching is required."
    } else {
        "The user reads the Transcript while watching the video; quotes anchor the read, timestamps drive seeking."
    };
    let pages_clause = if any_pages {
        " Extracted Entity, Concept, and Topic pages point their `Sources:` arrays back at it."
    } else {
        ""
    };
    s.push_str(&format!(
        "## Purpose\n\nFetch a {name} YouTube video transcript and write the canonical artifact at `{base}/Transcripts/<Source Title>.md`.{pages_clause} {read_mode}\n\nThis is a one-shot pipeline: a single invocation does fetch + clean + {}write + {}log. There is one user-facing gate (post-transcribe quality confirmation).\n\n",
        if glossary { "correct + " } else { "" },
        if any_pages { "extract + page creation + wikilink injection + " } else { "" },
    ));

    // ───────── Location ─────────
    s.push_str("## Location\n\n");
    s.push_str("- Skill runtime spec: `~/.claude/skills/transcript/SKILL.md`\n");
    s.push_str(&format!("- Vault manual (this file): `Infrastructure/Skills/Transcripts/transcript-{slug}.md`\n"));
    s.push_str(&format!("- Transcript output: `{base}/Transcripts/`\n"));
    if entities {
        s.push_str(&format!("- Entity output: `{base}/Entities/`\n"));
    }
    if concepts {
        s.push_str(&format!("- Concept output: `{base}/Concepts/`\n"));
    }
    if topics {
        s.push_str(&format!("- Topic output: `{base}/Topics/`\n"));
    }
    // Promoted entity-type folders get their own output line (entities only).
    if entities {
        for t in &cfg.entity_taxonomy.types {
            let tn = t.name.trim();
            if t.promote && !tn.is_empty() {
                s.push_str(&format!("- {tn} output: `{base}/{tn}/` (promoted entity type)\n"));
            }
        }
    }
    s.push_str(&format!("- Raw (transient): `{base}/Raw/<Source Title>.md` — deleted at end of run\n"));
    s.push_str("- Temporary working directory: `/tmp/ingest-vtt/`\n");
    if glossary {
        s.push_str(&format!("- {name} Glossary (auto-correction lookup): `Infrastructure/Glossaries/{name} Glossary.md`\n"));
    }
    s.push('\n');

    // ───────── Dependencies ─────────
    s.push_str("## Dependencies\n\n");
    s.push_str("- **yt-dlp** — YouTube transcript fetcher. Must be installed and on `$PATH`.\n");
    s.push_str("- **Python 3** — Required for the VTT cleaner executed in Phase 1.\n");
    if glossary {
        s.push_str(&format!("- **{name} Glossary** — for transcription corrections.\n"));
    }
    s.push('\n');

    // ───────── Commands ─────────
    s.push_str("## Commands\n\nAll shell commands are executed during Phase 1.\n\nFetch auto-subtitles:\n```bash\nmkdir -p /tmp/ingest-vtt\nyt-dlp --skip-download --write-auto-subs --sub-lang en --convert-subs vtt \\\n  -o \"/tmp/ingest-vtt/%(id)s.%(ext)s\" \\\n  \"<url>\"\n```\n\nDuration:\n```bash\nDURATION=$(yt-dlp --print \"%(duration_string)s\" --skip-download \"<url>\")\n```\n\nDuplicate check (run before fetch):\n```bash\ngrep -rli \"Source URL: <FULL_URL>\" Knowledge/ 2>/dev/null\n```\n\n");

    // ───────── Troubleshooting ─────────
    s.push_str("## Troubleshooting\n\n- **No auto-subtitles available.** yt-dlp returns `WARNING: Unable to download video subtitles`. Stop and report.\n- **Duplicate URL detected.** Phase 0 surfaces the existing Transcript with Cancel/Replace/Skip.\n- **Non-YouTube URL.** Hard refuse with a one-line refusal.\n- **Long-Video annotation timeout.** Note in the final report. After 2 such runs, strip annotation permanently from Long-Video Mode.\n\n");

    // ───────── Execution Order ─────────
    let mut steps: Vec<String> = vec![
        "Phase 0 — Source resolution + duplicate gate".into(),
        "Phase 1 — Transcript fetch and clean + mode detection".into(),
    ];
    if glossary {
        steps.push(format!("Phase 1.2 — Transcription correction ({name} Glossary)"));
    }
    if summary {
        steps.push("Standard: Phase 2 — Thematic identification".into());
        steps.push("Standard: Phase 3 — Write the prose summary (no timestamps)".into());
    } else {
        steps.push("Standard: Phase 2 — Topic identification (first-mention rule)".into());
        steps.push("Standard: Phase 3 — Write the timestamped narrative with **bold** placeholders".into());
    }
    steps.push("Phase 4 — Post-transcribe quality rating & commit gate".into());
    if topics {
        steps.push("Phase 5 — Topic page (create or update)".into());
    }
    if entities || concepts {
        steps.push("Phase 6 — Sub-agent fan-out: Entity + Concept pages".into());
    }
    if any_pages {
        steps.push("Phase 7 — Rewrite body: replace `**Name**` with `[[full-path|Name]]`".into());
    }
    steps.push("Phase 8 — Delete Raw file".into());
    steps.push("Phase 9 — Update `Indexes/Index.md`, append Update Queue + daily Vault Activity bullet".into());
    steps.push("Phase 10 — Report back".into());

    s.push_str("## Execution Order\n\nAll runs execute Phases 0–1 and 4–10. Middle phases depend on duration:\n\n");
    s.push_str("**Long-Video Mode (> 30 minutes):** Phase 1 mode detection activates the chunked + annotation workflow, which replaces Phases 2–3.\n\n");
    s.push_str("**Standard Mode (<= 30 minutes):** Phases 2–3 execute as defined below.\n\n");
    for (i, step) in steps.iter().enumerate() {
        s.push_str(&format!("{}. {step}\n", i + 1));
    }
    s.push('\n');

    // ───────── Domain Routing ─────────
    s.push_str(&format!(
        "## Domain Routing\n\nHard-coded `{name}`. The folder is `{name}/YouTube Pipeline/`. Frontmatter `Domain: {fm}` (canonical Title-Case-hyphenated per Frontmatter.md).\n\n"
    ));

    // ───────── Phase 0 ─────────
    s.push_str("## Phase 0: Source Resolution + Duplicate Gate\n\n");
    s.push_str(&format!("Detect the input shape (single URL, or a URL pasted in chat — confirm intent if pasted without `/transcript {slug}`). Extract the video ID. Reject non-YouTube URLs with a one-line refusal.\n\n"));
    s.push_str("### Duplicate Check + Re-Ingest Gate\n\n```bash\ngrep -rli \"Source URL: <FULL_URL>\" Knowledge/ 2>/dev/null\n```\n\nOn a match, call `AskUserQuestion`:\n- `header`: \"Existing Transcript\"\n- `options`:\n  - \"Cancel\" — abort, no changes\n  - \"Replace\" — delete the existing Transcript + every Entity/Concept/Topic page whose `Sources:` array contains ONLY this Transcript (count == 1 and matches); for multi-Source pages, remove this Transcript from the array. Then proceed as a fresh ingest.\n  - \"Skip\" — exit silently\n\nOn no match, proceed to Phase 1.\n\n");

    // ───────── Phase 1 ─────────
    s.push_str(&format!("## Phase 1: Transcript Fetch and Clean\n\n### Fetch\n\n```bash\nmkdir -p /tmp/ingest-vtt\nyt-dlp --skip-download --write-auto-subs --sub-lang en --convert-subs vtt \\\n  -o \"/tmp/ingest-vtt/%(id)s.%(ext)s\" \\\n  \"<url>\"\n```\n\nIf yt-dlp returns `WARNING: Unable to download video subtitles`, stop and report.\n\n### Duration\n\n```bash\nDURATION=$(yt-dlp --print \"%(duration_string)s\" --skip-download \"<url>\")\n```\n\n### Mode Detection\n\n- **Duration > 30 minutes** → Long-Video Mode (replaces Phases 2–3)\n- **Duration <= 30 minutes OR parse fails** → Standard Mode\n\n### Clean (Exact-Second Precision)\n\nRun the Python VTT cleaner. Output line shape:\n\n```\n[12:34 | t=754] He says the model performs better when the context is clean.\n```\n\n`t=754` is the integer copy-paste source for `&t=754` in YouTube URLs.\n\nWrite the cleaned transcript to `{base}/Raw/<Source Title>.md` (deleted in Phase 8) with header:\n\n```\nCleaned transcript for [[{base}/Transcripts/<Source Title>]]. Source: <url>. Each line is one cue with [HH:MM | t=SECONDS] prefix.\n```\n\nDelete the original `.vtt` from `/tmp/ingest-vtt/`.\n\n"));

    // ───────── Phase 1.2 (glossary) ─────────
    if glossary {
        s.push_str(&format!("## Phase 1.2: Transcription Correction\n\nScan the cleaned transcript against the {name} Glossary (`Infrastructure/Glossaries/{name} Glossary.md`). Each row lists a **Canonical Display Name**, its **Vault Filename**, and **Known Misspellings**. For every known misspelling found (case-insensitive), replace it with the Canonical Display Name. Apply longest-canonical-first to avoid partial matches. Use the Vault Filename column when injecting wikilinks in Phase 7. Runs in both timestamped and summary modes, before Phase 2.\n\n"));
    }

    // ───────── Phase 2 + 3 (mode-specific) ─────────
    if summary {
        s.push_str("## Phase 2: Thematic Identification (Standard Mode)\n\nRead the cleaned transcript end-to-end. Identify the major thematic sections — NOT first-mention timestamps. Group the content into a handful of coherent themes that tell the video's through-line.\n\n");
        if topics {
            s.push_str(&format!("Surface in chat (auto-routing — proposes the Topic from `{base}/Topics/`; proceeds unless the user objects in the same turn):\n\n- **Topic** — must match an existing Topic page or be a new proposal (Phase 5 handles create).\n- **3–7 bullets**: factual claims worth remembering; creator opinions; tensions with existing Knowledge.\n\n"));
        }
        s.push_str(&format!("## Phase 3: Write the Summary (Standard Mode)\n\nPath: `{base}/Transcripts/<Source Title>.md`\n\n### Frontmatter\n\n```yaml\n---\nType: Transcript\nDomain: {fm}\nTopic: <kebab-case-topic>\nCreated: YYYY-MM-DD\nUpdated: YYYY-MM-DD\nSource URL: https://www.youtube.com/watch?v=VIDEO_ID\nSource Type: Video\nDuration: H:MM:SS\nTranscribed: YYYY-MM-DD\nCreator: <creator name if known>\nChannel: <channel name if known>\n---\n```\n\n(Frontmatter is identical to timestamped mode so downstream `Sources:` arrays are unaffected.)\n\n### Body Structure — Summary (no timestamps)\n\n- **No H1.** Filename renders as title.\n- **`## Executive Summary`** — a 2–4 sentence prose summary of the video's thesis. **Bold** {inc} on first mention.\n- **Thematic `## ` sections** — one per theme from Phase 2, written as flowing prose. No `[HH:MM]` links, no `&t=SECONDS` seek anchors, no per-cue blockquotes (prose may paraphrase; grounding discipline still applies).\n- **Inline bold** — wrap the first occurrence of {inc} in `**bold**`. Do NOT bold {exc}.{}\n- **`## Creator Opinions`** — required. Subjective takes only; `_None._` if none.\n"
            , if any_pages { " Bolded terms become wikilinks in Phase 7." } else { "" }));
        if glossary {
            s.push_str("- **`## Transcription Corrections`** — required. List every term auto-corrected in Phase 1.2 as `Original: <misheard> → Canonical: <correct>`. `_None._` if none.\n");
        }
        s.push_str("- **`## Related`** — wikilinks added in Phase 7.\n\n### Grounding Discipline\n\nEvery factual claim must be traceable to a cue in the cleaned transcript. No fabrication.\n\n");
    } else {
        s.push_str("## Phase 2: Topic Identification (Standard Mode)\n\nRead the cleaned transcript end-to-end. Identify the major topics.\n\n**First-mention rule (non-negotiable):** Each topic's timestamp is the first cue where the topic is introduced, not where it's best explained.\n\nDensity target: roughly one topic per 60–120 seconds.\n\n");
        if topics {
            s.push_str(&format!("Surface in chat (auto-routing — proposes the Topic from `{base}/Topics/`; proceeds unless the user objects in the same turn):\n\n- **Topic** — must match an existing Topic page or be a new proposal (Phase 5 handles create).\n- **3–7 bullets**: factual claims worth remembering; creator opinions; tensions with existing Knowledge.\n\n"));
        }
        s.push_str(&format!("## Phase 3: Write the Transcript Narrative (Standard Mode)\n\nPath: `{base}/Transcripts/<Source Title>.md`\n\n### Frontmatter\n\n```yaml\n---\nType: Transcript\nDomain: {fm}\nTopic: <kebab-case-topic>\nCreated: YYYY-MM-DD\nUpdated: YYYY-MM-DD\nSource URL: https://www.youtube.com/watch?v=VIDEO_ID\nSource Type: Video\nDuration: H:MM:SS\nTranscribed: YYYY-MM-DD\nCreator: <creator name if known>\nChannel: <channel name if known>\n---\n```\n\n### Body Structure\n\n- **No H1.** Filename renders as title.\n- **Opening paragraph** — 1–3 sentence executive summary of the video's thesis. **Bold** {inc} on first mention.\n- **Section headings** — `## Topic Name` per topic identified in Phase 2.\n- **Timestamp link directly under each heading**: `[HH:MM — Section Title](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS)`\n- **Verbatim blockquotes** — `> \"quote\"` grounded in the cleaned transcript. No attribution suffix.\n- **Subtopic headings** — `### Subtopic` get their own first-mention timestamp link.\n- **Inline bold** — wrap the first occurrence of {inc} in `**bold**`. Do NOT bold {exc}.{}\n- **`## Creator Opinions`** — required. Subjective takes only; `_None._` if none.\n"
            , if any_pages { " Bolded terms must be candidates for Knowledge pages (Phase 6 creates them)." } else { "" }));
        if glossary {
            s.push_str("- **`## Transcription Corrections`** — required. List every term auto-corrected in Phase 1.2 as `Original: <misheard> → Canonical: <correct>`. `_None._` if none.\n");
        }
        s.push_str("- **`## Related`** — wikilink to the Topic page (Phase 5). Other wikilinks added in Phase 7.\n\n### Grounding Discipline\n\nEvery factual claim in the body must be traceable to at least one cue in the cleaned transcript. No fabrication.\n\n");
    }

    // ───────── Long-Video Mode ─────────
    let exclude_sections = if glossary {
        "`## Creator Opinions`, `## Transcription Corrections`, `## Related`"
    } else {
        "`## Creator Opinions`, `## Related`"
    };
    s.push_str("## Long-Video Mode (> 30 Minutes)\n\nActivated automatically from Phase 1 mode detection. Apply the chunked + annotation workflow documented in [[Infrastructure/Manuals/Long-Video Transcription]]. Phases 0–1");
    if glossary {
        s.push_str(".2");
    }
    s.push_str(&format!(" and 4–10 of this sub-spec run unchanged.\n\nWhen invoking the manual, pass:\n\n- Bolding rules: **{inc}** on first mention. Do NOT bold {exc}.\n- Required body sections to exclude from density count: {exclude_sections}.\n"));
    if summary {
        s.push_str("- Summary mode: chunk thematically and write prose per theme; do NOT emit `[HH:MM]` links or per-cue blockquotes.\n");
    }
    s.push('\n');

    // ───────── Phase 4 ─────────
    let relevance = format!("{name} Relevance");
    s.push_str(&format!("## Phase 4: Post-Transcribe Quality Gate\n\nRead the full assembled Transcript. Produce a confirmed quality rating:\n\n```\nPost-Transcript Quality Rating\nOverall: <grade>\n- Sales-Pitch Density: <grade>\n- Actionable Insight Density: <grade>\n- {relevance}: <grade>\n- Production Quality: <grade>\n```\n\nGrade scale: F-, F, F+, D-, D, D+, C-, C, C+, B-, B, B+, A-, A, A+, S, S+.\n\nImmediately call `AskUserQuestion`:\n- `header`: \"Commit ingest?\"\n- `options`:\n  - \"Yes — proceed with full ingest\"\n  - \"No — abort and discard transcript\"\n\nIf **No**: delete the Transcript + Raw files; capture a timestamp via `! date`, then append a `## Vault Activity` bullet to today's daily log noting the rejection + rating; stop.\n\nIf **Yes**: continue.\n\n"));

    // ───────── Phase 5 (Topic page) ─────────
    if topics {
        s.push_str(&format!("## Phase 5: Topic Page (Create or Update)\n\nPath: `{base}/Topics/<Topic>.md`\n\n**If missing**, create:\n\n```yaml\n---\nType: Topic\nDomain: {fm}\nTopic Kind: Thread\nStatus: Active\nSources:\n  - \"[[{base}/Transcripts/<Source Title>]]\"\nCreated: YYYY-MM-DD\nLast Revision Date: YYYY-MM-DD\n---\n```\n\nBody: 1–2 sentence topic statement. `## Related` is back-filled in Phase 6.\n\n**If exists**, append this Transcript's wikilink to `Sources:` and bump `Last Revision Date`.\n\n"));
    }

    // ───────── Phase 6 (Entity + Concept fan-out) ─────────
    if entities || concepts {
        let classify = match (entities, concepts) {
            (true, true) => "Classify each as **Entity** or **Concept**.",
            (true, false) => "Treat each as an **Entity**.",
            (false, true) => "Treat each as a **Concept**.",
            (false, false) => "",
        };
        s.push_str(&format!("## Phase 6: Sub-Agent Fan-out — Entity + Concept Pages\n\nRead the Transcript body. Extract every `**bold**` term. {classify} Determine the target path and whether the page is new or existing.\n\n"));
        // Promoted entity-type routing.
        let promoted: Vec<&str> = cfg
            .entity_taxonomy
            .types
            .iter()
            .filter(|t| t.promote && !t.name.trim().is_empty())
            .map(|t| t.name.trim())
            .collect();
        if entities {
            if promoted.is_empty() {
                s.push_str(&format!("Entities go to `{base}/Entities/<Name>.md` (distinguished by the `Entity Type:` frontmatter value).\n\n"));
            } else {
                s.push_str(&format!("Entities go to `{base}/Entities/<Name>.md` by default. Promoted entity types route to their own folder instead: "));
                let routes: Vec<String> = promoted.iter().map(|t| format!("`{t}` → `{base}/{t}/<Name>.md`")).collect();
                s.push_str(&routes.join("; "));
                s.push_str(".\n\n");
            }
        }
        if entities {
            s.push_str("**Creator Entity Check:** If the video creator is not already in the extracted set, add them as an Entity.\n\n");
        }
        let etype_enum = entity_type_enum(cfg);
        s.push_str(&format!("Spawn one sub-agent per page via the Task tool, `model: \"sonnet\"`, in a single message.\n\n**Sub-agent instruction template:**\n\n> Create or update the page at `<target path>` for the term `<Term>` extracted from the Transcript at `<transcript path>`.\n>\n> Read the Transcript. Extract every claim, mention, and contextual note involving this term. Ground every statement in transcript content — no fabrication.\n>\n> If the page does not exist, create with frontmatter:\n> ```yaml\n> ---\n> Type: <Entity|Concept>\n> Domain: {fm}\n> Entity Type: {etype_enum}   # Entity only\n> Status: Active              # Concept only; Entity: omit\n> aliases:\n>   - <alias>\n> Sources:\n>   - \"[[{base}/Transcripts/<Source Title>]]\"\n> ---\n> ```\n>\n> If the page exists, append this Transcript's wikilink to `Sources:` and add a `### From [[<Source Title>]]` subsection with the new claims (do NOT overwrite the body).\n>\n> Body: 1–3 paragraphs grounded in the transcript.\n>\n> Return: the file path written + a 1-sentence summary.\n\nAfter all sub-agents return: validate each (valid YAML + Sources + substantive body); retry malformed once; write each file; build a `term → target path` map for Phase 7."));
        if topics {
            s.push_str(" Update the Topic page's `## Related` section with wikilinks to every created/updated Entity + Concept page.");
        }
        s.push_str("\n\n");
    }

    // ───────── Phase 7 (wikilink rewrite) ─────────
    if any_pages {
        s.push_str("## Phase 7: Rewrite Body — Bold → Wikilinks\n\nFor every `term → target path` in the Phase 6 map, replace every `**<term>**` in the body with `[[<target path>|<term>]]` (full path inline). Replace every occurrence (wikilink everywhere, not first-mention-only). Case-insensitive match; preserve the original case in the alias position. Leave any bold with no matching page as `**term**`.\n\n");
    }

    // ───────── Phase 8 ─────────
    s.push_str(&format!("## Phase 8: Delete Raw File\n\n```bash\nrm \"{base}/Raw/<Source Title>.md\"\n```\n\nThe `Source URL` field in the Transcript frontmatter is the sole audit trail. Re-run `/transcript {slug}` with the same URL to re-fetch (Phase 0 gate prompts Cancel/Replace/Skip).\n\n"));

    // ───────── Phase 9 (logging) ─────────
    s.push_str(&format!("## Phase 9: Logging\n\nThree surfaces per [[CLAUDE.md|CLAUDE.md Definition of Done]].\n\n### `Infrastructure/Indexes/Index.md`\n\nAdd (or move) the Transcript"));
    if topics {
        s.push_str(", the Topic (if newly created)");
    }
    if entities || concepts {
        s.push_str(", and every new Entity + Concept");
    }
    s.push_str(&format!(" under the `{name}` domain section.\n\n### Today's Daily Log Vault Activity Bullet\n\nCapture a timestamp via `! date`, then append to `Pulse/Daily Logs/YYYY-MM-DD.md` under `## Vault Activity` (H2):\n\n```\n- H:MM AM — Ingested \"<Source Title>\" (<creator>) to {base}/Transcripts/ via /transcript {slug}. <1–2 sentence summary>\n```\n\nPlain prose only — no wikilinks.\n\n### `Infrastructure/Vault State/Update Queue.md`\n\nAppend an unchecked entry:\n\n```markdown\n- [ ] [YYYY-MM-DD H:MM AM] ingest — <Source Title> (<creator>)\n  Files:\n  - <each file written>\n```\n\n"));

    // ───────── Phase 10 ─────────
    s.push_str("## Phase 10: Report Back\n\nTight summary:\n\n- **Source URL** (prominent — first line)\n- Transcript path\n");
    if topics {
        s.push_str("- Topic chosen (new or existing)\n");
    }
    if entities || concepts {
        s.push_str("- Entity + Concept counts (created vs updated)\n");
    }
    if glossary {
        s.push_str("- Transcription corrections applied (count)\n");
    }
    s.push_str("- Post-transcribe rating\n- Contradictions or open questions surfaced\n- **Long-Video Mode only:** chunk count (success/fail), density achieved, wall-clock time, whether annotation was skipped\n\n");

    // ───────── Cross-Cutting ─────────
    s.push_str("## Cross-Cutting: Single Approval Gate\n\nPhase 4 is the sole user-facing decision point (Yes/No to commit). Domain is hard-coded; Topic routing is an auto-proposal that proceeds unless the user objects in the same turn. Sub-agent orchestration is automatic; any sub-agent failure is reported in Phase 10 without blocking the rest.\n");

    s
}

#[cfg(test)]
mod tests {
    use super::render_subspec;
    use crate::commands::domain::DomainConfig;

    fn cfg(v: serde_json::Value) -> DomainConfig {
        serde_json::from_value(v).expect("DomainConfig deserializes")
    }

    // The skeleton every generated sub-spec must share with the hand-authored
    // transcript-yt-study.md / transcript-yt-deadlock.md (anti-drift guard).
    const REQUIRED_SKELETON: &[&str] = &[
        "Type: Infrastructure",
        "Feature Kind: skill",
        "Skill File: ~/.claude/skills/transcript/SKILL.md",
        "Destructive: true",
        "Arguments:",
        "## Purpose",
        "## Location",
        "## Dependencies",
        "## Commands",
        "## Troubleshooting",
        "## Execution Order",
        "## Domain Routing",
        "## Phase 0:",
        "## Phase 1:",
        "## Phase 2:",
        "## Phase 3:",
        "## Phase 4:",
        "## Phase 8:",
        "## Phase 9:",
        "## Phase 10:",
        "## Cross-Cutting",
    ];

    #[test]
    fn timestamped_matches_canonical_skeleton() {
        let c = cfg(serde_json::json!({
            "domainName": "Artificial Intelligence",
            "transcriptMode": "timestamped",
            "glossary": { "enabled": true, "wireAutoCorrection": true },
            "entityTaxonomy": { "types": [ { "name": "Model" }, { "name": "Lab", "promote": true } ] },
        }));
        let out = render_subspec(&c, "2026-06-07");
        for needle in REQUIRED_SKELETON {
            assert!(out.contains(needle), "timestamped missing: {needle}");
        }
        // Canonical casing + slug.
        assert!(out.contains("Command: /transcript yt-artificial-intelligence"));
        assert!(out.contains("Domain: Artificial-Intelligence"));
        // Timestamped-only artifacts.
        assert!(out.contains("&t=SECONDS"), "timestamped must emit seek anchors");
        assert!(out.contains("## Phase 1.2"), "glossary mode adds Phase 1.2");
        assert!(out.contains("## Transcription Corrections"));
        // Custom taxonomy → Entity Type enum + promoted-folder routing.
        assert!(out.contains("Entity Type: Model|Lab"));
        assert!(out.contains("promoted entity type"));
    }

    #[test]
    fn summary_has_no_timestamps() {
        let c = cfg(serde_json::json!({
            "domainName": "Brewing",
            "transcriptMode": "summary",
        }));
        let out = render_subspec(&c, "2026-06-07");
        for needle in REQUIRED_SKELETON {
            assert!(out.contains(needle), "summary missing: {needle}");
        }
        assert!(out.contains("## Executive Summary"));
        // The real seek link is `](…VIDEO_ID&t=SECONDS)`; summary only *mentions*
        // "&t=SECONDS" in a don't-do-this instruction, so match the closing paren.
        assert!(!out.contains("&t=SECONDS)"), "summary must not emit real seek links");
        assert!(!out.contains("[HH:MM —"), "summary must not emit timestamp links");
    }

    #[test]
    fn extraction_off_drops_page_phases() {
        let c = cfg(serde_json::json!({
            "domainName": "Quotes",
            "transcriptMode": "timestamped",
            "extraction": { "entities": false, "concepts": false, "topics": false },
        }));
        let out = render_subspec(&c, "2026-06-07");
        assert!(!out.contains("## Phase 5:"), "no Topic page when topics off");
        assert!(!out.contains("## Phase 6:"), "no fan-out when entities+concepts off");
        assert!(!out.contains("## Phase 7:"), "no wikilink rewrite with no pages");
        // Core transcript phases still present.
        assert!(out.contains("## Phase 3:"));
        assert!(out.contains("## Phase 4:"));
    }

    #[test]
    fn topics_folder_off_drops_topic_phase_even_with_extraction_on() {
        // The reported bug: Topics folder deselected but topic extraction left
        // on must NOT emit any Topic phase or folder reference (the spec would
        // otherwise recreate the opted-out folder on first run).
        let c = cfg(serde_json::json!({
            "domainName": "Gaming",
            "transcriptMode": "summary",
            "pipeline": { "folders": { "concepts": true, "entities": true, "topics": false, "assets": true } },
            "extraction": { "entities": true, "concepts": true, "topics": true },
        }));
        let out = render_subspec(&c, "2026-06-07");
        assert!(!out.contains("## Phase 5:"), "no Topic page when Topics folder is off");
        assert!(!out.contains("/Topics/"), "no Topics folder references when folder is off");
        assert!(!out.contains("Topic output:"), "no Topic output Location line");
        // Entities + Concepts unaffected — their folders are on.
        assert!(out.contains("## Phase 6:"), "Entity/Concept fan-out still present");
        assert!(out.contains("/Entities/"));
        assert!(out.contains("/Concepts/"));
    }
}
