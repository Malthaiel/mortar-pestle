//! Loopback HTTP server for media bytes only.
//!
//! WebKitGTK's HTMLMediaElement rejects custom URI schemes
//! (`iskariel-asset://...`) with NotSupportedError, so `<audio>` / `<video>`
//! can't load from the asset protocol. This module re-exposes the existing
//! byte-serving helpers in `asset_protocol` over plain HTTP on 127.0.0.1 —
//! the only origin WebKit accepts for media. SF12 removed the Fastify
//! sidecar but the media WebKit constraint outlived it.
//!
//! Routes (all loopback, no auth — same security profile as the prior
//! Fastify sidecar; the binary is desktop-only, no external attacker can
//! reach this port):
//!
//! ```text
//! GET /media?path=<abs>                          → native file bytes (Range)
//! GET /transcode/<16-hex>.mp4                    → live ffmpeg remux
//! GET /subs/<16-hex>.vtt                         → extracted WebVTT
//! GET /editor-proxy/<16-hex>.mp4                 → Video Editor proxy lane
//! ```
//!
//! Path containment + the hash-prefix access-token check are inherited from
//! the asset-protocol helpers (`is_under_allowed_root`, `strip_virtual`).

use std::borrow::Cow;
use std::net::SocketAddr;
use std::sync::OnceLock;

use axum::{
    body::Body,
    extract::Query,
    http::{header, HeaderMap, HeaderName, HeaderValue, Response, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::Deserialize;
use tokio::net::TcpListener;

use crate::asset_protocol::{
    mime_for_path, parse_range_against, serve_file_range, serve_subs, serve_transcode,
};
use crate::commands::media::is_under_allowed_root;
use crate::parsers::video_transcode::{snapshot_for_serve, EntryStatus};

static SERVER_PORT: OnceLock<u16> = OnceLock::new();

pub fn port() -> Option<u16> {
    SERVER_PORT.get().copied()
}

/// Bind to a kernel-assigned port on 127.0.0.1 and run the router until exit.
/// Returns the bound port via `port()` once `setup` completes.
pub async fn run() -> std::io::Result<()> {
    let app = Router::new()
        .route("/media", get(handle_media).options(handle_preflight))
        .route("/transcode/:hash", get(handle_transcode).options(handle_preflight))
        .route("/subs/:hash", get(handle_subs).options(handle_preflight))
        .route("/editor-proxy/:hash", get(handle_editor_proxy).options(handle_preflight));

    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let listener = TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    let _ = SERVER_PORT.set(local.port());
    log::info!("media server listening on http://{}", local);
    axum::serve(listener, app).await
}

#[derive(Deserialize)]
struct MediaQuery {
    path: String,
}

async fn handle_media(Query(q): Query<MediaQuery>, headers: HeaderMap) -> Response<Body> {
    use std::fs;
    use std::path::PathBuf;

    // Strip a Windows `\\?\` verbatim prefix. The Library vault path reaches the
    // frontend already canonicalized (with `\\?\`), and in a verbatim path
    // forward slashes are literal chars, not separators — so fs::canonicalize
    // fails on the mixed-separator URL path and 404s. No-op on non-verbatim
    // (Linux) paths.
    let requested = PathBuf::from(q.path.strip_prefix(r"\\?\").unwrap_or(&q.path));
    let canonical = match fs::canonicalize(&requested) {
        Ok(p) => p,
        Err(_) => return status(StatusCode::NOT_FOUND, "not found"),
    };
    if !is_under_allowed_root(&canonical) {
        return status(StatusCode::FORBIDDEN, "outside allowed root");
    }
    let meta = match fs::metadata(&canonical) {
        Ok(m) => m,
        Err(_) => return status(StatusCode::NOT_FOUND, "not found"),
    };
    if !meta.is_file() {
        return status(StatusCode::BAD_REQUEST, "not a file");
    }
    let file_size = meta.len();

    if headers.get(header::RANGE).is_none() {
        return stream_full_file(&canonical).await;
    }
    let range_opt = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| parse_range_against(raw, file_size));
    cow_response_to_axum(serve_file_range(&canonical, file_size, range_opt))
}

async fn handle_transcode(
    axum::extract::Path(hash_with_ext): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(hash) = hash_with_ext.strip_suffix(".mp4") else {
        return status(StatusCode::NOT_FOUND, "bad suffix");
    };
    // No Range header → stream the whole file as a 200 with the real
    // Content-Length. WebKitGTK's GStreamer souphttpsrc misreads a 206 returned
    // for an unconditional GET (it takes the chunk's Content-Length as the whole
    // resource and stops at ~8 MB → premature EOS / 'ended'). A full 200 plays
    // straight through; GStreamer issues Range requests (handled below) to seek.
    if headers.get(header::RANGE).is_none() {
        return match snapshot_for_serve(hash) {
            Some((_, EntryStatus::Failed { .. })) => {
                status(StatusCode::INTERNAL_SERVER_ERROR, "transcode failed")
            }
            Some((path, _)) => stream_full_file(&path).await,
            None => status(StatusCode::NOT_FOUND, "transcode not found"),
        };
    }
    let req = http::Request::builder()
        .method("GET")
        .uri("/")
        .body(Vec::<u8>::new())
        .map(|mut r| {
            if let Some(v) = headers.get(header::RANGE) {
                r.headers_mut().insert(header::RANGE, v.clone());
            }
            r
        })
        .unwrap();
    cow_response_to_axum(serve_transcode(hash, &req))
}

/// Video Editor proxy lane (parsers/editor_proxy.rs registry — NOT the player
/// lane's). Same WebKitGTK souphttpsrc workaround as handle_transcode: a
/// no-Range GET streams the whole file as a real 200 (a 206 there reads the
/// chunk length as the full resource and EOSes early); seeks arrive as Range
/// requests served from disk. vedit_remux_start awaits Done before handing
/// out URLs, so Running snapshots are never served bytes here.
async fn handle_editor_proxy(
    axum::extract::Path(hash_with_ext): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(hash) = hash_with_ext.strip_suffix(".mp4") else {
        return status(StatusCode::NOT_FOUND, "bad suffix");
    };
    match crate::parsers::editor_proxy::snapshot_for_serve(hash) {
        None => status(StatusCode::NOT_FOUND, "editor proxy not found"),
        Some((_, EntryStatus::Failed { .. })) => {
            status(StatusCode::INTERNAL_SERVER_ERROR, "editor remux failed")
        }
        Some((path, _)) => {
            if headers.get(header::RANGE).is_none() {
                return stream_full_file(&path).await;
            }
            let file_size = match std::fs::metadata(&path) {
                Ok(m) => m.len(),
                Err(_) => return status(StatusCode::NOT_FOUND, "proxy file missing"),
            };
            let range_opt = headers
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|raw| parse_range_against(raw, file_size));
            cow_response_to_axum(serve_file_range(&path, file_size, range_opt))
        }
    }
}

async fn handle_subs(
    axum::extract::Path(hash_with_ext): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(hash) = hash_with_ext.strip_suffix(".vtt") else {
        return status(StatusCode::NOT_FOUND, "bad suffix");
    };
    let req = http::Request::builder()
        .method("GET")
        .uri("/")
        .body(Vec::<u8>::new())
        .map(|mut r| {
            if let Some(v) = headers.get(header::RANGE) {
                r.headers_mut().insert(header::RANGE, v.clone());
            }
            r
        })
        .unwrap();
    cow_response_to_axum(serve_subs(hash, &req))
}

/// Stream an entire file as a 200 with the real Content-Length, read from disk
/// in 256 KB chunks (bounded memory, backpressured by the client). Used for
/// unconditional (no-Range) GETs: WebKitGTK's media pipeline treats a 206 sent
/// for a no-Range request as the whole resource and stops early, so media must
/// get a full 200 here. Seeks arrive as Range requests, served chunked.
async fn stream_full_file(path: &std::path::Path) -> Response<Body> {
    let file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return status(StatusCode::NOT_FOUND, "open failed"),
    };
    let total = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mime = mime_for_path(path);
    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 256 * 1024];
        let n = file.read(&mut buf).await?;
        if n == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            buf.truncate(n);
            Ok(Some((axum::body::Bytes::from(buf), file)))
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, total)
        .header(header::ACCEPT_RANGES, "bytes")
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges",
        )
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR, "build failed"))
}

