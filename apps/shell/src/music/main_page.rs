//! The main page (Music Tab Redesign step 3), the whole Music panel since 2026-11-06
//! (his asks: the top bar with the internet's search box and the Music pill gone, and
//! the four turned numbers, Plays / Artists / Songs / Hours, for showing elsewhere
//! later): left to right, each its own Panel box a gap-2 apart on the box's Frame, the
//! media box (the shown record's cover | its names, facts and the album's buttons,
//! centred), the big box (Tracks, Lyrics, Credits, Discography, Search) and the button
//! column: the search pill over the strip's pill, down, picking the big box's tab.
//! Under both pages, across the whole box, the playing bar (his ask 2026-11-08,
//! Spotify's bottom bar; until then the playing box under the media box): the playing
//! song's cover and title over artist, the player's buttons over the seek bar in the
//! middle, the volume at the far right; a right-click on the song opens its menu (his
//! ask 2026-11-06).
//! The shown record is the album or playlist you picked (`Library::place`); each open
//! shows the playing song's album. A click on its cover slides to the left page, a
//! right-click opens its menu (Download, Uninstall and the like). The wheel over the
//! media box or the playing bar is the volume.

use iced::alignment::Horizontal;
use iced::widget::{column, container, image, mouse_area, row, scrollable, space, stack, text};
use iced::{Alignment, Element, Length, Padding, Task, mouse};
use mp_ui::bar::{self, Bar};
use mp_ui::drop::{self, Item, Pair};
use mp_ui::measured::measured;
use mp_ui::scroll::styled;
use mp_ui::style::{BODY, GAP_1, GAP_2, GAP_3, ICON, LINE_TIGHT, SMALL, TITLE};

use crate::music::library::{self, Album, Playlist};
use crate::music::now::{self, Command, Repeat};
use crate::music::page::{self, COVER, QUEUE, RATING, SAVE, STATUS, Tab};
use crate::music::playlist::{self, Pic, Slot, Target, youtube_id};
use crate::music::sliding::sliding;
use crate::music::words::Words;
use crate::music::{Library, Message, Place, box_scroll, boxed, lyrics, off, seek, words};

/// The box's height (chat 55's call, his look decides): 300, then "just a pinch" more
/// for the pages over the playing bar (his ask 2026-11-09), a gap-2.
pub const H: f32 = 308.0;
/// The names and buttons beside the cover: Windows' `MediaTab` 340, a quarter larger
/// (the shell's Media tab).
const DETAILS: f32 = 425.0;
/// The playing song's cover: as tall as the player's buttons (bare, `SLOT` squares
/// since their pill went) over the seek bar.
const SONG: f32 = bar::SLOT + GAP_1 + seek::ROW;
/// The playing bar across the box's foot: the song's cover and a gap-2 round it (his
/// asks 2026-11-08: "smaller vertically", 85 -> 69; a 77 try put back, the box grown
/// instead).
pub const PLAYING: f32 = SONG + 2.0 * GAP_2;
/// The pages over the playing bar, a gap-2 above it (his ask 2026-11-08: the box keeps
/// its height, the big box gives up the room).
pub const PAGE: f32 = H - PLAYING - GAP_2;
/// The playing bar's middle (the buttons over the seek bar): Spotify's share of its
/// bottom bar, 40%; the song and the volume share the rest evenly.
const MIDDLE: f32 = 0.4;
/// The player bar's buttons, left to right.
const SHUFFLE: usize = 0;
const PREVIOUS: usize = 1;
const PLAY: usize = 2;
const NEXT: usize = 3;
const REPEAT: usize = 4;

/// The player bar's pictures (shuffle, previous, play, pause, next, repeat, repeat one
/// song), each plain (Text) and on (Accent, as Spotify lights shuffle and repeat), at
/// `ICON` as the button column's. Boxicons Filled (his ask 2026-11-10), the Windows
/// Media tab's; one song = `bx-repeat-one`, Boxicons' repeat with a 1 made inside it
/// (Boxicons has none; Windows drew a `Badge` tag, Noctalia Look step 6 Tabler's
/// `repeat-once`). Then the speaker by the volume, the top bar's (`crate::SPEAKER`).
pub struct Player([[image::Handle; 2]; 7], [image::Handle; 3]);

