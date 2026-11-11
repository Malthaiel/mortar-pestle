//! mp-shell: the desktop's always-on parts (M&P Shell plan,
//! `Knowledge/Mortar & Pestle/Plans/M&P Shell.md`). So far: a bar across the top of
//! every screen (Noctalia Look step 2, 2026-11-08: hooxoo's Noctalia picture) holding,
//! left, the workspace marks (`workspaces.rs`) and a box of the top drawer's page
//! buttons (Dashboard, Music, Performance); in the middle, search (the Start menu), the
//! clock's box (the clock, the weather) and the shortcuts button (niri's own list); right,
//! a box of the bell (the side panel), network, Bluetooth and the speaker, then power. A
//! click on the clock, power, Bluetooth or the speaker opens its panel floating under it
//! (a month calendar, the power rows, the Bluetooth box, the sound box; Noctalia Look
//! step 7); a click off it (the click sheet, `sheet.rs`), Esc, its X or the same button
//! closes it.
//! niri's Mod+D opens the Start menu (`start.rs`) at the bottom of the mouse's screen;
//! Mod+Shift+D opens the top drawer on Music, its three panels side by side (Dashboard,
//! Music, Performance; Weather gone, Chat Tab plan 2026-11-05; Chat gone with M&P Chat,
//! scrapped 2026-11-07), sliding to the one picked last (`music/`, its own program
//! mp-library until the Top Strip plan's step 2). Only Music has content yet. Quick
//! toggles' replay and camera pills open a capture pop-up centred on their screen
//! (`capture.rs`). CPU drawing; nothing runs on a timer except the clock, once a minute
//! (it also asks the weather every 30 minutes, `weather.rs`), the wifi's signal read every 6 s while it is joined (`net.rs`), a recording's clock
//! once a second while one runs (`capture.rs`), and motion while it moves; niri's, the
//! sound server's, BlueZ's and the kernel's link events wake it.

mod apps;
mod audio;
mod bluetooth;
mod bluetooth_menu;
mod calendar;
mod capture;
mod clock;
mod menu;
mod music;
mod net;
mod niri;
mod notices;
mod popups;
mod record;
mod recorder;
mod sheet;
mod side;
mod signal;
mod sound;
mod start;
mod weather;
mod workspaces;

use std::collections::HashMap;

use iced::widget::{Space, container, image, mouse_area, row, stack, text};
use iced::window::Id;
use iced::{Center, Color, Element, Fill, Length, Rectangle, Size, Subscription, Task, Theme, mouse, theme};
use iced_exwlshell::actions::RegionActionCB;
use iced_exwlshell::daemon;
use iced_exwlshell::reexport::{Anchor, KeyboardInteractivity, Layer, LayerSize, Margin, NewLayerShellSettings, OutputOption};
use iced_exwlshell::settings::{ExWlSettings, LayerShellSettings, StartMode};
use iced_exwlshell::to_layer_message;
use iced_wayland_subscriber::shell::{ShellEvent, ShellReceiver};
use iced_wayland_subscriber::{ExWlOutputInfo, OutputId};

// The rulebook, colours, motion, icons, the pill and the font, shared with every app.
use colours::Colours;
use menu::{Menu, MenuEvent};
use mp_ui::measured::measured;
use mp_ui::{BOLD, BOLD_TTF, FONT_TTF, MEDIUM, colours, icon, motion, style};
use serde_json::json;
use workspaces::{Kind, Workspaces};

/// The top drawer's panels, left to right as the drawer lays them (Top Strip plan step
/// 3), by name (saved for the one picked last). Their tab row went 2026-11-08 (his ask:
/// the top bar switches them: its page buttons, 2026-11-09; the shortcut opens Music).
const PANELS: [&str; 3] = ["Dashboard", "Music", "Performance"];
/// The bar's page buttons' pictures, `PANELS`' order, the Caelestia copy's (his pick
/// 2026-11-09), Boxicons Filled (his ask 2026-11-10: every picture Filled again).
const PAGES: [&[u8]; 3] = [include_bytes!("../assets/bx-dashboard.svg"), include_bytes!("../assets/bx-music.svg"), include_bytes!("../assets/bx-rocket.svg")];
/// The panel the music box fills; the others are blank, its size, for now.
const MUSIC_PANEL: usize = 1;

/// The panel picked last (`$XDG_STATE_HOME/mp-shell/panel`, its name), else Music.
fn saved_panel() -> usize {
    let name = std::fs::read_to_string(apps::state("panel")).unwrap_or_default();
    PANELS.iter().position(|n| *n == name.trim()).unwrap_or(MUSIC_PANEL)
}

/// The power menu, top to bottom (M&P Shell plan, step 1): name, Boxicon. `run`
/// holds each row's command.
const POWER: [(&str, &[u8]); 4] =
    [("Lock", include_bytes!("../assets/bx-lock-keyhole.svg")), ("Sleep", include_bytes!("../assets/bx-moon-stars.svg")), ("Restart", include_bytes!("../assets/bx-refresh-cw.svg")), ("Shut down", include_bytes!("../assets/bx-power.svg"))];

/// The bar's pictures are Boxicons Filled (his ask 2026-11-10; Tabler, Noctalia's, from
/// 2026-11-08 till then). The network, as Noctalia's `network_display.cpp` picks it: a
/// cable in, no network, then the wifi by its signal band.
const NETWORK: [&[u8]; 6] = [
    include_bytes!("../assets/bx-ethernet.svg"),
    include_bytes!("../assets/bx-wifi-slash.svg"),
    include_bytes!("../assets/bx-wifi-0.svg"),
    include_bytes!("../assets/bx-wifi-1.svg"),
    include_bytes!("../assets/bx-wifi-2.svg"),
    include_bytes!("../assets/bx-wifi.svg"),
];

fn network(n: net::Net) -> usize {
    match n {
        net::Net::Cable => 0,
        net::Net::Off => 1,
        // Noctalia's `wifiSignalBand` less its 80: Boxicons has a dot and three arcs.
        net::Net::Wifi(s) => 2 + [15, 35, 60].iter().filter(|&&at| s >= at).count(),
    }
}

/// Bluetooth, as Noctalia's bluetooth widget picks it: off (no controller, or it is
/// off), on, a device connected.
const BLUETOOTH: [&[u8]; 3] = [include_bytes!("../assets/bx-bluetooth-slash.svg"), include_bytes!("../assets/bx-bluetooth.svg"), include_bytes!("../assets/bx-bluetooth-connected.svg")];

fn bluetooth(b: &bluetooth::Bluetooth) -> usize {
    match b.adapter() {
        Some(a) if a.powered && b.devices().any(|(_, d)| d.connected) => 2,
        Some(a) if a.powered => 1,
        _ => 0,
    }
}

/// The speaker, by volume as Noctalia's `audioVolumeGlyph`: muted or at 0%, under
/// 40%, the rest. The music box's playing bar shows the player's volume by them too.
const SPEAKER: [&[u8]; 3] = [include_bytes!("../assets/bx-volume-mute.svg"), include_bytes!("../assets/bx-volume-low.svg"), include_bytes!("../assets/bx-volume-full.svg")];

/// The weather's sky, in `weather::Sky`'s order: the Boxicon nearest each of Noctalia's
/// weather glyphs.
const WEATHER: [&[u8]; 9] = [
    include_bytes!("../assets/bx-sun.svg"),
    include_bytes!("../assets/bx-moon.svg"),
    include_bytes!("../assets/bx-cloud-sun.svg"),
    include_bytes!("../assets/bx-moon-stars.svg"),
    include_bytes!("../assets/bx-cloud.svg"),
    include_bytes!("../assets/bx-cloud-fog.svg"),
    include_bytes!("../assets/bx-cloud-rain.svg"),
    include_bytes!("../assets/bx-cloud-snow.svg"),
    include_bytes!("../assets/bx-cloud-lightning.svg"),
];

/// Which `SPEAKER` picture a volume (1.0 = 100%) shows.
fn speaker(volume: f64, muted: bool) -> usize {
    match volume {
        v if muted || (v * 100.0).round() == 0.0 => 0,
        v if v < 0.4 => 1,
        _ => 2,
    }
}

