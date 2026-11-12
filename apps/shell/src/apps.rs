//! The programs the Start menu lists (M&P Shell plan, step 3): the desktop
//! entries (freedesktop Desktop Entry spec 1.5) a menu shows, each one's picture
//! from the icon theme, how it starts and how often it was started. Read on every
//! open and dropped on close; nothing is kept between.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::{env, fs};

use iced::widget::image;
use resvg::tiny_skia::{FillRule, FilterQuality, Mask, PathBuilder, Pixmap, PixmapPaint, Transform};
use resvg::usvg;

pub struct App {
    /// The desktop id (`firefox.desktop`), which the launch counts go by.
    pub id: String,
    pub name: String,
    /// `Comment`, else `GenericName` (Windows' grey line).
    pub about: String,
    /// The command as words, field codes gone (`words`).
    pub exec: Vec<String>,
    pub terminal: bool,
    /// In full colour, `side` square; none found = the menu's fallback.
    pub picture: Option<image::Handle>,
}

pub(crate) fn home() -> PathBuf {
    PathBuf::from(env::var_os("HOME").unwrap_or_default())
}

/// `$XDG_<name>` if set, else `~/<default>`.
pub(crate) fn xdg(name: &str, default: &str) -> PathBuf {
    env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(default))
}

/// `$XDG_DATA_HOME`, then `$XDG_DATA_DIRS` (unset here: the spec's default).
fn data_dirs() -> Vec<PathBuf> {
    let dirs = env::var("XDG_DATA_DIRS").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    std::iter::once(xdg("XDG_DATA_HOME", ".local/share")).chain(dirs.split(':').filter(|d| !d.is_empty()).map(PathBuf::from)).collect()
}

/// Every program a menu shows, most launched first, then A-Z (Windows'
/// `getSortedApps`), pictures drawn `side` square.
pub fn load(side: u32) -> Vec<App> {
    let desktop = env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let ours = |list: &str| list.split(';').any(|d| !d.is_empty() && desktop.split(':').any(|c| c == d));
    let icons = Icons::read();
    let mut apps = Vec::new();
    for (id, file) in read_entries() {
        let keys = group(&file);
        if keys.get("NoDisplay") == Some(&"true") || keys.get("OnlyShowIn").is_some_and(|l| !ours(l)) || keys.get("NotShowIn").is_some_and(|l| ours(l)) || keys.get("Name").is_some_and(|n| hidden_name(&unescape(n))) {
            continue;
        }
        apps.extend(app(id, &keys, &icons, side));
    }
    let counts = counts();
    let count = |a: &App| counts.get(&a.id).copied().unwrap_or(0);
    apps.sort_by(|a, b| count(b).cmp(&count(a)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    apps
}

/// Every desktop entry's id and text. The first entry of an id wins, even a
/// hidden one (it hides the rest).
fn read_entries() -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    data_dirs().iter().flat_map(|dir| entries(&dir.join("applications"))).filter(|(id, _)| seen.insert(id.clone())).filter_map(|(id, path)| Some((id, fs::read_to_string(path).ok()?))).collect()
}

/// An entry's program, if it is one that runs (an Application, not Hidden, its
/// TryExec found, a name and a command), its picture drawn `side` square.
fn app(id: String, keys: &HashMap<&str, &str>, icons: &Icons, side: u32) -> Option<App> {
    let get = |k| keys.get(k).map(|v| unescape(v)).unwrap_or_default();
    let yes = |k| keys.get(k) == Some(&"true");
    if keys.get("Type") != Some(&"Application") || yes("Hidden") || keys.get("TryExec").is_some_and(|t| !on_path(t)) {
        return None;
    }
    let (name, exec) = (get("Name"), words(&get("Exec")));
    if name.is_empty() || exec.is_empty() {
        return None;
    }
    let about = Some(get("Comment")).filter(|c| !c.is_empty()).unwrap_or_else(|| get("GenericName"));
    let picture = icons.find(&get("Icon"), side).and_then(|p| draw(&p, side));
    Some(App { id, name, about, exec, terminal: yes("Terminal"), picture })
}

/// The `.desktop` files under `dir`, with their desktop ids (sub-folders join the
/// id with `-`, as the spec says).
fn entries(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let mut walk = vec![(dir.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = walk.pop() {
        for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            if path.is_dir() {
                walk.push((path, format!("{prefix}{name}-")));
            } else if name.ends_with(".desktop") {
                found.push((prefix.clone() + &name, path));
            }
        }
    }
    found
}

/// The `[Desktop Entry]` group's keys (locale variants keep their `[xx]` and go unused).
fn group(file: &str) -> HashMap<&str, &str> {
    let mut keys = HashMap::new();
    let mut inside = false;
    for line in file.lines().map(str::trim) {
        if line.starts_with('[') {
            inside = line == "[Desktop Entry]";
        } else if inside
            && !line.starts_with('#')
            && let Some((k, v)) = line.split_once('=')
        {
            keys.entry(k.trim()).or_insert(v.trim());
        }
    }
    keys
}

/// A string value's escapes: `\s \n \t \r \\`.
fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        out.extend(chars.next().map(|e| match e {
            's' => ' ',
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            other => other,
        }));
    }
    out
}

