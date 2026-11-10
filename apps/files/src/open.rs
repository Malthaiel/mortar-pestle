//! A file opened with its usual program, the freedesktop way GNOME's GIO follows:
//! its type (the name's, else "text" when its start reads as text), the type's
//! program from `mimeapps.list` ([Default Applications], then [Added Associations])
//! in the user's then the system's folders, then the programs' own claims
//! (`mimeinfo.cache`), trying the type's parents after (a Rust file opens as plain
//! text). The program's `Exec` line gets the file in place of its field codes and
//! starts through niri's `Spawn`, as the Start menu starts programs, so it is
//! niri's child, not ours. `Terminal=true` runs inside foot.
//!
//! TO MOVE (File Explorer plan, Architecture): the desktop-entry reading here and the
//! Start menu's (`apps/shell/src/apps.rs`) become one in `mp-ui` once the chat now
//! editing `mp-ui` has committed.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

use crate::folder;
use crate::kind;

/// A type's description, as GIO's `g_content_type_get_description` reads it: the
/// first (untranslated) `<comment>` of shared-mime-info's `<type>.xml`; none for an
/// unknown type.
fn describe(mime: &str) -> Option<String> {
    if mime == "application/octet-stream" {
        return None;
    }
    let xml = data_dirs().into_iter().find_map(|d| std::fs::read_to_string(d.join("mime").join(format!("{mime}.xml"))).ok());
    let said = xml
        .as_deref()
        .and_then(|x| x.split_once("<comment>"))
        .and_then(|(_, rest)| rest.split_once("</comment>"))
        .map(|(c, _)| c.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&apos;", "'").replace("&quot;", "\""));
    Some(said.unwrap_or_else(|| mime.to_string()))
}

/// GNOME Files' words for a file no program opens (`show_unhandled_type_error`).
fn unhandled(mime: &str) -> String {
    match describe(mime) {
        Some(kind) => format!("There is no app installed for \u{201c}{kind}\u{201d} files"),
        None => "The file is of an unknown type".into(),
    }
}

/// The program for a type: its own, else its parents', else plain text's for text.
fn program(mime: &'static str) -> Option<Desktop> {
    let mut types = vec![mime];
    types.extend(kind::parents(mime));
    if mime.starts_with("text/") && !types.contains(&"text/plain") {
        types.push("text/plain");
    }
    types.iter().flat_map(|m| programs(m)).find_map(|id| desktop(&id))
}

/// Files by the program that opens them, in the order first met (GNOME Files'
/// `make_activation_parameters`), each type looked up once; those no program
/// opens, as (name, GNOME's words why).
pub fn group(paths: &[PathBuf]) -> (Vec<(Desktop, Vec<PathBuf>)>, Vec<(String, String)>) {
    let mut by_type: HashMap<&'static str, Option<usize>> = HashMap::new();
    let (mut groups, mut errors): (Vec<(Desktop, Vec<PathBuf>)>, Vec<(String, String)>) = (Vec::new(), Vec::new());
    for path in paths {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mime = kind::mime(&name).unwrap_or_else(|| sniff(path));
        let at = match by_type.get(mime) {
            Some(&at) => at,
            None => {
                let at = program(mime).map(|d| match groups.iter().position(|(g, _)| g.file == d.file) {
                    Some(i) => i,
                    None => {
                        groups.push((d, Vec::new()));
                        groups.len() - 1
                    }
                });
                by_type.insert(mime, at);
                at
            }
        };
        match at {
            Some(i) => groups[i].1.push(path.clone()),
            None => errors.push((name, unhandled(mime))),
        }
    }
    (groups, errors)
}

/// Starts each program: once with all its files when its `Exec` takes a list
/// (`%F`, `%U`), else once a file (GIO's way); what failed, as (its first file's
/// name, why).
pub fn start(groups: Vec<(Desktop, Vec<PathBuf>)>) -> Vec<(String, String)> {
    let mut errors = Vec::new();
    for (d, files) in groups {
        let runs: Vec<Vec<PathBuf>> = if d.takes_many() { vec![files] } else { files.into_iter().map(|f| vec![f]).collect() };
        for run in runs {
            if let Err(e) = spawn(d.command(&run)) {
                errors.push((run[0].file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), e));
            }
        }
    }
    errors
}

