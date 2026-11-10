//! The capture pop-ups (Left Strip Return plan step 5, Malthaiel's asks 2026-11-05; the
//! process side is `record.rs`, recordings are the side panel's box, `recorder.rs`).
//! Quick toggles' [replay] and [camera] pills (`side.rs`) fold the panel and open one,
//! centred on that screen over its windows, blurred (niri's layer rule on
//! `mp-shell-capture`, in dots) and faded to the frame colour
//! (`mp_ui::ask::over`): a card (`ask::bare`) of square picture buttons, no words
//! anywhere but the settings page (Malthaiel's ask 2026-11-05): a 28 picture padded
//! gap-3 (`mp_ui::ask::press`).
//!
//! - Instant replay (his pick 2026-11-05: the replay alone, recordings went to the
//!   box): save the last 30 s / 1 min / 2 min (greyed while the replay is off),
//!   Settings. While a recording runs the time shows on the panel's pill.
//! - Screenshot: Whole screen, Region (niri's own picker), Window (the one focused as
//!   the pop-up opened), Files.
//!
//! A button closes the pop-up, and its job runs once the surface is gone, so no shot or
//! recording has it in. Settings slides a page in inside the card (`mp_ui::slide`, Back
//! slides it out): Instant replay on / off and its sound (the switch,
//! `mp_ui::switch::toggle`), its length and its screen (`mp_ui::drop::menu`'s rows, a
//! check on the picked one). Esc or a click off the card closes it.
//!
//! One `Capture` (what runs) serves the panel, its recorder box and the pop-ups. Nothing
//! runs at rest: /proc is read ten times a second only while a start, stop or save is
//! awaited (or a saved clip's check shows), once a second while a recording runs.

use std::sync::atomic::Ordering::Relaxed;
use std::thread;
use std::time::Duration;

use iced::futures::channel::mpsc;
use iced::time::Instant;
use iced::widget::{column, container, image, row, space, text};
use iced::{Alignment, Element, Length, Subscription, border};
use mp_ui::drop::{self, Item, Pair};
use mp_ui::style::{BODY, CONTROL, CORNER, GAP_1, GAP_2, GAP_3, ICON, ICON_LG, LINE_TIGHT};
use mp_ui::{ask, slide, switch};
use serde_json::json;

use crate::colours::Colours;
use crate::icon;
use crate::niri;
use crate::record::{self, LENGTHS, Live, SAVED};

/// /proc read while a start, stop or save is awaited, a start or stop given up after;
/// once a second while a recording runs (its clock's pace). A save is waited for longer.
const POLL: u64 = 100;
const SECOND: u64 = 1000;
const GIVE_UP: Duration = Duration::from_secs(2);
const SAVE_WAIT: Duration = Duration::from_secs(10);
/// How long a saved clip's check shows, in ms.
const CHECKED: u64 = 1500;

/// A tile's side: its picture padded gap-3 all round.
const TILE: f32 = 2.0 * GAP_3 + ICON_LG as f32;

/// The replay's lengths' words, as `LENGTHS`; the settings page's switches' words.
const LENGTH_WORDS: [&str; 3] = ["30 seconds", "1 minute", "2 minutes"];
const SWITCHES: [&str; 2] = ["Instant replay", "Replay sound"];

/// Which pop-up: the instant replay's or the screenshots'.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Card {
    Record,
    Shot,
}

/// niri's own screenshots, as his keys Print / Super+Shift+S / Alt+Print.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Shot {
    Screen,
    Region,
    Window,
}

/// A tile's job.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Replay,
    /// A recording of the whole screen, or of an area picked first (slurp), with or
    /// without the PC's sound (the side panel's box).
    Record {
        region: bool,
        sound: bool,
    },
    Stop,
    Pause,
    Shot(Shot),
    /// The screenshots' folder, in mp-files.
    Files,
}

/// A setting flipped or picked on the settings page.
#[derive(Debug, Clone, PartialEq)]
pub enum Set {
    ReplayOn,
    ReplaySound,
    Length(u32),
    /// niri's name for the screen the replay films.
    Screen(String),
}

/// What a pop-up tells the shell.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Act(Kind),
    Set(Set),
    /// The settings page in (true) or out.
    Page(bool),
    Close,
}

/// The pop-ups' pictures, drawn as one opens (and on a recolour).
pub struct Pictures {
    /// Instant replay, plain and greyed (the replay off).
    replay: [image::Handle; 2],
    full: image::Handle,
    region: image::Handle,
    window: image::Handle,
    files: image::Handle,
    settings: image::Handle,
    /// The settings page's Back, and its rows' (plain, lit): a length, a screen, the check.
    back: image::Handle,
    length: Pair,
    screen: Pair,
    check: Pair,
}

