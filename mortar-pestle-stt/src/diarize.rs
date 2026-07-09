//! Offline speaker diarization for the comms transcript (Scrim Coaching sub-plan 6, SF1).
//!
//! Wraps sherpa-onnx's `OfflineSpeakerDiarization` (pyannote-segmentation-3.0 + a
//! 3D-Speaker CAM++ embedder) — the Rust-only, Windows-native "who spoke when" engine.
//! It answers speaker-labeled time spans + an estimated speaker count. The per-cluster
//! MEAN EMBEDDING (the host-side voiceprint match key, sub-plan 6 SF3) is NOT surfaced by
//! the diarization result, so we recompute it here with a standalone
//! `SpeakerEmbeddingExtractor` over each speaker's concatenated segment audio.
//!
//! All sherpa-onnx usage is contained in this module; the rest of the crate sees only the
//! plain-data [`DiarizationOutcome`]. The daemon calls [`diarize_file`] (worker thread);
//! the `diarize` CLI subcommand ([`run_cli`]) is the SF1 GATE HARNESS — one command that
//! fetches the models and diarizes a real track, no socket/host wiring needed.

use std::path::Path;

use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerDiarizationSegment, OfflineSpeakerSegmentationModelConfig,
    OfflineSpeakerSegmentationPyannoteModelConfig, SpeakerEmbeddingExtractor,
    SpeakerEmbeddingExtractorConfig,
};

use crate::models::{ensure_model, ModelError};

/// Registry names of the two diarization models (fetch-on-demand + SHA256-verified via
/// the same `models::ensure_model` path as the speech + VAD models). Non-speech, so
/// excluded from the Settings speech-model picker.
pub const SEG_MODEL: &str = "pyannote-seg-3.0";
pub const EMB_MODEL: &str = "campplus-sv-en";

/// The audio contract shared with whisper: 16 kHz mono f32. pyannote-segmentation-3.0 and
/// the CAM++ embedder are both 16 kHz models.
const SAMPLE_RATE: i32 = 16_000;

/// One diarization span: millisecond bounds + the 0-based speaker cluster it was
/// attributed to.
pub struct DiarSpan {
    pub t0_ms: u64,
    pub t1_ms: u64,
    pub cluster_id: i32,
}

/// One detected speaker cluster + its mean voiceprint embedding (the host cosine-matches
/// it against a team's saved prints, SF3). `embedding.len()` = the embedder's dim.
pub struct DiarCluster {
    pub cluster_id: i32,
    pub embedding: Vec<f32>,
}

/// The full result of one diarize run — plain data, no sherpa types cross this boundary.
pub struct DiarizationOutcome {
    pub num_speakers: i32,
    pub spans: Vec<DiarSpan>,
    pub clusters: Vec<DiarCluster>,
}

/// Decode an audio file to 16 kHz mono f32 (reusing the whisper decoder — WAV in the SF2
/// pipeline, any symphonia container otherwise), then diarize. Convenience over
/// [`diarize_samples`] for the daemon + CLI.
pub fn diarize_file(
    seg_model: &Path,
    emb_model: &Path,
    audio_path: &Path,
    max_speakers: i32,
) -> Result<DiarizationOutcome, String> {
    let samples = crate::whisper::decode_to_16k_mono(audio_path)?;
    diarize_samples(seg_model, emb_model, &samples, max_speakers)
}

/// Diarize a decoded 16 kHz mono f32 waveform. `seg_model`/`emb_model` are the cached
/// pyannote + embedder onnx paths (resolved by the caller via the model registry).
/// `max_speakers > 0` forces exactly that many clusters (the roster-size cap); `<= 0`
/// auto-detects via threshold clustering. Returns speaker-labeled spans + per-cluster
/// mean embeddings, or a human-readable error (a null pointer from the C API ⇒ a bad
/// model file or an unsupported config).
pub fn diarize_samples(
    seg_model: &Path,
    emb_model: &Path,
    samples: &[f32],
    max_speakers: i32,
) -> Result<DiarizationOutcome, String> {
    if samples.is_empty() {
        return Err("no audio samples to diarize".into());
    }

    // num_clusters: >0 forces a fixed K — the native "cap at roster size" primitive. It
    // can over-split when fewer than K players actually spoke; the live gate + SF4 roster
    // wiring tune the final semantics. <=0 = auto threshold clustering (the SF1 default).
    let clustering = FastClusteringConfig {
        num_clusters: if max_speakers > 0 { max_speakers } else { -1 },
        ..Default::default()
    };

    let config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(seg_model.to_string_lossy().into_owned()),
            },
            ..Default::default()
        },
        embedding: SpeakerEmbeddingExtractorConfig {
            model: Some(emb_model.to_string_lossy().into_owned()),
            ..Default::default()
        },
        clustering,
        ..Default::default()
    };

    let diar = OfflineSpeakerDiarization::create(&config)
        .ok_or("failed to create diarizer (bad segmentation/embedding model?)")?;

    // pyannote-seg-3.0 is a 16 kHz model; guard the contract loudly rather than feed it a
    // mismatched rate (which yields silent garbage clusters).
    let sr = diar.sample_rate();
    if sr != SAMPLE_RATE {
        return Err(format!("diarizer expects {sr} Hz, audio is {SAMPLE_RATE} Hz"));
    }

    let result = diar.process(samples).ok_or("diarization produced no result")?;
    let num_speakers = result.num_speakers();
    let segments = result.sort_by_start_time();

    let spans: Vec<DiarSpan> = segments
        .iter()
        .map(|s| DiarSpan {
            t0_ms: (s.start.max(0.0) * 1000.0) as u64,
            t1_ms: (s.end.max(0.0) * 1000.0) as u64,
            cluster_id: s.speaker,
        })
        .collect();

    let clusters = compute_cluster_embeddings(emb_model, samples, &segments)?;

    Ok(DiarizationOutcome { num_speakers, spans, clusters })
}

