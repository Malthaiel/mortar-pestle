//! The internet's search (Music Tab Redesign step 5): the big box's Search page since
//! 2026-11-06 (his ask: no longer a pop-up under a search box at the top; the search
//! pill over the button column opens it), its search box across its top, the lists
//! under it filling in as you type (his picks): Albums and Artists from MusicBrainz
//! as each letter comes, one ask at a time and so at most one a second (its rule for
//! programs, `web::ask`); Songs from YouTube once typing pauses half a second (they
//! take ~2.3 s), one look-up at a time. Each list keeps the last answer on screen
//! until a newer one comes. All of them, scrolling. A song plays (the page stays); the
//! arrow on its row, while hovered, downloads it; a right-click saves it to a playlist.
//! A found album opens on the main page, an artist slides to their albums. Enter does
//! nothing (his pick). An artist's albums sit on the left page as the wall's covers.

use std::time::Duration;

use iced::widget::{column, container, image, mouse_area, row, scrollable, space, text};
use iced::{Alignment, Element, Length, Task, mouse};
use mp_ui::bar::Bar;
use mp_ui::style::{BODY, GAP_1, GAP_2, GAP_3, ICON, LINE_TIGHT, TITLE};

use crate::music::page;
use crate::music::playlist::Target;
use crate::music::web::{self, Group, Video};
use crate::music::{Field, Found, Library, Message, Results, download, off, styled};

/// How long typing pauses before YouTube is asked (his pick).
const PAUSE: Duration = Duration::from_millis(500);

/// The search's asks: the search (`Library::asked`) each list was last asked for and
/// shows, and whether a MusicBrainz or a YouTube ask is on its way; the search typing
/// last paused on.
#[derive(Default)]
pub struct Asks {
    albums: u64,
    artists: u64,
    songs: u64,
    shown: [u64; 3],
    brainz: bool,
    tube: bool,
    paused: u64,
}

impl Results {
    pub fn loading() -> Self {
        Results { albums: Found::Loading, artists: Found::Loading, songs: Found::Loading }
    }
}

