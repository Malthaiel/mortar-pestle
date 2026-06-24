//! Shield — native ad/tracker blocker for the in-app browser.
//!
//! Sub-feature 1 (this module): the **network layer**. A vendored
//! EasyList + EasyPrivacy pure-domain blocklist (`seed/hosts.txt`, generated)
//! is loaded into a `HashSet` at startup; the loopback-refusing browser proxy
//! (`crate::proxy`) consults [`should_block_host`] on every CONNECT and refuses
//! ad/tracker destinations *before* DNS resolution. A global enabled flag
//! (default ON, uBlock parity) gates the whole layer; the React chrome flips it
//! via `blocker_set_enabled` and restores the persisted value on start.
//!
//! Later sub-features add the per-tab WebKit content-filter (FFI), cosmetic CSS,
//! scriptlets, runtime list refresh, and the per-site allow-list.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, RwLock};

pub mod commands;
// `ffi` wraps WebKit's compiled content-filter store (webkit2gtk-sys) — Linux
// only. WebView2 has no equivalent; on Windows network blocking rides the proxy
// (host layer) and cosmetics ride JS injection (the shared `cosmetic_css` +
// `scriptlets::bootstrap`).
#[cfg(target_os = "linux")]
pub mod ffi;
pub mod lists;
pub mod scriptlets;

/// Whole-blocker master switch. Default ON; the chrome restores the persisted
/// value via `blocker_set_enabled` during startup.
static ENABLED: AtomicBool = AtomicBool::new(true);

/// Live ad/tracker host set. Seeded from the vendored `SEED`; the runtime
/// list-refresh (`blocker::lists`) hot-swaps it from freshly-fetched
/// EasyList/EasyPrivacy via `replace_hosts`.
static HOSTS: LazyLock<RwLock<HashSet<String>>> = LazyLock::new(|| RwLock::new(parse_hosts(SEED)));

/// Per-site allow-list (hosts where the user disabled Shield). Mutated by the
/// chrome via `blocker_set_site_allowed`; consulted per-tab on navigation so an
/// allow-listed host runs with the cosmetic/content-filter/scriptlet layers
/// detached. The proxy host-blocklist stays global (documented limitation). The
/// chrome persists this set and replays it on start, so it can live in-memory.
static ALLOWLIST: LazyLock<RwLock<HashSet<String>>> = LazyLock::new(|| RwLock::new(HashSet::new()));

/// Generated seed: one host per line (vendored offline baseline). `host_from_line`
/// also accepts raw `||host^` adblock rules, so the same parser handles the
/// fetched EasyList/EasyPrivacy in `blocker::lists`.
const SEED: &str = include_str!("seed/hosts.txt");

/// Vendored cosmetic stylesheet baseline (chunked `selector{display:none}`).
const COSMETICS_SEED: &str = include_str!("seed/cosmetics.css");

/// Live generic cosmetic stylesheet, injected per tab. Seeded from
/// `COSMETICS_SEED`; hot-swapped by the runtime refresh (re-parsed from EasyList
/// `##` rules via `replace_cosmetics`).
static COSMETICS: LazyLock<RwLock<String>> = LazyLock::new(|| RwLock::new(COSMETICS_SEED.to_string()));

/// Generated WebKit content-blocker JSON: network block rules for path-bearing
/// rules the proxy can't express (path-level / first-party).
const CONTENT_FILTER_NET: &str = include_str!("seed/content_filter_net.json");

/// Generated WebKit content-blocker JSON: `css-display-none` for domain-scoped
/// element-hide rules (`domain##selector`).
const CONTENT_FILTER_COSMETIC: &str = include_str!("seed/content_filter_cosmetic.json");

/// Force the seed parse + log the count. Call once from `setup`, before the
/// proxy starts serving. (`blocker::lists::spawn_startup_refresh` may then swap
/// in a fresher cached/fetched set.)
pub fn init() {
    log::info!("blocker: loaded {} host rules", host_rule_count());
}

/// Parse host lines into a set. Accepts both the vendored seed (one bare domain
/// per line) and raw adblock lists (`||host^[$opts]`); paths/wildcards, comment
/// lines, and cosmetic/scriptlet lines are skipped.
pub(crate) fn parse_hosts(text: &str) -> HashSet<String> {
    text.lines().filter_map(host_from_line).collect()
}

