//! The taps other programs give the shell: niri's Mod+D sends SIGUSR1 (`pkill
//! -USR1 -x mp-shell`, the Start menu), mp-theme sends SIGUSR2 once it has written
//! new colours. A thread waits in `sigwait`, so nothing runs in between. (The music
//! box's shortcut and the media keys call mp-library and mp-player on the session bus
//! straight since the Music Tab Redesign, step 2.)

use std::thread;

use iced::Subscription;
use iced::futures::channel::mpsc;

#[derive(Debug, Clone, Copy)]
pub enum Signal {
    /// SIGUSR1: the Start menu opens, or closes when open.
    Start,
    /// SIGUSR2: `colours.toml` changed.
    Colours,
}

/// SIGUSR1 and SIGUSR2.
fn set() -> libc::sigset_t {
    // SAFETY: the set is emptied before it is filled and read.
    unsafe {
        let mut set = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGUSR1);
        libc::sigaddset(&mut set, libc::SIGUSR2);
        set
    }
}

/// Keeps the signals (which would end the program) off every thread started
/// after this, so `events` takes them: first thing in `main`, before any thread starts.
pub fn hold() {
    // SAFETY: changes this thread's signal mask only; new threads inherit it.
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &set(), std::ptr::null_mut()) };
}

pub fn events() -> Subscription<Signal> {
    Subscription::run(|| {
        let (mut tx, rx) = mpsc::channel(1);
        thread::spawn(move || {
            let set = set();
            let mut signal = 0;
            // SAFETY: sigwait reads the set and writes the signal's number.
            while unsafe { libc::sigwait(&set, &mut signal) } == 0 && !tx.is_closed() {
                let tap = match signal {
                    libc::SIGUSR2 => Signal::Colours,
                    _ => Signal::Start,
                };
                let _ = tx.try_send(tap);
            }
        });
        rx
    })
}
