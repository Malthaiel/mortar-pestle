//! Shield scriptlet layer — injects one bootstrap `UserScript` into each tab's
//! MAIN world at document-start. The script carries a clean-room library of the
//! supported uBlock scriptlets (`scriptlets_lib.js`) plus a generated rule table
//! (`seed/scriptlets.json`); a dispatcher runs only the scriptlets whose domains
//! suffix-match the page hostname. Entirely safe bindings (`UserScript` +
//! `UserContentManager::add_script`) — no FFI.
//!
//! This is the most fragile layer (esp. YouTube): sites change, and the
//! supported subset deliberately excludes uBlock's `trusted-*` network-response
//! rewriting (the current primary YouTube defeat). The classic
//! `set ytInitialPlayerResponse.adPlacements=undefined` + `json-prune` rules are
//! covered, which still helps but will miss server-side-inserted ads.

use std::sync::OnceLock;

// `bootstrap`/`rule_count`/the rule table are pure data, used for the WebView2
// init-script. The WebKit injector that also consumed them went with Linux
// (2026-08-06).

/// Generated rule table: `[{"d":[domains],"s":name,"a":[args]}]`.
const RULES_JSON: &str = include_str!("seed/scriptlets.json");

/// Clean-room scriptlet library + dispatcher (reads the prepended `RULES`).
const LIB_JS: &str = include_str!("scriptlets_lib.js");

/// Full bootstrap source, assembled once: `RULES` literal wrapped around the
/// library. The literal braces of the IIFE are escaped (`{{`/`}}`); the JSON's
/// own braces ride in as an interpolated value and are untouched.
static BOOTSTRAP: OnceLock<String> = OnceLock::new();

/// Full scriptlet bootstrap source. `pub` so the Windows browser port can embed
/// it in its WebView2 document-start init-script (Linux uses it via `attach`).
pub fn bootstrap() -> &'static str {
    BOOTSTRAP.get_or_init(|| format!("(function(){{\nvar RULES={RULES_JSON};\n{LIB_JS}\n}})();"))
}

/// Number of scriptlet rules in the seed (parsed once; for the status readout).
pub fn rule_count() -> usize {
    static N: OnceLock<usize> = OnceLock::new();
    *N.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(RULES_JSON)
            .ok()
            .and_then(|v| v.as_array().map(Vec::len))
            .unwrap_or(0)
    })
}