/// One mean voiceprint per speaker cluster: concatenate all of a speaker's segment audio,
/// run it through the embedder once, and keep the vector. Clusters are the distinct
/// `segment.speaker` ids. A cluster whose audio is too short for the embedder (never
/// `is_ready`) is skipped rather than failing the whole run.
fn compute_cluster_embeddings(
    emb_model: &Path,
    samples: &[f32],
    segments: &[OfflineSpeakerDiarizationSegment],
) -> Result<Vec<DiarCluster>, String> {
    let extractor = SpeakerEmbeddingExtractor::create(&SpeakerEmbeddingExtractorConfig {
        model: Some(emb_model.to_string_lossy().into_owned()),
        ..Default::default()
    })
    .ok_or("failed to create speaker-embedding extractor")?;

    let mut ids: Vec<i32> = segments.iter().map(|s| s.speaker).collect();
    ids.sort_unstable();
    ids.dedup();

    let mut clusters = Vec::with_capacity(ids.len());
    for id in ids {
        let mut audio: Vec<f32> = Vec::new();
        for seg in segments.iter().filter(|s| s.speaker == id) {
            let a = ((seg.start.max(0.0) * SAMPLE_RATE as f32) as usize).min(samples.len());
            let b = ((seg.end.max(0.0) * SAMPLE_RATE as f32) as usize).min(samples.len());
            if b > a {
                audio.extend_from_slice(&samples[a..b]);
            }
        }
        if audio.is_empty() {
            continue;
        }
        let Some(stream) = extractor.create_stream() else { continue };
        stream.accept_waveform(SAMPLE_RATE, &audio);
        stream.input_finished();
        if !extractor.is_ready(&stream) {
            log::warn!("diarize: cluster {id} audio too short for an embedding — skipped");
            continue;
        }
        if let Some(embedding) = extractor.compute(&stream) {
            clusters.push(DiarCluster { cluster_id: id, embedding });
        }
    }
    Ok(clusters)
}

/// `mortar-pestle-stt diarize <audio-file> [max_speakers]` — the SF1 gate harness. Fetches
/// (on first use) + SHA256-verifies both diarization models, decodes the file, diarizes,
/// and prints a plain summary: speaker count, span count, the first spans, and the
/// per-cluster embedding dim. No socket, no host — the one command that proves a real
/// multi-voice track clusters plausibly.
pub fn run_cli(args: &[String]) -> std::process::ExitCode {
    use std::process::ExitCode;

    let Some(audio) = args.first() else {
        eprintln!("usage: mortar-pestle-stt diarize <audio-file> [max_speakers]");
        return ExitCode::from(2);
    };
    let max_speakers: i32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(-1);

    let seg = match ensure_model(SEG_MODEL, |p| eprint!("\rfetching {SEG_MODEL}: {p:>3.0}%   ")) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("\nmodel error: {}", model_err(&e));
            return ExitCode::FAILURE;
        }
    };
    let emb = match ensure_model(EMB_MODEL, |p| eprint!("\rfetching {EMB_MODEL}: {p:>3.0}%   ")) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("\nmodel error: {}", model_err(&e));
            return ExitCode::FAILURE;
        }
    };
    eprintln!("\rmodels ready.                    ");

    let out = match diarize_file(&seg.path, &emb.path, Path::new(audio), max_speakers) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("diarize failed: {e}");
            return ExitCode::FAILURE;
        }
    };

    println!("num_speakers: {}", out.num_speakers);
    println!("segments: {}", out.spans.len());
    for s in out.spans.iter().take(30) {
        println!("  [{:>7}..{:>7} ms] speaker {}", s.t0_ms, s.t1_ms, s.cluster_id);
    }
    if out.spans.len() > 30 {
        println!("  … {} more", out.spans.len() - 30);
    }
    let dim = out.clusters.first().map(|c| c.embedding.len()).unwrap_or(0);
    println!("clusters with embeddings: {} (dim {})", out.clusters.len(), dim);
    ExitCode::SUCCESS
}

/// Human-readable one-liner for a model-fetch error (CLI only).
fn model_err(e: &ModelError) -> String {
    match e {
        ModelError::UnknownModel(n) => format!("unknown model `{n}` (not in the registry)"),
        ModelError::Download(msg) => msg.clone(),
    }
}
