//! The music box, part of mp-shell: the Music panel of the one top drawer
//! (`mp_ui::drawer`), opened by Mod+Shift+D over the session bus (`bus.rs`) or the top
//! bar's page buttons; the strip lays its panels side by side in it (`Music::view`).
//! Its state is made on the first open and kept after the box shuts. Windows' Music
//! page (`modules/core/library/music/`) held to the rulebook: the cover wall and the
//! lists on the left page, the open record on the main page. Songs play in
//! `mp-player`, so shutting the box keeps the music going; songs not on this PC play
//! off the internet, their addresses looked up here ahead.

pub(crate) mod bus;
mod download;
mod import;
mod library;
mod lyrics;
mod main_page;
mod now;
mod page;
mod playlist;
mod release;
mod search;
mod seek;
mod sliding;
mod stats;
pub(crate) mod web;
mod words;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use iced::widget::{Id, column, container, image, mouse_area, operation, row, scrollable, space, stack, text, text_input};
use iced::{Alignment, Color, Element, Event, Length, Padding, Point, Rectangle, Subscription, Task, Vector, border, event, keyboard, mouse, window};
use iced_exwlshell::actions::RegionActionCB;
use iced_exwlshell::reexport::{Anchor, KeyboardInteractivity, Layer, LayerSize, Margin, NewLayerShellSettings, OutputOption};
use iced_exwlshell::to_layer_message;
use mp_ui::bar::{self, Bar, SLOT};
use mp_ui::colours::{self, Colours};
use mp_ui::drag::Reorder;
use mp_ui::drawer::{self, MUSIC};
use mp_ui::measured::measured;
use mp_ui::scroll::styled;
use mp_ui::style::{BODY, CONTROL, CORNER, GAP_1, GAP_2, GAP_3, ICON, ICON_LG, ICON_SM, LINE_TIGHT, MENU_PAD};
use mp_ui::{MEDIUM, cover, turned};

use library::{Album, Playlist, Status};
use mp_ui::drop::{self, Item, Pair};
use now::Now;
use playlist::Target;
use release::Release;
use web::{Artist, Group, Video};

/// A cover on the wall: Windows' smallest tile (`TILE_MIN` 93 -> 100, his call
/// 2026-10-31).
const SIDE: f32 = 100.0;
/// The wall's covers' box: the box's width less the up-and-down bar and the gap-2
/// between (Music Tab Redesign step 4).
const WALL: f32 = MUSIC - bar::THICK - GAP_2;

/// The wall's rows and their covers' side, whole pixels: of the most rows that fit the
/// page's height at `SIDE` and one more, the count whose side is nearer it, as many
/// times over as under; the rows fill the height, a gap-2 over, under and between, and
/// the wall scrolls sideways (his ask 2026-11-08: "so that i dont have to scroll up and
/// down"; until then the covers filled each row across, his ask as Spotify's library,
/// his pick over Windows' `minmax(100px, 1fr)`, whose one cover grew to 210 before a
/// second joined: "too big"). The part pixel left goes over and under.
fn wall() -> (usize, f32) {
    rows_in(main_page::PAGE)
}

/// An artist page's rows and covers' side: the wall's rule in the page less the
/// artist's name line and the gap-3 under it (his ask 2026-11-09: "Make it sideways
/// too"; the name stays put over the sliding covers, his pick).
pub(crate) fn artist_rows() -> (usize, f32) {
    rows_in(main_page::PAGE - mp_ui::style::TITLE * LINE_TIGHT - GAP_3)
}

/// The rows of covers, and their side, that fill `h` by `wall`'s rule.
fn rows_in(h: f32) -> (usize, f32) {
    let side = |n: usize| (h - (n + 1) as f32 * GAP_2) / n as f32;
    let n = (((h - GAP_2) / (SIDE + GAP_2)).floor() as usize).max(1);
    let n = if side(n + 1) > 0.0 && SIDE / side(n + 1) < side(n) / SIDE { n + 1 } else { n };
    (n, side(n).floor())
}

/// The box as it shows: the pages. Every panel of the top drawer is this size (the
/// strip's blanks, Top Strip plan step 3).
pub(crate) fn size() -> iced::Size {
    iced::Size::new(MUSIC, main_page::H)
}

/// One of the music box's boxes (the album, the songs, the playing bar, the wall, an
/// artist's page): `panel`, the drawer's own colour, no line (his ask 2026-11-09, like
/// hooxoo's yazi: nothing sets the parts apart, the gaps the boxes' colour).
fn boxed<'a>(inside: container::Container<'a, Message>, c: Colours) -> Element<'a, Message> {
    let fill = move |_: &iced::Theme| container::Style { background: Some(c.panel.into()), border: border::rounded(CORNER), ..Default::default() };
    inside.style(fill).into()
}

/// The box's content: the body (the taller Chat page went with M&P Chat, 2026-11-07).
fn content() -> iced::Size {
    iced::Size::new(MUSIC, BODY_HEIGHT)
}

/// A search box: as wide as its word, measured as a text box draws (the Library's rule).
fn search_width() -> f32 {
    drop::text_width("Search", iced::advanced::text::Shaping::Advanced).ceil() + 1.0
}

/// The part of the box's surface that takes the pointer.
fn input_region(id: window::Id, hit: Rectangle) -> Task<Message> {
    let region = RegionActionCB::new(move |region| {
        let _ = region.add(hit.x as i32, hit.y as i32, hit.width as i32, hit.height as i32);
    });
    Task::done(Message::SetInputRegion { id, callback: region })
}
/// The play button on a hovered cover: the control height (his call 2026-10-31;
/// Windows' 40, a quarter larger, was half a 100 cover).
const PLAY: f32 = CONTROL;
/// The button bar's cells after the search box: the Albums / Playlists / Both
/// switch, sort, filter, and the plus (New Playlist).
const CELLS: usize = 4;
const VIEW: usize = 0;
const SORT: usize = 1;
const FILTER: usize = 2;
const NEW: usize = 3;
/// Artist covers fetched at once (Windows' `streamCache` asks 3 at a time).
const THUMBS: usize = 3;
/// Marks a Discography being asked for in `Library::asking` (never a release id or key).
const DISCOGRAPHY: &str = "\0discography ";
/// Songs' addresses looked up at once (Windows' `streamCache`, his pick).
const AHEAD: usize = 3;

/// The strip's hold on the box: its state and its own kinds of message stay in here.
pub(crate) struct Music(Library);

impl Music {
    pub(crate) fn new() -> (Self, Task<crate::Message>) {
        let (library, task) = Library::new();
        (Self(library), task.map(lift))
    }

    pub(crate) fn update(&mut self, Msg(message): Msg) -> Task<crate::Message> {
        self.0.update(message).map(lift)
    }

    /// The box's surface, while it shows.
    pub(crate) fn shows(&self, id: window::Id) -> bool {
        self.0.top.as_ref().is_some_and(|t| t.id == id)
    }

    /// The drawer is up and staying (not closing).
    pub(crate) fn open(&self) -> bool {
        self.0.top.as_ref().is_some_and(|t| t.open(self.0.hold()))
    }

    /// The drawer: `pages` lays the panels out round this box's page (the strip's).
    pub(crate) fn view<'a>(&'a self, id: window::Id, pages: impl FnOnce(Element<'a, crate::Message>) -> Element<'a, crate::Message>) -> Element<'a, crate::Message> {
        let l = &self.0;
        let Some(top) = l.top.as_ref().filter(|t| t.id == id) else { return space().into() };
        let over = Element::from(measured(l.over(), Message::Room)).map(lift);
        drawer::drawer(pages(l.page().map(lift)), top.open(l.hold()), l.corner, l.colours.panel, |e| lift(Message::Drawer(e))).over(over).into()
    }

    pub(crate) fn subscription(&self) -> Subscription<crate::Message> {
        self.0.subscription().map(lift)
    }
}

/// A message to the box, as the strip holds it.
#[derive(Debug, Clone)]
pub(crate) struct Msg(Message);

impl Msg {
    /// The panel pill or the shortcut.
    pub(crate) fn call(call: bus::Call) -> Self {
        Self(Message::Bus(call))
    }

    /// The drawer slid off the Music panel.
    pub(crate) fn away() -> Self {
        Self(Message::Away)
    }

    /// mp-theme wrote new colours (the strip hears its signal).
    pub(crate) fn colours() -> Self {
        Self(Message::Colours)
    }
}

/// The box's messages as the strip's: the runtime acts only on the program's own
/// message, so the layer asks the box makes become the strip's; the rest come back here.
fn lift(message: Message) -> crate::Message {
    match message {
        Message::NewLayerShell { settings, id } => crate::Message::NewLayerShell { settings, id },
        Message::LayoutChange { id, anchor, size } => crate::Message::LayoutChange { id, anchor, size },
        Message::KeyboardInteractivityChange { id, keyboard_interactivity } => crate::Message::KeyboardInteractivityChange { id, keyboard_interactivity },
        Message::SetInputRegion { id, callback } => crate::Message::SetInputRegion { id, callback },
        message => crate::Message::Music(Msg(message)),
    }
}

/// The box's surface while it shows: the strip's other surfaces' clicks, keys and
/// pointer moves are not the box's.
static OPEN: Mutex<Option<window::Id>> = Mutex::new(None);

/// The surface's room: the pages (`main_page::H` tall) over the room
/// for their menus (a song's with your playlists outruns the page), which fit the
/// surface (his call, chat 57; the top area's 50 off it since it went, 2026-11-06).
const BODY_HEIGHT: f32 = 720.0;

/// The open box: its surface, why it is open (the shell's top bar's rules, Windows'
/// `useHoverIntent`), and the surface's state as last sent.
struct Top {
    id: window::Id,
    /// Opened by the shortcut: it stays until the shortcut or Esc, or until the
    /// pointer, once it came in, leaves (Windows' shortcut-to-hover handover).
    key: bool,
    entered: bool,
    over: bool,
    /// Closed by the shortcut, Esc or a click outside while you type.
    shut: bool,
    /// The keyboard held; the surface spanning the screen (while you type, so a click
    /// outside the box is heard); the whole surface taking the pointer (typing or a
    /// menu); the box's part of the surface.
    exclusive: bool,
    full: bool,
    whole: bool,
    hit: Option<Rectangle>,
}

impl Top {
    /// `hold`: you are typing in it, or the desktop's Open window is up.
    fn open(&self, hold: bool) -> bool {
        !self.shut && ((self.key && !self.entered) || self.over || hold)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Sort {
    Added,
    Rating,
    Artist,
    Year,
    Title,
    /// Your own order (his pick, chat 37): hold a tile and drag it; one order holds
    /// albums and playlists both; no direction (Windows').
    Custom,
}

impl Sort {
    const ALL: [Sort; 6] = [Sort::Added, Sort::Rating, Sort::Artist, Sort::Year, Sort::Title, Sort::Custom];

    fn label(self) -> &'static str {
        match self {
            Sort::Added => "Date Added",
            Sort::Rating => "Your Rating",
            Sort::Artist => "Artist",
            Sort::Year => "Year",
            Sort::Title => "Title",
            Sort::Custom => "Custom",
        }
    }

    /// Windows' `defaultDir`: newest, highest and latest first, names A to Z.
    fn descending(self) -> bool {
        matches!(self, Sort::Added | Sort::Rating | Sort::Year)
    }

    fn order(self, a: &Album, b: &Album) -> std::cmp::Ordering {
        match self {
            Sort::Added => a.added.cmp(&b.added),
            Sort::Rating => a.rating.cmp(&b.rating),
            Sort::Artist => a.artist.to_lowercase().cmp(&b.artist.to_lowercase()),
            Sort::Year => a.year.cmp(&b.year),
            Sort::Title => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
            Sort::Custom => std::cmp::Ordering::Equal,
        }
    }

    /// Two tiles: albums by the sort; a playlist by when it was made or its name
    /// (only those two sorts put playlists among the albums).
    fn compare(self, a: &Tile, b: &Tile) -> std::cmp::Ordering {
        match (a, b) {
            (Tile::Album(x), Tile::Album(y)) => self.order(x, y),
            _ if self == Sort::Added => a.added().cmp(&b.added()),
            _ => a.name().to_lowercase().cmp(&b.name().to_lowercase()),
        }
    }
}

/// What the wall shows (his pick, Windows' `VIEW_OPTIONS`); Both at each open.
#[derive(Debug, Clone, Copy, PartialEq)]
enum View {
    Albums,
    Playlists,
    Both,
}

impl View {
    const ALL: [View; 3] = [View::Albums, View::Playlists, View::Both];

    fn label(self) -> &'static str {
        match self {
            View::Albums => "Albums",
            View::Playlists => "Playlists",
            View::Both => "Both",
        }
    }
}

/// A tile on the wall.
enum Tile<'a> {
    Downloaded,
    Album(&'a Album),
    Playlist(&'a Playlist),
}

impl Tile<'_> {
    fn added(&self) -> SystemTime {
        match self {
            Tile::Downloaded => SystemTime::UNIX_EPOCH,
            Tile::Album(a) => a.added,
            Tile::Playlist(p) => p.added,
        }
    }

    fn name(&self) -> &str {
        match self {
            Tile::Downloaded => playlist::NAME,
            Tile::Album(a) => &a.title,
            Tile::Playlist(p) => &p.name,
        }
    }

    /// Its key in the Custom order and for its hover: an album's folder key, '/' + a
    /// playlist's name.
    fn key(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Tile::Downloaded => playlist::NAME.into(),
            Tile::Album(a) => a.key.as_str().into(),
            Tile::Playlist(p) => playlist::tile_key(&p.name).into(),
        }
    }
}

/// What is held to drag (piece C): a row of the open playlist, or a tile on the
/// wall (Custom).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Held {
    Row(usize),
    Tile,
}