fn host_from_line(line: &str) -> Option<String> {
    let s = line.trim();
    if s.is_empty() || s.starts_with('#') || s.starts_with('!') || s.starts_with('[') {
        return None;
    }
    // Adblock network rule `||host^` (opt. `$third-party` etc.). Only a HOST-ONLY
    // rule belongs on the proxy layer: after the host token, an optional `^`
    // separator must be followed by either end-of-line or `$<options>`. A `/path`,
    // a trailing `*`, or a `^*/path` tail is a path/wildcard rule the content-filter
    // owns — it must NOT collapse to a bare host (the SF5 white-screen regression:
    // `||youtube.com/track^` leaked youtube.com, `||twitter.com^*/log.json` leaked
    // twitter.com / x.com / bing.com — blanking every such site via the proxy block).
    if let Some(rest) = s.strip_prefix("||") {
        let hostlen = rest
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'.' || *b == b'-')
            .count();
        let host = &rest[..hostlen];
        let after = &rest[hostlen..];
        let tail = after.strip_prefix('^').unwrap_or(after);
        let host_only = tail.is_empty() || tail.starts_with('$');
        return (host_only && is_plain_host(host)).then(|| host.to_ascii_lowercase());
    }
    // Bare domain (seed format).
    is_plain_host(s).then(|| s.to_ascii_lowercase())
}

fn is_plain_host(h: &str) -> bool {
    !h.is_empty()
        && h.contains('.')
        && !h.contains("..")
        && !h.starts_with(['-', '.'])
        && !h.ends_with(['-', '.'])
        && h.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// Distill a chunked cosmetic stylesheet from generic `##selector` element-hide
/// rules. Domain-scoped (`dom##sel`) and procedural/extended selectors are
/// skipped (the content-filter handles the former; the latter is unsupported).
pub(crate) fn parse_cosmetics(text: &str) -> String {
    let mut sels: Vec<&str> = Vec::new();
    for line in text.lines() {
        let Some(sel) = line.trim().strip_prefix("##") else {
            continue;
        };
        if sel.is_empty()
            || sel.starts_with("+js")
            || sel.contains(":has(")
            || sel.contains(":-abp")
            || sel.contains(":matches")
            || sel.contains(":style")
            || sel.contains(":upward")
            || sel.contains(":remove")
            || sel.contains(":watch")
            || sel.contains(":xpath")
        {
            continue;
        }
        sels.push(sel);
    }
    let mut out = String::new();
    for chunk in sels.chunks(1000) {
        out.push_str(&chunk.join(","));
        out.push_str("{display:none!important}\n");
    }
    out
}

/// Hot-swap the live host set (runtime refresh).
pub(crate) fn replace_hosts(set: HashSet<String>) {
    if let Ok(mut g) = HOSTS.write() {
        *g = set;
    }
}

/// Hot-swap the live cosmetic stylesheet (runtime refresh).
pub(crate) fn replace_cosmetics(css: String) {
    if let Ok(mut g) = COSMETICS.write() {
        *g = css;
    }
}

/// Whether blocking is currently on.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Flip the master switch (called from the chrome).
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Number of live host rules (for the chrome's status readout).
pub fn host_rule_count() -> usize {
    HOSTS.read().map_or(0, |s| s.len())
}

/// A snapshot of the live cosmetic (element-hiding) stylesheet, injected into a
/// tab's `UserContentManager` when blocking is on for its host. Cloned because
/// the runtime refresh can hot-swap it. Injected User-level so its `!important`
/// rules win the cascade.
pub fn cosmetic_css() -> String {
    COSMETICS.read().map_or_else(|_| String::new(), |c| c.clone())
}

/// WebKit content-blocker JSON for path-level / first-party network blocking.
pub fn content_filter_net_json() -> &'static str {
    CONTENT_FILTER_NET
}

/// WebKit content-blocker JSON for domain-scoped cosmetic (element-hide) rules.
pub fn content_filter_cosmetic_json() -> &'static str {
    CONTENT_FILTER_COSMETIC
}

/// Does `set` block `host` or any parent domain? A label-wise suffix walk:
/// `a.b.example.com` checks `a.b.example.com`, `b.example.com`, `example.com`,
/// `com` — so a `||example.com^` rule covers every subdomain, while
/// `notexample.com` never matches `example.com` (no substring false-positives).
fn host_matches(set: &HashSet<String>, host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    let mut cur = h.as_str();
    loop {
        if set.contains(cur) {
            return true;
        }
        match cur.find('.') {
            Some(i) => cur = &cur[i + 1..],
            None => return false,
        }
    }
}

