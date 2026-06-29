//! Sub-feature 7 / 7.5 — `mortar-pestle-asset://` URI scheme handler.
//!
//! URL forms:
//!
//! ```text
//! mortar-pestle-asset://localhost/<abs>                     (native files)
//! mortar-pestle-asset://localhost/transcode/<16-hex>.mp4    (live ffmpeg remux)
//! mortar-pestle-asset://localhost/subs/<16-hex>.vtt         (extracted WebVTT)
//! ```
//!
//! Native files are canonicalized and rejected unless contained under
//! `vault_root()` or any `media_roots()` entry. Per-request slice is capped at
//! `MAX_CHUNK` bytes — browsers Range-request more as they play / seek.
//!
//! `/transcode/<hash>.mp4` + `/subs/<hash>.vtt` (Sub-feature 7.5) Range-serve
//! hash-keyed cache files produced by `parsers::video_transcode`. The 16-hex
//! sha1 prefix is an unguessable access token — un-registered hashes return
//! 404 before any disk path is touched.
//!
//! Transcodes are served only after `video_start_transcode` reports the remux
//! complete, so `/transcode/<hash>.mp4` is a plain seekable file — there's no
//! growing-file polling here.

use std::borrow::Cow;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use http::{header, Response, StatusCode};
use tauri::http::Request;

use crate::commands::media::is_under_allowed_root;
use crate::parsers::video_transcode::{
    snapshot_for_serve, subs_path as transcode_subs_path, EntryStatus,
};

/// 8 MB per-request chunk cap. Browsers Range-request more as needed.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

pub fn handle(
    _ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let uri_path = request.uri().path();
    let decoded = match urlencoding::decode(uri_path) {
        Ok(s) => s.into_owned(),
        Err(_) => return simple_status(StatusCode::BAD_REQUEST, "invalid path encoding"),
    };
    if decoded.is_empty() || !decoded.starts_with('/') {
        return simple_status(StatusCode::BAD_REQUEST, "absolute path required");
    }

    // Sub-feature 7.5 virtual paths take priority over native-file lookup.
    if let Some(hash) = strip_virtual(&decoded, "/transcode/", ".mp4") {
        return serve_transcode(&hash, &request);
    }
    if let Some(hash) = strip_virtual(&decoded, "/subs/", ".vtt") {
        return serve_subs(&hash, &request);
    }

    serve_native_path(&decoded, &request)
}

fn serve_native_path(decoded: &str, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let requested = PathBuf::from(decoded);
    let canonical = match fs::canonicalize(&requested) {
        Ok(p) => p,
        Err(_) => return simple_status(StatusCode::NOT_FOUND, "not found"),
    };
    if !is_under_allowed_root(&canonical) {
        return simple_status(StatusCode::FORBIDDEN, "outside allowed root");
    }
    let meta = match fs::metadata(&canonical) {
        Ok(m) => m,
        Err(_) => return simple_status(StatusCode::NOT_FOUND, "not found"),
    };
    if !meta.is_file() {
        return simple_status(StatusCode::BAD_REQUEST, "not a file");
    }

    // Cover-thumbnail fast path: an `<img src="…?w=320">` request serves a
    // cached, downscaled JPEG instead of the full-resolution original, so the
    // Library Music tab doesn't decode dozens of large album covers into ~160px
    // tiles. Falls through to the full file on any decode/encode failure.
    if let Some(w) = parse_thumb_width(request) {
        if is_raster_image(&canonical) {
            if let Some(resp) = serve_thumbnail(&canonical, w) {
                return resp;
            }
        }
    }

    let file_size = meta.len();

    let range = match parse_range_from(request, file_size) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    serve_file_range(&canonical, file_size, range)
}

// ── Cover thumbnails ─────────────────────────────────────────────────────────

