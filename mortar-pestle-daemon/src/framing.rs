//! 3-WAY shared NDJSON framing: line write, id extraction, capped line read,
//! and the 1 MiB line cap constant. Consumed by all 3 sidecars.

use serde::de::DeserializeOwned;
use serde_json::Value;
use std::io;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// 1 MiB — the hostile-line cap. Broadcast already enforced this; adopting it
/// here gives capture/stt the same defense (closes the NDJSON silent-wedge
/// gotcha where an unbounded `BufReader::lines()` wedges on an unterminated
/// line). No legitimate capture/stt NDJSON line exceeds 1 MiB.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Write one NDJSON line (`line` + `\n` + flush).
pub async fn write_line<W: AsyncWrite + Unpin>(w: &mut W, line: &str) -> io::Result<()> {
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await?;
    Ok(())
}

/// Best-effort extract of the `id` field from a (possibly malformed) NDJSON line,
/// for error-correlation logging. Read-only — never re-serializes the envelope.
/// `String` → `""` fallback (capture/stt); `u64` → `0` fallback (broadcast,
/// matches `Response::err(0, …)`).
pub fn extract_id<Id: DeserializeOwned + Default>(line: &str) -> Id {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .and_then(|i| serde_json::from_value(i).ok())
        .unwrap_or_default()
}

/// Read one line into `buf` from a capped reader. Caller wraps the reader with
/// `.take(MAX_LINE_BYTES as u64)` so a hostile unterminated line is truncated
/// (not wedged). Returns `Ok(None)` at clean EOF, `Ok(Some(()))` on a line.
pub async fn read_capped_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut String,
) -> io::Result<Option<()>> {
    buf.clear();
    let n = reader.read_line(buf).await?;
    if n == 0 {
        Ok(None)
    } else {
        Ok(Some(()))
    }
}