struct Shell {
    colours: Colours,
    pictures: Pictures,
    now: clock::Now,
    weather: weather::Weather,
    /// A device's picture blinks in the bar (a call to it waits): drawn every frame.
    blinking: bool,
    /// The windows' corner, which the menus share.
    corner: f32,
    /// Each screen's strip and menus, so an unplugged screen closes its own.
    screens: HashMap<OutputId, Screen>,
    shell_events: ShellReceiver,
    /// The Start menu while it shows; nothing of it is kept once it has closed.
    start: Option<Start>,
    /// The notices popping up (`notices.rs`), as of their last change.
    popups: Vec<notices::Notice>,
    /// The side panel (or the switches alone) while it shows.
    side: Option<Panel>,
    /// The music box: made on its first open, kept after it shuts (as mp-library ran on).
    /// It holds the top drawer (`Music::view`).
    music: Option<music::Music>,
    /// The top drawer's panel shown, or shown last (`PANELS`).
    panel: usize,
    /// What the recorder does (a recording's clock for the panel and the pop-up), and
    /// the capture pop-up while it shows.
    capture: capture::Capture,
    capturing: Option<Capturing>,
}

/// The capture pop-up while it shows: made on open, dropped on close.
struct Capturing {
    id: Id,
    card: capture::Card,
    /// The record card's settings page in.
    settings: bool,
    /// niri's name for its screen, and its focused window as it opened (the Window tile).
    output: String,
    window: Option<u64>,
    pictures: capture::Pictures,
}

/// The side panel while it shows: made on open, dropped on close.
struct Panel {
    id: Id,
    /// The pointer on the right band's zone, on the corner's, and on its boxes.
    band: bool,
    corner: bool,
    over: bool,
    /// Every kept notice and each program's pictures, as of the last change.
    list: Vec<notices::Notice>,
    faces: HashMap<String, (Option<image::Handle>, Option<image::Handle>)>,
    drawn: HashMap<(std::path::PathBuf, u32), image::Handle>,
    pictures: side::Pictures,
    /// The whole panel's content height.
    height: f32,
    /// niri's name for its screen.
    output: String,
    /// Closed on purpose (Esc): shut though the pointer is on it, and though pinned.
    shut: bool,
    /// Kept open by its pin till the pin is pressed again (Malthaiel's ask 2026-11-04).
    pinned: bool,
    /// Opened by the bar's bell: held till the pointer has been on it and left, or the
    /// bell is pressed again.
    bell: bool,
    /// The recorder box's screenshot button pressed: taken once the panel is gone.
    shot: Option<capture::Shot>,
}

impl Panel {
    fn open(&self) -> bool {
        !self.shut && (self.pinned || self.band || self.corner || self.over || self.bell)
    }
}

/// The bar's own pictures, painted in the colours: drawn on start and again when
/// mp-theme changes them.
struct Pictures {
    /// The bar's, in Text at the bar's 16: search, power, the shortcuts' keyboard, the
    /// bell, hooxoo's grip, then `NETWORK`'s, `BLUETOOTH`'s, `SPEAKER`'s, `WEATHER`'s.
    search: image::Handle,
    power: image::Handle,
    keys: image::Handle,
    bell: image::Handle,
    grip: image::Handle,
    network: Vec<image::Handle>,
    bluetooth: Vec<image::Handle>,
    speaker: Vec<image::Handle>,
    weather: Vec<image::Handle>,
    /// The page buttons' (`PAGES`): in Text, and in On Accent for the open page.
    pages: [[image::Handle; 2]; 3],
    /// A connected device's picture after the Bluetooth one (`bluetooth_menu::DEVICES`,
    /// the Bluetooth box's Boxicons, not yet redone).
    bt_devices: Vec<image::Handle>,
    /// The Bluetooth box's own.
    bt_menu: bluetooth_menu::Pictures,
    power_rows: Vec<menu::Row>,
    /// The calendar's arrows: back, forward.
    arrows: [image::Handle; 2],
    /// A floating panel's X (Noctalia's `close`) at its header glyph's 14.
    close: image::Handle,
    /// The notice cards' arrows, X and bell.
    notices: popups::Pictures,
}

impl Pictures {
    fn new(colours: &Colours) -> Self {
        let bare = |svg: &[u8]| icon::svg(svg, style::ICON, colours.text);
        let power_rows = POWER.iter().map(|&(label, svg)| menu::Row { label: label.into(), icon: Some([icon::svg(svg, style::ICON, colours.text), icon::svg(svg, style::ICON, colours.on_accent)]) }).collect();
        let plain = |svgs: &[&[u8]]| svgs.iter().map(|svg| bare(svg)).collect();
        let (network, bluetooth, speaker, weather, bt_devices) = (plain(&NETWORK), plain(&BLUETOOTH), plain(&SPEAKER), plain(&WEATHER), plain(&bluetooth_menu::DEVICES));
        let arrows = [icon::svg(include_bytes!("../assets/bx-chevron-left.svg"), style::ICON, colours.text), icon::svg(include_bytes!("../assets/bx-chevron-right.svg"), style::ICON, colours.text)];
        let bt_menu = bluetooth_menu::Pictures::new(colours);
        Self {
            search: bare(include_bytes!("../assets/bx-search.svg")),
            power: bare(include_bytes!("../assets/bx-power.svg")),
            keys: bare(include_bytes!("../assets/bx-keyboard.svg")),
            bell: bare(include_bytes!("../assets/bx-bell.svg")),
            grip: bare(include_bytes!("../assets/bx-dots-vertical-rounded.svg")),
            network,
            bluetooth,
            speaker,
            weather,
            pages: PAGES.map(|svg| [bare(svg), icon::svg(svg, style::ICON, colours.on_accent)]),
            bt_devices,
            bt_menu,
            power_rows,
            arrows,
            close: icon::svg(include_bytes!("../assets/bx-x.svg"), style::ICON_SM, colours.text),
            notices: popups::Pictures::new(colours),
        }
    }
}

/// The open Start menu: its surface, the programs it lists, its own pictures.
struct Start {
    id: Id,
    apps: Vec<apps::App>,
    /// `start::widest`, read on open.
    width: f32,
    pictures: start::Pictures,
    /// False while it closes.
    open: bool,
}

/// A bar button that opens a floating panel: the clock, power, Bluetooth, the speaker.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Pop {
    Clock,
    Power,
    Bluetooth,
    Sound,
}

impl Pop {
    /// Its panel's title: Noctalia's tab names (`assets/translations/en.json`
    /// `control-center.tabs`).
    fn title(self) -> &'static str {
        match self {
            Pop::Clock => "Calendar",
            Pop::Power => "Power",
            Pop::Bluetooth => "Bluetooth",
            Pop::Sound => "Audio",
        }
    }
}

struct Screen {
    info: ExWlOutputInfo,
    strip: Id,
    /// Where the bar was laid out.
    strip_at: Rectangle,
    /// The clock box's width, so it is centred on whole pixels.
    middle: f32,
    /// The buttons, each with where it was laid out.
    buttons: Vec<(Pop, Button)>,
    /// The pointer on the bell.
    bell: bool,
    /// The page button under the pointer (`PANELS`).
    page_over: Option<usize>,
    /// The floating panel's surface, while one shows or closes (one at a time on all
    /// screens, as Noctalia's).
    menu: Option<Id>,
    /// The button whose panel shows, or showed last while it closes.
    shown: Pop,
    /// False while it closes.
    opened: bool,
    /// The notices' box in the top-right corner under the bar, while any pops up.
    notices: Option<Id>,
    /// The side panel's hover zones, invisible in niri's gap at the screen's edge: the
    /// right edge (the whole panel, or the list added over the switches), and the bottom
    /// edge's right end (the switches alone; Windows' `.side-zone` and `.c-corner-zone`,
    /// his picks 2026-11-03 and 2026-11-08, Noctalia Look step 3).
    side_zone: Id,
    corner_zone: Id,
}

impl Screen {
    /// The side panel's room: the screen under the bar.
    fn hole(&self) -> f32 {
        self.info.logical_size.map_or(0.0, |(_, h)| h as f32) - style::BAR
    }

    fn button(&mut self, pop: &Pop) -> Option<&mut Button> {
        self.buttons.iter_mut().find(|(p, _)| p == pop).map(|(_, b)| b)
    }

    /// niri's name for the screen (`DP-1`).
    fn output(&self) -> &str {
        self.info.name.as_deref().unwrap_or("")
    }
}