/// `TryExec`: a path, or a name found on `$PATH`.
fn on_path(program: &str) -> bool {
    if program.contains('/') {
        return Path::new(program).is_file();
    }
    env::var_os("PATH").is_some_and(|path| env::split_paths(&path).any(|d| d.join(program).is_file()))
}

/// Windows' filter (`Launcher.jsx` `HIDE`): uninstallers, and help, docs and
/// web pages, by whole words of the name.
fn hidden_name(name: &str) -> bool {
    const ONE: [&str; 6] = ["help", "documentation", "docs", "readme", "website", "manual"];
    const TWO: [[&str; 2]; 4] = [["read", "me"], ["web", "site"], ["release", "notes"], ["support", "center"]];
    let lower = name.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|w| !w.is_empty()).collect();
    (lower.starts_with("uninstall") && words.first() == Some(&"uninstall")) || words.iter().any(|w| ONE.contains(w)) || words.windows(2).any(|pair| TWO.iter().any(|t| pair == t))
}

/// `Exec` as words, by the spec's quoting (double quotes; `\"`, `` \` ``, `\$`,
/// `\\` inside them). Nothing is opened with it, so the file and URL codes
/// (`%f %F %u %U`) stand for nothing, and the rest (`%i %c %k`, the old ones) are
/// left out too; `%%` is a `%`.
pub fn words(exec: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut quoted = false;
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                word.get_or_insert_default();
            }
            '\\' if quoted => word.get_or_insert_default().extend(chars.next()),
            ' ' | '\t' if !quoted => words.extend(word.take()),
            '%' if !quoted => {
                if chars.next() == Some('%') {
                    word.get_or_insert_default().push('%');
                }
            }
            c => word.get_or_insert_default().push(c),
        }
    }
    words.extend(word);
    words
}

/// One of the shell's own notes, in `$XDG_STATE_HOME/mp-shell`.
pub fn state(name: &str) -> PathBuf {
    xdg("XDG_STATE_HOME", ".local/state").join("mp-shell").join(name)
}

/// Writes a note, its folder made first.
pub fn save(path: &Path, text: String) {
    if let Err(e) = path.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::write(path, text)) {
        eprintln!("mp-shell: {}: {e}", path.display());
    }
}

/// The launch counts: `launches`, a `count<TAB>id` line each (Windows'
/// `launcher:counts:v1`).
fn counts_file() -> PathBuf {
    state("launches")
}

fn counts() -> HashMap<String, u32> {
    let file = fs::read_to_string(counts_file()).unwrap_or_default();
    file.lines().filter_map(|l| l.split_once('\t')).filter_map(|(n, id)| Some((id.to_string(), n.parse().ok()?))).collect()
}

/// One more launch of `id`.
pub fn count(id: &str) {
    let mut all = counts();
    *all.entry(id.to_string()).or_default() += 1;
    save(&counts_file(), all.iter().map(|(id, n)| format!("{n}\t{id}\n")).collect());
}

/// The icon theme's program pictures, one folder listing each, read once per
/// open: hicolor (no theme is set here, so the spec's fallback is the theme) in
/// `~/.icons` and each data dir's `icons`, by name; then `/usr/share/pixmaps`.
struct Icons {
    /// A name's files, each with its folder's size (None: `scalable`).
    files: HashMap<String, Vec<(Option<u32>, PathBuf)>>,
}

impl Icons {
    fn read() -> Self {
        let mut files: HashMap<String, Vec<(Option<u32>, PathBuf)>> = HashMap::new();
        let bases = std::iter::once(home().join(".icons")).chain(data_dirs().into_iter().map(|d| d.join("icons")));
        for theme in bases.map(|b| b.join("hicolor")) {
            for e in fs::read_dir(&theme).into_iter().flatten().flatten() {
                let dir = e.file_name().to_string_lossy().into_owned();
                // `24x24`, `scalable`; not `24x24@2` (a scaled screen's), not `symbolic`.
                let size = match dir.split_once('x') {
                    Some((n, _)) if !dir.contains('@') => n.parse().ok(),
                    _ if dir == "scalable" => None,
                    _ => continue,
                };
                for f in fs::read_dir(e.path().join("apps")).into_iter().flatten().flatten() {
                    let path = f.path();
                    if let (Some(name), Some("png" | "svg")) = (path.file_stem(), path.extension().and_then(|x| x.to_str())) {
                        files.entry(name.to_string_lossy().into_owned()).or_default().push((size, path));
                    }
                }
            }
        }
        Self { files }
    }

