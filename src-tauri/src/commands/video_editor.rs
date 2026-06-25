// Video Editor (studio module) — project storage commands.
//
// Projects are folders: <Library vault>/Studio/Projects/<Name>/project.json.
// The JS module owns the JSON schema (modules/studio/video-editor/project.js,
// schemaVersion inside the document); Rust treats it as opaque JSON and
// enforces only the vault-wide f64-ms mtime conflict contract
// (vault_write_file precedent). Folder names go through the playlists
// sanitize_name rule so a picker-typed title can't escape the tree.
// Host Extensions § Editor remux lane extends this file with the
// vedit_probe / vedit_remux_* commands (Cuts NLE SF4).

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use super::vault::{atomic_write, library_vault_root, mtime_ms, VaultError};
use crate::parsers::playlists::sanitize_name;
use crate::parsers::{editor_proxy, probe_cache, video_transcode};

fn projects_root() -> PathBuf {
    PathBuf::from(library_vault_root())
        .join("Studio")
        .join("Projects")
}

/// Sanitized folder name + project.json path for a user-facing project name.
fn project_paths(name: &str) -> Result<(String, PathBuf), VaultError> {
    let clean = sanitize_name(name);
    if clean.is_empty() {
        return Err(VaultError::Invalid(
            "Project name is empty after sanitizing".into(),
        ));
    }
    let file = projects_root().join(&clean).join("project.json");
    Ok((clean, file))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListEntry {
    pub name: String,
    pub mtime: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReadOut {
    pub name: String,
    pub data: serde_json::Value,
    pub mtime: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWriteOut {
    pub ok: bool,
    pub name: String,
    pub mtime: f64,
}

// Async wrapper: run the (blocking) directory scan off the main-thread command
// path via spawn_blocking, so a future main-thread stall can't starve content
// loads (resilience hardening after the 2026-06-24 Windows browser deadlock).
#[tauri::command]
pub async fn vedit_project_list() -> Result<Vec<ProjectListEntry>, VaultError> {
    tauri::async_runtime::spawn_blocking(vedit_project_list_inner)
        .await
        .map_err(|e| VaultError::Io(e.to_string()))?
}

fn vedit_project_list_inner() -> Result<Vec<ProjectListEntry>, VaultError> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(projects_root()) else {
        return Ok(out); // no Studio/Projects yet — empty picker, not an error
    };
    for entry in rd.flatten() {
        let file = entry.path().join("project.json");
        if let Ok(meta) = fs::metadata(&file) {
            if meta.is_file() {
                out.push(ProjectListEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    mtime: mtime_ms(&meta),
                });
            }
        }
    }
    out.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

#[tauri::command]
pub fn vedit_project_read(name: String) -> Result<ProjectReadOut, VaultError> {
    let (clean, file) = project_paths(&name)?;
    let meta = fs::metadata(&file).map_err(|_| VaultError::NotFound(clean.clone()))?;
    let raw = fs::read_to_string(&file)?;
    let data = serde_json::from_str(&raw)
        .map_err(|e| VaultError::Io(format!("project.json parse failed: {e}")))?;
    Ok(ProjectReadOut {
        name: clean,
        data,
        mtime: mtime_ms(&meta),
    })
}

/// `mtime: None` = create (errors instead of clobbering an existing project);
/// `Some` = guarded update returning CONFLICT on drift (vault contract,
/// 1 ms tolerance like vault_write_file).
#[tauri::command]
pub fn vedit_project_save(
    name: String,
    data: serde_json::Value,
    mtime: Option<f64>,
) -> Result<ProjectWriteOut, VaultError> {
    let (clean, file) = project_paths(&name)?;
    match (mtime, fs::metadata(&file)) {
        (None, Ok(_)) => {
            return Err(VaultError::Invalid(format!(
                "Project \"{clean}\" already exists"
            )));
        }
        (Some(expected), Ok(meta)) => {
            let current = mtime_ms(&meta);
            if (current - expected).abs() > 1.0 {
                return Err(VaultError::Conflict {
                    current_mtime: current,
                });
            }
        }
        (Some(_), Err(_)) => return Err(VaultError::NotFound(clean)),
        (None, Err(_)) => {}
    }
    let bytes = serde_json::to_vec_pretty(&data)
        .map_err(|e| VaultError::Io(format!("project serialize failed: {e}")))?;
    atomic_write(&file, &bytes)?;
    let meta = fs::metadata(&file)?;
    Ok(ProjectWriteOut {
        ok: true,
        name: clean,
        mtime: mtime_ms(&meta),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOut {
    pub ok: bool,
    pub bin_id: String,
}

/// Immediate trash, never a confirm modal (locked UX decision): the whole
/// project folder moves into the recycling bin's Studio arm and the picker
/// raises a Toast whose Restore calls recycle_bin_restore with the returned
/// id. No direct-unlink path exists by design. SF4 additionally wires
/// vedit_remux_release here to drop the project's proxy pins.
#[tauri::command]
pub fn vedit_project_delete(
    app: tauri::AppHandle,
    name: String,
) -> Result<DeleteOut, VaultError> {
    let (clean, file) = project_paths(&name)?;
    let dir = file
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| VaultError::Invalid("project folder has no parent".into()))?;
    if !dir.is_dir() {
        return Err(VaultError::NotFound(clean));
    }
    // Release the project's proxy pins before trashing (SF4): unpinned
    // proxies stay on disk (no eviction pass in Phase 1) but stop counting
    // as project-held.
    if let Ok(raw) = fs::read_to_string(&file) {
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) {
            let hashes: Vec<String> = doc
                .get("media")
                .and_then(|m| m.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.get("proxyHash").and_then(|h| h.as_str()))
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            editor_proxy::release(&hashes);
        }
    }
    let rel = format!("Studio/Projects/{clean}");
    let bin_id =
        super::recycle_bin::trash_video_project(&app, Some("library".into()), &rel, &dir)?;
    Ok(DeleteOut { ok: true, bin_id })
}

// ── Editor remux lane commands (Host Extensions § Editor remux lane) ──
//
// Trust boundary: vedit_probe and vedit_remux_start accept any picker-derived
// absolute path and DELIBERATELY skip is_under_allowed_root — the native
// dialog is the consent boundary. canonicalize + is_file checks stay.
// Arbitrary source paths are still NOT servable via /media (403); preview
// always plays the /editor-proxy/ URL.

fn canonical_file(path: &str) -> Result<PathBuf, VaultError> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(VaultError::Invalid("expected an absolute path".into()));
    }
    let canonical =
        fs::canonicalize(&p).map_err(|_| VaultError::NotFound(path.to_string()))?;
    if !canonical.is_file() {
        return Err(VaultError::NotFile);
    }
    Ok(canonical)
}

#[tauri::command]
pub fn vedit_probe(path: String) -> Result<probe_cache::ProbeResult, VaultError> {
    let canonical = canonical_file(&path)?;
    probe_cache::probe(&canonical)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxOut {
    pub hash: String,
    pub url: String,
    /// Source−proxy container start_time delta (seconds); export corrects
    /// trims by this so proxy-chosen cuts land on the same source frames.
    pub start_time_offset: f64,
    /// Editor-proxy cache exceeded its 20 GB accounting budget (warning
    /// only — nothing is evicted in Phase 1).
    pub over_budget: bool,
}

/// Remux `path` into the editor-proxy lane and await completion, then pin the
/// hash and return the loopback URL directly (no iskariel-asset:// round-trip).
/// Cache hits (including completed files from prior runs) return on the first
/// poll tick — that's the instant re-pin on project open.
#[tauri::command]
pub async fn vedit_remux_start(
    path: String,
    audio_track: Option<i64>,
) -> Result<RemuxOut, VaultError> {
    let canonical = canonical_file(&path)?;
    let canonical_str = canonical.display().to_string();
    let probe = probe_cache::probe(&canonical)?;
    let mtime = video_transcode::mtime_ms_for(&canonical);

    // 1080p preview-proxy gate (Color Grading SF2): frames larger than 1080p
    // never enter the WebGL upload path (GPU Display Path decision), so
    // >1080p sources re-encode into a ≤1080p short-GOP proxy. The recipe
    // suffix keeps every ≤1080p key identical to the legacy hash.
    let v0 = probe.video.first();
    let needs_proxy = v0
        .map(|v| v.height.unwrap_or(0) > 1080 || v.width.unwrap_or(0) > 1920)
        .unwrap_or(false);
    let recipe = if needs_proxy { "p1080" } else { "" };
    let hash = video_transcode::compute_hash_with_recipe(&canonical_str, audio_track, mtime, recipe);
    let proxy_scale = if needs_proxy {
        Some(video_transcode::ProxyScale {
            fps: v0.and_then(|v| v.fps).unwrap_or(30.0),
            color_space: v0.and_then(|v| v.color_space.clone()),
            color_primaries: v0.and_then(|v| v.color_primaries.clone()),
            color_transfer: v0.and_then(|v| v.color_transfer.clone()),
            color_range: v0.and_then(|v| v.color_range.clone()),
        })
    } else {
        None
    };

    let sel = audio_track.unwrap_or(0).max(0) as usize;
    let copy_audio = probe
        .audio
        .get(sel)
        .map(|s| s.codec.as_deref() == Some("aac") && s.profile.as_deref() == Some("LC"))
        .unwrap_or(false);
    editor_proxy::start_or_reuse(hash.clone(), canonical_str, audio_track, copy_audio, proxy_scale)?;

    // The copy remux is I/O-bound (120 s is generous); a re-encode is not —
    // scale the deadline with source duration (veryfast 1080p measures
    // ~7× realtime, so 2× duration has wide margin) and keep the 120 s floor.
    let deadline = if needs_proxy {
        std::time::Duration::from_secs_f64((probe.duration.unwrap_or(60.0) * 2.0).max(120.0))
    } else {
        std::time::Duration::from_secs(120)
    };
    let started = std::time::Instant::now();
    loop {
        match editor_proxy::status_of(&hash) {
            Some(video_transcode::EntryStatus::Done) => break,
            Some(video_transcode::EntryStatus::Failed { stderr_tail, .. }) => {
                return Err(VaultError::Io(format!("editor remux failed: {stderr_tail}")));
            }
            Some(video_transcode::EntryStatus::Running) => {}
            None => return Err(VaultError::Io("editor remux entry vanished".into())),
        }
        if started.elapsed() >= deadline {
            return Err(VaultError::Io("editor remux timed out".into()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    editor_proxy::pin(&hash);

    // Import-time start_time parity: store the src−proxy delta so export can
    // correct trims chosen against the proxy.
    let proxy_file = editor_proxy::proxy_path(&hash)?;
    let proxy_start = probe_cache::probe(&proxy_file)
        .ok()
        .and_then(|p| p.start_time)
        .unwrap_or(0.0);
    let src_start = probe.start_time.unwrap_or(0.0);
    let delta = src_start - proxy_start;
    let start_time_offset = if delta.abs() > 0.001 { delta } else { 0.0 };

    let port = crate::media_server::port()
        .ok_or_else(|| VaultError::Io("media server not running".into()))?;
    Ok(RemuxOut {
        url: format!("http://127.0.0.1:{port}/editor-proxy/{hash}.mp4"),
        hash,
        start_time_offset,
        over_budget: editor_proxy::accounted_bytes() > editor_proxy::BYTE_BUDGET,
    })
}

/// Unpin proxies no longer referenced (project close, clip removed from the
/// bin, project delete). Files stay on disk — Phase 1 accounts, never evicts.
#[tauri::command]
pub fn vedit_remux_release(hashes: Vec<String>) -> Result<(), VaultError> {
    editor_proxy::release(&hashes);
    Ok(())
}

// ───────────────────────── SF10: export engine ─────────────────────────
//
// Pure builder fns (unit-tested below, build_transcode_argv precedent) feed a
// single-job supervisor that streams `-progress pipe:1` from ffmpeg stdout.
// Sources are ALWAYS the originals (the proxy's audio is already one AAC
// generation down); srcIn is corrected by startTimeOffset INSIDE the builder
// so the tested code owns the parity rule. The filter graph always travels
// via -filter_complex_script (128 KiB argv ceiling ≈ 600 segments). Output
// writes to <out>.partial (explicit -f mp4 — the suffix breaks ffmpeg's
// extension sniffing) and renames on exit 0; ANY other exit deletes the
// .partial (+faststart needs the final moov pass anyway).

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportSegment {
    /// None = timeline gap → black + silence (lavfi sources, no -i input).
    pub src: Option<String>,
    #[serde(default)]
    pub src_in: f64,
    pub dur: f64,
    #[serde(default = "one")]
    pub gain: f64,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub start_time_offset: f64,
    /// Color Grading SF4 — the segment's compiled 33³ grade as .cube TEXT
    /// (None = ungraded: the chain stays byte-identical to Phase 1).
    /// Identical texts across segments dedupe to one temp file.
    #[serde(default)]
    pub lut: Option<String>,
    /// scale `in_color_matrix` / `in_range` strings ("bt709"/"bt601",
    /// "tv"/"pc") resolved by colorimetry.js — consulted only when `lut` is
    /// Some (the ungraded chain never converts through RGB).
    #[serde(default)]
    pub color_matrix: Option<String>,
    #[serde(default)]
    pub color_range: Option<String>,
    /// Audio Post SF7 — the source track id this segment came from (mixer key).
    /// None = pre-Audio-Post spec → no per-track processing (identity chain).
    #[serde(default)]
    pub track_id: Option<String>,
}

// ── Compositing SF7: region/layer spatial composite ─────────────────────────
// The JS marshals flattenComposite regions (ordered layer stacks bottom→top)
// into ExportSpec.regions; when set, the region filtergraph runs and `segments`
// is ignored. A region of exactly one transform-identity layer (or a gap) emits
// the VERBATIM Phase-1 chain so a no-transform export stays byte-identical.

/// Normalized 0..1 crop inset (fraction of the source edge), mirroring the JS
/// `transform.crop` — all-zero = no crop.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    #[serde(default)]
    pub l: f64,
    #[serde(default)]
    pub t: f64,
    #[serde(default)]
    pub r: f64,
    #[serde(default)]
    pub b: f64,
}

/// A clip transform mirroring the JS `clip.transform` (project.js
/// normalizeTransform): position x/y normalized to sequence dims (+x right,
/// +y up), uniform `scale`, `rot` in degrees clockwise, `opacity` 0..1, static
/// `crop`. Anchor = clip center.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default)]
    pub rot: f64,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default)]
    pub crop: Crop,
}

impl Default for Transform {
    fn default() -> Self {
        Transform { x: 0.0, y: 0.0, scale: 1.0, rot: 0.0, opacity: 1.0, crop: Crop::default() }
    }
}

/// One layer of a region — a clip spanning the region. Carries the per-layer
/// transform/grade/source-dims so the export filtergraph reproduces the
/// preview's renderComposite. `src: None` contributes nothing (no -i input).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportLayer {
    pub src: Option<String>,
    #[serde(default)]
    pub src_in: f64,
    pub dur: f64,
    #[serde(default = "one")]
    pub gain: f64,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub start_time_offset: f64,
    /// Source pixel dims — the fit factor min(seqW/srcW, seqH/srcH) needs them
    /// (computeLayerQuad parity hinge). 0 → identity fit (1:1) as a safe floor.
    #[serde(default)]
    pub src_w: u32,
    #[serde(default)]
    pub src_h: u32,
    /// SF2 transform {x,y,scale,rot,opacity,crop}; None = identity → the region
    /// can take the byte-identical fast-path.
    #[serde(default)]
    pub transform: Option<Transform>,
    #[serde(default)]
    pub lut: Option<String>,
    #[serde(default)]
    pub color_matrix: Option<String>,
    #[serde(default)]
    pub color_range: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
    /// SF9 — compiled region-local ffmpeg expr strings for ANIMATED params (None
    /// = no animation → the SF7 static literal paths run, byte-identical). The JS
    /// layerExports bakes constant tracks into `transform`/`gain`; only genuinely
    /// animated tracks reach here.
    #[serde(default)]
    pub kf: Option<LayerKf>,
    /// SF11 — base64 PNG of a title layer (drawTitle at sequence scale). Some ⇒
    /// this layer is a TITLE (src is None): materialize_titles writes it to a temp
    /// the filtergraph loops (`-loop 1`); layer_geom maps it 1:1 (fit=1). None ⇒
    /// a video layer (the SF7 path).
    #[serde(default)]
    pub title_png: Option<String>,
}

/// SF9 keyframe expr payload (region-local ffmpeg expressions). pos_x/pos_y are
/// overlay CENTRE fractions (0.5±offset, y flipped); rot is RADIANS; opacity uses
/// uppercase-T (geq); gain is the clip gain; track_vol is the track fader.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayerKf {
    #[serde(default)]
    pub pos_x: Option<String>,
    #[serde(default)]
    pub pos_y: Option<String>,
    #[serde(default)]
    pub rot: Option<String>,
    #[serde(default)]
    pub opacity: Option<String>,
    #[serde(default)]
    pub gain: Option<String>,
    #[serde(default)]
    pub track_vol: Option<String>,
}

/// A time region with an ordered (bottom→top) layer stack. `layers` empty = a
/// gap (black + silence), like a Phase-1 None-src segment.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportRegion {
    pub dur: f64,
    #[serde(default)]
    pub layers: Vec<ExportLayer>,
}

fn one() -> f64 {
    1.0
}

fn loud_target() -> f64 {
    -14.0
}