/// A button that opens a floating panel.
#[derive(Default)]
struct Button {
    /// Where it was laid out.
    at: Rectangle,
    over: bool,
}

#[to_layer_message(multi)]
#[derive(Debug, Clone)]
enum Message {
    Tick,
    /// The weather's ask back: a reading, or none when it failed.
    Weather(Option<weather::Reading>),
    ScreenAdded(ExWlOutputInfo),
    ScreenRemoved(OutputId),
    StripAt(Id, Rectangle),
    ButtonAt(Id, Pop, Rectangle),
    ButtonHover(Id, Pop, bool),
    /// A press on a panel's button: its panel opens, or shuts when it shows.
    Pop(Id, Pop),
    /// A press off the open panel (on the click sheet), or Esc: it shuts.
    PopShut,
    /// The bar's clock box laid out.
    MiddleAt(Id, Rectangle),
    /// The pointer onto or off the bell; a press on it (the side panel opens or shuts).
    BellHover(Id, bool),
    Bell(Id),
    /// The pointer onto or off a page button (`PANELS`); a press on one (the drawer
    /// opens on its page, slides to it, or shuts).
    PageHover(Id, usize, bool),
    Page(Id, usize),
    /// The search button: the Start menu opens (a click on it while open has closed it).
    Search,
    /// The keyboard button: niri's own list of its shortcuts.
    Keys,
    Menu(Id, MenuEvent),
    /// niri's windows or workspaces changed.
    Niri,
    /// The sound server's state changed.
    Sound,
    /// A cable went in or out, the wifi joined or left, or its signal changed.
    Net,
    /// BlueZ's controller or a device changed (`bluetooth.rs`).
    Bluetooth,
    /// A frame while a device's picture blinks in the strip.
    Frame,
    /// The wheel on the speaker: the volume up or down by this much.
    Volume(f32),
    /// A middle-click on the speaker: mute or unmute.
    Mute,
    /// A workspace dot clicked (its id).
    Workspace(u64),
    /// niri's Mod+D: the Start menu opens, or closes when open.
    Start,
    /// mp-theme wrote new colours (Super+Shift+L flips dark / light).
    Colours,
    /// A click on one of the shell's surfaces (its id), and whether a button took it:
    /// it closes the Start menu, and on the bar's bare part a floating panel.
    Clicked(Id, bool),
    /// The pointer came onto or left a screen's side-panel hover zone (its id).
    Zone(Id, bool),
    /// A notice came, or a pop-up's state changed (`notices.rs`).
    Notices,
    /// The music box's own messages; the shortcut, over the session bus.
    Music(music::Msg),
    MusicCall(music::bus::Call),
    /// The capture pop-up: a tile, a setting, its page, Esc or a click off it.
    Capture(capture::Out),
    /// A tile's job, once the pop-up has gone: its screen, its focused window.
    CaptureRun(capture::Kind, String, Option<u64>),
    /// Time to read what the recorder does (`capture::Capture::ticks`).
    CaptureTick,
}

fn main() -> Result<(), iced_exwlshell::Error> {
    // Big buffers go back on free, so a cover read on a side thread leaves no glibc
    // arena behind (the service sets the first too); every thread shares one memory
    // pile, so what a helper frees (covers, search answers) the music box reuses after it
    // shuts (Music Tab Redesign step 6, measured in mp-library).
    // SAFETY: plain C calls, before any thread starts.
    unsafe {
        libc::mallopt(libc::M_MMAP_THRESHOLD, 131_072);
        libc::mallopt(libc::M_ARENA_MAX, 1);
    }
    // Before any thread starts, so they all leave Mod+D's and mp-theme's signals to `signal::events`.
    signal::hold();
    let (shell_broadcast, shell_events) = iced_wayland_subscriber::shell::channel();
    daemon(move || Shell::new(shell_events.clone()), || "mp-shell".to_string(), Shell::update, Shell::view)
        .subscription(Shell::subscription)
        // See-through unless painted: the menus' curves need it; the strip paints itself.
        .style(|shell: &Shell, _: &Theme| theme::Style { background_color: Color::TRANSPARENT, text_color: shell.colours.text })
        .wl_settings(ExWlSettings { layer_settings: LayerShellSettings { start_mode: StartMode::Background, ..Default::default() }, shell_broadcast, ..Default::default() })
        .font(FONT_TTF)
        .font(BOLD_TTF)
        .default_font(MEDIUM)
        // The music box's text (the strip's own sets its size).
        .default_text_size(style::BODY)
        .run()
}