/// No known end: text if its first 1 KB is clean UTF-8 with no zero byte.
fn sniff(path: &Path) -> &'static str {
    let mut head = [0u8; 1024];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    let head = &head[..n];
    let text = !head.contains(&0) && (std::str::from_utf8(head).is_ok() || std::str::from_utf8(&head[..n.saturating_sub(3)]).is_ok());
    if text { "text/plain" } else { "application/octet-stream" }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn env_dir(var: &str, default: PathBuf) -> PathBuf {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or(default)
}

/// Where programs' `.desktop` files live, the user's first.
fn data_dirs() -> Vec<PathBuf> {
    let mut v = vec![env_dir("XDG_DATA_HOME", home().join(".local/share"))];
    let rest = std::env::var("XDG_DATA_DIRS").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    v.extend(rest.split(':').map(PathBuf::from));
    v
}

/// The programs for a type, in the spec's order, each once.
fn programs(mime: &str) -> Vec<String> {
    let config = env_dir("XDG_CONFIG_HOME", home().join(".config"));
    let config_dirs = std::env::var("XDG_CONFIG_DIRS").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/etc/xdg".into());
    let mut lists: Vec<PathBuf> = vec![config.join("mimeapps.list")];
    lists.extend(config_dirs.split(':').map(|d| PathBuf::from(d).join("mimeapps.list")));
    lists.extend(data_dirs().into_iter().map(|d| d.join("applications/mimeapps.list")));
    let mut out: Vec<String> = Vec::new();
    let mut add = |ids: &str| {
        for id in ids.split(';').filter(|s| !s.is_empty()) {
            if !out.iter().any(|o| o == id) {
                out.push(id.to_string());
            }
        }
    };
    for group in ["Default Applications", "Added Associations"] {
        for file in &lists {
            if let Some(ids) = ini(file, group).remove(mime) {
                add(&ids);
            }
        }
    }
    for d in data_dirs() {
        if let Some(ids) = ini(&d.join("applications/mimeinfo.cache"), "MIME Cache").remove(mime) {
            add(&ids);
        }
    }
    out
}

/// One `[group]` of an ini-style file as `key -> value` (unreadable = empty).
fn ini(file: &Path, group: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = std::fs::read_to_string(file) else { return out };
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(g) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            inside = g == group;
        } else if inside && let Some((k, v)) = line.split_once('=') {
            out.entry(k.trim().to_string()).or_insert_with(|| v.trim().to_string());
        }
    }
    out
}

pub struct Desktop {
    file: PathBuf,
    exec: String,
    name: String,
    icon: String,
    terminal: bool,
}

fn desktop(id: &str) -> Option<Desktop> {
    let file = data_dirs().into_iter().map(|d| d.join("applications").join(id)).find(|f| f.is_file())?;
    let keys = ini(&file, "Desktop Entry");
    if keys.get("Hidden").is_some_and(|v| v == "true") {
        return None;
    }
    let exec = keys.get("Exec")?.clone();
    let get = |k: &str| keys.get(k).cloned().unwrap_or_default();
    Some(Desktop { exec, name: get("Name"), icon: get("Icon"), terminal: get("Terminal") == "true", file })
}

impl Desktop {
    /// Its `Exec` takes several files at once.
    fn takes_many(&self) -> bool {
        words(&self.exec).iter().any(|w| w == "%F" || w == "%U")
    }

