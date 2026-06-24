# Shield seed regeneration

Reproducible regeneration of the **Shield** ad/tracker blocker's vendored seed
(`src-tauri/src/blocker/seed/`). Shield is a native, uBlock-style blocker for the
in-app browser — see `Iskariel/Plans/Browser Ad Blocker (Shield).md` for the
full design and honest ceiling.

## Run

```sh
tools/shield/regen.sh            # fetch upstream + rebuild the committed seed in place
tools/shield/regen.sh /tmp/out   # write to another dir (verification / dry run)
```

Needs `curl` + `python3` (stdlib only). After an in-place run, rebuild the app so
the new seed is re-embedded (`include_str!`): `cargo tauri dev` auto-rebuilds, or
`npm run tauri build` for a release bundle.

## What it produces

`regen.sh` fetches seven upstream lists into a temp dir, then `gen_seed.py` emits
five artifacts:

| Artifact | Source rules | Shield layer |
|---|---|---|
| `hosts.txt` | EasyList + EasyPrivacy `\|\|host^` pure-domain | proxy CONNECT blocklist |
| `cosmetics.css` | EasyList + EasyPrivacy generic `##selector` | per-tab `UserStyleSheet` |
| `content_filter_net.json` | EasyList + EasyPrivacy path/1st-party `\|\|host/path` | WebKit content-filter (FFI) |
| `content_filter_cosmetic.json` | EasyList + EasyPrivacy domain-scoped `dom##selector` | WebKit content-filter (FFI) |
| `scriptlets.json` | uBlock `dom##+js(...)` | scriptlet bootstrap (`scriptlets_lib.js`) |

Upstream: EasyList/EasyPrivacy from `easylist.to`; the `ubo-*` scriptlet lists
from `uBlockOrigin/uAssets` (`filters`, `privacy`, `quick-fixes`, `badware`,
`resource-abuse`, processed in that order).

## When to run

- **Before cutting a release**, to refresh the offline baseline and — crucially —
  the **content-filter + scriptlet** layers, which (unlike hosts + cosmetics) do
  **not** refresh at runtime. `hosts.txt` + `cosmetics.css` are hot-swapped on
  launch from a fresh `easylist.to` fetch (`src-tauri/src/blocker/lists.rs`,
  Plan SF4b); they're regenerated here only to keep the vendored offline seed
  (used on a network-less first launch) current.
- After upstream syntax changes that the parser should track.

## Faithfulness / parser parity

`gen_seed.py` is **not** a fresh interpretation of the filter syntax:

- `hosts.txt` / `cosmetics.css` generation **mirrors `blocker::parse_hosts` and
  `parse_cosmetics`** line-for-line, so the offline seed equals what the first
  runtime refresh produces from the same input. Change one, change the other.
- `content_filter_*.json` / `scriptlets.json` generation is **lifted verbatim**
  from the throwaway generators that produced the gate-approved seed (Plan
  SF2b / SF3). Nothing is silently capped — every dropped rule is counted and
  printed to stderr.

## Maintenance notes

- **Adding a scriptlet** is a three-touch change: implement it clean-room in
  `src-tauri/src/blocker/scriptlets_lib.js`, register it in that file's
  dispatcher, and add its uBlock token(s) to the `ALIAS` map in `gen_seed.py`.
  A token with no `ALIAS` entry is counted under "top dropped scriptlets".
- **WebKit `url-filter` is a limited regex subset** — no `(?:`, no alternation
  `|`, no mid-pattern `$`. `path_to_regex` emits only literal escapes, `.*`, and
  a single negated char class for the `^` separator. Rules that can't be
  expressed safely are dropped (counted), not approximated — this is why the
  content-filter is lossy versus uBlock.
- **Honest ceiling:** no `$redirect`/CSP/header rewriting, and the scriptlet
  subset deliberately excludes uBlock's `trusted-*` network-response rewriting
  (the current primary YouTube defeat). Classic `set-constant` / `json-prune`
  YouTube rules are ported and help, but server-side-inserted ads persist.