/// Parse a `?w=<n>` thumbnail width (clamped 16..=2000) from the request query.
fn parse_thumb_width(request: &Request<Vec<u8>>) -> Option<u32> {
    let q = request.uri().query()?;
    q.split('&').find_map(|pair| {
        let v = pair.strip_prefix("w=")?;
        let w: u32 = v.parse().ok()?;
        (16..=2000).contains(&w).then_some(w)
    })
}

fn is_raster_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "webp")
    )
}

/// Decode `path`, downscale to `width` px (never upscaling), JPEG-encode, and
/// cache the result in the OS temp dir keyed by path + mtime + width. Returns
/// `None` on any failure so the caller falls back to the full-size file.
fn serve_thumbnail(path: &Path, width: u32) -> Option<Response<Cow<'static, [u8]>>> {
    use std::hash::{Hash, Hasher};
    use std::io::Write;

    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    mtime.hash(&mut hasher);
    width.hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());

    let cache_dir = std::env::temp_dir().join("mortar-pestle-thumbs");
    let cache_path = cache_dir.join(format!("{key}.jpg"));

    if let Ok(bytes) = fs::read(&cache_path) {
        return Some(jpeg_response(bytes));
    }

    let img = image::open(path).ok()?;
    let (w0, h0) = (img.width(), img.height());
    if w0 == 0 || h0 == 0 {
        return None;
    }
    let target_w = width.min(w0); // never upscale
    let target_h = ((u64::from(h0) * u64::from(target_w)) / u64::from(w0)).max(1) as u32;
    let resized = img.resize(target_w, target_h, image::imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();

    let mut buf: Vec<u8> = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 82);
    enc.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .ok()?;

    let _ = fs::create_dir_all(&cache_dir);
    if let Ok(mut f) = File::create(&cache_path) {
        let _ = f.write_all(&buf);
    }
    Some(jpeg_response(buf))
}

fn jpeg_response(bytes: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CACHE_CONTROL, "private, max-age=31536000")
        .body(Cow::Owned(bytes))
        .expect("jpeg response builds")
}

/// Accept only `<prefix><16-lowercase-hex><suffix>` — path-injection defense.
pub fn strip_virtual(p: &str, prefix: &str, suffix: &str) -> Option<String> {
    let inner = p.strip_prefix(prefix)?.strip_suffix(suffix)?;
    if inner.len() != 16 {
        return None;
    }
    if !inner.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()) {
        return None;
    }
    Some(inner.to_string())
}

pub fn serve_transcode(hash: &str, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let Some((path, status)) = snapshot_for_serve(hash) else {
        return simple_status(StatusCode::NOT_FOUND, "transcode not found");
    };
    if matches!(status, EntryStatus::Failed { .. }) {
        return simple_status(StatusCode::INTERNAL_SERVER_ERROR, "transcode failed");
    }

    // `video_start_transcode` only returns the URL once the remux is complete, so
    // the file is final by the time the element requests it — serve it as a plain
    // seekable byte range, identical to a native media file.
    let file_size = match fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(_) => return simple_status(StatusCode::NOT_FOUND, "transcode not found"),
    };
    if file_size == 0 {
        return simple_status(StatusCode::INTERNAL_SERVER_ERROR, "empty transcode");
    }
    let range = match parse_range_from(request, file_size) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    serve_file_range(&path, file_size, range)
}

pub fn serve_subs(hash: &str, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = match transcode_subs_path(hash) {
        Ok(p) => p,
        Err(_) => return simple_status(StatusCode::INTERNAL_SERVER_ERROR, "subs path failed"),
    };
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return simple_status(StatusCode::NOT_FOUND, "subs not found"),
    };
    if !meta.is_file() {
        return simple_status(StatusCode::NOT_FOUND, "subs not file");
    }
    let file_size = meta.len();
    let range = match parse_range_from(request, file_size) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    serve_file_range(&path, file_size, range)
}