impl Pictures {
    pub fn new(c: &Colours) -> Self {
        let big = |svg: &[u8]| icon::svg(svg, ICON_LG, c.text);
        let pair = |svg: &[u8]| Pair::new(svg, ICON, c.text, c.on_accent);
        let replay = include_bytes!("../assets/bx-repeat.svg");
        Self {
            replay: [big(replay), icon::svg(replay, ICON_LG, c.text_faint)],
            full: big(include_bytes!("../assets/bx-fullscreen.svg")),
            region: big(include_bytes!("../assets/bx-square-dashed.svg")),
            window: big(include_bytes!("../assets/bx-window.svg")),
            files: big(include_bytes!("../assets/bx-folder.svg")),
            settings: big(include_bytes!("../assets/bx-cog.svg")),
            back: icon::svg(include_bytes!("../assets/bx-chevron-left.svg"), ICON, c.text),
            length: pair(include_bytes!("../assets/bx-clock.svg")),
            screen: pair(include_bytes!("../assets/bx-desktop.svg")),
            check: pair(include_bytes!("../assets/bx-check.svg")),
        }
    }
}

/// A start or stop asked for and not yet seen in /proc.
#[derive(Clone, Copy)]
enum Wait {
    /// Asked at, and slurp last seen at (an area being picked).
    Start(Instant, Instant),
    Stop(Instant),
}

/// What runs, as of the last read: one for the panel and the pop-ups.
pub struct Capture {
    live: Option<Live>,
    wait: Option<Wait>,
    /// A clip asked for at, and `SAVED` then: waited for till it changes.
    saving: Option<(Instant, u64)>,
    /// A recording's clock, as the panel's pill shows it.
    time: String,
    /// His replay choices, and niri's screens to pick from (read as the settings first
    /// show).
    want: record::Want,
    screens: Vec<(String, String, u64)>,
}

impl Capture {
    /// Read live as the shell starts (a recording outlives a shell restart).
    pub fn new() -> Self {
        let mut c = Self { live: record::look().live, wait: None, saving: None, time: String::new(), want: record::want(), screens: Vec::new() };
        c.clock();
        c
    }

    fn clock(&mut self) {
        if let Some(l) = self.live {
            self.time = record::clock(l.filmed(record::now_ms()));
        }
    }

    /// A recording's clock while one runs.
    pub fn recording(&self) -> Option<&str> {
        self.live.map(|_| self.time.as_str())
    }

    /// The recording running, and a start asked for and not yet seen (the box's state).
    pub fn live(&self) -> Option<Live> {
        self.live
    }

    pub fn starting(&self) -> bool {
        matches!(self.wait, Some(Wait::Start(..)))
    }

    /// A clip saved a moment ago: the replay picture shows a check.
    pub fn checked() -> bool {
        record::now_ms().saturating_sub(SAVED.load(Relaxed)) < CHECKED
    }

    /// How often it wants reading now, in ms; none at rest.
    fn pace(&self) -> Option<u64> {
        if self.wait.is_some() || self.saving.is_some() || Self::checked() { Some(POLL) } else { self.live.map(|_| SECOND) }
    }

    /// Its reads, on a thread of their own at `pace` (as the clock's minutes).
    pub fn ticks(&self) -> Subscription<()> {
        self.pace().map_or_else(Subscription::none, |ms| {
            Subscription::run_with(ms, |&ms| {
                let (mut tx, rx) = mpsc::channel(1);
                thread::spawn(move || {
                    while !tx.is_closed() {
                        thread::sleep(Duration::from_millis(ms));
                        let _ = tx.try_send(());
                    }
                });
                rx
            })
        })
    }

    /// Reads /proc: a start or stop seen (or given up on), a save landed, the clock.
    pub fn tick(&mut self) {
        let now = Instant::now();
        if let Some((asked, was)) = self.saving
            && (SAVED.load(Relaxed) != was || now > asked + SAVE_WAIT)
        {
            self.saving = None;
        }
        match self.wait {
            Some(Wait::Start(asked, slurp)) => {
                let seen = record::look();
                let slurp = if seen.picking { now } else { slurp };
                self.live = seen.live;
                self.wait = (self.live.is_none() && now < asked.max(slurp) + GIVE_UP).then_some(Wait::Start(asked, slurp));
            }
            Some(Wait::Stop(asked)) => {
                self.live = self.live.and_then(|l| l.again());
                if self.live.is_none() || now > asked + GIVE_UP {
                    self.wait = None;
                }
            }
            None => self.live = self.live.and_then(|l| l.again()),
        }
        self.clock();
    }

    /// A tile's or the box's job, run once the pop-up has gone: a recording films
    /// `output` (the box's screen), a window shot takes `window` (focused as it opened).
    pub fn act(&mut self, kind: Kind, output: &str, window: Option<u64>, c: &Colours) {
        let now = Instant::now();
        match kind {
            Kind::Replay => {
                self.saving = Some((now, SAVED.load(Relaxed)));
                record::save();
            }
            Kind::Record { region, sound } => {
                record::start(output, region, sound, c.accent, c.frame);
                self.wait = Some(Wait::Start(now, now));
            }
            Kind::Stop => {
                if let Some(l) = self.live {
                    record::stop(&l);
                    self.wait = Some(Wait::Stop(now));
                }
            }
            Kind::Pause => {
                if let Some(l) = self.live {
                    self.live = record::pause(&l);
                    self.clock();
                }
            }
            Kind::Shot(shot) => niri::act(match shot {
                Shot::Screen => json!({ "ScreenshotScreen": { "write_to_disk": true, "show_pointer": true, "path": null } }),
                Shot::Region => json!({ "Screenshot": { "show_pointer": true, "path": null } }),
                Shot::Window => json!({ "ScreenshotWindow": { "id": window, "write_to_disk": true, "show_pointer": false, "path": null } }),
            }),
            Kind::Files => record::show(&record::shots_folder()),
        }
    }

