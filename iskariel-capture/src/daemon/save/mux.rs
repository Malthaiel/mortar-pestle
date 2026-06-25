//! The per-clip ffmpeg mux (live video-only; AAC audio added at finalize).
//!
//! `ClipMux::start` mkfifo's a per-clip FIFO, spawns ffmpeg as its READER (so its
//! blocking `open()` happens inside ffmpeg, not in our capture thread), then opens
//! the write end and hands it to the `Recorder`. ffmpeg writes a **fragmented**
//! MP4 (`+frag_keyframe+empty_moov+default_base_moof`) straight to the final path,
//! so a SIGKILL — or the daemon dying and closing the FIFO — still leaves a valid,
//! playable file (ffmpeg flushes on the EOF and exits).
//!
//! Audio (Step 6) is added at `finalize`, NOT live: recording stays single-stream
//! (kill-survivable, and ffmpeg never buffers video waiting to interleave a PCM
//! stream that only completes at stop). On a clean stop, `finalize` runs ONE ffmpeg
//! pass that copies the video, encodes the cut PCM to an AAC track, and faststarts
//! — folded into the same full-file rewrite the silent path already did for
//! faststart, so audio costs only the AAC encode + a transient PCM temp file.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use super::fifo;

/// How long to wait for ffmpeg to open the FIFO read end before aborting a start.
#[cfg(unix)]
const FIFO_OPEN_TIMEOUT: Duration = Duration::from_secs(2);

/// One in-flight clip's mux: the ffmpeg child + its FIFO + the final `.mp4` path.
/// The encoded-byte writer is NOT held here — it is moved into the `Recorder`,
/// whose `finish()` closes it to signal EOF to ffmpeg. Recording is video-only;
/// `finalize` adds the audio track.
pub struct ClipMux {
    pub mp4_path: String,
    fifo_path: PathBuf,
    child: Option<Child>,
}

impl ClipMux {
    /// mkfifo → spawn ffmpeg (reader) → open the write end (bounded). Returns the
    /// mux handle and the FIFO writer the `Recorder` tees encoded packets into.
    #[cfg(unix)]
    pub fn start(mp4_path: &str) -> Result<(ClipMux, Box<dyn Write>), String> {
        let fifo_path = super::fifo_path();
        fifo::make_fifo(&fifo_path)?;

        // Spawn ffmpeg FIRST (the reader). Its FIFO open() blocks inside ffmpeg, so
        // our subsequent write-open returns promptly. `-f h264 -r 60` forces the
        // raw Annex-B demuxer at the CFR clock (the stream carries no timestamps).
        let spawn = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-f", "h264", "-r", "60", "-i"])
            .arg(&fifo_path)
            .args([
                "-c:v", "copy",
                "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
                "-y",
            ])
            .arg(mp4_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawn {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&fifo_path);
                return Err(format!("spawn ffmpeg (is it installed?): {e}"));
            }
        };

        match fifo::open_writer_bounded(&fifo_path, &mut child, FIFO_OPEN_TIMEOUT) {
            Ok(file) => {
                let mux = ClipMux { mp4_path: mp4_path.to_string(), fifo_path, child: Some(child) };
                Ok((mux, Box::new(std::io::BufWriter::new(file))))
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&fifo_path);
                let _ = std::fs::remove_file(mp4_path);
                Err(e)
            }
        }
    }

    /// Windows: no Unix FIFO — spawn ffmpeg reading the raw H.264 from its piped
    /// stdin (`-i pipe:0`) and hand back the stdin writer. Dropping that writer is
    /// the EOF signal (the FIFO-close analog), so the same fragmented,
    /// kill-survivable MP4 contract holds. `fifo_path` is unused (empty PathBuf).
    #[cfg(windows)]
    pub fn start(mp4_path: &str) -> Result<(ClipMux, Box<dyn Write>), String> {
        let mut child = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-f", "h264", "-r", "60", "-i", "pipe:0"])
            .args([
                "-c:v", "copy",
                "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
                "-y",
            ])
            .arg(mp4_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            // Pipe stderr (was null) so finalize can read ffmpeg's actual error on a
            // non-zero exit — the EINVAL reason a bare exit code hides (WI-3 Step A).
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn ffmpeg (is it installed / on PATH?): {e}"))?;
        let stdin = child.stdin.take().ok_or("ffmpeg stdin pipe unavailable")?;
        let mux = ClipMux {
            mp4_path: mp4_path.to_string(),
            fifo_path: PathBuf::new(),
            child: Some(child),
        };
        Ok((mux, Box::new(std::io::BufWriter::new(stdin))))
    }

    /// Clean finalize — the `Recorder` has already closed the write end, so ffmpeg
    /// sees EOF and the video-only fragmented MP4 is complete. Wait for it, unlink
    /// the FIFO, then: if the clip captured audio (`audio_pcm`), run ONE ffmpeg pass
    /// that muxes the cut PCM in as an AAC track AND faststarts; otherwise just
    /// faststart-remux. A non-zero VIDEO ffmpeg exit is a real failure; a remux/mux
    /// failure is not (the fragmented file is already playable).
    pub fn finalize(mut self, audio_pcm: Option<Vec<u8>>, atempo: f64) -> Result<(), String> {
        // `wait_with_output` drains the (now piped) stderr so a finalize failure
        // carries ffmpeg's actual diagnostic (e.g. "Invalid data found"/no start
        // code) — the EINVAL reason a bare exit code hides (WI-3 Step A). stdout is
        // null; on Unix (inherited stderr) `out.stderr` is just empty, no regression.
        let status = self.child.take().map(|c| c.wait_with_output());
        let _ = std::fs::remove_file(&self.fifo_path);
        match status {
            Some(Ok(out)) if out.status.success() => {}
            Some(Ok(out)) => {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("ffmpeg mux exited {} — stderr: {}", out.status, err.trim()));
            }
            Some(Err(e)) => return Err(format!("wait ffmpeg: {e}")),
            None => {}
        }
        match audio_pcm {
            Some(pcm) if !pcm.is_empty() => mux_audio_and_faststart(&self.mp4_path, &pcm, atempo),
            _ => faststart_remux(&self.mp4_path),
        }
        Ok(())
    }

    /// Abort — build failed or the clip ended fatally. Kill ffmpeg, unlink the
    /// FIFO, and remove the partial `.mp4` (a broken clip is discarded, not listed).
    pub fn abort(mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_file(&self.fifo_path);
        let _ = std::fs::remove_file(&self.mp4_path);
    }
}

