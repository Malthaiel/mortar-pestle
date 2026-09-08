#!/usr/bin/env python3
"""download_anime.py — app-native MAL/AniList anime downloader.

Ports the download half of `Infrastructure/Skills/Ingest/ingest-mal.md`
(Phase 4 metadata enrich + title card + episode table + cover + Phase 4.5 Nyaa
torrent queue), minus the Claude-driven entity graph (characters / voice actors
/ studios / staff), which stays a `/ingest mal` job.

Given a MAL ID it:
  1. Enriches via AniList (queried by MAL id), with a best-effort Jikan
     side-fetch for opening/ending songs, age rating, background and episode
     titles — the only fields AniList does not carry.
  2. Writes (fresh) or minimally patches (backfill) an `/ingest mal`-compatible
     `Type: Media-Entry` title card under `Anime/Catalog/` in the Library vault
     with `## Plot`, the per-kind H2 placeholders, and a `## Episodes` table.
  3. Downloads the cover into `.../Assets/` (the `Image:` field stays the remote
     MAL URL, matching existing cards).
  4. Searches Nyaa (`nyaa_search.py`, batch-first for finished cours) and RETURNS
     the chosen magnet — Rust's built-in engine does the adding. New episodes of
     an airing series are picked up by Rust's airing poller (`anime_download.rs`),
     not by a qBittorrent RSS rule.

Unlike `download_album.py` (which streams NDJSON because yt-dlp downloads inline),
torrents are asynchronous — this script does its synchronous work and prints
exactly ONE terminal JSON object on stdout, then exits. The Rust worker owns the
add and all progress (`commands/torrent.rs`). Human diagnostics → stderr.

Terminal stdout JSON (exactly one object):
  ok:        {"ok": true, "tag": "mal-<id>", "magnet": "magnet:?...",
              "savePath": "...",
              "seriesPath": "Knowledge/Anime/.../<Title>.md",
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
status/progress overrides; skips Nyaa and the torrent engine entirely and emits
  {"ok": true, "metadataOnly": true, "seriesPath": ..., "skipped": bool}
skipped=true (and nothing written) when a card with this MAL ID already exists.
"""

import argparse
import gzip
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

ANILIST_URL = "https://graphql.anilist.co"
JIKAN_BASE = "https://api.jikan.moe/v4"
UA = "Citadel/1.0 (mortar-pestle)"
CATALOG_REL = "Anime/Catalog"
ASSETS_REL = "Anime/Assets"

_last_call = [0.0]

# Jikan's documented ceiling is 3 requests/second. 0.34s spacing sits just under
# it. Separate from `_last_call`, which paces AniList — the two are different
# services with different budgets and must not share a clock.
JIKAN_SPACING = 0.34
# A 429 whose Retry-After is longer than this is not worth waiting out: every
# Jikan field here is optional, so giving up costs some episode titles while
# stalling costs the whole download's wall-clock.
RETRY_AFTER_CAP = 5.0
_jikan_last = [0.0]


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


# ── AniList ─────────────────────────────────────────────────────────────────
# AniList replaced Jikan as the metadata source on 2026-08-25: Jikan's origin is
# dead (every 200 it still serves carries `X-Cache-Status: STALE` with a
# last-modified no newer than 2026-07-30; anything not already in its nginx
# cache 504s in ~0.4 s from every network and under every Accept-Encoding).
# See Knowledge/Mortar & Pestle/Plans/AniList Migration.md.
#
# AniList is queried BY MAL ID (`Media(idMal:)`) and its payload is adapted into
# the Jikan-shaped dict `build_card` already consumes, so the card format is
# byte-for-byte unchanged.
ANILIST_BACKOFF = (2, 5, 15)


