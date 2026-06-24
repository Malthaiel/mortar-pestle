#!/usr/bin/env python3
"""download_anime.py — app-native MAL/Jikan anime downloader.

Ports the download half of `Infrastructure/Skills/Ingest/ingest-mal.md`
(Phase 4 metadata enrich + title card + episode table + cover + Phase 4.5 Nyaa
torrent queue), minus the Claude-driven entity graph (characters / voice actors
/ studios / staff), which stays a `/ingest mal` job.

Given a MAL ID it:
  1. Enriches via Jikan (/anime/{id} + /anime/{id}/episodes).
  2. Writes (fresh) or minimally patches (backfill) an `/ingest mal`-compatible
     `Type: Media-Entry` title card under `Anime/Catalog/` in the Library vault
     with `## Plot`, the per-kind H2 placeholders, and a `## Episodes` table.
  3. Downloads the cover into `.../Assets/` (the `Image:` field stays the remote
     MAL URL, matching existing cards).
  4. Searches Nyaa (`nyaa_search.py`, batch-first for finished cours) and queues
     the magnet into qBittorrent (`qbittorrent_client.py add`) tagged `mal-<id>`;
     registers an RSS rule when the series is airing.

Unlike `download_album.py` (which streams NDJSON because yt-dlp downloads inline),
qBittorrent is asynchronous — this script does its synchronous work and prints
exactly ONE terminal JSON object on stdout, then exits. The Rust worker owns all
progress (polling `qbittorrent_client.py state --tag`). Human diagnostics → stderr.

Terminal stdout JSON (exactly one object):
  ok:        {"ok": true, "tag": "mal-<id>", "savePath": "...",
              "seriesPath": "Knowledge/Anime/.../<Title>.md", "queued": N,
              "filesExpected": M, "airing": bool, "backfill": bool}
  ambiguous: {"ambiguous": true, "candidates": [ ... up to 5 ... ]}
  error:     {"error": "<code>", "detail": "<msg>"}   (exit non-zero)

  download_anime.py --mal-id <id> --vault <content> --library <library> --audio {sub|dub}
                    --type {TV|Movie|OVA|Special} [--airing]
                    [--save-root <dir>] [--download-source <magnet|group>]
                    [--metadata-only] [--status S] [--score N] [--watched-upto N]
                    [--rewatches N] [--started YYYY-MM-DD] [--finished YYYY-MM-DD]

Metadata-only mode (Add to Library / MAL import): writes the title card + cover
with `Download Status: Not-Downloaded`, an empty Local Path, and the given
status/progress overrides; skips Nyaa + qBittorrent entirely and emits
  {"ok": true, "metadataOnly": true, "seriesPath": ..., "skipped": bool}
skipped=true (and nothing written) when a card with this MAL ID already exists.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

JIKAN_BASE = "https://api.jikan.moe/v4"
JIKAN_UA = "Citadel/1.0 (agentic-os)"
CATALOG_REL = "Anime/Catalog"
ASSETS_REL = "Anime/Assets"

_last_jikan = [0.0]


# ── output ────────────────────────────────────────────────────────────────
def emit(obj):
    """The single terminal JSON object on stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


# Card path, set once the title card has been written, so error output can
# point the Rust worker at the card to mark it Failed (not leave it Queued).
_SERIES_REL = None


def fatal(code, detail=""):
    obj = {"error": code, "detail": str(detail)}
    if _SERIES_REL:
        obj["seriesPath"] = _SERIES_REL
    emit(obj)
    sys.exit(1)


# ── Jikan ───────────────────────────────────────────────────────────────────
# Transient statuses worth retrying: rate-limit (429) + gateway/5xx blips.
JIKAN_RETRY_CODES = frozenset({429, 500, 502, 503, 504})


