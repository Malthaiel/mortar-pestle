//! The click sheet (Noctalia Look step 7, his pick 2026-11-09: "our own homemade version
//! of noctalia's sheet"): while a bar panel shows, a see-through sheet lies over every
//! screen under the bar, so a click off the panel (on a window, the wallpaper) is heard
//! and closes it. The panel sits over it (`Layer::Overlay`), the bar's own band stays
//! uncovered (the sheet takes the room the bar leaves, its `exclusive_zone` 0), and the
//! click goes no further, as Noctalia's (`src/shell/panel/panel_click_shield.cpp` at
//! `2f3e3c4f`). Each sheet's picture is one see-through dot stretched over its screen
//! (`wp_viewport`, 4 bytes), not an iced surface (a screen-sized picture: ~40 MB on
//! the 3440 x 1440 screen).
//!
//! It has its own small link to niri, so iced draws nothing for it. Nothing of it is
//! there while no panel shows: `clicks` makes the link and its thread when the
//! subscription starts, and dropping the subscription ends both, which takes the sheets
//! away with the link.

use std::os::fd::{AsFd, FromRawFd, OwnedFd};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};

use iced::Subscription;
use iced::futures::channel::mpsc;
use iced::futures::{Stream, StreamExt};
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::wl_buffer::WlBuffer;
use wayland_client::protocol::wl_callback::WlCallback;
use wayland_client::protocol::wl_compositor::WlCompositor;
use wayland_client::protocol::wl_output::WlOutput;
use wayland_client::protocol::wl_pointer::{self, WlPointer};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::protocol::wl_seat::{self, WlSeat};
use wayland_client::protocol::wl_shm::{self, WlShm};
use wayland_client::protocol::wl_shm_pool::WlShmPool;
use wayland_client::protocol::wl_surface::WlSurface;
use wayland_client::{Connection, Dispatch, QueueHandle, WEnum, delegate_noop};
use wayland_protocols::wp::cursor_shape::v1::client::wp_cursor_shape_device_v1::{Shape, WpCursorShapeDeviceV1};
use wayland_protocols::wp::cursor_shape::v1::client::wp_cursor_shape_manager_v1::WpCursorShapeManagerV1;
use wayland_protocols::wp::viewporter::client::wp_viewport::WpViewport;
use wayland_protocols::wp::viewporter::client::wp_viewporter::WpViewporter;
use wayland_protocols_wlr::layer_shell::v1::client::zwlr_layer_shell_v1::{Layer, ZwlrLayerShellV1};
use wayland_protocols_wlr::layer_shell::v1::client::zwlr_layer_surface_v1::{self, Anchor, KeyboardInteractivity, ZwlrLayerSurfaceV1};

/// A press on any screen's sheet, while a panel shows.
pub fn clicks() -> Subscription<()> {
    Subscription::run(start)
}

struct State {
    tx: mpsc::Sender<()>,
    /// The one see-through dot every sheet shows.
    dot: WlBuffer,
    shapes: Option<WpCursorShapeManagerV1>,
    pointer: Option<(WlPointer, Option<WpCursorShapeDeviceV1>)>,
}

/// The link's half kept by the subscription: dropping it ends the thread.
struct Sheet {
    rx: mpsc::Receiver<()>,
    link: Option<(Connection, QueueHandle<State>, Arc<AtomicBool>)>,
}

impl Stream for Sheet {
    type Item = ();
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<()>> {
        self.rx.poll_next_unpin(cx)
    }
}

impl Drop for Sheet {
    /// The thread sleeps reading the link: a round trip wakes it to see the stop.
    fn drop(&mut self) {
        if let Some((conn, qh, stop)) = self.link.take() {
            stop.store(true, Ordering::Relaxed);
            conn.display().sync(&qh, ());
            let _ = conn.flush();
        }
    }
}

fn start() -> Sheet {
    let (tx, rx) = mpsc::channel(1);
    let link = open(tx).map_err(|e| eprintln!("mp-shell: no click sheet: {e}")).ok();
    Sheet { rx, link }
}

