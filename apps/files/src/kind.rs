//! What a file is, from its name alone (nothing read from the file while a folder
//! lists): shared-mime-info's `/usr/share/mime/globs2` (`weight:type:glob[:flags]`,
//! highest weight first), its simple globs only (`*.ext` and whole names), the
//! longest matching end winning (the shared-mime-info spec). Each type falls into
//! one of a few kinds, each drawn with its Boxicon.

use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    Folder,
    Text,
    Code,
    Image,
    Audio,
    Video,
    Archive,
    Book,
    Package,
    File,
}

pub const KINDS: [Kind; 10] = [Kind::Folder, Kind::Text, Kind::Code, Kind::Image, Kind::Audio, Kind::Video, Kind::Archive, Kind::Book, Kind::Package, Kind::File];

#[derive(Default)]
struct Globs {
    /// `*.tar.gz` -> its type, lower case unless the glob says it cares (`cs`).
    ends: HashMap<String, &'static str>,
    ends_cased: HashMap<String, &'static str>,
    names: HashMap<String, &'static str>,
    names_cased: HashMap<String, &'static str>,
}

fn globs() -> &'static Globs {
    static GLOBS: OnceLock<Globs> = OnceLock::new();
    GLOBS.get_or_init(|| {
        let mut g = Globs::default();
        let Ok(text) = std::fs::read_to_string("/usr/share/mime/globs2") else { return g };
        // Read once for the program's life: the types stay, borrowed for good.
        let text: &'static str = Box::leak(text.into_boxed_str());
        for line in text.lines().filter(|l| !l.starts_with('#')) {
            let mut parts = line.splitn(4, ':');
            let (Some(_weight), Some(mime), Some(glob)) = (parts.next(), parts.next(), parts.next()) else { continue };
            let cased = parts.next().is_some_and(|f| f.split(',').any(|f| f == "cs"));
            if let Some(end) = glob.strip_prefix("*.") {
                if end.contains(['*', '?', '[']) {
                    continue;
                }
                // The file lists the heaviest first: the first seen keeps the end.
                if cased {
                    g.ends_cased.entry(end.to_string()).or_insert(mime);
                } else {
                    g.ends.entry(end.to_lowercase()).or_insert(mime);
                }
            } else if !glob.contains(['*', '?', '[']) {
                if cased {
                    g.names_cased.entry(glob.to_string()).or_insert(mime);
                } else {
                    g.names.entry(glob.to_lowercase()).or_insert(mime);
                }
            }
        }
        g
    })
}

/// The type a name says, or none (no known end).
pub fn mime(name: &str) -> Option<&'static str> {
    let g = globs();
    if let Some(m) = g.names_cased.get(name).or_else(|| g.names.get(&name.to_lowercase())) {
        return Some(m);
    }
    // From the first dot on: the longest end first.
    for (i, _) in name.match_indices('.') {
        let end = &name[i + 1..];
        if end.is_empty() {
            continue;
        }
        if let Some(m) = g.ends_cased.get(end) {
            return Some(m);
        }
        if let Some(m) = g.ends.get(&end.to_lowercase()) {
            return Some(m);
        }
    }
    None
}

pub fn of(name: &str, folder: bool) -> Kind {
    if folder {
        return Kind::Folder;
    }
    mime(name).map(from_mime).unwrap_or(Kind::File)
}

fn from_mime(m: &str) -> Kind {
    let (top, sub) = m.split_once('/').unwrap_or((m, ""));
    match top {
        "image" => return Kind::Image,
        "audio" => return Kind::Audio,
        "video" => return Kind::Video,
        _ => {}
    }
    if ["zip", "tar", "compressed", "rar", "archive", "gzip", "bzip", "xz", "zstd", "lzma", "lz4", "lzip", "cpio"].iter().any(|w| sub.contains(w)) && !sub.contains("officedocument") && !sub.contains("opendocument") {
        return Kind::Archive;
    }
    if sub == "pdf" || sub.contains("epub") || sub.contains("djvu") {
        return Kind::Book;
    }
    if ["executable", "sharedlib", "package", "rpm", "appimage", "msdownload", "iso9660", "disk-image", "flatpak", "deb"].iter().any(|w| sub.contains(w)) {
        return Kind::Package;
    }
    if m == "text/plain" || m == "text/markdown" || m == "text/csv" || sub.contains("opendocument") || sub.contains("officedocument") || sub == "msword" || sub == "rtf" {
        return Kind::Text;
    }
    if top == "text" || ["javascript", "json", "xml", "shellscript", "perl", "ruby", "php", "toml", "yaml", "sql", "python", "x-desktop"].iter().any(|w| sub.contains(w)) {
        return Kind::Code;
    }
    Kind::File
}

/// A type's parents (`/usr/share/mime/subclasses`: `child parent` a line), for a
/// program that opens the parent (a Rust file opens as plain text).
pub fn parents(m: &str) -> Vec<&'static str> {
    static SUB: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    let sub = SUB.get_or_init(|| {
        let Ok(text) = std::fs::read_to_string("/usr/share/mime/subclasses") else { return Vec::new() };
        let text: &'static str = Box::leak(text.into_boxed_str());
        text.lines().filter_map(|l| l.split_once(' ')).collect()
    });
    let mut out: Vec<&'static str> = Vec::new();
    let mut at = vec![m.to_string()];
    while let Some(m) = at.pop() {
        for (child, parent) in sub {
            if *child == m && !out.contains(parent) {
                out.push(parent);
                at.push(parent.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longest_end_wins() {
        assert_eq!(mime("a.tar.gz"), Some("application/x-compressed-tar"));
        assert_eq!(mime("photo.JPG"), Some("image/jpeg"));
        assert_eq!(mime("Makefile"), Some("text/x-makefile"));
        assert_eq!(of("notes.md", false), Kind::Text);
        assert_eq!(of("main.rs", false), Kind::Code);
        assert_eq!(of("song.opus", false), Kind::Audio);
        assert_eq!(of("noend", false), Kind::File);
        assert!(parents("text/rust").contains(&"text/plain"));
    }
}