/// Which search box has the keys.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Field {
    /// The wall's: filters your albums as you type.
    Wall,
    /// The top bar's: searches the internet as you type (`search.rs`).
    Web,
}

/// What a page shows: the main page a record, the left page the wall (`Home`) or an
/// artist's albums.
#[derive(Debug, Clone, PartialEq)]
enum Place {
    /// On the main page, nothing picked; on the left page, the wall.
    Home,
    /// An album's page, yours or one off the internet (`Library.web`).
    Album(String),
    /// An artist's albums and EPs: id, name.
    Artist(String, String),
    /// Downloaded Songs.
    Downloaded,
    /// One of your playlists, by name.
    Playlist(String),
}

/// An answer on its way.
pub enum Found<T> {
    Loading,
    Failed,
    Got(Vec<T>),
}

impl<T> From<Option<Vec<T>>> for Found<T> {
    fn from(answer: Option<Vec<T>>) -> Self {
        answer.map_or(Found::Failed, Found::Got)
    }
}

/// The search's three lists.
pub struct Results {
    pub albums: Found<Group>,
    pub artists: Found<Artist>,
    pub songs: Found<Video>,
}

pub struct ArtistPage {
    pub id: String,
    pub groups: Found<Group>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Menu {
    View,
    Sort,
    Filter,
    New,
    Rating,
    Status,
    /// A song's right-click (Windows' `useSongMenu`): Send to Queue, Remove from
    /// Playlist on a playlist's own row, then Save to Playlist's rows; at the pointer.
    Song,
    /// The main page's cover's right-click: the shown record's own actions, at the pointer.
    Cover,
    /// Save to Playlist's rows alone, under the album bar's cell (the rows' plus went
    /// for the right-click menu, his call chat 58).
    Save(usize),
}

/// The shown record's cover, cut for the main page; none if it couldn't be read.
struct Art {
    key: String,
    picture: Option<image::Handle>,
}

struct Pictures {
    /// The search box's glass: Text, On Accent while typing.
    search: Pair,
    /// Albums, Playlists, Both.
    view: [Pair; 3],
    sort: [Pair; 6],
    down: Pair,
    up: Pair,
    /// No filter picked.
    all: Pair,
    status: [Pair; 4],
    /// Downloaded, Not Downloaded.
    files: [Pair; 2],
    /// New Playlist, Import Playlist.
    new: Pair,
    import: Pair,
    /// A song menu's Send to Queue and Remove from Playlist.
    queue: Pair,
    unlist: Pair,
    check: Pair,
    /// A song menu's Save to / Remove from Saved Tracks row.
    heart_row: Pair,
    play: image::Handle,
    /// Downloaded Songs' face, Saved Tracks'.
    youtube: image::Handle,
    heart: image::Handle,
    /// The cover menu's rows: Download, Uninstall, Choose Picture.
    download_row: Pair,
    trash_row: Pair,
    image_row: Pair,
    player: main_page::Player,
}

impl Pictures {
    fn new(c: &Colours) -> Self {
        let mark = |svg: &[u8]| Pair::new(svg, ICON, c.text, c.on_accent);
        Self {
            search: Pair::new(include_bytes!("../../assets/bx-search.svg"), ICON, c.text, c.on_accent),
            view: [mark(include_bytes!("../../assets/bx-music.svg")), mark(include_bytes!("../../assets/bx-file-detail.svg")), mark(include_bytes!("../../assets/bx-grid.svg"))],
            new: mark(include_bytes!("../../assets/bx-plus-big.svg")),
            import: mark(include_bytes!("../../assets/bx-list-plus.svg")),
            sort: [
                mark(include_bytes!("../../assets/bx-calendar.svg")),
                mark(include_bytes!("../../assets/bx-star.svg")),
                mark(include_bytes!("../../assets/bx-microphone.svg")),
                mark(include_bytes!("../../assets/bx-tag.svg")),
                mark(include_bytes!("../../assets/bx-font-family.svg")),
                mark(include_bytes!("../../assets/bx-arrow-down-a-z.svg")),
            ],
            down: Pair::new(include_bytes!("../../assets/bx-arrow-down.svg"), ICON_SM, c.text, c.on_accent),
            up: Pair::new(include_bytes!("../../assets/bx-arrow-up.svg"), ICON_SM, c.text, c.on_accent),
            all: mark(include_bytes!("../../assets/bx-layers.svg")),
            status: [mark(include_bytes!("../../assets/bx-clock.svg")), mark(include_bytes!("../../assets/bx-rocket.svg")), mark(include_bytes!("../../assets/bx-check.svg")), mark(include_bytes!("../../assets/bx-x.svg"))],
            files: [mark(include_bytes!("../../assets/bx-arrow-to-bottom.svg")), mark(include_bytes!("../../assets/bx-globe.svg"))],
            check: Pair::new(include_bytes!("../../assets/bx-check.svg"), ICON, c.text, c.on_accent),
            queue: Pair::new(include_bytes!("../../assets/bx-paper-plane.svg"), ICON, c.text, c.on_accent),
            unlist: Pair::new(include_bytes!("../../assets/bx-minus.svg"), ICON, c.text, c.on_accent),
            heart_row: Pair::new(include_bytes!("../../assets/bx-heart.svg"), ICON, c.text, c.on_accent),
            play: mp_ui::icon::svg(include_bytes!("../../assets/bx-play.svg"), ICON, c.on_accent),
            youtube: mp_ui::icon::svg(include_bytes!("../../assets/bx-youtube.svg"), ICON_LG, c.text),
            heart: mp_ui::icon::svg(include_bytes!("../../assets/bx-heart.svg"), ICON_LG, c.text),
            download_row: Pair::new(include_bytes!("../../assets/bx-arrow-big-down.svg"), ICON, c.text, c.on_accent),
            trash_row: Pair::new(include_bytes!("../../assets/bx-trash.svg"), ICON, c.text, c.on_accent),
            image_row: Pair::new(include_bytes!("../../assets/bx-image.svg"), ICON, c.text, c.on_accent),
            player: main_page::Player::new(c),
        }
    }
}

struct Library {
    colours: Colours,
    pictures: Pictures,
    albums: Vec<Album>,
    /// Covers by album key, cut at `side`.
    covers: HashMap<String, image::Handle>,
    /// The covers' side on the wall and an artist's page (`grid`), set once.
    side: f32,
    /// The open box, while it shows; the windows' corner (niri's), which its curves take.
    top: Option<Top>,
    corner: f32,
    /// The wall's search words, and the internet's; the wall's as drawn in its bar,
    /// turned (`wall_words`).
    query: String,
    web_query: String,
    typing: Option<Field>,
    words_pic: Option<(image::Handle, iced::Size, (bool, String, f32))>,
    /// The wall bar's length as laid out.
    wall_bar: f32,
    view: View,
    sort: Sort,
    descending: bool,
    status: Option<Status>,
    /// Some(true) = downloaded only, Some(false) = not downloaded only.
    files: Option<bool>,
    open: Option<Menu>,
    /// Where the bar's cells and the window sit, read off the live layout.
    cells: [Rectangle; CELLS],
    window: Rectangle,
    hovered: Option<String>,
    /// The record the main page shows (Album, Playlist, Downloaded; Home = none), and
    /// what the left page shows (Home = the wall, Artist); `left`: the left
    /// page is shown; `forward`: the mouse's Back just left it (its Forward goes back).
    place: Place,
    aside: Place,
    left: bool,
    forward: bool,
    /// The room menus have over the box: from the content's top left to the surface's
    /// far corner (`Drawer::over`).
    room: Rectangle,
    /// Songs' words by `words::key`, fetched while the box is open.
    words: HashMap<String, words::Words>,
    /// Albums opened off the internet, by key (`Artist/Title`, as a folder).
    web: HashMap<String, Album>,
    /// The Search page's lists; searches made (each change of the words: an answer
    /// older than the list shown is dropped, Windows' `reqId`) and the asks for them.
    results: Results,
    asked: u64,
    asks: search::Asks,
    artist: Option<ArtistPage>,
    /// The open album's artist's other records (the Discography tab, asked for when
    /// it is picked).
    discography: Option<ArtistPage>,
    /// Artist covers by release group, cut as the wall's, the shown artist's only; the
    /// ones still to fetch, the next on top, and how many are on their way.
    thumbs: HashMap<String, image::Handle>,
    thumb_queue: Vec<String>,
    thumbs_busy: usize,
    page_pictures: page::Pictures,
    /// The album page's tab.
    tab: page::Tab,
    /// Artists' photos, cut round, by MusicBrainz id; none = asked, and it has none.
    photos: HashMap<String, Option<image::Handle>>,
    /// Songs' Spotify plays by MusicBrainz recording.
    world: HashMap<String, u64>,
    /// Song lists by release id (by album key for an album with none).
    releases: HashMap<String, Release>,
    /// Release ids being asked for, and internet albums (by key) whose release is
    /// being picked.
    asking: HashSet<String>,
    /// Internet albums (by key) whose cover is on its way.
    covering: HashSet<String>,
    art: Option<Art>,
    /// A cover is being cut; another waits until it is done.
    art_busy: bool,
    /// The playing song's picture, cut for the playing box, and whether one is being cut.
    song_art: Option<Art>,
    song_art_busy: bool,
    /// The volume the speaker goes back to (the playing bar's, Spotify's mute).
    unmuted: f64,
    /// The album bar's cells by kind (`page::RATING`..), and how far the big box's
    /// list is scrolled.
    page_cells: [Rectangle; page::CELLS],
    scrolled: f32,
    /// The open album's plays a song, by place.
    plays: HashMap<(u32, u32), u32>,
    now: Now,
    /// Albums and playlists (a playlist's tile key) waiting to download, the next
    /// first (one at a time, his pick), the one downloading, and those whose last
    /// download got no song.
    queue: VecDeque<String>,
    loading: Option<Fetch>,
    failed: HashSet<String>,
    /// `sources` (song key, link), read again after each write.
    links: Vec<(String, String)>,
    /// Songs' addresses as the player takes them, by key: memory only, never on disk
    /// (his pick); the songs waiting to be looked up, the next first; those on their
    /// way; those no upload was found for, or whose link found nothing (not asked again
    /// while the strip runs).
    addresses: HashMap<String, String>,
    looks: VecDeque<Look>,
    looking: HashSet<String>,
    unfound: HashMap<String, Instant>,
    /// A play waiting for its first song's address (songs, start).
    pending: Option<(Vec<String>, usize)>,
    /// YouTube songs downloading on their own, and those on this PC, by id.
    singles: HashSet<String>,
    have: HashSet<String>,
    /// Downloaded Songs, newest first, and finished listens by song key (read on its
    /// page).
    downloaded: Vec<library::Song>,
    song_plays: HashMap<String, u32>,
    /// Your playlists, by name; the faces asked for (by tile key).
    playlists: Vec<Playlist>,
    facing: HashSet<String>,
    /// The open playlist's name being typed, and whether its box has had the keys
    /// yet (a click off it then leaves it).
    naming: Option<String>,
    naming_seen: bool,
    /// An Open window is up (a picture, an import).
    picking: bool,
    /// The songs the open song menu acts on, and where it opened (the pointer, from the
    /// content's top left: the surface may grow while it shows).
    target: Option<Target>,
    menu_at: Point,
    /// Songs sent to the queue not handed over yet: from a name-only row on, waiting
    /// for its link.
    sending: VecDeque<String>,
    /// The wall's Custom order (tile keys, `order`), and what is held to drag.
    custom: Vec<String>,
    held: Option<Held>,
    /// The playlist page's rows built so far (50 at a time as it scrolls, piece D).
    built: usize,
    /// Playlist rows' YouTube pictures, cut small, by video id; none = on its way, or
    /// none came (asked once a strip run).
    row_pics: HashMap<String, Option<image::Handle>>,
    stats: stats::Stats,
}

/// A song not on this PC whose address is looked up ahead: its key, its link when
/// `sources` has one, else its album's artist and its details to find one by.
struct Look {
    key: String,
    link: Option<String>,
    find: Option<(String, release::Track)>,
}

/// An album or a playlist (its tile key) downloading: its songs to fetch, those
/// done, those that came.
pub struct Fetch {
    pub key: String,
    pub total: usize,
    pub done: usize,
    pub got: usize,
}

#[to_layer_message(multi)]
#[derive(Debug, Clone)]
enum Message {
    /// The shortcut over the session bus, or a page button on the top bar.
    Bus(bus::Call),
    /// The strip slid the drawer to another panel: menus and the keys let go.
    Away,
    /// The box: the pointer on it, its part of the surface, shut.
    Drawer(drawer::Event),
    Cell(usize, Rectangle),
    Window(Rectangle),
    Covers(Vec<(String, image::Handle)>),
    Bar(usize),
    Query(Field, String),
    /// Any left click anywhere (whether a widget took it), and whether a search box has
    /// the keys after it.
    Pressed(bool),
    /// The wall's glass: its box opens over the bar; the bar laid out.
    OpenSearch,
    WallBar(Rectangle),
    Focused(Field, bool),
    Escape,
    /// Typing in the internet's box paused on search n.
    Paused(u64),
    Albums(u64, Option<Vec<Group>>),
    Artists(u64, Option<Vec<Artist>>),
    Songs(u64, Option<Vec<Video>>),
    Group(Group),
    Artist(Artist),
    Groups(String, Option<Vec<Group>>),
    Thumb(String, Option<image::Handle>),
    /// The album page's tab picked; the Discography tab's list; an artist's photo; the
    /// open album's Spotify plays.
    Tab(page::Tab),
    Discography(String, Option<Vec<Group>>),
    Photo(String, Option<image::Handle>),
    World(Vec<(String, u64)>),
    /// An internet album's release, and its songs.
    Picked(String, Option<(String, Option<Release>)>),
    Cover(String, Option<PathBuf>),
    Add,
    /// The mouse's back and forward buttons.
    Back,
    Forward,
    Sort(Sort),
    Status(Status),
    Files(bool),
    Close,
    Hover(String, bool),
    Select(String),
    Play(String),
    Art(String, Option<image::Handle>),
    SongArt(String, Option<image::Handle>),
    Fetched(String, Option<Release>),
    PageCell(usize, Rectangle),
    PageBar(usize),
    /// The page scrolled: how far, and whether the end of its rows nears the bottom.
    Scrolled(f32, bool),
    Rate(u8),
    Mark(Status),
    PlayAlbum,
    /// The Download button: download or repair.
    Download,
    /// The trash can: the songs to the bin.
    Uninstall,
    /// The minus, once no songs are on this PC: Remove from Library.
    Remove,
    /// A song of the album or playlist downloading.
    Got(download::Event),
    Song(usize),
    /// A song's look-up: the link found for it (none when `sources` had one), and its
    /// address.
    Address(String, (Option<String>, Option<String>)),
    /// A YouTube song's row, and its download arrow; the arrow's download done.
    Tube(Video),
    Single(Video),
    Downloaded(String, Option<String>),
    /// A playlist (`None` = Downloaded Songs): its page, Play Playlist (and its
    /// tile's play); a song's row on the page shown.
    Playlist(Option<String>),
    PlayPlaylist(Option<String>),
    PlaylistSong(usize),
    View(View),
    NewPlaylist,
    /// The open playlist's name clicked; typed; Enter; its box has the keys or not.
    Name,
    Naming(String),
    Rename,
    NameFocused(bool),
    /// Your own picture: the Open window, and the file picked in it.
    Picture,
    Pictured(String, Option<PathBuf>),
    DeletePlaylist,
    /// Import Playlist: the Open window, and the file picked in it.
    Import,
    Imported(Option<PathBuf>),
    /// The open playlist's download part: Download, then Uninstall once all are in.
    DownloadPlaylist,
    UninstallPlaylist,
    /// A song row's right-click; Save to Playlist's rows (an album bar's cell).
    SongMenu(Target),
    SaveMenu(Target, usize),
    /// In a song menu: one of your playlists (in, or out when it holds them), New
    /// Playlist with them, Remove from Playlist (the open playlist's row).
    Save(String),
    SaveNew,
    /// A song menu's first row: into Saved Tracks, or out when it holds them.
    Heart,
    Unlist(usize),
    /// Send to Queue: after what plays.
    Send(Target),
    /// Held to drag (piece C); a tile let go (shown places: from, to); a row of the
    /// open playlist let go.
    Lift(Held),
    MoveTile(usize, usize),
    MoveRow(usize, usize),
    Now(Now),
    Colours,
    /// The main page: a player bar button; the wheel over its media box or the playing
    /// bar, the volume line and the speaker (the volume); its cover clicked (to the left
    /// page) or right-clicked; the room menus have; a song's words; playlist rows'
    /// pictures.
    Player(usize),
    Wheel(mouse::ScrollDelta),
    Volume(f64),
    Mute,
    ToWall,
    CoverMenu,
    Room(Rectangle),
    Words(String, words::Words),
    RowPics(Vec<(String, Option<image::Handle>)>),
}

/// A record's place from its tile key (`Tile::key`): an album's folder key, '/' + a
/// playlist's name, Downloaded Songs' name.
fn place_of(key: &str) -> Place {
    match key.strip_prefix('/') {
        _ if key == playlist::NAME => Place::Downloaded,
        Some(name) => Place::Playlist(name.into()),
        None => Place::Album(key.into()),
    }
}

fn field_id(f: Field) -> Id {
    Id::new(match f {
        Field::Wall => "search",
        Field::Web => "web",
    })
}

/// The main page's big box's list.
fn box_scroll() -> Id {
    Id::new("box")
}

impl Library {
    /// The window, and a cover fetched for each album that came without one (a
    /// fetch at Add can fail: the archive's server took 5-10 s a cover, chat 33).
    fn new() -> (Self, Task<Message>) {
        let colours = colours::load();
        let links = library::links();
        let (shown, shown_tab) = library::shown();
        let mut library = Self {
            pictures: Pictures::new(&colours),
            page_pictures: page::Pictures::new(&colours),
            releases: HashMap::new(),
            asking: HashSet::new(),
            covering: HashSet::new(),
            place: Some(&shown).filter(|k| !k.is_empty()).map_or(Place::Home, |k| place_of(k)),
            aside: Place::Home,
            left: false,
            forward: false,
            room: Rectangle::default(),
            words: HashMap::new(),
            stats: stats::Stats::default(),
            web: HashMap::new(),
            results: Results::loading(),
            asked: 0,
            asks: search::Asks::default(),
            artist: None,
            discography: None,
            thumbs: HashMap::new(),
            thumb_queue: Vec::new(),
            thumbs_busy: 0,
            tab: page::Tab::ALL.into_iter().find(|t| format!("{t:?}") == shown_tab).unwrap_or(page::Tab::Tracks),
            photos: HashMap::new(),
            world: HashMap::new(),
            art: None,
            art_busy: false,
            song_art: None,
            song_art_busy: false,
            unmuted: 1.0,
            page_cells: [Rectangle::default(); page::CELLS],
            scrolled: 0.0,
            plays: HashMap::new(),
            now: Now::default(),
            queue: VecDeque::new(),
            loading: None,
            failed: HashSet::new(),
            playlists: library::playlists(&links),
            facing: HashSet::new(),
            naming: None,
            naming_seen: false,
            picking: false,
            target: None,
            menu_at: Point::ORIGIN,
            sending: VecDeque::new(),
            custom: library::order(),
            held: None,
            built: playlist::ROWS,
            row_pics: HashMap::new(),
            links,
            addresses: HashMap::new(),
            looks: VecDeque::new(),
            looking: HashSet::new(),
            unfound: HashMap::new(),
            pending: None,
            singles: HashSet::new(),
            have: HashSet::new(),
            downloaded: library::downloaded(),
            song_plays: HashMap::new(),
            colours,
            albums: library::read(),
            covers: HashMap::new(),
            side: wall().1,
            top: None,
            corner: mp_ui::shape::corner_radius(),
            query: String::new(),
            web_query: String::new(),
            typing: None,
            words_pic: None,
            wall_bar: 0.0,
            view: View::Both,
            sort: Sort::Added,
            descending: Sort::Added.descending(),
            status: None,
            files: None,
            open: None,
            cells: [Rectangle::default(); CELLS],
            window: Rectangle::default(),
            hovered: None,
        };
        let bare: Vec<(String, String)> = library.albums.iter().filter(|a| a.cover.is_none() && !a.group.is_empty()).map(|a| (a.key.clone(), a.group.clone())).collect();
        let tasks = bare.into_iter().filter(|(key, _)| library.covering.insert(key.clone())).map(|(key, group)| off(move || web::cover(&group, 1200), move |path| Message::Cover(key.clone(), path.flatten())));
        let mut tasks: Vec<Task<Message>> = tasks.collect();
        let wanted: Vec<_> = library.albums.iter().filter_map(|a| Some((a.key.clone(), a.cover.clone()?))).collect();
        let side = library.side;
        tasks.push(off(move || read_covers(wanted, side as u32), |c| Message::Covers(c.unwrap_or_default())));
        tasks.push(library.faces());
        (library, Task::batch(tasks))
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        let task = self.handle(message);
        self.mend_tab();
        self.turn_words();
        Task::batch([task, self.settle()])
    }

