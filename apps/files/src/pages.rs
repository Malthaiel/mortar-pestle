//! The File Explorer's step 2 views: the left column (Recents, the places, the Bin,
//! pinned folders), the Recents page (copies at work on top with a bar and a stop
//! button, then every action with its Undo or Redo), the Bin page, the right-click
//! menus, and the boxes (rename under the file, new folder, delete forever, empty
//! the Bin, a name clash), all `mp_ui::ask`.

use iced::widget::{column, container, image, mouse_area, progress_bar, row, space, stack, text, text_input};
use iced::{Alignment, Color, Element, Length, Point, border, mouse, window};
use mp_ui::MEDIUM;
use mp_ui::ask;
use mp_ui::bar::{self, Bar};
use mp_ui::drag::Reorder;
use mp_ui::drop::{self, Item};
use mp_ui::icon::Pair;
use mp_ui::pill::Highlight;
use mp_ui::style::{BODY, CONTROL, CORNER, FADED, GAP_1, GAP_2, GAP_3, ICON, LINE, LINE_TIGHT, SMALL, TITLE};

use crate::acts::{key, name_note};
use crate::ops::{Kind, Pick};
use crate::recents::Act;
use crate::{Ask, DATE_W, DRAG_PICTURE, Do, Drag, Files, Message, Page, ROWS, Spot, Target, Win, folder, kind, landing, places, row_height, show_name};

const WHERE_W: f32 = 220.0;

