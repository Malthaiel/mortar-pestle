//! Sub-feature 9 — PTY command surface.
//!
//! Wire shape — single tagged enum, one Channel per session:
//!
//! ```json
//! { "kind": "data", "text": "..." }
//! { "kind": "exit", "exit_code": 0, "signal": null }
//! ```
//!
//! No log file, no retention, no replay buffer, no late-attach subscribe, no
//! cancel-escalation ladder — the JS `TerminalProvider` ring at
//! `modules/core/terminal/TerminalProvider.jsx` already gives per-tab replay
//! semantics, and `Ctrl+C` is just a keystroke the user sends through
//! `pty_write`. Close = drop master = SIGHUP to child.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::commands::vault::{vault_root, PtyError};

// ─── Wire types ─────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PtyEvent {
    Data {
        text: String,
    },
    Exit {
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
}

#[derive(Serialize)]
pub struct PtyOpenResponse {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

// ─── Session state + registry ──────────────────────────────────────────────

struct PtySession {
    pty_master: Option<Box<dyn MasterPty + Send>>,
    pty_writer: Option<Box<dyn Write + Send>>,
}

type SessionArc = Arc<Mutex<PtySession>>;

fn sessions() -> &'static Mutex<HashMap<String, SessionArc>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, SessionArc>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ─── UTF-8 boundary helper ─────────────────────────────────────────────────

/// Split a byte buffer at the last complete UTF-8 boundary. Returns the valid
/// UTF-8 prefix as a String and any incomplete trailing bytes (≤ 3) as a
/// remainder to be prepended to the next read. Prevents `U+FFFD` replacement
/// glyphs when a multi-byte char straddles a 4096-byte read boundary.
fn split_at_utf8_boundary(buf: &[u8]) -> (String, Vec<u8>) {
    if buf.is_empty() {
        return (String::new(), Vec::new());
    }
    // UTF-8 char lengths: 1-byte (0xxxxxxx), 2-byte (110xxxxx + 10xxxxxx),
    // 3-byte (1110xxxx + 2×10xxxxxx), 4-byte (11110xxx + 3×10xxxxxx). A
    // continuation byte has the high two bits `10`. Walk back at most 3 bytes
    // from the tail looking for the start of the last sequence; if its
    // declared length exceeds what's present, hold those bytes back.
    let mut split_at = buf.len();
    for back in 1..=4.min(buf.len()) {
        let i = buf.len() - back;
        let b = buf[i];
        if b & 0b1100_0000 != 0b1000_0000 {
            // Lead byte of a sequence. Decode declared length.
            let needed = if b & 0b1000_0000 == 0 {
                1
            } else if b & 0b1110_0000 == 0b1100_0000 {
                2
            } else if b & 0b1111_0000 == 0b1110_0000 {
                3
            } else if b & 0b1111_1000 == 0b1111_0000 {
                4
            } else {
                // Invalid lead byte — let from_utf8_lossy handle it; don't
                // hold back anything.
                split_at = buf.len();
                break;
            };
            let have = back;
            split_at = if have >= needed { buf.len() } else { i };
            break;
        }
    }
    let valid = String::from_utf8_lossy(&buf[..split_at]).into_owned();
    let remainder = buf[split_at..].to_vec();
    (valid, remainder)
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pty_open(
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<PtyOpenResponse, PtyError> {
    if cols < 1 || rows < 1 {
        return Err(PtyError::SpawnFailed(format!(
            "cols/rows must be >= 1 (got cols={cols} rows={rows})"
        )));
    }

    let session_id = uuid::Uuid::new_v4().to_string();

    let pty_pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| PtyError::SpawnFailed(format!("openpty: {e}")))?;
    let master = pty_pair.master;
    let slave = pty_pair.slave;

    #[cfg(not(windows))]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    // Windows: prefer PowerShell (pwsh 7 → Windows PowerShell), else cmd.exe.
    #[cfg(windows)]
    let shell = {
        let mut chosen: Option<String> = None;
        if let Ok(path) = std::env::var("PATH") {
            'outer: for name in ["pwsh.exe", "powershell.exe"] {
                for dir in std::env::split_paths(&path) {
                    let cand = dir.join(name);
                    if cand.is_file() {
                        chosen = Some(cand.to_string_lossy().into_owned());
                        break 'outer;
                    }
                }
            }
        }
        chosen.unwrap_or_else(|| std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()))
    };
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(vault_root());
    // Inherit env, then force-override TERM (matches server/src/pty/routes.js
    // and the SF8 skills runner pattern in commands/skills.rs:299-304).
    for (k, v) in std::env::vars() {
        if k == "TERM" {
            continue;
        }
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = slave
        .spawn_command(cmd)
        .map_err(|e| PtyError::SpawnFailed(format!("spawn {shell}: {e}")))?;
    drop(slave); // master.read sees EOF on child exit only after slave drops

    let reader = master
        .try_clone_reader()
        .map_err(|e| PtyError::SpawnFailed(format!("clone_reader: {e}")))?;
    let writer = master
        .take_writer()
        .map_err(|e| PtyError::SpawnFailed(format!("take_writer: {e}")))?;

    let state = PtySession {
        pty_master: Some(master),
        pty_writer: Some(writer),
    };
    let arc: SessionArc = Arc::new(Mutex::new(state));

    {
        let mut map = sessions().lock().map_err(|e| PtyError::Io(e.to_string()))?;
        map.insert(session_id.clone(), arc.clone());
    }

    // Read loop in a dedicated std::thread — portable-pty's reader is blocking
    // and not Send across tokio task boundaries (same constraint SF8 hit at
    // commands/skills.rs:362-382).
    let session_id_for_thread = session_id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut leftover: Vec<u8> = Vec::with_capacity(4);
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut combined = std::mem::take(&mut leftover);
                    combined.extend_from_slice(&buf[..n]);
                    let (text, remainder) = split_at_utf8_boundary(&combined);
                    leftover = remainder;
                    if !text.is_empty() {
                        let _ = on_event.send(PtyEvent::Data { text });
                    }
                }
                Err(_) => break,
            }
        }
        // Flush any trailing leftover (incomplete sequence at EOF — emit as
        // lossy so the bytes aren't silently dropped).
        if !leftover.is_empty() {
            let text = String::from_utf8_lossy(&leftover).into_owned();
            let _ = on_event.send(PtyEvent::Data { text });
        }
        let exit_code = match child.wait() {
            Ok(s) => Some(s.exit_code() as i32),
            Err(_) => Some(-1),
        };
        let _ = on_event.send(PtyEvent::Exit {
            exit_code,
            signal: None, // portable-pty's ExitStatus doesn't expose signal info
        });
        if let Ok(mut map) = sessions().lock() {
            map.remove(&session_id_for_thread);
        }
    });

    Ok(PtyOpenResponse { session_id })
}