    fn handle(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Bus(call) => return self.call(call),
            // As Esc short of shutting the box: nothing of Music's holds the drawer, nor
            // sits over the panel it slid to.
            Message::Away => {
                (self.open, self.naming) = (None, None);
                let unfocus = iced::advanced::widget::operate(iced::advanced::widget::operation::focusable::unfocus());
                return unfocus.chain(self.ask_focus());
            }
            Message::Drawer(event) => return self.drawer_event(event),
            Message::Cell(i, at) => self.cells[i] = at,
            Message::Window(at) => self.window = at,
            Message::WallBar(at) => self.wall_bar = at.height,
            Message::OpenSearch => {
                let id = field_id(Field::Wall);
                return operation::focus(id.clone()).chain(operation::is_focused(id).map(|on| Message::Focused(Field::Wall, on)));
            }
            Message::Covers(covers) => {
                self.covers.extend(covers);
                // A playlist's first song's picture may have just come.
                return Task::batch([self.cut_art(), self.cut_song_art()]);
            }
            Message::Bar(i) => self.open = Some([Menu::View, Menu::Sort, Menu::Filter, Menu::New][i]),
            Message::PageBar(i) => self.open = Some(if i == page::RATING { Menu::Rating } else { Menu::Status }),
            Message::PageCell(i, at) => self.page_cells[i] = at,
            Message::Room(at) => self.room = at,
            Message::Player(i) => self.press_player(i),
            Message::Wheel(delta) => self.wheel(delta),
            Message::Volume(v) => self.set_volume(v),
            Message::Mute => self.mute(),
            Message::ToWall => {
                (self.left, self.forward) = (true, false);
                self.open = None;
            }
            Message::CoverMenu => {
                self.menu_at = drop::pointer() - Vector::new(self.window.x, self.window.y);
                self.open = Some(Menu::Cover);
            }
            Message::Words(key, words) => _ = self.words.insert(key, words),
            Message::RowPics(pics) => self.row_pics.extend(pics),
            Message::Scrolled(y, end) => {
                self.scrolled = y;
                if end {
                    self.more_rows();
                    return self.want_row_pics();
                }
            }
            Message::Art(key, picture) => {
                self.art_busy = false;
                self.art = Some(Art { key, picture });
                // The page may have moved on meanwhile.
                return self.cut_art();
            }
            Message::SongArt(key, picture) => {
                self.song_art_busy = false;
                self.song_art = Some(Art { key, picture });
                // The song may have moved on meanwhile.
                return self.cut_song_art();
            }
            Message::Fetched(id, found) => {
                self.asking.remove(&id);
                match found {
                    Some(r) => _ = self.releases.insert(id.clone(), r),
                    // No answer and none kept: the songs on this PC, if any.
                    None if !self.releases.contains_key(&id) => {
                        if let Some(a) = self.albums.iter().find(|a| a.release == id && !a.songs.is_empty()) {
                            self.releases.insert(id.clone(), release::from_files(a));
                        }
                    }
                    None => {}
                }
                if self.open_album().is_some_and(|a| a.release == id) {
                    return Task::batch([self.look_album(), self.look_extras(true)]);
                }
            }
            Message::Rate(n) => {
                self.open = None;
                if let Some(a) = self.open_album_mut() {
                    // Picking the current one again clears it (Windows' `clearable`).
                    a.rating = if a.rating == n { 0 } else { n };
                    library::save(a);
                }
            }
            Message::Mark(s) => {
                self.open = None;
                if let Some(a) = self.open_album_mut() {
                    a.status = if a.status == Some(s) { None } else { Some(s) };
                    library::save(a);
                }
            }
            // Every song in order, those not on this PC off the internet (his pick).
            Message::PlayAlbum => {
                let songs = self.open_album().map(|a| self.album_songs(a)).unwrap_or_default();
                if !songs.is_empty() {
                    return self.play(songs, 0);
                }
            }
            Message::Song(i) => {
                let songs = self.open_album().map(|a| self.album_songs(a)).unwrap_or_default();
                let Some(key) = songs.get(i) else { return Task::none() };
                if self.now.song.as_ref() == Some(key) {
                    now::send(now::Command::Toggle);
                } else {
                    return self.play(songs, i);
                }
            }
            Message::Address(key, (link, address)) => {
                self.looking.remove(&key);
                let mut key = key;
                let mut tasks = Vec::new();
                if let Some(url) = &link {
                    if playlist::is_named(&key) {
                        // A playlist's name-only row: its link goes in its row.
                        self.found_named(&key, url);
                        // The player may hold it in the list playing.
                        library::named(key, url.clone(), address.clone().unwrap_or_default());
                        key = url.clone();
                        tasks.push(self.faces());
                    } else {
                        library::link(&key, url);
                        self.links = library::links();
                    }
                }
                match address {
                    Some(a) => _ = self.addresses.insert(key.clone(), a),
                    // None, with a link too (its video went: seven were asked again on
                    // every page shown, 2026-11-05, 256 times in 3 hours): not looked up
                    // ahead again while the strip runs; a play still asks (the player).
                    None => _ = self.unfound.insert(key.clone(), Instant::now()),
                }
                // Songs sent to the queue may have waited for this one; a row's picture
                // may come with its link.
                self.flush_send();
                tasks.push(self.look());
                tasks.push(self.want_row_pics());
                if let Some((songs, at)) = self.pending.take_if(|(songs, at)| songs[*at] == key) {
                    tasks.push(self.play(songs, at));
                }
                return Task::batch(tasks);
            }
            // Just that song (his pick); from this PC once it is downloaded.
            Message::Tube(v) => {
                let key = if self.have.contains(&v.id) { download::single_key(&v) } else { web::watch(&v.id) };
                if self.now.song.as_ref() == Some(&key) || self.now.link.as_ref() == Some(&key) {
                    now::send(now::Command::Toggle);
                } else {
                    return self.play(vec![key], 0);
                }
            }
            Message::Single(v) => {
                if !self.have.contains(&v.id) && self.singles.insert(v.id.clone()) {
                    let id = v.id.clone();
                    return off(move || download::single(&v), move |key| Message::Downloaded(id.clone(), key.flatten()));
                }
            }
            Message::Downloaded(id, key) => {
                self.singles.remove(&id);
                if let Some(key) = key {
                    library::link(&key, &web::watch(&id));
                    self.links = library::links();
                    self.have.insert(id);
                    self.downloaded = library::downloaded();
                    // A playlist's link row may now play from this PC.
                    self.playlists = library::playlists(&self.links);
                }
            }
            Message::Playlist(name) => return self.go(name.map_or(Place::Downloaded, Place::Playlist)),
            Message::PlayPlaylist(name) => {
                let songs = self.playlist_songs(name.as_deref());
                if !songs.is_empty() {
                    return self.play(songs, 0);
                }
            }
            Message::PlaylistSong(i) => return self.playlist_song(i),
            Message::View(v) => {
                self.view = v;
                self.open = None;
            }
            Message::NewPlaylist => {
                self.open = None;
                return self.new_playlist(Vec::new());
            }
            Message::SongMenu(t) => {
                self.target = Some(t);
                self.menu_at = drop::pointer() - Vector::new(self.window.x, self.window.y);
                self.open = Some(Menu::Song);
            }
            Message::SaveMenu(t, cell) => {
                self.target = Some(t);
                self.open = Some(Menu::Save(cell));
            }
            Message::Save(name) => {
                self.open = None;
                return self.save_to(&name);
            }
            Message::SaveNew => {
                self.open = None;
                return self.save_new();
            }
            // Made on the first save (Windows'), then saved as any playlist's row.
            Message::Heart => {
                self.open = None;
                if !self.playlists.iter().any(playlist::is_saved) {
                    if let Err(e) = library::new_playlist(playlist::SAVED) {
                        eprintln!("mp-shell: music: making {}: {e}", playlist::SAVED);
                        return Task::none();
                    }
                    self.playlists = library::playlists(&self.links);
                }
                return self.save_to(playlist::SAVED);
            }
            Message::Unlist(i) => {
                self.open = None;
                return self.unlist(i);
            }
            Message::Send(t) => {
                self.open = None;
                return self.send(&t);
            }
            Message::Lift(h) => {
                self.held = Some(h);
                self.open = None;
            }
            Message::MoveTile(from, to) => {
                self.held = None;
                self.move_tile(from, to);
            }
            Message::MoveRow(from, to) => {
                self.held = None;
                return self.move_row(from, to);
            }
            Message::Name => {
                if let Some(name) = self.open_own().map(|p| p.name.clone()) {
                    return self.start_naming(name);
                }
            }
            Message::Naming(typed) => self.naming = Some(typed),
            Message::NameFocused(on) => {
                if on {
                    self.naming_seen = true;
                } else if self.naming_seen {
                    // A click off the box: the name stays as it was.
                    self.naming = None;
                }
            }
            Message::Rename => return self.rename(),
            Message::Picture => {
                let Some(name) = self.open_own().map(|p| p.name.clone()) else { return Task::none() };
                if !std::mem::replace(&mut self.picking, true) {
                    let pick = || mp_ui::portal::open("Choose a picture", Some(("Pictures", &["image/jpeg", "image/png"])), false).pop();
                    return off(pick, move |path| Message::Pictured(name.clone(), path.flatten()));
                }
            }
            Message::Pictured(name, path) => {
                self.picking = false;
                if let Some(path) = path {
                    match library::set_cover(&name, &path) {
                        Ok(_) => {
                            self.forget_face(&name);
                            self.playlists = library::playlists(&self.links);
                            return Task::batch([self.faces(), self.cut_art()]);
                        }
                        Err(e) => eprintln!("mp-shell: music: a picture for {name}: {e}"),
                    }
                }
            }
            Message::Import => {
                self.open = None;
                if !std::mem::replace(&mut self.picking, true) {
                    let pick = || mp_ui::portal::open("Import a playlist", Some(("Playlists", &["text/csv", "text/plain"])), false).pop();
                    return off(pick, |path| Message::Imported(path.flatten()));
                }
            }
            Message::Imported(path) => {
                self.picking = false;
                if let Some(path) = path {
                    return self.import(&path);
                }
            }
            Message::DownloadPlaylist => return self.download_playlist(),
            Message::UninstallPlaylist => self.uninstall_playlist(),
            Message::DeletePlaylist => {
                let Some(name) = self.open_own().map(|p| p.name.clone()) else { return Task::none() };
                if let Err(e) = library::delete_playlist(&name) {
                    eprintln!("mp-shell: music: deleting {name}: {e}");
                    return Task::none();
                }
                self.forget_face(&name);
                self.playlists.retain(|p| p.name != name);
                self.open = None;
                (self.place, self.aside, self.left) = (Place::Home, Place::Home, true);
                return self.arrive();
            }
            Message::Colours => {
                // mp-theme wrote new colours: the pictures are drawn in them too.
                self.colours = colours::load();
                self.pictures = Pictures::new(&self.colours);
                self.page_pictures = page::Pictures::new(&self.colours);
                self.words_pic = None;
            }
            Message::Now(now) => {
                let (song, words) = (now.song != self.now.song, words::key(&now) != words::key(&self.now));
                self.now = now;
                let mut tasks = Vec::new();
                // A song left may have added a listen: the numbers and plays again.
                if song {
                    if let Some(key) = self.selected().cloned() {
                        self.plays = library::plays(&key);
                    }
                    if matches!(self.place, Place::Downloaded | Place::Playlist(_)) {
                        self.song_plays = library::song_plays();
                    }
                    self.count();
                }
                if words {
                    // Words that could not be fetched (the internet dropped) are asked
                    // for again each time their song starts.
                    let key = words::key(&self.now);
                    if matches!(self.words.get(&key), Some(words::Words::Failed)) {
                        self.words.remove(&key);
                    }
                    tasks.push(self.want_words());
                }
                if song {
                    tasks.push(self.cut_song_art());
                    tasks.push(self.look_next());
                }
                return Task::batch(tasks);
            }
            Message::Query(Field::Wall, q) => self.query = q,
            Message::Query(Field::Web, q) => return self.typed(q),
            // A click off a box lets go of the keys (the box does that itself) and
            // keeps its words: with none, the same as Esc (his call 2026-10-31).
            Message::Pressed(captured) => {
                // While you type the surface spans the screen, while a menu shows the whole
                // surface takes the pointer: a click on nothing there shuts the menu, else
                // (typing, off the box) the box (a press on a menu row or its click-off
                // layer is taken by them).
                if !captured
                    && self.open.take().is_none()
                    && let Some(t) = self.top.as_mut().filter(|t| t.full && !t.over)
                {
                    t.shut = true;
                }
                return self.ask_focus();
            }
            Message::Focused(f, on) => {
                if on {
                    self.typing = Some(f);
                } else if self.typing == Some(f) {
                    self.typing = None;
                }
            }
            Message::Escape => {
                // Esc shuts an open menu, then a playlist's name (it stays as it was), then
                // the box (his pick), what you typed with it. A text box lets go of the keys
                // on Esc itself.
                if self.open.take().is_none()
                    && self.naming.take().is_none()
                    && let Some(t) = &mut self.top
                {
                    t.shut = true;
                }
                return self.ask_focus();
            }
            Message::Paused(n) => return self.paused(n),
            Message::Albums(n, found) => return self.got_albums(n, found),
            Message::Artists(n, found) => return self.got_artists(n, found),
            Message::Songs(n, found) => return self.got_songs(n, found),
            Message::Group(g) => return self.open_group(g),
            Message::Artist(a) => return self.go(Place::Artist(a.id, a.name)),
            Message::Groups(id, found) => {
                let Some(artist) = self.artist.as_mut().filter(|a| a.id == id) else { return Task::none() };
                artist.groups = found.into();
                return self.want_covers();
            }
            Message::Thumb(id, cut) => {
                self.thumbs_busy = self.thumbs_busy.saturating_sub(1);
                if let Some(cut) = cut {
                    self.thumbs.insert(id, cut);
                }
                return self.thumbs();
            }
            Message::Tab(tab) => {
                self.tab = tab;
                self.open = None;
                self.scrolled = 0.0;
                // The search pill: its box takes the keys at once.
                if tab == page::Tab::Search {
                    let id = field_id(Field::Web);
                    return operation::focus(id.clone()).chain(operation::is_focused(id).map(|on| Message::Focused(Field::Web, on)));
                }
                let snap = operation::snap_to(box_scroll(), scrollable::RelativeOffset::START);
                return Task::batch([snap, if tab == page::Tab::Discography { self.look_discography() } else { self.want_covers() }]);
            }
            Message::Discography(id, found) => {
                self.asking.remove(&format!("{DISCOGRAPHY}{id}"));
                let Some(shown) = self.discography.as_mut().filter(|d| d.id == id) else { return Task::none() };
                // No answer: what was kept stays.
                if found.is_some() || !matches!(shown.groups, Found::Got(_)) {
                    shown.groups = found.into();
                }
                return self.want_covers();
            }
            Message::Photo(id, photo) => _ = self.photos.insert(id, photo),
            Message::World(plays) => self.world.extend(plays),
            Message::Picked(key, found) => {
                self.asking.remove(&key);
                if let Some((id, songs)) = found {
                    if let Some(a) = self.web.get_mut(&key) {
                        a.release = id.clone();
                    }
                    if let Some(songs) = songs {
                        self.releases.insert(id, songs);
                    }
                }
                if self.selected() == Some(&key) {
                    return Task::batch([self.look_album(), self.look_extras(true)]);
                }
            }
            Message::Cover(key, path) => {
                self.covering.remove(&key);
                if let Some(a) = self.web.get_mut(&key) {
                    a.cover = path;
                } else if let Some(a) = self.albums.iter_mut().find(|a| a.key == key)
                    && let Some(kept) = path.and_then(|p| library::keep_cover(a, &p))
                {
                    // One of yours that had none: kept in its folder, cut for the wall.
                    a.cover = Some(kept.clone());
                    let side = self.side;
                    return Task::batch([self.cut_art(), self.cut_song_art(), off(move || read_covers(vec![(key, kept)], side as u32), move |c| Message::Covers(c.unwrap_or_default()))]);
                }
                return Task::batch([self.cut_art(), self.cut_song_art()]);
            }
            Message::Add => return self.add(),
            Message::Download => return self.download(),
            Message::Remove => return self.remove(),
            Message::Uninstall => self.uninstall(),
            // Followed by the downloading one's key, which a playlist's rename moves.
            Message::Got(download::Event::Song(got)) => {
                let Some(f) = self.loading.as_mut() else { return Task::none() };
                f.done += 1;
                f.got += usize::from(got.is_some());
                let key = f.key.clone();
                if let Some((song, url)) = got {
                    library::link(&song, &url);
                    self.links = library::links();
                    if let Some(name) = key.strip_prefix('/') {
                        return self.playlist_got(name, &song, &url);
                    }
                    if let Some(a) = self.albums.iter_mut().find(|a| a.key == key) {
                        a.songs.push(song);
                        a.songs.sort();
                    }
                }
            }
            Message::Got(download::Event::End) => {
                // Not one song came: "Failed — Retry" until the next press (Windows').
                if let Some(f) = self.loading.take() {
                    if f.got == 0 {
                        self.failed.insert(f.key);
                    } else {
                        self.failed.remove(&f.key);
                    }
                }
                return self.start();
            }
            // The mouse's Back slides to the main page, its Forward back to the page that
            // left (his ask, chat 58).
            Message::Back => {
                self.forward = self.left;
                (self.left, self.open) = (false, None);
            }
            Message::Forward => {
                if std::mem::take(&mut self.forward) {
                    (self.left, self.open) = (true, None);
                }
            }
            Message::Sort(s) => {
                // Picking the current one again flips it; Custom has no direction.
                self.descending = if s == self.sort && s != Sort::Custom { !self.descending } else { s.descending() };
                self.sort = s;
                self.open = None;
            }
            Message::Status(s) => {
                self.status = if self.status == Some(s) { None } else { Some(s) };
                self.open = None;
            }
            Message::Files(on) => {
                self.files = if self.files == Some(on) { None } else { Some(on) };
                self.open = None;
            }
            Message::Close => self.open = None,
            // Held to drag, the tile keeps the hover it lifted with (Windows').
            Message::Hover(..) if self.held.is_some() => {}
            Message::Hover(key, true) => self.hovered = Some(key),
            Message::Hover(key, false) => {
                if self.hovered.as_ref() == Some(&key) {
                    self.hovered = None;
                }
            }
            Message::Select(key) => return self.go(Place::Album(key)),
            // As Play Album: every song, from its saved list when its page wasn't opened.
            Message::Play(key) => {
                let Some(a) = self.albums.iter().find(|a| a.key == key) else { return Task::none() };
                if !a.release.is_empty()
                    && !self.releases.contains_key(&a.release)
                    && let Some(r) = release::saved(&a.release)
                {
                    self.releases.insert(a.release.clone(), r);
                }
                let songs = self.album_songs(a);
                return self.play(songs, 0);
            }
            // The layer's own asks, which the runtime takes before they get here.
            _ => {}
        }
        Task::none()
    }

