//! The top bar's weather (Noctalia Look step 5, his picks 2026-11-08): the US weather
//! service's latest reading at the station named in `~/.config/mp-shell/weather` (one
//! word, an airport's letters as `api.weather.gov/stations` lists them; no file, no ask;
//! `api.weather.gov`, free for any use, asks only for the program's name), shown
//! as Noctalia's bar weather shows it: a sky picture, then the temperature (hooxoo's
//! picture: no condition words). Asked through curl (`music::web::curl`) every 30
//! minutes (Noctalia's `refresh_minutes`) on the clock's once-a-minute wake, so nothing
//! else wakes; a failed ask is tried again after 30 s, doubling up to 5 min (Noctalia's
//! retry), which the minute wake rounds up to whole minutes. The last reading stays
//! through failed asks and is saved, so a restart shows it at once (Noctalia's weather
//! cache). Measured 2026-11-08: an ask costs ~11 ms of processor and ~15 MB for under
//! 0.6 s, in curl, then nothing.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs};

use iced::Task;
use iced::futures::channel::oneshot;
use serde_json::Value;

use crate::music::web;

/// Noctalia's `refresh_minutes` default.
const EVERY: Duration = Duration::from_secs(30 * 60);
/// Noctalia's first retry after a failed ask, and its longest.
const RETRY: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(5 * 60);

/// The sky, as Noctalia's buckets (`WeatherService::glyphForCode`); in `main.rs`'s
/// `WEATHER` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sky {
    Sun,
    Moon,
    CloudSun,
    MoonStars,
    Cloud,
    Fog,
    Rain,
    Snow,
    Bolt,
}

const SKIES: [Sky; 9] = [Sky::Sun, Sky::Moon, Sky::CloudSun, Sky::MoonStars, Sky::Cloud, Sky::Fog, Sky::Rain, Sky::Snow, Sky::Bolt];

#[derive(Debug, Clone, Copy)]
pub struct Reading {
    pub fahrenheit: i32,
    pub sky: Sky,
}

pub struct Weather {
    /// The address of the station's latest reading (a new one every 5 minutes, landing
    /// ~20 minutes late, in whole degrees C; the hourly one has tenths); none = no station set.
    latest: Option<String>,
    reading: Option<Reading>,
    asking: bool,
    failed: bool,
    /// When the next ask is due (the wall clock, so a sleep in between counts).
    next: SystemTime,
    retry: Duration,
}

impl Weather {
    /// With the saved reading, if any, due again 30 minutes after it was asked.
    pub fn new() -> Self {
        let saved = fs::read_to_string(file()).ok().and_then(|s| {
            let mut w = s.split_whitespace();
            let at = UNIX_EPOCH + Duration::from_secs(w.next()?.parse().ok()?);
            let fahrenheit = w.next()?.parse().ok()?;
            let sky = *SKIES.get(w.next()?.parse::<usize>().ok()?)?;
            Some((at, Reading { fahrenheit, sky }))
        });
        let station = fs::read_to_string(mp_ui::colours::config_dir().join("mp-shell/weather")).unwrap_or_default();
        let station = station.trim();
        let latest = (!station.is_empty() && station.chars().all(|c| c.is_ascii_alphanumeric())).then(|| format!("https://api.weather.gov/stations/{station}/observations/latest"));
        Self { latest, reading: saved.map(|(_, r)| r), asking: false, failed: false, next: saved.map_or(UNIX_EPOCH, |(at, _)| at + EVERY), retry: RETRY }
    }

    /// An ask, off the window's thread, when one is due and none is out.
    pub fn check(&mut self) -> Option<Task<Option<Reading>>> {
        if self.asking || SystemTime::now() < self.next {
            return None;
        }
        let latest = self.latest.clone()?;
        self.asking = true;
        let (tx, rx) = oneshot::channel();
        std::thread::spawn(move || {
            let _ = tx.send(ask(&latest));
        });
        Some(Task::future(async move { rx.await.ok().flatten() }))
    }