impl Files {
    /// The left column: the title, then Recents, the places, the Bin and the pinned
    /// folders on the accent pill, resting on what's shown. A pin held a moment
    /// lifts and drags into a new place among the pins (`drag::Reorder`, the
    /// Library playlist's way: the pill stands down, the held row wears the accent).
    pub(crate) fn side<'a>(&'a self, id: window::Id, w: &'a Win) -> Element<'a, Message> {
        let c = self.colours;
        let pic = &self.pictures;
        // Each row's spot: where a drag dropped on it lands (Recents takes none).
        let mut rows: Vec<(String, &Pair, Message, Option<Message>, Option<Spot>)> = vec![("Recents".into(), &pic.history, Message::Page(id, Page::Recents), None, None)];
        rows.extend(self.places.iter().map(|p| (p.name.to_string(), &pic.places[p.picture], Message::Go(id, p.path.clone()), None, Some(Spot::Folder(p.path.clone())))));
        rows.push(("Bin".into(), &pic.trash, Message::Page(id, Page::Bin), None, Some(Spot::Bin)));
        rows.extend(self.pins.iter().enumerate().map(|(i, p)| (show_name(p), &pic.pinned, Message::Go(id, p.clone()), Some(Message::PinMenu(id, i)), Some(Spot::Folder(p.clone())))));
        let over = w.drag.as_ref().and_then(|d| d.over.as_ref());
        let here = match w.page {
            Page::Recents => Some(0),
            Page::Bin => Some(self.places.len() + 1),
            Page::Folder => self.places.iter().position(|p| p.path == w.folder).map(|i| i + 1).or_else(|| self.pins.iter().position(|p| *p == w.folder).map(|i| i + self.places.len() + 2)),
        };
        // Recents, the places and the Bin stay put; the pins after them move.
        let fixed = self.places.len() + 2;
        let draw = |lit: bool| -> Vec<Element<'a, Message>> {
            rows.iter()
                .enumerate()
                .map(|(i, (name, pair, go, right, spot))| {
                    let held = !lit && w.lifted == Some(i);
                    let colour = if lit || held { c.on_accent } else { c.text };
                    let line =
                        row![image(pair.get(lit || held)).width(ICON as f32).height(ICON as f32), text(name.clone()).size(BODY).line_height(LINE_TIGHT).color(colour).wrapping(text::Wrapping::None)].spacing(GAP_3).align_y(Alignment::Center);
                    let target = spot.is_some() && spot.as_ref() == over;
                    let cell = container(line).padding([0.0, GAP_3]).height(CONTROL).width(Length::Fill).align_y(Alignment::Center).clip(true).style(move |_| container::Style {
                        background: held.then(|| c.accent.into()),
                        border: landing(target, c),
                        ..Default::default()
                    });
                    if lit || held {
                        return cell.into();
                    }
                    // A pin opens on the release, so a hold can lift it first.
                    let m = mouse_area(cell);
                    let mut m = if i >= fixed { m.on_release(go.clone()) } else { m.on_press(go.clone()) }.interaction(mouse::Interaction::Pointer);
                    if let Some(r) = right {
                        m = m.on_right_press(r.clone());
                    }
                    if let Some(s) = spot {
                        m = m.on_enter(Message::Spot(id, s.clone(), true)).on_exit(Message::Spot(id, s.clone(), false));
                    }
                    m.into()
                })
                .collect()
        };
        let plain = Reorder::new(draw(false)).pinned(fixed).on_drag(move |i| Message::Lift(id, i), move |from, to| Message::MovePin(id, from.saturating_sub(fixed), to.saturating_sub(fixed)));
        let title = container(text("File Explorer").size(BODY).color(c.text)).height(bar::THICK).padding([0.0, GAP_3]).align_y(Alignment::Center);
        column![title, Highlight::new(plain, column(draw(true)), here, None, &c).corner(CORNER).off(w.lifted.is_some())].spacing(GAP_2).into()
    }

    /// The dragged things under the pointer (GNOME Files' pile): up to four pictures,
    /// the first on top, each under it a step down and the other way across (10 px
    /// for two, 6 for three, 4 for more; 6 across), and when there are two or more
    /// their count on the accent at the pile's foot. Hung a gap from the pointer.
    pub(crate) fn drag_view<'a>(&'a self, d: &'a Drag) -> Element<'a, Message> {
        let c = self.colours;
        let n = d.pictures.len();
        let down = match n {
            2 => 10.0,
            3 => 6.0,
            4.. => 4.0,
            _ => 0.0,
        };
        let side = DRAG_PICTURE as f32;
        let (width, height) = (side + 6.0, side + down * n.saturating_sub(1) as f32);
        let place = |left: f32, top: f32| iced::Padding { left, top, ..iced::Padding::ZERO };
        let mut pile: Vec<Element<'a, Message>> = (0..n).rev().map(|k| container(image(d.pictures[k].get(false)).width(side).height(side)).padding(place(if k % 2 == 1 { 6.0 } else { 0.0 }, down * k as f32)).into()).collect();
        if d.paths.len() > 1 {
            let count = if d.paths.len() > 9999 { "9999+".to_string() } else { d.paths.len().to_string() };
            let badge = container(text(count).size(SMALL).line_height(LINE_TIGHT).color(c.on_accent)).padding([GAP_1, GAP_2]).style(move |_| container::Style {
                background: Some(c.accent.into()),
                border: border::rounded(SMALL),
                ..Default::default()
            });
            pile.push(container(badge).width(width).height(height).align_x(Alignment::End).align_y(Alignment::End).into());
        }
        let pile = stack(pile).width(width).height(height);
        container(container(pile).padding(place(d.at.x + GAP_2, d.at.y + GAP_2))).width(Length::Fill).height(Length::Fill).into()
    }

    /// A small text button on the default bar (Undo, Redo, Empty Bin); faded and
    /// still when it can't be used.
    pub(crate) fn word_button<'a>(&self, words: &'a str, on: Option<Message>) -> Element<'a, Message> {
        let c = self.colours;
        let piece = |colour: Color| container(text(words).size(BODY).line_height(LINE_TIGHT).color(colour)).padding([0.0, GAP_2]).height(bar::SLOT).align_y(Alignment::Center);
        match on {
            Some(m) => Bar::new(vec![mouse_area(piece(c.text)).on_press(m).interaction(mouse::Interaction::Pointer).into()], vec![piece(c.on_accent).into()], None, None, &c).across().into(),
            None => Bar::new(vec![piece(Color { a: FADED, ..c.text }).into()], vec![piece(Color { a: FADED, ..c.text }).into()], None, None, &c).across().into(),
        }
    }

    /// Recents: copies at work first (a bar, the share done, a stop button), then
    /// every action newest first with when, and Undo or Redo while it can be.
    pub(crate) fn recents_view<'a>(&'a self, id: window::Id, w: &'a Win) -> Element<'a, Message> {
        let c = self.colours;
        let pic = &self.pictures;
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        for j in &self.jobs {
            let names: Vec<String> = j.pairs.iter().filter_map(|(f, _)| f.file_name()).map(|n| n.to_string_lossy().into_owned()).collect();
            let what = if names.len() == 1 { format!("\u{201c}{}\u{201d}", names[0]) } else { format!("{} items", names.len()) };
            let to = j.pairs.first().and_then(|(_, t)| t.parent()).map(show_name).unwrap_or_default();
            let verb = if j.kind == Kind::Copy { "Copying" } else { "Moving" };
            let share = if j.total > 0 { (j.done as f32 / j.total as f32).min(1.0) } else { 0.0 };
            let stop = mouse_area(bar::icon(pic.stop.get(false))).on_press(Message::Stop(j.id)).interaction(mouse::Interaction::Pointer);
            let top = row![
                image(if j.kind == Kind::Copy { &pic.copy } else { &pic.cut }.get(false)).width(ICON as f32).height(ICON as f32),
                text(format!("{verb} {what} to {to}")).size(BODY).line_height(LINE_TIGHT).color(c.text).wrapping(text::Wrapping::None).width(Length::Fill),
                text(format!("{}%", (share * 100.0) as u32)).size(SMALL).color(c.text_muted),
                Bar::new(vec![stop.into()], vec![bar::icon(pic.stop.get(true))], None, None, &c).across(),
            ]
            .spacing(GAP_3)
            .align_y(Alignment::Center);
            let thin = progress_bar(0.0..=1.0, share).girth(GAP_1).style(move |_| progress_bar::Style { background: c.raised.into(), bar: c.accent.into(), border: border::rounded(GAP_1 / 2.0) });
            parts.push(container(column![top, thin].spacing(GAP_2)).padding([GAP_2, GAP_3]).into());
        }
        if self.recents.is_empty() {
            if parts.is_empty() {
                return container(text("Nothing done yet").size(BODY).color(c.text_faint)).center(Length::Fill).into();
            }
            return column(parts).into();
        }
        let line = crate::RECENT_LINE;
        let list = self.long(id, w, self.recents.len(), line, move |i| {
            let l = &self.recents[i];
            // Its button works, or why not (a deletion forever has no button).
            let blocked = self.can.get(i);
            let ok = matches!(blocked, Some(None));
            let why = blocked.cloned().flatten().filter(|_| !matches!(l.act, Act::Delete(_)));
            let icon = match &l.act {
                Act::Put(Kind::Copy, _) => &pic.copy,
                Act::Put(Kind::Move, _) => &pic.cut,
                Act::Rename(..) => &pic.rename,
                Act::Make(_) => &pic.folder_plus,
                Act::Bin(_) => &pic.trash,
                Act::Restore(_) => &pic.undo,
                Act::Delete(_) => &pic.trash_x,
            };
            let mut words = l.words();
            if let Some(first) = l.errors.first() {
                words += &format!(" \u{2014} {} failed: {first}", l.errors.len());
            }
            if l.stopped {
                words += " \u{2014} stopped";
            }
            let button = match &l.act {
                Act::Delete(_) => space().width(Length::Shrink).into(),
                _ if l.undone => self.word_button("Redo", ok.then_some(Message::Line(id, l.id, true))),
                _ => self.word_button("Undo", ok.then_some(Message::Line(id, l.id, false))),
            };
            let shown = if l.undone { c.text_muted } else { c.text };
            let mut said = row![text(words).size(BODY).line_height(LINE_TIGHT).color(shown).wrapping(text::Wrapping::None)].spacing(GAP_2);
            if let Some(why) = why {
                said = said.push(text(format!("\u{2014} {why}")).size(BODY).line_height(LINE_TIGHT).color(c.text_faint).wrapping(text::Wrapping::None));
            }
            row![image(icon.get(false)).width(ICON as f32).height(ICON as f32), container(said).width(Length::Fill).clip(true), text(folder::date(l.at)).size(BODY).color(c.text_muted).width(DATE_W), button,]
                .spacing(GAP_3)
                .align_y(Alignment::Center)
                .padding([0.0, GAP_3])
                .height(line)
                .into()
        });
        parts.push(list);
        column(parts).into()
    }

    /// The Bin: in the grid, each thing's picture and name, as a folder; in rows,
    /// with where it came from and when it was binned.
    pub(crate) fn bin_view<'a>(&'a self, id: window::Id, w: &'a Win) -> Element<'a, Message> {
        let c = self.colours;
        if self.binned.is_empty() {
            return container(text("The Bin is empty").size(BODY).color(c.text_faint)).center(Length::Fill).into();
        }
        if self.grid {
            return self.grid(id, w, self.binned.len(), move |at| {
                let b = &self.binned[at];
                let name = b.binned.from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                (kind::of(&name, b.dir), name, w.picked.contains(&key(&b.binned)), 1.0, false)
            });
        }
        let side = ROWS[self.rows_zoom];
        let line = row_height(side);
        let head = |s: &'static str, width: Length| container(text(s).size(SMALL).color(c.text_faint)).width(width);
        let header = row![space().width(side as f32), head("Name", Length::Fill), head("Original Location", Length::Fixed(WHERE_W)), head("Deleted", Length::Fixed(DATE_W))].spacing(GAP_3).padding([GAP_2, GAP_3]);
        let home = places::home();
        let list = self.long(id, w, self.binned.len(), line, move |at| {
            let item = &self.binned[at];
            let name = item.binned.from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let picked = w.picked.contains(&key(&item.binned));
            let (strong, soft) = if picked { (c.on_accent, c.on_accent) } else { (c.text, c.text_muted) };
            let up = item.binned.from.parent().map(|p| match p.strip_prefix(&home) {
                Ok(rest) if rest.as_os_str().is_empty() => "Home".to_string(),
                Ok(rest) => format!("~/{}", rest.display()),
                Err(_) => p.display().to_string(),
            });
            let cell = |s: String, width: Length, colour: Color| container(text(s).size(BODY).line_height(LINE_TIGHT).color(colour).wrapping(text::Wrapping::None)).width(width).clip(true);
            let inside = row![
                image(self.pictures.kinds[kind::of(&name, item.dir) as usize].get(picked)).width(side as f32).height(side as f32),
                cell(name, Length::Fill, strong),
                cell(up.unwrap_or_default(), Length::Fixed(WHERE_W), soft),
                cell(folder::date(item.when), Length::Fixed(DATE_W), soft),
            ]
            .spacing(GAP_3)
            .align_y(Alignment::Center)
            .padding([0.0, GAP_3]);
            let face = self.face(picked, w.hover == Some(at), false, inside).width(Length::Fill).height(line - GAP_1).align_y(Alignment::Center);
            container(self.cell(id, at, face)).padding([0.0, GAP_1]).height(line).into()
        });
        column![header, list].into()
    }

    /// The right-click menu for what was clicked.
    pub(crate) fn context_items(&self, id: window::Id, w: &Win, target: Target) -> Vec<Item<'_, Message>> {
        let pic = &self.pictures;
        let entry = |icon: &Pair, label: &'static str, d: Do| Item::Row(drop::Row { icon: icon.clone(), label, after: None, picked: false, pick: Message::Do(id, d) });
        match (w.page, target) {
            (_, Target::Pin(i)) => vec![entry(&pic.unpin, "Unpin", Do::Unpin(i))],
            (Page::Folder, Target::Picks) => {
                let picked = self.picked_paths(w);
                // Open takes every pick (GNOME's `open-with-default-application`).
                let mut v = vec![entry(&pic.open, "Open", Do::Open), entry(&pic.cut, "Cut", Do::Cut), entry(&pic.copy, "Copy", Do::Copy)];
                if picked.len() == 1 {
                    v.push(entry(&pic.rename, "Rename\u{2026}", Do::Rename));
                }
                v.push(entry(&pic.trash, "Move to Bin", Do::Bin));
                if let [one] = picked.as_slice()
                    && one.is_dir()
                {
                    v.push(match self.pins.iter().position(|p| p == one) {
                        Some(i) => entry(&pic.unpin, "Unpin", Do::Unpin(i)),
                        None => entry(&pic.pin, "Pin", Do::Pin),
                    });
                }
                v
            }
            (Page::Folder, Target::Here) => {
                let mut v = vec![entry(&pic.folder_plus, "New Folder\u{2026}", Do::NewFolder)];
                if self.clipboard.is_some() {
                    v.push(entry(&pic.paste, "Paste", Do::Paste));
                }
                v.push(entry(&pic.select_all, "Select All", Do::All));
                if !self.pins.contains(&w.folder) {
                    v.push(entry(&pic.pin, "Pin", Do::Pin));
                }
                v
            }
            (Page::Bin, Target::Picks) => vec![entry(&pic.undo, "Restore", Do::Restore), entry(&pic.trash_x, "Delete Forever", Do::Delete)],
            (Page::Bin, Target::Here) if !self.binned.is_empty() => vec![entry(&pic.select_all, "Select All", Do::All), entry(&pic.trash_x, "Empty Bin", Do::Empty)],
            _ => Vec::new(),
        }
    }

    /// The text box in a box (rename, new folder): Panel, control height.
    fn field<'a>(&self, id: window::Id, w: &'a Win, value: &'a str, placeholder: &'a str) -> Element<'a, Message> {
        let c = self.colours;
        let input = text_input(placeholder, value)
            .id(w.field_id.clone())
            .on_input(move |t| Message::Field(id, t))
            .on_submit(Message::Confirm(id))
            .size(BODY)
            .font(MEDIUM)
            .line_height(LINE_TIGHT)
            .padding(0)
            .width(Length::Fill)
            .style(move |_, _| text_input::Style { background: Color::TRANSPARENT.into(), border: border::rounded(0), icon: Color::TRANSPARENT, placeholder: c.text_faint, value: c.text, selection: c.accent.scale_alpha(0.3) });
        container(input)
            .padding([0.0, GAP_2])
            .height(CONTROL)
            .width(Length::Fill)
            .align_y(Alignment::Center)
            .style(move |_| container::Style { background: Some(c.panel.into()), border: border::rounded(CORNER), ..Default::default() })
            .into()
    }

    /// A box's main choice, still and faded when it can't be taken.
    fn main_choice<'a>(&self, words: &'a str, face: Color, ok: bool, on: Message) -> Element<'a, Message> {
        let c = self.colours;
        if ok {
            return ask::choice(words, face, c.on_accent, on);
        }
        container(text(words).size(BODY).line_height(LINE_TIGHT).color(c.on_accent))
            .padding([0.0, GAP_3])
            .height(CONTROL)
            .align_y(Alignment::Center)
            .style(move |_| container::Style { background: Some(face.scale_alpha(FADED).into()), border: border::rounded(CORNER), ..Default::default() })
            .into()
    }

    pub(crate) fn ask_view<'a>(&'a self, id: window::Id, w: &'a Win, a: &'a Ask) -> Element<'a, Message> {
        let c = self.colours;
        let cancel = || ask::choice("Cancel", Color::TRANSPARENT, c.text, Message::Ask(id));
        let things = |n: usize, one: &dyn Fn() -> String| if n == 1 { format!("\u{201c}{}\u{201d}", one()) } else { format!("{n} Items") };
        let note = |s: Option<String>, colour: Color| -> Option<Element<'a, Message>> { s.map(|s| text(s).size(BODY).line_height(LINE).color(colour).into()) };
        match a {
            Ask::Rename { old, text: typed, error } => {
                let (said, ok) = name_note(typed, &w.folder, Some(old));
                let dir = w.folder.join(old).is_dir();
                let mut inside = vec![self.field(id, w, typed, "Name")];
                inside.extend(note(error.clone(), c.error).or_else(|| note(said, if ok { c.text_muted } else { c.error })));
                let card = ask::card(if dir { "Rename Folder" } else { "Rename File" }, None, Some(column(inside).spacing(GAP_2).into()), vec![self.main_choice("Rename", c.accent, ok, Message::Confirm(id))], &c);
                // Under the file, as GNOME's: its box in the window.
                let at = (0..self.count(w)).find(|&i| self.key_at(w, i).as_deref() == Some(old.as_str())).map(|i| self.rect(w, i));
                let r = at.map(|r| iced::Rectangle { x: r.x + w.area.x, y: r.y + w.area.y - w.offset, ..r }).unwrap_or(iced::Rectangle { x: w.size.width / 2.0, y: w.size.height / 3.0, width: 0.0, height: 0.0 });
                let tall = 2.0 * GAP_3 + TITLE * LINE_TIGHT + 2.0 * GAP_3 + 2.0 * CONTROL + GAP_2 + BODY * LINE;
                ask::under(card, Point::new(r.center_x(), r.y + r.height), r.y, tall, w.size, Message::Ask(id))
            }
            Ask::NewFolder { text: typed, error } => {
                let (said, ok) = name_note(typed, &w.folder, None);
                let mut inside = vec![self.field(id, w, typed, "Folder name")];
                inside.extend(note(error.clone(), c.error).or_else(|| note(said, if ok { c.text_muted } else { c.error })));
                let card = ask::card("New Folder", None, Some(column(inside).spacing(GAP_2).into()), vec![cancel(), self.main_choice("Create", c.accent, ok, Message::Confirm(id))], &c);
                ask::over(card, Message::Ask(id), &c)
            }
            Ask::Delete(paths) => {
                let title = format!("Permanently Delete {}?", things(paths.len(), &|| show_name(&paths[0])));
                let card = ask::card(title, Some("If you delete an item, it will be permanently lost.".into()), None, vec![cancel(), ask::choice("Delete", c.error, c.on_accent, Message::Confirm(id))], &c);
                ask::over(card, Message::Ask(id), &c)
            }
            Ask::Forget(items) => {
                let title = format!("Permanently Delete {}?", things(items.len(), &|| show_name(&items[0].from)));
                let card = ask::card(title, Some("If you delete an item, it will be permanently lost.".into()), None, vec![cancel(), ask::choice("Delete", c.error, c.on_accent, Message::Confirm(id))], &c);
                ask::over(card, Message::Ask(id), &c)
            }
            Ask::Empty => {
                let card = ask::card("Empty the Bin?", Some("All items in the Bin will be permanently deleted.".into()), None, vec![cancel(), ask::choice("Empty Bin", c.error, c.on_accent, Message::Confirm(id))], &c);
                ask::over(card, Message::Ask(id), &c)
            }
            // GNOME Files' Select App joins it with Open With (step 6); its OK only
            // closed the box, so it goes.
            Ask::Note(title, words) => ask::over(ask::card(title.as_str(), Some(words.clone()), None, Vec::new(), &c), Message::Ask(id), &c),
            // GNOME Files' words (`show_confirm_multiple`); no tabs yet, so all windows.
            Ask::OpenAll(_, n) => {
                let card = ask::card("Are you sure you want to open all files?", Some(format!("This will open {n} separate windows.")), None, vec![cancel(), ask::choice("Open All", c.accent, c.on_accent, Message::Confirm(id))], &c);
                ask::over(card, Message::Ask(id), &c)
            }
            Ask::Clash { to, dir, bins, all, .. } => {
                let there = to.parent().map(show_name).unwrap_or_default();
                let thing = show_name(to);
                let (title, words, main) = if *dir {
                    (format!("Merge Folder \u{201c}{thing}\u{201d}?"), format!("A folder with the same name already exists in \u{201c}{there}\u{201d}. Merging asks before replacing any file inside it with the same name."), "Merge")
                } else if *bins {
                    // A file onto a folder or the other way: what's there isn't lost.
                    let (old, moved) = if to.symlink_metadata().is_ok_and(|m| m.is_dir()) { ("folder", "the folder and everything in it") } else { ("file", "that file") };
                    (format!("Replace \u{201c}{thing}\u{201d}?"), format!("A {old} with the same name already exists in \u{201c}{there}\u{201d}. Replacing it moves {moved} to the Bin."), "Replace")
                } else {
                    (format!("Replace \u{201c}{thing}\u{201d}?"), format!("A file with the same name already exists in \u{201c}{there}\u{201d}. Replacing it overwrites what's in it."), "Replace")
                };
                let tick = if *all { &self.pictures.checked } else { &self.pictures.checkbox };
                let toggle = mouse_area(row![image(tick.get(false)).width(ICON as f32).height(ICON as f32), text("Apply to all").size(BODY).color(c.text)].spacing(GAP_2).align_y(Alignment::Center))
                    .on_press(Message::All(id))
                    .interaction(mouse::Interaction::Pointer);
                let choices = vec![
                    ask::choice("Stop", Color::TRANSPARENT, c.text, Message::Clash(id, None)),
                    ask::choice("Skip", c.panel, c.text, Message::Clash(id, Some(Pick::Skip))),
                    ask::choice("Keep Both", c.panel, c.text, Message::Clash(id, Some(Pick::Both))),
                    ask::choice(main, c.accent, c.on_accent, Message::Clash(id, Some(Pick::Replace))),
                ];
                ask::over(ask::card(title, Some(words), Some(toggle.into()), choices, &c), Message::Nothing, &c)
            }
        }
    }
}