/// Read + respond with a (possibly partial) slice of `path`.
///
/// `known_size` is the total reported in `Content-Range` for partial responses
/// and used to derive default ranges for `range = None`.
pub fn serve_file_range(
    path: &Path,
    known_size: u64,
    range: Option<(u64, u64)>,
) -> Response<Cow<'static, [u8]>> {
    let (start, end, is_partial) = match range {
        Some((s, e)) => {
            let capped_end = e.min(s.saturating_add(MAX_CHUNK).saturating_sub(1));
            (s, capped_end, true)
        }
        None if known_size > MAX_CHUNK => {
            // No Range header, but the file exceeds one chunk. Respond 206 with
            // the real total in Content-Range so the client learns the true size
            // and Range-requests the rest. A capped 200 would advertise an 8 MB
            // Content-Length that the media pipeline reads as EOF — playing only
            // the first chunk and firing a premature 'ended'.
            (0u64, MAX_CHUNK - 1, true)
        }
        None => {
            // Fits in a single chunk → a normal full 200.
            (0u64, known_size.saturating_sub(1), false)
        }
    };

    if known_size == 0 || start >= known_size || end < start {
        return range_not_satisfiable(known_size);
    }
    let len = end - start + 1;

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return simple_status(StatusCode::NOT_FOUND, "open failed"),
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return simple_status(StatusCode::INTERNAL_SERVER_ERROR, "seek failed");
    }
    let mut buf = vec![0u8; len as usize];
    if let Err(e) = file.read_exact(&mut buf) {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            let mut shrink = Vec::with_capacity(len as usize);
            if file.seek(SeekFrom::Start(start)).is_err() {
                return simple_status(StatusCode::INTERNAL_SERVER_ERROR, "seek failed");
            }
            if file.take(len).read_to_end(&mut shrink).is_err() {
                return simple_status(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
            }
            buf = shrink;
        } else {
            return simple_status(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
        }
    }

    let actual_len = buf.len() as u64;
    let actual_end = start + actual_len.saturating_sub(1);

    let mime = mime_for_path(path);

    let status = if is_partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, actual_len);
    if is_partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{actual_end}/{known_size}"),
        );
    }
    builder
        .body(Cow::Owned(buf))
        .unwrap_or_else(|_| simple_status(StatusCode::INTERNAL_SERVER_ERROR, "build failed"))
}

/// MIME with explicit codec hints where mime_guess falls short. Opus-in-Ogg
/// is the load-bearing case: WebKitGTK rejects `<audio src=…>` with
/// NotSupportedError unless the response is `audio/ogg; codecs=opus` — the
/// bare `audio/ogg` mime_guess returns isn't enough for the decoder to pick
/// the right pipeline. Chromium-based WebViews are more forgiving and sniff
/// the container, which is why browser-tab dev (Fastify, which already sends
/// the hint) plays opus fine.
pub fn mime_for_path(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("opus") => "audio/ogg; codecs=opus".to_string(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string(),
    }
}

/// Extract the parsed Range from `request`, resolved against `file_size`. The
/// caller surrenders an early response on header-parse failure.
fn parse_range_from(
    request: &Request<Vec<u8>>,
    file_size: u64,
) -> Result<Option<(u64, u64)>, Response<Cow<'static, [u8]>>> {
    let Some(value) = request.headers().get(header::RANGE) else {
        return Ok(None);
    };
    let raw = match value.to_str() {
        Ok(s) => s,
        Err(_) => return Err(range_not_satisfiable(file_size)),
    };
    match parse_range_against(raw, file_size) {
        Some(r) => Ok(Some(r)),
        None => Err(range_not_satisfiable(file_size)),
    }
}

fn simple_status(status: StatusCode, msg: &'static str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Borrowed(msg.as_bytes()))
        .expect("static response builds")
}

fn range_not_satisfiable(file_size: u64) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CONTENT_RANGE, format!("bytes */{file_size}"))
        .body(Cow::Borrowed(&b"range not satisfiable"[..]))
        .expect("static response builds")
}

