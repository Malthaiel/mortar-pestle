//! The desktop's own Open window (xdg-desktop-portal's FileChooser), asked by hand
//! over the session bus with zbus 6 (`ashpd` needs zbus 5, a second copy; a file
//! dropped on a window can't work: winit has file drops on X11 only).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use iced::futures::StreamExt;
use zbus::message::Type;
use zbus::{Connection, MatchRule, MessageStream, OwnedVariant, Variant};

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";

/// The files picked in an Open window titled `title` (several when `many`), showing
/// only the MIME types of `filter` under its name (none: every file); empty when it
/// was closed. Waits for it: run it off the window's thread.
pub fn open(title: &str, filter: Option<(&str, &[&str])>, many: bool) -> Vec<PathBuf> {
    zbus::block_on(ask(title, filter, many)).unwrap_or_else(|e| {
        eprintln!("Open window: {e}");
        Vec::new()
    })
}

async fn ask(title: &str, filter: Option<(&str, &[&str])>, many: bool) -> zbus::Result<Vec<PathBuf>> {
    static ASKED: AtomicU32 = AtomicU32::new(0);
    let conn = Connection::session().await?;
    // The answer comes as a signal on a path made of our bus name and a token (the
    // portal's `Request`): listened for before asking, so a quick one can't slip by.
    let sender = conn.unique_name().map(|n| n.as_str().trim_start_matches(':').replace('.', "_")).unwrap_or_default();
    let token = format!("mp_{}_{}", std::process::id(), ASKED.fetch_add(1, Ordering::Relaxed));
    let request = format!("{PATH}/request/{sender}/{token}");
    let rule = MatchRule::builder().msg_type(Type::Signal).interface("org.freedesktop.portal.Request").member("Response").path(request.as_str()).build()?;
    let mut answers = MessageStream::for_match_rule(rule, &conn, None).await?;

    let mut options: HashMap<&str, Variant> = HashMap::from([("handle_token", Variant::from(token.as_str())), ("multiple", Variant::from(many))]);
    if let Some((name, types)) = filter {
        options.insert("filters", Variant::from(vec![(name, types.iter().map(|t| (1u32, *t)).collect::<Vec<_>>())]));
    }
    conn.call_method(Some(PORTAL), PATH, Some("org.freedesktop.portal.FileChooser"), "OpenFile", &("", title, options)).await?;

    let Some(msg) = answers.next().await else { return Ok(Vec::new()) };
    // 0 = picked, 1 = closed, 2 = failed.
    let (code, mut results) = msg?.body().deserialize::<(u32, HashMap<String, OwnedVariant>)>()?;
    if code != 0 {
        return Ok(Vec::new());
    }
    let uris = results.remove("uris").and_then(|v| Vec::<String>::try_from(v).ok()).unwrap_or_default();
    Ok(uris.iter().filter_map(|u| u.strip_prefix("file://")).map(|p| PathBuf::from(unescape(p))).collect())
}

/// A file address's `%XX` letters as the bytes they stand for (a `file://` link, a
/// `.trashinfo` path): the one decoder every app uses. A `%` not followed by two hex
/// digits stays as written.
pub fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |i: usize| b.get(i).and_then(|&c| (c as char).to_digit(16));
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], hex(i + 1), hex(i + 2)) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            (c, ..) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::unescape;

    #[test]
    fn unescape_turns_percent_pairs_into_bytes() {
        assert_eq!(unescape("/a%20b/%C3%A9.mp3"), "/a b/\u{e9}.mp3");
        // Not a pair: kept as written.
        assert_eq!(unescape("100%"), "100%");
        assert_eq!(unescape("%zz%4"), "%zz%4");
        // A sign is no hex digit (`from_str_radix` took "+f" for 15).
        assert_eq!(unescape("%+f%41"), "%+fA");
    }
}