// ── Mixer model (Audio Post SF7) — mirrors the JS project.mixer; every field
// defaults so an absent mixer (or a partial one) round-trips to identity. ──────
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EqBand {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub f: f64,
    #[serde(default)]
    pub g: f64,
    #[serde(default = "one")]
    pub q: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EqSpec {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bands: Vec<EqBand>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackMix {
    #[serde(default = "one")]
    pub volume: f64,
    #[serde(default)]
    pub pan: f64,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub solo: bool,
    #[serde(default)]
    pub eq: EqSpec,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompSpec {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub threshold: f64, // dB
    #[serde(default = "one")]
    pub ratio: f64,
    #[serde(default)]
    pub attack: f64, // seconds
    #[serde(default)]
    pub release: f64, // seconds
    #[serde(default)]
    pub knee: f64, // dB
    #[serde(default)]
    pub makeup: f64, // dB
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoudnormSpec {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "loud_target")]
    pub target: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MasterMix {
    #[serde(default)]
    pub eq: EqSpec,
    #[serde(default)]
    pub comp: CompSpec,
    #[serde(default)]
    pub loudnorm: LoudnormSpec,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mixer {
    #[serde(default)]
    pub tracks: std::collections::HashMap<String, TrackMix>,
    #[serde(default)]
    pub master: MasterMix,
}

/// Integrated-loudness measurements from the first ffmpeg pass, fed into the
/// second (encode) pass's linear `loudnorm` for two-pass normalization.
#[derive(Clone, Debug, Default)]
pub struct LoudnormMeasured {
    pub input_i: f64,
    pub input_tp: f64,
    pub input_lra: f64,
    pub input_thresh: f64,
}

/// Delivery & Presets (SF3) — how the export is encoded. `None` on `ExportSpec`
/// takes the byte-identical Phase-1 path (libx264/veryfast/crf18 + AAC 192k +
/// mp4). `Some` routes through `build_export_argv`'s encode arm: the `codec`
/// resolves to a working encoder via the probe caps (an explicit `encoder` wins
/// when available), `quality` (0–100, higher = better) maps to the encoder's
/// native control, and `container` selects the muxer (mp4/webm). Output dims
/// come from `ExportSpec::width/height`, so downscale presets just send smaller
/// dims — no encode field needed for that.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncodeSpec {
    pub container: String,
    pub codec: String,
    #[serde(default)]
    pub encoder: Option<String>,
    #[serde(default)]
    pub quality: Option<u32>,
    #[serde(default)]
    pub bitrate_kbps: Option<u32>,
    #[serde(default)]
    pub audio_bitrate_kbps: Option<u32>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    /// SF7: defaulted so a region-only spec (the compositing path) may omit it —
    /// the JS sends EITHER `segments` (Phase-1) OR `regions` (composite), never
    /// both. Without the default, serde rejects a region-only payload at the IPC
    /// boundary ("missing field `segments`").
    #[serde(default)]
    pub segments: Vec<ExportSegment>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    #[serde(default = "one")]
    pub master_volume: f64,
    pub output_path: String,
    /// Audio Post SF7 — per-track + master processing. None / all-default →
    /// the filtergraph stays byte-identical to the Phase-1 (pre-mixer) output.
    #[serde(default)]
    pub mixer: Option<Mixer>,
    /// Compositing SF7 — region/layer spatial composite. None → the Phase-1
    /// `segments` path runs unchanged (byte-identical). Some → `segments` is
    /// ignored and the region filtergraph runs.
    #[serde(default)]
    pub regions: Option<Vec<ExportRegion>>,
    /// Delivery & Presets SF3 — encoder/container/quality. None → byte-identical
    /// Phase-1 encode (libx264/crf18 + AAC 192k + mp4).
    #[serde(default)]
    pub encode: Option<EncodeSpec>,
}

/// Per-segment (Phase-1) or per-region×layer (SF7 composite) LUT temp paths,
/// parallel to the spec's segment or region/layer walk. `materialize_luts`
/// picks the arm by whether `spec.regions` is set; both `build_filter_script_for`
/// and the consumers thread the same carrier.
pub(crate) enum LutPaths {
    Segments(Vec<Option<PathBuf>>),
    Regions(Vec<Vec<Option<PathBuf>>>),
}

impl LutPaths {
    fn segments(&self) -> &[Option<PathBuf>] {
        match self {
            LutPaths::Segments(v) => v,
            LutPaths::Regions(_) => &[],
        }
    }
    fn regions(&self) -> &[Vec<Option<PathBuf>>] {
        match self {
            LutPaths::Regions(v) => v,
            LutPaths::Segments(_) => &[],
        }
    }
}

/// Per-process unique tag so two materialize_luts calls in the same millisecond
/// (concurrent test threads, or two app instances exporting at once) never share
/// a temp filename.
static LUT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Write one grade's cube text to a temp (deduped by exact text via `by_text`),
/// appending to `files` for cleanup. None text → None path. Cleans `files` on a
/// write error before returning. Shared by the segment + region materialize arms.
fn materialize_one<'a>(
    by_text: &mut std::collections::HashMap<&'a str, PathBuf>,
    files: &mut Vec<PathBuf>,
    stamp: u128,
    seq: u64,
    text: Option<&'a str>,
) -> Result<Option<PathBuf>, VaultError> {
    let Some(text) = text.filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if let Some(p) = by_text.get(text) {
        return Ok(Some(p.clone()));
    }
    let p = std::env::temp_dir().join(format!("vedit-lut-{stamp}-{seq}-{}.cube", files.len()));
    if let Err(e) = fs::write(&p, text) {
        for f in files.iter() {
            let _ = fs::remove_file(f);
        }
        return Err(VaultError::Io(format!("lut temp write failed: {e}")));
    }
    by_text.insert(text, p.clone());
    files.push(p.clone());
    Ok(Some(p))
}

/// Write each unique graded clip's cube text to a temp file
/// (`vedit-lut-<ms>-<n>.cube`), deduped by exact text content — split halves
/// and pasted grades sharing a text share one file. Returns paths parallel to
/// the spec's walk (per-segment, or region-major per-layer when `spec.regions`
/// is set) plus the unique file list; every exit path of the export
/// (write/spawn failure, cancel, error, success, app shutdown) removes them.
pub(crate) fn materialize_luts(
    spec: &ExportSpec,
) -> Result<(LutPaths, Vec<PathBuf>), VaultError> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = LUT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut by_text: std::collections::HashMap<&str, PathBuf> = std::collections::HashMap::new();
    let mut files: Vec<PathBuf> = Vec::new();
    if let Some(regions) = &spec.regions {
        let mut per_region: Vec<Vec<Option<PathBuf>>> = Vec::with_capacity(regions.len());
        for region in regions {
            let mut per_layer: Vec<Option<PathBuf>> = Vec::with_capacity(region.layers.len());
            for layer in &region.layers {
                per_layer.push(materialize_one(&mut by_text, &mut files, stamp, seq, layer.lut.as_deref())?);
            }
            per_region.push(per_layer);
        }
        Ok((LutPaths::Regions(per_region), files))
    } else {
        let mut per_seg: Vec<Option<PathBuf>> = Vec::with_capacity(spec.segments.len());
        for seg in &spec.segments {
            per_seg.push(materialize_one(&mut by_text, &mut files, stamp, seq, seg.lut.as_deref())?);
        }
        Ok((LutPaths::Segments(per_seg), files))
    }
}

/// Per-process unique tag for title temp filenames (mirrors LUT_SEQ).
static TITLE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Decode each unique title PNG (base64, from drawTitle at sequence scale) to a
/// temp `vedit-title-<ms>-<seq>-<n>.png`, deduped by the exact base64 so repeated
/// titles share one file. Region-major paths parallel to `regions` (None for
/// non-title layers) plus the unique file list; the export's existing temp
/// cleanup removes them. Mirrors materialize_luts. (Compositing & Titles SF11)
pub(crate) fn materialize_titles(
    spec: &ExportSpec,
) -> Result<(Vec<Vec<Option<PathBuf>>>, Vec<PathBuf>), VaultError> {
    use base64::Engine;
    let regions = match &spec.regions {
        Some(r) => r,
        None => return Ok((Vec::new(), Vec::new())),
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = TITLE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut by_b64: std::collections::HashMap<&str, PathBuf> = std::collections::HashMap::new();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut per_region: Vec<Vec<Option<PathBuf>>> = Vec::with_capacity(regions.len());
    for region in regions {
        let mut per_layer: Vec<Option<PathBuf>> = Vec::with_capacity(region.layers.len());
        for layer in &region.layers {
            let path = match layer.title_png.as_deref().filter(|s| !s.is_empty()) {
                None => None,
                Some(b64) => {
                    if let Some(p) = by_b64.get(b64) {
                        Some(p.clone())
                    } else {
                        let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
                            Ok(b) => b,
                            Err(e) => {
                                for f in &files {
                                    let _ = fs::remove_file(f);
                                }
                                return Err(VaultError::Io(format!("title base64 decode: {e}")));
                            }
                        };
                        let p = std::env::temp_dir()
                            .join(format!("vedit-title-{stamp}-{seq}-{}.png", files.len()));
                        if let Err(e) = fs::write(&p, &bytes) {
                            for f in &files {
                                let _ = fs::remove_file(f);
                            }
                            return Err(VaultError::Io(format!("title temp write: {e}")));
                        }
                        by_b64.insert(b64, p.clone());
                        files.push(p.clone());
                        Some(p)
                    }
                }
            };
            per_layer.push(path);
        }
        per_region.push(per_layer);
    }
    Ok((per_region, files))
}

/// Solo-aware audibility (mirrors mix.js trackAudible): audible unless muted,
/// and when ANY track is soloed only soloed tracks play.
fn track_audible(mixer: &Mixer, track_id: &str) -> bool {
    let any_solo = mixer.tracks.values().any(|t| t.solo);
    match mixer.tracks.get(track_id) {
        Some(t) => !t.mute && (!any_solo || t.solo),
        None => true,
    }
}

/// Linear-balance pan coefficients (left gain, right gain). Centre (p=0) is
/// unity on both channels — matching the skip-at-centre in segment_audio_inserts
/// — and panning attenuates the OPPOSITE channel linearly: p>0 cuts left, p<0
/// cuts right. SF8 parity: the preview applies the identical law (mixerGraph
/// mkPan/setPan), where the old equal-power StereoPanner diverged ~unbounded on
/// stereo sources. The earlier equal-power coeffs were also discontinuous here
/// (−3 dB just off centre vs unity at the skipped centre).
fn pan_coeffs(p: f64) -> (f64, f64) {
    let p = p.clamp(-1.0, 1.0);
    let lg = if p > 0.0 { 1.0 - p } else { 1.0 };
    let rg = if p < 0.0 { 1.0 + p } else { 1.0 };
    (lg, rg)
}

/// 4-band EQ [low-shelf, peak, peak, high-shelf] → bass / equalizer×2 / treble,
/// each comma-PREFIXED to splice onto a chain. "" when disabled (identity).
fn eq_filters(eq: &EqSpec) -> String {
    if !eq.enabled || eq.bands.is_empty() {
        return String::new();
    }
    let mut s = String::new();
    for b in &eq.bands {
        match b.kind.as_str() {
            // SF8 parity: Web Audio low/high-shelf IGNORE Q and use a fixed slope
            // S=1; ffmpeg width_type=s:width=1 yields the identical RBJ shelf (the
            // old width_type=q:width=0.7 diverged ~20 dB). The stored band q is
            // intentionally dropped for shelves, mirroring Web Audio.
            "lowshelf" => {
                s.push_str(&format!(",bass=g={g}:f={f}:width_type=s:width=1", g = b.g, f = b.f))
            }
            "highshelf" => {
                s.push_str(&format!(",treble=g={g}:f={f}:width_type=s:width=1", g = b.g, f = b.f))
            }
            _ => s.push_str(&format!(",equalizer=f={f}:width_type=q:width={q}:g={g}", f = b.f, q = b.q, g = b.g)),
        }
    }
    s
}

/// Per-segment mixer inserts (EQ → track fader×audible → equal-power pan),
/// comma-prefixed, to splice after the clip `volume={gain}`. "" when the segment
/// has no track / the track is identity (vol 1, pan 0, eq off, audible) / no
/// mixer — preserving the Phase-1 audio chain byte-for-byte.
fn segment_audio_inserts(mixer: Option<&Mixer>, track_id: Option<&str>, vol_expr: Option<&str>) -> String {
    let Some(mixer) = mixer else { return String::new() };
    let Some(track_id) = track_id else { return String::new() };
    let Some(track) = mixer.tracks.get(track_id) else { return String::new() };
    let mut s = eq_filters(&track.eq);
    let audible = track_audible(mixer, track_id);
    // SF9: an animated track fader becomes a per-frame volume expr; a muted /
    // soloed-out automated track collapses to silence. No expr → the Phase-1
    // static path (byte-identical when vol_expr is None and the fader is unity).
    match vol_expr {
        Some(expr) if audible => s.push_str(&format!(",volume='{expr}':eval=frame")),
        Some(_) => s.push_str(",volume=0"),
        None => {
            let tv = if audible { track.volume } else { 0.0 };
            if (tv - 1.0).abs() > 1e-9 {
                s.push_str(&format!(",volume={tv}"));
            }
        }
    }
    if track.pan.abs() > 1e-9 {
        let (l, r) = pan_coeffs(track.pan);
        s.push_str(&format!(",pan=stereo|c0={l:.6}*c0|c1={r:.6}*c1"));
    }
    s
}

/// Master compressor (acompressor) with Web-Audio→ffmpeg unit conversion:
/// threshold/makeup dB→linear (10^(dB/20)), attack/release s→ms, ratio direct,
/// knee dB→ffmpeg's 1..8 curve (approximate — the documented compressor parity
/// gap that SF8 measures).
fn acompressor_filter(c: &CompSpec) -> String {
    let thr = 10f64.powf(c.threshold / 20.0).clamp(0.000_976_563, 1.0);
    let mk = 10f64.powf(c.makeup / 20.0).clamp(1.0, 64.0);
    let knee = (1.0 + (c.knee / 40.0).clamp(0.0, 1.0) * 7.0).clamp(1.0, 8.0);
    format!(
        ",acompressor=threshold={thr:.6}:ratio={ratio}:attack={atk:.3}:release={rel:.3}:knee={knee:.4}:makeup={mk:.4}",
        ratio = c.ratio,
        atk = (c.attack * 1000.0).clamp(0.01, 2000.0),
        rel = (c.release * 1000.0).clamp(0.01, 9000.0),
    )
}

/// The master audio tail spliced onto [cona]: `volume={mv}` + master EQ + comp +
/// (two-pass) loudnorm, then `[outa]`. Identity (no mixer / all-default master) →
/// exactly `volume={mv}[outa]` (Phase-1 byte-identical).
fn master_audio_tail(spec: &ExportSpec, measured: Option<&LoudnormMeasured>, measure_mode: bool) -> String {
    let mut s = format!("[cona]volume={mv}", mv = spec.master_volume);
    if let Some(mixer) = spec.mixer.as_ref() {
        s.push_str(&eq_filters(&mixer.master.eq));
        if mixer.master.comp.enabled {
            s.push_str(&acompressor_filter(&mixer.master.comp));
        }
        let ln = &mixer.master.loudnorm;
        if ln.enabled {
            if measure_mode {
                // Pass 1: measure the integrated loudness of the PROCESSED audio.
                s.push_str(&format!(",loudnorm=I={i}:TP=-1.0:LRA=11.0:print_format=json", i = ln.target));
            } else if let Some(m) = measured {
                // Pass 2: linear correction from the measured values.
                s.push_str(&format!(
                    ",loudnorm=I={i}:TP=-1.0:LRA=11.0:measured_I={mi:.2}:measured_TP={mtp:.2}:measured_LRA={mlra:.2}:measured_thresh={mth:.2}:linear=true",
                    i = ln.target, mi = m.input_i, mtp = m.input_tp, mlra = m.input_lra, mth = m.input_thresh
                ));
            } else {
                // No measurement (measure pass failed) → single-pass dynamic.
                s.push_str(&format!(",loudnorm=I={i}:TP=-1.0:LRA=11.0", i = ln.target));
            }
        }
    }
    s.push_str("[outa]");
    s
}

/// One filter chain pair per segment, concat, master volume on [outa].
/// Every chain is hard-capped in the frame/sample domain (`trim=end_frame`,
/// `atrim`+`apad`): demuxer `-ss/-t` is timestamp-approximate, so an uncapped
/// segment tail can round up a frame and the +1s accumulate across the concat
/// (measured +3 frames / +41 ms a-v drift on a 6-segment program).
/// `lut_paths` parallels `spec.segments` (materialize_luts output): Some
/// routes that segment through the graded RGB chain.
/// Every chain also pins `setsar=1` (Color Grading SF4): concat requires
/// identical SAR on all inputs, and real sources can flip SAR mid-stream when
/// the bitstream VUI disagrees with the container tag — that triggers a
/// filter-graph reinit, and an unpinned SAR change kills concat with -22
/// (observed: VUI SAR 460733:460800 vs negotiated 1:1). The export canvas is
/// square-pixel by definition — it is exactly what the preview renders.
pub(crate) fn build_filter_script(
    spec: &ExportSpec,
    lut_paths: &[Option<PathBuf>],
    measured: Option<&LoudnormMeasured>,
    measure_mode: bool,
) -> String {
    let (w, h, fps) = (spec.width, spec.height, spec.fps);
    let mut s = String::new();
    let mut input_idx = 0usize;
    for (i, seg) in spec.segments.iter().enumerate() {
        let n = (seg.dur * fps).round() as i64;
        if seg.src.is_some() {
            if let Some(lut) = lut_paths.get(i).and_then(|p| p.as_ref()) {
                // Graded (Color Grading SF4): pin the single YUV→RGB
                // conversion to the probed matrix (in_color_matrix/in_range),
                // apply the grade in planar RGB with trilinear interp matching
                // WebGL LINEAR, convert back with bt709/tv forced. pad runs
                // AFTER the grade: the preview applies the LUT only inside the
                // video viewport, so letterbox bars stay ungraded black here
                // too (the approved plan sketched pad before lut3d — that
                // would tint the bars and break preview parity).
                let m = seg.color_matrix.as_deref().unwrap_or("bt709");
                let r = seg.color_range.as_deref().unwrap_or("tv");
                s.push_str(&format!(
                    "[{k}:v]setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease:in_color_matrix={m}:in_range={r},format=gbrp,lut3d=file='{p}':interp=trilinear,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps},setsar=1,settb=AVTB,trim=end_frame={n}[v{i}];\n",
                    k = input_idx,
                    p = lut.display()
                ));
            } else {
                s.push_str(&format!(
                    "[{k}:v]setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps},format=yuv420p,setsar=1,settb=AVTB,trim=end_frame={n}[v{i}];\n",
                    k = input_idx
                ));
            }
            if seg.has_audio {
                s.push_str(&format!(
                    "[{k}:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume={gain}{inserts},atrim=duration={dur:.6},apad=whole_dur={dur:.6}[a{i}];\n",
                    k = input_idx,
                    gain = seg.gain,
                    inserts = segment_audio_inserts(spec.mixer.as_ref(), seg.track_id.as_deref(), None),
                    dur = seg.dur
                ));
            } else {
                s.push_str(&format!(
                    "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration={dur},asetpts=PTS-STARTPTS[a{i}];\n",
                    dur = seg.dur
                ));
            }
            input_idx += 1;
        } else {
            s.push_str(&format!(
                "color=black:size={w}x{h}:rate={fps},format=yuv420p,setsar=1,settb=AVTB,trim=end_frame={n}[v{i}];\n",
            ));
            s.push_str(&format!(
                "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration={dur},asetpts=PTS-STARTPTS[a{i}];\n",
                dur = seg.dur
            ));
        }
    }
    for i in 0..spec.segments.len() {
        s.push_str(&format!("[v{i}][a{i}]"));
    }
    // ≥1 graded segment: pin frame-level colorimetry on the concat output —
    // modern ffmpeg writes VUI from FRAME properties and the argv
    // -colorspace/-color_trc options lose to them (observed: matrix + range
    // tagged, primaries/trc "unknown" without this). Ungraded exports keep
    // the Phase 1 tail untouched.
    if lut_paths.iter().any(|p| p.is_some()) {
        s.push_str(&format!(
            "concat=n={n}:v=1:a=1[catv][cona];\n[catv]setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[outv];\n{tail}",
            n = spec.segments.len(),
            tail = master_audio_tail(spec, measured, measure_mode)
        ));
    } else {
        s.push_str(&format!(
            "concat=n={n}:v=1:a=1[outv][cona];\n{tail}",
            n = spec.segments.len(),
            tail = master_audio_tail(spec, measured, measure_mode)
        ));
    }
    s
}

// ── Compositing SF7: region filtergraph ─────────────────────────────────────

/// A transform with no geometric/alpha effect — the layer renders exactly like
/// Phase-1, so a one-layer region takes the byte-identical fast-path. JS sends
/// `transform: null` for identity (setClipTransform drops the key), so the None
/// arm is the common case; the float compare is the defensive belt.
fn is_identity_transform(t: &Option<Transform>) -> bool {
    match t {
        None => true,
        Some(t) => {
            t.x == 0.0 && t.y == 0.0 && t.scale == 1.0 && t.rot == 0.0 && t.opacity == 1.0
                && t.crop.l == 0.0 && t.crop.t == 0.0 && t.crop.r == 0.0 && t.crop.b == 0.0
        }
    }
}

/// The literal ffmpeg geometry a layer compiles to, mirroring glDisplay.js
/// `computeLayerQuad`: integer fit dims (drop the preview-only canvas seqFit;
/// export renders AT sequence res), an optional crop prefix, rotation radians,
/// alpha, and the center fraction of the sequence (cx,cy) for the overlay anchor.
struct LayerGeom {
    crop: Option<String>,
    fit_w: i64,
    fit_h: i64,
    rot_rad: f64,
    opacity: f64,
    cx: f64,
    cy: f64,
}

fn layer_geom(seq_w: u32, seq_h: u32, layer: &ExportLayer) -> LayerGeom {
    let t = layer.transform.clone().unwrap_or_default();
    let sw = layer.src_w.max(1) as f64;
    let sh = layer.src_h.max(1) as f64;
    let qw = seq_w as f64;
    let qh = seq_h as f64;
    // f = min(seqW/srcW, seqH/srcH) from the SAME source dims GL uses (parity hinge).
    // A TITLE is authored in sequence px (its tight box) → maps 1:1 (fit=1),
    // matching computeLayerQuad's isTitle branch.
    let layer_fit = if layer.title_png.is_some() { 1.0 } else { (qw / sw).min(qh / sh) };
    let base_w = sw * layer_fit;
    let base_h = sh * layer_fit;
    let (cl, ct, cr, cb) = (t.crop.l, t.crop.t, t.crop.r, t.crop.b);
    let vis_w = (1.0 - cl - cr).max(0.0);
    let vis_h = (1.0 - ct - cb).max(0.0);
    // Displayed size folds crop-shrink + uniform scale; round to match Math.round.
    let fit_w = (base_w * vis_w * t.scale).round().max(1.0) as i64;
    let fit_h = (base_h * vis_h * t.scale).round().max(1.0) as i64;
    let crop = if cl == 0.0 && ct == 0.0 && cr == 0.0 && cb == 0.0 {
        None
    } else {
        // crop the source rect BEFORE scale (the subsequent scale stretches the
        // cropped, same-aspect region to the displayed size — no distortion).
        Some(format!(
            "crop=w=iw*{vw:.6}:h=ih*{vh:.6}:x=iw*{cl:.6}:y=ih*{ct:.6},",
            vw = vis_w, vh = vis_h
        ))
    };
    LayerGeom {
        crop,
        fit_w,
        fit_h,
        rot_rad: t.rot * std::f64::consts::PI / 180.0,
        opacity: t.opacity,
        // export canvas == sequence (no letterbox): center fraction = 0.5 ± offset,
        // y flipped (GL +y is up; overlay y grows down).
        cx: 0.5 + t.x,
        cy: 0.5 - t.y,
    }
}

/// One ffmpeg `-i` input the region filtergraph references. Walking regions
/// (region 0 layers bottom→top, region 1 …) and skipping `src: None` layers
/// yields the input ordinal `input_idx` == the `[{k}:v]` label. BOTH
/// `build_filter_script_regions` and `input_args` consume this exact walk, so
/// the ordinals never drift.
pub(crate) struct LayerInput<'a> {
    pub region_idx: usize,
    pub layer_idx: usize,
    pub input_idx: usize,
    pub layer: &'a ExportLayer,
}

