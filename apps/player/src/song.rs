//! One song file, found by its key (its path under `~/Music` without the ending: the
//! plan's Storage section) and read packet by packet into interleaved f32 samples at
//! the file's own rate. Symphonia reads every format but Opus; Opus goes through the
//! system's libopus (his pick 2026-10-30, after measuring 8 pure-Rust decoders). A song
//! not on this PC is read from YouTube's WebM as it arrives (`web.rs`).

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::Ordering;

use symphonia::core::codecs::CodecParameters;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{Time, TimeBase, Timestamp};

use lofty::prelude::*;

use crate::web::{self, Fetched, Found, Growing};

static CODECS: LazyLock<CodecRegistry> = LazyLock::new(|| {
    let mut codecs = CodecRegistry::new();
    symphonia::default::register_enabled_codecs(&mut codecs);
    codecs.register_audio_decoder::<symphonia_adapter_libopus::OpusDecoder>();
    codecs
});

pub fn music() -> PathBuf {
    crate::saved::home().join("Music")
}

/// What the top bar shows: the file's own tags, else its place in `~/Music`
/// (`Artist/Album/NN Title`, `Artist/Singles/Title`, `Unsorted/name`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tags {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Seconds; none when the file doesn't say.
    pub length: Option<f64>,
    pub path: PathBuf,
    /// Where a song off the internet comes from (the top bar's `xesam:url`).
    pub link: Option<String>,
    pub cover: Option<PathBuf>,
}

pub struct Song {
    pub tags: Tags,
    pub rate: u32,
    pub channels: u8,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track: u32,
    base: TimeBase,
    /// Where the last packet handed out starts, in seconds.
    pub at: f64,
    /// The file it is read from, for a song off the internet (a jump back opens it afresh).
    web: Option<Fetched>,
}

/// The file a key names: the one in its folder whose name without the ending is the
/// key's last part (pictures left out). None for a web-only song or a missing file.
fn find(key: &str) -> Option<PathBuf> {
    if web::is_link(key) {
        return None;
    }
    let full = music().join(key);
    let (dir, name) = (full.parent()?, full.file_name()?);
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.file_stem() == Some(name) && p.is_file() && !matches!(p.extension().and_then(|e| e.to_str()), Some("jpg" | "png" | "lrc")))
}

/// The song's file is on this PC.
pub fn on_disk(key: &str) -> bool {
    find(key).is_some()
}

impl Song {
    pub fn open(key: &str) -> Option<Song> {
        let path = find(key)?;
        let mut tags = from_place(key, &path);
        tags.cover = cover(&path);
        // Tags by lofty: symphonia's own reader found no MP3's ID3 title (his 49 songs,
        // 2026-10-31: 9 titles vs lofty's 49, and lofty 10x faster).
        if let Ok(file) = lofty::read_from_path(&path)
            && let Some(tag) = file.primary_tag().or(file.first_tag())
        {
            for (field, value) in [(&mut tags.title, tag.title()), (&mut tags.artist, tag.artist()), (&mut tags.album, tag.album())] {
                if let Some(v) = value {
                    *field = v.into_owned();
                }
            }
        }
        let ending = path.extension().and_then(|e| e.to_str()).map(String::from);
        Song::read(Box::new(File::open(&path).ok()?), ending.as_deref(), tags)
    }

    /// A song off the internet, read as it arrives (`web.rs`).
    pub fn open_web(key: &str, got: &Fetched) -> Option<Song> {
        let mut tags = web_tags(key, Some(&got.found), got.picture.clone());
        tags.path = got.path.clone();
        let mut song = Song::read(Box::new(Growing::open(got)?), Some("webm"), tags)?;
        song.web = Some(got.clone());
        Some(song)
    }

    fn read(source: Box<dyn MediaSource>, ending: Option<&str>, mut tags: Tags) -> Option<Song> {
        let source = MediaSourceStream::new(source, Default::default());
        let mut hint = Hint::new();
        if let Some(ending) = ending {
            hint.with_extension(ending);
        }
        let format = symphonia::default::get_probe().probe(&hint, source, FormatOptions::default(), MetadataOptions::default()).ok()?;
        let track = format.default_track(TrackType::Audio)?;
        let Some(CodecParameters::Audio(params)) = &track.codec_params else { return None };
        let decoder = CODECS.make_audio_decoder(params, &AudioDecoderOptions::default()).ok()?;
        let rate = params.sample_rate?;
        let channels = params.channels.as_ref()?.count() as u8;
        let base = track.time_base.unwrap_or(TimeBase::new(1.try_into().unwrap(), rate.try_into().ok()?));
        let length = track.num_frames.and_then(|n| base.calc_time(Timestamp::new(n as i64))).map(|t| t.as_secs_f64());
        let id = track.id;
        // YouTube's WebM doesn't say its length: the look-up's stands.
        tags.length = length.or(tags.length);
        Some(Song { tags, rate, channels, format, decoder, track: id, base, at: 0.0, web: None })
    }