impl Library {
    /// The Search page: the search box as it was at the top (`Bar` round the box,
    /// across the big box), a gap-2, then the three lists scrolling, a gap-3 in.
    pub fn search_page(&self) -> Element<'_, Message> {
        let c = self.colours;
        let bar = Bar::new(Vec::new(), Vec::new(), None, None, &c).across().lead(self.field(Field::Web));
        let bar = container(bar).padding(iced::Padding { top: GAP_3, right: GAP_3, bottom: 0.0, left: GAP_3 });
        let lists = styled(scrollable(container(self.found_lists()).padding([GAP_2, GAP_3])).width(Length::Fill).height(Length::Fill), c);
        column![bar, lists].into()
    }

    /// The three lists, a heading over each.
    fn found_lists(&self) -> Element<'_, Message> {
        let p = &self.page_pictures;
        let r = &self.results;
        let albums = self.found(&r.albums, "MusicBrainz", "No albums found.", |list| {
            let face = |i: usize, lit| {
                let g: &Group = &list[i];
                let year = (g.year > 0).then(|| (&p.year, g.year.to_string()));
                self.line(None, None, &g.title, &g.artist, year.into_iter().collect(), Vec::new(), lit)
            };
            self.list(list.len(), None, face, |i| Some(Message::Group(list[i].clone())), |_| None, false)
        });
        let artists = self.found(&r.artists, "MusicBrainz", "No artists found.", |list| {
            self.list(list.len(), None, |i, lit| self.line(None, None, &list[i].name, &list[i].about, Vec::new(), Vec::new(), lit), |i| Some(Message::Artist(list[i].clone())), |_| None, false)
        });
        let songs = self.found(&r.songs, "YouTube", "No songs found.", |list| {
            let playing = self.playing();
            let rest = list.iter().position(|v| {
                let link = web::watch(&v.id);
                playing == Some(&link) || (self.now.playing && self.now.link.as_ref() == Some(&link)) || (self.have.contains(&v.id) && playing == Some(&download::single_key(v)))
            });
            let face = |i: usize, lit| {
                let v = &list[i];
                let after = self.arrow(v, lit).into_iter().collect();
                let line = self.line(None, None, &v.title, &v.channel, vec![(&p.clock, page::clock(v.length))], after, lit);
                if lit || self.singles.contains(&v.id) || self.have.contains(&v.id) {
                    return line;
                }
                // The arrow shows on the row under the pointer, over its press area
                // (`line`'s side pad and middle); the lit copy draws the playing row's.
                let side = ICON as f32;
                let shown = container(image(p.download.get(false)).width(side).height(side)).padding([GAP_1, GAP_2]).width(Length::Fill).height(Length::Fill).align_x(Alignment::End).align_y(Alignment::Center);
                iced::widget::hover(line, shown)
            };
            self.list(list.len(), rest, face, |i| Some(Message::Tube(list[i].clone())), |i| Some(Message::SongMenu(Target::Tube(list[i].clone()))), false)
        });
        // Nothing typed: no lists yet.
        if self.web_query.trim().is_empty() {
            return space().into();
        }
        column![self.heading("Albums".into(), true), albums, self.heading("Artists".into(), false), artists, self.heading("Songs".into(), false), songs].spacing(GAP_2).into()
    }

    /// The internet's box changed: a new search asks MusicBrainz at once and YouTube
    /// once typing pauses. Emptied, its lists start afresh. A pasted YouTube link asks
    /// YouTube only.
    pub fn typed(&mut self, q: String) -> Task<Message> {
        let changed = q.trim() != self.web_query.trim();
        self.web_query = q;
        if !changed {
            return Task::none();
        }
        self.asked += 1;
        let n = self.asked;
        let q = self.web_query.trim();
        if q.is_empty() {
            self.forget_search();
            return Task::none();
        }
        if web::is_link(q) {
            (self.results.albums, self.results.artists) = (Found::Got(Vec::new()), Found::Got(Vec::new()));
            (self.asks.albums, self.asks.artists, self.asks.shown[0], self.asks.shown[1]) = (n, n, n, n);
        }
        Task::batch([self.ask_brainz(), off(|| std::thread::sleep(PAUSE), move |_| Message::Paused(n))])
    }

    /// The lists go back to waiting and an answer still on its way is dropped (the box
    /// emptied or shut).
    pub fn forget_search(&mut self) {
        self.results = Results::loading();
        self.asks.shown = [self.asked; 3];
    }

    /// Asks MusicBrainz for the newest search's albums, then its artists, unless an
    /// ask is on its way (the next goes when it is back).
    fn ask_brainz(&mut self) -> Task<Message> {
        let (n, q) = (self.asked, self.web_query.trim().to_string());
        if self.asks.brainz || q.is_empty() {
            return Task::none();
        }
        if self.asks.albums < n {
            (self.asks.albums, self.asks.brainz) = (n, true);
            return off(move || web::search_albums(&q), move |r| Message::Albums(n, r.flatten()));
        }
        if self.asks.artists < n {
            (self.asks.artists, self.asks.brainz) = (n, true);
            return off(move || web::search_artists(&q), move |r| Message::Artists(n, r.flatten()));
        }
        Task::none()
    }

    /// Asks YouTube for the search typing paused on, while it is still the newest,
    /// unless a look-up is on its way (the next goes when it is back).
    fn ask_tube(&mut self) -> Task<Message> {
        let (n, q) = (self.asks.paused, self.web_query.trim().to_string());
        if self.asks.tube || n != self.asked || self.asks.songs >= n || q.is_empty() {
            return Task::none();
        }
        (self.asks.songs, self.asks.tube) = (n, true);
        off(move || web::youtube(&q), move |r| Message::Songs(n, r.flatten()))
    }

    /// Typing paused on search `n`.
    pub fn paused(&mut self, n: u64) -> Task<Message> {
        self.asks.paused = n;
        self.ask_tube()
    }

    /// MusicBrainz's albums for search `n`: shown unless a newer list is; the next ask.
    pub fn got_albums(&mut self, n: u64, found: Option<Vec<Group>>) -> Task<Message> {
        self.asks.brainz = false;
        if n > self.asks.shown[0] {
            (self.results.albums, self.asks.shown[0]) = (found.into(), n);
        }
        self.ask_brainz()
    }

    pub fn got_artists(&mut self, n: u64, found: Option<Vec<web::Artist>>) -> Task<Message> {
        self.asks.brainz = false;
        if n > self.asks.shown[1] {
            (self.results.artists, self.asks.shown[1]) = (found.into(), n);
        }
        self.ask_brainz()
    }

    /// YouTube's songs for search `n`: shown unless a newer list is, and looked up
    /// ahead (his pick); the next look-up.
    pub fn got_songs(&mut self, n: u64, found: Option<Vec<Video>>) -> Task<Message> {
        self.asks.tube = false;
        let mut tasks = Vec::new();
        if n > self.asks.shown[2] {
            (self.results.songs, self.asks.shown[2]) = (found.into(), n);
            if let Found::Got(list) = &self.results.songs {
                self.have = list.iter().filter(|v| crate::music::library::on_disk(&download::single_key(v))).map(|v| v.id.clone()).collect();
            }
            tasks.push(self.look_results());
        }
        tasks.push(self.ask_tube());
        Task::batch(tasks)
    }

    /// An artist's albums and EPs, newest first, as covers in the rows that fill the
    /// page under their name, filled top to bottom and scrolling sideways like the wall
    /// (his ask 2026-11-09: "Make it sideways too"); the name stays put over them (his
    /// pick); a click opens its page.
    pub fn artist_view<'a>(&'a self, name: &'a str) -> Element<'a, Message> {
        let c = self.colours;
        let Some(artist) = &self.artist else { return self.note("Loading") };
        let (rows, side) = crate::music::artist_rows();
        let covers = self.found(&artist.groups, "MusicBrainz", "No albums found.", |list| {
            let columns = list.chunks(rows).map(|col| column(col.iter().map(|g| self.cover_tile(g, side))).spacing(GAP_2).into());
            let covers = container(row(columns).spacing(GAP_2)).padding(iced::Padding { top: 0.0, right: GAP_2, bottom: GAP_2, left: GAP_2 }).height(Length::Fill).align_y(Alignment::Center);
            mp_ui::scroll::sideways(scrollable(covers).width(Length::Fill).height(Length::Fill), c)
        });
        let name = container(text(name).size(TITLE).line_height(LINE_TIGHT).color(c.text)).padding(iced::Padding { top: GAP_2, right: GAP_2, bottom: 0.0, left: GAP_2 });
        column![name, covers].spacing(GAP_3).into()
    }

    /// Albums as the wall's covers, wrapping; a click opens its page.
    pub fn cover_grid<'a>(&'a self, list: Vec<&'a Group>) -> Element<'a, Message> {
        row(list.into_iter().map(|g| self.cover_tile(g, self.side))).spacing(GAP_2).wrap().vertical_spacing(GAP_2).into()
    }

    /// An album off the internet as a cover `side` square; a click opens its page.
    pub fn cover_tile<'a>(&'a self, g: &'a Group, side: f32) -> Element<'a, Message> {
        mouse_area(self.face(self.thumbs.get(&g.id), side)).on_press(Message::Group(g.clone())).interaction(mouse::Interaction::Pointer).into()
    }

    /// A YouTube song's download (his pick): the arrow on the row under the pointer
    /// (`found_lists` draws it there) and, lit, on the playing row inside the pill; the
    /// plain row has a press area the arrow's size where it shows. "Downloading" while
    /// it comes; nothing once it is on this PC.
    fn arrow<'a>(&'a self, v: &Video, lit: bool) -> Option<Element<'a, Message>> {
        let c = self.colours;
        if self.singles.contains(&v.id) {
            return Some(text("Downloading").size(BODY).line_height(LINE_TIGHT).color(if lit { c.on_accent } else { c.text_muted }).into());
        }
        if self.have.contains(&v.id) {
            return None;
        }
        let side = ICON as f32;
        Some(if lit { image(self.page_pictures.download.get(true)).width(side).height(side).into() } else { mouse_area(space().width(side).height(side)).on_press(Message::Single(v.clone())).interaction(mouse::Interaction::Pointer).into() })
    }

    /// A list once its answer is in; until then, or without one, faint words.
    pub fn found<'a, T>(&'a self, found: &'a Found<T>, from: &str, none: &'a str, rows: impl FnOnce(&'a [T]) -> Element<'a, Message>) -> Element<'a, Message> {
        match found {
            Found::Loading => self.note("Loading"),
            Found::Failed => self.note(format!("Couldn't reach {from}.")),
            Found::Got(list) if list.is_empty() => self.note(none),
            Found::Got(list) => rows(list),
        }
    }
}