pub(crate) fn layer_inputs(regions: &[ExportRegion]) -> Vec<LayerInput<'_>> {
    let mut out = Vec::new();
    let mut input_idx = 0usize;
    for (ri, region) in regions.iter().enumerate() {
        for (li, layer) in region.layers.iter().enumerate() {
            if layer.src.is_none() && layer.title_png.is_none() {
                continue;
            }
            out.push(LayerInput { region_idx: ri, layer_idx: li, input_idx, layer });
            input_idx += 1;
        }
    }
    out
}

/// Temporal+spatial filtergraph: per region a composited `[vR]` (+ `[aR]`), then
/// the same concat tail as Phase-1. A region of one transform-identity layer (or
/// a gap) emits the VERBATIM Phase-1 chain → a no-transform export is byte-
/// identical. `lut_by_region_layer` is region-major, parallel to `regions`.
pub(crate) fn build_filter_script_regions(
    spec: &ExportSpec,
    regions: &[ExportRegion],
    lut_by_region_layer: &[Vec<Option<PathBuf>>],
    measured: Option<&LoudnormMeasured>,
    measure_mode: bool,
) -> String {
    let (w, h, fps) = (spec.width, spec.height, spec.fps);
    // (region, layer) ⇒ ffmpeg input ordinal — the SAME walk input_args uses.
    let mut idx_of: std::collections::HashMap<(usize, usize), usize> =
        std::collections::HashMap::new();
    for inp in layer_inputs(regions) {
        idx_of.insert((inp.region_idx, inp.layer_idx), inp.input_idx);
    }
    let lut_at = |ri: usize, li: usize| -> Option<&PathBuf> {
        lut_by_region_layer.get(ri).and_then(|v| v.get(li)).and_then(|p| p.as_ref())
    };

    let mut s = String::new();
    let mut any_graded = false;

    for (ri, region) in regions.iter().enumerate() {
        let n = (region.dur * fps).round() as i64;
        let drawn: Vec<usize> = region
            .layers
            .iter()
            .enumerate()
            .filter(|(_, l)| l.src.is_some() || l.title_png.is_some())
            .map(|(li, _)| li)
            .collect();

        // ── Video ──────────────────────────────────────────────────────────
        if drawn.is_empty() {
            // gap → black (Phase-1 gap video chain, label v{ri}).
            s.push_str(&format!(
                "color=black:size={w}x{h}:rate={fps},format=yuv420p,setsar=1,settb=AVTB,trim=end_frame={n}[v{ri}];\n",
            ));
        } else if drawn.len() == 1
            && is_identity_transform(&region.layers[drawn[0]].transform)
            && region.layers[drawn[0]].kf.is_none()
            && region.layers[drawn[0]].title_png.is_none()
        {
            // fast-path: the VERBATIM Phase-1 single-segment chain (byte-identical).
            // Excludes any animated layer (kf present) — its video/audio needs exprs.
            let li = drawn[0];
            let k = idx_of[&(ri, li)];
            let layer = &region.layers[li];
            if let Some(lut) = lut_at(ri, li) {
                any_graded = true;
                let m = layer.color_matrix.as_deref().unwrap_or("bt709");
                let r = layer.color_range.as_deref().unwrap_or("tv");
                s.push_str(&format!(
                    "[{k}:v]setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease:in_color_matrix={m}:in_range={r},format=gbrp,lut3d=file='{p}':interp=trilinear,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps},setsar=1,settb=AVTB,trim=end_frame={n}[v{ri}];\n",
                    p = lut.display()
                ));
            } else {
                s.push_str(&format!(
                    "[{k}:v]setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps},format=yuv420p,setsar=1,settb=AVTB,trim=end_frame={n}[v{ri}];\n",
                ));
            }
        } else {
            // composite: per-layer RGBA chain → overlay stack over a black base.
            for &li in &drawn {
                let layer = &region.layers[li];
                let k = idx_of[&(ri, li)];
                let g = layer_geom(w, h, layer);
                let mut chain = format!("[{k}:v]setpts=PTS-STARTPTS,");
                if let Some(crop) = &g.crop {
                    chain.push_str(crop);
                }
                chain.push_str(&format!("scale={fw}:{fh},", fw = g.fit_w, fh = g.fit_h));
                if let Some(lut) = lut_at(ri, li) {
                    any_graded = true;
                    let m = layer.color_matrix.as_deref().unwrap_or("bt709");
                    let r = layer.color_range.as_deref().unwrap_or("tv");
                    chain.push_str(&format!(
                        "format=gbrp,lut3d=file='{p}':interp=trilinear,scale=out_color_matrix=bt709:out_range=tv,",
                        p = lut.display()
                    ));
                }
                chain.push_str("format=rgba,");
                let kf = layer.kf.as_ref();
                // rotate: an animated angle expr (radians) overrides the static
                // angle; c=none → transparent corners; ow/oh = bounding box so the
                // rotated rect isn't clipped (overlay_w/h stay post-rotate).
                match kf.and_then(|x| x.rot.as_deref()) {
                    Some(expr) => chain.push_str(&format!(
                        "rotate='{expr}':c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)',"
                    )),
                    None => {
                        if g.rot_rad != 0.0 {
                            chain.push_str(&format!(
                                "rotate={rot:.6}:c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)',",
                                rot = g.rot_rad
                            ));
                        }
                    }
                }
                // opacity: an animated value can't ride colorchannelmixer (no time
                // var) → geq scales the alpha plane per frame (uppercase T); static
                // opacity stays on the cheap colorchannelmixer path.
                match kf.and_then(|x| x.opacity.as_deref()) {
                    Some(expr) => chain.push_str(&format!(
                        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*({expr}),0,255)',"
                    )),
                    None => {
                        if (g.opacity - 1.0).abs() > 1e-9 {
                            chain.push_str(&format!("colorchannelmixer=aa={a:.6},", a = g.opacity));
                        }
                    }
                }
                chain.push_str(&format!("setsar=1,settb=AVTB,trim=end_frame={n}[L{ri}_{li}];\n"));
                s.push_str(&chain);
            }
            s.push_str(&format!(
                "color=black:size={w}x{h}:rate={fps},format=rgba,setsar=1,settb=AVTB[base{ri}_0];\n",
            ));
            let m = drawn.len();
            for (j, &li) in drawn.iter().enumerate() {
                let layer = &region.layers[li];
                let g = layer_geom(w, h, layer);
                let kf = layer.kf.as_ref();
                // animated position → centre-fraction exprs + eval=frame; static →
                // the SF7 literal centre + eval=init (evaluated once).
                let overlay = match (kf.and_then(|x| x.pos_x.as_deref()), kf.and_then(|x| x.pos_y.as_deref())) {
                    (Some(px), Some(py)) => format!(
                        "overlay=x='(main_w*({px}))-(overlay_w/2)':y='(main_h*({py}))-(overlay_h/2)':eval=frame"
                    ),
                    _ => format!(
                        "overlay=x='(main_w*{cx:.6})-(overlay_w/2)':y='(main_h*{cy:.6})-(overlay_h/2)':eval=init",
                        cx = g.cx, cy = g.cy
                    ),
                };
                if j + 1 == m {
                    s.push_str(&format!(
                        "[base{ri}_{j}][L{ri}_{li}]{overlay},format=yuv420p,setsar=1,settb=AVTB,trim=end_frame={n}[v{ri}];\n",
                    ));
                } else {
                    s.push_str(&format!(
                        "[base{ri}_{j}][L{ri}_{li}]{overlay}[base{ri}_{next}];\n",
                        next = j + 1
                    ));
                }
            }
        }

        // ── Audio ──────────────────────────────────────────────────────────
        let audible: Vec<usize> = region
            .layers
            .iter()
            .enumerate()
            .filter(|(_, l)| l.src.is_some() && l.has_audio)
            .map(|(li, _)| li)
            .collect();
        if audible.is_empty() {
            s.push_str(&format!(
                "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration={dur},asetpts=PTS-STARTPTS[a{ri}];\n",
                dur = region.dur
            ));
        } else if audible.len() == 1 {
            // single audible layer → label directly (no amix → Phase-1 byte-identical).
            let li = audible[0];
            let k = idx_of[&(ri, li)];
            let layer = &region.layers[li];
            let kf = layer.kf.as_ref();
            let vol = match kf.and_then(|x| x.gain.as_deref()) {
                Some(expr) => format!("volume='{expr}':eval=frame"),
                None => format!("volume={}", layer.gain),
            };
            let inserts = segment_audio_inserts(spec.mixer.as_ref(), layer.track_id.as_deref(), kf.and_then(|x| x.track_vol.as_deref()));
            s.push_str(&format!(
                "[{k}:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,{vol}{inserts},atrim=duration={dur:.6},apad=whole_dur={dur:.6}[a{ri}];\n",
                dur = region.dur
            ));
        } else {
            // N≥2 → mix with normalize=0 (default amix divides by N, halving overlaps).
            for (j, &li) in audible.iter().enumerate() {
                let k = idx_of[&(ri, li)];
                let layer = &region.layers[li];
                let kf = layer.kf.as_ref();
                let vol = match kf.and_then(|x| x.gain.as_deref()) {
                    Some(expr) => format!("volume='{expr}':eval=frame"),
                    None => format!("volume={}", layer.gain),
                };
                let inserts = segment_audio_inserts(spec.mixer.as_ref(), layer.track_id.as_deref(), kf.and_then(|x| x.track_vol.as_deref()));
                s.push_str(&format!(
                    "[{k}:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,{vol}{inserts},atrim=duration={dur:.6},apad=whole_dur={dur:.6}[a{ri}_{j}];\n",
                    dur = region.dur
                ));
            }
            for j in 0..audible.len() {
                s.push_str(&format!("[a{ri}_{j}]"));
            }
            s.push_str(&format!("amix=inputs={n}:normalize=0[a{ri}];\n", n = audible.len()));
        }
    }

    for ri in 0..regions.len() {
        s.push_str(&format!("[v{ri}][a{ri}]"));
    }
    if any_graded {
        s.push_str(&format!(
            "concat=n={n}:v=1:a=1[catv][cona];\n[catv]setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[outv];\n{tail}",
            n = regions.len(),
            tail = master_audio_tail(spec, measured, measure_mode)
        ));
    } else {
        s.push_str(&format!(
            "concat=n={n}:v=1:a=1[outv][cona];\n{tail}",
            n = regions.len(),
            tail = master_audio_tail(spec, measured, measure_mode)
        ));
    }
    s
}

