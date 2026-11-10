//! Local time through libc, and one wake-up at the start of each minute.

use std::thread;
use std::time::Duration;

use iced::Subscription;
use iced::futures::channel::mpsc;

#[derive(Debug, Clone, Copy)]
pub struct Now(libc::tm);

pub fn now() -> Now {
    // SAFETY: localtime_r only writes the tm it is given.
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        Now(tm)
    }
}

impl Now {
    /// The top bar's clock as the picture shows it (`07:33PM`; his pick 2026-11-08):
    /// 12-hour, two-digit hours, AM / PM after the minutes.
    pub fn time(&self) -> String {
        let h = match self.0.tm_hour % 12 {
            0 => 12,
            h => h,
        };
        format!("{h:02}:{:02}{}", self.0.tm_min, if self.0.tm_hour < 12 { "AM" } else { "PM" })
    }

    /// Today as (year, month 0-11, day 1-31).
    pub fn date(&self) -> (i32, u32, u32) {
        (self.0.tm_year + 1900, self.0.tm_mon as u32, self.0.tm_mday as u32)
    }
}

/// Fires as each new minute starts. A plain thread sleeps until then, so nothing
/// else wakes in between.
pub fn minutes() -> Subscription<()> {
    Subscription::run(|| {
        let (mut tx, rx) = mpsc::channel(1);
        thread::spawn(move || {
            while !tx.is_closed() {
                // Whole seconds read after the second started: never wakes early.
                thread::sleep(Duration::from_secs(60 - now().0.tm_sec.min(59) as u64));
                let _ = tx.try_send(());
            }
        });
        rx
    })
}