    /// `Icon=`'s file for `side`: a path as it is; else the theme's closest (an
    /// exact size, else an SVG, else the smallest PNG over the size, else one of
    /// unknown size, else the largest under); else `/usr/share/pixmaps`.
    fn find(&self, icon: &str, side: u32) -> Option<PathBuf> {
        if icon.starts_with('/') {
            return Some(PathBuf::from(icon));
        }
        let rank = |(size, path): &&(Option<u32>, PathBuf)| {
            let svg = path.extension().is_some_and(|x| x == "svg");
            match *size {
                Some(s) if s == side => (0, 0),
                _ if svg => (1, 0),
                Some(s) if s > side => (2, s),
                None => (3, 0),
                Some(s) => (4, u32::MAX - s),
            }
        };
        if let Some(best) = self.files.get(icon).and_then(|f| f.iter().min_by_key(rank)) {
            return Some(best.1.clone());
        }
        ["svg", "png"].iter().map(|x| Path::new("/usr/share/pixmaps").join(format!("{icon}.{x}"))).find(|p| p.is_file())
    }
}

/// A program's picture by its icon name or file (a notice's `app_icon`), `side`
/// square and cut round: the theme looked up on each call, and the file it found.
pub fn picture(icon: &str, side: u32) -> Option<(PathBuf, image::Handle)> {
    let icon = icon.strip_prefix("file://").unwrap_or(icon);
    if icon.is_empty() {
        return None;
    }
    let path = Icons::read().find(icon, side)?;
    let picture = draw(&path, side)?;
    Some((path, picture))
}

/// A picture file drawn once, `side` square and centred, in its own colours, cut
/// into a circle (his call 2026-10-30, strip and Start menu: as the round pills).
pub fn draw(path: &Path, side: u32) -> Option<image::Handle> {
    let data = fs::read(path).ok()?;
    let mut out = Pixmap::new(side, side)?;
    let fit = |w: f32, h: f32| {
        let scale = side as f32 / w.max(h);
        Transform::from_scale(scale, scale).post_translate((side as f32 - w * scale) / 2.0, (side as f32 - h * scale) / 2.0)
    };
    if path.extension().is_some_and(|x| x == "svg") {
        let tree = usvg::Tree::from_data(&data, &usvg::Options::default()).ok()?;
        resvg::render(&tree, fit(tree.size().width(), tree.size().height()), &mut out.as_mut());
    } else {
        let mut png = Pixmap::decode_png(&data).ok()?;
        // Halved while over twice the size: one big step down skips pixels.
        while png.width() >= 2 * side && png.height() >= 2 * side {
            let mut half = Pixmap::new(png.width() / 2, png.height() / 2)?;
            let paint = PixmapPaint { quality: FilterQuality::Bilinear, ..Default::default() };
            half.draw_pixmap(0, 0, png.as_ref(), &paint, Transform::from_scale(0.5, 0.5), None);
            png = half;
        }
        let paint = PixmapPaint { quality: FilterQuality::Bicubic, ..Default::default() };
        out.draw_pixmap(0, 0, png.as_ref(), &paint, fit(png.width() as f32, png.height() as f32), None);
    }
    let half = side as f32 / 2.0;
    let mut round = Mask::new(side, side)?;
    round.fill_path(&PathBuilder::from_circle(half, half, half)?, FillRule::Winding, true, Transform::identity());
    out.apply_mask(&round);
    let pixels = out.pixels().iter().flat_map(|p| {
        let c = p.demultiply();
        [c.red(), c.green(), c.blue(), c.alpha()]
    });
    Some(image::Handle::from_rgba(side, side, pixels.collect::<Vec<u8>>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_words() {
        assert_eq!(words("/usr/lib/firefox/firefox %u"), ["/usr/lib/firefox/firefox"]);
        assert_eq!(words("foot --server"), ["foot", "--server"]);
        assert_eq!(words(r#"sh -c "echo \"a b\" \$HOME" %F"#), ["sh", "-c", r#"echo "a b" $HOME"#]);
        assert_eq!(words("app --file=%f 100%%"), ["app", "--file=", "100%"]);
        assert_eq!(words(r#"app "" x"#), ["app", "", "x"]);
    }

    #[test]
    fn entry_group() {
        let file = "[Desktop Entry]\nName=Foot\nName[de]=Fuß\nComment=A\\sterminal\n# x=y\n[Desktop Action new]\nName=New\n";
        let keys = group(file);
        assert_eq!(keys.get("Name"), Some(&"Foot"));
        assert_eq!(unescape(keys["Comment"]), "A terminal");
        assert!(!keys.contains_key("# x"));
    }

    #[test]
    fn hidden_names() {
        assert!(hidden_name("Uninstall Steam"));
        assert!(hidden_name("GIMP Help"));
        assert!(hidden_name("Read Me"));
        assert!(!hidden_name("Helper"));
        assert!(!hidden_name("Firefox"));
    }
}