impl Player {
    pub fn new(c: &mp_ui::colours::Colours) -> Self {
        let svgs: [&[u8]; 7] = [
            include_bytes!("../../assets/bx-shuffle.svg"),
            include_bytes!("../../assets/bx-skip-previous.svg"),
            include_bytes!("../../assets/bx-play.svg"),
            include_bytes!("../../assets/bx-pause.svg"),
            include_bytes!("../../assets/bx-skip-next.svg"),
            include_bytes!("../../assets/bx-repeat.svg"),
            include_bytes!("../../assets/bx-repeat-one.svg"),
        ];
        Self(svgs.map(|d| [c.text, c.accent].map(|colour| mp_ui::icon::svg(d, ICON, colour))), crate::SPEAKER.map(|d| mp_ui::icon::svg(d, ICON, c.text)))
    }
}

/// What the main page shows: an album, a playlist (none = Downloaded Songs), or nothing.
pub enum Shown<'a> {
    Album(&'a Album),
    Playlist(Option<&'a Playlist>),
    Nothing,
}

impl Library {
    pub fn showing(&self) -> Shown<'_> {
        match &self.place {
            Place::Album(_) => self.open_album().map_or(Shown::Nothing, Shown::Album),
            Place::Downloaded => Shown::Playlist(None),
            Place::Playlist(_) => self.open_playlist().map_or(Shown::Nothing, |p| Shown::Playlist(Some(p))),
            _ => Shown::Nothing,
        }
    }

    /// Whether the record shown holds the song playing.
    pub fn shows_playing(&self) -> bool {
        let Some(song) = self.now.song.as_ref() else { return false };
        match self.showing() {
            Shown::Album(a) => self.album_songs(a).contains(song),
            Shown::Playlist(_) => self.playlist_holds(song),
            Shown::Nothing => false,
        }
    }

    /// Whether the big box's tab can be picked (his asks 2026-11-06): Credits and
    /// Discography for an album only, Lyrics while a song plays that has words (or they
    /// are still being found, or couldn't be got: those say so).
    pub fn usable(&self, tab: Tab) -> bool {
        match tab {
            Tab::Tracks | Tab::Search => true,
            Tab::Lyrics => self.now.loaded() && !matches!(self.words.get(&words::key(&self.now)), Some(Words::None)),
            Tab::Credits | Tab::Discography => matches!(self.showing(), Shown::Album(_)),
        }
    }

    /// The tab shown went out of reach (a song with no words came, a playlist opened):
    /// Tracks.
    pub fn mend_tab(&mut self) {
        if !self.usable(self.tab) {
            self.tab = Tab::Tracks;
        }
    }

    /// A player bar button: each steers the playing song (Spotify's, his pick
    /// 2026-11-04; a record starts from a click on one of its songs). Play wakes a
    /// closed player, which picks up where it stopped.
    pub fn press_player(&mut self, i: usize) {
        match i {
            SHUFFLE => {
                self.now.shuffle = !self.now.shuffle;
                now::send(Command::Shuffle(self.now.shuffle));
            }
            PREVIOUS => now::send(Command::Previous),
            NEXT => now::send(Command::Next),
            // Windows' `cycleRepeat`: off, all, one.
            REPEAT => {
                self.now.repeat = match self.now.repeat {
                    Repeat::None => Repeat::Playlist,
                    Repeat::Playlist => Repeat::Track,
                    Repeat::Track => Repeat::None,
                };
                now::send(Command::Repeat(self.now.repeat));
            }
            PLAY => now::send(Command::Toggle),
            _ => {}
        }
    }

    /// The playing song's picture: its album's cover, else YouTube's picture of it
    /// (a playlist's face, `playlist_picture`, for one song), keyed by where it comes from.
    fn song_picture(&self) -> Option<(String, Pic)> {
        let key = self.now.song.as_deref()?;
        let album = key.rsplit_once('/').and_then(|(dir, _)| self.albums.iter().find(|a| a.key == dir));
        if let Some(cover) = album.and_then(|a| a.cover.clone()) {
            return Some((cover.to_string_lossy().into_owned(), Pic::File(cover)));
        }
        let link = self.now.link.clone().or_else(|| self.link_of(key))?;
        youtube_id(&link).map(|id| (id.to_string(), Pic::Tube(id.into())))
    }

    /// Cuts the playing song's picture for the playing box, one cut at a time (a
    /// YouTube picture fetched first, kept for the next time).
    pub fn cut_song_art(&mut self) -> Task<Message> {
        let Some((key, pic)) = self.song_picture() else { return Task::none() };
        if self.song_art_busy || self.song_art.as_ref().is_some_and(|art| art.key == key) {
            return Task::none();
        }
        self.song_art_busy = true;
        off(move || mp_ui::cover::square(&std::fs::read(pic.fetch()?).ok()?, SONG as u32), move |r| Message::SongArt(key.clone(), r.flatten()))
    }

    /// The wheel over the media box or the playing bar: 5% a notch (Windows' 0.05); the
    /// box's smooth wheel hands a notch over as 100 pixels.
    pub fn wheel(&mut self, delta: mouse::ScrollDelta) {
        let step = match delta {
            mouse::ScrollDelta::Lines { y, .. } => 0.05 * y as f64,
            mouse::ScrollDelta::Pixels { y, .. } => 0.05 * y as f64 / 100.0,
        };
        if step != 0.0 {
            self.set_volume(self.now.volume + step);
        }
    }

    /// The player's volume, while a song is loaded (the wheel, the volume line).
    pub fn set_volume(&mut self, volume: f64) {
        if self.now.loaded() {
            self.now.volume = volume.clamp(0.0, 1.0);
            now::send(Command::Volume(self.now.volume));
        }
    }

    /// The speaker pressed (Spotify's): silent, or back to the volume it had.
    pub fn mute(&mut self) {
        if !self.now.loaded() {
            return;
        }
        let to = if self.now.volume > 0.0 {
            self.unmuted = self.now.volume;
            0.0
        } else {
            self.unmuted
        };
        self.set_volume(to);
    }

    /// The cover's right-click menu (his Decision): an album's Download, Uninstall or
    /// Remove from Library; an internet album's Add to Library and Download; your
    /// playlist's picture, Delete and its download part; Saved Tracks its download
    /// part only; Downloaded Songs none.
    pub fn cover_items(&self) -> Vec<Item<'_, Message>> {
        let p = &self.pictures;
        let row = |icon: &Pair, label: &'static str, pick: Message| Item::Row(drop::Row { icon: icon.clone(), label, after: None, picked: false, pick });
        let mut items = Vec::new();
        match self.showing() {
            Shown::Album(a) => {
                let busy = self.loading.as_ref().is_some_and(|f| f.key == a.key) || self.queue.contains(&a.key);
                let download = if self.failed.contains(&a.key) { "Download Failed" } else { "Download" };
                if self.is_web(a) {
                    items.push(row(&p.new, "Add to Library", Message::Add));
                    items.push(row(&p.download_row, download, Message::Download));
                } else if !busy {
                    if self.missing(a) != Some(0) {
                        items.push(row(&p.download_row, download, Message::Download));
                    }
                    items.push(if a.songs.is_empty() { row(&p.unlist, "Remove from Library", Message::Remove) } else { row(&p.trash_row, "Uninstall", Message::Uninstall) });
                }
            }
            Shown::Playlist(Some(l)) => {
                if !playlist::is_saved(l) {
                    items.push(row(&p.image_row, "Choose Picture", Message::Picture));
                    items.push(row(&p.unlist, "Delete Playlist", Message::DeletePlaylist));
                }
                let failed = self.failed.contains(&playlist::tile_key(&l.name));
                match self.slot(l) {
                    Slot::Download => items.push(row(&p.download_row, if failed { "Download Failed" } else { "Download Playlist" }, Message::DownloadPlaylist)),
                    Slot::Uninstall => items.push(row(&p.trash_row, "Uninstall Playlist", Message::UninstallPlaylist)),
                    Slot::Busy | Slot::None => {}
                }
            }
            Shown::Playlist(None) | Shown::Nothing => {}
        }
        items
    }

    pub fn main_page(&self) -> Element<'_, Message> {
        let c = self.colours;
        let shown = self.showing();
        let record = boxed(container(row![self.cover(&shown), self.details(&shown)].spacing(GAP_3)).padding(GAP_3), c);
        let wheel = mouse_area(record).on_scroll(Message::Wheel);
        let big = boxed(container(self.big_box(&shown)).width(Length::Fill).height(PAGE).clip(true), c);
        row![wheel, big, self.button_column()].spacing(GAP_2).width(drawer_width()).height(PAGE).into()
    }

    /// The playing bar across the box's foot, under both pages (`Library::page`).
    pub fn playing_bar(&self) -> Element<'_, Message> {
        // The times' blank under their numbers comes off the bottom pad (playing_box).
        let pad = Padding { bottom: GAP_2 - seek::below(), ..Padding::new(GAP_2) };
        let bar = boxed(container(self.playing_box()).padding(pad).width(drawer_width()).height(PLAYING), self.colours);
        mouse_area(bar).on_scroll(Message::Wheel).into()
    }

    /// The cover, the download bar across its bottom while it downloads, waits or failed.
    fn cover<'a>(&'a self, shown: &Shown<'a>) -> Element<'a, Message> {
        let p = &self.pictures;
        let art = self.picture().and_then(|(key, _)| self.art.as_ref().filter(|a| a.key == key)).and_then(|a| a.picture.clone());
        let (face, key): (Element<'_, Message>, Option<String>) = match (shown, art) {
            (Shown::Playlist(None), _) => (self.square(COVER, Some(&p.youtube)), None),
            (Shown::Playlist(Some(l)), _) if playlist::is_saved(l) => (self.square(COVER, Some(&p.heart)), Some(playlist::tile_key(&l.name))),
            (Shown::Playlist(Some(l)), art) => (art.map_or_else(|| self.square(COVER, None), |a| image(a).width(COVER).height(COVER).into()), Some(playlist::tile_key(&l.name))),
            (Shown::Album(a), art) => (art.map_or_else(|| self.square(COVER, None), |art| image(art).width(COVER).height(COVER).into()), Some(a.key.clone())),
            (Shown::Nothing, _) => (self.square(COVER, None), None),
        };
        let face = match key {
            Some(k) => self.with_bar(face, &k, COVER),
            None => face,
        };
        let mut area = mouse_area(face).on_press(Message::ToWall).interaction(mouse::Interaction::Pointer);
        if !self.cover_items().is_empty() {
            area = area.on_right_press(Message::CoverMenu);
        }
        area.into()
    }

    /// A cover `side` square with the download bar across its bottom (the main page's
    /// and the wall's, his Decision "Download news").
    pub fn with_bar<'a>(&'a self, face: Element<'a, Message>, key: &str, side: f32) -> Element<'a, Message> {
        match self.download_bar(key, side) {
            Some(bar) => stack![face, container(bar).width(side).align_bottom(side)].into(),
            None => face,
        }
    }

    /// Gap-1 tall: the accent filling done / total while it downloads, an empty track
    /// while it waits, the error colour once it failed (his Decision "Download news").
    fn download_bar(&self, key: &str, side: f32) -> Option<Element<'_, Message>> {
        let c = self.colours;
        let (part, colour) = match &self.loading {
            Some(f) if f.key == key => (f.done as f32 / f.total.max(1) as f32, c.accent),
            _ if self.queue.iter().any(|k| k == key) => (0.0, c.accent),
            _ if self.failed.contains(key) => (1.0, c.error),
            _ => return None,
        };
        let strip = move |w: f32, colour: iced::Color| container(space()).width(w).height(GAP_1).style(move |_| container::background(colour));
        Some(stack![strip(side, c.raised), strip((side * part).round(), colour)].into())
    }

    /// The record's names (title, artist, facts) over its buttons, centred both ways
    /// (his ask 2026-11-04). A name too long for the box starts at its left and is cut.
    fn details<'a>(&'a self, shown: &Shown<'a>) -> Element<'a, Message> {
        let c = self.colours;
        let middle = |e: Element<'a, Message>| -> Element<'a, Message> { container(e).width(Length::Fill).align_x(Horizontal::Center).clip(true).into() };
        let one = |s: String, size: f32, colour: iced::Color| middle(text(s).size(size).line_height(LINE_TIGHT).color(colour).wrapping(text::Wrapping::None).into());
        let names: Vec<Element<'_, Message>> = match shown {
            Shown::Album(a) => {
                let r = self.release(a);
                vec![one(a.title.clone(), TITLE, c.text), middle(self.artist_link(a, r)), one(self.facts(a, r).join(" · "), BODY, c.text_muted)]
            }
            Shown::Playlist(_) => {
                let (artists, facts) = self.playlist_facts();
                vec![middle(self.playlist_title()), one(artists, BODY, c.text), one(facts, BODY, c.text_muted)]
            }
            Shown::Nothing => Vec::new(),
        };
        // One gap between every row, the buttons too (his ask 2026-11-04: "even"): their
        // pictures sit (SLOT - ICON) / 2, a gap-2, inside their cells, so the cells touch
        // the facts and the pictures are as far under them as the facts are under the
        // artist (his ask 2026-11-08, the pill gone: "the same").
        let names = column(names).spacing(GAP_2).align_x(Alignment::Center);
        let middle: Element<'_, Message> = match self.album_bar(shown) {
            Some(album) => column![names, album].align_x(Alignment::Center).into(),
            None => names.into(),
        };
        container(middle).width(DETAILS).height(COVER).align_y(Alignment::Center).into()
    }

    /// Spotify's bottom bar (his ask 2026-11-08; its parts his asks since 2026-11-04):
    /// the playing song's cover and its title over its artist on the left, the player's
    /// buttons over the seek bar in the middle (`MIDDLE`), the speaker and the volume
    /// line at the far right. A right-click on the song opens its menu (his ask
    /// 2026-11-06). Nothing playing: an empty square.
    fn playing_box(&self) -> Element<'_, Message> {
        let c = self.colours;
        let n = &self.now;
        let art = self.song_picture().and_then(|(key, _)| self.song_art.as_ref().filter(|a| a.key == key)).and_then(|a| a.picture.as_ref());
        // Too long for its third, a name slides (his pick 2026-11-04).
        let one = |s: &str, none: &str, size: f32, colour: iced::Color| -> Element<'_, Message> { sliding(if s.is_empty() { none } else { s }.to_string(), size, colour) };
        let names: Element<'_, Message> = if n.loaded() { column![one(&n.title, "Unknown title", BODY, c.text), one(&n.artist, "Unknown artist", SMALL, c.text_muted)].spacing(GAP_1).into() } else { space().into() };
        let names = container(names).width(Length::Fill).height(SONG).align_y(Alignment::Center);
        let song = row![self.face(art, SONG), names].spacing(GAP_3);
        let song: Element<'_, Message> = if n.loaded() { mouse_area(song).on_right_press(Message::SongMenu(Target::Playing)).into() } else { song.into() };
        // The times' numbers' ink as far off the box's bottom as the buttons' track is off
        // its top (his ask 2026-11-04): the row goes down by the blank under them.
        let below = seek::below();
        let controls = column![self.player_bar(), seek::seek(n, c)].spacing(GAP_1 + below).align_x(Alignment::Center).width(drawer_width() * MIDDLE);
        // The speaker's picture a bar button's: its blank is the gap to the line.
        let speaker = self.pictures.player.1[crate::speaker(n.volume, false)].clone();
        let speaker = mouse_area(bar::icon(speaker)).on_press(Message::Mute).interaction(mouse::Interaction::Pointer);
        let volume = row![speaker, seek::volume(n.volume, c, Message::Volume)].align_y(Alignment::Center);
        let volume = container(volume).width(Length::Fill).height(SONG).align_x(Horizontal::Right).align_y(Alignment::Center);
        row![song, controls, volume].spacing(GAP_3).height(SONG + below).into()
    }

    /// Shuffle, previous, play / pause, next, repeat (Spotify's order), pictures only
    /// (his ask 2026-11-08: the pill and the filled squares gone), `SLOT` squares a
    /// gap-1 apart as the button bar's items, no longer the bar's height. As
    /// Spotify's, the picture shows the state: shuffle in accent while on, repeat in
    /// accent while on and turned to repeat-once for one song, pause while the song plays.
    fn player_bar(&self) -> Element<'_, Message> {
        let n = &self.now;
        let pictures = [0, 1, if n.playing { 3 } else { 2 }, 4, if n.repeat == Repeat::Track { 6 } else { 5 }];
        let on = |i: usize| match i {
            SHUFFLE => n.shuffle,
            REPEAT => n.repeat != Repeat::None,
            _ => false,
        };
        let buttons = (0..5).map(|i| {
            let picture = self.pictures.player.0[pictures[i]][on(i) as usize].clone();
            mouse_area(bar::icon(picture)).on_press(Message::Player(i)).interaction(mouse::Interaction::Pointer).into()
        });
        row(buttons).spacing(GAP_1).into()
    }

    /// The shown album's rating (star and number), status, save to playlist and send
    /// to queue; a playlist's, Saved Tracks', Downloaded Songs' and an internet
    /// album's save and send only. Each button's place is kept for its menu.
    fn album_bar<'a>(&'a self, shown: &Shown<'a>) -> Option<Element<'a, Message>> {
        let (kinds, target, album): (&[usize], Target, Option<&Album>) = match shown {
            Shown::Album(a) if !self.is_web(a) => (&[RATING, STATUS, SAVE, QUEUE], Target::Album, Some(*a)),
            Shown::Album(_) => (&[SAVE, QUEUE], Target::Album, None),
            Shown::Playlist(_) => (&[SAVE, QUEUE], Target::Playlist, None),
            Shown::Nothing => return None,
        };
        let c = self.colours;
        let p = &self.page_pictures;
        let end = page::end_pad();
        let face = |kind: usize| -> Element<'_, Message> {
            let rating = album.map_or(0, |a| a.rating);
            match kind {
                RATING => page::cell(&p.star, (rating > 0).then(|| (page::RATINGS[10 - rating as usize], GAP_1)), false, c.text, end),
                STATUS => {
                    let status = album.and_then(|a| a.status).map(|s| &p.status[library::Status::ALL.iter().position(|x| *x == s).unwrap_or(0)]);
                    page::cell(status.unwrap_or(&p.tag), None::<(&str, f32)>, false, c.text, end)
                }
                SAVE => page::cell(&p.save, None::<(&str, f32)>, false, c.text, end),
                _ => page::cell(&p.queue, None::<(&str, f32)>, false, c.text, end),
            }
        };
        let press = |kind: usize| match kind {
            RATING | STATUS => Message::PageBar(kind),
            SAVE => Message::SaveMenu(target.clone(), SAVE),
            _ => Message::Send(target.clone()),
        };
        // Pictures only (his ask 2026-11-08: the pill gone, as the player's), a gap-1 apart
        // as the bar's items; each one's place kept for its menu.
        let cells = kinds.iter().map(|&k| measured(mouse_area(face(k)).on_press(press(k)).interaction(mouse::Interaction::Pointer), move |at| Message::PageCell(k, at)).into());
        Some(row(cells).spacing(GAP_1).into())
    }

    /// The picked tab: a list scrolling on its own, or the playing song's words.
    fn big_box<'a>(&'a self, shown: &Shown<'a>) -> Element<'a, Message> {
        let c = self.colours;
        match (self.tab, shown) {
            (Tab::Lyrics, _) => {
                let words = self.words.get(&words::key(&self.now));
                container(lyrics::lyrics(words, self.now.loaded().then_some(&self.now), c)).padding([0.0, GAP_3]).into()
            }
            (Tab::Search, _) => self.search_page(),
            (Tab::Tracks, Shown::Album(a)) => self.scrolled(self.songs(a, self.release(a))),
            (Tab::Credits, Shown::Album(a)) => self.scrolled(self.credits(a, self.release(a))),
            (Tab::Discography, Shown::Album(a)) => self.scrolled(self.discography(a, self.release(a))),
            (_, Shown::Playlist(_)) => self.scrolled(self.playlist_rows()),
            _ => space().into(),
        }
    }

    fn scrolled<'a>(&self, content: Element<'a, Message>) -> Element<'a, Message> {
        let list = scrollable(container(content).padding(GAP_3)).id(box_scroll()).on_scroll(|v| {
            let y = v.absolute_offset().y;
            Message::Scrolled(y, v.content_bounds().height - v.bounds().height - y <= playlist::MORE)
        });
        styled(list.width(Length::Fill).height(Length::Fill), self.colours).into()
    }

    /// Search, then the big box's tabs, in one pill down a column (`bar::Bar`, Raised;
    /// his ask 2026-11-08: the search pill joined to the tabs' pill), its accent resting
    /// on the shown tab; a tab out of reach greyed out, taking no click and no accent
    /// (his ask 2026-11-06).
    fn button_column(&self) -> Element<'_, Message> {
        let glass = &self.pictures.search;
        let tabs: Vec<_> = std::iter::once((Tab::Search, glass)).chain(Tab::ALL.into_iter().zip(&self.page_pictures.tabs)).collect();
        let press = |t: Tab, face: Element<'static, Message>| -> Element<'static, Message> { mouse_area(face).on_press(Message::Tab(t)).interaction(mouse::Interaction::Pointer).into() };
        let plain = tabs.iter().map(|&(t, p)| if self.usable(t) { press(t, bar::icon(p.get(false))) } else { bar::faded(p.get(false)) }).collect();
        let lit = tabs.iter().map(|&(t, p)| if self.usable(t) { bar::icon(p.get(true)) } else { bar::faded(p.get(false)) }).collect();
        let skip = (0..tabs.len()).filter(|&i| !self.usable(tabs[i].0)).collect();
        Bar::new(plain, lit, tabs.iter().position(|(t, _)| *t == self.tab), None, &self.colours).on(self.colours.panel).skip(skip).into()
    }
}

/// The box's content width, every page's.
fn drawer_width() -> f32 {
    mp_ui::drawer::MUSIC
}
