//! The left column's places (GNOME Files' sidebar): Home, then the user folders
//! from `~/.config/user-dirs.dirs` GNOME shows (Documents, Downloads, Music,
//! Pictures, Videos), each only when it exists and isn't Home itself. Recents
//! and the Bin come with step 2, pinned folders and drives with steps 2 and 7.

use std::path::PathBuf;

pub struct Place {
    pub name: &'static str,
    pub path: PathBuf,
    /// Index into the place pictures (`main.rs` `Pictures::places`).
    pub picture: usize,
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Where the File Explorer keeps what it saves: Recents, pinned folders.
pub fn state() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local/state")).join("mp-files")
}

/// `XDG_DOCUMENTS_DIR="$HOME/Documents"` lines, `$HOME` put in.
fn user_dir(key: &str) -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config"));
    let text = std::fs::read_to_string(config.join("user-dirs.dirs")).ok()?;
    let line = text.lines().find(|l| l.trim_start().starts_with(&format!("{key}=")))?;
    let value = line.split_once('=')?.1.trim().trim_matches('"');
    let path = match value.strip_prefix("$HOME") {
        Some(rest) => home().join(rest.trim_start_matches('/')),
        None => PathBuf::from(value),
    };
    Some(path)
}

pub fn load() -> Vec<Place> {
    let mut out = vec![Place { name: "Home", path: home(), picture: 0 }];
    for (i, (name, key)) in [("Documents", "XDG_DOCUMENTS_DIR"), ("Downloads", "XDG_DOWNLOAD_DIR"), ("Music", "XDG_MUSIC_DIR"), ("Pictures", "XDG_PICTURES_DIR"), ("Videos", "XDG_VIDEOS_DIR")].into_iter().enumerate() {
        if let Some(path) = user_dir(key).filter(|p| p.is_dir() && *p != home()) {
            out.push(Place { name, path, picture: i + 1 });
        }
    }
    out
}