    /// The shortcut and the top bar's page buttons. One drawer at a time.
    fn call(&mut self, call: bus::Call) -> Task<Message> {
        let hold = self.hold();
        match call {
            bus::Call::Key => match &mut self.top {
                Some(t) if t.open(hold) => t.shut = true,
                // Closing: opened again, as by the key.
                Some(t) => (t.key, t.entered, t.shut) = (true, false, false),
                None => return Task::batch([self.open_top(crate::niri::focused_output(), true), self.open_on()]),
            },
            bus::Call::Open(output) => match &mut self.top {
                Some(t) if t.open(hold) => {}
                Some(t) => (t.key, t.entered, t.shut) = (true, false, false),
                None => return Task::batch([self.open_top(Some(output), true), self.open_on()]),
            },
        }
        Task::none()
    }

    /// The box, made on each open: one surface the box's size and its two curves, hung
    /// under the frame's top band in the middle of the screen (`output`, else niri's
    /// active one: the mouse's). By the key it holds the keyboard, for Esc.
    fn open_top(&mut self, output: Option<String>, key: bool) -> Task<Message> {
        let id = window::Id::unique();
        *OPEN.lock().unwrap() = Some(id);
        let output_option = output.clone().map_or(OutputOption::Active, OutputOption::OutputName);
        self.top = Some(Top { id, key, entered: false, over: false, shut: false, exclusive: key, full: false, whole: false, hit: None });
        let settings = NewLayerShellSettings {
            anchor: Anchor::Top,
            layer: Layer::Top,
            // Kept clear of the strip's reserved edge, so centred on the rest, as the
            // shell's hover zone.
            exclusive_zone: Some(0),
            size: self.surface(),
            margin: Some(Margin { top: GAP_2 as i32, ..Default::default() }),
            keyboard_interactivity: if key { KeyboardInteractivity::Exclusive } else { KeyboardInteractivity::None },
            output_option,
            namespace: Some("mp-shell-music".into()),
            ..Default::default()
        };
        Task::done(Message::NewLayerShell { settings, id })
    }