impl Shell {
    fn new(shell_events: ShellReceiver) -> Self {
        // Instant replay starts with the shell (as he set it), off the drawing thread.
        std::thread::spawn(record::sync);
        let colours = colours::load();
        let pictures = Pictures::new(&colours);
        let panel = saved_panel();
        Self {
            colours,
            pictures,
            now: clock::now(),
            weather: weather::Weather::new(),
            blinking: false,
            corner: mp_ui::shape::corner_radius(),
            screens: HashMap::new(),
            shell_events,
            start: None,
            popups: Vec::new(),
            side: None,
            music: None,
            panel,
            capture: capture::Capture::new(),
            capturing: None,
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        // While the Start menu or a floating panel shows: a click on the shell's own
        // surfaces closes it (a click on a window never reaches the Start menu, see
        // `open_start`; the panel hears one on its click sheet).
        let popped = self.screens.values().any(|s| s.menu.is_some() && s.opened);
        let clicks = (self.start.is_some() || popped).then(|| {
            iced::event::listen_with(|event, status, id| match event {
                iced::Event::Mouse(mouse::Event::ButtonPressed(_)) => Some(Message::Clicked(id, status == iced::event::Status::Captured)),
                _ => None,
            })
        });
        // While a floating panel shows (it holds the keyboard): Esc shuts it, and so does
        // a press off it, on the sheet over every screen.
        let pop = popped.then(|| {
            let escape = iced::event::listen_with(|event, _, _| match event {
                iced::Event::Keyboard(iced::keyboard::Event::KeyPressed { key: iced::keyboard::Key::Named(iced::keyboard::key::Named::Escape), .. }) => Some(Message::PopShut),
                _ => None,
            });
            Subscription::batch([escape, sheet::clicks().map(|()| Message::PopShut)])
        });
        // While the capture pop-up shows (it holds the keyboard): Esc closes it.
        let escape = self.capturing.as_ref().map(|_| {
            iced::event::listen_with(|event, _, _| match event {
                iced::Event::Keyboard(iced::keyboard::Event::KeyPressed { key: iced::keyboard::Key::Named(iced::keyboard::key::Named::Escape), .. }) => Some(Message::Capture(capture::Out::Close)),
                _ => None,
            })
        });
        Subscription::batch([
            clock::minutes().map(|()| Message::Tick),
            niri::events().map(|()| Message::Niri),
            sound::events().map(|()| Message::Sound),
            net::events().map(|()| Message::Net),
            bluetooth::events().map(|()| Message::Bluetooth),
            if self.blinking { iced::window::frames().map(|_| Message::Frame) } else { Subscription::none() },
            notices::events().map(|()| Message::Notices),
            signal::events().map(|s| match s {
                signal::Signal::Start => Message::Start,
                signal::Signal::Colours => Message::Colours,
            }),
            clicks.unwrap_or_else(Subscription::none),
            escape.unwrap_or_else(Subscription::none),
            pop.unwrap_or_else(Subscription::none),
            self.capture.ticks().map(|()| Message::CaptureTick),
            music::bus::calls().map(Message::MusicCall),
            self.music.as_ref().map_or_else(Subscription::none, music::Music::subscription),
            self.shell_events.listen().filter_map(|event| match event {
                ShellEvent::OutputAdded(screen) => Some(Message::ScreenAdded(screen)),
                ShellEvent::OutputRemoved(screen) => Some(Message::ScreenRemoved(OutputId::from(&screen))),
                _ => None,
            }),
        ])
    }

    /// The weather's ask, when one is due.
    fn ask_weather(&mut self) -> Task<Message> {
        self.weather.check().map_or_else(Task::none, |ask| ask.map(Message::Weather))
    }

    /// The screen a strip or menu belongs to.
    fn screen(&mut self, id: Id) -> Option<&mut Screen> {
        self.screens.values_mut().find(|s| s.strip == id || s.menu == Some(id))
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        // Another of the bar's buttons pressed: a floating panel shuts first.
        if matches!(message, Message::Search | Message::Keys | Message::Bell(_) | Message::Page(..) | Message::Workspace(_) | Message::PopShut) {
            self.pop_shut();
        }
        match message {
            Message::Tick => {
                self.now = clock::now();
                return self.ask_weather();
            }
            Message::Weather(reading) => self.weather.got(reading),
            Message::ScreenAdded(info) => {
                let id = Id::unique();
                // The bar across the top, its height reserved (the top band's drawer zone
                // went with it: the calendar drops where it lay; Mod+Shift+D opens the
                // drawer, Noctalia Look step 2).
                let settings = NewLayerShellSettings {
                    anchor: Anchor::Top | Anchor::Left | Anchor::Right,
                    layer: Layer::Top,
                    exclusive_zone: Some(style::BAR as i32),
                    size: LayerSize::fill_width(style::BAR as u32),
                    keyboard_interactivity: KeyboardInteractivity::None,
                    output_option: OutputOption::Output(info.wl_output()),
                    ..Default::default()
                };
                let screen = Screen {
                    info: info.clone(),
                    strip: id,
                    strip_at: Rectangle::default(),
                    middle: 0.0,
                    buttons: [Pop::Clock, Pop::Power, Pop::Bluetooth, Pop::Sound].map(|pop| (pop, Button::default())).into(),
                    bell: false,
                    page_over: None,
                    menu: None,
                    shown: Pop::Clock,
                    opened: false,
                    notices: None,
                    side_zone: Id::unique(),
                    corner_zone: Id::unique(),
                };
                let zones = self.side_zones(&screen);
                self.screens.insert(OutputId::from(&info), screen);
                let output = OutputId::from(&info);
                // The weather's first ask goes with the first bar, not a minute later.
                return Task::batch([Task::done(Message::NewLayerShell { settings, id }), zones, self.show_notices(Some(&output)), self.ask_weather()]);
            }
            Message::ScreenRemoved(output) => {
                if let Some(s) = self.screens.remove(&output) {
                    let popup = self.capturing.take_if(|c| c.output == s.output()).map(|c| c.id);
                    return Task::batch([s.strip, s.side_zone, s.corner_zone].into_iter().chain(s.menu).chain(s.notices).chain(popup).map(iced::window::close));
                }
            }
            Message::MiddleAt(id, at) => {
                if let Some(s) = self.screen(id) {
                    s.middle = at.width;
                }
            }
            Message::BellHover(id, on) => {
                if let Some(s) = self.screen(id) {
                    s.bell = on;
                }
            }
            Message::Bell(id) => return self.bell(id),
            Message::PageHover(id, i, on) => {
                if let Some(s) = self.screen(id) {
                    if on {
                        s.page_over = Some(i);
                    } else if s.page_over == Some(i) {
                        s.page_over = None;
                    }
                }
            }
            Message::Page(id, i) => return self.page(id, i),
            // A click on search while the menu shows has closed it already (`Clicked`).
            Message::Search if self.start.is_none() => return self.open_start(),
            Message::Keys => niri::act(json!({ "ShowHotkeyOverlay": {} })),
            Message::StripAt(id, at) => {
                if let Some(s) = self.screen(id) {
                    s.strip_at = at;
                }
            }
            Message::ButtonAt(id, pop, at) => {
                if let Some(b) = self.screen(id).and_then(|s| s.button(&pop)) {
                    b.at = at;
                }
            }
            Message::ButtonHover(id, pop, on) => {
                if let Some(b) = self.screen(id).and_then(|s| s.button(&pop)) {
                    b.over = on;
                }
            }
            Message::Pop(id, pop) => return self.pop(id, pop),
            Message::Menu(id, event) if self.start.as_ref().is_some_and(|s| s.id == id) => return self.start_event(event),
            Message::Menu(id, event) if self.screens.values().any(|s| s.notices == Some(id)) => return self.notices_event(id, event),
            Message::Menu(id, event) if self.side.as_ref().is_some_and(|p| p.id == id) => return self.side_event(event),
            Message::Notices => {
                self.popups = notices::popups();
                if let Some(p) = self.side.as_mut() {
                    p.list = notices::list();
                    p.faces = notices::group_pictures(&p.list, &mut p.drawn);
                }
                return self.show_notices(None);
            }
            Message::Zone(id, on) => return self.side_hover(id, on),
            Message::MusicCall(call) => return self.music_call(call),
            Message::Music(m) => return self.music.as_mut().map_or_else(Task::none, |music| music.update(m)),
            Message::Menu(id, event) => return self.menu_event(id, event),
            Message::Capture(out) => return self.capture_event(out),
            Message::CaptureRun(kind, output, window) => self.capture.act(kind, &output, window, &self.colours),
            Message::CaptureTick => self.capture.tick(),
            Message::Start => match &mut self.start {
                Some(start) => start.open = !start.open,
                None => return self.open_start(),
            },
            Message::Clicked(id, taken) => {
                if let Some(start) = self.start.as_mut().filter(|s| s.id != id) {
                    start.open = false;
                }
                // The bar's bare part, off every button: the panel shuts.
                if !taken && self.screens.values().any(|s| s.strip == id) {
                    self.pop_shut();
                }
            }
            // Every picture painted again in the new colours, at once (as foot's).
            Message::Colours => {
                self.colours = colours::load();
                self.pictures = Pictures::new(&self.colours);
                if let Some(start) = &mut self.start {
                    start.pictures = start::Pictures::new(&self.colours);
                }
                if let Some(p) = &mut self.side {
                    p.pictures = side::Pictures::new(&self.colours);
                }
                if let Some(c) = &mut self.capturing {
                    c.pictures = capture::Pictures::new(&self.colours);
                }
                return self.music.as_mut().map_or_else(Task::none, |music| music.update(music::Msg::colours()));
            }
            // A menu measures its boxes as it lays out and sizes its own surface
            // (`MenuEvent::Span`), so a device coming or going needs nothing here.
            Message::Bluetooth => self.blinking = bluetooth::bluetooth().devices().any(|(_, d)| d.busy.is_some()),
            Message::Volume(by) if by != 0.0 => sound::step(by),
            Message::Mute => sound::mute(!sound::sound().muted),
            Message::Workspace(ws) => niri::act(json!({ "FocusWorkspace": { "reference": { "Id": ws } } })),
            _ => {}
        }
        Task::none()
    }

    /// A panel picked (the shortcut): the drawer slides to it, and the
    /// pick is saved for the next open, a restart too. Leaving Music lets go of its menus
    /// and keys.
    fn pick(&mut self, i: usize) -> Task<Message> {
        if i == self.panel {
            return Task::none();
        }
        let was = std::mem::replace(&mut self.panel, i);
        apps::save(&apps::state("panel"), PANELS[i].to_string());
        match &mut self.music {
            Some(music) if was == MUSIC_PANEL => music.update(music::Msg::away()),
            _ => Task::none(),
        }
    }

    /// A page button on a screen's bar (his picks 2026-11-09): the drawer opens on its
    /// page on that screen, as the shortcut opens it; while open it slides to the page,
    /// or shuts when it shows that page already.
    fn page(&mut self, id: Id, i: usize) -> Task<Message> {
        let Some(output) = self.screen(id).map(|s| s.output().to_string()) else { return Task::none() };
        if self.music.as_ref().is_some_and(music::Music::open) {
            return if i == self.panel { self.music_call(music::bus::Call::Key) } else { self.pick(i) };
        }
        let picked = self.pick(i);
        Task::batch([picked, self.music_call(music::bus::Call::Open(output))])
    }

    /// The shortcut or a page button, to the music box (it holds the top drawer), made on
    /// the first that opens it. Mod+Shift+D opens it on Music.
    fn music_call(&mut self, call: music::bus::Call) -> Task<Message> {
        let open = self.music.as_ref().is_some_and(music::Music::open);
        let picked = match call {
            music::bus::Call::Key if !open => self.pick(MUSIC_PANEL),
            _ => Task::none(),
        };
        let made = match self.music {
            Some(_) => Task::none(),
            None => {
                let (m, task) = music::Music::new();
                self.music = Some(m);
                task
            }
        };
        let m = self.music.as_mut().expect("made above");
        Task::batch([picked, made, m.update(music::Msg::call(call))])
    }

    /// A press on a panel's button (his picks 2026-11-09, Noctalia's): the same button's
    /// open panel shuts; else any panel showing goes at once, with no close (Noctalia's
    /// `openPanel` destroys it), and this one opens under the button with its wipe.
    fn pop(&mut self, id: Id, pop: Pop) -> Task<Message> {
        if self.screen(id).is_some_and(|s| s.menu.is_some() && s.opened && s.shown == pop) {
            self.pop_shut();
            return Task::none();
        }
        let gone: Vec<Id> = self.screens.values_mut().filter_map(|s| s.menu.take()).collect();
        let Some(s) = self.screen(id) else { return Task::none() };
        let id = Id::unique();
        (s.menu, s.shown, s.opened) = (Some(id), pop, true);
        let settings = NewLayerShellSettings {
            anchor: Anchor::Top | Anchor::Left,
            // Over the click sheet (`sheet.rs`, on `Top`), whatever opened first.
            layer: Layer::Overlay,
            // -1 = placed on the whole screen, as the bar, so nothing reserving an edge
            // moves it off its button.
            exclusive_zone: Some(-1),
            // The panel measures its card and places and sizes the surface
            // (`MenuEvent::Span`).
            size: LayerSize::px(1, 1),
            margin: Some(Margin { top: menu::FLOAT_TOP as i32, ..Default::default() }),
            // Its keys (Esc) whatever the pointer is on, as Noctalia's on a compositor
            // with no focus grab.
            keyboard_interactivity: KeyboardInteractivity::Exclusive,
            output_option: OutputOption::Output(s.info.wl_output()),
            namespace: Some("mp-shell-panel".into()),
            ..Default::default()
        };
        Task::batch(gone.into_iter().map(iced::window::close).chain([Task::done(Message::NewLayerShell { settings, id })]))
    }

    /// The floating panel shuts (its wipe back up; the surface goes once it is shut).
    fn pop_shut(&mut self) {
        self.screens.values_mut().for_each(|s| s.opened = false);
    }

    fn menu_event(&mut self, id: Id, event: MenuEvent) -> Task<Message> {
        let Some(s) = self.screens.values_mut().find(|s| s.menu == Some(id)) else { return Task::none() };
        match event {
            MenuEvent::Pick(row) => {
                if s.shown == Pop::Power {
                    self.run(row);
                }
                self.pop_shut();
            }
            MenuEvent::Dismiss => self.pop_shut(),
            MenuEvent::Span { left, size } => {
                let size = LayerSize::px(size.width as u32, size.height as u32);
                let margin = Margin { top: menu::FLOAT_TOP as i32, left: left as i32, ..Default::default() };
                return Task::batch([Task::done(Message::LayoutChange { id, anchor: Anchor::Top | Anchor::Left, size }), Task::done(Message::MarginChange { id, margin })]);
            }
            MenuEvent::Hit(hit) => return input_region(id, hit),
            MenuEvent::Closed if !s.opened => {
                s.menu = None;
                // A look for devices started in the Bluetooth box ends with the last box
                // (Malthaiel's pick 2026-11-05; Caelestia's runs till switched off).
                if self.screens.values().all(|s| s.menu.is_none()) {
                    bluetooth::send(bluetooth::Ask::Look(false));
                }
                return iced::window::close(id);
            }
            MenuEvent::Hover(_) | MenuEvent::Closed | MenuEvent::Size(_) => {}
        }
        Task::none()
    }

    /// The Start menu, made anew on each open: the programs read, their pictures
    /// drawn, one surface the size of its tallest box at the bottom middle of
    /// niri's active screen (the mouse's, by focus-follows-mouse; niri also hands
    /// the keyboard only to a layer on its active screen). It holds the keyboard
    /// while it shows (fuzzel's way), so niri keeps the keyboard on it whatever
    /// window is clicked and tells no one: a click on a window can't close it
    /// (niri 26.04 `update_keyboard_focus`, read 2026-10-30).
    fn open_start(&mut self) -> Task<Message> {
        let apps = apps::load(style::ICON_LG);
        let width = start::widest(&apps);
        let pad = 2.0 * style::MENU_PAD;
        let room = menu::bottom_room(Size::new(width + pad, start::tallest(apps.len()) + pad));
        let size = LayerSize::px(room.width.ceil() as u32, room.height.ceil() as u32);
        let id = Id::unique();
        self.start = Some(Start { id, apps, width, pictures: start::Pictures::new(&self.colours), open: true });
        let settings = NewLayerShellSettings {
            anchor: Anchor::Bottom,
            layer: Layer::Top,
            // Kept clear of the strip's reserved edge, so centred on the rest.
            exclusive_zone: Some(0),
            size,
            keyboard_interactivity: KeyboardInteractivity::Exclusive,
            output_option: OutputOption::Active,
            namespace: Some("mp-shell-start".into()),
            ..Default::default()
        };
        Task::done(Message::NewLayerShell { settings, id })
    }

    fn start_event(&mut self, event: MenuEvent) -> Task<Message> {
        let Some(start) = &mut self.start else { return Task::none() };
        match event {
            MenuEvent::Pick(i) if start.open => {
                start.open = false;
                launch(&start.apps[i]);
                apps::count(&start.apps[i].id);
            }
            MenuEvent::Dismiss => start.open = false,
            MenuEvent::Hit(hit) => return input_region(start.id, hit),
            // Shut: the surface goes, and the list and pictures with it.
            MenuEvent::Closed if !start.open => {
                let id = start.id;
                self.start = None;
                return iced::window::close(id);
            }
            _ => {}
        }
        Task::none()
    }

    /// A power row's command: one click, nothing asks first (Caelestia's session
    /// commands; the lock screen in the strip's colour). Started by niri like a
    /// launched program, so a shell restart (its service) can't stop the lock screen.
    fn run(&self, row: usize) {
        let [r, g, b, _] = self.colours.frame.into_rgba8();
        let colour = format!("{r:02x}{g:02x}{b:02x}");
        let command: &[&str] = match row {
            0 => &["swaylock", "-f", "-c", &colour],
            1 => &["systemctl", "suspend"],
            2 => &["systemctl", "reboot"],
            _ => &["systemctl", "poweroff"],
        };
        niri::act(json!({ "Spawn": { "command": command } }));
    }

    /// The notices' box on every screen (Caelestia's: one per screen, the same
    /// pop-ups), or on just a new screen: one surface each, made while any pops up
    /// (the menu sizes it as they come and go), in the overlay layer so it shows over a
    /// full-screen window, never taking the keyboard.
    fn show_notices(&mut self, only: Option<&OutputId>) -> Task<Message> {
        if self.popups.is_empty() {
            return Task::none();
        }
        let room = menu::corner_room(popups::size(&self.popups));
        let mut tasks = Vec::new();
        for (output, s) in self.screens.iter_mut().filter(|(o, s)| s.notices.is_none() && only.is_none_or(|x| x == *o)) {
            let _ = output;
            let id = Id::unique();
            s.notices = Some(id);
            let settings = NewLayerShellSettings {
                anchor: Anchor::Top | Anchor::Right,
                layer: Layer::Overlay,
                exclusive_zone: Some(0),
                // Under the bar (it reserves its edge), at the screen's right edge: the card
                // keeps its gap inside, so it slides in from behind the edge.
                size: LayerSize::px(room.width as u32, room.height as u32),
                keyboard_interactivity: KeyboardInteractivity::None,
                output_option: OutputOption::Output(s.info.wl_output()),
                namespace: Some("mp-shell-notices".into()),
                ..Default::default()
            };
            tasks.push(Task::done(Message::NewLayerShell { settings, id }));
        }
        Task::batch(tasks)
    }

    fn notices_event(&mut self, id: Id, event: MenuEvent) -> Task<Message> {
        let empty = self.popups.is_empty();
        let Some(s) = self.screens.values_mut().find(|s| s.notices == Some(id)) else { return Task::none() };
        match event {
            MenuEvent::Size(size) => {
                let size = LayerSize::px(size.width as u32, size.height as u32);
                return Task::done(Message::LayoutChange { id, anchor: Anchor::Top | Anchor::Right, size });
            }
            MenuEvent::Hit(hit) => return input_region(id, hit),
            MenuEvent::Closed if empty => {
                s.notices = None;
                return iced::window::close(id);
            }
            _ => {}
        }
        Task::none()
    }

    /// A screen's two side-panel hover zones, empty surfaces in niri's gap at the screen's
    /// edge (`BAR_GAP`, the whole gap, so never over a window; the frame they sat on went
    /// in Noctalia Look step 3): the right edge under the bar, and the bottom edge's right end under
    /// the panel's bottom, plus a window's round corner when niri rounds them, kept off
    /// the right edge.
    fn side_zones(&self, s: &Screen) -> Task<Message> {
        let round = self.corner.round();
        let zone = |anchor, size, margin, namespace: &str| NewLayerShellSettings {
            anchor,
            layer: Layer::Top,
            exclusive_zone: Some(0),
            size,
            margin: Some(margin),
            keyboard_interactivity: KeyboardInteractivity::None,
            output_option: OutputOption::Output(s.info.wl_output()),
            namespace: Some(namespace.into()),
            ..Default::default()
        };
        let band = zone(Anchor::Top | Anchor::Bottom | Anchor::Right, LayerSize::fill_height(style::BAR_GAP as u32), Margin::default(), "mp-shell-side-zone");
        let size = LayerSize::px((popups::WIDTH + round) as u32, (style::BAR_GAP + round) as u32);
        let corner = zone(Anchor::Bottom | Anchor::Right, size, Margin { right: style::BAR_GAP as i32, ..Default::default() }, "mp-shell-switches-zone");
        Task::batch([Task::done(Message::NewLayerShell { settings: band, id: s.side_zone }), Task::done(Message::NewLayerShell { settings: corner, id: s.corner_zone })])
    }

    /// The pointer came onto or left a side-panel zone: opens the panel when none shows,
    /// from either zone (one card since his ask 2026-11-09, "make the right panel one").
    fn side_hover(&mut self, id: Id, on: bool) -> Task<Message> {
        let Some(s) = self.screens.values().find(|s| s.side_zone == id || s.corner_zone == id) else { return Task::none() };
        let band = s.side_zone == id;
        let (output, hole, name) = (OutputOption::Output(s.info.wl_output()), s.hole(), s.output().to_string());
        match &mut self.side {
            // Another screen's panel is left as it is.
            Some(p) if p.output != name => {}
            Some(p) => {
                if band {
                    p.band = on;
                } else {
                    p.corner = on;
                }
            }
            None if on && hole > 0.0 => return self.open_side(band, false, output, hole, name),
            None => {}
        }
        Task::none()
    }

    /// The side panel, one card the hole's height at the right edge (the list over the
    /// recorder and switches), opened from the right band's zone (`band`), the bottom
    /// edge's (neither) or the bell: its surface made on open, its pictures with it. The
    /// list showing clears the corner's pop-ups.
    fn open_side(&mut self, band: bool, bell: bool, output: OutputOption, hole: f32, name: String) -> Task<Message> {
        notices::panel(true);
        let id = Id::unique();
        let list = notices::list();
        let mut drawn = HashMap::new();
        let faces = notices::group_pictures(&list, &mut drawn);
        let panel = Panel {
            id,
            band,
            corner: !band && !bell,
            over: false,
            bell,
            list,
            faces,
            drawn,
            pictures: side::Pictures::new(&self.colours),
            height: menu::side_inner(hole),
            output: name,
            shut: false,
            pinned: false,
            shot: None,
        };
        let settings = NewLayerShellSettings {
            anchor: Anchor::Top | Anchor::Bottom | Anchor::Right,
            layer: Layer::Top,
            exclusive_zone: Some(0),
            // Under the bar (it reserves its edge) to the screen's bottom and right edges:
            // the card keeps its gaps inside, so it slides in from behind the right edge.
            size: LayerSize::fill_height(menu::side_width(popups::WIDTH) as u32),
            keyboard_interactivity: KeyboardInteractivity::None,
            output_option: output,
            namespace: Some("mp-shell-side".into()),
            ..Default::default()
        };
        self.side = Some(panel);
        Task::done(Message::NewLayerShell { settings, id })
    }

    /// The bar's bell: the whole side panel on its screen, held open (`Panel::bell`), or
    /// shut when it shows there; another screen's is left as it is.
    fn bell(&mut self, id: Id) -> Task<Message> {
        let Some(s) = self.screens.values().find(|s| s.strip == id) else { return Task::none() };
        let (output, hole, name) = (OutputOption::Output(s.info.wl_output()), s.hole(), s.output().to_string());
        match &mut self.side {
            Some(p) if p.output == name => p.shut = true,
            Some(_) => {}
            None if hole > 0.0 => return self.open_side(false, true, output, hole, name),
            None => {}
        }
        Task::none()
    }

    fn side_event(&mut self, event: MenuEvent) -> Task<Message> {
        let slot = &mut self.side;
        let Some(p) = slot else { return Task::none() };
        match event {
            MenuEvent::Hover(on) => {
                p.over = on;
                // Opened by the bell: held till the pointer has been on it and left.
                p.bell &= on;
            }
            MenuEvent::Dismiss => p.shut = true,
            // The switches: dark / light (mp-theme taps the shell back), do not disturb.
            MenuEvent::Pick(0) => niri::act(json!({ "Spawn": { "command": ["mp-theme", "toggle"] } })),
            MenuEvent::Pick(side::PIN) => p.pinned = !p.pinned,
            // The capture pills fold the panel and open their pop-up on its screen.
            MenuEvent::Pick(pill @ (side::REC | side::SHOT)) => {
                p.shut = true;
                let output = p.output.clone();
                return self.open_capture(if pill == side::REC { capture::Card::Record } else { capture::Card::Shot }, output);
            }
            // The recorder box: a mode on the panel's screen, pause, stop.
            MenuEvent::Pick(i @ side::START..side::PAUSE) => {
                let (region, sound) = recorder::MODES[i - side::START];
                self.capture.act(capture::Kind::Record { region, sound }, &p.output, None, &self.colours);
            }
            MenuEvent::Pick(side::PAUSE) => self.capture.act(capture::Kind::Pause, &p.output, None, &self.colours),
            MenuEvent::Pick(side::STOP) => self.capture.act(capture::Kind::Stop, &p.output, None, &self.colours),
            // A screenshot button: the panel folds first (a pinned one too).
            MenuEvent::Pick(i @ side::SNAP..) if i < side::SNAP + recorder::SHOTS.len() => {
                p.shot = Some(recorder::SHOTS[i - side::SNAP]);
                p.shut = true;
            }
            MenuEvent::Pick(_) => notices::set_quiet(!notices::quiet()),
            MenuEvent::Hit(hit) => return input_region(p.id, hit),
            MenuEvent::Closed if !p.open() => {
                let (id, shot, output) = (p.id, p.shot, p.output.clone());
                *slot = None;
                notices::panel(false);
                let close = iced::window::close(id);
                // niri's shot once the surface is asked away (the window shot: niri's
                // focused one, as the panel never takes the keyboard).
                let Some(shot) = shot else { return close };
                return close.chain(Task::done(Message::CaptureRun(capture::Kind::Shot(shot), output, None)));
            }
            _ => {}
        }
        Task::none()
    }

    /// The capture pop-up on screen `output`, made on open (Left Strip Return step 5): the
    /// whole screen in the overlay layer, over the strip and a full-screen window, its
    /// windows blurred by niri (the `mp-shell-capture` layer rule, in dots); it holds the
    /// keyboard while it shows, for Esc. The record card brings the replay in line with
    /// his choices (as the panel's open did, `record::sync`); the screenshot card reads
    /// the focused window first, as the pop-up's keyboard hold may change it.
    fn open_capture(&mut self, card: capture::Card, output: String) -> Task<Message> {
        let Some(screen) = self.screens.values().find(|s| s.output() == output) else { return Task::none() };
        if self.capturing.is_some() {
            return Task::none();
        }
        let settings = NewLayerShellSettings {
            anchor: Anchor::Top | Anchor::Bottom | Anchor::Left | Anchor::Right,
            layer: Layer::Overlay,
            exclusive_zone: Some(-1),
            size: LayerSize::FILL,
            keyboard_interactivity: KeyboardInteractivity::Exclusive,
            output_option: OutputOption::Output(screen.info.wl_output()),
            namespace: Some("mp-shell-capture".into()),
            ..Default::default()
        };
        let window = if card == capture::Card::Shot { niri::focused_window() } else { None };
        if card == capture::Card::Record {
            std::thread::spawn(record::sync);
        }
        let id = Id::unique();
        self.capturing = Some(Capturing { id, card, settings: false, output, window, pictures: capture::Pictures::new(&self.colours) });
        Task::done(Message::NewLayerShell { settings, id })
    }

    /// The capture pop-up: a tile closes it and runs its job once the surface is asked
    /// away (so it is in no shot or recording); a setting or its page stays in it.
    fn capture_event(&mut self, out: capture::Out) -> Task<Message> {
        let Some(c) = &mut self.capturing else { return Task::none() };
        match out {
            capture::Out::Page(on) => {
                c.settings = on;
                if on {
                    self.capture.read_screens();
                }
            }
            capture::Out::Set(set) => self.capture.set(set),
            capture::Out::Close => {
                let id = c.id;
                self.capturing = None;
                return iced::window::close(id);
            }
            capture::Out::Act(kind) => {
                let Some(c) = self.capturing.take() else { return Task::none() };
                return iced::window::close(c.id).chain(Task::done(Message::CaptureRun(kind, c.output, c.window)));
            }
        }
        Task::none()
    }

    fn view(&self, id: Id) -> Element<'_, Message> {
        if let Some(c) = self.capturing.as_ref().filter(|c| c.id == id) {
            return self.capture.view(c.card, c.settings, &c.pictures, &self.colours).map(Message::Capture);
        }
        // The top drawer: the panels side by side, the music box's page among them, the
        // view sliding to the one picked (Caelestia's dashboard, Windows' `.dash-row`).
        if let Some(music) = self.music.as_ref().filter(|m| m.shows(id)) {
            let s = music::size();
            return music.view(id, |page| {
                let mut pages: Vec<Element<'_, Message>> = (0..PANELS.len()).map(|_| Space::new().width(s.width).height(s.height).into()).collect();
                pages[MUSIC_PANEL] = page;
                mp_ui::slide::slide(pages, self.panel).into()
            });
        }
        if self.screens.values().any(|s| s.notices == Some(id)) {
            let body = popups::Popups { cards: &self.popups, colours: self.colours, pictures: &self.pictures.notices };
            let menu = Menu::new(vec![(0.0, Box::new(body))], 0, !self.popups.is_empty(), self.corner, self.colours.frame, move |e| Message::Menu(id, e));
            return menu.from_corner().into();
        }
        if let Some(p) = self.side.as_ref().filter(|p| p.id == id) {
            let body = side::Side {
                height: p.height,
                list: &p.list,
                faces: &p.faces,
                quiet: notices::quiet(),
                dark: theme::palette::is_dark(self.colours.frame),
                pinned: p.pinned,
                recording: self.capture.recording(),
                saved: capture::Capture::checked(),
                live: self.capture.live(),
                starting: self.capture.starting(),
                colours: self.colours,
                cards: &self.pictures.notices,
                pictures: &p.pictures,
            };
            let menu = Menu::new(vec![(0.0, Box::new(body))], 0, p.open(), self.corner, self.colours.frame, move |e| Message::Menu(id, e));
            return menu.from_side().into();
        }
        if self.screens.values().any(|s| s.side_zone == id || s.corner_zone == id) {
            return mouse_area(Space::new().width(Fill).height(Fill)).on_enter(Message::Zone(id, true)).on_exit(Message::Zone(id, false)).into();
        }
        if let Some(start) = self.start.as_ref().filter(|s| s.id == id) {
            let body = start::Start { apps: &start.apps, width: start.width, colours: self.colours, pictures: &start.pictures };
            let menu = Menu::new(vec![(0.0, Box::new(body))], 0, start.open, self.corner, self.colours.frame, move |e| Message::Menu(id, e));
            return menu.from_bottom().into();
        }
        let Some(s) = self.screens.values().find(|s| s.strip == id || s.menu == Some(id)) else {
            return Space::new().into();
        };
        let c = &self.colours;
        let d = niri::desktop();
        let sound = sound::sound();
        let net = net::net();
        let bt = bluetooth::bluetooth();
        if s.menu == Some(id) {
            let [prev, next] = &self.pictures.arrows;
            let body: Box<dyn menu::Page> = match s.shown {
                Pop::Clock => Box::new(calendar::Calendar { today: self.now.date(), colours: *c, prev: prev.clone(), next: next.clone() }),
                Pop::Bluetooth => Box::new(bluetooth_menu::Menu { bt: bt.clone(), colours: *c, pictures: &self.pictures.bt_menu }),
                Pop::Sound => Box::new(audio::Audio { sound: sound.clone(), colours: *c }),
                Pop::Power => Box::new(menu::Rows { rows: self.pictures.power_rows.clone(), colours: *c }),
            };
            let middle = s.buttons.iter().find(|(p, _)| *p == s.shown).map_or(0.0, |(_, b)| b.at.center_x());
            let head = menu::Head { title: s.shown.title(), close: self.pictures.close.clone(), colours: *c };
            return Menu::new(vec![(middle, body)], 0, s.opened, self.corner, c.frame, move |e| Message::Menu(id, e)).floating(s.strip_at.width, head).into();
        }
        // A button that opens a floating panel on a press, hovering as its whole room.
        let button = |content: Element<'static, Message>, pop: Pop| {
            let area = mouse_area(content).on_press(Message::Pop(id, pop)).on_enter(Message::ButtonHover(id, pop, true)).on_exit(Message::ButtonHover(id, pop, false)).interaction(mouse::Interaction::Pointer);
            let area = match pop {
                // His picks 2026-10-30: the wheel turns the volume (Caelestia's bar),
                // a middle-click mutes.
                Pop::Sound => area
                    .on_scroll(|delta| {
                        let (mouse::ScrollDelta::Lines { y, .. } | mouse::ScrollDelta::Pixels { y, .. }) = delta;
                        Message::Volume(if y == 0.0 { 0.0 } else { audio::WHEEL.copysign(y) })
                    })
                    .on_middle_press(Message::Mute),
                _ => area,
            };
            measured(area, move |at| Message::ButtonAt(id, pop, at))
        };
        // Lit while hovered, and while its panel shows.
        let over = |pop: Pop| s.buttons.iter().any(|(p, b)| *p == pop && b.over) || (s.opened && s.menu.is_some() && s.shown == pop);
        let p = &self.pictures;
        let pad = style::BAR_PAD;
        let pic = |h: &image::Handle| image(h.clone()).width(style::ICON).height(style::ICON);
        // Noctalia's hover: a patch of the text colour over what the pointer is on.
        let patch = c.text.scale_alpha(style::HOVER);
        let lit = move |on: bool| move |_: &Theme| container::Style { background: on.then(|| patch.into()), ..Default::default() };
        // A box: `raised`, no line round it (his ask 2026-11-09, late: the line went).
        let raised = c.raised;
        let boxed = move |_: &Theme| container::Style { background: Some(raised.into()), ..Default::default() };