impl Drop for ClipMux {
    /// Safety net for an unexpected drop (e.g. a panic between start and
    /// finalize/abort): reap ffmpeg and unlink the FIFO. Never touches the `.mp4`
    /// — on a normal `finalize` that file is the product. After `finalize`/`abort`
    /// the child is already taken and the FIFO already gone, so this is a no-op.
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_file(&self.fifo_path);
    }
}

/// Extract a single poster frame from the finished `mp4` into a sibling `.jpg`
/// (same stem). Best-effort: returns the poster path, or None on failure (the clip
/// still saves without a thumbnail).
pub fn extract_poster(mp4_path: &str) -> Option<String> {
    let poster = std::path::Path::new(mp4_path).with_extension("jpg");
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(mp4_path)
        .args(["-frames:v", "1", "-q:v", "3"])
        .arg(&poster)
        .status();
    match status {
        Ok(s) if s.success() => Some(poster.to_string_lossy().into_owned()),
        other => {
            log::warn!("poster extract for {mp4_path} skipped: {other:?}");
            None
        }
    }
}

/// Add the cut PCM to the finished video-only `mp4` as an AAC track, faststarting
/// in one pass: write the raw f32 to a temp file, then
/// `ffmpeg -i <mp4> -f f32le -ar 48000 -ac 2 -i <pcm> -map 0:v:0 -map 1:a:0 \
///   -c:v copy -c:a aac -b:a 192k -movflags +faststart` to a temp output,
/// atomically renamed over `mp4`. Video frame 0 and PCM sample 0 both sit at t=0
/// (the cut already aligned sample 0 to T0), so lip-sync holds. Best-effort: on ANY
/// failure the silent video-only file is faststarted and stands.
fn mux_audio_and_faststart(mp4: &str, pcm: &[u8], atempo: f64) {
    let pcm_path = format!("{mp4}.pcm.tmp");
    if let Err(e) = std::fs::write(&pcm_path, pcm) {
        log::warn!("write temp pcm {pcm_path}: {e} — clip stays silent");
        faststart_remux(mp4);
        return;
    }
    let tmp = format!("{mp4}.mux.tmp");
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(mp4)
        .args(["-f", "f32le", "-ar", "48000", "-ac", "2", "-i"])
        .arg(&pcm_path)
        .args(["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"]);
    // Pitch-preserving tempo nudge so the audio ends with the CFR video (the heads
    // are already aligned by the cut). Skip when ~1.0 to avoid a needless pass.
    if (atempo - 1.0).abs() > 0.0005 {
        cmd.arg("-filter:a").arg(format!("atempo={atempo:.6}"));
    }
    // AAC, not Opus: WebKitGTK (the in-app player) does not play Opus-in-MP4 (the
    // file is valid — ffmpeg plays it fully — but the app's player stalls ~2s in).
    // AAC-in-MP4 is universally supported; finalize is a touch slower than Opus.
    cmd.args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&tmp);
    let status = cmd.status();
    let _ = std::fs::remove_file(&pcm_path);
    match status {
        Ok(s) if s.success() => {
            if let Err(e) = std::fs::rename(&tmp, mp4) {
                log::warn!("audio-mux rename {tmp} -> {mp4}: {e}");
                let _ = std::fs::remove_file(&tmp);
                faststart_remux(mp4);
            }
        }
        other => {
            log::warn!("audio mux of {mp4} failed ({other:?}) — keeping silent video, faststarting");
            let _ = std::fs::remove_file(&tmp);
            faststart_remux(mp4);
        }
    }
}

/// Faststart-remux `mp4` in place (`-c copy` → temp → atomic rename). Best-effort:
/// the input fragmented MP4 is already playable, so on any failure we keep it.
fn faststart_remux(mp4: &str) {
    let tmp = format!("{mp4}.faststart.tmp");
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(mp4)
        // `-f mp4` is required: ffmpeg can't infer the container from the
        // `.faststart.tmp` extension (the bug the first gate caught).
        .args(["-c", "copy", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&tmp)
        .status();
    match status {
        Ok(s) if s.success() => {
            if let Err(e) = std::fs::rename(&tmp, mp4) {
                log::warn!("faststart rename {tmp} -> {mp4}: {e}");
                let _ = std::fs::remove_file(&tmp);
            }
        }
        other => {
            log::warn!("faststart remux of {mp4} skipped (fragmented file stands): {other:?}");
            let _ = std::fs::remove_file(&tmp);
        }
    }
}