    pub fn got(&mut self, reading: Option<Reading>) {
        self.asking = false;
        let now = SystemTime::now();
        match reading {
            Some(r) => {
                (self.reading, self.failed, self.retry, self.next) = (Some(r), false, RETRY, now + EVERY);
            }
            None => {
                eprintln!("mp-shell: weather: no reading, again in {} s", self.retry.as_secs());
                (self.failed, self.next) = (true, now + self.retry);
                self.retry = (self.retry * 2).min(RETRY_MAX);
            }
        }
    }

    /// The sky picture and the words beside it, as Noctalia's `WeatherWidget::sync`:
    /// the reading once there is one; before it, a cloud and "Weather" while asking
    /// (Noctalia's "Weather…", its dots left off: his rule) or "Weather err" after a
    /// failed ask.
    pub fn shown(&self) -> (Sky, String) {
        match self.reading {
            Some(r) => (r.sky, format!("{}°F", r.fahrenheit)),
            None if self.failed && !self.asking => (Sky::Cloud, "Weather err".into()),
            None => (Sky::Cloud, "Weather".into()),
        }
    }
}

/// Asks for the latest reading and saves it.
fn ask(latest: &str) -> Option<Reading> {
    let answer: Value = serde_json::from_slice(&web::curl(&["--compressed", latest])?).ok()?;
    let p = &answer["properties"];
    // Always degrees C (`wmoUnit:degC`); none while the airport's thermometer is out.
    let celsius = p["temperature"]["value"].as_f64()?;
    let r = Reading { fahrenheit: (celsius * 1.8 + 32.0).round() as i32, sky: sky(p["icon"].as_str().unwrap_or_default()) };
    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let file = file();
    let _ = file.parent().map(fs::create_dir_all);
    let _ = fs::write(file, format!("{at} {} {}\n", r.fahrenheit, r.sky as usize));
    Some(r)
}

/// The sky from the reading's picture address (`.../icons/land/{day|night}/{code}?size=medium`;
/// every code at `api.weather.gov/icons`, all 34 placed here), into Noctalia's buckets:
/// clear = a sun or moon, a few or scattered clouds = a cloud with a sun or a moon with
/// stars, mostly cloudy or overcast = a cloud; none = a cloud (Noctalia's fallback).
fn sky(icon: &str) -> Sky {
    let night = icon.contains("/night/");
    let code = icon.split("/land/").nth(1).and_then(|s| s.split(['/', ',', '?']).nth(1)).unwrap_or_default();
    match code.trim_start_matches("wind_") {
        "skc" | "hot" | "cold" if night => Sky::Moon,
        "skc" | "hot" | "cold" => Sky::Sun,
        "few" | "sct" if night => Sky::MoonStars,
        "few" | "sct" => Sky::CloudSun,
        "fog" | "haze" | "smoke" | "dust" => Sky::Fog,
        c if c.contains("snow") || c == "sleet" || c == "blizzard" => Sky::Snow,
        c if c.starts_with("tsra") || matches!(c, "tornado" | "hurricane" | "tropical_storm") => Sky::Bolt,
        c if c.contains("rain") || c == "fzra" => Sky::Rain,
        _ => Sky::Cloud,
    }
}

/// `~/.cache/mp-shell/weather`: the last reading as "<seconds since 1970> <°F> <sky>".
fn file() -> PathBuf {
    env::var_os("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".cache")).join("mp-shell/weather")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skies() {
        let at = |when: &str, code: &str| sky(&format!("https://api.weather.gov/icons/land/{when}/{code}?size=medium"));
        assert_eq!(at("night", "skc"), Sky::Moon);
        assert_eq!(at("day", "few"), Sky::CloudSun);
        assert_eq!(at("night", "wind_sct"), Sky::MoonStars);
        assert_eq!(at("day", "bkn"), Sky::Cloud);
        assert_eq!(at("day", "rain_snow"), Sky::Snow);
        assert_eq!(at("day", "rain_fzra"), Sky::Rain);
        assert_eq!(at("day", "tsra_hi,40"), Sky::Bolt);
        assert_eq!(at("day", "rain,40/tsra,60"), Sky::Rain);
        assert_eq!(at("day", "haze"), Sky::Fog);
        assert_eq!(sky(""), Sky::Cloud);
    }
}
