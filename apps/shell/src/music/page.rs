//! What the main page's big box shows of an album (Music Tab Redesign step 3), from
//! the old album page (M&P Library plan, step 3 pieces B and C: Windows' `RecordPage`
//! and `AlbumDetail` held to the rulebook): its songs (number, name over artist,
//! Spotify plays, your plays, length, the accent pill on the playing song, sliding to
//! the hovered one), the people credited, the artist's other records; the artist's
//! link and the fact line the media box shows; the rows and bar cells other lists
//! share. Songs not on this PC look the same and play off the internet.

use std::collections::HashMap;
use std::sync::LazyLock;

use iced::advanced::text::Shaping;
use iced::widget::{column, container, image, mouse_area, rich_text, row, space, span, text};
use iced::{Alignment, Color, Element, Length, Padding, border, mouse};
use mp_ui::bar::SLOT;
use mp_ui::drag::Reorder;
use mp_ui::pill::Highlight;
use mp_ui::style::{BODY, CORNER, GAP_1, GAP_2, GAP_3, ICON, LINE_TIGHT, SMALL, TITLE};

use crate::music::library::{self, Album};
use crate::music::playlist::Target;
use crate::music::release::{Credit, Release, Track};
use crate::music::web::{Artist, Group};
use crate::music::{Held, Library, Message};
use mp_ui::drop::{self, Pair};

/// The main page's cover: the page's height over the playing bar less a gap-3 each
/// side (his pick 2026-11-04: the cover shrinks rather than the box grows).
pub const COVER: f32 = crate::music::main_page::PAGE - 2.0 * GAP_3;
/// The album bar's buttons (the main page's), by kind: where each was laid out is kept
/// for its menu.
pub const CELLS: usize = 4;
pub const RATING: usize = 0;
pub const STATUS: usize = 1;
pub const SAVE: usize = 2;
pub const QUEUE: usize = 3;
pub const RATINGS: [&str; 10] = ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1"];
/// What `Library::hovered` holds over the artist's name (never a tile's key).
const ARTIST_NAME: &str = "\0artist";

/// The big box's tabs (Windows' `ALBUM_TABS` and Lyrics): an album opens on Lyrics
/// when it holds the playing song and it has words, else on Tracks; a playlist's
/// Credits and Discography are greyed out, Lyrics too while the playing song has no
/// words (his asks 2026-11-06). Search, the pill over the button column's (his ask
/// 2026-11-06: the internet's search box no longer a pop-up), is not in `ALL`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tab {
    Tracks,
    Lyrics,
    Credits,
    Discography,
    Search,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::Tracks, Tab::Lyrics, Tab::Credits, Tab::Discography];
}

/// A playlist row's cover (his ask 2026-11-06, Spotify's): as tall as the row's two
/// lines of words (the second one small, `line`).
pub const ROW_COVER: f32 = ((BODY + SMALL) * LINE_TIGHT).round();

/// Text's end pad in a bar cell: the gap above and below its capitals, + 2
/// (Windows' `.strip-value` / `.strip-name > span` padding-right, from the font's own
/// cap height).
pub fn end_pad() -> f32 {
    // Worked out once: the font file was read again on every draw of the album bar.
    static PAD: LazyLock<f32> = LazyLock::new(|| {
        let face = ttf_parser::Face::parse(mp_ui::FONT_TTF, 0).expect("bundled font");
        let cap = face.capital_height().unwrap_or(face.ascender()) as f32 / face.units_per_em() as f32 * BODY;
        ((ICON as f32 - cap) / 2.0 + 2.0).round()
    });
    *PAD
}

/// A row number's room: two digits' width, shaped once (it was shaped for every
/// numbered row, twice, on every draw).
fn number_width() -> f32 {
    static WIDE: LazyLock<f32> = LazyLock::new(|| drop::text_width("00", Shaping::Auto).ceil());
    *WIDE
}