        // Left: the workspace marks, this screen's workspaces in niri's order.
        let marks = d
            .workspaces
            .iter()
            .filter(|w| w.output == s.output())
            .map(|w| {
                let kind = match () {
                    _ if w.active => Kind::Current,
                    _ if d.windows.iter().any(|x| x.workspace == Some(w.id)) => Kind::Windows,
                    _ => Kind::Empty,
                };
                (w.id, kind)
            })
            .collect();
        let left = Workspaces { marks, colours: *c, on_click: Box::new(Message::Workspace) };

        // A shared box's member: its room reaches half way to the next and to the box's end.
        let cell = |content: Element<'static, Message>, left: f32, right: f32| -> Element<'static, Message> { container(content).padding(iced::Padding { left, right, ..iced::Padding::ZERO }).center_y(style::BAR_BOX).into() };
        let half = pad / 2.0;
        // `BAR_GAP` beside every box and bare picture, to what it draws; boxes keep their insides.
        let gap = style::BAR_GAP;
        // A patch `w` wide from `at` in a shared box, `BAR_INSET` short of its top and bottom.
        let patch_at = |at: f32, w: f32| row![Space::new().width(at), container(Space::new().width(w).height(style::BAR_BOX - 2.0 * style::BAR_INSET)).style(lit(true))].padding([style::BAR_INSET, 0.0]);