    /// The box's surface: the box and a corner each side for its curves.
    fn surface(&self) -> LayerSize {
        let c = content();
        LayerSize::px((c.width + 2.0 * (MENU_PAD + self.corner.round())) as u32, (c.height + 2.0 * MENU_PAD) as u32)
    }

    fn drawer_event(&mut self, event: drawer::Event) -> Task<Message> {
        let hold = self.hold();
        let Some(t) = &mut self.top else { return Task::none() };
        match event {
            drawer::Event::Hover(on) => {
                t.over = on;
                t.entered |= on;
            }
            drawer::Event::Hit(hit) => {
                t.hit = Some(hit);
                if !t.whole {
                    return input_region(t.id, hit);
                }
            }
            drawer::Event::Closed if !t.open(hold) => return self.drop_top(),
            drawer::Event::Closed => {}
        }
        Task::none()
    }

    /// Shut: the surface goes, and what you typed with it (it opens fresh).
    fn drop_top(&mut self) -> Task<Message> {
        let Some(t) = self.top.take() else { return Task::none() };
        *OPEN.lock().unwrap() = None;
        let shown = match &self.place {
            Place::Album(key) => Some(key.clone()),
            Place::Playlist(name) => Some(playlist::tile_key(name)),
            Place::Downloaded => Some(playlist::NAME.to_string()),
            _ => None,
        };
        // The search goes with the box: the record's own tab next time.
        if self.tab == page::Tab::Search {
            self.tab = if self.shows_playing() { page::Tab::Lyrics } else { page::Tab::Tracks };
        }
        if let Some(key) = shown {
            library::save_shown(&key, &format!("{:?}", self.tab));
        }
        (self.open, self.typing, self.naming, self.hovered) = (None, None, None, None);
        self.query.clear();
        self.web_query.clear();
        self.forget_search();
        window::close(t.id)
    }

    /// A text box has your typing (the desktop's Open window over it lets go).
    fn typing_held(&self) -> bool {
        (self.typing.is_some() || self.naming.is_some()) && !self.picking
    }

    /// What keeps the box open whatever the pointer does: your typing, the desktop's
    /// Open window, which sits over the screen while you pick, a menu.
    fn hold(&self) -> bool {
        self.typing_held() || self.picking || self.open.is_some()
    }

    /// Asks which text box has the keys (after a click or Esc).
    fn ask_focus(&self) -> Task<Message> {
        let mut asks: Vec<Task<Message>> = [Field::Wall, Field::Web].into_iter().map(|f| operation::is_focused(field_id(f)).map(move |on| Message::Focused(f, on))).collect();
        if self.naming.is_some() {
            asks.push(operation::is_focused(playlist::name_id()).map(Message::NameFocused));
        }
        Task::batch(asks)
    }

    /// After every change: the surface follows what the box needs. While you type it holds the keyboard (niri hands an
    /// on-demand layer's keys to whatever the pointer crosses: `handle_focus_follows_
    /// mouse`, niri 26.04) and spans the screen, see-through, so a click outside the box
    /// lands on it and shuts it (with the keys held, niri tells no one of a click on a
    /// window). By the shortcut it holds the keyboard until the pointer comes in.
    fn settle(&mut self) -> Task<Message> {
        // A menu holds the keys too (Esc) and the whole surface takes the pointer (its
        // rows, a click round the box shuts it), but only your typing spans
        // the screen: a menu fits the surface and stays while the pointer is away (his call
        // 2026-11-03), and a size change that moves the surface's corner flashes the old
        // picture there.
        let keys = self.typing_held() || self.open.is_some();
        let (typing, surface, picking) = (self.typing_held(), self.surface(), self.picking);
        let Some(t) = &mut self.top else { return Task::none() };
        let mut tasks = Vec::new();
        let exclusive = keys || (t.key && !t.entered && !picking);
        if exclusive != t.exclusive {
            t.exclusive = exclusive;
            let keyboard_interactivity = if exclusive { KeyboardInteractivity::Exclusive } else { KeyboardInteractivity::None };
            tasks.push(Task::done(Message::KeyboardInteractivityChange { id: t.id, keyboard_interactivity }));
        }
        if typing != t.full {
            t.full = typing;
            let (anchor, size) = if typing { (Anchor::Top | Anchor::Bottom | Anchor::Left | Anchor::Right, LayerSize::FILL) } else { (Anchor::Top, surface) };
            tasks.push(Task::done(Message::LayoutChange { id: t.id, anchor, size }));
        }
        if keys != t.whole {
            t.whole = keys;
            let whole = Rectangle::new(Point::ORIGIN, iced::Size::new(100_000.0, 100_000.0));
            if let Some(hit) = if keys { Some(whole) } else { t.hit } {
                tasks.push(input_region(t.id, hit));
            }
        }
        Task::batch(tasks)
    }

    /// Each open: the main page on the record it showed when the box closed (his ask,
    /// chat 58: it went "back to saved tracks instead of the playlist/album/song i was
    /// on"; kept while the program runs, saved for a restart) and its big box's tab (his
    /// ask: "it goes back to lyrics even though before i closed it i was on tracks"), else
    /// (none, or it has gone) on the playing song's album, else the record played last,
    /// else nothing (his Decision "Opens on"); the numbers counted again, the playing
    /// song's words asked for.
    fn open_on(&mut self) -> Task<Message> {
        self.count();
        let kept = (!matches!(self.showing(), main_page::Shown::Nothing)).then_some(self.tab);
        if kept.is_none() {
            let playing = self.now.song.as_ref().and_then(|s| s.rsplit_once('/')).map(|(dir, _)| dir.to_string()).filter(|d| self.albums.iter().any(|a| &a.key == d) || self.web.contains_key(d));
            let last = || self.stats.last.as_deref().map(place_of);
            self.place = playing.map(Place::Album).or_else(last).unwrap_or(Place::Home);
        }
        (self.left, self.forward) = (false, false);
        let arrive = self.arrive();
        if let Some(tab) = kept.filter(|t| *t != page::Tab::Search && self.usable(*t)) {
            self.tab = tab;
        }
        Task::batch([arrive, self.look_discography(), self.want_words()])
    }

    /// The playing song's words, once per song while the box is open, whatever the tab:
    /// whether it has any greys Lyrics out (his ask 2026-11-06).
    fn want_words(&mut self) -> Task<Message> {
        if self.top.is_none() || !self.now.loaded() {
            return Task::none();
        }
        let key = words::key(&self.now);
        if self.words.contains_key(&key) {
            return Task::none();
        }
        self.words.insert(key.clone(), words::Words::Finding);
        let now = self.now.clone();
        off(move || words::fetch(now), move |w| Message::Words(key.clone(), w.unwrap_or(words::Words::Failed)))
    }

    /// Shows `place`: a record on the main page, a list (Home, the search's, an
    /// artist's) on the left page.
    fn go(&mut self, place: Place) -> Task<Message> {
        self.forward = false;
        match place {
            Place::Album(_) | Place::Playlist(_) | Place::Downloaded => {
                (self.place, self.left) = (place, false);
                self.arrive()
            }
            _ => {
                (self.aside, self.left) = (place, true);
                self.arrive_aside()
            }
        }
    }

    /// Loads what the record shown needs; the big box opens on Lyrics when it holds the
    /// playing song (and it has words: `mend_tab`), else on Tracks.
    fn arrive(&mut self) -> Task<Message> {
        // A row held on the page left goes with it.
        if matches!(self.held, Some(Held::Row(_))) {
            self.held = None;
        }
        self.open = None;
        self.naming = None;
        self.scrolled = 0.0;
        self.built = playlist::ROWS;
        let snap = operation::snap_to(box_scroll(), scrollable::RelativeOffset::START);
        let load = match self.place.clone() {
            Place::Album(key) => self.load_album(key),
            Place::Downloaded => {
                self.downloaded = library::downloaded();
                self.song_plays = library::song_plays();
                self.want_row_pics()
            }
            Place::Playlist(_) => {
                self.playlists = library::playlists(&self.links);
                self.song_plays = library::song_plays();
                Task::batch([self.look_playlist(), self.faces(), self.cut_art(), self.want_row_pics()])
            }
            _ => Task::none(),
        };
        self.tab = if self.shows_playing() { page::Tab::Lyrics } else { page::Tab::Tracks };
        Task::batch([snap, load, self.want_words(), self.want_covers()])
    }

    /// Loads what the left page shows.
    fn arrive_aside(&mut self) -> Task<Message> {
        self.open = None;
        match self.aside.clone() {
            Place::Home => Task::none(),
            Place::Artist(id, _) if self.artist.as_ref().is_none_or(|a| a.id != id) => {
                self.thumbs.clear();
                self.artist = Some(ArtistPage { id: id.clone(), groups: Found::Loading });
                let ask = id.clone();
                let tasks = [self.want_covers(), off(move || web::artist_groups(&ask), move |found| Message::Groups(id.clone(), found.flatten()))];
                Task::batch(tasks)
            }
            _ => self.want_covers(),
        }
    }

    /// Fetches the covers the place shown lacks, the first next, and no others: leaving
    /// a long Discography stops its covers.
    fn want_covers(&mut self) -> Task<Message> {
        let shown = match (&self.aside, &self.place, self.tab) {
            (Place::Artist(..), _, _) if self.left => self.artist.as_ref(),
            (_, Place::Album(_), page::Tab::Discography) if !self.left => self.discography.as_ref(),
            _ => None,
        };
        let wanted: Vec<&Group> = match shown.map(|s| &s.groups) {
            Some(Found::Got(groups)) => groups.iter().collect(),
            _ => Vec::new(),
        };
        self.thumb_queue = wanted.into_iter().rev().filter(|g| !self.thumbs.contains_key(&g.id)).map(|g| g.id.clone()).collect();
        self.thumbs()
    }

    /// The Discography tab, when it shows and its artist is known: the list kept at once
    /// and a fresh look behind it on each pick (his rule).
    fn look_discography(&mut self) -> Task<Message> {
        if self.tab != page::Tab::Discography {
            return Task::none();
        }
        let Some(id) = self.open_album().and_then(|a| self.release(a)).and_then(page::lead_artist).map(|p| p.id.clone()) else { return Task::none() };
        if self.discography.as_ref().is_none_or(|d| d.id != id) {
            self.thumbs.clear();
            self.discography = Some(ArtistPage { id: id.clone(), groups: web::saved_discography(&id).map_or(Found::Loading, Found::Got) });
        }
        let mut tasks = vec![self.want_covers()];
        if self.asking.insert(format!("{DISCOGRAPHY}{id}")) {
            let ask = id.clone();
            tasks.push(off(move || web::discography(&ask), move |found| Message::Discography(id.clone(), found.flatten())));
        }
        Task::batch(tasks)
    }

    /// What an album's page shows beside its songs, once its list is in: the artist's
    /// photo (asked once), the Discography if it is picked, and with a `fresh` list the
    /// songs' Spotify plays (one ask each visit; saved ones show until it answers).
    fn look_extras(&mut self, fresh: bool) -> Task<Message> {
        let Some(a) = self.open_album() else { return Task::none() };
        let Some(r) = self.release(a) else { return Task::none() };
        let lead = page::lead_artist(r).map(|p| (p.id.clone(), p.name.clone()));
        let songs: Vec<(String, String)> = r.tracks.iter().filter(|t| !t.recording.is_empty()).map(|t| (t.recording.clone(), t.title.clone())).collect();
        let id = a.release.clone();
        let mut tasks = vec![self.look_discography()];
        if let Some(lead) = lead.as_ref().map(|l| l.0.clone()).filter(|l| !self.photos.contains_key(l)) {
            self.photos.insert(lead.clone(), None);
            let ask = lead.clone();
            tasks.push(off(move || cover::square_file(&std::fs::read(web::photo(&ask)?).ok()?, ICON, ICON as f32 / 2.0), move |photo| Message::Photo(lead.clone(), photo.flatten())));
        }
        if !fresh {
            self.world.extend(release::saved_plays(&id));
        } else if let Some((artist, name)) = lead.filter(|_| !songs.is_empty()) {
            tasks.push(off(move || release::fetch_plays(&id, &artist, &name, &songs), |plays| Message::World(plays.flatten().unwrap_or_default())));
        }
        Task::batch(tasks)
    }

