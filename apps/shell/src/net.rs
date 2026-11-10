//! The network: a cable in, or the wifi joined and how strong it is, read from the
//! kernel (his pick 2026-10-30 over NetworkManager's D-Bus, a new crate, and
//! Caelestia's `nmcli monitor` helper, 3.8 MB and 5 threads more, measured). A
//! waiting thread holds a route socket the kernel writes to when a link goes up or
//! down, and on each message reads the cards' state in `/sys/class/net` anew.
//! While the wifi is joined it also reads the signal every 6 s, as NetworkManager
//! refreshes it (`nm-device-wifi.c` `periodic_update`, @1c71c568); otherwise
//! nothing runs between changes.

use std::fs;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Mutex;
use std::thread;

use iced::Subscription;
use iced::futures::channel::mpsc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Net {
    Off,
    Cable,
    /// The signal, NetworkManager's 0-100.
    Wifi(u8),
}

static NET: Mutex<Net> = Mutex::new(Net::Off);

pub fn net() -> Net {
    *NET.lock().unwrap()
}

/// A cable wins over the wifi (Caelestia's `StatusIcons`). Only real cards count:
/// loopback, bridges and tunnels have no `device`.
fn read() -> Net {
    let mut wifi = None;
    for card in fs::read_dir("/sys/class/net").into_iter().flatten().flatten() {
        let path = card.path();
        let up = fs::read_to_string(path.join("operstate")).is_ok_and(|s| s.trim() == "up");
        if !up || !path.join("device").exists() {
            continue;
        }
        if !path.join("phy80211").exists() {
            return Net::Cable;
        }
        wifi = card.file_name().into_string().ok();
    }
    wifi.map_or(Net::Off, |card| Net::Wifi(strength(&card)))
}

/// The card's signal in dBm from `/proc/net/wireless` (the station signal
/// NetworkManager reads too, kernel `wext-compat.c` `cfg80211_wireless_stats`),
/// made NetworkManager's percent (`nl80211_xbm_to_percent`: 100 - 70 * (-20 - dBm)
/// / 70, dBm held to -90..-20), so the bars match its own tools; 0 when the
/// kernel gives none (Caelestia's `strength ?? 0`).
fn strength(card: &str) -> u8 {
    let table = fs::read_to_string("/proc/net/wireless").unwrap_or_default();
    let dbm = table.lines().find_map(|line| {
        let (name, fields) = line.split_once(':')?;
        if name.trim() != card {
            return None;
        }
        // status, link quality, level (dBm, a '.' after it when fresh), ...
        fields.split_whitespace().nth(2)?.trim_end_matches('.').parse::<i32>().ok()
    });
    dbm.map_or(0, |dbm| (120 + dbm.clamp(-90, -20)) as u8)
}

/// A netlink route socket joined to the link group: a message on every link change.
fn listen() -> Option<OwnedFd> {
    unsafe {
        let fd = libc::socket(libc::AF_NETLINK, libc::SOCK_RAW | libc::SOCK_CLOEXEC, libc::NETLINK_ROUTE);
        if fd < 0 {
            return None;
        }
        let fd = OwnedFd::from_raw_fd(fd);
        let mut addr: libc::sockaddr_nl = std::mem::zeroed();
        addr.nl_family = libc::AF_NETLINK as u16;
        addr.nl_groups = libc::RTMGRP_LINK as u32;
        let len = size_of::<libc::sockaddr_nl>() as u32;
        (libc::bind(fd.as_raw_fd(), (&raw const addr).cast(), len) == 0).then_some(fd)
    }
}

/// Fires whenever `NET` changes.
pub fn events() -> Subscription<()> {
    Subscription::run(|| {
        let (mut tx, rx) = mpsc::channel(1);
        thread::spawn(move || {
            let Some(sock) = listen() else { return eprintln!("mp-shell: network: {}", std::io::Error::last_os_error()) };
            let mut buf = [0u8; 8192];
            while !tx.is_closed() {
                let now = read();
                if std::mem::replace(&mut *NET.lock().unwrap(), now) != now {
                    let _ = tx.try_send(());
                }
                let wait = if matches!(now, Net::Wifi(_)) { 6000 } else { -1 };
                let mut ready = libc::pollfd { fd: sock.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                if unsafe { libc::poll(&mut ready, 1, wait) } > 0 {
                    // What changed is read from /sys, so the messages are only emptied.
                    while unsafe { libc::recv(sock.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), libc::MSG_DONTWAIT) } > 0 {}
                }
            }
        });
        rx
    })
}