    /// `Exec` split by the spec's quoting, the files put where its field code asks
    /// (`%F` the paths, `%U` their addresses, `%f` / `%u` the first), added at the
    /// end when none does.
    fn command(&self, paths: &[PathBuf]) -> Vec<String> {
        let files = || paths.iter().map(|p| p.to_string_lossy().into_owned());
        let taken = words(&self.exec).iter().any(|w| matches!(w.as_str(), "%f" | "%F" | "%u" | "%U"));
        let mut out: Vec<String> = Vec::new();
        for word in words(&self.exec) {
            match word.as_str() {
                "%F" => out.extend(files()),
                "%U" => out.extend(paths.iter().map(|p| folder::address(p))),
                "%f" => out.extend(files().take(1)),
                "%u" => out.extend(paths.iter().take(1).map(|p| folder::address(p))),
                "%i" if !self.icon.is_empty() => out.extend(["--icon".to_string(), self.icon.clone()]),
                "%c" => out.push(self.name.clone()),
                "%k" => out.push(self.file.to_string_lossy().into_owned()),
                w if w.len() == 2 && w.starts_with('%') => {}
                w => out.push(w.replace("%%", "%")),
            }
        }
        if !taken {
            out.extend(files());
        }
        if self.terminal {
            out.insert(0, "foot".into());
        }
        out
    }
}

/// The spec's `Exec` quoting: words split on spaces, "double quotes" keep spaces,
/// a backslash inside them keeps the next character.
fn words(exec: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let (mut quoted, mut any) = (false, false);
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => (quoted, any) = (!quoted, true),
            '\\' if quoted => word.extend(chars.next()),
            ' ' | '\t' if !quoted => {
                if any || !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
                any = false;
            }
            c => word.push(c),
        }
    }
    if any || !word.is_empty() {
        out.push(word);
    }
    out
}

/// Starts a command through niri (`{"Action":{"Spawn":{"command":[...]}}}`), the
/// shell's `niri::act`.
fn spawn(command: Vec<String>) -> Result<(), String> {
    let socket = std::env::var_os("NIRI_SOCKET").ok_or("niri isn't running")?;
    let mut stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    let request = serde_json::json!({ "Action": { "Spawn": { "command": command } } }).to_string() + "\n";
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).map_err(|e| e.to_string())?;
    if reply.contains("\"Ok\"") { Ok(()) } else { Err(reply.trim().to_string()) }
}

/// A folder in a new foot window (step 6's Open in Terminal uses it).
#[allow(dead_code)]
pub fn terminal(folder: &Path) -> Result<(), String> {
    spawn(vec!["foot".into(), "--working-directory".into(), folder.to_string_lossy().into_owned()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_words() {
        assert_eq!(words(r#"foo "a b" %U"#), ["foo", "a b", "%U"]);
        assert_eq!(words(r#""/opt/x y/run" --flag"#), ["/opt/x y/run", "--flag"]);
        let d = Desktop { file: PathBuf::from("/x.desktop"), exec: "mpv --player-operation-mode=pseudo-gui -- %U".into(), name: "mpv".into(), icon: String::new(), terminal: false };
        assert_eq!(d.command(&["/a b.mkv".into()]), ["mpv", "--player-operation-mode=pseudo-gui", "--", "file:///a%20b.mkv"]);
        assert!(d.takes_many());
        assert_eq!(d.command(&["/a.mkv".into(), "/b.mkv".into()])[3..], ["file:///a.mkv", "file:///b.mkv"]);
        let d = Desktop { exec: "viewer %f".into(), ..d };
        assert!(!d.takes_many());
        assert_eq!(d.command(&["/a.png".into(), "/b.png".into()]), ["viewer", "/a.png"]);
        let d = Desktop { exec: "vim".into(), terminal: true, ..d };
        assert_eq!(d.command(&["/n.txt".into()]), ["foot", "vim", "/n.txt"]);
    }

    #[test]
    fn unhandled_words() {
        assert_eq!(unhandled("application/octet-stream"), "The file is of an unknown type");
        // A type with no description file says its own name.
        assert_eq!(unhandled("application/x-mp-none"), "There is no app installed for \u{201c}application/x-mp-none\u{201d} files");
    }
}