#[tauri::command]
pub async fn pty_write(session_id: String, data: String) -> Result<(), PtyError> {
    let arc = {
        let map = sessions().lock().map_err(|e| PtyError::Io(e.to_string()))?;
        map.get(&session_id)
            .cloned()
            .ok_or_else(|| PtyError::NotFound(format!("PTY session not found: {session_id}")))?
    };
    let mut state = arc.lock().map_err(|e| PtyError::Io(e.to_string()))?;
    if let Some(writer) = state.pty_writer.as_mut() {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| PtyError::Io(e.to_string()))?;
        writer.flush().map_err(|e| PtyError::Io(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(session_id: String, cols: u16, rows: u16) -> Result<(), PtyError> {
    if cols < 1 || rows < 1 {
        return Ok(()); // mirror server's silent-swallow on invalid resize
    }
    let arc = {
        let map = sessions().lock().map_err(|e| PtyError::Io(e.to_string()))?;
        map.get(&session_id)
            .cloned()
            .ok_or_else(|| PtyError::NotFound(format!("PTY session not found: {session_id}")))?
    };
    let state = arc.lock().map_err(|e| PtyError::Io(e.to_string()))?;
    if let Some(master) = state.pty_master.as_ref() {
        let _ = master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_close(session_id: String) -> Result<(), PtyError> {
    // Drop master + writer → kernel sends SIGHUP to child → read loop hits
    // EOF → emits PtyEvent::Exit → removes session from map naturally.
    let arc = {
        let map = sessions().lock().map_err(|e| PtyError::Io(e.to_string()))?;
        map.get(&session_id).cloned()
    };
    if let Some(arc) = arc {
        let mut state = arc.lock().map_err(|e| PtyError::Io(e.to_string()))?;
        state.pty_writer = None;
        state.pty_master = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_boundary_clean_ascii() {
        let (text, remainder) = split_at_utf8_boundary(b"hello");
        assert_eq!(text, "hello");
        assert!(remainder.is_empty());
    }

    #[test]
    fn utf8_boundary_complete_multibyte() {
        let buf = "héllo 🐎".as_bytes();
        let (text, remainder) = split_at_utf8_boundary(buf);
        assert_eq!(text, "héllo 🐎");
        assert!(remainder.is_empty());
    }

    #[test]
    fn utf8_boundary_split_2byte() {
        // 'é' = 0xC3 0xA9; pass only the first byte.
        let buf = b"a\xC3";
        let (text, remainder) = split_at_utf8_boundary(buf);
        assert_eq!(text, "a");
        assert_eq!(remainder, vec![0xC3]);
    }

    #[test]
    fn utf8_boundary_split_3byte() {
        // '€' = 0xE2 0x82 0xAC; pass only the first two bytes.
        let buf = b"a\xE2\x82";
        let (text, remainder) = split_at_utf8_boundary(buf);
        assert_eq!(text, "a");
        assert_eq!(remainder, vec![0xE2, 0x82]);
    }

    #[test]
    fn utf8_boundary_split_4byte() {
        // '🐎' = 0xF0 0x9F 0x90 0x8E; pass only the first 3 bytes.
        let buf = b"a\xF0\x9F\x90";
        let (text, remainder) = split_at_utf8_boundary(buf);
        assert_eq!(text, "a");
        assert_eq!(remainder, vec![0xF0, 0x9F, 0x90]);
    }

    #[test]
    fn utf8_boundary_consecutive_splits() {
        // Simulate streaming: read 1 gives "a" + first byte of 'é';
        // read 2 prepends the leftover and gives the rest.
        let (text1, leftover1) = split_at_utf8_boundary(b"a\xC3");
        assert_eq!(text1, "a");
        assert_eq!(leftover1, vec![0xC3]);

        let mut combined = leftover1;
        combined.extend_from_slice(b"\xA9b");
        let (text2, leftover2) = split_at_utf8_boundary(&combined);
        assert_eq!(text2, "éb");
        assert!(leftover2.is_empty());
    }

    #[test]
    fn utf8_boundary_empty_input() {
        let (text, remainder) = split_at_utf8_boundary(&[]);
        assert_eq!(text, "");
        assert!(remainder.is_empty());
    }
}
