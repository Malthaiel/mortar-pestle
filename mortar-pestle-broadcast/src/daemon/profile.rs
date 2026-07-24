//! OBS-format profile store — `profiles/Default/basic.ini` under the engine
//! config dir, OBS key names exactly (SP4 locked decision: import/export
//! fidelity by construction; SP10 builds the profiles manager on top, SP11's
//! import wizard maps a real OBS basic.ini onto this file unchanged).
//!
//! Order- and unknown-line-preserving: a key we never touch (hand-edit or a
//! future OBS import) round-trips byte-identical. Writes are atomic
//! (tmp + rename). All values are strings on disk, exactly like OBS's
//! config-file; typed getters parse at the read site.

use std::io;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::obs::app_config_dir;

/// (section, key, default) — seeded into a fresh profile so the file is
/// complete and self-documenting from first boot (gate step 1). Values mirror
/// OBS 32 defaults except where an SP4 decision overrides (RecRBTime 30,
/// RecRBSize 512, RecFormat2 hybrid_mp4 which IS the OBS 32 default).
pub const DEFAULTS: &[(&str, &str, &str)] = &[
    ("Output", "Mode", "Simple"),
    ("Output", "FilenameFormatting", "%CCYY-%MM-%DD %hh-%mm-%ss"),
    ("SimpleOutput", "RecQuality", "HQ"),
    ("SimpleOutput", "RecEncoder", "x264"),
    ("SimpleOutput", "RecFormat2", "hybrid_mp4"),
    ("SimpleOutput", "RecTracks", "3"),
    ("SimpleOutput", "RecAudioEncoder", "aac"),
    ("SimpleOutput", "RecRB", "false"),
    ("SimpleOutput", "RecRBTime", "30"),
    ("SimpleOutput", "RecRBSize", "512"),
    ("SimpleOutput", "RecRBPrefix", "Replay"),
    ("Video", "BaseCX", "1920"),
    ("Video", "BaseCY", "1080"),
    ("Video", "OutputCX", "1920"),
    ("Video", "OutputCY", "1080"),
    ("Video", "FPSCommon", "60"),
    ("Video", "AutoRemux", "false"),
    ("AdvOut", "RecEncoder", "obs_x264"),
    ("AdvOut", "RecSplitFile", "false"),
    ("AdvOut", "RecSplitFileType", "Time"),
    ("AdvOut", "RecSplitFileTime", "15"),
    ("AdvOut", "RecSplitFileSize", "2048"),
];

enum Line {
    Kv(String, String),
    /// Comment / blank / anything that isn't `key=value` — preserved verbatim.
    Raw(String),
}

pub struct Profile {
    path: PathBuf,
    sections: Vec<(String, Vec<Line>)>,
}

pub fn profile_path() -> PathBuf {
    app_config_dir().join("profiles").join("Default").join("basic.ini")
}

/// Advanced encoder overrides live beside the ini under OBS's own filename
/// (basic-profile convention), written via obs_data_save_json by the engine.
pub fn record_encoder_path() -> PathBuf {
    app_config_dir().join("profiles").join("Default").join("recordEncoder.json")
}

/// The stream service (SP5), beside basic.ini under OBS's own filename and
/// shape — `{type, settings}` — so an OBS profile round-trips through SP11's
/// import wizard unchanged. The ONE dir constant for the profile directory is
/// this file's; nothing else may compose that path.
pub fn service_path() -> PathBuf {
    app_config_dir().join("profiles").join("Default").join("service.json")
}

impl Profile {
    /// Load (or start empty), then seed any missing DEFAULTS and persist the
    /// seed so first boot leaves a complete file on disk.
    pub fn load() -> Self {
        let path = profile_path();
        let mut p = Profile { path: path.clone(), sections: Vec::new() };
        match std::fs::read_to_string(&path) {
            Ok(text) => p.parse(&text),
            Err(_) => log::info!("no profile at {} (fresh start)", path.display()),
        }
        let mut seeded = false;
        for (sec, key, default) in DEFAULTS {
            if p.get(sec, key).is_none() {
                p.set(sec, key, *default);
                seeded = true;
            }
        }
        if seeded {
            if let Err(e) = p.save() {
                log::warn!("profile seed save failed: {e}");
            }
        }
        p
    }