    /// The next stretch of sound into `out` (cleared first); false at the end of the
    /// song. A packet that won't decode is skipped, as players do.
    pub fn next(&mut self, out: &mut Vec<f32>) -> bool {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return false,
                Err(e) => {
                    eprintln!("mp-player: {}: {e}", self.tags.path.display());
                    return false;
                }
            };
            if packet.track_id != self.track {
                continue;
            }
            if let Some(t) = self.base.calc_time(packet.pts) {
                self.at = t.as_secs_f64();
            }
            match self.decoder.decode(&packet) {
                Ok(sound) => {
                    out.clear();
                    sound.copy_to_vec_interleaved(out);
                    return true;
                }
                Err(Error::DecodeError(_)) => continue,
                Err(e) => {
                    eprintln!("mp-player: {}: {e}", self.tags.path.display());
                    return false;
                }
            }
        }
    }

    /// Still arriving off the internet, with too little unread to decode from without
    /// waiting for more (`web::MARGIN`). Never so once curl is done.
    pub fn starved(&self) -> bool {
        self.web.as_ref().is_some_and(|got| {
            // Done before the size, as `Growing::read`: then the size is the whole file.
            !got.done.load(Ordering::Acquire) && std::fs::metadata(&got.path).map_or(0, |m| m.len()) < got.read.load(Ordering::Relaxed) + web::MARGIN
        })
    }

    /// Jumps to `seconds` in; where it landed.
    pub fn seek(&mut self, seconds: f64) -> f64 {
        let Some(time) = Time::try_from_secs_f64(seconds.max(0.0)) else { return self.at };
        // symphonia-format-mkv 0.6.1 keeps the frames read before a jump through the
        // cues, so a jump back landed where it already was (its dev-0.6 too, checked
        // 2026-11-03): a WebM off the internet opens afresh for one (his pick over a
        // patched copy). A fresh reader holds no frames.
        if seconds < self.at
            && let Some(got) = &self.web
            && let Some(fresh) = Growing::open(got).and_then(|g| Song::read(Box::new(g), Some("webm"), self.tags.clone()))
        {
            (self.format, self.decoder) = (fresh.format, fresh.decoder);
        }
        if let Ok(to) = self.format.seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(self.track) }) {
            self.decoder.reset();
            self.at = self.base.calc_time(to.actual_ts).map_or(seconds, |t| t.as_secs_f64());
        }
        self.at
    }
}

/// What shows for a song off the internet, before and while it plays: an album song
/// not downloaded by its place in `~/Music` (its album's cover when that is on this
/// PC), a YouTube song by YouTube's names; else YouTube's picture.
pub fn web_tags(key: &str, found: Option<&Found>, picture: Option<PathBuf>) -> Tags {
    let length = found.and_then(|f| f.length);
    if web::is_link(key) {
        let title = found.map(|f| f.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| key.into());
        let artist = found.map(|f| f.artist.clone()).unwrap_or_default();
        return Tags { title, artist, length, link: Some(key.into()), cover: picture, ..Default::default() };
    }
    let path = music().join(key);
    let mut tags = from_place(key, &path);
    (tags.length, tags.link, tags.cover) = (length, web::link(key), cover(&path).or(picture));
    tags
}

/// The album's cover beside a song: `cover.jpg`, or `cover.png` (4 copied from Windows).
pub fn cover(song: &Path) -> Option<PathBuf> {
    let dir = song.parent()?;
    ["cover.jpg", "cover.png"].into_iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

/// Title, artist and album from the song's place in `~/Music`.
fn from_place(key: &str, path: &Path) -> Tags {
    let parts: Vec<&str> = key.split('/').collect();
    let name = parts.last().copied().unwrap_or(key);
    // "03 Title" -> "Title": the copy named album songs by their track number.
    let title = match name.split_once(' ') {
        Some((n, rest)) if parts.len() == 3 && n.chars().all(|c| c.is_ascii_digit()) => rest,
        _ => name,
    };
    let (artist, album) = match parts.as_slice() {
        [artist, album, _] if *album != "Singles" => (*artist, *album),
        [artist, _, _] => (*artist, ""),
        _ => ("", ""),
    };
    Tags { title: title.into(), artist: artist.into(), album: album.into(), length: None, path: path.into(), link: None, cover: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_come_from_the_song_s_place() {
        let names = |key: &str| {
            let t = from_place(key, Path::new("x"));
            (t.title, t.artist, t.album)
        };
        let own = |a: &str, b: &str, c: &str| (a.to_string(), b.to_string(), c.to_string());
        assert_eq!(names("Artist/Album/03 Title"), own("Title", "Artist", "Album"));
        assert_eq!(names("Artist/Singles/Title"), own("Title", "Artist", ""));
        // Only an album song's leading number is its track number.
        assert_eq!(names("Artist/Singles/99 Problems"), own("Problems", "Artist", ""));
        assert_eq!(names("Unsorted/99 Problems"), own("99 Problems", "", ""));
        assert_eq!(names("Artist/Album/1979"), own("1979", "Artist", "Album"));
    }
}