/// The pictures the page draws, plain (Text, the strip's: his call 2026-11-03) and lit
/// (On Accent).
pub struct Pictures {
    pub star: Pair,
    pub tag: Pair,
    pub status: [Pair; 4],
    /// Plays and length in a song row, a found album's year.
    pub ear: Pair,
    pub clock: Pair,
    pub year: Pair,
    /// Save to Playlist on an album's bar (Windows' `ActionRun`), and Send to Queue
    /// (Windows' More Options row).
    pub save: Pair,
    pub queue: Pair,
    /// A YouTube song's download arrow.
    pub download: Pair,
    /// Spotify plays in a song row.
    pub globe: Pair,
    /// The button column's: Tracks, Lyrics, Credits, Discography.
    pub tabs: [Pair; 4],
}

impl Pictures {
    pub fn new(c: &mp_ui::colours::Colours) -> Self {
        let pair = |svg: &[u8]| Pair::new(svg, ICON, c.text, c.on_accent);
        Self {
            year: pair(include_bytes!("../../assets/bx-calendar.svg")),
            save: pair(include_bytes!("../../assets/bx-bookmark-alt.svg")),
            queue: pair(include_bytes!("../../assets/bx-paper-plane.svg")),
            download: pair(include_bytes!("../../assets/bx-arrow-big-down.svg")),
            globe: pair(include_bytes!("../../assets/bx-globe.svg")),
            tabs: [pair(include_bytes!("../../assets/bx-music.svg")), pair(include_bytes!("../../assets/bx-microphone-alt.svg")), pair(include_bytes!("../../assets/bx-group.svg")), pair(include_bytes!("../../assets/bx-radio.svg"))],
            star: pair(include_bytes!("../../assets/bx-star.svg")),
            tag: pair(include_bytes!("../../assets/bx-tag.svg")),
            status: [pair(include_bytes!("../../assets/bx-clock.svg")), pair(include_bytes!("../../assets/bx-rocket.svg")), pair(include_bytes!("../../assets/bx-check.svg")), pair(include_bytes!("../../assets/bx-x.svg"))],
            ear: pair(include_bytes!("../../assets/bx-ear-alt.svg")),
            clock: pair(include_bytes!("../../assets/bx-clock.svg")),
        }
    }
}

/// A bar cell's face: its picture, then a value or a name.
pub fn cell<'a>(icon: &Pair, words: Option<(impl text::IntoFragment<'a>, f32)>, lit: bool, colour: Color, end: f32) -> Element<'a, Message> {
    let edge = (SLOT - ICON as f32) / 2.0;
    let mut face = row![image(icon.get(lit)).width(ICON as f32).height(ICON as f32)].align_y(Alignment::Center);
    if let Some((words, before)) = words {
        face = face.push(container(text(words).size(BODY).line_height(LINE_TIGHT).color(colour).wrapping(text::Wrapping::None)).padding(Padding { left: before, right: end, ..Padding::ZERO }));
    }
    container(face).padding([0.0, edge]).height(SLOT).align_y(Alignment::Center).into()
}

impl Library {
    /// The album's song list: MusicBrainz's, or for one with no release its files.
    pub fn release(&self, a: &Album) -> Option<&Release> {
        self.releases.get(if a.release.is_empty() { &a.key } else { &a.release })
    }

    /// Every song of the album in order, as the player takes them: the file's key when
    /// it is on this PC, else its `sources` line's (Windows named some songs its own
    /// way), else the name a download gives it. Its songs on disk until its list is in.
    pub fn album_songs(&self, a: &Album) -> Vec<String> {
        let Some(tracks) = self.release(a).map(|r| &r.tracks).filter(|t| !t.is_empty()) else { return a.songs.clone() };
        let several = several(tracks);
        let on_disk: HashMap<(u32, u32), &String> = a.songs.iter().filter_map(|k| Some((library::place(k)?, k))).collect();
        let saved = |t: &Track| self.links.iter().find(|(k, _)| k.rsplit_once('/').is_some_and(|(dir, _)| dir == a.key) && library::place(k) == Some((t.disc, t.n))).map(|(k, _)| k.clone());
        let named = |t: &Track| format!("{}/{}", a.key, library::song_name(t.disc, t.n, &t.title, several));
        tracks.iter().map(|t| on_disk.get(&(t.disc, t.n)).map(|k| (*k).clone()).or_else(|| saved(t)).unwrap_or_else(|| named(t))).collect()
    }