/// Dispatch to the Phase-1 segment path or the SF7 region path by `spec.regions`.
pub(crate) fn build_filter_script_for(
    spec: &ExportSpec,
    lut_paths: &LutPaths,
    measured: Option<&LoudnormMeasured>,
    measure_mode: bool,
) -> String {
    match &spec.regions {
        Some(regions) => {
            build_filter_script_regions(spec, regions, lut_paths.regions(), measured, measure_mode)
        }
        None => build_filter_script(spec, lut_paths.segments(), measured, measure_mode),
    }
}

/// The `-ss/-t/-i` input list — one per media segment (Phase-1) or per src-bearing
/// layer in region×layer order (SF7), shared by the encode argv and the loudnorm
/// measurement pass. The region walk == `layer_inputs` so labels stay in lockstep.
fn input_args(spec: &ExportSpec, title_paths: &[Vec<Option<PathBuf>>]) -> Vec<String> {
    let mut a = Vec::new();
    let push_video = |a: &mut Vec<String>, src: &str, src_in: f64, sto: f64, dur: f64| {
        let corrected = src_in + sto;
        a.push("-ss".into());
        a.push(format!("{corrected:.6}"));
        a.push("-t".into());
        a.push(format!("{:.6}", dur + 0.05));
        a.push("-i".into());
        a.push(src.to_string());
    };
    match &spec.regions {
        Some(regions) => {
            for li in layer_inputs(regions) {
                let l = li.layer;
                if let Some(src) = &l.src {
                    push_video(&mut a, src, l.src_in, l.start_time_offset, l.dur);
                } else if l.title_png.is_some() {
                    // Title = a looped still at the sequence fps (-framerate aligns
                    // it to the base; the chain's trim caps the exact length).
                    if let Some(p) = title_paths
                        .get(li.region_idx)
                        .and_then(|r| r.get(li.layer_idx))
                        .and_then(|p| p.as_ref())
                    {
                        a.push("-loop".into());
                        a.push("1".into());
                        a.push("-framerate".into());
                        a.push(format!("{}", spec.fps));
                        a.push("-t".into());
                        a.push(format!("{:.6}", l.dur + 0.05));
                        a.push("-i".into());
                        a.push(crate::tool_path::native_str(&p.display().to_string()));
                    }
                }
            }
        }
        None => {
            for seg in &spec.segments {
                if let Some(src) = &seg.src {
                    push_video(&mut a, src, seg.src_in, seg.start_time_offset, seg.dur);
                }
            }
        }
    }
    a
}

/// Parse ffmpeg's `loudnorm=print_format=json` block (emitted to stderr) into
/// the measured integrated-loudness values for the linear second pass.
fn parse_loudnorm_json(stderr: &str) -> Option<LoudnormMeasured> {
    let start = stderr.rfind('{')?;
    let rel_end = stderr[start..].rfind('}')?;
    let json = &stderr[start..start + rel_end + 1];
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).and_then(|s| s.parse::<f64>().ok());
    Some(LoudnormMeasured {
        input_i: get("input_i")?,
        input_tp: get("input_tp")?,
        input_lra: get("input_lra")?,
        input_thresh: get("input_thresh")?,
    })
}

/// Pass 1 of two-pass loudnorm: run the PROCESSED audio (the full mixer chain)
/// through `loudnorm` in measurement mode and parse the JSON. Maps only [outa]
/// to a null muxer — decode + filter, no encode. None on any failure (the caller
/// falls back to single-pass dynamic).
async fn measure_loudnorm(spec: &ExportSpec, lut_paths: &LutPaths, title_paths: &[Vec<Option<PathBuf>>]) -> Option<LoudnormMeasured> {
    let script = build_filter_script_for(spec, lut_paths, None, true);
    let path = std::env::temp_dir().join(format!(
        "vedit-measure-{}.txt",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::write(&path, &script).ok()?;
    let mut argv = vec!["-hide_banner".to_string(), "-nostats".to_string()];
    argv.extend(input_args(spec, title_paths));
    argv.extend([
        "-filter_complex_script".into(),
        path.to_string_lossy().to_string(),
        "-map".into(),
        "[outa]".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    let out = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg")).args(&argv).output().await.ok();
    let _ = fs::remove_file(&path);
    parse_loudnorm_json(&String::from_utf8_lossy(&out?.stderr))
}

// ── Delivery & Presets (SF3) — encoder / quality / container argv ─────────────

/// Auto-fallback order per codec family (software-first for quality, then NVENC
/// / QSV / AMF, then a software fallback). Walked against the probe caps.
fn encoder_chain(codec: &str) -> &'static [&'static str] {
    match codec {
        "h264" => &["libx264", "h264_nvenc", "h264_qsv", "h264_amf", "libopenh264"],
        "hevc" => &["libx265", "hevc_nvenc", "hevc_qsv", "hevc_amf"],
        "vp9" => &["libvpx-vp9"],
        "av1" => &["libsvtav1", "av1_nvenc", "av1_qsv", "av1_amf"],
        _ => &[],
    }
}

/// Resolve an `EncodeSpec` to a concrete working encoder. An explicit
/// `enc.encoder` (Custom) wins when the caps say it works; otherwise the codec's
/// chain is walked for the first available. None → nothing in the chain works
/// (the caller surfaces a remediation error).
pub(crate) fn resolve_export_encoder(enc: &EncodeSpec, caps: &EncoderCaps) -> Option<String> {
    let ok = |name: &str| caps.encoders.get(name).copied().unwrap_or(false);
    if let Some(explicit) = enc.encoder.as_deref() {
        if ok(explicit) {
            return Some(explicit.to_string());
        }
    }
    encoder_chain(&enc.codec)
        .iter()
        .find(|c| ok(c))
        .map(|c| (*c).to_string())
}

/// Map unified quality (0–100, higher = better) to an encoder's native quality
/// value over [0, rmax] (lower native = better). q=65, rmax=51 → 18 (the
/// Phase-1 libx264 CRF), so the default presets match today's output.
fn quality_to_native(q: u32, rmax: u32) -> u32 {
    let q = q.min(100);
    ((100 - q) * rmax + 50) / 100
}

/// `-c:v <enc>` + the encoder's rate-control flags. An explicit `bitrate_kbps`
/// selects the encoder's VBR/bitrate mode; otherwise unified quality maps to the
/// encoder's quality control (CRF / CQ / global_quality / QP).
fn video_encode_args(encoder: &str, quality: u32, bitrate_kbps: Option<u32>) -> Vec<String> {
    let mut a = vec!["-c:v".to_string(), encoder.to_string()];
    if let Some(kbps) = bitrate_kbps {
        let br = format!("{kbps}k");
        match encoder {
            "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => {
                a.extend(["-rc".into(), "vbr".into(), "-b:v".into(), br]);
            }
            "h264_amf" | "hevc_amf" | "av1_amf" => {
                a.extend(["-rc".into(), "vbr_latency".into(), "-b:v".into(), br]);
            }
            // libx264/x265, svtav1, vp9, qsv, openh264: plain target bitrate.
            _ => a.extend(["-b:v".into(), br]),
        }
        return a;
    }
    match encoder {
        "libx264" | "libx265" => a.extend([
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            quality_to_native(quality, 51).to_string(),
        ]),
        "libsvtav1" => a.extend([
            "-preset".into(),
            "8".into(),
            "-crf".into(),
            quality_to_native(quality, 63).to_string(),
        ]),
        "libvpx-vp9" => a.extend([
            "-b:v".into(),
            "0".into(),
            "-crf".into(),
            quality_to_native(quality, 63).to_string(),
        ]),
        "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => a.extend([
            "-rc".into(),
            "vbr".into(),
            "-cq".into(),
            quality_to_native(quality, 51).to_string(),
        ]),
        "h264_qsv" | "hevc_qsv" | "av1_qsv" => {
            a.extend(["-global_quality".into(), quality_to_native(quality, 51).to_string()])
        }
        "h264_amf" | "hevc_amf" | "av1_amf" => {
            let qp = quality_to_native(quality, 51).to_string();
            a.extend([
                "-rc".into(),
                "cqp".into(),
                "-qp_i".into(),
                qp.clone(),
                "-qp_p".into(),
                qp.clone(),
                "-qp_b".into(),
                qp,
            ]);
        }
        // libopenh264 is bitrate-only — estimate from quality (last-resort sw fallback).
        "libopenh264" => {
            let kbps = 2000 + quality.min(100) * 60;
            a.extend(["-b:v".into(), format!("{kbps}k")]);
        }
        _ => a.extend(["-crf".into(), quality_to_native(quality, 51).to_string()]),
    }
    a
}

/// `-c:a <codec> -b:a <kbps>k`. WebM gets Opus; every other container AAC.
fn audio_encode_args(container: &str, audio_kbps: u32) -> Vec<String> {
    let codec = if container == "webm" { "libopus" } else { "aac" };
    vec!["-c:a".into(), codec.into(), "-b:a".into(), format!("{audio_kbps}k")]
}

/// Container/muxer tail (+ progress reporting). The mp4 branch is byte-identical
/// to the Phase-1 tail; webm drops faststart and pins yuv420p.
fn container_muxer_args(container: &str, partial: &str) -> Vec<String> {
    let mut a: Vec<String> = if container == "webm" {
        vec!["-pix_fmt".into(), "yuv420p".into(), "-f".into(), "webm".into()]
    } else {
        vec!["-movflags".into(), "+faststart".into(), "-f".into(), "mp4".into()]
    };
    a.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-stats_period".into(),
        "0.25".into(),
        partial.into(),
    ]);
    a
}

/// One accurate `-ss <in> -t <dur+slack> -i <src>` per media segment
/// (decode-discard while re-encoding), srcIn corrected by startTimeOffset
/// here. `-t` carries +0.05 s slack so the demuxer never under-delivers the
/// last frame; the filter graph's frame-domain caps cut back to exact length.
///
/// `video_encoder` is the SF3-resolved encoder for `spec.encode`; None → the
/// byte-identical Phase-1 libx264 path (the source-match preset sends no encode).
pub(crate) fn build_export_argv(
    spec: &ExportSpec,
    title_paths: &[Vec<Option<PathBuf>>],
    filter_script: &str,
    partial: &str,
    video_encoder: Option<&str>,
) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostats".into(),
    ];
    argv.extend(input_args(spec, title_paths));
    argv.extend([
        "-filter_complex_script".into(),
        filter_script.into(),
        "-map".into(),
        "[outv]".into(),
        "-map".into(),
        "[outa]".into(),
    ]);
    match (spec.encode.as_ref(), video_encoder) {
        (Some(enc), Some(vid)) => {
            argv.extend(video_encode_args(vid, enc.quality.unwrap_or(65), enc.bitrate_kbps));
            argv.extend(audio_encode_args(&enc.container, enc.audio_bitrate_kbps.unwrap_or(192)));
        }
        // None encode (or an unresolved encoder) → the byte-identical Phase-1 encode.
        _ => argv.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "18".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]),
    }
    // ≥1 graded segment/layer → those were normalized to bt709/tv by the lut3d
    // sandwich, so tag the container to match. Zero grades → argv stays
    // byte-identical to Phase 1 (tagging unconverted passthrough content
    // would mis-tag SD bt601 sources).
    let any_graded = match &spec.regions {
        Some(rs) => rs.iter().any(|r| r.layers.iter().any(|l| l.lut.is_some())),
        None => spec.segments.iter().any(|s| s.lut.is_some()),
    };
    if any_graded {
        argv.extend([
            "-colorspace".into(),
            "bt709".into(),
            "-color_primaries".into(),
            "bt709".into(),
            "-color_trc".into(),
            "bt709".into(),
            "-color_range".into(),
            "tv".into(),
        ]);
    }
    let container = spec.encode.as_ref().map_or("mp4", |e| e.container.as_str());
    argv.extend(container_muxer_args(container, partial));
    argv
}

// ── Delivery & Presets (sub-plan 7) ──────────────────────────────────────────
// Runtime encoder capability probe. The GPU & Codec Spike proved `ffmpeg
// -encoders` LISTS encoders that can't initialize (HW encoders with no GPU /
// driver present), so every candidate is 1-frame test-encoded against a
// synthetic lavfi source — the only truthful signal. Each test-encode is
// time-boxed so a wedged HW encoder can't stall the probe. SF2 wraps this in a
// path+version-keyed disk cache.

/// Every encoder the export matrix can emit, grouped by family in auto-fallback
/// order (software-first for quality, then NVENC / QSV / AMF, then a software
/// fallback). The probe reports each as available or not; `encode_args` (SF3)
/// walks these orders to resolve a codec to a working encoder.
const PROBE_VIDEO_ENCODERS: &[&str] = &[
    "libx264", "h264_nvenc", "h264_qsv", "h264_amf", "libopenh264",
    "libx265", "hevc_nvenc", "hevc_qsv", "hevc_amf",
    "libvpx-vp9",
    "libsvtav1", "av1_nvenc", "av1_qsv", "av1_amf",
];
const PROBE_AUDIO_ENCODERS: &[&str] = &["aac", "libopus"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncoderCaps {
    /// encoder name → did a 1-frame test-encode succeed.
    pub encoders: std::collections::BTreeMap<String, bool>,
    pub ffmpeg_path: String,
    pub ffmpeg_version: String,
}

/// First line of `ffmpeg -version` (an SF2 cache-key component); "" on failure.
async fn ffmpeg_version_line(ffmpeg: &str) -> String {
    match tokio::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-version"])
        .output()
        .await
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string(),
        Err(_) => String::new(),
    }
}

/// Run one ffmpeg invocation to a null muxer, time-boxed. true = clean exit 0.
async fn probe_test_encode(ffmpeg: &str, args: &[&str]) -> bool {
    let child = tokio::process::Command::new(ffmpeg)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(_) => return false,
    };
    match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => status.success(),
        Ok(Err(_)) => false,
        Err(_) => {
            // Timed out — a wedged encoder. Kill it and report unavailable.
            let _ = child.start_kill();
            false
        }
    }
}

/// Test-encode every matrix encoder against a 1-frame (video) / 0.1 s (audio)
/// synthetic source. The truthful capability map behind the preset system.
async fn run_encoder_probe() -> EncoderCaps {
    let ffmpeg = crate::tool_path::resolve("ffmpeg");
    let ffmpeg_version = ffmpeg_version_line(&ffmpeg).await;
    let mut encoders = std::collections::BTreeMap::new();
    for enc in PROBE_VIDEO_ENCODERS {
        let ok = probe_test_encode(
            &ffmpeg,
            &[
                "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1",
                "-frames:v", "1", "-c:v", enc, "-f", "null", "-",
            ],
        )
        .await;
        encoders.insert((*enc).to_string(), ok);
    }
    for enc in PROBE_AUDIO_ENCODERS {
        let ok = probe_test_encode(
            &ffmpeg,
            &[
                "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-t", "0.1", "-c:a", enc, "-f", "null", "-",
            ],
        )
        .await;
        encoders.insert((*enc).to_string(), ok);
    }
    EncoderCaps { encoders, ffmpeg_path: ffmpeg, ffmpeg_version }
}

/// Path of the probe cache: a serialized `EncoderCaps` keyed (by its own
/// `ffmpeg_path` + `ffmpeg_version` fields) to the ffmpeg it was measured
/// against. Lives beside the other app-config stores (sidebar.json, etc.).
fn caps_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, VaultError> {
    Ok(super::sidebar::app_config_root(app)?.join("video-export-caps.json"))
}

/// Encoder caps with the SF2 disk cache: returns the cached verdict when the
/// resolved ffmpeg path + version still match; otherwise (or when `force`)
/// re-runs the full test-encode probe and rewrites the cache. The cheap `ffmpeg
/// -version` call is the invalidation key — an upgraded or relocated ffmpeg
/// re-probes automatically; a GPU/driver swap needs `force`. Shared by the probe
/// command (SF1–SF2) and the export path (SF3).
pub(crate) async fn caps_cached(app: &tauri::AppHandle, force: bool) -> EncoderCaps {
    let ffmpeg = crate::tool_path::resolve("ffmpeg");
    let cache_path = caps_cache_path(app).ok();
    if !force {
        if let Some(cp) = &cache_path {
            if let Ok(txt) = fs::read_to_string(cp) {
                if let Ok(cached) = serde_json::from_str::<EncoderCaps>(&txt) {
                    let version = ffmpeg_version_line(&ffmpeg).await;
                    if cached.ffmpeg_path == ffmpeg && cached.ffmpeg_version == version {
                        return cached;
                    }
                }
            }
        }
    }
    let caps = run_encoder_probe().await;
    // Best-effort cache write — the probe result still returns if the write fails.
    if let Some(cp) = &cache_path {
        if let Ok(txt) = serde_json::to_string_pretty(&caps) {
            let _ = fs::write(cp, txt);
        }
    }
    caps
}

