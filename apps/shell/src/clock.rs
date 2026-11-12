//! Local time through libc, and one wake-up at the start of each minute.

use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iced::Subscription;

#[derive(Debug, Clone, Copy)]
pub struct Now(pub libc::tm);

/// `secs` since 1970 as this place's date and time.
pub fn at(secs: i64) -> Now {
    // SAFETY: localtime_r only writes the tm it is given.
    unsafe {
        let mut tm = std::mem::zeroed();
        libc::localtime_r(&secs, &mut tm);
        Now(tm)
    }
}

pub fn now() -> Now {
    at(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64))
}

impl Now {
    /// The hour on a 12-hour clock, and its half of the day.
    pub fn twelve(&self) -> (i32, &'static str) {
        let h = match self.0.tm_hour % 12 {
            0 => 12,
            h => h,
        };
        (h, if self.0.tm_hour < 12 { "AM" } else { "PM" })
    }

    /// The top bar's clock as the picture shows it (`07:33PM`; his pick 2026-11-08):
    /// 12-hour, two-digit hours, AM / PM after the minutes.
    pub fn time(&self) -> String {
        let (h, half) = self.twelve();
        format!("{h:02}:{:02}{half}", self.0.tm_min)
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
        crate::listener(|mut tx| {
            while !tx.is_closed() {
                // Whole seconds read after the second started: never wakes early.
                thread::sleep(Duration::from_secs(60 - now().0.tm_sec.min(59) as u64));
                let _ = tx.try_send(());
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twelve_hour_clock() {
        // SAFETY: a tm is plain numbers (and a name pointer nothing here reads).
        let at = |hour, min| Now(libc::tm { tm_hour: hour, tm_min: min, ..unsafe { std::mem::zeroed() } });
        assert_eq!(at(0, 5).time(), "12:05AM");
        assert_eq!(at(9, 45).time(), "09:45AM");
        assert_eq!(at(12, 0).time(), "12:00PM");
        assert_eq!(at(19, 33).time(), "07:33PM");
        assert_eq!(at(23, 59).twelve(), (11, "PM"));
    }
}
