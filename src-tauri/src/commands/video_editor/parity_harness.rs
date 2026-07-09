// ── DEV parity / encode-smoke harness — split from mod.rs, plan 026 B5.
// Color / composite / audio parity render + encode-smoke: DEV-only diagnostic
// commands kept out of the ~1900-line export production file. Shim
// `pub use parity_harness::*;` keeps the vedit_encode_smoke / vedit_parity_render /
// vedit_composite_parity / vedit_audio_parity command paths + ACL resolving.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::commands::vault::VaultError;
use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{Mixer, TrackMix, EqSpec, EqBand, MasterMix, LoudnormSpec};

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
}