/// The link, a sheet on each screen, and the thread that hears their presses.
fn open(tx: mpsc::Sender<()>) -> Result<(Connection, QueueHandle<State>, Arc<AtomicBool>), Box<dyn std::error::Error>> {
    let conn = Connection::connect_to_env()?;
    let (globals, mut queue) = registry_queue_init::<State>(&conn)?;
    let qh = queue.handle();
    let compositor: WlCompositor = globals.bind(&qh, 1..=6, ())?;
    let shm: WlShm = globals.bind(&qh, 1..=1, ())?;
    let layers: ZwlrLayerShellV1 = globals.bind(&qh, 1..=4, ())?;
    let viewporter: WpViewporter = globals.bind(&qh, 1..=1, ())?;
    let _seat: WlSeat = globals.bind(&qh, 1..=7, ())?;
    let shapes = globals.bind(&qh, 1..=1, ()).ok();
    let outputs: Vec<WlOutput> = globals.contents().with_list(|list| list.iter().filter(|g| g.interface == "wl_output").map(|g| globals.registry().bind(g.name, g.version.min(4), &qh, ())).collect());

    // One see-through dot (four zero bytes) in a file only this link knows.
    // SAFETY: a C call with a C string.
    let raw = unsafe { libc::memfd_create(c"mp-shell-sheet".as_ptr(), libc::MFD_CLOEXEC) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: a fresh descriptor, owned from here on.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    std::fs::File::from(fd.try_clone()?).set_len(4)?;
    let pool = shm.create_pool(fd.as_fd(), 4, &qh, ());
    let dot = pool.create_buffer(0, 1, 1, 4, wl_shm::Format::Argb8888, &qh, ());
    pool.destroy();

    for output in &outputs {
        let surface = compositor.create_surface(&qh, ());
        let viewport = viewporter.get_viewport(&surface, &qh, ());
        let layer = layers.get_layer_surface(&surface, Some(output), Layer::Top, "mp-shell-sheet".into(), &qh, (surface.clone(), viewport));
        layer.set_anchor(Anchor::all());
        layer.set_size(0, 0);
        layer.set_exclusive_zone(0);
        layer.set_keyboard_interactivity(KeyboardInteractivity::None);
        surface.commit();
    }

    let stop = Arc::new(AtomicBool::new(false));
    let mut state = State { tx, dot, shapes, pointer: None };
    let held = stop.clone();
    std::thread::Builder::new().name("sheet".into()).spawn(move || while !held.load(Ordering::Relaxed) && queue.blocking_dispatch(&mut state).is_ok() {})?;
    Ok((conn, qh, stop))
}

impl Dispatch<ZwlrLayerSurfaceV1, (WlSurface, WpViewport)> for State {
    /// niri gives the sheet its screen's size under the bar: the dot stretched to it.
    fn event(state: &mut Self, layer: &ZwlrLayerSurfaceV1, event: zwlr_layer_surface_v1::Event, (surface, viewport): &(WlSurface, WpViewport), _: &Connection, _: &QueueHandle<Self>) {
        if let zwlr_layer_surface_v1::Event::Configure { serial, width, height } = event {
            layer.ack_configure(serial);
            if width > 0 && height > 0 {
                viewport.set_destination(width as i32, height as i32);
                surface.attach(Some(&state.dot), 0, 0);
                surface.damage_buffer(0, 0, 1, 1);
                surface.commit();
            }
        }
    }
}

impl Dispatch<WlSeat, ()> for State {
    fn event(state: &mut Self, seat: &WlSeat, event: wl_seat::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        if let wl_seat::Event::Capabilities { capabilities: WEnum::Value(caps) } = event
            && caps.contains(wl_seat::Capability::Pointer)
            && state.pointer.is_none()
        {
            let pointer = seat.get_pointer(qh, ());
            let device = state.shapes.as_ref().map(|m| m.get_pointer(&pointer, qh, ()));
            state.pointer = Some((pointer, device));
        }
    }
}

impl Dispatch<WlPointer, ()> for State {
    fn event(state: &mut Self, _: &WlPointer, event: wl_pointer::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            // The plain arrow over the sheet, as over the windows under it.
            wl_pointer::Event::Enter { serial, .. } => {
                if let Some((_, Some(device))) = &state.pointer {
                    device.set_shape(serial, Shape::Default);
                }
            }
            wl_pointer::Event::Button { state: WEnum::Value(wl_pointer::ButtonState::Pressed), .. } => {
                let _ = state.tx.try_send(());
            }
            _ => {}
        }
    }
}

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &WlRegistry, _: wayland_client::protocol::wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

delegate_noop!(State: WlCompositor);
delegate_noop!(State: WlShmPool);
delegate_noop!(State: WpViewporter);
delegate_noop!(State: WpViewport);
delegate_noop!(State: ZwlrLayerShellV1);
delegate_noop!(State: WpCursorShapeManagerV1);
delegate_noop!(State: WpCursorShapeDeviceV1);
delegate_noop!(State: ignore WlShm);
delegate_noop!(State: ignore WlBuffer);
delegate_noop!(State: ignore WlSurface);
delegate_noop!(State: ignore WlOutput);
delegate_noop!(State: ignore WlCallback);