def anilist_gql(query, variables):
    """AniList GraphQL POST. Retries 429 / 5xx / timeouts on ANILIST_BACKOFF
    (4 attempts, ~22 s). A GraphQL-level error with no data is fatal — retrying
    a malformed query never helps."""
    body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    last_err = None
    for attempt in range(len(ANILIST_BACKOFF) + 1):
        # AniList allows 30 req/min; one card costs 1-2 calls.
        elapsed = time.monotonic() - _last_call[0]
        if elapsed < 0.7:
            time.sleep(0.7 - elapsed)
        req = urllib.request.Request(
            ANILIST_URL,
            data=body,
            headers={
                "User-Agent": UA,
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Accept-Encoding": "gzip",
                # AniList answers 403 with "The AniList API has been temporarily
                # disabled due to severe stability issues" to any client that
                # does not present as their own site. Measured 2026-09-08:
                # Referer ALONE flips it to 200 -- Origin does nothing, and the
                # User-Agent is irrelevant either way (a browser UA still 403s).
                "Referer": "https://anilist.co/",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                _last_call[0] = time.monotonic()
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
            payload = json.loads(raw)
            data = payload.get("data")
            if data:
                return data
            msg = (payload.get("errors") or [{}])[0].get("message") or "no data"
            raise RuntimeError(f"AniList error: {msg}")
        except urllib.error.HTTPError as e:
            _last_call[0] = time.monotonic()
            last_err = e
            if e.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError) as e:
            _last_call[0] = time.monotonic()
            last_err = e
        if attempt < len(ANILIST_BACKOFF):
            time.sleep(ANILIST_BACKOFF[attempt])
    raise RuntimeError(
        f"AniList unavailable after {len(ANILIST_BACKOFF) + 1} attempts "
        f"(last: {last_err}). Please retry shortly."
    )


def jikan_side(path):
    """Best-effort Jikan GET for the handful of fields AniList does not carry
    (opening/ending songs, age rating, background blurb, episode titles).

    Short timeout, `None` on any failure — a dead Jikan must leave those fields
    empty and never fail a download. `Accept-Encoding: gzip` is the bucket their
    cache still answers from, and urllib does not auto-decompress it.

    THROTTLE + ONE 429 RETRY (2026-09-06). This is the ONLY place the script
    talks to Jikan, so the spacing lives here rather than at the three call
    sites. It matters because `episode_titles` pages up to 25 times in a row:
    unspaced, that blows Jikan's 3 req/s limit within the first second, and the
    loop's `if not resp: break` then TRUNCATES the episode list silently — the
    show downloads with half its titles missing and nothing says why. On a 429
    we honour `Retry-After` for one bounded wait (capped at RETRY_AFTER_CAP, so
    a "wait 60s" header gives up instead of stalling the download) and retry
    once. Worst case per call is one spacing gap + one capped wait; the
    best-effort contract is unchanged."""
    elapsed = time.monotonic() - _jikan_last[0]
    if elapsed < JIKAN_SPACING:
        time.sleep(JIKAN_SPACING - elapsed)

    req = urllib.request.Request(
        f"{JIKAN_BASE}/{path}",
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
        },
    )
    for attempt in (0, 1):
        try:
            _jikan_last[0] = time.monotonic()
            with urllib.request.urlopen(req, timeout=8) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            _jikan_last[0] = time.monotonic()
            if e.code == 429 and attempt == 0:
                try:
                    wait = float(e.headers.get("Retry-After") or JIKAN_SPACING)
                except ValueError:
                    wait = JIKAN_SPACING
                if wait <= RETRY_AFTER_CAP:
                    log(f"jikan 429 on {path}; waiting {wait:.1f}s and retrying once")
                    time.sleep(wait)
                    continue
                log(f"jikan 429 on {path}; Retry-After {wait:.0f}s exceeds cap, giving up")
            else:
                log(f"jikan side-fetch {path} unavailable ({e})")
            return None
        except Exception as e:  # noqa: BLE001 — every failure is non-fatal here
            _jikan_last[0] = time.monotonic()
            log(f"jikan side-fetch {path} unavailable ({e})")
            return None
    return None


DETAIL_QUERY = """
query($idMal:Int){
  Media(idMal:$idMal, type:ANIME){
    id idMal
    title { romaji english native }
    synonyms format episodes duration status season seasonYear source
    startDate { year month day } endDate { year month day }
    averageScore popularity
    rankings { rank type allTime }
    genres
    tags { name rank isGeneralSpoiler isMediaSpoiler }
    studios { edges { isMain node { name } } }
    description
    coverImage { extraLarge large }
    trailer { id site }
    stats { scoreDistribution { amount } }
  }
}
"""

EPISODES_QUERY = """
query($idMal:Int){ Media(idMal:$idMal, type:ANIME){ streamingEpisodes { title } } }
"""

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

