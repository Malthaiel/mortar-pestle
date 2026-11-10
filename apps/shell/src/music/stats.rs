//! The record played last, which the box opens on when nothing plays, off this PC
//! (`listens`). The main page's four numbers (Plays, Artists, Songs and Hours, Last.fm's
//! header as Home had it, M&P Library plan step 6) went 2026-11-06, his ask, to be shown
//! elsewhere later: their counting is in `git show 6684aae1:apps/shell/src/music/
//! stats.rs`. The rest of Home went with the Music Tab Redesign (his pick "none").

use std::collections::{HashMap, HashSet};

use crate::music::library::{self, Album, Playlist};
use crate::music::{Library, playlist};

/// Read from `listens`.
#[derive(Default)]
pub struct Stats {
    /// The tile key (`Tile::key`) of the record played last.
    pub last: Option<String>,
}

/// Reads `listens`. A link `sources` ties to a song stands for that song.
pub fn tally(listens: &str, albums: &[Album], playlists: &[Playlist], links: &[(String, String)]) -> Stats {
    let own: HashMap<&str, &str> = links.iter().map(|(key, link)| (link.as_str(), key.as_str())).collect();
    let on_wall: HashSet<&str> = albums.iter().map(|a| a.key.as_str()).collect();
    let mut holders: HashMap<&str, Vec<&str>> = HashMap::new();
    for p in playlists {
        for r in &p.rows {
            for k in [&r.key, &r.link, &r.here].into_iter().flatten() {
                let held = holders.entry(k.as_str()).or_default();
                if !held.contains(&p.name.as_str()) {
                    held.push(&p.name);
                }
            }
        }
    }
    // Each line's song: when, seconds, song.
    let songs = listens.lines().filter_map(|l| l.split('\t').nth(2));
    let canon = |song: &str| own.get(song).map_or_else(|| song.to_string(), |k| k.to_string());
    // The newest play's album on the wall, else Downloaded Songs for a single, else the
    // first playlist holding it.
    let last = songs.rev().find_map(|song| {
        let key = canon(song);
        let dir = (!key.starts_with("http") && !key.starts_with("windows:")).then(|| key.rsplit_once('/').map(|(dir, _)| dir)).flatten();
        let tile = dir.and_then(|dir| if on_wall.contains(dir) { Some(dir.to_string()) } else { dir.ends_with("/Singles").then(|| playlist::NAME.to_string()) });
        tile.or_else(|| [song, key.as_str()].into_iter().find_map(|k| holders.get(k)?.first()).map(|name| playlist::tile_key(name)))
    });
    Stats { last }
}

impl Library {
    /// Read again (a song left may have added a listen).
    pub fn count(&mut self) {
        self.stats = tally(&library::listens(), &self.albums, &self.playlists, &self.links);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music::library::Row;
    use std::time::SystemTime;

    fn album(key: &str) -> Album {
        let (artist, title) = key.split_once('/').unwrap();
        Album { key: key.into(), artist: artist.into(), title: title.into(), status: None, rating: 0, year: 0, added: SystemTime::UNIX_EPOCH, songs: Vec::new(), cover: None, release: String::new(), group: String::new() }
    }

    fn list(name: &str, link: &str, title: &str, artist: &str) -> Playlist {
        Playlist { name: name.into(), rows: vec![Row { key: None, link: Some(link.into()), title: title.into(), artist: artist.into(), length: Some(100), here: None }], cover: None, added: SystemTime::UNIX_EPOCH }
    }

    #[test]
    fn a_link_tied_to_a_song_counts_as_that_song() {
        let log = "2026-07-25T01:00:00.170137300+00:00\t3600\tArt/Alb/01 One\n2026-07-26T01:00:00+00:00\t3600\thttp://a\n";
        let links = vec![("Art/Alb/01 One".to_string(), "http://a".to_string())];
        let s = tally(log, &[album("Art/Alb")], &[], &links);
        assert_eq!(s.last.as_deref(), Some("Art/Alb"));
    }

    #[test]
    fn the_last_record_is_the_newest_plays() {
        let log = "2026-07-24T01:00:00+00:00\t60\tArt/Alb/01 One\n2026-07-24T02:00:00+00:00\t60\tChan/Singles/3 Song\n";
        assert_eq!(tally(log, &[album("Art/Alb")], &[], &[]).last.as_deref(), Some(playlist::NAME));
        let log = format!("{log}2026-07-24T03:00:00+00:00\t60\thttp://b\n");
        let s = tally(&log, &[album("Art/Alb")], &[list("Mine", "http://b", "Bee", "Chan"), list("Yours", "http://b", "Bee", "Chan")], &[]);
        assert_eq!(s.last.as_deref(), Some("/Mine"));
    }

    #[test]
    fn nothing_played_shows_nothing() {
        assert!(tally("", &[], &[], &[]).last.is_none());
    }
}