/// CORS preflight (OPTIONS) for every media route. WebView2/Chromium preflights
/// a cross-origin `<video crossOrigin>` Range request (and PNA-preflights even a
/// simple loopback fetch); without an OPTIONS responder axum returns 405 with no
/// CORS headers, the preflight fails, and the media element reports "no supported
/// sources" (fetch throws). WebKitGTK didn't require this — the WebView2 port
/// does. Loopback-only; the path-containment check on the real GET is the gate.
async fn handle_preflight() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range, Content-Type")
        .header("Access-Control-Allow-Private-Network", "true")
        .header("Access-Control-Max-Age", "86400")
        .body(Body::empty())
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR, "preflight build failed"))
}

fn status(code: StatusCode, msg: &'static str) -> Response<Body> {
    // ACAO on error responses too: a cross-origin 404/403 without it is blocked
    // by the WebView2 CORS check and surfaces to fetch()/<video> as the opaque
    // "Failed to fetch" rather than the real status — masking media bugs.
    Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .body(Body::from(msg))
        .expect("static response builds")
}

fn cow_response_to_axum(resp: http::Response<Cow<'static, [u8]>>) -> Response<Body> {
    let (parts, body) = resp.into_parts();
    let bytes: Vec<u8> = body.into_owned();
    let mut builder = Response::builder().status(parts.status);
    for (name, value) in parts.headers.iter() {
        let n: &HeaderName = name;
        let v: &HeaderValue = value;
        builder = builder.header(n, v);
    }
    // WebKit enforces CORS on <video> Range requests (and on <track> subtitle
    // loads) even from tauri://localhost. Allow all origins — the server is
    // loopback-only and the path-containment check is the actual gate.
    builder = builder
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    builder
        .body(Body::from(bytes))
        .expect("response builds")
        .into_response()
}