    /// How many of the album's songs aren't on this PC; none until its list is in.
    pub fn missing(&self, a: &Album) -> Option<usize> {
        let tracks = &self.release(a).filter(|r| !r.tracks.is_empty())?.tracks;
        let have: Vec<(u32, u32)> = a.songs.iter().filter_map(|k| library::place(k)).collect();
        Some(tracks.iter().filter(|t| !have.contains(&(t.disc, t.n))).count())
    }

    /// The artist on the fact line (Windows' `ArtistLink`): a round photo, or the initials
    /// circle while there is none, then the name, underlined under the pointer; a click
    /// opens the lead artist's page. An album with no release has no page to open.
    pub fn artist_link<'a>(&'a self, a: &'a Album, release: Option<&'a Release>) -> Element<'a, Message> {
        let c = self.colours;
        let side = ICON as f32;
        let lead = release.and_then(lead_artist);
        let photo: Element<'a, Message> = match lead.and_then(|p| self.photos.get(&p.id)).and_then(Option::as_ref) {
            Some(photo) => image(photo.clone()).width(side).height(side).into(),
            None => {
                let circle = move |_: &iced::Theme| container::Style { background: Some(c.raised.into()), border: border::rounded(side / 2.0), ..Default::default() };
                container(text(initials(lead.map_or(&a.artist, |p| &p.name))).size(SMALL).line_height(LINE_TIGHT).color(c.text_muted)).center(side).style(circle).into()
            }
        };
        let name = rich_text![span::<(), _>(&a.artist).underline(lead.is_some() && self.hovered.as_deref() == Some(ARTIST_NAME))].size(BODY).line_height(LINE_TIGHT).color(c.text);
        let link = row![photo, name].spacing(GAP_2).align_y(Alignment::Center);
        let Some(p) = lead else { return link.into() };
        let open = Message::Artist(Artist { id: p.id.clone(), name: p.name.clone(), about: String::new() });
        mouse_area(link).on_press(open).on_enter(Message::Hover(ARTIST_NAME.into(), true)).on_exit(Message::Hover(ARTIST_NAME.into(), false)).interaction(mouse::Interaction::Pointer).into()
    }

    /// The Credits tab: a row a person (his pick over Windows' chips, no new part): name
    /// over jobs; a click opens their artist page.
    pub fn credits<'a>(&'a self, a: &'a Album, release: Option<&'a Release>) -> Element<'a, Message> {
        let Some(people) = release.map(|r| &r.credits).filter(|p| !p.is_empty()) else { return self.waiting(a) };
        let open = |i: usize| {
            let p = &people[i];
            (!p.id.is_empty()).then(|| Message::Artist(Artist { id: p.id.clone(), name: p.name.clone(), about: String::new() }))
        };
        self.list(people.len(), None, |i, lit| self.line(None, None, &people[i].name, &people[i].roles, Vec::new(), Vec::new(), lit), open, |_| None, false)
    }

    /// The Discography tab (Windows' `ArtistAlbums`): the artist's other records as the
    /// artist page's covers; owned ones open your page, the rest their internet one.
    pub fn discography<'a>(&'a self, a: &'a Album, release: Option<&'a Release>) -> Element<'a, Message> {
        let Some(release) = release else { return self.waiting(a) };
        let Some(lead) = lead_artist(release) else { return self.note("No other albums found.") };
        let Some(found) = self.discography.as_ref().filter(|d| d.id == lead.id) else { return self.note("Loading") };
        self.found(&found.groups, "MusicBrainz", "No other albums found.", |list| {
            let others: Vec<&'a Group> = list.iter().filter(|g| g.id != a.group).collect();
            if others.is_empty() { self.note("No other albums found.") } else { self.cover_grid(others) }
        })
    }

    /// Faint words where an album's list goes while it has none.
    fn waiting<'a>(&'a self, a: &'a Album) -> Element<'a, Message> {
        // An internet album's key is asked for while its release is picked.
        let words = if self.asking.contains(&a.release) || self.asking.contains(&a.key) {
            "Loading"
        } else if a.release.is_empty() && !self.is_web(a) {
            "No songs on this PC."
        } else {
            "Couldn't reach MusicBrainz."
        };
        self.note(words)
    }

    /// A record's name, at the title size.
    pub fn title<'a>(&self, s: &'a str) -> Element<'a, Message> {
        text(s).size(TITLE).line_height(LINE_TIGHT).color(self.colours.text).into()
    }

    /// Year · N tracks · length (his Decision "year · songs · length").
    pub fn facts(&self, a: &Album, release: Option<&Release>) -> Vec<String> {
        let mut facts: Vec<String> = Vec::new();
        if a.year > 0 {
            facts.push(a.year.to_string());
        }
        if let Some(r) = release.filter(|r| !r.tracks.is_empty()) {
            let n = r.tracks.len();
            facts.push(format!("{n} track{}", if n == 1 { "" } else { "s" }));
            let secs: u32 = r.tracks.iter().filter_map(|t| t.length).sum();
            if secs > 0 {
                facts.push(format!("{}m", (secs as f32 / 60.0).round()));
            }
        }
        facts
    }

    /// The songs, a group a disc ("Disc N" over each when there are several).
    pub fn songs<'a>(&'a self, a: &'a Album, release: Option<&'a Release>) -> Element<'a, Message> {
        let p = &self.page_pictures;
        let Some(release) = release.filter(|r| !r.tracks.is_empty()) else { return self.waiting(a) };
        let keys = self.album_songs(a);
        let playing = self.playing();
        let mut discs: Vec<u32> = release.tracks.iter().map(|t| t.disc).collect();
        discs.dedup();
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        for (d, &disc) in discs.iter().enumerate() {
            if discs.len() > 1 {
                parts.push(self.heading(format!("Disc {disc}"), d == 0));
            }
            let tracks: Vec<(usize, &Track)> = release.tracks.iter().enumerate().filter(|(_, t)| t.disc == disc).collect();
            let rest = tracks.iter().position(|(i, _)| playing.is_some() && keys.get(*i) == playing);
            let face = |k: usize, lit: bool| {
                let t = tracks[k].1;
                let plays = self.plays.get(&(t.disc, t.n)).copied().unwrap_or(0);
                // The full number, a dash while loading or unknown (Windows').
                let world = self.world.get(&t.recording).map_or_else(|| "–".to_string(), |n| thousands(*n));
                self.line(Some(t.n), None, &t.title, &t.artist, vec![(&p.globe, world), (&p.ear, plays.to_string()), (&p.clock, clock(t.length))], Vec::new(), lit)
            };
            parts.push(self.list(tracks.len(), rest, face, |k| Some(Message::Song(tracks[k].0)), |k| Some(Message::SongMenu(Target::Song(tracks[k].0))), false));
        }
        column(parts).spacing(GAP_2).into()
    }

    /// Rows a column, 4 apart (Noctalia's launcher list, `itemGap` spaceXs; his pick
    /// 2026-11-09, they were 16), the accent pill resting on `rest` and
    /// sliding to the hovered one; a row with a message takes clicks, one with a menu
    /// right-clicks. `drag`: a row held lifts and is dragged into a new place (piece
    /// C, Windows' playlist): its click goes on release, and while one is held the
    /// pill stands down and the held row wears the accent itself (Windows' `hold`).
    pub fn list<'a>(&'a self, n: usize, rest: Option<usize>, face: impl Fn(usize, bool) -> Element<'a, Message>, press: impl Fn(usize) -> Option<Message>, menu: impl Fn(usize) -> Option<Message>, drag: bool) -> Element<'a, Message> {
        let c = self.colours;
        let held = match self.held {
            Some(Held::Row(i)) if drag => Some(i),
            _ => None,
        };
        let rows = |lit: bool| -> Vec<Element<'a, Message>> {
            (0..n)
                .map(|i| {
                    if !lit && held == Some(i) {
                        return container(face(i, true)).style(move |_| container::Style { background: Some(c.accent.into()), border: border::rounded(CORNER), ..Default::default() }).into();
                    }
                    let (on, right) = if lit { (None, None) } else { (press(i), menu(i)) };
                    if on.is_none() && right.is_none() {
                        return face(i, lit);
                    }
                    let mut row = mouse_area(face(i, lit));
                    if let Some(on) = on {
                        row = if drag { row.on_release(on) } else { row.on_press(on) }.interaction(mouse::Interaction::Pointer);
                    }
                    if let Some(right) = right {
                        row = row.on_right_press(right);
                    }
                    row.into()
                })
                .collect()
        };
        let plain: Element<'a, Message> = if drag { Reorder::new(rows(false)).spacing(GAP_1).on_drag(|i| Message::Lift(Held::Row(i)), Message::MoveRow).into() } else { column(rows(false)).spacing(GAP_1).into() };
        Highlight::new(plain, column(rows(true)).spacing(GAP_1), rest, None, &c).corner(CORNER).off(held.is_some()).into()
    }

    /// One row (Windows' `TrackRow`): a number if it has one, a playlist song's cover
    /// (his ask 2026-11-06), a name over a second line, readouts (a picture and a value)
    /// at the right, then `after` (a YouTube song's download arrow). A song; a search's
    /// album, artist or YouTube song. Noctalia's launcher row (his pick 2026-11-09):
    /// the second line small, 4 over and under, 8 in from the sides.
    #[allow(clippy::too_many_arguments)]
    pub fn line<'a>(&'a self, number: Option<u32>, cover: Option<Element<'a, Message>>, title: &'a str, sub: &'a str, readouts: Vec<(&'a Pair, String)>, after: Vec<Element<'a, Message>>, lit: bool) -> Element<'a, Message> {
        let c = self.colours;
        let (bright, muted) = if lit { (c.on_accent, c.on_accent) } else { (c.text, c.text_muted) };
        let words = |s: &'a str, size: f32, colour: Color| text(s).size(size).line_height(LINE_TIGHT).color(colour).wrapping(text::Wrapping::None);
        let count =
            |icon: &Pair, s: String| -> Element<'a, Message> { row![image(icon.get(lit)).width(ICON as f32).height(ICON as f32), text(s).size(BODY).line_height(LINE_TIGHT).color(muted)].spacing(GAP_1).align_y(Alignment::Center).into() };
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        if let Some(n) = number {
            parts.push(container(text(n.to_string()).size(BODY).line_height(LINE_TIGHT).color(muted)).width(number_width()).into());
        }
        parts.extend(cover);
        parts.push(container(column![words(title, BODY, bright), words(sub, SMALL, muted)]).width(Length::Fill).clip(true).into());
        parts.push(row(readouts.into_iter().map(|(icon, s)| count(icon, s)).chain(after)).spacing(2.0 * GAP_3).align_y(Alignment::Center).into());
        container(row(parts).spacing(GAP_3).align_y(Alignment::Center)).padding([GAP_1, GAP_2]).width(Length::Fill).into()
    }

    /// A list's name over a line (a disc's, a search's three lists), in line with the
    /// rows' words (`line`'s side pad).
    pub fn heading<'a>(&self, words: String, first: bool) -> Element<'a, Message> {
        let c = self.colours;
        let words = container(text(words).size(SMALL).line_height(LINE_TIGHT).color(c.text_faint)).padding(Padding { top: if first { GAP_1 } else { GAP_3 }, right: GAP_2, bottom: GAP_2, left: GAP_2 });
        column![words, container(space()).height(1).width(Length::Fill).style(move |_| container::background(c.border))].into()
    }

    /// Faint words where a list goes: loading, nothing found, no answer.
    pub fn note<'a>(&self, words: impl text::IntoFragment<'a>) -> Element<'a, Message> {
        container(text(words).size(BODY).color(self.colours.text_faint)).padding([GAP_3, GAP_2]).into()
    }
}

/// The person whose photo and page an album's artist stands for: the first credited,
/// when MusicBrainz knows them.
pub fn lead_artist(release: &Release) -> Option<&Credit> {
    release.credits.first().filter(|p| !p.id.is_empty())
}

/// Up to two words' first letters (Windows' `ArtistLink`).
fn initials(name: &str) -> String {
    name.split_whitespace().take(2).filter_map(|w| w.chars().next()).flat_map(char::to_uppercase).collect()
}

/// `1,234,567`.
pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, d) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(d);
    }
    out
}

/// An album on several discs (its songs are named `D-NN`).
pub fn several(tracks: &[Track]) -> bool {
    tracks.iter().any(|t| t.disc != tracks[0].disc)
}

/// `m:ss` (Windows' `fmtDuration`); nothing when unknown.
pub fn clock(secs: Option<u32>) -> String {
    secs.filter(|s| *s > 0).map(|s| format!("{}:{:02}", s / 60, s % 60)).unwrap_or_default()
}
