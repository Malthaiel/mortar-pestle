//! The player's own facts in `$XDG_DATA_HOME/mp-library/` (plan's Storage section):
//! `player` (the list, where it was, volume, shuffle, repeat) and `listens` (one line
//! per listen: time, seconds heard, song key). Plain text, tab-separated.

use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn home() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

pub fn library(name: &str) -> PathBuf {
    let data = env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(".local/share"));
    data.join("mp-library").join(name)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Repeat {
    #[default]
    None,
    Track,
    Playlist,
}

impl Repeat {
    /// MPRIS's `LoopStatus` words.
    pub fn word(self) -> &'static str {
        match self {
            Repeat::None => "None",
            Repeat::Track => "Track",
            Repeat::Playlist => "Playlist",
        }
    }

    pub fn from_word(word: &str) -> Option<Repeat> {
        [Repeat::None, Repeat::Track, Repeat::Playlist].into_iter().find(|r| r.word() == word)
    }
}

/// What `player` holds. Line 1: list place of the current song, seconds in, volume,
/// shuffle (0 / 1), repeat; line 2: the shuffled order (list places, spaces), empty
/// when not shuffled; then one song key per line, in list order.
#[derive(Debug, Default)]
pub struct Spot {
    pub list: Vec<String>,
    pub order: Vec<usize>,
    pub current: usize,
    pub seconds: f64,
    pub volume: f64,
    pub shuffle: bool,
    pub repeat: Repeat,
}

pub fn load() -> Option<Spot> {
    read(&fs::read_to_string(library("player")).ok()?)
}

fn read(text: &str) -> Option<Spot> {
    let mut lines = text.lines();
    let head: Vec<&str> = lines.next()?.split('\t').collect();
    let order = lines.next()?.split_whitespace().filter_map(|n| n.parse().ok()).collect();
    let list: Vec<String> = lines.map(String::from).collect();
    let [current, seconds, volume, shuffle, repeat] = head.as_slice() else { return None };
    let spot = Spot { current: current.parse().ok()?, seconds: seconds.parse().ok()?, volume: volume.parse().ok()?, shuffle: *shuffle == "1", repeat: Repeat::from_word(repeat)?, order, list };
    (spot.current < spot.list.len()).then_some(spot)
}

fn write(spot: &Spot) -> String {
    let order: Vec<String> = spot.order.iter().map(|n| n.to_string()).collect();
    format!("{}\t{:.1}\t{:.2}\t{}\t{}\n{}\n{}\n", spot.current, spot.seconds, spot.volume, spot.shuffle as u8, spot.repeat.word(), order.join(" "), spot.list.join("\n"))
}

/// A file of ours with its folder made: the music box makes the folder too, but a media
/// key on a fresh install comes here first.
fn ours(name: &str) -> PathBuf {
    let path = library(name);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    path
}

pub fn save(spot: &Spot) {
    let path = ours("player");
    // Whole file or nothing: written beside it, then moved over it.
    let fresh = path.with_extension("new");
    if let Err(e) = fs::write(&fresh, write(spot)).and_then(|_| fs::rename(&fresh, &path)) {
        eprintln!("mp-player: saving {}: {e}", path.display());
    }
}

/// One listen: now, seconds heard, the song.
pub fn listened(seconds: f64, key: &str) {
    let line = format!("{}\t{}\t{key}\n", now(), seconds.round() as u64);
    let path = ours("listens");
    if let Err(e) = fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| f.write_all(line.as_bytes())) {
        eprintln!("mp-player: {}: {e}", path.display());
    }
}

/// Now as `2026-10-30T21:05:09+00:00`, the copied plays' form (theirs carry nanoseconds).
fn now() -> String {
    stamp(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64)
}

fn stamp(secs: i64) -> String {
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970 to a date (Howard Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + (month <= 2) as i64;
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}+00:00", rest / 3600, rest / 60 % 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spot_comes_back_as_saved() {
        let list: Vec<String> = ["A/B/01 One", "https://youtu.be/x", "Unsorted/two"].map(String::from).into();
        let spot = Spot { list: list.clone(), order: vec![2, 0, 1], current: 1, seconds: 61.3, volume: 0.55, shuffle: true, repeat: Repeat::Playlist };
        let back = read(&write(&spot)).unwrap();
        assert_eq!((back.list, back.order, back.current, back.seconds, back.volume, back.shuffle, back.repeat), (list.clone(), vec![2, 0, 1], 1, 61.3, 0.55, true, Repeat::Playlist));
        // Not shuffled: the order line is empty, and still there.
        let back = read(&write(&Spot { list, ..Default::default() })).unwrap();
        assert_eq!((back.order, back.shuffle, back.repeat), (vec![], false, Repeat::None));
        // A current place past the list, a cut-off head: no spot.
        assert!(read("3\t0.0\t1.00\t0\tNone\n\na\nb\n").is_none());
        assert!(read("0\t0.0\t1.00\t0\n\na\n").is_none());
    }

    #[test]
    fn repeat_words_are_mpris_s() {
        for r in [Repeat::None, Repeat::Track, Repeat::Playlist] {
            assert_eq!(Repeat::from_word(r.word()), Some(r));
        }
        assert_eq!(Repeat::from_word("none"), None);
    }

    #[test]
    fn stamp_is_the_calendar_s_date() {
        assert_eq!(stamp(0), "1970-01-01T00:00:00+00:00");
        assert_eq!(stamp(1_793_480_709), "2026-10-31T21:05:09+00:00");
        // A leap day, and the last second of a year.
        assert_eq!(stamp(1_709_164_800), "2024-02-29T00:00:00+00:00");
        assert_eq!(stamp(946_684_799), "1999-12-31T23:59:59+00:00");
    }
}