        // Middle: search (the Start menu), the clock's box, the shortcuts button (niri's own
        // list; his ask 2026-11-09); outside a box each picture has a room of its own
        // (Noctalia's ghost pill) whose drawing sits `gap` from the box. The clock's box holds the clock, hooxoo's grip (a
        // picture only, his pick) and the weather (`weather.rs`: its sky picture, `GAP_1`
        // (Noctalia's `spaceXs`), the °F), `pad` apart; the grip and the weather do nothing
        // (his pick). A patch reaches half a `pad` past what it covers (Noctalia's full `pad`
        // touched the next picture, his photo 2026-11-09): the clock's as it hovers and
        // drops its menu.
        let search_pad = gap - icon::side_blank(&p.search).1;
        let search = mp_ui::ask::press(pic(&p.search), style::BAR_BOX, search_pad, Color::TRANSPARENT, c.text, Message::Search);
        let clock = button(cell(text(self.now.time()).size(style::BAR_TEXT).font(MEDIUM).into(), pad, half), Pop::Clock);
        let (sky, words) = self.weather.shown();
        let weather = row![pic(&p.weather[sky as usize]), text(words).size(style::BAR_TEXT).font(MEDIUM)].spacing(style::GAP_1).align_y(Center);
        // The page buttons (his picks 2026-11-09), their own box right of the workspace
        // marks: Dashboard, Music, Performance. While the drawer shows, its page's button sits
        // on an accent block (Noctalia's picked tab) the patch's size, its picture in
        // On Accent; the hovered other one gets the patch. Each room is the patch's size, so
        // each draws its own; the box adds the other half `pad` at its ends. A press opens,
        // slides or shuts (`page`).
        let open = self.music.as_ref().is_some_and(music::Music::open).then_some(self.panel);
        let accent = c.accent;
        let pages = p.pages.iter().enumerate().map(|(i, [plain, lit])| {
            let (picture, fill) = match () {
                _ if open == Some(i) => (lit, Some(accent)),
                _ if s.page_over == Some(i) => (plain, Some(patch)),
                _ => (plain, None),
            };
            let room = container(pic(picture)).center_x(style::ICON as f32 + pad).center_y(style::BAR_BOX - 2.0 * style::BAR_INSET).style(move |_: &Theme| container::Style { background: fill.map(Into::into), ..Default::default() });
            mouse_area(container(room).padding([style::BAR_INSET, 0.0])).on_press(Message::Page(id, i)).on_enter(Message::PageHover(id, i, true)).on_exit(Message::PageHover(id, i, false)).interaction(mouse::Interaction::Pointer).into()
        });
        let pages = container(row(pages)).padding([0.0, half]).style(boxed);
        let members = row![clock, cell(pic(&p.grip).into(), half, half), cell(weather.into(), half, pad)];
        let clock_w = s.buttons.iter().find(|(p, _)| *p == Pop::Clock).map_or(0.0, |(_, b)| b.at.width);
        let spot = over(Pop::Clock).then(|| patch_at(half, (clock_w - half).max(0.0)));
        let clock = container(stack(std::iter::once(Element::from(members)).chain(spot.map(Element::from)))).style(boxed);
        let keys = mp_ui::ask::press(pic(&p.keys), style::BAR_BOX, gap - icon::side_blank(&p.keys).0, Color::TRANSPARENT, c.text, Message::Keys);
        let middle = row![search, measured(clock, move |at| Message::MiddleAt(id, at)), keys].align_y(Center);