/// Runtime encoder capability probe (Delivery & Presets SF1–SF2).
#[tauri::command]
pub async fn vedit_encoder_probe(
    app: tauri::AppHandle,
    force: bool,
) -> Result<EncoderCaps, VaultError> {
    Ok(caps_cached(&app, force).await)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SmokeResult {
    pub codec: String,
    pub encoder: Option<String>,
    pub ok: bool,
    pub detail: String,
}

/// Delivery & Presets SF9 (DEV) — end-to-end encode smoke across the built-in
/// codec families, exercising the REAL `resolve_export_encoder` + `video_encode_
/// args` + `audio_encode_args` against a 1 s synthetic source, then ffprobing the
/// result's codec tag. A family with no available encoder reports ok:false /
/// "no available encoder" (skipped, not a hard fail).
#[tauri::command]
pub async fn vedit_encode_smoke(app: tauri::AppHandle) -> Result<Vec<SmokeResult>, VaultError> {
    let caps = caps_cached(&app, false).await;
    let ffmpeg = crate::tool_path::resolve("ffmpeg");
    let ffprobe = crate::tool_path::resolve("ffprobe");
    let cases: &[(&str, &str)] = &[("h264", "mp4"), ("hevc", "mp4"), ("av1", "mp4"), ("vp9", "webm")];
    let mut out = Vec::new();
    for (codec, container) in cases {
        let enc_spec = EncodeSpec {
            container: (*container).to_string(),
            codec: (*codec).to_string(),
            encoder: None,
            quality: Some(65),
            bitrate_kbps: None,
            audio_bitrate_kbps: None,
        };
        let Some(encoder) = resolve_export_encoder(&enc_spec, &caps) else {
            out.push(SmokeResult {
                codec: (*codec).to_string(),
                encoder: None,
                ok: false,
                detail: "no available encoder".into(),
            });
            continue;
        };
        let tmp = std::env::temp_dir().join(format!("vedit-smoke-{codec}.{container}"));
        let mut argv: Vec<String> = vec![
            "-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(),
            "-f".into(), "lavfi".into(), "-i".into(), "testsrc2=size=320x240:rate=30:duration=1".into(),
            "-f".into(), "lavfi".into(), "-i".into(), "sine=frequency=440:duration=1".into(),
        ];
        argv.extend(video_encode_args(&encoder, 65, None));
        argv.extend(audio_encode_args(container, 128));
        if *container == "webm" {
            argv.extend(["-pix_fmt".into(), "yuv420p".into(), "-f".into(), "webm".into()]);
        } else {
            argv.extend(["-movflags".into(), "+faststart".into(), "-f".into(), "mp4".into()]);
        }
        argv.push(tmp.to_string_lossy().to_string());
        let status = tokio::process::Command::new(&ffmpeg)
            .args(&argv)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        let (ok, detail) = match status {
            Ok(s) if s.success() => {
                let probe = tokio::process::Command::new(&ffprobe)
                    .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"])
                    .arg(&tmp)
                    .output()
                    .await;
                let got = probe
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default();
                (got == *codec, format!("{encoder} → {got}"))
            }
            _ => (false, format!("{encoder} encode failed")),
        };
        let _ = fs::remove_file(&tmp);
        out.push(SmokeResult { codec: (*codec).to_string(), encoder: Some(encoder), ok, detail });
    }
    Ok(out)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExportState {
    Idle,
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportStatus {
    pub state: ExportState,
    pub pct: f64,
    pub out_time_us: i64,
    pub total_us: i64,
    pub speed: Option<f64>,
    pub eta_secs: Option<i64>,
    pub error: Option<String>,
    pub output_path: Option<String>,
    #[serde(skip)]
    pub child_pid: Option<u32>,
    #[serde(skip)]
    pub cancel_requested: bool,
    #[serde(skip)]
    pub partial_path: Option<String>,
    /// LUT temps + filter script for this run — removed by the monitor task
    /// on every exit and by shutdown_export on app quit.
    #[serde(skip)]
    pub temp_paths: Vec<String>,
}

static EXPORT: Mutex<Option<ExportStatus>> = Mutex::new(None);

#[cfg(unix)]
fn export_signal(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

fn emit_export(app: &tauri::AppHandle, event: &str) {
    let snap = EXPORT.lock().unwrap().clone();
    if let Some(s) = snap {
        let _ = app.emit(event, s);
    }
}

#[tauri::command]
pub async fn vedit_export_start(app: tauri::AppHandle, spec: ExportSpec) -> Result<(), VaultError> {
    let has_regions = spec.regions.as_ref().map_or(false, |r| !r.is_empty());
    if spec.segments.is_empty() && !has_regions {
        return Err(VaultError::Invalid("nothing to export — the timeline is empty".into()));
    }
    // Delivery & Presets SF3: resolve the export encoder from the probe caps
    // before any work. None encode → the byte-identical Phase-1 path; an
    // unresolvable codec errors here (the JS remediation banner should prevent
    // reaching this, but defend so a bad preset never spawns a doomed ffmpeg).
    let resolved_encoder: Option<String> = if let Some(enc) = spec.encode.as_ref() {
        let caps = caps_cached(&app, false).await;
        match resolve_export_encoder(enc, &caps) {
            Some(name) => Some(name),
            None => {
                return Err(VaultError::Invalid(format!(
                    "no available encoder for codec '{}' — open Export presets to re-probe, or install an ffmpeg that has it",
                    enc.codec
                )));
            }
        }
    } else {
        None
    };
    let total_secs: f64 = match &spec.regions {
        Some(rs) => rs.iter().map(|r| r.dur).sum(),
        None => spec.segments.iter().map(|s| s.dur).sum(),
    };
    let total_us = (total_secs * 1_000_000.0) as i64;
    let partial = format!("{}.partial", spec.output_path);
    {
        let mut g = EXPORT.lock().unwrap();
        if matches!(g.as_ref().map(|s| &s.state), Some(ExportState::Running)) {
            return Err(VaultError::Invalid("an export is already running".into()));
        }
        *g = Some(ExportStatus {
            state: ExportState::Running,
            pct: 0.0,
            out_time_us: 0,
            total_us,
            speed: None,
            eta_secs: None,
            error: None,
            output_path: Some(spec.output_path.clone()),
            child_pid: None,
            cancel_requested: false,
            partial_path: Some(partial.clone()),
            temp_paths: Vec::new(),
        });
    }

    let (lut_paths, mut lut_files) = match materialize_luts(&spec) {
        Ok(v) => v,
        Err(e) => {
            *EXPORT.lock().unwrap() = None;
            return Err(e);
        }
    };
    // SF11: rasterized title PNGs (region-major). Their temps join lut_files so
    // every existing cleanup path removes them too.
    let (title_paths, title_files) = match materialize_titles(&spec) {
        Ok(v) => v,
        Err(e) => {
            for f in &lut_files {
                let _ = fs::remove_file(f);
            }
            *EXPORT.lock().unwrap() = None;
            return Err(e);
        }
    };
    lut_files.extend(title_files);
    // Two-pass loudnorm: measure the processed audio first when enabled (decode
    // + filter only, no encode). Falls back to single-pass dynamic on failure.
    let loud_enabled = spec.mixer.as_ref().map_or(false, |m| m.master.loudnorm.enabled);
    let measured = if loud_enabled { measure_loudnorm(&spec, &lut_paths, &title_paths).await } else { None };
    // A cancel may have arrived during the measurement pass.
    if EXPORT.lock().unwrap().as_ref().map(|s| s.cancel_requested).unwrap_or(false) {
        for f in &lut_files {
            let _ = fs::remove_file(f);
        }
        if let Some(s) = EXPORT.lock().unwrap().as_mut() {
            s.state = ExportState::Cancelled;
        }
        emit_export(&app, "vedit-export-progress");
        return Ok(());
    }
    let script = build_filter_script_for(&spec, &lut_paths, measured.as_ref(), false);
    let filter_path = std::env::temp_dir().join(format!(
        "vedit-filter-{}.txt",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    if let Err(e) = fs::write(&filter_path, &script) {
        for f in &lut_files {
            let _ = fs::remove_file(f);
        }
        *EXPORT.lock().unwrap() = None;
        return Err(VaultError::Io(format!("filter script: {e}")));
    }
    if let Some(s) = EXPORT.lock().unwrap().as_mut() {
        s.temp_paths = lut_files.iter().map(|p| p.display().to_string()).collect();
        s.temp_paths.push(filter_path.display().to_string());
    }
    let argv = build_export_argv(
        &spec,
        &title_paths,
        &filter_path.to_string_lossy(),
        &partial,
        resolved_encoder.as_deref(),
    );

    let mut child = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg"))
        .args(&argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            let _ = fs::remove_file(&filter_path);
            for f in &lut_files {
                let _ = fs::remove_file(f);
            }
            *EXPORT.lock().unwrap() = None;
            VaultError::Io(format!("ffmpeg spawn failed: {e}"))
        })?;

    if let Some(pid) = child.id() {
        if let Some(s) = EXPORT.lock().unwrap().as_mut() {
            s.child_pid = Some(pid);
        }
    }
    emit_export(&app, "vedit-export-progress");

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_path = spec.output_path.clone();
    let partial_clone = partial.clone();
    let filter_clone = filter_path.clone();

    // stderr tail collector (last 40 lines) for the error state.
    let tail: std::sync::Arc<Mutex<Vec<String>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
    if let Some(err) = stderr {
        let tail = tail.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut t = tail.lock().unwrap();
                t.push(line);
                let drop_n = t.len().saturating_sub(40);
                if drop_n > 0 {
                    t.drain(0..drop_n);
                }
            }
        });
    }

    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        if let Some(out) = stdout {
            let mut lines = tokio::io::BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut dirty = false;
                {
                    let mut g = EXPORT.lock().unwrap();
                    let Some(s) = g.as_mut() else { break };
                    if let Some(v) = line.strip_prefix("out_time_us=") {
                        // NB: ffmpeg's `out_time_ms` key is ALSO microseconds
                        // (ffmpeg bug 7345) — out_time_us is the unambiguous one.
                        if let Ok(us) = v.trim().parse::<i64>() {
                            s.out_time_us = us.max(0);
                            if s.total_us > 0 {
                                s.pct = (s.out_time_us as f64 / s.total_us as f64).clamp(0.0, 1.0);
                            }
                            dirty = true;
                        }
                    } else if let Some(v) = line.strip_prefix("speed=") {
                        let sp = v.trim().trim_end_matches('x').parse::<f64>().ok();
                        s.speed = sp.filter(|x| *x > 0.0);
                        if let Some(sp) = s.speed {
                            let remain_us = (s.total_us - s.out_time_us).max(0);
                            s.eta_secs = Some(((remain_us as f64 / 1_000_000.0) / sp).ceil() as i64);
                        }
                        dirty = true;
                    }
                }
                if dirty {
                    emit_export(&app, "vedit-export-progress");
                }
            }
        }
        let exit_ok = matches!(child.wait().await.map(|st| st.success()), Ok(true));
        let cancelled = EXPORT
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.cancel_requested)
            .unwrap_or(false);
        let _ = fs::remove_file(&filter_clone);
        for f in &lut_files {
            let _ = fs::remove_file(f);
        }
        if exit_ok && !cancelled {
            let renamed = fs::rename(&partial_clone, &out_path);
            let mut g = EXPORT.lock().unwrap();
            if let Some(s) = g.as_mut() {
                match renamed {
                    Ok(()) => {
                        s.state = ExportState::Done;
                        s.pct = 1.0;
                    }
                    Err(e) => {
                        s.state = ExportState::Error;
                        s.error = Some(format!("rename failed: {e}"));
                    }
                }
            }
        } else {
            let _ = fs::remove_file(&partial_clone);
            let mut g = EXPORT.lock().unwrap();
            if let Some(s) = g.as_mut() {
                if cancelled {
                    s.state = ExportState::Cancelled;
                } else {
                    s.state = ExportState::Error;
                    let t = tail.lock().unwrap();
                    s.error = Some(if t.is_empty() {
                        "ffmpeg failed".into()
                    } else {
                        t.join("\n")
                    });
                }
            }
        }
        emit_export(&app, "vedit-export-done");
    });

    Ok(())
}

/// Flag + SIGTERM → 2 s grace → SIGKILL (anime_download cancel pattern).
#[tauri::command]
pub fn vedit_export_cancel() {
    let pid = {
        let mut g = EXPORT.lock().unwrap();
        match g.as_mut() {
            Some(s) if s.state == ExportState::Running => {
                s.cancel_requested = true;
                s.child_pid
            }
            _ => None,
        }
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        export_signal(pid, libc::SIGTERM);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            export_signal(pid, libc::SIGKILL);
        });
    }
    #[cfg(not(unix))]
    if let Some(pid) = pid {
        crate::commands::proc_util::terminate_pid(pid);
    }
}

/// Remount re-sync: the dialog adopts a job that survived navigation.
#[tauri::command]
pub fn vedit_export_status() -> Option<ExportStatus> {
    EXPORT.lock().unwrap().clone()
}