    /// An album's page: its plays, its saved song list at once and a fresh ask
    /// behind it, its cover cut for the page. An internet album's release is picked
    /// first, and its cover fetched.
    fn load_album(&mut self, key: String) -> Task<Message> {
        let Some(a) = self.open_album() else { return Task::none() };
        let web = self.is_web(a);
        let (release, group, has_cover) = (a.release.clone(), a.group.clone(), a.cover.is_some());
        let files = (release.is_empty() && !web).then(|| release::from_files(a));
        let mut tasks = Vec::new();
        self.plays = library::plays(&key);
        if let Some(files) = files {
            self.releases.insert(key.clone(), files);
        } else if release.is_empty() {
            if self.asking.insert(key.clone()) {
                let (k, g) = (key.clone(), group.clone());
                let pick = move || {
                    let id = web::pick_release(&g)?;
                    let songs = release::fetch(&id);
                    Some((id, songs))
                };
                tasks.push(off(pick, move |found| Message::Picked(k.clone(), found.flatten())));
            }
        } else {
            if !self.releases.contains_key(&release)
                && let Some(r) = release::saved(&release)
            {
                self.releases.insert(release.clone(), r);
            }
            if self.asking.insert(release.clone()) {
                let ask = release.clone();
                tasks.push(off(move || release::fetch(&ask), move |r| Message::Fetched(release.clone(), r.flatten())));
            }
        }
        if web && !has_cover && self.covering.insert(key.clone()) {
            tasks.push(off(move || web::cover(&group, 1200), move |path| Message::Cover(key.clone(), path.flatten())));
        }
        tasks.push(self.cut_art());
        tasks.push(self.look_album());
        tasks.push(self.look_extras(false));
        Task::batch(tasks)
    }

    /// Types a new name for the open playlist, the old one picked so typing
    /// replaces it.
    fn start_naming(&mut self, name: String) -> Task<Message> {
        self.naming = Some(name);
        self.naming_seen = false;
        Task::batch([operation::focus(playlist::name_id()), operation::select_all(playlist::name_id())])
    }