    fn parse(&mut self, text: &str) {
        for raw in text.lines() {
            let line = raw.trim_end();
            let trimmed = line.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                let name = trimmed[1..trimmed.len() - 1].to_string();
                self.sections.push((name, Vec::new()));
            } else if let Some((k, v)) = line.split_once('=') {
                let entry = Line::Kv(k.trim().to_string(), v.to_string());
                match self.sections.last_mut() {
                    Some((_, lines)) => lines.push(entry),
                    None => self.sections.push((String::new(), vec![entry])),
                }
            } else {
                match self.sections.last_mut() {
                    Some((_, lines)) => lines.push(Line::Raw(line.to_string())),
                    None => self.sections.push((String::new(), vec![Line::Raw(line.to_string())])),
                }
            }
        }
    }

    pub fn get(&self, section: &str, key: &str) -> Option<&str> {
        self.sections.iter().find(|(s, _)| s == section).and_then(|(_, lines)| {
            lines.iter().find_map(|l| match l {
                Line::Kv(k, v) if k == key => Some(v.as_str()),
                _ => None,
            })
        })
    }

    pub fn get_or<'a>(&'a self, section: &str, key: &str, default: &'a str) -> &'a str {
        self.get(section, key).unwrap_or(default)
    }

    pub fn get_u32(&self, section: &str, key: &str, default: u32) -> u32 {
        self.get(section, key).and_then(|v| v.trim().parse().ok()).unwrap_or(default)
    }

    pub fn get_bool(&self, section: &str, key: &str, default: bool) -> bool {
        match self.get(section, key) {
            Some(v) => v.trim().eq_ignore_ascii_case("true"),
            None => default,
        }
    }

    pub fn set(&mut self, section: &str, key: &str, value: impl Into<String>) {
        let value = value.into();
        let sec = match self.sections.iter_mut().find(|(s, _)| s == section) {
            Some((_, lines)) => lines,
            None => {
                self.sections.push((section.to_string(), Vec::new()));
                &mut self.sections.last_mut().unwrap().1
            }
        };
        for l in sec.iter_mut() {
            if let Line::Kv(k, v) = l {
                if k == key {
                    *v = value;
                    return;
                }
            }
        }
        sec.push(Line::Kv(key.to_string(), value));
    }

    pub fn save(&self) -> io::Result<()> {
        let mut out = String::new();
        for (name, lines) in &self.sections {
            if !name.is_empty() {
                out.push_str(&format!("[{name}]\n"));
            }
            for l in lines {
                match l {
                    Line::Kv(k, v) => out.push_str(&format!("{k}={v}\n")),
                    Line::Raw(r) => {
                        out.push_str(r);
                        out.push('\n');
                    }
                }
            }
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("ini.tmp");
        std::fs::write(&tmp, out)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// `{section: {key: value}}` view for `get_output_settings` — values stay
    /// strings (disk truth); the UI parses numbers/bools at its edge.
    pub fn to_json(&self) -> Value {
        let mut root = serde_json::Map::new();
        for (name, lines) in &self.sections {
            let mut sec = serde_json::Map::new();
            for l in lines {
                if let Line::Kv(k, v) = l {
                    sec.insert(k.clone(), Value::String(v.clone()));
                }
            }
            root.insert(name.clone(), Value::Object(sec));
        }
        json!(root)
    }

    /// Merge a `{section: {key: value}}` patch (set_output_settings). Non-string
    /// leaf values are stringified (the wire may send numbers/bools).
    pub fn apply_patch(&mut self, patch: &Value) {
        let Some(obj) = patch.as_object() else { return };
        for (section, keys) in obj {
            let Some(keys) = keys.as_object() else { continue };
            for (k, v) in keys {
                let s = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                self.set(section, k, s);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_unknown_lines_and_order() {
        let mut p = Profile { path: PathBuf::from("unused"), sections: Vec::new() };
        p.parse("# hand comment\n[Video]\nBaseCX=1920\nMysteryKey=7\n\n[SimpleOutput]\nRecQuality=HQ\n");
        assert_eq!(p.get("Video", "BaseCX"), Some("1920"));
        assert_eq!(p.get("Video", "MysteryKey"), Some("7"));
        p.set("Video", "BaseCX", "2560");
        p.set("Zed", "NewKey", "x");
        assert_eq!(p.get("Video", "BaseCX"), Some("2560"));
        assert_eq!(p.get("Zed", "NewKey"), Some("x"));
        assert_eq!(p.get_u32("Video", "MysteryKey", 0), 7);
        assert!(!p.get_bool("SimpleOutput", "RecRB", false));
        // Section order + raw lines survive a set.
        assert_eq!(p.sections[0].0, ""); // pre-section comment bucket
        assert_eq!(p.sections[1].0, "Video");
    }
}