def jikan_get(path):
    """Throttled (>=0.4s) Jikan GET. Retries transient failures — 429,
    5xx (500/502/503/504), timeouts and connection errors — up to 3
    attempts with exponential backoff (1s, then 2s)."""
    last_err = None
    for attempt in range(3):
        elapsed = time.monotonic() - _last_jikan[0]
        if elapsed < 0.4:
            time.sleep(0.4 - elapsed)
        req = urllib.request.Request(
            f"{JIKAN_BASE}/{path}",
            # Send an EMPTY Accept-Encoding. urllib otherwise auto-injects
            # `Accept-Encoding: identity`, which Jikan's nginx 504s on for
            # some entries (that variant misses cache → slow origin) while it
            # serves the default cached response instantly. An empty value
            # both suppresses urllib's identity injection and hits that warm
            # cache bucket — same request shape curl/reqwest use. See the
            # 2026-06-17 Hibike! Euphonium (mal-27989) 504 investigation.
            headers={
                "User-Agent": JIKAN_UA,
                "Accept": "application/json",
                "Accept-Encoding": "",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                _last_jikan[0] = time.monotonic()
                return json.load(r)
        except urllib.error.HTTPError as e:
            _last_jikan[0] = time.monotonic()
            last_err = e
            if e.code not in JIKAN_RETRY_CODES:
                raise  # 4xx (e.g. 404 bad MAL id) — retrying won't help.
        except (urllib.error.URLError, TimeoutError) as e:
            _last_jikan[0] = time.monotonic()
            last_err = e
        if attempt < 2:
            time.sleep(2 ** attempt)  # 1s, then 2s
    raise RuntimeError(
        f"Jikan API unavailable after 3 attempts (last: {last_err}). "
        "Please retry shortly."
    )


def get_episodes(mal_id):
    """Paginated episode list → [{n, title, aired}]. Capped at 25 pages."""
    out = []
    page = 1
    while page <= 25:
        resp = jikan_get(f"anime/{mal_id}/episodes?page={page}")
        for e in resp.get("data", []) or []:
            n = e.get("mal_id")
            if n is None:
                continue
            aired = e.get("aired")
            out.append({
                "n": n,
                "title": e.get("title") or "",
                "aired": (aired or "")[:10] if aired else "",
            })
        if not resp.get("pagination", {}).get("has_next_page"):
            break
        page += 1
        time.sleep(1.0)
    return out


# ── filesystem-safe names (matches ingest-mal Phase 3: strip / \ : ? * ") ────
def safe_filename(s):
    for ch in '/\\:?*"':
        s = s.replace(ch, "")
    s = re.sub(r"\s+", " ", s).strip().strip(".")
    return s or "Untitled"


def yaml_scalar(v):
    """JSON-encode a string as a YAML-safe double-quoted scalar."""
    return json.dumps("" if v is None else str(v), ensure_ascii=False)


def write_text(path, text):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# ── frontmatter list helpers ────────────────────────────────────────────────
def _names(detail, key):
    """Names from a Jikan `[{name}]` array (genres/studios/themes/demographics/producers)."""
    return [x.get("name") for x in (detail.get(key) or []) if x.get("name")]


def _emit_list(fm, label, values):
    """Append a YAML list field — block form when populated, `[]` when empty."""
    if values:
        fm.append(f"{label}:")
        fm.extend(f"  - {yaml_scalar(v)}" for v in values)
    else:
        fm.append(f"{label}: []")


# ── title card ────────────────────────────────────────────────────────────
def build_card(detail, episodes, local_path, source_audio,
               status="Plan-to-Watch", rating=0, started="", finished="",
               rewatches=0, watched=None, download_status="Queued"):
    """Render an /ingest mal-compatible Type: Media-Entry card. Field order +
    types match Infrastructure/Schemas/Frontmatter.md (Anime Title Card).
    The keyword overrides serve metadata-only adds/imports; the download path
    keeps the literal defaults."""
    today = date.today().isoformat()
    fm = []
    fm.append("Type: Media-Entry")
    fm.append("Domain: Anime")
    fm.append("Provider: mal")
    fm.append(f"Provider ID: {int(detail['mal_id'])}")
    fm.append(f"Title: {yaml_scalar(detail.get('title'))}")
    if detail.get("title_english"):
        fm.append(f"Title English: {yaml_scalar(detail['title_english'])}")
    if detail.get("title_japanese"):
        fm.append(f"Title Japanese: {yaml_scalar(detail['title_japanese'])}")
    fm.append(f"Status: {status}")
    fm.append(f"Created: {today}")
    fm.append(f"Ingested: {today}")
    _r = rating or 0
    fm.append(f"Personal Rating: {int(_r) if float(_r).is_integer() else _r}")
    fm.append(f"Started: {yaml_scalar(started)}")
    fm.append(f"Finished: {yaml_scalar(finished)}")
    fm.append(f"Re Watches: {int(rewatches) if rewatches else 0}")
    fm.append('Notes Link: ""')
    fm.append("Topics: []")
    if detail.get("year"):
        fm.append(f"Year: {int(detail['year'])}")
    season = detail.get("season")
    if season:
        prem = f"{str(season).capitalize()} {int(detail['year'])}" if detail.get("year") else str(season).capitalize()
        fm.append(f"Premiered: {yaml_scalar(prem)}")
    if detail.get("type"):
        fm.append(f"Format: {yaml_scalar(detail['type'])}")
    if detail.get("source"):
        fm.append(f"Source: {yaml_scalar(detail['source'])}")
    if detail.get("rating"):
        fm.append(f"Rating: {yaml_scalar(detail['rating'])}")
    broadcast = (detail.get("broadcast") or {}).get("string")
    if broadcast:
        fm.append(f"Broadcast: {yaml_scalar(broadcast)}")
    _emit_list(fm, "Genres", _names(detail, "genres"))
    _emit_list(fm, "Studio", _names(detail, "studios"))
    _emit_list(fm, "Themes", _names(detail, "themes"))
    _emit_list(fm, "Demographics", _names(detail, "demographics"))
    _emit_list(fm, "Producers", _names(detail, "producers"))
    _emit_list(fm, "Synonyms", detail.get("title_synonyms") or [])
    theme = detail.get("theme") or {}
    _emit_list(fm, "Openings", theme.get("openings") or [])
    _emit_list(fm, "Endings", theme.get("endings") or [])
    fm.append("Main Characters: []")
    fm.append('Director: ""')
    fm.append('Music: ""')
    fm.append('Series Composition: ""')
    fm.append('Original Creator: ""')
    fm.append('Script: ""')
    if detail.get("episodes") is not None:
        fm.append(f"Episodes: {int(detail['episodes'])}")
    if detail.get("duration"):
        fm.append(f"Duration: {yaml_scalar(detail['duration'])}")
    if detail.get("score") is not None:
        fm.append(f"Online Rating: {detail['score']}")
    if detail.get("scored_by") is not None:
        fm.append(f"Scored By: {int(detail['scored_by'])}")
    if detail.get("rank") is not None:
        fm.append(f"Rank: {int(detail['rank'])}")
    if detail.get("popularity") is not None:
        fm.append(f"Popularity: {int(detail['popularity'])}")
    if detail.get("members") is not None:
        fm.append(f"Members: {int(detail['members'])}")
    aired = detail.get("aired") or {}
    fm.append(f'Aired From: {yaml_scalar((aired.get("from") or "")[:10])}')
    fm.append(f'Aired To: {yaml_scalar((aired.get("to") or "")[:10])}')
    if aired.get("string"):
        fm.append(f'Aired: {yaml_scalar(aired["string"])}')
    fm.append(f"Airing: {'true' if detail.get('airing') else 'false'}")
    fm.append(f"Local Path: {yaml_scalar(local_path)}")
    fm.append(f"Download Status: {download_status}")
    if source_audio:
        fm.append(f"Download Source: {yaml_scalar(source_audio)}")
    watched_str = ", ".join(str(n) for n in (watched or []))
    fm.append(f"Watched Episodes: [{watched_str}]")
    fm.append(f'Source URL: {yaml_scalar(detail.get("url") or "")}')
    trailer_url = (detail.get("trailer") or {}).get("url")
    if trailer_url:
        fm.append(f"Trailer: {yaml_scalar(trailer_url)}")
    fm.append(f'Image: {yaml_scalar(image_of(detail))}')

    body = []
    body.append("## Plot")
    body.append("")
    if detail.get("airing"):
        body.append("*Currently airing — episode table reflects episodes released "
                    "as of download. Re-run `/ingest mal` to refresh as new "
                    "episodes air.*")
        body.append("")
    body.append(detail.get("synopsis") or "")
    body.append("")
    if detail.get("background"):
        body.append("## Background")
        body.append("")
        body.append(detail["background"])
        body.append("")
    for h2 in ("## Studio", "## Main Characters", "## Voice Actors", "## Staff"):
        body.append(h2)
        body.append("")
    body.append("## Episodes")
    body.append("")
    body.append(episode_table(episodes, detail.get("episodes")))

    return f"---\n" + "\n".join(fm) + "\n---\n\n" + "\n".join(body) + "\n"


def image_of(detail):
    return (((detail.get("images") or {}).get("jpg") or {}).get("image_url")) or ""


def episode_table(episodes, total):
    width = 3 if (total or 0) > 99 or len(episodes) > 99 else 2
    rows = ["| #   | Title                | Aired      |",
            "| --- | -------------------- | ---------- |"]
    for ep in episodes:
        title = (ep["title"] or "").replace("|", "\\|")
        rows.append(f"| {str(ep['n']).zfill(width)} | {title} | {ep['aired'] or ''} |")
    return "\n".join(rows)


# ── dedup / backfill ────────────────────────────────────────────────────────
def find_existing(catalog_dir, mal_id):
    """Return the path of an existing card with this MAL ID (own Provider ID or
    a Related IDs franchise sibling), else None."""
    pid_re = re.compile(rf"^Provider ID:\s*{mal_id}\s*$", re.M)
    rel_re = re.compile(rf"^Related IDs:.*\b{mal_id}\b", re.M)
    try:
        names = os.listdir(catalog_dir)
    except OSError:
        return None
    for name in names:
        if not name.endswith(".md"):
            continue
        p = os.path.join(catalog_dir, name)
        try:
            with open(p, encoding="utf-8") as f:
                head = f.read(4000)
        except OSError:
            continue
        if pid_re.search(head) or rel_re.search(head):
            return p
    return None


def patch_backfill(path, local_path):
    """Backfill-safe: set Download Status: Queued and Local Path (only if empty).
    Never touches Status / Personal Rating / Watched Episodes / the body."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        return False, str(e)
    new = re.sub(r"^Download Status:.*$", "Download Status: Queued", text, count=1, flags=re.M)
    if "Download Status:" not in new:
        new = new.replace("\n---\n", f"\nDownload Status: Queued\n---\n", 1)
    # Set Local Path only when currently empty ("" or absent).
    def _lp(m):
        cur = m.group(1).strip().strip('"')
        return m.group(0) if cur else f'Local Path: {yaml_scalar(local_path)}'
    new = re.sub(r'^Local Path:\s*(.*)$', _lp, new, count=1, flags=re.M)
    if new != text:
        write_text(path, new)
    return True, None


# ── nyaa + qBittorrent ──────────────────────────────────────────────────────
def run_script(script_abs, args):
    """Run a vault helper script, capture JSON stdout + return code."""
    proc = subprocess.run(
        [sys.executable, script_abs, *args],
        capture_output=True, text=True, timeout=120,
    )
    out = proc.stdout.strip()
    try:
        data = json.loads(out) if out else {}
    except json.JSONDecodeError:
        data = {"error": "bad_json", "raw": out[:200]}
    return proc.returncode, data, proc.stderr.strip()


def nyaa_search(scripts_dir, title, english, ctype, audio, batch=False, group="", backlog=False):
    args = ["--title", title, "--english-title", english or "", "--audio", audio]
    if not backlog:
        args += ["--type", ctype]
    if batch:
        args.append("--batch")
    if backlog:
        args.append("--backlog")
    if group:
        args += ["--group", group]
    return run_script(os.path.join(scripts_dir, "nyaa_search.py"), args)


def qbit(scripts_dir, *args):
    return run_script(os.path.join(scripts_dir, "qbittorrent_client.py"), list(args))


# ── main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mal-id", type=int, required=True)
    ap.add_argument("--vault", required=True)
    ap.add_argument("--library", required=True)
    ap.add_argument("--audio", choices=["sub", "dub"], default="sub")
    ap.add_argument("--type", dest="ctype", default="TV", choices=["TV", "Movie", "OVA", "Special"])
    ap.add_argument("--airing", action="store_true")
    ap.add_argument("--save-root", default=os.path.expanduser("~/Anime"))
    ap.add_argument("--download-source", default="")
    ap.add_argument("--metadata-only", action="store_true",
                    help="write card + cover only; skip Nyaa/qBittorrent (Add to Library / imports)")
    ap.add_argument("--status", default="Plan-to-Watch",
                    choices=["Plan-to-Watch", "Currently-Watching", "Completed", "On-Hold", "Dropped"])
    ap.add_argument("--score", type=float, default=0.0)
    ap.add_argument("--watched-upto", type=int, default=0)
    ap.add_argument("--rewatches", type=int, default=0)
    ap.add_argument("--started", default="")
    ap.add_argument("--finished", default="")
    args = ap.parse_args()

    # --vault = content vault (Infrastructure/Scripts helpers); --library =
    # writable Library vault that holds the card + cover (Library Migration P2).
    vault = args.vault
    library = args.library
    scripts_dir = os.path.join(vault, "Infrastructure", "Scripts")
    catalog_dir = os.path.join(library, CATALOG_REL)
    assets_dir = os.path.join(library, ASSETS_REL)

    # 1. Enrich.
    try:
        detail = jikan_get(f"anime/{args.mal_id}").get("data")
    except Exception as e:  # noqa: BLE001 — surface any Jikan failure to the worker
        fatal("jikan_failed", e)
    if not detail:
        fatal("jikan_no_data", f"MAL {args.mal_id}")
    title = detail.get("title") or f"anime-{args.mal_id}"
    english = detail.get("title_english") or ""

    # 2. Paths. Metadata-only adds own no media folder — Local Path stays empty
    # so a later real download's backfill patch can fill it.
    folder = safe_filename(title)
    if args.metadata_only:
        local_path = ""
        card_local = ""
    else:
        local_path = os.path.join(os.path.expanduser(args.save_root), folder)
        os.makedirs(local_path, exist_ok=True)
        # Card records Local Path vault-relative to the library root when the save
        # root is inside it (e.g. Anime/Videos/<Title>) — Library Migration; falls
        # back to the absolute path for out-of-library save roots.
        _lib_abs = os.path.abspath(os.path.expanduser(library))
        _lp_abs = os.path.abspath(local_path)
        card_local = (
            os.path.relpath(_lp_abs, _lib_abs)
            if os.path.commonpath([_lp_abs, _lib_abs]) == _lib_abs
            else local_path
        )
    os.makedirs(catalog_dir, exist_ok=True)
    series_rel = f"{CATALOG_REL}/{safe_filename(title)}.md"

    # 3. Title card — fresh write or backfill-safe patch. Metadata-only mode
    # never patches an existing card: a hit means "already in library" (the
    # import's dedupe-skip / resume guard).
    existing = find_existing(catalog_dir, args.mal_id)
    if args.metadata_only and existing:
        emit({
            "ok": True, "metadataOnly": True, "skipped": True,
            "seriesPath": os.path.relpath(existing, library),
        })
        return
    backfill = existing is not None
    if backfill:
        ok, err = patch_backfill(existing, card_local)
        if not ok:
            log(f"backfill patch failed: {err}")
        series_rel = os.path.relpath(existing, library)
    else:
        try:
            episodes = get_episodes(args.mal_id)
        except Exception as e:  # noqa: BLE001
            log(f"episode fetch failed ({e}); writing card without table")
            episodes = []
        total_eps = detail.get("episodes")
        upto = max(0, args.watched_upto)
        if total_eps:
            upto = min(upto, int(total_eps))
        card = build_card(
            detail, episodes, card_local, None,
            status=args.status,
            rating=args.score,
            started=args.started,
            finished=args.finished,
            rewatches=args.rewatches,
            watched=list(range(1, upto + 1)),
            download_status="Not-Downloaded" if args.metadata_only else "Queued",
        )
        write_text(os.path.join(catalog_dir, f"{safe_filename(title)}.md"), card)

        # 4. Cover (best-effort; Image: stays the remote URL).
        img = image_of(detail)
        if img:
            try:
                os.makedirs(assets_dir, exist_ok=True)
                req = urllib.request.Request(img, headers={"User-Agent": JIKAN_UA})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read()
                with open(os.path.join(assets_dir, f"{safe_filename(title)}.jpg"), "wb") as f:
                    f.write(data)
            except Exception as e:  # noqa: BLE001
                log(f"cover download failed: {e}")

    # The card now exists on disk; expose its path so any later failure marks
    # the card Failed instead of leaving it stuck at Queued.
    global _SERIES_REL
    _SERIES_REL = series_rel

    if args.metadata_only:
        emit({
            "ok": True, "metadataOnly": True, "skipped": False,
            "seriesPath": series_rel,
        })
        return

    tag = f"mal-{args.mal_id}"

    # 5. Resolve a magnet — explicit source, else Nyaa (batch-first when finished).
    magnet, group = "", ""
    if args.download_source.startswith("magnet:"):
        magnet = args.download_source
    else:
        forced_group = "" if args.download_source.startswith("magnet:") else args.download_source
        rc, data = (2, {})
        if not args.airing:
            rc, data, _ = nyaa_search(scripts_dir, title, english, args.ctype, args.audio,
                                      batch=True, group=forced_group)
        if rc != 0:
            rc, data, _ = nyaa_search(scripts_dir, title, english, args.ctype, args.audio,
                                      group=forced_group)
        if rc == 1 and isinstance(data, dict) and data.get("ambiguous"):
            emit({"ambiguous": True, "candidates": data.get("candidates", []), "seriesPath": series_rel})
            return
        if rc == 2 or not isinstance(data, dict) or not data.get("magnet"):
            fatal("no_results", f"Nyaa found no torrent for {title!r}")
        magnet = data["magnet"]
        group = data.get("group", "")

    # 6. Queue into qBittorrent.
    rc, data, err = qbit(scripts_dir, "add", "--magnet", magnet,
                         "--save-path", local_path,
                         "--tag", f"mal-ingest,Anime,{tag}")
    if rc == 1:
        fatal("auth_failed", "qBittorrent authentication failed — check Settings.")
    if rc != 0:
        fatal("qbit_add_failed", (data or {}).get("detail") or err or f"exit {rc}")
    queued = 1

    # 7. Airing → RSS rule for new episodes.
    if args.airing:
        short = re.sub(r"[^\w ]", "", title).split()[:3]
        feed_q = urllib.parse.quote_plus(f"{title} {group}".strip())
        feed = f"https://nyaa.si/?page=rss&q={feed_q}&c=1_2&f=0"
        rc, _, err = qbit(scripts_dir, "add-rss", "--feed", feed,
                         "--rule-name", tag, "--save-path", local_path,
                         "--must-contain", " ".join(short))
        if rc != 0:
            log(f"RSS rule registration failed (non-fatal): {err}")

    emit({
        "ok": True,
        "tag": tag,
        "savePath": local_path,
        "seriesPath": series_rel,
        "queued": queued,
        "filesExpected": detail.get("episodes") or 0,
        "airing": bool(args.airing),
        "backfill": backfill,
    })


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — last-resort guard so the worker always gets JSON
        fatal("unexpected", e)