    /// Enter in a playlist's name: renamed, file and picture (the page and Back
    /// follow it); a name taken stays to be changed; nothing typed leaves it.
    fn rename(&mut self) -> Task<Message> {
        let (Some(typed), Some(old)) = (self.naming.clone(), self.open_playlist().map(|p| p.name.clone())) else { return Task::none() };
        if typed.trim().is_empty() {
            self.naming = None;
            return Task::none();
        }
        match library::rename_playlist(&old, typed.trim()) {
            Ok(new) => {
                self.naming = None;
                if new != old {
                    let (was, now) = (playlist::tile_key(&old), playlist::tile_key(&new));
                    if let Some(k) = self.custom.iter_mut().find(|k| **k == was) {
                        *k = now.clone();
                        library::save_order(&self.custom);
                    }
                    // Its download, waiting or under way, follows it.
                    if let Some(f) = self.loading.as_mut().filter(|f| f.key == was) {
                        f.key = now.clone();
                    }
                    for k in self.queue.iter_mut().filter(|k| **k == was) {
                        *k = now.clone();
                    }
                    if self.failed.remove(&was) {
                        self.failed.insert(now);
                    }
                    self.forget_face(&old);
                    self.playlists = library::playlists(&self.links);
                    if self.place == Place::Playlist(old) {
                        self.place = Place::Playlist(new.clone());
                    }
                    return Task::batch([self.faces(), self.cut_art()]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => {
                eprintln!("mp-shell: music: renaming {old}: {e}");
                self.naming = None;
            }
        }
        Task::none()
    }

    /// Plays `songs` from `start`, handing over the addresses looked up ahead. When
    /// the first one's is still on its way, it plays once that is in (else the player
    /// looks it up again, or skips a song whose link isn't found yet), that look-up
    /// first.
    fn play(&mut self, songs: Vec<String>, start: usize) -> Task<Message> {
        let key = &songs[start];
        // A name-only row has no link for the player yet: found first (H1).
        if playlist::is_named(key)
            && !self.looking.contains(key)
            && !self.gone(key)
            && !self.looks.iter().any(|l| &l.key == key)
            && let Some(l) = self.named_look(key)
        {
            self.looks.push_front(l);
        }
        let queued = self.looks.iter().position(|l| &l.key == key);
        if queued.is_some() || self.looking.contains(key) {
            let task = queued.and_then(|i| self.looks.remove(i)).map_or_else(Task::none, |l| self.look_up(l));
            self.pending = Some((songs, start));
            return task;
        }
        self.pending = None;
        let found = self.addresses_of(&songs);
        library::play(songs, start as u32, found);
        Task::none()
    }

    /// A song whose look-up found nothing in the last hour: not looked up ahead again
    /// till then (a dropped internet no longer marks it for the strip's whole run).
    fn gone(&self, key: &str) -> bool {
        self.unfound.get(key).is_some_and(|at| at.elapsed() < Duration::from_secs(3600))
    }

    /// Each song's address looked up ahead and still fresh, "" for none: what the
    /// player is handed with a list.
    fn addresses_of(&self, songs: &[String]) -> Vec<String> {
        songs.iter().map(|k| self.addresses.get(k).filter(|a| web::fresh(a)).cloned().unwrap_or_default()).collect()
    }

    /// The song the pill rests on: the one about to play, else the one playing.
    pub fn playing(&self) -> Option<&String> {
        self.pending.as_ref().map(|(songs, at)| &songs[*at]).or(self.now.song.as_ref().filter(|_| self.now.playing))
    }

    /// Where a song plays from: a YouTube song's key is its link, else `sources`'.
    fn link_of(&self, key: &str) -> Option<String> {
        if key.starts_with("http") {
            return Some(key.into());
        }
        self.links.iter().find(|(k, _)| k == key).map(|(_, url)| url.clone())
    }

    /// The open album's songs not on this PC, looked up ahead (his pick): a link by
    /// Windows' pick rules for each one `sources` has none for (kept there), then its
    /// address.
    fn look_album(&mut self) -> Task<Message> {
        let Some(a) = self.open_album() else { return Task::none() };
        let Some(tracks) = self.release(a).map(|r| &r.tracks) else { return Task::none() };
        let keys = self.album_songs(a);
        let looks = tracks.iter().zip(keys).filter(|(_, k)| !a.songs.contains(k)).map(|(t, key)| Look { link: self.link_of(&key), find: Some((a.artist.clone(), t.clone())), key }).collect();
        self.look_ahead(looks)
    }

    /// The search's YouTube songs, looked up ahead (his pick).
    fn look_results(&mut self) -> Task<Message> {
        let Found::Got(list) = &self.results.songs else { return Task::none() };
        let looks = list.iter().filter(|v| !self.have.contains(&v.id)).map(|v| web::watch(&v.id)).map(|key| Look { link: Some(key.clone()), find: None, key }).collect();
        self.look_ahead(looks)
    }

    /// Looks up the page's songs in place of another page's still waiting (the song
    /// about to play and songs sent to the queue stay), but not those in, on their way
    /// or never found.
    fn look_ahead(&mut self, looks: Vec<Look>) -> Task<Message> {
        let pending = self.pending.as_ref().map(|(songs, at)| songs[*at].clone());
        self.looks.retain(|l| Some(&l.key) == pending.as_ref() || self.sending.contains(&l.key));
        let wanted = |l: &Look| !self.looking.contains(&l.key) && !self.gone(&l.key) && !self.addresses.get(&l.key).is_some_and(|a| web::fresh(a));
        let looks: Vec<Look> = looks.into_iter().filter(wanted).collect();
        self.looks.extend(looks);
        self.look()
    }

    /// Starts the next look-ups, a few at a time.
    fn look(&mut self) -> Task<Message> {
        let mut tasks = Vec::new();
        while self.looking.len() < AHEAD
            && let Some(l) = self.looks.pop_front()
        {
            tasks.push(self.look_up(l));
        }
        Task::batch(tasks)
    }

    fn look_up(&mut self, l: Look) -> Task<Message> {
        self.looking.insert(l.key.clone());
        let key = l.key.clone();
        let work = move || {
            let found = if l.link.is_some() { None } else { l.find.as_ref().and_then(|(artist, t)| download::find(artist, t)) };
            let address = found.as_ref().or(l.link.as_ref()).and_then(|link| web::address(link));
            (found, address)
        };
        off(work, move |r| Message::Address(key.clone(), r.unwrap_or_default()))
    }

    /// Opens a found album: yours when it is in your library (the same release
    /// group, or the same folder), else its page off the internet.
    fn open_group(&mut self, g: Group) -> Task<Message> {
        let key = format!("{}/{}", library::folder(&g.artist), library::folder(&g.title));
        if let Some(a) = self.albums.iter().find(|a| (!a.group.is_empty() && a.group == g.id) || a.key == key) {
            let key = a.key.clone();
            return self.go(Place::Album(key));
        }
        if !self.web.contains_key(&key) {
            let kept = web::cover_at(&g.id, 1200);
            let album =
                Album { key: key.clone(), artist: g.artist, title: g.title, status: None, rating: 0, year: g.year, added: SystemTime::now(), songs: Vec::new(), cover: kept.is_file().then_some(kept), release: String::new(), group: g.id };
            self.web.insert(key.clone(), album);
        }
        self.go(Place::Album(key))
    }

    /// Add to Library on an internet album's page, once its release and cover are
    /// in: the page turns into your album's, the wall shows it as Not Downloaded.
    fn add(&mut self) -> Task<Message> {
        let Some(a) = self.open_album().filter(|a| self.is_web(a)).cloned() else { return Task::none() };
        if self.asking.contains(&a.key) || self.covering.contains(&a.key) {
            return Task::none();
        }
        if let Err(e) = library::add(&a) {
            eprintln!("mp-shell: music: adding {}: {e}", a.key);
            return Task::none();
        }
        self.albums = library::read();
        let Some(cover) = self.albums.iter().find(|x| x.key == a.key).and_then(|x| x.cover.clone()) else { return Task::none() };
        let side = self.side;
        off(move || read_covers(vec![(a.key, cover)], side as u32), |c| Message::Covers(c.unwrap_or_default()))
    }

    /// The Download button (Windows' download part): on an album off the internet it
    /// adds it first (his pick); songs uninstalled earlier come back from the bin;
    /// the rest wait their turn.
    fn download(&mut self) -> Task<Message> {
        let Some(a) = self.open_album().cloned() else { return Task::none() };
        let mut tasks = Vec::new();
        if self.is_web(&a) {
            tasks.push(self.add());
            if self.is_web(&a) {
                // Its release or cover is still on its way (or adding failed).
                return Task::batch(tasks);
            }
        }
        if self.loading.as_ref().is_some_and(|f| f.key == a.key) || self.queue.contains(&a.key) {
            return Task::none();
        }
        // Songs uninstalled earlier come back from the bin first (his call).
        if self.missing(&a).is_some_and(|n| n > 0)
            && let Some(x) = self.open_album_mut()
        {
            let found = library::restore(x);
            x.songs.extend(found);
            x.songs.sort();
        }
        let Some(a) = self.open_album().cloned() else { return Task::batch(tasks) };
        if self.missing(&a).is_some_and(|n| n > 0) {
            self.failed.remove(&a.key);
            self.queue.push_back(a.key);
            tasks.push(self.start());
        }
        Task::batch(tasks)
    }

    /// The trash can (Windows' Uninstall): the open album's songs to the bin, not
    /// while it downloads.
    fn uninstall(&mut self) {
        let Some(a) = self.open_album().filter(|a| !self.is_web(a)).cloned() else { return };
        if self.loading.as_ref().is_some_and(|f| f.key == a.key) || self.queue.contains(&a.key) {
            return;
        }
        if let Err(e) = library::uninstall(&a) {
            eprintln!("mp-shell: music: uninstalling {}: {e}", a.key);
        } else if let Some(a) = self.open_album_mut() {
            a.songs.clear();
        }
    }

    /// Remove from Library: the album goes to the bin and off the wall; one found on
    /// MusicBrainz shows as its internet page again (Play Album, Add, Download).
    fn remove(&mut self) -> Task<Message> {
        // Only once its songs are gone (the trash can first, his call 2026-10-31).
        let Some(a) = self.open_album().filter(|a| !self.is_web(a) && a.songs.is_empty()).cloned() else { return Task::none() };
        if self.loading.as_ref().is_some_and(|f| f.key == a.key) || self.queue.contains(&a.key) {
            return Task::none();
        }
        if let Err(e) = library::remove(&a) {
            eprintln!("mp-shell: music: removing {}: {e}", a.key);
            return Task::none();
        }
        self.albums.retain(|x| x.key != a.key);
        self.covers.remove(&a.key);
        self.failed.remove(&a.key);
        self.art = None;
        if a.group.is_empty() {
            (self.place, self.aside, self.left) = (Place::Home, Place::Home, true);
            return self.arrive();
        }
        let kept = web::cover_at(&a.group, 1200);
        let album = Album { status: None, rating: 0, songs: Vec::new(), cover: kept.is_file().then_some(kept), ..a };
        let key = album.key.clone();
        self.web.insert(key.clone(), album);
        self.load_album(key)
    }

    /// Starts the next album or playlist waiting, when none is downloading.
    fn start(&mut self) -> Task<Message> {
        while self.loading.is_none()
            && let Some(key) = self.queue.pop_front()
        {
            let jobs = match key.strip_prefix('/') {
                Some(name) => self.playlist_jobs(name),
                None => self.job(&key).into_iter().collect(),
            };
            let jobs: Vec<download::Job> = jobs.into_iter().filter(|j| !j.songs.is_empty()).collect();
            let total = jobs.iter().map(|j| j.songs.len()).sum();
            if total == 0 {
                continue;
            }
            self.loading = Some(Fetch { key, total, done: 0, got: 0 });
            let (tx, rx) = iced::futures::channel::mpsc::unbounded();
            std::thread::spawn(move || download::run(jobs, tx));
            return Task::run(rx, Message::Got);
        }
        Task::none()
    }

    /// What an album's download fetches: its songs not on this PC, each with the
    /// link `sources` keeps for it.
    fn job(&self, key: &str) -> Option<download::Job> {
        let a = self.albums.iter().find(|a| a.key == key)?;
        let tracks = &self.release(a)?.tracks;
        let several = page::several(tracks);
        let have: HashSet<(u32, u32)> = a.songs.iter().filter_map(|k| library::place(k)).collect();
        let saved = |t: &release::Track| {
            let found = self.links.iter().find(|(k, _)| k.rsplit_once('/').is_some_and(|(dir, _)| dir == key) && library::place(k) == Some((t.disc, t.n)));
            found.map(|(_, url)| url.clone())
        };
        let songs = tracks.iter().filter(|t| !have.contains(&(t.disc, t.n))).map(|t| download::Want { name: library::song_name(t.disc, t.n, &t.title, several), saved: saved(t), track: t.clone() }).collect();
        Some(download::Job { key: key.into(), artist: a.artist.clone(), album: a.title.clone(), year: a.year, several, alone: false, songs })
    }

    /// Starts the next artist covers, a few at a time.
    fn thumbs(&mut self) -> Task<Message> {
        let side = self.side as u32;
        let mut tasks = Vec::new();
        while self.thumbs_busy < THUMBS
            && let Some(id) = self.thumb_queue.pop()
        {
            self.thumbs_busy += 1;
            let ask = id.clone();
            tasks.push(off(move || cover::square(&std::fs::read(web::cover(&ask, 250)?).ok()?, side), move |cut| Message::Thumb(id.clone(), cut.flatten())));
        }
        Task::batch(tasks)
    }

    /// Cuts the shown album's cover, or the shown playlist's picture, for the main page,
    /// one cut at a time.
    fn cut_art(&mut self) -> Task<Message> {
        let Some((key, path)) = self.picture() else { return Task::none() };
        if self.art_busy || self.art.as_ref().is_some_and(|art| art.key == key) {
            return Task::none();
        }
        self.art_busy = true;
        off(move || cover::square(&std::fs::read(path).ok()?, page::COVER as u32), move |r| Message::Art(key.clone(), r.flatten()))
    }

    fn selected(&self) -> Option<&String> {
        match &self.place {
            Place::Album(key) => Some(key),
            _ => None,
        }
    }

    /// The album whose page shows: yours, else one off the internet.
    fn open_album(&self) -> Option<&Album> {
        let key = self.selected()?;
        self.albums.iter().find(|a| &a.key == key).or_else(|| self.web.get(key))
    }

    fn open_album_mut(&mut self) -> Option<&mut Album> {
        let key = self.selected()?.clone();
        self.albums.iter_mut().find(|a| a.key == key)
    }

    /// An album off the internet, not in your library.
    pub fn is_web(&self, a: &Album) -> bool {
        !self.albums.iter().any(|x| x.key == a.key)
    }

    /// While the box exists, shown or not: the player's state, and the box's own clicks,
    /// keys and pointer.
    fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            event::listen_with(|event, status, id| match event {
                _ if *OPEN.lock().unwrap() != Some(id) => None,
                Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => Some(Message::Pressed(status == event::Status::Captured)),
                Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Back)) => Some(Message::Back),
                Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Forward)) => Some(Message::Forward),
                Event::Mouse(mouse::Event::CursorMoved { position }) => {
                    drop::keep_pointer(position);
                    None
                }
                Event::Keyboard(keyboard::Event::KeyPressed { key: keyboard::Key::Named(keyboard::key::Named::Escape), .. }) => Some(Message::Escape),
                _ => None,
            }),
            now::events().map(Message::Now),
        ])
    }

    /// The wall's tiles, searched, filtered and sorted: albums, playlists or both
    /// (the switch); Downloaded Songs first whatever the sort (his pick); Date Added
    /// and Title sort your playlists in among the albums, the other sorts put them
    /// after the albums, newest first (Windows' `mixes`); Custom is your own order with
    /// the kind switched off hidden (Windows').
    fn shown(&self) -> Vec<Tile<'_>> {
        let q = self.query.trim().to_lowercase();
        let (albums, own) = (self.view != View::Playlists, self.view != View::Albums);
        let mut tiles: Vec<Tile> = if self.sort == Sort::Custom {
            let keep = |t: &Tile| match t {
                Tile::Album(a) => albums && self.album_shown(a, &q),
                Tile::Playlist(p) => own && self.own_shown(p),
                Tile::Downloaded => false,
            };
            self.arranged().into_iter().filter(keep).collect()
        } else {
            let mut tiles: Vec<Tile> = if albums { self.albums.iter().filter(|a| self.album_shown(a, &q)).map(Tile::Album).collect() } else { Vec::new() };
            let mut own: Vec<&Playlist> = if own { self.playlists.iter().filter(|p| !playlist::is_saved(p) && self.own_shown(p)).collect() } else { Vec::new() };
            if matches!(self.sort, Sort::Added | Sort::Title) {
                tiles.extend(own.drain(..).map(Tile::Playlist));
            }
            tiles.sort_by(|a, b| {
                let o = self.sort.compare(a, b);
                if self.descending { o.reverse() } else { o }
            });
            own.sort_by_key(|p| std::cmp::Reverse(p.added));
            tiles.extend(own.into_iter().map(Tile::Playlist));
            tiles
        };
        if own && self.playlist_shown() {
            tiles.insert(0, Tile::Downloaded);
        }
        // Saved Tracks before it (his pick, chat 42; Windows' and Spotify's first).
        if let Some(saved) = self.playlists.iter().find(|p| playlist::is_saved(p)).filter(|p| own && self.own_shown(p)) {
            tiles.insert(0, Tile::Playlist(saved));
        }
        tiles
    }

    /// An album on the wall: by its name or artist, the status picked, on this PC.
    fn album_shown(&self, a: &Album, q: &str) -> bool {
        (q.is_empty() || a.title.to_lowercase().contains(q) || a.artist.to_lowercase().contains(q)) && (self.status.is_none() || a.status == self.status) && self.files.is_none_or(|on| !a.songs.is_empty() == on)
    }

    /// Every album and playlist in your own order: as saved in `order`, those not in
    /// it yet after, newest first (Windows' `applyOrder`, which adds them at the end).
    /// Saved Tracks stays out, first on the wall (Windows').
    fn arranged(&self) -> Vec<Tile<'_>> {
        let rank: HashMap<&str, usize> = self.custom.iter().enumerate().map(|(i, k)| (k.as_str(), i)).collect();
        let own = self.playlists.iter().filter(|p| !playlist::is_saved(p));
        let mut tiles: Vec<Tile> = self.albums.iter().map(Tile::Album).chain(own.map(Tile::Playlist)).collect();
        tiles.sort_by_cached_key(|t| (rank.get(t.key().as_ref()).copied().unwrap_or(usize::MAX), std::cmp::Reverse(t.added())));
        tiles
    }

    /// A tile let go on the wall (Custom): `from` and `to` are places among those
    /// shown. It lands in the whole order just before the shown tile now after it,
    /// or just after the one before it, so those hidden keep their places (Windows'
    /// `useRailOrder` `show`); the whole order is saved.
    fn move_tile(&mut self, from: usize, to: usize) {
        let shown: Vec<String> = self.shown().iter().map(|t| t.key().into_owned()).collect();
        if from == to || from >= shown.len() || to >= shown.len() {
            return;
        }
        let mut order: Vec<String> = self.arranged().iter().map(|t| t.key().into_owned()).collect();
        let mut now = shown;
        let moved = now.remove(from);
        now.insert(to, moved.clone());
        order.retain(|k| *k != moved);
        let next = now.get(to + 1).and_then(|n| order.iter().position(|k| k == n));
        let after = to.checked_sub(1).and_then(|i| now.get(i)).and_then(|b| order.iter().position(|k| k == b)).map(|i| i + 1);
        let at = next.or(after).unwrap_or(order.len());
        order.insert(at, moved);
        library::save_order(&order);
        self.custom = order;
    }

    /// The Music panel: the pages, `size()` big.
    fn page(&self) -> Element<'_, Message> {
        let c = self.colours;
        // The left page, the main page's size (his ask: the window's far left column, its
        // pill up and down): the wall or an artist's albums.
        let left: Element<'_, Message> = match &self.aside {
            Place::Artist(_, name) => boxed(container(self.artist_view(name)).width(MUSIC).height(main_page::PAGE).clip(true), c),
            _ => row![self.wall_bar(), boxed(container(self.tiles()).width(WALL).height(main_page::PAGE).clip(true), c)].spacing(GAP_2).into(),
        };
        // The left page and the main page side by side, the box gliding between them
        // (his calls: the wall comes in from the left), over the playing bar, which
        // stays (his ask 2026-11-08, Spotify's bottom bar).
        let pages = mp_ui::slide::slide(vec![left, self.main_page()], if self.left { 0 } else { 1 });
        let body = column![pages, self.playing_bar()].spacing(GAP_2);
        // `size()` whatever the surface: while a menu shows or you type the surface spans
        // the screen (the box went screen-wide).
        let s = size();
        let content = measured(container(body).width(s.width).height(s.height), Message::Window);
        // Always a stack, its layers over the window only while wanted: a new kind of
        // widget at the top would start everything inside afresh (iced's `Tree::diff`),
        // the lists' scroll among it.
        mp_ui::scroll::smooth(stack![content])
    }

    /// Menus over the box, never cut to it (a song's with your playlists outruns the
    /// main page), in the room measured there.
    fn over(&self) -> Element<'_, Message> {
        match self.open {
            Some(menu) => self.menu(menu),
            None => space().width(Length::Fill).height(Length::Fill).into(),
        }
    }

    /// The wall's up-and-down pill (his ask: the search / sort pill "vertically"), the
    /// main page's button column on the left: the glass, the Albums / Playlists / Both
    /// switch, Sort, Filter and the plus (New Playlist), the accent pill behind the
    /// hovered one, held on the one whose menu is up (Windows' `IconBar`). While the
    /// glass's box has the keys or words it lies over the whole bar (Windows'
    /// `.icon-bar.is-typing`). Its text box is kept at no width: it holds the keys and
    /// the words, and the glass hands it the keys.
    fn wall_bar(&self) -> Element<'_, Message> {
        let p = &self.pictures;
        let c = self.colours;
        let view = &p.view[View::ALL.iter().position(|v| *v == self.view).unwrap_or(2)];
        let sort = &p.sort[Sort::ALL.iter().position(|s| *s == self.sort).unwrap_or(0)];
        let filter = match (self.status, self.files) {
            (Some(s), _) => &p.status[Status::ALL.iter().position(|x| *x == s).unwrap_or(0)],
            (None, Some(on)) => &p.files[usize::from(!on)],
            (None, None) => &p.all,
        };
        let pictures = [&p.search, view, sort, filter, &p.new];
        let cell = |i: usize, lit: bool| -> Element<'_, Message> {
            let face = bar::icon(pictures[i].get(lit));
            match i {
                _ if lit => face,
                0 => mouse_area(face).on_press(Message::OpenSearch).interaction(mouse::Interaction::Pointer).into(),
                _ => measured(mouse_area(face).on_press(Message::Bar(i - 1)).interaction(mouse::Interaction::Pointer), move |at| Message::Cell(i - 1, at)).into(),
            }
        };
        let held = self.open.and_then(|m| match m {
            Menu::View => Some(VIEW),
            Menu::Sort => Some(SORT),
            Menu::Filter => Some(FILTER),
            Menu::New => Some(NEW),
            _ => None,
        });
        let plain = (0..=CELLS).map(|i| cell(i, false)).collect();
        let lit = (0..=CELLS).map(|i| cell(i, true)).collect();
        let bar = measured(Bar::new(plain, lit, None, held.map(|i| i + 1), &c).on(c.panel), Message::WallBar);
        let keys = container(self.field(Field::Wall)).width(0.0).clip(true);
        let mut layers = stack![bar, keys];
        if self.typing == Some(Field::Wall) || !self.query.is_empty() {
            layers = layers.push(self.wall_field());
        }
        layers.into()
    }

    /// The glass's box over the bar, a gap-1 in as Windows' (`inset: var(--bar-pad)`):
    /// the glass where the bar's sits, a gap-2, then the words (or "Search") turned to
    /// read top to bottom (his pick, chat 58: "in the same pill - text read sideways"),
    /// the caret after them (before "Search"). Raised, the whole of it accent while it has
    /// the keys. A click on it keeps the keys there.
    fn wall_field(&self) -> Element<'_, Message> {
        let c = self.colours;
        let typing = self.typing == Some(Field::Wall);
        let caret = || container(space()).width((BODY * LINE_TIGHT).round()).height(1.0).style(move |_| container::background(c.on_accent));
        let mut inside = column![image(self.pictures.search.get(typing)).width(ICON as f32).height(ICON as f32), space().height(GAP_2)].align_x(Alignment::Center);
        if typing && self.query.is_empty() {
            inside = inside.push(caret());
        }
        if let Some((pic, size, _)) = &self.words_pic {
            inside = inside.push(image(pic.clone()).width(size.width).height(size.height));
        }
        if typing && !self.query.is_empty() {
            inside = inside.push(caret());
        }
        let field = container(inside).padding(Padding { top: (SLOT - ICON as f32) / 2.0, ..Padding::ZERO }).width(SLOT).height(Length::Fill).align_x(Alignment::Center).style(move |_| container::Style {
            background: Some(if typing { c.accent } else { c.raised }.into()),
            border: border::rounded(SLOT / 2.0),
            ..Default::default()
        });
        container(mouse_area(field).on_press(Message::OpenSearch).interaction(mouse::Interaction::Text)).padding(GAP_1).into()
    }

    /// The wall's words drawn turned for the bar's box (`wall_field`), made again when
    /// they, the keys or the bar's length change (new colours drop it): the words in
    /// Text, On Accent while it has the keys; too long for the box, their end shows, as a
    /// text box keeps its caret in view.
    fn turn_words(&mut self) {
        let typing = self.typing == Some(Field::Wall);
        // The bar's box less the glass at its top and the gap-2 after it, the caret, and
        // a gap-3 end (Windows' word end, near enough).
        let room = (self.wall_bar - 2.0 * GAP_1 - (SLOT - ICON as f32) / 2.0 - ICON as f32 - GAP_2 - 1.0 - GAP_3).floor();
        if (!typing && self.query.is_empty()) || room < 1.0 {
            self.words_pic = None;
            return;
        }
        let key = (typing, self.query.clone(), room);
        if self.words_pic.as_ref().is_some_and(|w| w.2 == key) {
            return;
        }
        let c = self.colours;
        let words = if self.query.is_empty() { "Search" } else { self.query.as_str() };
        let line = (BODY * LINE_TIGHT).round();
        let long = turned::width(words, BODY, MEDIUM).ceil();
        let shown = long.min(room);
        let mut flat = turned::Flat::new(iced::Size::new(shown, line));
        flat.write(words, BODY, line, MEDIUM, if typing { c.on_accent } else { c.text }, Point::new(shown - long, 0.0));
        self.words_pic = Some((flat.turned(), iced::Size::new(line, shown), key));
    }

    /// A search box (Windows' `.icon-bar-field`): the glass, gap 8 (10 here), the
    /// words in a box as wide as its placeholder and the caret after it (the internet's
    /// across the Search page, 2026-11-06), as tall as a bar's items (`bar::SLOT`), its
    /// picture where theirs sit. Raised, the whole of it accent while typing. The wall's
    /// is kept at no width (`wall_bar`).
    fn field(&self, f: Field) -> Element<'_, Message> {
        let c = self.colours;
        let typing = self.typing == Some(f);
        let (placeholder, value) = match f {
            Field::Wall => ("Search", &self.query),
            Field::Web => ("Search", &self.web_query),
        };
        let input = text_input(placeholder, value)
            .id(field_id(f))
            .on_input(move |q| Message::Query(f, q))
            // Measured as a text box draws: kerning made "Search" wider than plain
            // shaping measured it, and cut its last letter.
            .width(if f == Field::Web { Length::Fill } else { search_width().into() })
            .size(BODY)
            .font(MEDIUM)
            .line_height(LINE_TIGHT)
            .padding(0)
            .style(move |_, _| text_input::Style {
                background: Color::TRANSPARENT.into(),
                border: border::rounded(0),
                icon: Color::TRANSPARENT,
                placeholder: if typing { c.on_accent } else { c.text_muted },
                value: if typing { c.on_accent } else { c.text },
                selection: if typing { c.on_accent.scale_alpha(0.3) } else { c.accent.scale_alpha(0.3) },
            });
        let edge = (SLOT - ICON as f32) / 2.0;
        container(row![image(self.pictures.search.get(typing)).width(ICON as f32).height(ICON as f32), input].spacing(GAP_2).align_y(Alignment::Center))
            .padding([0.0, edge])
            .height(SLOT)
            .align_y(Alignment::Center)
            .style(move |_| container::Style { background: Some(if typing { c.accent } else { c.raised }.into()), border: border::rounded(SLOT / 2.0), ..Default::default() })
            .into()
    }

    /// The cover wall: the tiles shown, `grid`'s count a row, the gap between them all
    /// round (the part pixel left at the row's two ends).
    fn tiles<'a>(&'a self) -> Element<'a, Message> {
        let c = self.colours;
        let shown = self.shown();
        if shown.is_empty() {
            let words = if self.view == View::Albums && self.albums.is_empty() { "No albums yet." } else { "Nothing matches." };
            return container(text(words).size(BODY).color(c.text_faint)).padding(GAP_2 + 2.0).width(Length::Fill).align_x(Alignment::Center).into();
        }
        let rows = wall().0;
        let tile = |t: &Tile<'a>| self.any_tile(t);
        // Under Custom any tile but Saved Tracks and Downloaded Songs (first, outside
        // the order: his picks) lifts to be dragged.
        let pinned = shown.iter().take_while(|t| matches!(t, Tile::Downloaded) || matches!(t, Tile::Playlist(p) if playlist::is_saved(p))).count();
        let mut covers = Reorder::new(shown.iter().map(tile).collect()).sideways(rows).spacing(GAP_2).pinned(pinned);
        if self.sort == Sort::Custom {
            covers = covers.on_drag(|_| Message::Lift(Held::Tile), Message::MoveTile);
        }
        let covers = container(covers).padding(GAP_2).height(Length::Fill).align_y(Alignment::Center);
        mp_ui::scroll::sideways(scrollable(covers).width(Length::Fill).height(Length::Fill), c)
    }

    /// A tile on the wall, its download bar on it.
    fn any_tile<'a>(&'a self, t: &Tile<'a>) -> Element<'a, Message> {
        let side = self.side;
        match *t {
            Tile::Downloaded => self.playlist_tile(),
            Tile::Album(a) => {
                let play = (!a.songs.is_empty()).then(|| Message::Play(a.key.clone()));
                self.card(&a.key, self.with_bar(self.face(self.covers.get(&a.key), side), &a.key, side), play, Message::Select(a.key.clone()), side)
            }
            Tile::Playlist(p) => self.own_tile(p),
        }
    }

    /// Windows' `CoverArtCard`: the face only; hovered, a round accent play button
    /// shows in its bottom-right corner when it has songs on this PC (no darkening, no
    /// shadow: his call 2026-10-31). `key`: which tile the pointer is on.
    pub fn card<'a>(&'a self, key: &str, face: Element<'a, Message>, play: Option<Message>, open: Message, side: f32) -> Element<'a, Message> {
        let c = self.colours;
        let mut layers = stack![face];
        if self.hovered.as_deref() == Some(key)
            && let Some(on) = play
        {
            let play = container(image(self.pictures.play.clone()).width(ICON as f32).height(ICON as f32)).padding(Padding { left: GAP_1, ..Padding::ZERO }).center(PLAY).style(move |_| container::Style {
                background: Some(c.accent.into()),
                border: border::rounded(PLAY / 2.0),
                ..Default::default()
            });
            let play = mouse_area(play).on_press(on).interaction(mouse::Interaction::Pointer);
            layers = layers.push(container(play).width(side).height(side).padding(GAP_2).align_right(Length::Fill).align_bottom(Length::Fill));
        }
        // Under Custom a tile opens on release: a press held lifts it to be dragged.
        let area = mouse_area(layers);
        let area = if self.sort == Sort::Custom { area.on_release(open) } else { area.on_press(open) };
        area.on_enter(Message::Hover(key.into(), true)).on_exit(Message::Hover(key.into(), false)).interaction(mouse::Interaction::Pointer).into()
    }

    /// A cover `side` square, or a Raised square where there is none.
    pub fn face(&self, cover: Option<&image::Handle>, side: f32) -> Element<'_, Message> {
        match cover {
            Some(cover) => image(cover.clone()).width(side).height(side).into(),
            None => self.square(side, None),
        }
    }

    /// A Raised square: where a cover is missing, and a playlist's face with its
    /// picture in the middle.
    pub fn square(&self, side: f32, picture: Option<&image::Handle>) -> Element<'_, Message> {
        let c = self.colours;
        let inside: Element<'_, Message> = match picture {
            Some(p) => image(p.clone()).width(ICON_LG as f32).height(ICON_LG as f32).into(),
            None => space().into(),
        };
        container(inside).center(side).style(move |_| container::Style { background: Some(c.raised.into()), border: border::rounded(CORNER), ..Default::default() }).into()
    }

    /// The open drop-down, centred under its cell, and a click-off layer under it.
    fn menu(&self, menu: Menu) -> Element<'_, Message> {
        let p = &self.pictures;
        let items: Vec<Item<Message>> = match menu {
            Menu::View => View::ALL.iter().zip(&p.view).map(|(&v, mark)| Item::Row(drop::Row { icon: mark.clone(), label: v.label(), after: None, picked: v == self.view, pick: Message::View(v) })).collect(),
            // Import Playlist (piece D): Windows' Import, `IconListPlus`.
            Menu::New => vec![
                Item::Row(drop::Row { icon: p.new.clone(), label: "New Playlist", after: None, picked: false, pick: Message::NewPlaylist }),
                Item::Row(drop::Row { icon: p.import.clone(), label: "Import Playlist", after: None, picked: false, pick: Message::Import }),
            ],
            Menu::Sort => Sort::ALL
                .iter()
                .zip(&p.sort)
                .map(|(&s, mark)| {
                    let current = s == self.sort;
                    Item::Row(drop::Row { icon: mark.clone(), label: s.label(), after: (current && s != Sort::Custom).then(|| if self.descending { p.down.clone() } else { p.up.clone() }), picked: current, pick: Message::Sort(s) })
                })
                .collect(),
            Menu::Filter => {
                let mut items = vec![Item::Header("Status")];
                items.extend(Status::ALL.iter().zip(&p.status).map(|(&s, mark)| Item::Row(drop::Row { icon: mark.clone(), label: s.label(), after: None, picked: self.status == Some(s), pick: Message::Status(s) })));
                items.push(Item::Header("Files"));
                items.extend(
                    [(true, "Downloaded"), (false, "Not Downloaded")]
                        .into_iter()
                        .zip(&p.files)
                        .map(|((on, label), mark)| Item::Row(drop::Row { icon: mark.clone(), label, after: None, picked: self.files == Some(on), pick: Message::Files(on) })),
                );
                items
            }
            // Windows' `CandySelect` rows: the list's own picture on each (the star),
            // or each status's own.
            Menu::Rating => {
                let rating = self.open_album().map_or(0, |a| a.rating);
                (1..=10u8).rev().map(|n| Item::Row(drop::Row { icon: p.sort[1].clone(), label: page::RATINGS[10 - n as usize], after: None, picked: rating == n, pick: Message::Rate(n) })).collect()
            }
            Menu::Status => {
                let status = self.open_album().and_then(|a| a.status);
                Status::ALL.iter().zip(&p.status).map(|(&s, mark)| Item::Row(drop::Row { icon: mark.clone(), label: s.label(), after: None, picked: status == Some(s), pick: Message::Mark(s) })).collect()
            }
            // Windows' song menu, flat (no sub-menu): a check on the playlists holding
            // the songs (his pick), New Playlist last (Windows').
            Menu::Cover => self.cover_items(),
            Menu::Song | Menu::Save(_) => {
                let Some(target) = self.target.clone() else { return space().into() };
                let picks = self.picks(&target);
                let mut items = Vec::new();
                if menu == Menu::Song {
                    let own = match (&self.place, &target) {
                        (Place::Playlist(_), Target::Row(i)) => Some(*i),
                        _ => None,
                    };
                    // First, as Windows' `useSongMenu`: the heart, out when it holds them.
                    let saved = self.playlists.iter().find(|pl| playlist::is_saved(pl)).is_some_and(|pl| self.holds(pl, &picks));
                    let label = if saved { "Remove from Saved Tracks" } else { "Save to Saved Tracks" };
                    items.push(Item::Row(drop::Row { icon: p.heart_row.clone(), label, after: None, picked: false, pick: Message::Heart }));
                    items.push(Item::Row(drop::Row { icon: p.queue.clone(), label: "Send to Queue", after: None, picked: false, pick: Message::Send(target) }));
                    if let Some(i) = own {
                        items.push(Item::Row(drop::Row { icon: p.unlist.clone(), label: "Remove from Playlist", after: None, picked: false, pick: Message::Unlist(i) }));
                    }
                    items.push(Item::Header("Save to Playlist"));
                }
                items.extend(self.playlists.iter().map(|pl| Item::Row(drop::Row { icon: p.view[1].clone(), label: &pl.name, after: None, picked: self.holds(pl, &picks), pick: Message::Save(pl.name.clone()) })));
                items.push(Item::Row(drop::Row { icon: p.new.clone(), label: "New Playlist", after: None, picked: false, pick: Message::SaveNew }));
                items
            }
        };
        let width = drop::width(&items);
        let page_cell = |i: usize| self.page_cells[i];
        let trigger = match menu {
            Menu::View => self.cells[VIEW],
            Menu::Sort => self.cells[SORT],
            Menu::Filter => self.cells[FILTER],
            Menu::New => self.cells[NEW],
            Menu::Rating => page_cell(page::RATING),
            Menu::Status => page_cell(page::STATUS),
            Menu::Save(i) => page_cell(i),
            Menu::Song | Menu::Cover => Rectangle::default(),
        };
        // Places are read in the box's surface; the menu's layer starts at the content.
        let origin = Vector::new(self.window.x, self.window.y);
        let room = self.room.size();
        // The wall bar's menus open beside it, level with their button, as the strip's;
        // the album bar's centred under theirs.
        let at = match menu {
            Menu::Song | Menu::Cover => drop::at_pointer(&items, self.menu_at, room),
            Menu::View | Menu::Sort | Menu::Filter | Menu::New => Point::new(trigger.x + trigger.width + GAP_1 + GAP_2, trigger.y) - origin,
            _ => Point::new(trigger.center_x() - width / 2.0, trigger.y + trigger.height + GAP_1) - origin,
        };
        drop::layer(items, Some(&p.check), self.colours, at, room, Message::Close)
    }
}

/// Every cover cut at `side`, off the window's thread.
fn read_covers(wanted: Vec<(String, std::path::PathBuf)>, side: u32) -> Vec<(String, image::Handle)> {
    wanted.into_iter().filter_map(|(key, path)| Some((key, cover::square(&std::fs::read(path).ok()?, side)?))).collect()
}

fn off<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, done: impl Fn(Option<T>) -> Message + Send + 'static) -> Task<Message> {
    let (tx, rx) = iced::futures::channel::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    Task::perform(async move { rx.await.ok() }, done)
}