/// Resolve a Range header value against a known total size.
///
/// Supported forms (per RFC 7233 §2.1, single-range subset):
/// - `bytes=START-END`   → inclusive byte range, clamped end
/// - `bytes=START-`      → from START to EOF
/// - `bytes=-LEN`        → suffix range: the last LEN bytes
///
/// Multi-range requests honor only the first range.
pub fn parse_range_against(raw: &str, file_size: u64) -> Option<(u64, u64)> {
    let raw = raw.trim();
    let rest = raw.strip_prefix("bytes=")?;
    let first = rest.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;
    let start_s = start_s.trim();
    let end_s = end_s.trim();
    if start_s.is_empty() {
        let len: u64 = end_s.parse().ok()?;
        if len == 0 || file_size == 0 {
            return None;
        }
        let start = file_size.saturating_sub(len);
        return Some((start, file_size - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    if start >= file_size {
        return None;
    }
    if end_s.is_empty() {
        return Some((start, file_size - 1));
    }
    let end: u64 = end_s.parse().ok()?;
    let end = end.min(file_size - 1);
    if end < start {
        return None;
    }
    Some((start, end))
}

// Backwards-compat alias for existing call sites + tests.
pub fn parse_range(raw: &str, file_size: u64) -> Option<(u64, u64)> {
    parse_range_against(raw, file_size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_start_end() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-199", 1000), Some((100, 199)));
    }

    #[test]
    fn range_start_open() {
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
    }

    #[test]
    fn range_suffix() {
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 50), Some((0, 49)));
    }

    #[test]
    fn range_clamps_end_to_eof() {
        assert_eq!(parse_range("bytes=0-9999", 1000), Some((0, 999)));
    }

    #[test]
    fn range_rejects_start_past_eof() {
        assert_eq!(parse_range("bytes=2000-3000", 1000), None);
    }

    #[test]
    fn range_rejects_zero_suffix_on_empty() {
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("bytes=-100", 0), None);
    }

    #[test]
    fn range_rejects_garbage() {
        assert_eq!(parse_range("foo", 1000), None);
        assert_eq!(parse_range("bytes=abc-def", 1000), None);
    }

    #[test]
    fn range_takes_first_of_multi() {
        assert_eq!(parse_range("bytes=0-99,200-299", 1000), Some((0, 99)));
    }

    #[test]
    fn strip_virtual_accepts_16_hex() {
        assert_eq!(
            strip_virtual("/transcode/0123456789abcdef.mp4", "/transcode/", ".mp4"),
            Some("0123456789abcdef".to_string())
        );
    }

    #[test]
    fn strip_virtual_rejects_short_hash() {
        assert_eq!(
            strip_virtual("/transcode/0123abc.mp4", "/transcode/", ".mp4"),
            None
        );
    }

    #[test]
    fn strip_virtual_rejects_uppercase_hex() {
        assert_eq!(
            strip_virtual("/transcode/0123456789ABCDEF.mp4", "/transcode/", ".mp4"),
            None
        );
    }

    #[test]
    fn strip_virtual_rejects_non_hex_char() {
        assert_eq!(
            strip_virtual("/transcode/0123456789abcdex.mp4", "/transcode/", ".mp4"),
            None
        );
    }

    #[test]
    fn strip_virtual_rejects_wrong_suffix() {
        assert_eq!(
            strip_virtual("/transcode/0123456789abcdef.webm", "/transcode/", ".mp4"),
            None
        );
    }

    #[test]
    fn strip_virtual_rejects_wrong_prefix() {
        assert_eq!(
            strip_virtual("/foo/0123456789abcdef.mp4", "/transcode/", ".mp4"),
            None
        );
    }

    #[test]
    fn strip_virtual_rejects_path_injection() {
        // Slashes break the hex check, so dotdot can't escape.
        assert_eq!(
            strip_virtual("/transcode/../etc/passwd.mp4", "/transcode/", ".mp4"),
            None
        );
    }
}
