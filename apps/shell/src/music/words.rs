//! A song's words for the main page's Lyrics box (Music Tab Redesign step 3; the
//! shell's Media tab had them until step 2, `git show 12a8e104:apps/shell/src/
//! words.rs`), Windows' `music_lyrics` (`src-tauri/src/
//! commands/music_lyrics.rs`) and `LyricsPanel.jsx` `parseLyrics`: the `.lrc` file
//! beside the song first, else LRCLIB (lrclib.net, free, no key) by artist / title /
//! album / length, saved beside the song so each song is asked once (his pick
//! 2026-10-30). Asked through the system's `curl`, as the rest of the music program
//! asks the internet, one run per song, only while the box is open. Only those four
//! fields leave the machine. A song with no file is asked again after each start of
//! the music program (it keeps a copy until then).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use serde_json::Value;

use crate::music::now::Now;
use crate::music::web::AGENT;

const LRCLIB: &str = "https://lrclib.net/api";

#[derive(Debug, Clone)]
pub struct Line {
    /// Seconds into the song; none for plain words.
    pub time: Option<f64>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub enum Words {
    Finding,
    None,
    Failed,
    Lines(Arc<Vec<Line>>),
}

/// What the words are kept under: the song's file, else its artist and title.
pub fn key(p: &Now) -> String {
    if p.url.is_empty() { format!("{}|{}", p.artist, p.title) } else { p.url.clone() }
}

/// The `.lrc` beside a song file (`file://` only).
fn beside(url: &str) -> Option<PathBuf> {
    let path = url.strip_prefix("file://")?;
    let path = mp_ui::portal::unescape(path);
    Some(PathBuf::from(path).with_extension("lrc"))
}

/// The words, read or fetched. Blocks: run it off the box's thread.
pub fn fetch(p: Now) -> Words {
    let lrc = beside(&p.url);
    if let Some(text) = lrc.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) {
        return words(&text);
    }
    let found = match ask(&p) {
        Ok(found) => found,
        Err(()) => return Words::Failed,
    };
    let Some(text) = found else { return Words::None };
    // A failed save only means the song is asked again next time.
    if let Some(f) = lrc {
        let _ = std::fs::write(f, &text);
    }
    words(&text)
}

/// `/get` wants the exact song (album + length within 2 s); `/search` is the loose
/// fallback, timed words first (Windows' order).
fn ask(p: &Now) -> Result<Option<String>, ()> {
    let mut fields = vec![("artist_name", p.artist.clone()), ("track_name", p.title.clone())];
    if !p.album.is_empty() && p.length > 0.0 {
        fields.extend([("album_name", p.album.clone()), ("duration", format!("{}", p.length.round()))]);
        if let Some(hit) = get("get", &fields)?
            && let Some(w) = text(&hit)
        {
            return Ok(Some(w));
        }
        fields.truncate(2);
    }
    let hits = get("search", &fields)?;
    let list = hits.as_ref().and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let timed = list.iter().find(|h| h.get("syncedLyrics").and_then(Value::as_str).is_some());
    Ok(timed.or(list.first()).and_then(text))
}

/// One `curl` run; none on a 404 (LRCLIB has no such song).
fn get(what: &str, fields: &[(&str, String)]) -> Result<Option<Value>, ()> {
    let mut curl = Command::new("curl");
    curl.args(["-sS", "--max-time", "15", "-A", AGENT, "-G", "-w", "\n%{http_code}"]);
    for (k, v) in fields {
        curl.arg("--data-urlencode").arg(format!("{k}={v}"));
    }
    let out = curl.arg(format!("{LRCLIB}/{what}")).output().map_err(|e| eprintln!("mp-shell: music: curl: {e}"))?;
    let body = String::from_utf8_lossy(&out.stdout);
    let (json, code) = body.rsplit_once('\n').ok_or(())?;
    match code.trim() {
        "200" => serde_json::from_str(json).map(Some).map_err(|_| ()),
        "404" => Ok(None),
        code => {
            eprintln!("mp-shell: music: lrclib.net {what}: {code} {}", String::from_utf8_lossy(&out.stderr).trim());
            Err(())
        }
    }
}

/// Timed words first, then plain; an instrumental says so.
fn text(v: &Value) -> Option<String> {
    let text = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string);
    text("syncedLyrics").or_else(|| text("plainLyrics")).or_else(|| v.get("instrumental").and_then(Value::as_bool).filter(|b| *b).map(|_| "(Instrumental)".to_string()))
}

/// LRC (`[mm:ss.xx]` lines, several stamps a line allowed) or plain text.
fn words(body: &str) -> Words {
    let mut out = Vec::new();
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            out.push(Line { time: None, text: String::new() });
            continue;
        }
        let mut rest = line;
        let mut times = Vec::new();
        while let Some(t) = stamp(rest) {
            times.push(t.0);
            rest = t.1;
        }
        // A tag line (`[ar:...]`) isn't words.
        if times.is_empty() && line.starts_with('[') && line.ends_with(']') {
            continue;
        }
        if times.is_empty() {
            out.push(Line { time: None, text: line.trim().into() });
        }
        out.extend(times.into_iter().map(|t| Line { time: Some(t), text: rest.trim().into() }));
    }
    // Untimed lines first, then by time (Windows' sort).
    if out.iter().any(|l| l.time.is_some()) {
        out.sort_by(|a, b| a.time.unwrap_or(-1.0).total_cmp(&b.time.unwrap_or(-1.0)));
    }
    if out.iter().all(|l| l.text.is_empty()) { Words::None } else { Words::Lines(Arc::new(out)) }
}

/// A leading `[mm:ss]` or `[mm:ss.xx]`: its seconds and what follows.
fn stamp(s: &str) -> Option<(f64, &str)> {
    let inner = s.strip_prefix('[')?;
    let (inside, rest) = inner.split_once(']')?;
    let (m, sec) = inside.split_once(':')?;
    let (s, frac) = sec.split_once('.').unwrap_or((sec, ""));
    if m.is_empty() || s.len() != 2 || !(m.chars().chain(s.chars()).chain(frac.chars()).all(|c| c.is_ascii_digit())) {
        return None;
    }
    let frac = if frac.is_empty() { 0.0 } else { format!("0.{frac}").parse().ok()? };
    Some((m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()? + frac, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timed_lines_sorted_tags_skipped() {
        let Words::Lines(l) = words("[ar:Someone]\n[00:12.50]second\n[00:01.00][00:20]twice\n\nplain") else { panic!() };
        let got: Vec<_> = l.iter().map(|l| (l.time, l.text.as_str())).collect();
        assert_eq!(got, [(None, ""), (None, "plain"), (Some(1.0), "twice"), (Some(12.5), "second"), (Some(20.0), "twice")]);
    }

    #[test]
    fn file_url_decoded() {
        assert_eq!(beside("file:///home/m/Music/A%20B/01%20C.opus"), Some(PathBuf::from("/home/m/Music/A B/01 C.lrc")));
    }
}
