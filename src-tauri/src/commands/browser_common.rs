//! Shared browser navigation/host allow-list helpers.
//!
//! SECURITY-CRITICAL navigation gate, used by BOTH per-OS browser drivers — the
//! Linux WebKitGTK controller (`browser.rs`) and the Windows WebView2 controller
//! (`browser_windows.rs`). Kept in one module so the two can never drift. The
//! proxy is the authoritative IP-level boundary; these are the fast literal-host
//! rejects plus a dependency-free host parse.

/// A host that must never be reachable as a navigation target (the proxy is the
/// authoritative IP-level gate; this is a fast literal-host reject).
pub fn host_blocked(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local")
}

/// Navigation allow-list: only `https:` to a non-local host (plus `about:blank`
/// for the initial load). Everything else — `http:`, `file:`, `tauri:`, `app:`,
/// `iskariel-asset:`, `javascript:`, `data:` — is refused.
pub fn nav_allowed(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    if lower == "about:blank" {
        return true;
    }
    let Some(rest) = lower.strip_prefix("https://") else {
        return false;
    };
    let host = rest
        .split(|c| c == '/' || c == '?' || c == '#' || c == ':')
        .next()
        .unwrap_or("");
    !host.is_empty() && !host_blocked(host)
}

/// Lowercased hostname from an http(s) URL, or None for about:/data: and
/// unparseable inputs. Minimal hand-parse — avoids a URL-crate dependency.
pub fn host_of_url(url: &str) -> Option<String> {
    let after = url.split_once("://")?.1;
    let authority = after.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}