FORMAT_LABELS = {
    "TV": "TV", "TV_SHORT": "TV Short", "MOVIE": "Movie", "SPECIAL": "Special",
    "OVA": "OVA", "ONA": "ONA", "MUSIC": "Music",
}

# AniList files these as tags; MAL gives them their own card field.
DEMOGRAPHIC_TAGS = ("Shounen", "Shoujo", "Seinen", "Josei", "Kids")


def humanize_enum(raw):
    """`LIGHT_NOVEL` → `Light novel`. Sentence case, matching MAL's labels;
    runs of 3 characters or fewer (TV, OVA, ONA) keep their case."""
    words = []
    for i, w in enumerate(str(raw).split("_")):
        if not w:
            continue
        words.append(w if len(w) <= 3 else (w.capitalize() if i == 0 else w.lower()))
    return " ".join(words)


def strip_html(raw):
    """AniList descriptions are HTML fragments; cards want plain text."""
    if not raw:
        return ""
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", raw, flags=re.I)
    text = re.sub(r"<\s*/?\s*p[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    for ent, ch in (("&quot;", '"'), ("&#039;", "'"), ("&apos;", "'"),
                    ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&amp;", "&")):
        text = text.replace(ent, ch)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _fuzzy(d, human=False):
    """AniList `{year,month,day}` → `2013-04-07`, or `Apr 7, 2013` when human.
    Month/day can be null; the string degrades to the precision available."""
    d = d or {}
    y, m, day = d.get("year"), d.get("month"), d.get("day")
    if not y:
        return ""
    if not m:
        return str(y)
    if human:
        return f"{MONTHS[m - 1]} {day}, {y}" if day else f"{MONTHS[m - 1]} {y}"
    return f"{y:04d}-{m:02d}-{day:02d}" if day else f"{y:04d}-{m:02d}"


def _ranking(media, kind):
    """All-time rank of the given kind, falling back to the seasonal figure."""
    rows = media.get("rankings") or []
    for all_time in (True, False):
        for r in rows:
            if r.get("type") == kind and bool(r.get("allTime")) == all_time:
                return r.get("rank")
    return None


def _named(values):
    """Plain strings → the `[{name}]` shape `build_card` reads."""
    return [{"name": v} for v in values if v]


def fetch_detail(mal_id):
    """AniList detail for a MAL id, adapted into the Jikan-shaped dict that
    `build_card` consumes. Opening/ending songs, the age rating and the
    background blurb come from a best-effort Jikan side-fetch — absent when
    Jikan is down, never fatal."""
    m = (anilist_gql(DETAIL_QUERY, {"idMal": int(mal_id)}) or {}).get("Media")
    if not m:
        return None

    tags = m.get("tags") or []
    themes = [
        t["name"] for t in tags
        if t.get("name")
        and not t.get("isGeneralSpoiler") and not t.get("isMediaSpoiler")
        and (t.get("rank") or 0) >= 60
        and t["name"] not in DEMOGRAPHIC_TAGS
    ]
    demographics = [t["name"] for t in tags if t.get("name") in DEMOGRAPHIC_TAGS]
    studio_edges = ((m.get("studios") or {}).get("edges")) or []
    studios = [e["node"]["name"] for e in studio_edges if e.get("isMain") and e.get("node")]
    producers = [e["node"]["name"] for e in studio_edges if not e.get("isMain") and e.get("node")]

    episodes = m.get("episodes")
    minutes = m.get("duration")
    duration = ""
    if minutes:
        duration = f"{minutes} min per ep" if (episodes or 1) > 1 else f"{minutes} min"

    scored_by = sum(
        b.get("amount") or 0
        for b in (((m.get("stats") or {}).get("scoreDistribution")) or [])
    )
    score = m.get("averageScore")
    aired_from, aired_to = _fuzzy(m.get("startDate")), _fuzzy(m.get("endDate"))
    human_from, human_to = _fuzzy(m.get("startDate"), True), _fuzzy(m.get("endDate"), True)
    aired_string = f"{human_from} to {human_to}" if human_to and human_to != human_from else human_from

    trailer = m.get("trailer") or {}
    trailer_url = ""
    if trailer.get("site") == "youtube" and trailer.get("id"):
        trailer_url = f"https://www.youtube.com/watch?v={trailer['id']}"

    # Jikan-only fields. A None here just leaves them out of the card.
    # `/full` is the ONLY endpoint carrying the opening/ending song lists — the
    # plain `/anime/{id}` returns `theme: null`, which is why Openings/Endings
    # were empty on every card written before 2026-08-25. Fall back to the plain
    # endpoint when `/full` is cold, since it still has rating + background.
    side = (jikan_side(f"anime/{mal_id}/full") or jikan_side(f"anime/{mal_id}") or {})
    side = side.get("data") or {}
    theme = side.get("theme") or {}

    return {
        "mal_id": m.get("idMal") or int(mal_id),
        "title": (m.get("title") or {}).get("romaji") or (m.get("title") or {}).get("english") or "",
        "title_english": (m.get("title") or {}).get("english") or "",
        "title_japanese": (m.get("title") or {}).get("native") or "",
        "title_synonyms": m.get("synonyms") or [],
        "year": m.get("seasonYear") or (m.get("startDate") or {}).get("year"),
        "season": humanize_enum(m["season"]) if m.get("season") else "",
        "type": FORMAT_LABELS.get(m.get("format"), humanize_enum(m.get("format") or "")),
        "source": humanize_enum(m["source"]) if m.get("source") else "",
        "episodes": episodes,
        "duration": duration,
        "score": round(score / 10.0, 2) if score is not None else None,
        "scored_by": scored_by or None,
        "rank": _ranking(m, "RATED"),
        "popularity": _ranking(m, "POPULAR"),
        "members": m.get("popularity"),
        "airing": m.get("status") == "RELEASING",
        "aired": {"from": aired_from, "to": aired_to, "string": aired_string},
        "genres": _named(m.get("genres") or []),
        "studios": _named(studios),
        "producers": _named(producers),
        "themes": _named(themes),
        "demographics": _named(demographics),
        "synopsis": strip_html(m.get("description")),
        "url": f"https://myanimelist.net/anime/{m.get('idMal') or mal_id}",
        "trailer": {"url": trailer_url} if trailer_url else {},
        "images": {"jpg": {"image_url": (m.get("coverImage") or {}).get("extraLarge")
                           or (m.get("coverImage") or {}).get("large") or ""}},
        # Jikan-only, best-effort:
        "rating": side.get("rating") or "",
        "background": side.get("background") or "",
        "broadcast": side.get("broadcast") or {},
        "theme": {"openings": theme.get("openings") or [],
                  "endings": theme.get("endings") or []},
    }


def _streaming_episodes(mal_id):
    """AniList fallback episode list. `streamingEpisodes` titles read
    `Episode 3 - A Dim Light`; no air dates are available. Complete for a
    normal-length licensed series, a recent-window subset for 1000-episode
    runners, empty for unlicensed titles."""
    m = (anilist_gql(EPISODES_QUERY, {"idMal": int(mal_id)}) or {}).get("Media") or {}
    out = []
    for e in m.get("streamingEpisodes") or []:
        raw = (e.get("title") or "").strip()
        if not raw.startswith("Episode "):
            continue
        rest = raw[len("Episode "):]
        num, _, title = rest.partition(" - ")
        try:
            n = int(num.strip())
        except ValueError:
            continue
        out.append({"n": n, "title": title.strip(), "aired": ""})
    out.sort(key=lambda e: e["n"])
    return out


def get_episodes(mal_id):
    """Paginated episode list → [{n, title, aired}], capped at 25 pages.

    Jikan first — it is the only source with real per-episode titles AND air
    dates — falling back to AniList's streaming titles the moment it fails."""
    out = []
    page = 1
    while page <= 25:
        resp = jikan_side(f"anime/{mal_id}/episodes?page={page}")
        if not resp:
            break
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
    if out:
        return out
    return _streaming_episodes(mal_id)


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


# ── nyaa ────────────────────────────────────────────────────────────────────
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
        detail = fetch_detail(args.mal_id)
    except Exception as e:  # noqa: BLE001 — surface any lookup failure to the worker
        fatal("anilist_failed", e)
    if not detail:
        fatal("anilist_no_data", f"MAL {args.mal_id}")
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
                req = urllib.request.Request(img, headers={"User-Agent": UA})
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
    magnet = ""
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

    # 6. The magnet goes back to Rust, which adds it to the built-in engine.

    emit({
        "ok": True,
        "tag": tag,
        "magnet": magnet,
        "savePath": local_path,
        "seriesPath": series_rel,
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