/// True iff blocking is ON, `host` is NOT per-site allow-listed, and `host` (or a
/// parent) is a known ad/tracker host. Consulted by `crate::proxy` on every
/// CONNECT. The allow-list bypass is the user's recovery path for a host that's
/// wrongly blocklisted; it gates ONLY this ad/tracker check — the proxy's loopback
/// / private-IP refusal is independent and can never be allow-listed away.
pub fn should_block_host(host: &str) -> bool {
    enabled()
        && !is_site_allowed(host)
        && HOSTS.read().is_ok_and(|set| host_matches(&set, host))
}

/// Add/remove `host` from the per-site allow-list. Normalized (trimmed, no
/// trailing dot, lowercased); empty hosts are ignored.
pub fn set_site_allowed(host: &str, allowed: bool) {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() {
        return;
    }
    if let Ok(mut set) = ALLOWLIST.write() {
        if allowed {
            set.insert(h);
        } else {
            set.remove(&h);
        }
    }
}

/// Is `host` (or a parent domain) allow-listed? Suffix-matched like the
/// blocklist, so allow-listing `example.com` also covers `www.example.com`.
pub fn is_site_allowed(host: &str) -> bool {
    ALLOWLIST.read().is_ok_and(|set| host_matches(&set, host))
}

/// Sorted snapshot of allow-listed hosts (for the chrome's readout).
pub fn allowed_sites() -> Vec<String> {
    ALLOWLIST.read().map_or_else(
        |_| Vec::new(),
        |set| {
            let mut v: Vec<String> = set.iter().cloned().collect();
            v.sort();
            v
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn matches_exact_and_subdomains() {
        let s = set(&["doubleclick.net", "ads.example.com"]);
        assert!(host_matches(&s, "doubleclick.net"));
        assert!(host_matches(&s, "stats.g.doubleclick.net"));
        assert!(host_matches(&s, "ads.example.com"));
        assert!(host_matches(&s, "x.y.ads.example.com"));
        assert!(host_matches(&s, "DoubleClick.net")); // case-insensitive
        assert!(host_matches(&s, "doubleclick.net.")); // trailing dot (FQDN)
    }

    #[test]
    fn no_substring_or_tld_false_positives() {
        let s = set(&["example.com"]);
        assert!(!host_matches(&s, "notexample.com"));
        assert!(!host_matches(&s, "example.com.evil.com"));
        assert!(!host_matches(&s, "com"));
        assert!(!host_matches(&s, "example.org"));
        assert!(!host_matches(&s, "example.net"));
    }

    #[test]
    fn host_from_line_keeps_host_only_blocks() {
        assert_eq!(host_from_line("||doubleclick.net^").as_deref(), Some("doubleclick.net"));
        assert_eq!(
            host_from_line("||ads.example.com^$third-party").as_deref(),
            Some("ads.example.com")
        );
        assert_eq!(host_from_line("||example.com^$domain=foo.com").as_deref(), Some("example.com"));
        assert_eq!(host_from_line("||tracker.io").as_deref(), Some("tracker.io"));
        assert_eq!(host_from_line("doubleclick.net").as_deref(), Some("doubleclick.net"));
    }

    #[test]
    fn host_from_line_drops_path_and_wildcard_rules() {
        // SF5 white-screen regression: a path-bearing rule like `||youtube.com/track^`
        // must NOT collapse to a bare `youtube.com` host block — that blanked
        // youtube/google/reddit/etc. through the proxy host-block layer.
        assert_eq!(host_from_line("||youtube.com/youtubei/v1/log_event^"), None);
        assert_eq!(host_from_line("||www.youtube.com/api/stats/qoe^"), None);
        assert_eq!(host_from_line("||google.com/pagead/conversion/"), None);
        assert_eq!(host_from_line("||github.com/_private/browser/stats"), None);
        // `^*/path` form — '^' separator then a wildcard path (leaked twitter/x/bing).
        assert_eq!(host_from_line("||twitter.com^*/log.json"), None);
        assert_eq!(host_from_line("||bing.com^*/glinkping.aspx$ping,xmlhttprequest"), None);
        assert_eq!(host_from_line("||*.doubleclick.net^"), None);
        assert_eq!(host_from_line("youtube.com,reddit.com##.ad"), None);
        assert_eq!(host_from_line("##.banner"), None);
        assert_eq!(host_from_line("! comment"), None);
    }

    #[test]
    fn is_plain_host_rejects_junk() {
        assert!(is_plain_host("youtube.com"));
        assert!(is_plain_host("a.b.example.co.uk"));
        assert!(!is_plain_host("-300x250.")); // leading '-' and trailing '.'
        assert!(!is_plain_host(".foo"));
        assert!(!is_plain_host("foo."));
        assert!(!is_plain_host("a..b"));
        assert!(!is_plain_host("nodot"));
        assert!(!is_plain_host(""));
    }
}