        // Right: one box of the bell, network, Bluetooth and the speaker, `pad` apart; each
        // takes the room half way to the next and the box's end, and its patch (Noctalia's
        // per-member hover in a shared box) reaches half a `pad` past its picture (Noctalia's
        // full `pad` touched the next picture, his photo 2026-11-09), `BAR_INSET` short of
        // the box's top and bottom. Then power, last on the bar (his ask 2026-11-09), in a
        // room of its own.
        // Bluetooth, then a picture for each device connected or being (dis)connected,
        // blinking while a call to it waits (Caelestia's `BluetoothStatus`): one button.
        let now = iced::time::Instant::now();
        let devices: Vec<Element<'static, Message>> =
            bt.devices().filter(|(_, d)| d.connected || d.busy.is_some()).map(|(_, d)| pic(&p.bt_devices[bluetooth_menu::kind(&d.icon)]).opacity(d.busy.map_or(1.0, |since| blink(since, now))).into()).collect();
        let blue_w = style::ICON as f32 + devices.len() as f32 * (style::ICON as f32 + pad);
        let blue = row(std::iter::once(pic(&p.bluetooth[bluetooth(&bt)]).into()).chain(devices)).spacing(pad);
        let bell = mouse_area(cell(pic(&p.bell).into(), pad, half)).on_press(Message::Bell(id)).on_enter(Message::BellHover(id, true)).on_exit(Message::BellHover(id, false)).interaction(mouse::Interaction::Pointer);
        let members =
            row![bell, cell(pic(&p.network[network(net)]).into(), half, half), button(cell(blue.into(), half, half), Pop::Bluetooth), button(cell(pic(&p.speaker[speaker(sound.volume.into(), sound.muted)]).into(), half, pad), Pop::Sound),];
        let mut x = pad;
        let mut shown = None;
        for (w, on) in [(style::ICON as f32, s.bell), (style::ICON as f32, false), (blue_w, over(Pop::Bluetooth)), (style::ICON as f32, over(Pop::Sound))] {
            if on {
                shown = Some((x - half, w + pad));
            }
            x += w + pad;
        }
        let spot = shown.map(|(at, w)| {
            let at = at.max(0.0);
            patch_at(at, w.min(x - at))
        });
        let status = container(stack(std::iter::once(Element::from(members)).chain(spot.map(Element::from)))).style(boxed);
        let (l, r) = icon::side_blank(&p.power);
        let power = container(pic(&p.power)).padding(iced::Padding { left: gap - l, right: gap - r, ..iced::Padding::ZERO }).center_y(style::BAR_BOX).style(lit(over(Pop::Power)));
        let power = button(power.into(), Pop::Power);
        let right = row![status, power].align_y(Center);