/// DEV parity harness (Color Grading SF5): render ONE frame of `src` at
/// `time` through the EXACT export color pipeline — pinned
/// in_color_matrix/in_range, optional 33³ lut3d with interp=trilinear, no
/// geometric scale — to a lossless PNG returned as raw bytes
/// (tauri::ipc::Response; no base64 dep). The in-app ParityPanel diffs this
/// against the WebGL preview path pixel-for-pixel. Same picker-class trust
/// boundary as vedit_probe: arbitrary absolute paths are deliberate — the
/// DEV panel is the consent boundary, and /media still won't serve them.
#[tauri::command]
pub async fn vedit_parity_render(
    src: String,
    time: f64,
    cube_text: Option<String>,
    color_matrix: String,
    color_range: String,
) -> Result<tauri::ipc::Response, VaultError> {
    let canonical = canonical_file(&src)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut lut_path: Option<PathBuf> = None;
    if let Some(text) = cube_text.as_deref().filter(|t| !t.is_empty()) {
        let p = std::env::temp_dir().join(format!("vedit-parity-{stamp}.cube"));
        fs::write(&p, text).map_err(|e| VaultError::Io(format!("parity lut write: {e}")))?;
        lut_path = Some(p);
    }
    let out_png = std::env::temp_dir().join(format!("vedit-parity-{stamp}.png"));
    // setparams=unknown strips frame-level color props before the PNG encoder:
    // ffmpeg >= 6.1 otherwise writes cICP/cHRM/gAMA chunks from tagged sources,
    // and WebKit's PNG decoder color-adapts on them (BT.1886 -> sRGB, ~+6 mean /
    // 13 p99 on 8-bit), silently corrupting the parity reference. Pixels are
    // unaffected — metadata-only.
    const STRIP: &str = "setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown";
    let vf = match &lut_path {
        Some(p) => format!(
            "scale=in_color_matrix={m}:in_range={r},format=gbrp,lut3d=file='{p}':interp=trilinear,format=rgb24,{STRIP}",
            m = color_matrix,
            r = color_range,
            p = p.display()
        ),
        None => format!(
            "scale=in_color_matrix={m}:in_range={r},format=rgb24,{STRIP}",
            m = color_matrix,
            r = color_range
        ),
    };
    let result = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg"))
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-ss",
            &format!("{time:.6}"),
            "-i",
            &canonical.display().to_string(),
            "-frames:v",
            "1",
            "-vf",
            &vf,
            "-f",
            "image2",
            "-update",
            "1",
        ])
        .arg(&out_png)
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("ffmpeg spawn failed: {e}")));
    if let Some(p) = &lut_path {
        let _ = fs::remove_file(p);
    }
    let out = result?;
    if !out.status.success() {
        let _ = fs::remove_file(&out_png);
        return Err(VaultError::Io(format!(
            "parity render failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let bytes = fs::read(&out_png).map_err(|e| VaultError::Io(format!("parity png read: {e}")))?;
    let _ = fs::remove_file(&out_png);
    Ok(tauri::ipc::Response::new(bytes))
}

/// SF12 — DEV compositing parity probe. Renders ONE composited frame of a mini
/// 1-region spec through the REAL shipping codegen (build_filter_script_regions
/// + input_args) to a PNG, which the panel diffs against the WebGL
/// renderComposite of the same layers. The battery uses still-image layers
/// (title_png), so GL and ffmpeg composite byte-identical source pixels — this
/// tests the overlay/rotate/opacity/crop/multi-layer codegen (the video-decode
/// fit scalar is covered by the SF7 unit tests). Static sources → frame 0
/// suffices (no frame-addressing). Returns raw PNG bytes (no base64 dep).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositeParitySpec {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub layers: Vec<ExportLayer>,
}

#[tauri::command]
pub async fn vedit_composite_parity(
    spec: CompositeParitySpec,
) -> Result<tauri::ipc::Response, VaultError> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let export_spec = ExportSpec {
        segments: vec![],
        width: spec.width,
        height: spec.height,
        fps: spec.fps,
        master_volume: 1.0,
        output_path: String::new(),
        mixer: None,
        regions: Some(vec![ExportRegion {
            dur: 2.0 / spec.fps.max(1.0),
            layers: spec.layers,
        }]),
        encode: None,
    };
    let regions = export_spec.regions.as_ref().unwrap();
    let (lut_paths, lut_files) = materialize_luts(&export_spec)?;
    let (title_paths, title_files) = match materialize_titles(&export_spec) {
        Ok(v) => v,
        Err(e) => {
            for f in &lut_files {
                let _ = fs::remove_file(f);
            }
            return Err(e);
        }
    };
    let mut temps: Vec<PathBuf> = lut_files;
    temps.extend(title_files);
    let script = build_filter_script_regions(&export_spec, regions, lut_paths.regions(), None, false);
    let script_path = std::env::temp_dir().join(format!("vedit-cparity-{stamp}.txt"));
    let out_png = std::env::temp_dir().join(format!("vedit-cparity-{stamp}.png"));
    if let Err(e) = fs::write(&script_path, &script) {
        for f in &temps {
            let _ = fs::remove_file(f);
        }
        return Err(VaultError::Io(format!("cparity script: {e}")));
    }
    let mut argv: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostats".into(),
    ];
    argv.extend(input_args(&export_spec, &title_paths));
    argv.extend([
        "-filter_complex_script".into(),
        script_path.to_string_lossy().to_string(),
        "-map".into(),
        "[outv]".into(),
        "-frames:v".into(),
        "1".into(),
        "-f".into(),
        "image2".into(),
        "-update".into(),
        "1".into(),
    ]);
    argv.push(out_png.to_string_lossy().to_string());
    // The shared export graph always emits a master [outa]; a labeled filtergraph
    // output pad must be consumed or ffmpeg aborts ("[outa] unconnected"). We only
    // want the PNG, so sink the (region-bounded, finite) audio to null — same idiom
    // as measure_loudnorm / parity_measure_graph.
    argv.extend([
        "-map".into(),
        "[outa]".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    let result = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg"))
        .args(&argv)
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("ffmpeg spawn failed: {e}")));
    let _ = fs::remove_file(&script_path);
    for f in &temps {
        let _ = fs::remove_file(f);
    }
    let out = result?;
    if !out.status.success() {
        let _ = fs::remove_file(&out_png);
        return Err(VaultError::Io(format!(
            "composite parity failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let bytes = fs::read(&out_png).map_err(|e| VaultError::Io(format!("cparity png read: {e}")))?;
    let _ = fs::remove_file(&out_png);
    Ok(tauri::ipc::Response::new(bytes))
}

// ── DEV audio parity harness (Audio Post SF8) ──────────────────────────────
// The golden-mix STOP gate: prove the preview Web Audio mixer == the export
// ffmpeg filter chain. Per cell the panel sends a fixture (inline lavfi audio
// sources) + a mixer; this renders it TWO ways to 48 kHz stereo pcm_f32le WAV —
//   source  the bare lavfi (clean, pre-mixer) → fed to the OfflineAudioContext
//           mirror on the JS side;
//   export  the SAME lavfi through the REAL shared export builders
//           (segment_audio_inserts + master_audio_tail) → the golden reference.
// Reusing the shipping builders is what makes the test valid (it exercises the
// real code path, not a re-implementation). For a loudnorm-enabled cell the
// export runs the real two-pass and the output's integrated loudness is measured
// back via loudnorm:print_format=json (the JS side gates it at ±1 LU).
//
// Output (no base64 dep — like vedit_parity_render returns raw bytes): one packed
// buffer via tauri::ipc::Response —
//   [u64 LE source_len][u64 LE export_len][f64 LE lufs (NaN = not measured)]
//   ++ source WAV ++ export WAV.
// Trust boundary: fixtures synthesize from JS-provided lavfi source strings and
// touch NO user path — there is nothing to is_under_allowed_root. DEV-only (the
// AudioParityPanel mount is import.meta.env.DEV-gated).

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioParitySeg {
    /// An ffmpeg lavfi audio SOURCE string incl. its own duration, e.g.
    /// "sine=frequency=440:sample_rate=48000:duration=3".
    pub source: String,
    pub dur: f64,
    #[serde(default = "one")]
    pub gain: f64,
    #[serde(default)]
    pub track_id: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioParitySpec {
    pub segments: Vec<AudioParitySeg>,
    #[serde(default = "one")]
    pub master_volume: f64,
    #[serde(default)]
    pub mixer: Option<Mixer>,
    /// Force the export's integrated-LUFS measurement even when loudnorm is off
    /// (the loudnorm cell triggers it implicitly via mixer.master.loudnorm).
    #[serde(default)]
    pub measure_lufs: bool,
}

/// Minimal ExportSpec the shared insert/tail builders read (they consult only
/// track_id / gain / mixer / master_volume — never src/dimensions).
fn audio_parity_export_spec(p: &AudioParitySpec) -> ExportSpec {
    ExportSpec {
        segments: p
            .segments
            .iter()
            .map(|s| ExportSegment {
                src: None,
                src_in: 0.0,
                dur: s.dur,
                gain: s.gain,
                has_audio: true,
                start_time_offset: 0.0,
                lut: None,
                color_matrix: None,
                color_range: None,
                track_id: s.track_id.clone(),
            })
            .collect(),
        width: 2,
        height: 2,
        fps: 30.0,
        master_volume: p.master_volume,
        output_path: String::new(),
        mixer: p.mixer.clone(),
        regions: None,
        encode: None,
    }
}

/// SOURCE graph: bare lavfi → aformat → atrim/apad → concat[outa]. No gain, no
/// inserts, no master — the JS mirror applies all of those itself.
fn audio_parity_source_graph(spec: &ExportSpec, sources: &[String]) -> String {
    let mut s = String::new();
    for (i, seg) in spec.segments.iter().enumerate() {
        s.push_str(&format!(
            "{src},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration={dur:.6},apad=whole_dur={dur:.6}[a{i}];\n",
            src = sources[i],
            dur = seg.dur,
        ));
    }
    for i in 0..spec.segments.len() {
        s.push_str(&format!("[a{i}]"));
    }
    s.push_str(&format!("concat=n={n}:v=0:a=1[outa];\n", n = spec.segments.len()));
    s
}

/// EXPORT graph: bare lavfi spliced into the EXACT real per-segment audio chain
/// (aformat → volume{gain} → segment_audio_inserts → atrim/apad) → concat →
/// master_audio_tail. Mirrors build_filter_script's audio path verbatim, minus
/// the [k:a] demuxed input (the lavfi source replaces it).
fn audio_parity_export_graph(
    spec: &ExportSpec,
    sources: &[String],
    measured: Option<&LoudnormMeasured>,
    measure_mode: bool,
) -> String {
    let mut s = String::new();
    for (i, seg) in spec.segments.iter().enumerate() {
        s.push_str(&format!(
            "{src},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume={gain}{inserts},atrim=duration={dur:.6},apad=whole_dur={dur:.6}[a{i}];\n",
            src = sources[i],
            gain = seg.gain,
            inserts = segment_audio_inserts(spec.mixer.as_ref(), seg.track_id.as_deref(), None),
            dur = seg.dur,
        ));
    }
    for i in 0..spec.segments.len() {
        s.push_str(&format!("[a{i}]"));
    }
    s.push_str(&format!("concat=n={n}:v=0:a=1[cona];\n", n = spec.segments.len()));
    s.push_str(&master_audio_tail(spec, measured, measure_mode));
    s
}

fn parity_temp(label: &str, ext: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("vedit-aparity-{label}-{stamp}.{ext}"))
}

/// Render an audio-only filtergraph (lavfi sources → [outa]) to a pcm_f32le WAV,
/// returning (bytes, path). The script temp is cleaned here; the caller removes
/// the WAV (kept so the loudnorm cell can re-measure it).
async fn render_parity_wav(graph: &str, label: &str) -> Result<(Vec<u8>, PathBuf), VaultError> {
    let script = parity_temp(label, "txt");
    let out = parity_temp(label, "wav");
    fs::write(&script, graph).map_err(|e| VaultError::Io(format!("aparity script: {e}")))?;
    let script_s = script.to_string_lossy().to_string();
    let out_s = out.to_string_lossy().to_string();
    let res = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg"))
        .args([
            "-y", "-hide_banner", "-loglevel", "error", "-nostats",
            "-filter_complex_script", script_s.as_str(),
            "-map", "[outa]", "-c:a", "pcm_f32le", "-f", "wav", out_s.as_str(),
        ])
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("ffmpeg spawn failed: {e}")));
    let _ = fs::remove_file(&script);
    let o = res?;
    if !o.status.success() {
        let _ = fs::remove_file(&out);
        return Err(VaultError::Io(format!(
            "aparity render failed: {}",
            String::from_utf8_lossy(&o.stderr)
        )));
    }
    let bytes = fs::read(&out).map_err(|e| VaultError::Io(format!("aparity wav read: {e}")))?;
    Ok((bytes, out))
}

/// Integrated loudness (LUFS) of an audio-only graph: map [outa] to null with
/// loudnorm in JSON measurement mode, parse input_i.
async fn parity_measure_graph(graph: &str) -> Option<LoudnormMeasured> {
    let script = parity_temp("meas", "txt");
    fs::write(&script, graph).ok()?;
    let script_s = script.to_string_lossy().to_string();
    let o = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg"))
        .args([
            "-hide_banner", "-nostats", "-filter_complex_script", script_s.as_str(),
            "-map", "[outa]", "-f", "null", "-",
        ])
        .output()
        .await
        .ok();
    let _ = fs::remove_file(&script);
    parse_loudnorm_json(&String::from_utf8_lossy(&o?.stderr))
}

/// Integrated loudness of a rendered WAV file (loudnorm json → input_i).
async fn parity_measure_file(path: &str) -> Option<f64> {
    let o = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg"))
        .args([
            "-hide_banner", "-nostats", "-i", path,
            "-filter_complex", "[0:a]loudnorm=print_format=json[outa]",
            "-map", "[outa]", "-f", "null", "-",
        ])
        .output()
        .await
        .ok()?;
    parse_loudnorm_json(&String::from_utf8_lossy(&o.stderr)).map(|m| m.input_i)
}

#[tauri::command]
pub async fn vedit_audio_parity(spec: AudioParitySpec) -> Result<tauri::ipc::Response, VaultError> {
    if spec.segments.is_empty() {
        return Err(VaultError::Invalid("audio parity: empty segment list".into()));
    }
    let sources: Vec<String> = spec.segments.iter().map(|s| s.source.clone()).collect();
    let export_spec = audio_parity_export_spec(&spec);

    // Clean pre-mixer source for the JS OfflineAudioContext mirror.
    let (source_wav, source_path) =
        render_parity_wav(&audio_parity_source_graph(&export_spec, &sources), "src").await?;
    let _ = fs::remove_file(&source_path);

    // Golden export via the real shared builders. Two-pass when loudnorm is on.
    let loud_enabled = export_spec
        .mixer
        .as_ref()
        .map_or(false, |m| m.master.loudnorm.enabled);
    let measured = if loud_enabled {
        parity_measure_graph(&audio_parity_export_graph(&export_spec, &sources, None, true)).await
    } else {
        None
    };
    let (export_wav, export_path) = render_parity_wav(
        &audio_parity_export_graph(&export_spec, &sources, measured.as_ref(), false),
        "exp",
    )
    .await?;

    let lufs = if loud_enabled || spec.measure_lufs {
        parity_measure_file(&export_path.to_string_lossy()).await
    } else {
        None
    };
    let _ = fs::remove_file(&export_path);

    let mut out = Vec::with_capacity(24 + source_wav.len() + export_wav.len());
    out.extend_from_slice(&(source_wav.len() as u64).to_le_bytes());
    out.extend_from_slice(&(export_wav.len() as u64).to_le_bytes());
    out.extend_from_slice(&lufs.unwrap_or(f64::NAN).to_le_bytes());
    out.extend_from_slice(&source_wav);
    out.extend_from_slice(&export_wav);
    Ok(tauri::ipc::Response::new(out))
}

/// RunEvent::Exit cleanup beside video_transcode::shutdown_active(): kill the
/// active export and remove its .partial.
pub fn shutdown_export() {
    let (pid, partial, temps) = {
        let g = EXPORT.lock().unwrap();
        match g.as_ref() {
            Some(s) if s.state == ExportState::Running => {
                (s.child_pid, s.partial_path.clone(), s.temp_paths.clone())
            }
            _ => (None, None, Vec::new()),
        }
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        export_signal(pid, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    if let Some(pid) = pid {
        crate::commands::proc_util::terminate_pid(pid);
    }
    if let Some(p) = partial {
        let _ = fs::remove_file(p);
    }
    for t in temps {
        let _ = fs::remove_file(t);
    }
}

// ── Creative LUT storage (Color Grading SF7) ───────────────────────────────
// LUTs are content-addressed under <project>/luts/<sha1-16>.cube: import
// hashes the TEXT, so re-importing the same file from any path dedupes to one
// copy, and grades persist a project-relative `file` that survives project
// folder moves. Reads validate the filename shape instead of canonicalizing —
// the grade is the only caller and never holds a user path.

const LUT_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LutImportOut {
    pub file: String,
    pub name: String,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LutReadOut {
    pub text: String,
}

#[tauri::command]
pub async fn vedit_lut_import(name: String, path: String) -> Result<LutImportOut, VaultError> {
    use sha1::{Digest, Sha1};
    let (clean, _) = project_paths(&name)?;
    let src = canonical_file(&path)?;
    let meta = fs::metadata(&src).map_err(|e| VaultError::Io(format!("lut stat: {e}")))?;
    if meta.len() > LUT_MAX_BYTES {
        return Err(VaultError::Invalid("LUT exceeds the 16 MB cap".into()));
    }
    let text = fs::read_to_string(&src)
        .map_err(|_| VaultError::Invalid("not a text .cube file (binary or non-UTF-8)".into()))?;
    if !text
        .lines()
        .any(|l| l.trim_start().starts_with("LUT_3D_SIZE"))
    {
        return Err(VaultError::Invalid(
            "missing LUT_3D_SIZE — only 3D .cube LUTs are supported".into(),
        ));
    }
    let digest = Sha1::digest(text.as_bytes());
    let mut hash16 = String::with_capacity(16);
    for b in digest.iter().take(8) {
        hash16.push_str(&format!("{b:02x}"));
    }
    let file = format!("{hash16}.cube");
    let dir = projects_root().join(&clean).join("luts");
    fs::create_dir_all(&dir).map_err(|e| VaultError::Io(format!("luts dir: {e}")))?;
    let dst = dir.join(&file);
    if !dst.exists() {
        fs::write(&dst, &text).map_err(|e| VaultError::Io(format!("lut write: {e}")))?;
    }
    let display_name = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| hash16.clone());
    Ok(LutImportOut {
        file,
        name: display_name,
        text,
    })
}

fn valid_lut_file(file: &str) -> bool {
    file.len() == 21
        && file.ends_with(".cube")
        && file.as_bytes()[..16]
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[tauri::command]
pub fn vedit_lut_read(name: String, file: String) -> Result<LutReadOut, VaultError> {
    let (clean, _) = project_paths(&name)?;
    if !valid_lut_file(&file) {
        return Err(VaultError::Invalid(format!("bad LUT filename: {file}")));
    }
    let p = projects_root().join(&clean).join("luts").join(&file);
    let text = fs::read_to_string(&p).map_err(|_| VaultError::NotFound(file))?;
    Ok(LutReadOut { text })
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn lut_filename_validation() {
        assert!(valid_lut_file("0123456789abcdef.cube"));
        assert!(!valid_lut_file("0123456789ABCDEF.cube"));
        assert!(!valid_lut_file("0123456789abcd.cube"));
        assert!(!valid_lut_file("../23456789abcdef.cube"));
        assert!(!valid_lut_file("0123456789abcdef.CUBE"));
    }

    fn seg(src: Option<&str>, src_in: f64, dur: f64, gain: f64, has_audio: bool, sto: f64) -> ExportSegment {
        ExportSegment {
            src: src.map(String::from),
            src_in,
            dur,
            gain,
            has_audio,
            start_time_offset: sto,
            lut: None,
            color_matrix: None,
            color_range: None,
            track_id: None,
        }
    }

    /// An identity-transform composite layer (src dims default to a 1920×1080
    /// 1:1 fit; the identity fast-path ignores them anyway). Tests override
    /// transform / src_w / src_h / lut as needed.
    fn layer(src: Option<&str>, src_in: f64, dur: f64, gain: f64, has_audio: bool, sto: f64) -> ExportLayer {
        ExportLayer {
            src: src.map(String::from),
            src_in,
            dur,
            gain,
            has_audio,
            start_time_offset: sto,
            src_w: 1920,
            src_h: 1080,
            transform: None,
            lut: None,
            color_matrix: None,
            color_range: None,
            track_id: None,
            kf: None,
            title_png: None,
        }
    }

    fn spec() -> ExportSpec {
        ExportSpec {
            segments: vec![
                seg(Some("/tmp/a.mp4"), 1.5, 2.0, 0.5, true, 2.778667),
                seg(None, 0.0, 1.0, 0.0, false, 0.0),
                seg(Some("/tmp/b.mp4"), 0.0, 3.0, 1.0, false, 0.0),
            ],
            width: 1280,
            height: 720,
            fps: 30.0,
            master_volume: 0.8,
            output_path: "/tmp/out.mp4".into(),
            mixer: None,
            regions: None,
            encode: None,
        }
    }

    fn no_luts(sp: &ExportSpec) -> Vec<Option<PathBuf>> {
        vec![None; sp.segments.len()]
    }

    /// spec() with the first segment graded (bt601/tv pinning).
    fn graded_spec() -> ExportSpec {
        let mut sp = spec();
        sp.segments[0].lut = Some("TITLE \"t\"\nLUT_3D_SIZE 2\n0 0 0\n".into());
        sp.segments[0].color_matrix = Some("bt601".into());
        sp.segments[0].color_range = Some("tv".into());
        sp
    }

    #[test]
    fn filter_script_shapes() {
        let sp = spec();
        let s = build_filter_script(&sp, &no_luts(&sp), None, false);
        assert!(s.contains("[0:v]setpts=PTS-STARTPTS,scale=1280:720"));
        // frame/sample-domain caps: 2 s @ 30 fps → 60, gap 1 s → 30
        assert!(s.contains("trim=end_frame=60[v0]"));
        assert!(s.contains("volume=0.5,atrim=duration=2.000000,apad=whole_dur=2.000000[a0]"));
        assert!(s.contains("color=black:size=1280x720:rate=30,format=yuv420p,setsar=1,settb=AVTB,trim=end_frame=30[v1]"));
        // audio-less media segment gets anullsrc, and gap audio too
        assert_eq!(s.matches("anullsrc=").count(), 2);
        // second -i input maps to [1:v] (gap consumed no input slot)
        assert!(s.contains("[1:v]setpts"));
        assert!(s.contains("concat=n=3:v=1:a=1[outv][cona]"));
        assert!(s.contains("[cona]volume=0.8[outa]"));
    }

    #[test]
    fn filter_script_mixer_inserts_and_identity() {
        use std::collections::HashMap;
        // An IDENTITY track (volume 1, pan 0, eq off — as JS always sends it)
        // must NOT perturb the Phase-1 chain. NB TrackMix::default() gives
        // volume 0.0 (derived Default); the serde "one" default only fills a
        // MISSING json field, and production always deserializes a full track.
        let mut sp = spec();
        sp.segments[0].track_id = Some("v1".into());
        let mut tracks = HashMap::new();
        tracks.insert("v1".to_string(), TrackMix { volume: 1.0, ..Default::default() });
        sp.mixer = Some(Mixer { tracks, master: MasterMix::default() });
        let s = build_filter_script(&sp, &no_luts(&sp), None, false);
        assert!(s.contains("volume=0.5,atrim=duration=2.000000")); // clip gain only
        assert!(!s.contains("equalizer="));
        assert!(!s.contains("pan=stereo"));
        assert!(s.contains("[cona]volume=0.8[outa]"));

        // Track EQ on + pan + lower fader → inserts spliced after the clip gain;
        // master EQ + comp + loudnorm → tail extends [cona].
        let mut tracks = HashMap::new();
        tracks.insert(
            "v1".to_string(),
            TrackMix {
                volume: 0.8,
                pan: 0.5,
                eq: EqSpec {
                    enabled: true,
                    bands: vec![
                        EqBand { kind: "lowshelf".into(), f: 120.0, g: 3.0, q: 0.7 },
                        EqBand { kind: "peaking".into(), f: 500.0, g: -2.0, q: 1.0 },
                        EqBand { kind: "peaking".into(), f: 2000.0, g: 0.0, q: 1.0 },
                        EqBand { kind: "highshelf".into(), f: 8000.0, g: 4.0, q: 0.7 },
                    ],
                },
                ..Default::default()
            },
        );
        let master = MasterMix {
            eq: EqSpec {
                enabled: true,
                bands: vec![EqBand { kind: "lowshelf".into(), f: 100.0, g: 2.0, q: 0.7 }],
            },
            comp: CompSpec { enabled: true, threshold: -24.0, ratio: 4.0, attack: 0.003, release: 0.25, knee: 30.0, makeup: 0.0 },
            loudnorm: LoudnormSpec { enabled: true, target: -14.0 },
        };
        sp.mixer = Some(Mixer { tracks, master });
        let s = build_filter_script(&sp, &no_luts(&sp), None, false);
        assert!(s.contains("volume=0.5,bass=g=3:f=120:width_type=s:width=1,"));
        assert!(s.contains("equalizer=f=500:width_type=q:width=1:g=-2,"));
        assert!(s.contains("treble=g=4:f=8000:width_type=s:width=1,"));
        assert!(s.contains(",volume=0.8,pan=stereo|c0=0.500000*c0|c1=1.000000*c1,atrim"));
        assert!(s.contains("[cona]volume=0.8,bass=g=2:f=100:width_type=s:width=1"));
        assert!(s.contains("acompressor=threshold=0.063096:ratio=4:attack=3.000:release=250.000:"));
        assert!(s.contains("loudnorm=I=-14:TP=-1.0:LRA=11.0[outa]"));
    }

    #[test]
    fn filter_script_loudnorm_two_pass() {
        use std::collections::HashMap;
        let mut sp = spec();
        sp.segments[0].track_id = Some("v1".into());
        let mut tracks = HashMap::new();
        tracks.insert("v1".to_string(), TrackMix { volume: 1.0, ..Default::default() });
        let master = MasterMix {
            loudnorm: LoudnormSpec { enabled: true, target: -16.0 },
            ..Default::default()
        };
        sp.mixer = Some(Mixer { tracks, master });

        // Pass 1 (measure): print_format=json, no correction.
        let m = build_filter_script(&sp, &no_luts(&sp), None, true);
        assert!(m.contains("loudnorm=I=-16:TP=-1.0:LRA=11.0:print_format=json[outa]"));
        assert!(!m.contains("measured_I"));
        // Pass 2 (apply): linear correction from measured values.
        let meas = LoudnormMeasured { input_i: -23.4, input_tp: -2.1, input_lra: 5.3, input_thresh: -33.6 };
        let a = build_filter_script(&sp, &no_luts(&sp), Some(&meas), false);
        assert!(a.contains("loudnorm=I=-16:TP=-1.0:LRA=11.0:measured_I=-23.40:measured_TP=-2.10:measured_LRA=5.30:measured_thresh=-33.60:linear=true[outa]"));
        // Fallback (enabled, no measurement): single-pass dynamic.
        let f = build_filter_script(&sp, &no_luts(&sp), None, false);
        assert!(f.contains("loudnorm=I=-16:TP=-1.0:LRA=11.0[outa]"));
        assert!(!f.contains("print_format"));

        // JSON parse from a realistic stderr tail.
        let stderr = "[Parsed_loudnorm_0 @ 0x55]\n{\n\t\"input_i\" : \"-23.40\",\n\t\"input_tp\" : \"-2.10\",\n\t\"input_lra\" : \"5.30\",\n\t\"input_thresh\" : \"-33.60\",\n\t\"output_i\" : \"-16.01\"\n}\n";
        let p = parse_loudnorm_json(stderr).unwrap();
        assert!((p.input_i + 23.40).abs() < 1e-9);
        assert!((p.input_thresh + 33.60).abs() < 1e-9);
        assert!(parse_loudnorm_json("no json here").is_none());
    }

    #[test]
    fn argv_shapes() {
        let sp = spec();
        let argv = build_export_argv(&sp, &[], "/tmp/f.txt", "/tmp/out.mp4.partial", None);
        let joined = argv.join(" ");
        // startTimeOffset correction applied inside the builder; -t has slack
        assert!(joined.contains("-ss 4.278667 -t 2.050000 -i /tmp/a.mp4"));
        assert!(joined.contains("-ss 0.000000 -t 3.050000 -i /tmp/b.mp4"));
        // exactly two -i (gap has none)
        assert_eq!(argv.iter().filter(|a| *a == "-i").count(), 2);
        assert!(joined.contains("-filter_complex_script /tmp/f.txt"));
        assert!(joined.contains("-movflags +faststart"));
        // .partial suffix defeats extension sniffing → explicit -f mp4
        assert!(joined.contains("-f mp4"));
        assert!(joined.ends_with("/tmp/out.mp4.partial"));
        assert!(joined.contains("-progress pipe:1"));
        // zero grades → no container color tags (Phase 1 argv byte-identical)
        assert!(!joined.contains("-colorspace"));
    }

    #[test]
    fn ungraded_chain_canonical_no_color_ops() {
        let sp = spec();
        let s = build_filter_script(&sp, &no_luts(&sp), None, false);
        // the FULL ungraded video chain, character for character — Phase 1
        // plus exactly one amendment: setsar=1 (latent concat-SAR bug fix,
        // see build_filter_script doc). No color ops without a grade.
        assert!(s.contains("[0:v]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1,settb=AVTB,trim=end_frame=60[v0];"));
        assert!(!s.contains("lut3d"));
        assert!(!s.contains("in_color_matrix"));
        assert!(!s.contains("setparams"));
    }

    #[test]
    fn graded_chain_pins_matrices_and_lut3d() {
        let sp = graded_spec();
        let mut paths = no_luts(&sp);
        paths[0] = Some(PathBuf::from("/tmp/x.cube"));
        let s = build_filter_script(&sp, &paths, None, false);
        // graded segment: decode matrix pinned, RGB sandwich around lut3d,
        // bt709/tv forced on the way back, pad AFTER the grade (ungraded bars)
        assert!(s.contains("[0:v]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:in_color_matrix=bt601:in_range=tv,format=gbrp,lut3d=file='/tmp/x.cube':interp=trilinear,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,settb=AVTB,trim=end_frame=60[v0];"));
        // ungraded segment in the same spec keeps the canonical chain
        assert!(s.contains("[1:v]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1,settb=AVTB,trim=end_frame=90[v2];"));
        // audio chains untouched by grading
        assert!(s.contains("volume=0.5,atrim=duration=2.000000,apad=whole_dur=2.000000[a0]"));
        // frame-level colorimetry pinned on the concat output (VUI source)
        assert!(s.contains("concat=n=3:v=1:a=1[catv][cona]"));
        assert!(s.contains("[catv]setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[outv]"));
    }

    #[test]
    fn materialize_luts_dedupes_and_cleans() {
        let mut sp = spec();
        sp.segments[0].lut = Some("AAA".into());
        sp.segments[2].lut = Some("AAA".into());
        sp.segments.push(seg(Some("/tmp/c.mp4"), 0.0, 1.0, 1.0, false, 0.0));
        sp.segments[3].lut = Some("BBB".into());
        let (lp, files) = materialize_luts(&sp).unwrap();
        let per_seg = lp.segments();
        assert_eq!(files.len(), 2); // AAA written once
        assert_eq!(per_seg[0], per_seg[2]);
        assert!(per_seg[1].is_none()); // gap stays bare
        assert_ne!(per_seg[0], per_seg[3]);
        assert_eq!(fs::read_to_string(&files[0]).unwrap(), "AAA");
        assert_eq!(fs::read_to_string(&files[1]).unwrap(), "BBB");
        for f in &files {
            let _ = fs::remove_file(f);
        }
        assert!(files.iter().all(|f| !f.exists()));
    }

    #[test]
    fn argv_tags_bt709_only_when_graded() {
        let j = build_export_argv(&graded_spec(), &[], "/tmp/f.txt", "/tmp/out.mp4.partial", None).join(" ");
        assert!(j.contains("-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"));
        // tags are output options: after the encoders, before the muxer flags
        assert!(j.find("-b:a 192k").unwrap() < j.find("-colorspace").unwrap());
        assert!(j.find("-colorspace").unwrap() < j.find("-movflags").unwrap());
    }

    #[test]
    fn sf3_encoder_resolution_and_argv() {
        let caps = |avail: &[&str]| EncoderCaps {
            encoders: avail.iter().map(|e| ((*e).to_string(), true)).collect(),
            ffmpeg_path: "ffmpeg".into(),
            ffmpeg_version: "t".into(),
        };
        // quality mapping: q65 → crf 18 (Phase-1 parity); endpoints clamp.
        assert_eq!(quality_to_native(65, 51), 18);
        assert_eq!(quality_to_native(100, 51), 0);
        assert_eq!(quality_to_native(0, 51), 51);

        // resolution: software-first chain; explicit-available wins; explicit-dead
        // falls through the chain; nothing available → None (caller remediates).
        let h264 = EncodeSpec {
            container: "mp4".into(),
            codec: "h264".into(),
            encoder: None,
            quality: None,
            bitrate_kbps: None,
            audio_bitrate_kbps: None,
        };
        assert_eq!(
            resolve_export_encoder(&h264, &caps(&["libx264", "h264_nvenc"])).as_deref(),
            Some("libx264")
        );
        let forced_nvenc = EncodeSpec { encoder: Some("h264_nvenc".into()), ..h264.clone() };
        assert_eq!(
            resolve_export_encoder(&forced_nvenc, &caps(&["libx264", "h264_nvenc"])).as_deref(),
            Some("h264_nvenc")
        );
        assert_eq!(
            resolve_export_encoder(&forced_nvenc, &caps(&["h264_amf"])).as_deref(),
            Some("h264_amf")
        );
        assert_eq!(resolve_export_encoder(&h264, &caps(&[])), None);

        // argv: vp9/webm — crf quality, opus audio, webm muxer, no faststart.
        let mut sp = spec();
        sp.encode = Some(EncodeSpec {
            container: "webm".into(),
            codec: "vp9".into(),
            encoder: None,
            quality: Some(65),
            bitrate_kbps: None,
            audio_bitrate_kbps: None,
        });
        let j = build_export_argv(&sp, &[], "/tmp/f.txt", "/tmp/out.webm.partial", Some("libvpx-vp9"))
            .join(" ");
        assert!(j.contains("-c:v libvpx-vp9 -b:v 0 -crf"));
        assert!(j.contains("-c:a libopus -b:a 192k"));
        assert!(j.contains("-f webm"));
        assert!(!j.contains("-movflags"));

        // argv: explicit bitrate → nvenc VBR mode (not CQ).
        sp.encode = Some(EncodeSpec {
            container: "mp4".into(),
            codec: "h264".into(),
            encoder: Some("h264_nvenc".into()),
            quality: None,
            bitrate_kbps: Some(8000),
            audio_bitrate_kbps: None,
        });
        let j2 = build_export_argv(&sp, &[], "/tmp/f.txt", "/tmp/out.mp4.partial", Some("h264_nvenc"))
            .join(" ");
        assert!(j2.contains("-c:v h264_nvenc -rc vbr -b:v 8000k"));
        assert!(j2.contains("-c:a aac -b:a 192k"));
        assert!(j2.contains("-movflags +faststart -f mp4"));
    }

    #[test]
    fn audio_parity_graph_shapes() {
        use std::collections::HashMap;
        let p = AudioParitySpec {
            segments: vec![
                AudioParitySeg { source: "sine=frequency=440:duration=1.5".into(), dur: 1.5, gain: 0.8, track_id: Some("v1".into()) },
                AudioParitySeg { source: "sine=frequency=880:duration=1.5".into(), dur: 1.5, gain: 0.8, track_id: Some("v1".into()) },
            ],
            master_volume: 0.9,
            mixer: Some(Mixer {
                tracks: {
                    let mut m = HashMap::new();
                    m.insert("v1".to_string(), TrackMix {
                        volume: 0.7,
                        pan: 0.5,
                        eq: EqSpec { enabled: true, bands: vec![EqBand { kind: "peaking".into(), f: 1000.0, g: 6.0, q: 1.0 }] },
                        ..Default::default()
                    });
                    m
                },
                master: MasterMix::default(),
            }),
            measure_lufs: false,
        };
        let spec = audio_parity_export_spec(&p);
        let srcs: Vec<String> = p.segments.iter().map(|s| s.source.clone()).collect();

        // SOURCE graph: bare lavfi, no gain / inserts / master.
        let sg = audio_parity_source_graph(&spec, &srcs);
        assert!(sg.contains("sine=frequency=440:duration=1.5,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=1.500000,apad=whole_dur=1.500000[a0]"));
        assert!(sg.contains("[a0][a1]concat=n=2:v=0:a=1[outa]"));
        assert!(!sg.contains("volume="));
        assert!(!sg.contains("equalizer="));

        // EXPORT graph: clip gain + track EQ + fader + equal-power pan, then the
        // shared master tail — exercising the REAL segment_audio_inserts/master_audio_tail.
        let eg = audio_parity_export_graph(&spec, &srcs, None, false);
        assert!(eg.contains("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.8,equalizer=f=1000:width_type=q:width=1:g=6,volume=0.7,pan=stereo|c0=0.500000*c0|c1=1.000000*c1,atrim=duration=1.500000,apad=whole_dur=1.500000[a0]"));
        assert!(eg.contains("[a0][a1]concat=n=2:v=0:a=1[cona]"));
        assert!(eg.contains("[cona]volume=0.9[outa]"));

        // Loudnorm two-pass shapes flow straight through master_audio_tail.
        let mut sp2 = spec.clone();
        sp2.mixer.as_mut().unwrap().master.loudnorm = LoudnormSpec { enabled: true, target: -14.0 };
        let meas = audio_parity_export_graph(&sp2, &srcs, None, true);
        assert!(meas.contains("loudnorm=I=-14:TP=-1.0:LRA=11.0:print_format=json[outa]"));
    }

    // ── Compositing SF7: region filtergraph ─────────────────────────────────

    fn ident_tf(x: f64, y: f64, scale: f64, rot: f64, opacity: f64) -> Transform {
        Transform { x, y, scale, rot, opacity, crop: Crop::default() }
    }

    /// spec() with a 1920×1080 sequence and a single region: an identity base
    /// (1920×1080) under a PiP top (1280×720 @ 0.4, +25%/+25%, opacity 0.8).
    fn pip_spec() -> ExportSpec {
        let mut sp = spec();
        sp.width = 1920;
        sp.height = 1080;
        let mut base = layer(Some("/tmp/base.mp4"), 0.0, 2.0, 1.0, false, 0.0);
        base.src_w = 1920;
        base.src_h = 1080;
        let mut pip = layer(Some("/tmp/pip.mp4"), 0.0, 2.0, 1.0, false, 0.0);
        pip.src_w = 1280;
        pip.src_h = 720;
        pip.transform = Some(ident_tf(0.25, 0.25, 0.4, 0.0, 0.8));
        sp.regions = Some(vec![ExportRegion { dur: 2.0, layers: vec![base, pip] }]);
        sp
    }

    /// The regression gate: a no-transform project (regions mirroring the
    /// segments 1:1, each a single identity layer / gap) compiles byte-for-byte
    /// identical to the Phase-1 segment path.
    #[test]
    fn region_identity_is_byte_identical_to_segments() {
        let seg_sp = spec();
        let seg_script = build_filter_script(&seg_sp, &no_luts(&seg_sp), None, false);

        let mut reg_sp = spec();
        reg_sp.regions = Some(vec![
            ExportRegion { dur: 2.0, layers: vec![layer(Some("/tmp/a.mp4"), 1.5, 2.0, 0.5, true, 2.778667)] },
            ExportRegion { dur: 1.0, layers: vec![] },
            ExportRegion { dur: 3.0, layers: vec![layer(Some("/tmp/b.mp4"), 0.0, 3.0, 1.0, false, 0.0)] },
        ]);
        let lut = vec![vec![None], vec![], vec![None]];
        let reg_script =
            build_filter_script_regions(&reg_sp, reg_sp.regions.as_ref().unwrap(), &lut, None, false);

        assert_eq!(seg_script, reg_script);
        assert!(!reg_script.contains("overlay"));
        assert!(!reg_script.contains("colorchannelmixer"));
        assert!(!reg_script.contains("amix"));
    }

    /// The dispatcher routes None → the verbatim segment script.
    #[test]
    fn dispatch_routes_segments_unchanged() {
        let sp = spec();
        let via = build_filter_script_for(&sp, &LutPaths::Segments(no_luts(&sp)), None, false);
        assert_eq!(via, build_filter_script(&sp, &no_luts(&sp), None, false));
    }

    #[test]
    fn region_pip_overlay_shapes() {
        let sp = pip_spec();
        let lut = vec![vec![None, None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        // bottom identity (1920×1080) and PiP (1280×720 @0.4 → 768×432) both RGBA;
        // PiP opacity 0.8 → colorchannelmixer; fit is exact (no force_original_aspect_ratio).
        assert!(s.contains("[0:v]setpts=PTS-STARTPTS,scale=1920:1080,format=rgba,setsar=1,settb=AVTB,trim=end_frame=60[L0_0];"));
        assert!(s.contains("[1:v]setpts=PTS-STARTPTS,scale=768:432,format=rgba,colorchannelmixer=aa=0.800000,setsar=1,settb=AVTB,trim=end_frame=60[L0_1];"));
        assert!(s.contains("color=black:size=1920x1080:rate=30,format=rgba,setsar=1,settb=AVTB[base0_0];"));
        assert!(s.contains("[base0_0][L0_0]overlay=x='(main_w*0.500000)-(overlay_w/2)':y='(main_h*0.500000)-(overlay_h/2)':eval=init[base0_1];"));
        assert!(s.contains("[base0_1][L0_1]overlay=x='(main_w*0.750000)-(overlay_w/2)':y='(main_h*0.250000)-(overlay_h/2)':eval=init,format=yuv420p,setsar=1,settb=AVTB,trim=end_frame=60[v0];"));
        assert!(!s.contains("force_original_aspect_ratio"));
    }

    #[test]
    fn region_crop_and_rotate_shapes() {
        let mut sp = pip_spec();
        // a 30° rotation + 10% crop on every edge, opacity 1.0 (no alpha filter).
        sp.regions.as_mut().unwrap()[0].layers[1].transform = Some(Transform {
            x: 0.0, y: 0.0, scale: 1.0, rot: 30.0, opacity: 1.0,
            crop: Crop { l: 0.1, t: 0.1, r: 0.1, b: 0.1 },
        });
        let lut = vec![vec![None, None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        // crop runs BEFORE scale; rotate is transparent + bbox-expanded.
        assert!(s.contains("crop=w=iw*0.800000:h=ih*0.800000:x=iw*0.100000:y=ih*0.100000,"));
        assert!(s.contains("rotate=0.523599:c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)',"));
        // opacity 1.0 → no colorchannelmixer on this layer.
        assert!(!s.contains("colorchannelmixer"));
    }

    #[test]
    fn region_two_audible_layers_amix_normalize_zero() {
        let mut sp = pip_spec();
        {
            let layers = &mut sp.regions.as_mut().unwrap()[0].layers;
            layers[0].has_audio = true;
            layers[0].gain = 0.5;
            layers[1].has_audio = true;
            layers[1].gain = 1.0;
        }
        let lut = vec![vec![None, None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        assert!(s.contains("[0:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.5,atrim=duration=2.000000,apad=whole_dur=2.000000[a0_0];"));
        assert!(s.contains("[1:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=1,atrim=duration=2.000000,apad=whole_dur=2.000000[a0_1];"));
        assert!(s.contains("[a0_0][a0_1]amix=inputs=2:normalize=0[a0];"));

        // single audible → NO amix (byte-identical to a Phase-1 segment audio chain).
        sp.regions.as_mut().unwrap()[0].layers[1].has_audio = false;
        let s2 = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        assert!(!s2.contains("amix"));
        assert!(s2.contains("volume=0.5,atrim=duration=2.000000,apad=whole_dur=2.000000[a0];"));
    }

    #[test]
    fn region_input_args_lockstep() {
        let mut sp = pip_spec(); // region 0: base + pip (2 inputs)
        sp.regions.as_mut().unwrap().push(ExportRegion { dur: 1.0, layers: vec![] }); // gap: no input
        let argv = build_export_argv(&sp, &[], "/tmp/f.txt", "/tmp/out.mp4.partial", None);
        assert_eq!(argv.iter().filter(|a| *a == "-i").count(), 2);
        let joined = argv.join(" ");
        assert!(joined.contains("-i /tmp/base.mp4"));
        assert!(joined.contains("-i /tmp/pip.mp4"));
        // labels line up: base=[0:v] (bottom), pip=[1:v] (top).
        let lut = vec![vec![None, None], vec![]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        assert!(s.contains("[0:v]setpts") && s.contains("[1:v]setpts"));
    }

    // ── SF11 titles ─────────────────────────────────────────────────────────
    fn title_layer(b64: &str, w: u32, h: u32, dur: f64) -> ExportLayer {
        let mut l = layer(None, 0.0, dur, 0.0, false, 0.0);
        l.src_w = w;
        l.src_h = h;
        l.title_png = Some(b64.to_string());
        l
    }

    fn title_only_spec(b64: &str) -> ExportSpec {
        ExportSpec {
            segments: vec![],
            width: 1920,
            height: 1080,
            fps: 30.0,
            master_volume: 1.0,
            output_path: "/tmp/o.mp4".into(),
            mixer: None,
            regions: Some(vec![ExportRegion {
                dur: 2.0,
                layers: vec![title_layer(b64, 800, 120, 2.0)],
            }]),
            encode: None,
        }
    }

    #[test]
    fn title_takes_composite_path_not_fast_path() {
        // A single identity-transform title takes the COMPOSITE path (format=rgba
        // overlay), NEVER the byte-identical pad fast-path (which assumes a
        // seekable video). fit=1 → the 800×120 box scales to its own px.
        let sp = title_only_spec("AAAA");
        let lut = vec![vec![None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        assert!(s.contains("[0:v]setpts=PTS-STARTPTS,scale=800:120,format=rgba,setsar=1,settb=AVTB,trim=end_frame=60[L0_0];"));
        assert!(s.contains("[base0_0][L0_0]overlay=x='(main_w*0.500000)-(overlay_w/2)':y='(main_h*0.500000)-(overlay_h/2)':eval=init"));
        assert!(!s.contains("force_original_aspect_ratio"));
        // a title-only region is silent (anullsrc), no amix.
        assert!(s.contains("anullsrc"));
        assert!(!s.contains("amix"));
    }

    #[test]
    fn title_input_loops_at_fps_in_lockstep() {
        // input_args emits `-loop 1 -framerate <fps> -t <dur+slack> -i <png>` for a
        // title (no -ss), and `-ss/-t/-i` for the video beneath, in layer order.
        let sp = ExportSpec {
            regions: Some(vec![ExportRegion {
                dur: 2.0,
                layers: vec![
                    layer(Some("/tmp/v.mp4"), 0.0, 2.0, 1.0, true, 0.0),
                    title_layer("AAAA", 800, 120, 2.0),
                ],
            }]),
            ..title_only_spec("AAAA")
        };
        let titles = vec![vec![None, Some(PathBuf::from("/tmp/t.png"))]];
        let argv = input_args(&sp, &titles);
        let j = argv.join(" ");
        assert!(j.contains("-ss 0.000000 -t 2.050000 -i /tmp/v.mp4"));
        assert!(j.contains("-loop 1 -framerate 30 -t 2.050000 -i /tmp/t.png"));
        assert_eq!(argv.iter().filter(|a| *a == "-i").count(), 2);
    }

    #[test]
    fn materialize_titles_dedupes_and_cleans() {
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3, 4]);
        let sp = ExportSpec {
            regions: Some(vec![
                ExportRegion { dur: 1.0, layers: vec![title_layer(&png, 10, 10, 1.0)] },
                ExportRegion { dur: 1.0, layers: vec![title_layer(&png, 10, 10, 1.0)] },
            ]),
            ..title_only_spec(&png)
        };
        let (paths, files) = materialize_titles(&sp).unwrap();
        // identical base64 → ONE temp file shared across both regions.
        assert_eq!(files.len(), 1);
        assert_eq!(paths[0][0], paths[1][0]);
        assert!(paths[0][0].as_ref().unwrap().exists());
        for f in &files {
            let _ = std::fs::remove_file(f);
        }
    }

    #[test]
    fn no_title_spec_materializes_nothing() {
        // Regression gate: a title-free regions spec yields no title temps (the
        // identity fast-path + Phase-1 byte-identity are untouched).
        let mut reg_sp = spec();
        reg_sp.regions = Some(vec![ExportRegion {
            dur: 2.0,
            layers: vec![layer(Some("/tmp/a.mp4"), 1.5, 2.0, 0.5, true, 2.778667)],
        }]);
        let (paths, files) = materialize_titles(&reg_sp).unwrap();
        assert!(files.is_empty());
        assert!(paths[0][0].is_none());
    }

    #[test]
    fn region_graded_layer_sandwich_and_tail() {
        let mut sp = pip_spec();
        {
            let pip = &mut sp.regions.as_mut().unwrap()[0].layers[1];
            pip.lut = Some("TITLE \"t\"\nLUT_3D_SIZE 2\n0 0 0\n".into());
            pip.color_matrix = Some("bt601".into());
            pip.color_range = Some("tv".into());
        }
        let lut = vec![vec![None, Some(PathBuf::from("/tmp/x.cube"))]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        // the SF4 grade sandwich lives INSIDE the layer chain, before format=rgba.
        assert!(s.contains("scale=768:432,format=gbrp,lut3d=file='/tmp/x.cube':interp=trilinear,scale=out_color_matrix=bt709:out_range=tv,format=rgba,colorchannelmixer=aa=0.800000,"));
        // graded → setparams tail on the concat output.
        assert!(s.contains("concat=n=1:v=1:a=1[catv][cona]"));
        assert!(s.contains("[catv]setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[outv]"));
        // and the container gets the bt709 tags.
        let j = build_export_argv(&sp, &[], "/tmp/f.txt", "/tmp/out.mp4.partial", None).join(" ");
        assert!(j.contains("-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"));
    }

    #[test]
    fn materialize_luts_regions_dedupe() {
        let mut sp = pip_spec();
        {
            let layers = &mut sp.regions.as_mut().unwrap()[0].layers;
            layers[0].lut = Some("SHARED".into());
            layers[1].lut = Some("SHARED".into());
        }
        let mut other = layer(Some("/tmp/c.mp4"), 0.0, 1.0, 1.0, false, 0.0);
        other.lut = Some("OTHER".into());
        sp.regions.as_mut().unwrap().push(ExportRegion { dur: 1.0, layers: vec![other] });

        let (lp, files) = materialize_luts(&sp).unwrap();
        assert_eq!(files.len(), 2); // SHARED written once + OTHER
        let r = lp.regions();
        assert_eq!(r[0][0], r[0][1]); // shared text dedupes to one path
        assert_ne!(r[0][0], r[1][0]); // region 1's OTHER is a different file
        assert!(r[0][0].is_some());
        for f in &files {
            let _ = fs::remove_file(f);
        }
        assert!(files.iter().all(|f| !f.exists()));
    }

    // ── SF9: keyframe export (expr substitution; static collapses to SF7) ────

    #[test]
    fn region_keyframed_position_overlay_expr() {
        let mut sp = pip_spec();
        sp.regions.as_mut().unwrap()[0].layers[1].kf = Some(LayerKf {
            pos_x: Some("if(lt(t,1.0),lerp(0.25,0.75,(t/1.0)),0.75)".into()),
            pos_y: Some("0.5".into()),
            ..Default::default()
        });
        let lut = vec![vec![None, None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        // animated position → the centre-fraction exprs + eval=frame.
        assert!(s.contains("overlay=x='(main_w*(if(lt(t,1.0),lerp(0.25,0.75,(t/1.0)),0.75)))-(overlay_w/2)':y='(main_h*(0.5))-(overlay_h/2)':eval=frame"));
    }

    #[test]
    fn region_keyframed_opacity_uses_geq() {
        let mut sp = pip_spec();
        sp.regions.as_mut().unwrap()[0].layers[1].kf = Some(LayerKf {
            opacity: Some("if(lt(T,1.0),lerp(1,0,(T/1.0)),0)".into()),
            ..Default::default()
        });
        let lut = vec![vec![None, None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        // animated opacity (uppercase T) → geq alpha-scale, NOT colorchannelmixer.
        assert!(s.contains("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(if(lt(T,1.0),lerp(1,0,(T/1.0)),0)),0,255)',"));
        assert!(!s.contains("colorchannelmixer"));
    }

    #[test]
    fn region_keyframed_rotate_expr() {
        let mut sp = pip_spec();
        sp.regions.as_mut().unwrap()[0].layers[1].kf = Some(LayerKf {
            rot: Some("lerp(0,1.5708,(t/2.0))".into()),
            ..Default::default()
        });
        let lut = vec![vec![None, None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        assert!(s.contains("rotate='lerp(0,1.5708,(t/2.0))':c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)',"));
    }

    #[test]
    fn region_keyframed_audio_exprs() {
        use std::collections::HashMap;
        let mut sp = pip_spec();
        {
            let layers = &mut sp.regions.as_mut().unwrap()[0].layers;
            layers[0].has_audio = true; // base is the only audible layer
            layers[0].track_id = Some("v1".into());
            layers[0].kf = Some(LayerKf {
                gain: Some("lerp(0,1,(t/2.0))".into()),
                track_vol: Some("lerp(1,0.5,(t/2.0))".into()),
                ..Default::default()
            });
            layers[1].has_audio = false;
        }
        let mut tracks = HashMap::new();
        tracks.insert("v1".to_string(), TrackMix { volume: 1.0, ..Default::default() });
        sp.mixer = Some(Mixer { tracks, master: MasterMix::default() });
        let lut = vec![vec![None, None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        assert!(s.contains("volume='lerp(0,1,(t/2.0))':eval=frame")); // clip gain expr
        assert!(s.contains(",volume='lerp(1,0.5,(t/2.0))':eval=frame")); // track fader expr
    }

    #[test]
    fn region_kf_excludes_fast_path() {
        // a single identity-transform layer WITH automation must NOT fast-path
        // (its audio needs the expr) → composite path + gain expr.
        let mut sp = spec();
        sp.width = 1920;
        sp.height = 1080;
        let mut l = layer(Some("/tmp/a.mp4"), 0.0, 2.0, 1.0, true, 0.0);
        l.kf = Some(LayerKf { gain: Some("lerp(0,1,(t/2.0))".into()), ..Default::default() });
        sp.regions = Some(vec![ExportRegion { dur: 2.0, layers: vec![l] }]);
        let lut = vec![vec![None]];
        let s = build_filter_script_regions(&sp, sp.regions.as_ref().unwrap(), &lut, None, false);
        assert!(s.contains("format=rgba")); // composite, not the pad fast-path
        assert!(!s.contains("force_original_aspect_ratio"));
        assert!(s.contains("volume='lerp(0,1,(t/2.0))':eval=frame"));
    }

    // The IPC-boundary contract: ExportDialog sends EITHER `segments` OR `regions`
    // (never both). Both must deserialize — the struct-literal tests above never
    // exercise serde, so a missing serde(default) slips past them (it reached the
    // running app as "missing field `segments`").
    #[test]
    fn spec_deserializes_region_only_and_segment_only() {
        let region_json = r#"{
            "regions":[{"dur":2.0,"layers":[{"src":"/tmp/a.mp4","dur":2.0,"srcW":1920,"srcH":1080}]}],
            "width":1920,"height":1080,"fps":30.0,"outputPath":"/tmp/o.mp4"
        }"#;
        let sp: ExportSpec = serde_json::from_str(region_json).expect("region-only spec must deserialize");
        assert!(sp.segments.is_empty());
        assert_eq!(sp.regions.as_ref().unwrap().len(), 1);

        let seg_json = r#"{
            "segments":[{"src":"/tmp/a.mp4","dur":2.0,"hasAudio":true}],
            "width":1280,"height":720,"fps":30.0,"outputPath":"/tmp/o.mp4"
        }"#;
        let sp2: ExportSpec = serde_json::from_str(seg_json).expect("segment-only spec must deserialize");
        assert_eq!(sp2.segments.len(), 1);
        assert!(sp2.regions.is_none());

        // an animated layer's kf exprs round-trip through serde (camelCase keys).
        let kf_json = r#"{
            "regions":[{"dur":2.0,"layers":[{"src":"/tmp/a.mp4","dur":2.0,"srcW":1920,"srcH":1080,
              "kf":{"posX":"lerp(0.25,0.75,(t/2.0))","posY":"0.5","trackVol":"lerp(1,0.5,(t/2.0))"}}]}],
            "width":1920,"height":1080,"fps":30.0,"outputPath":"/tmp/o.mp4"
        }"#;
        let sp3: ExportSpec = serde_json::from_str(kf_json).expect("kf spec must deserialize");
        let kf = sp3.regions.unwrap()[0].layers[0].kf.clone().unwrap();
        assert_eq!(kf.pos_x.as_deref(), Some("lerp(0.25,0.75,(t/2.0))"));
        assert_eq!(kf.track_vol.as_deref(), Some("lerp(1,0.5,(t/2.0))"));
    }
}