    /// A setting flipped or picked: the replay is brought in line at once.
    pub fn set(&mut self, set: Set) {
        let w = &mut self.want;
        match set {
            Set::ReplayOn => w.on = !w.on,
            Set::ReplaySound => w.sound = !w.sound,
            Set::Length(secs) => w.secs = secs,
            Set::Screen(name) => w.screen = name,
        }
        record::set_want(w);
    }

    /// niri's screens, for the replay's screen rows: read as the settings first show.
    pub fn read_screens(&mut self) {
        if self.screens.is_empty() {
            self.screens = niri::screens();
        }
    }

    /// The card's tiles: picture and job (none: greyed).
    fn tiles<'a>(&'a self, card: Card, p: &'a Pictures) -> Vec<(&'a image::Handle, Option<Out>)> {
        let act = |k| Some(Out::Act(k));
        match card {
            Card::Shot => vec![(&p.full, act(Kind::Shot(Shot::Screen))), (&p.region, act(Kind::Shot(Shot::Region))), (&p.window, act(Kind::Shot(Shot::Window))), (&p.files, act(Kind::Files))],
            Card::Record => {
                let on = self.want.on;
                vec![(&p.replay[!on as usize], on.then_some(Out::Act(Kind::Replay))), (&p.settings, Some(Out::Page(true)))]
            }
        }
    }

    /// The pop-up: card `card` (with its settings page in), centred on the screen faded
    /// to the frame colour; it glides to the shown page's size.
    pub fn view<'a>(&'a self, card: Card, settings: bool, p: &'a Pictures, c: &Colours) -> Element<'a, Out> {
        let row = row(self.tiles(card, p).into_iter().map(|(picture, on)| tile(picture, on, c))).spacing(GAP_2);
        let inside: Element<'a, Out> = match card {
            Card::Shot => row.into(),
            Card::Record => slide::slide(vec![row.into(), self.settings(p, c)], settings as usize).into(),
        };
        ask::over(ask::bare(inside, c), Out::Close, c)
    }

    /// The settings page: Back, the switches, the replay's lengths and screens; as wide
    /// as its widest part, measured (the rows' menu, or a switch's words and the switch).
    fn settings<'a>(&'a self, p: &'a Pictures, c: &Colours) -> Element<'a, Out> {
        let c = *c;
        let words = |s: &'a str| text(s).size(BODY).line_height(LINE_TIGHT).color(c.text);
        let back = row![image(p.back.clone()).width(ICON).height(ICON), words("Back")].spacing(GAP_1).align_y(Alignment::Center);
        let back = ask::press(back, CONTROL, GAP_3, c.panel, c.text, Out::Page(false));
        let switch = |label: &'a str, on: bool, set: Set| row![words(label), space::horizontal(), switch::toggle(on, &c, Out::Set(set))].align_y(Alignment::Center).height(CONTROL);
        let want = &self.want;
        let mut rows = vec![Item::Header("Replay length")];
        rows.extend(LENGTHS.iter().zip(LENGTH_WORDS).map(|(&secs, label)| Item::Row(drop::Row { icon: p.length.clone(), label, after: None, picked: want.secs == secs, pick: Out::Set(Set::Length(secs)) })));
        rows.push(Item::Header("Replay screen"));
        rows.extend(self.screens.iter().map(|(name, model, _)| Item::Row(drop::Row { icon: p.screen.clone(), label: model.as_str(), after: None, picked: want.screen == *name, pick: Out::Set(Set::Screen(name.clone())) })));
        let labels = SWITCHES.iter().map(|l| drop::text_width(l, text::Shaping::Auto)).fold(0.0, f32::max);
        let w = drop::width(&rows).max(labels + GAP_3 + switch::size().width).ceil();
        column![back, switch(SWITCHES[0], want.on, Set::ReplayOn), switch(SWITCHES[1], want.sound, Set::ReplaySound), drop::menu(rows, Some(&p.check), c),].spacing(GAP_2).width(w).into()
    }
}

/// A tile: its picture, square, on the panel colour; no job greys it (its picture faint)
/// and nothing presses it.
fn tile<'a>(picture: &image::Handle, on: Option<Out>, c: &Colours) -> Element<'a, Out> {
    let inside = image(picture.clone()).width(ICON_LG).height(ICON_LG);
    match on {
        Some(on) => ask::press(inside, TILE, GAP_3, c.panel, c.text, on),
        None => {
            let face = c.panel;
            container(container(inside).center_y(Length::Fill)).height(TILE).padding([0.0, GAP_3]).style(move |_| container::Style { background: Some(face.into()), border: border::rounded(CORNER), ..Default::default() }).into()
        }
    }
}