        // The clock box centred on the bar on whole pixels once both are measured.
        let at = ((s.strip_at.width - s.middle) / 2.0).floor() - (style::ICON as f32 + 2.0 * search_pad);
        // Left: the workspace marks `gap` from the screen's edge, then the page buttons' box
        // `gap` after (his asks 2026-11-09).
        let left = row![Space::new().width(gap), left, Space::new().width(gap), pages].align_y(Center);
        let left = container(left).width(if s.middle > 0.0 && at > 0.0 { Length::Fixed(at) } else { Length::Fill });
        let bar = row![left, middle, Space::new().width(Fill), right].align_y(Center);
        let (frame, fg) = (c.frame, c.text);
        let bar = container(bar).width(Fill).height(Fill).align_y(Center).style(move |_| container::Style { background: Some(frame.into()), text_color: Some(fg), ..Default::default() });
        measured(bar, move |at| Message::StripAt(id, at)).into()
    }
}

/// A device's picture while a call to it waits: out and back in, each half the rulebook's
/// move on its curve (Caelestia's: 600 ms each, accelerating out, slowing in).
fn blink(since: iced::time::Instant, now: iced::time::Instant) -> f32 {
    let half = motion::SPATIAL.duration().as_secs_f32();
    let t = now.saturating_duration_since(since).as_secs_f32() % (2.0 * half) / half;
    if t < 1.0 { 1.0 - motion::SPATIAL.at(t) } else { motion::SPATIAL.at(t - 1.0) }
}

/// The part of a menu's surface that takes the mouse: its shown box.
fn input_region(id: Id, hit: Rectangle) -> Task<Message> {
    let region = RegionActionCB::new(move |region| {
        let _ = region.add(hit.x as i32, hit.y as i32, hit.width as i32, hit.height as i32);
    });
    Task::done(Message::SetInputRegion { id, callback: region })
}

/// A program started by niri (`Spawn`), so it is niri's child, not the shell's;
/// one made for a terminal starts inside foot.
fn launch(app: &apps::App) {
    let command: Vec<&str> = app.terminal.then_some("foot").into_iter().chain(app.exec.iter().map(String::as_str)).collect();
    niri::act(json!({ "Spawn": { "command": command } }));
}
