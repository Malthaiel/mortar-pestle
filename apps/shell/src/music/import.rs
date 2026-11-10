//! Bringing in a playlist from a file (M&P Library plan, step 4 piece D): Windows'
//! `import_music_parse.py` without its Python helper. A `.csv` is read by its header
//! names, so any exporter's columns are found (chosic, Exportify, TuneMyMusic); a
//! `.txt`, or a `.csv` with no title column, is `Artist - Title` lines. Kept of each
//! song: its name, its first artist, its length (an import's albums don't go on the
//! wall, his pick chat 37). The playlist is named after the file, `_` read as spaces.

use std::path::Path;

/// Header names, lowercased with their spaces run together (Windows' `ALIASES`).
const TITLE: [&str; 7] = ["track", "track name", "title", "song", "name", "song name", "track title"];
const ARTIST: [&str; 6] = ["artist", "artist name", "artist name(s)", "artists", "artist names", "performer"];
const LENGTH: [&str; 9] = ["duration", "duration (ms)", "duration ms", "duration_ms", "length", "time", "track duration (ms)", "track duration", "runtime"];

pub struct Song {
    pub title: String,
    pub artist: String,
    /// Seconds.
    pub length: Option<u32>,
}

impl Song {
    /// Tabs and line breaks (a quoted cell may hold them) as one space each run: a
    /// playlist keeps a song a line, its fields split on tabs.
    fn new(title: &str, artist: &str, length: Option<u32>) -> Self {
        let plain = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        Song { title: plain(title), artist: plain(artist), length }
    }
}

/// The file's songs in order; none when it can't be read or holds none.
pub fn read(path: &Path) -> Vec<Song> {
    let bytes = std::fs::read(path).map_err(|e| eprintln!("mp-shell: music: {}: {e}", path.display())).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    let txt = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("txt"));
    (!txt).then(|| table(text)).flatten().unwrap_or_else(|| lines(text))
}

/// The playlist's name: the file's, `_` read as spaces (Windows').
pub fn name(path: &Path) -> String {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().replace('_', " ");
    stem.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A `.csv` by its header; none without a title column.
fn table(text: &str) -> Option<Vec<Song>> {
    let mut rows = records(text).into_iter();
    let header: Vec<String> = rows.next()?.iter().map(|h| h.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()).collect();
    let column = |names: &[&str]| header.iter().position(|h| names.contains(&h.as_str()));
    let title = column(&TITLE)?;
    let (artist, length) = (column(&ARTIST), column(&LENGTH));
    let ms = length.is_some_and(|i| header[i].contains("ms"));
    let songs = rows.filter_map(|row| {
        let cell = |i: Option<usize>| i.and_then(|i| row.get(i)).map_or("", |s| s.trim());
        let title = cell(Some(title));
        // Exports join several artists with ';', a name no search knows: the first
        // (his pick on Windows 2026-10-07).
        let artist = cell(artist).split(';').next().unwrap_or_default().trim();
        (!title.is_empty()).then(|| Song::new(title, artist, seconds(cell(length), ms)))
    });
    Some(songs.collect())
}

/// `Artist - Title` a line (a line without " - " is a title alone); `#` lines and
/// empty ones skipped.
fn lines(text: &str) -> Vec<Song> {
    let song = |s: &str| {
        let (artist, title) = s.split_once(" - ").unwrap_or(("", s));
        Song::new(title, artist, None)
    };
    text.lines().map(str::trim).filter(|s| !s.is_empty() && !s.starts_with('#')).map(song).collect()
}

/// A length as seconds: `m:ss`, or a number, which is milliseconds when its header
/// says so or it is over an hour (Windows').
fn seconds(s: &str, ms: bool) -> Option<u32> {
    let secs = if s.contains(':') {
        s.split(':').filter(|p| !p.is_empty()).try_fold(0.0, |total, p| Some(total * 60.0 + p.trim().parse::<f64>().ok()?.trunc()))?
    } else {
        let v: f64 = s.parse().ok()?;
        if ms || v > 3600.0 { v / 1000.0 } else { v }
    };
    Some(secs.round() as u32).filter(|s| *s > 0)
}

/// CSV as Python's reader reads it: commas between cells, a cell in quotes may hold
/// commas, line breaks and `""` for a quote; a quote opens only at a cell's start.
fn records(text: &str) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut cell) = (Vec::new(), Vec::new(), String::new());
    let (mut quoted, mut opened) = (false, false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted => {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                } else {
                    quoted = false;
                }
            }
            '"' if cell.is_empty() && !opened => (quoted, opened) = (true, true),
            ',' if !quoted => {
                row.push(std::mem::take(&mut cell));
                opened = false;
            }
            '\n' if !quoted => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
                opened = false;
            }
            '\r' if !quoted => {}
            c => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_is_read_as_pythons_reader_reads_it() {
        assert_eq!(records("a,b\r\n\"x, y\",\"say \"\"hi\"\"\"\n"), [vec!["a", "b"], vec!["x, y", "say \"hi\""]]);
        // A quote opens only at a cell's start; a quoted cell may hold a line break.
        assert_eq!(records("5\" disc,\"two\nlines\""), [vec!["5\" disc", "two\nlines"]]);
    }

    #[test]
    fn a_table_is_read_by_its_header_names() {
        let songs = table("Track  Name,Artist Name(s),Duration (ms)\nOne,A;B,185000\n,skipped,1\n\"Tab\there\",C,\n").unwrap();
        let got: Vec<_> = songs.iter().map(|s| (s.title.as_str(), s.artist.as_str(), s.length)).collect();
        assert_eq!(got, [("One", "A", Some(185)), ("Tab here", "C", None)]);
        // No title column: not a table.
        assert!(table("foo,bar\n1,2\n").is_none());
        let got: Vec<_> = lines("# mine\nA - One\n\nTwo\n").into_iter().map(|s| (s.artist, s.title)).collect();
        assert_eq!(got, [("A".to_string(), "One".to_string()), (String::new(), "Two".to_string())]);
    }

    #[test]
    fn lengths_in_every_exporters_shape() {
        assert_eq!(seconds("3:05", false), Some(185));
        assert_eq!(seconds("185", false), Some(185));
        assert_eq!(seconds("185000", true), Some(185));
        // Over an hour as a bare number: milliseconds.
        assert_eq!(seconds("185000", false), Some(185));
        assert_eq!(seconds("", false), None);
        assert_eq!(name(Path::new("/x/my_road__trip.csv")), "my road trip");
    }
}
