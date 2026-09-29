#!/usr/bin/env python3
"""download_album.py — app-native MusicBrainz album downloader.

Ports the download half of `Infrastructure/Skills/Ingest/ingest-musicbrainz.md`
(Phases 1-3b, minus the Claude-driven enrichment: no entity/topic pages, no
lyrics, no fun-facts). Given a release-group MBID it:

  1. Resolves the canonical release + tracklist via the MusicBrainz WS/2 API
     (same Official → earliest-date → GB/US rule the spec uses).
  2. For each track: searches YouTube (yt-dlp), scores candidates by duration /
     channel / exclusion-words, downloads the best as `.opus`, embeds the seven
     canonical Vorbis tags with ffmpeg, and verifies duration.
  3. Writes a "lite" album page (`Enriched: false`) + minimal track pages that
     the app's `read_album` parser can play immediately. A later `/ingest
     musicbrainz` run enriches them in place.

Progress is emitted as NDJSON on stdout (one JSON object per line) for the Rust
download worker; human diagnostics go to stderr. Exit 0 on completion (even with
some failed tracks), non-zero only on a fatal error.

  download_album.py --rg-mbid <id> --vault <path> [--only-missing] [--only-track N]
                    [--max-tracks N] [--metadata-only] [--status S]
  download_album.py --resolve (--watch-url U | --artist A --track-title T
                    [--album-title B] [--duration-sec N]) [--album-page P --track-key K]
  download_album.py --single --vault <path> (--watch-url U | --artist A --track-title T)

Only-track mode (per-song download): downloads just track N of the album and
treats every other track exactly like an --only-missing skip, so the album page
rewrite keeps all their rows.

Single mode (loose song, no release group): downloads one YouTube song into
`Music/Tracks/Singles/` and writes its track page. No album page, no
MusicBrainz call — the same release/track/done NDJSON events as an album run.

Resolve mode (streaming): finds one track's YouTube watch URL (cached via
--watch-url, else the same resolve_source() search the download path uses) and
prints a direct, playable googlevideo stream URL via `yt-dlp -g` — nothing is
downloaded. When the search ran, the found watch URL is written back into the
album page's empty `Track Sources:` line so later plays skip the search.

Metadata-only mode (Add to Library / imports): writes the album page with the
full MusicBrainz tracklist + cover URL but downloads no audio and writes no
track pages (the page parser dir-scans for audio, so every row reads
unavailable). Skips the yt-dlp/ffmpeg dep check. If the album page already
exists it writes nothing and reports skipped=true on the done event.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

MB_BASE = "https://musicbrainz.org/ws/2"
MB_UA = "Citadel/1.0 (altaccountrawr@proton.me)"
CAA = "https://coverartarchive.org"
ALBUMS_REL = "Music/Albums"
TRACKS_REL = "Music/Tracks"
SINGLES_REL = f"{TRACKS_REL}/Singles"
EXCLUDE_WORDS = ["live", "remix", "cover", "karaoke", "instrumental", "demo"]
# MusicBrainz writes typographic dashes and quotes ("rose‐tinted", U+2010).
# In a YouTube search they match nothing, so the right upload never comes back
# and a same-length stranger wins (2026-09-29).
PLAIN_PUNCT = str.maketrans({"‐": "-", "‑": "-", "‒": "-", "–": "-",
                             "—": "-", "‘": "'", "’": "'",
                             "“": '"', "”": '"'})
# A pasted YouTube link in the search box is a source, not a search term.
YT_URL_RE = re.compile(
    r"^(?:https?://)?(?:www\.|m\.|music\.)?(?:youtube\.com/|youtu\.be/)", re.I
)

_last_mb = [0.0]
# Running total of bytes on disk for the album (completed/skipped tracks), used
# to emit a live album SIZE in progress events. Fresh per process (one album/run).
_album_bytes = [0]


# ── output ────────────────────────────────────────────────────────────────
def emit(obj):
    """One NDJSON event on stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def fatal(message):
    emit({"event": "error", "message": message})
    sys.exit(1)


# ── MusicBrainz ─────────────────────────────────────────────────────────────
def mb_get(path):
    """Throttled (>=1.1s) MusicBrainz GET. `path` is everything after the base."""
    elapsed = time.monotonic() - _last_mb[0]
    if elapsed < 1.1:
        time.sleep(1.1 - elapsed)
    req = urllib.request.Request(
        f"{MB_BASE}/{path}",
        headers={"User-Agent": MB_UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    finally:
        _last_mb[0] = time.monotonic()
    return data


def artist_credit_names(obj):
    """Individual credited names from an `artist-credit` array."""
    out = []
    for c in obj.get("artist-credit", []) or []:
        if isinstance(c, dict) and c.get("name"):
            out.append(c["name"])
    return out


def first_artist_mbid(obj):
    for c in obj.get("artist-credit", []) or []:
        if isinstance(c, dict):
            aid = (c.get("artist") or {}).get("id")
            if aid:
                return aid
    return None


def pick_canonical(releases):
    """ingest-musicbrainz.md Phase 1 Step A: Official → earliest date → GB,US."""
    official = [r for r in releases if r.get("status") == "Official"]
    pool = official or releases
    if not pool:
        return None

    def rank(r):
        d = r.get("date") or ""
        if not d:
            d = "9999"
        c = r.get("country")
        crank = 0 if c == "GB" else (1 if c == "US" else 2)
        return (d, crank)

    return min(pool, key=rank)


# ── filesystem-safe names ────────────────────────────────────────────────────
def normalize_for_folder(s):
    """EXACT port of albums.rs::normalize_for_folder — must match so the app
    finds the audio folder. NFC, fold every dash variant to '-', collapse
    whitespace. Deliberately does NOT strip path-unsafe chars (the app doesn't
    either), so both sides agree."""
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"[‐-―−]", "-", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def sanitize_segment(s):
    """Phase 2 sanitize table — for the `<NN> - <Title>` track basename. The app
    keys audio to the table by the leading number only, so the title portion is
    free to be made fs-safe here."""
    s = s.replace("/", "-").replace("\\", "-")
    s = s.replace("?", "")
    s = s.replace(":", " -")
    for ch in "*<>|":
        s = s.replace(ch, "_")
    s = s.replace('"', "'")
    # Square brackets nest inside the `[[path|title]]` cell the playlist writer
    # emits, which Obsidian's own link parser can't unpick. Parens read the same.
    s = s.replace("[", "(").replace("]", ")")
    s = re.sub(r"[‐-―−]", "-", s)
    s = "".join("_" if ord(c) < 32 else c for c in s)
    s = re.sub(r"\s+", " ", s).strip().strip(".")
    return s or "Untitled"


def safe_filename(s):
    """Album page filename — keeps canonical glyphs (en-dashes survive, as in the
    real vault) but drops the handful of chars that break a Linux filename."""
    s = s.replace("/", "-").replace("\\", "-")
    s = s.replace(":", " -")
    s = re.sub(r'[*?"<>|]', "", s)
    s = s.replace("[", "(").replace("]", ")")  # see sanitize_segment
    s = re.sub(r"\s+", " ", s).strip().strip(".")
    return s or "Untitled"


# ── duration formatting ──────────────────────────────────────────────────────
def fmt_ms(ms):
    if not ms:
        return None
    total = round(ms / 1000)
    return f"{total // 60}:{total % 60:02d}"


def fmt_hms(total_ms):
    total = round(total_ms / 1000)
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


# ── yt-dlp ───────────────────────────────────────────────────────────────────
def ytdlp_json(spec, flat=True, timeout=180, no_playlist=False):
    args = ["yt-dlp", "--skip-download", "--dump-json"]
    if flat:
        args.append("--flat-playlist")
    if no_playlist:
        # A watch URL copied out of a playlist carries `&list=` along with it;
        # without this yt-dlp expands the whole list instead of the one video.
        args.append("--no-playlist")
    args.append(spec)
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return []
    res = []
    for line in out.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            res.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return res


def cand_field(c, *keys):
    for k in keys:
        v = c.get(k)
        if v:
            return v
    return None


def tokens_of(name):
    return [t for t in re.findall(r"[a-z0-9]+", (name or "").lower()) if len(t) >= 3]


def token_match(c, tokens):
    if not tokens:
        return True
    hay = ((c.get("title") or "") + " " + (cand_field(c, "uploader", "channel") or "")).lower()
    return any(t in hay for t in tokens)


def names_track(c, words):
    """Every word of the track title appears in the upload's title. Duration
    alone let another song on the same album win: 'JKTmelts' (206s) was saved
    as 'rose-tinted bitter grudge' (209s), 2026-09-29. A title with no Latin
    words (Japanese, say) yields no words and passes; duration still decides."""
    title_low = (c.get("title") or "").lower()
    return all(w in title_low for w in words)


def score_candidates(cands, expected_sec, track_title):
    """Phase 2 Step B. Returns (best, delta) or (None, None). Rejects exclusion
    words (unless in the MB title), uploads not naming the track, and any
    duration delta > 30s; prefers '- Topic' channels, breaks ties by view count."""
    tl = (track_title or "").lower()
    words = tokens_of(track_title)
    scored = []
    for c in cands:
        title_low = (c.get("title") or "").lower()
        if any(w in title_low and w not in tl for w in EXCLUDE_WORDS):
            continue
        if not names_track(c, words):
            continue
        dur = c.get("duration")
        if expected_sec and dur:
            delta = abs(dur - expected_sec)
            if delta > 30:
                continue
        else:
            delta = 999
        uploader = cand_field(c, "uploader", "channel") or ""
        is_topic = uploader.strip().endswith("- Topic")
        views = c.get("view_count") or 0
        scored.append((delta, 0 if is_topic else 1, -views, c))
    if not scored:
        return None, None
    scored.sort(key=lambda x: (x[0], x[1], x[2]))
    return scored[0][3], scored[0][0]


def watch_url(c):
    vid = c.get("id")
    return f"https://www.youtube.com/watch?v={vid}" if vid else c.get("url")


def resolve_source(track, album_artist, album_title, artist_mbid):
    """Find the best YouTube source for one track. Main path → niche-artist
    plausibility gate → artist-channel fallback → album-mix fallback. Returns
    (url, flag) where flag is a soft warning string or None; (None, reason) on
    failure."""
    track_title = track["title"].translate(PLAIN_PUNCT)
    track_artist = track.get("lead_artist") or track.get("artist") or album_artist
    expected = round(track["length_ms"] / 1000) if track.get("length_ms") else None
    tokens = tokens_of(album_artist)

    cands = ytdlp_json(f"ytsearch5:{track_artist} {track_title} official audio")

    # Step A.5 — plausibility gate: if nothing even mentions the artist, the
    # search is junk; go to the fallback chain rather than trust ranking.
    if cands and not any(token_match(c, tokens) for c in cands):
        log(f"  plausibility gate tripped for '{track_title}' — trying fallbacks")
        url = channel_fallback(track_title, artist_mbid, expected)
        if url:
            return url, "via artist channel"
        url = album_mix_fallback(album_artist, album_title, track, tokens, expected)
        if url:
            return url, "via album mix"
        return None, "niche artist, no plausible source"

    best, delta = score_candidates(cands, expected, track_title)
    if best is None:
        # Broaden once with a more specific query (Phase 2 Step B retry).
        cands = ytdlp_json(f'ytsearch10:"{track_title}" {track_artist}')
        best, delta = score_candidates(cands, expected, track_title)
    if best is None:
        return None, "no YouTube upload within ±30s of MB duration"

    flag = None
    if delta and 5 <= delta <= 30:
        flag = f"duration mismatch (expected {expected}s, got within {delta}s)"
    return watch_url(best), flag


def channel_fallback(track_title, artist_mbid, expected):
    """Fallback 1 — search the artist's official YouTube channel."""
    if not artist_mbid:
        return None
    try:
        data = mb_get(f"artist/{artist_mbid}?inc=url-rels&fmt=json")
    except Exception:
        return None
    for rel in data.get("relations", []) or []:
        if rel.get("type") not in ("youtube", "official homepage"):
            continue
        u = (rel.get("url") or {}).get("resource", "")
        if "youtube.com/@" not in u and "youtube.com/channel/" not in u:
            continue
        base = u.rstrip("/")
        spec = f"{base}/search?query={urllib.parse.quote(track_title)}"
        cands = ytdlp_json(spec)
        best, _ = score_candidates(cands, expected, track_title)
        if best:
            return watch_url(best)
    return None


def album_mix_fallback(album_artist, album_title, track, tokens, expected):
    """Fallback 2 — find a token-matched full-album upload and use its chapter
    timing as a duration anchor for a constrained re-search. Best-effort: the
    per-track description short-link extraction from the spec is not ported."""
    cands = ytdlp_json(f"ytsearch5:{album_artist} {album_title} full album")
    matched = [c for c in cands if token_match(c, tokens)]
    if not matched:
        return None
    matched.sort(key=lambda c: c.get("duration") or 0, reverse=True)
    mix = matched[0]
    full = ytdlp_json(watch_url(mix), flat=False, timeout=120)
    if not full:
        return None
    chapters = full[0].get("chapters") or []
    anchor = None
    for ch in chapters:
        if token_match({"title": ch.get("title", "")}, tokens_of(track["title"])):
            start, end = ch.get("start_time"), ch.get("end_time")
            if start is not None and end is not None:
                anchor = round(end - start)
            break
    target = anchor or expected
    if not target:
        return None
    title = track["title"].translate(PLAIN_PUNCT)
    cands = ytdlp_json(f"ytsearch5:{album_artist} {title}")
    words = tokens_of(title)
    best = None
    best_delta = 3
    for c in cands:
        dur = c.get("duration")
        if dur and abs(dur - target) <= best_delta and names_track(c, words):
            best, best_delta = c, abs(dur - target)
    return watch_url(best) if best else None


# ── stream resolve (no download) ─────────────────────────────────────────────
def ytdlp_stream_url(url, timeout=60):
    """Direct googlevideo audio URL for `url` via `yt-dlp -g` — nothing
    downloaded. Same format selector as download_opus so stream and download
    pick the same upload. The URL is IP + time-bound; callers re-resolve per
    play, never persist it."""
    try:
        out = subprocess.run(
            ["yt-dlp", "-g", "-f", "bestaudio[ext=webm][acodec=opus]/bestaudio", url],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None
    lines = [l.strip() for l in out.stdout.splitlines() if l.strip()]
    if out.returncode != 0 or not lines:
        tail = out.stderr.strip().splitlines()
        log(f"  yt-dlp -g failed: {tail[-1] if tail else 'no output'}")
        return None
    return lines[0]


def writeback_source(album_page, key, url):
    """Persist a found watch URL into the album page's empty Track Sources line
    so later plays skip the search. Best-effort: a miss just means a re-search
    next play."""
    try:
        with open(album_page, encoding="utf-8") as fh:
            text = fh.read()
        pat = re.compile(r'^(\s*"' + re.escape(key) + r'":)[ \t]*\r?$', re.MULTILINE)
        new, count = pat.subn(lambda m: m.group(1) + " " + url, text, count=1)
        if count:
            with open(album_page, "w", encoding="utf-8", newline="") as fh:
                fh.write(new)
        else:
            log(f"  writeback: no empty Track Sources line for key {key!r}")
    except OSError as e:
        log(f"  writeback failed: {e}")


def page_source_for(album_page, nn_prefix):
    """(key, url) for the album page's Track Sources line whose key starts with
    `NN - `. The lookup lives HERE, not in Rust: the app's frontmatter parser
    does scalars/lists only — a nested map like Track Sources never parses."""
    try:
        with open(album_page, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r'\s*"(' + re.escape(nn_prefix) + r'[^"]*)":\s*(\S+)?\s*$', line)
                if m:
                    return m.group(1), (m.group(2) or "")
    except OSError as e:
        log(f"  page_source_for failed: {e}")
    return None, ""


def run_resolve(args):
    """--resolve mode: one track → {watchUrl, streamUrl} on stdout, no download."""
    if not shutil.which("yt-dlp"):
        fatal("required tool not found on PATH: yt-dlp")
    url = args.watch_url
    key = args.track_key
    if not url and args.album_page and args.track_n:
        key, cached = page_source_for(args.album_page, f"{args.track_n:02d} - ")
        if cached:
            url = cached
    searched = False
    if not url:
        if not (args.artist and args.track_title):
            fatal("--resolve needs --watch-url or --artist + --track-title")
        track = {"title": args.track_title,
                 "length_ms": args.duration_sec * 1000 if args.duration_sec else None}
        url, info = resolve_source(track, args.artist, args.album_title or "", None)
        if not url:
            fatal(info or "no YouTube source found")
        searched = True
    stream = ytdlp_stream_url(url)
    if not stream:
        fatal("no stream URL (yt-dlp -g failed)")
    if searched and args.album_page and key:
        writeback_source(args.album_page, key, url)
    emit({"event": "resolve", "watchUrl": url, "streamUrl": stream})


def run_single(args):
    """--single mode: one loose song → Music/Tracks/Singles/<Artist - Title>.opus.

    No release group, so no MusicBrainz call and no album page — just the audio,
    a Music-Track page, and the same release/track/done events an album run emits
    (the Rust worker and the Downloads popup need no changes)."""
    for dep in ("yt-dlp", "ffmpeg", "ffprobe"):
        if not shutil.which(dep):
            fatal(f"required tool not found on PATH: {dep}")
    if not args.vault:
        fatal("--single requires --vault")

    url = args.watch_url
    title, artist = args.track_title, args.artist
    dur_sec = args.duration_sec or 0

    if url and not (title and artist):
        # Fill the gaps from the upload itself rather than trusting the caller.
        hits = ytdlp_json(url, no_playlist=True)
        c = hits[0] if hits else {}
        title = title or cand_field(c, "title")
        artist = artist or cand_field(c, "uploader", "channel", "uploader_id")
        dur_sec = dur_sec or (c.get("duration") or 0)
    if not url:
        if not (artist and title):
            fatal("--single needs --watch-url or --artist + --track-title")
        url, info = resolve_source(
            {"title": title, "length_ms": dur_sec * 1000 if dur_sec else None},
            artist, args.album_title or "", None,
        )
        if not url:
            fatal(info or "no YouTube source found")
    title = title or "Untitled"
    artist = artist or "Unknown Artist"

    key = sanitize_segment(f"{artist} - {title}")
    folder_abs = os.path.join(args.vault, SINGLES_REL)
    os.makedirs(folder_abs, exist_ok=True)
    out_base = os.path.join(folder_abs, key)

    emit({"event": "release", "title": title, "artist": artist, "trackTotal": 1,
          "year": "", "albumPath": "", "cover": ""})
    emit({"event": "track", "n": 1, "total": 1, "title": title, "status": "start"})

    meta = {"url": url, "artist": artist, "album": "", "title": title,
            "n": 1, "year": "", "disc": None}
    # No MusicBrainz duration to verify against — the upload IS the source of truth.
    opus = download_opus(url, out_base, meta, None)
    if not opus:
        emit({"event": "track", "n": 1, "total": 1, "title": title,
              "status": "fail", "reason": "download/verify failed"})
        fatal("single download failed")
    emit({"event": "track", "n": 1, "total": 1, "title": title, "status": "ok"})

    actual = probe_duration(opus)
    t = {"key": key, "title": title, "artist": artist, "n": 1, "disc": 1,
         "folder": "Singles", "url": url, "rec_id": None,
         "duration": fmt_ms(round((actual or dur_sec) * 1000)) if (actual or dur_sec) else None}
    write_track_page(folder_abs, "", t,
                     {"title": "", "artists": [artist], "year": "", "genres": [],
                      "provider": "youtube"})

    try:
        size = os.path.getsize(opus)
    except OSError:
        size = 0
    emit({"event": "done", "ok": True, "single": True, "albumPath": "",
          "downloaded": 1, "trackTotal": 1, "savePath": folder_abs,
          "sizeBytes": int(size), "failed": [],
          "audioPath": f"{SINGLES_REL}/{key}.opus", "trackPath": f"{SINGLES_REL}/{key}.md",
          "title": title, "artist": artist, "watchUrl": url,
          "duration": t["duration"]})


def run_search(args):
    """--search mode: free-text YouTube search → one `search` event, no download.

    A pasted YouTube link is handed to yt-dlp verbatim instead (one hit), so the
    same row/click/play path covers both. Metadata only (--flat-playlist), so
    nothing is resolved to a stream until a hit is actually played."""
    if not shutil.which("yt-dlp"):
        fatal("required tool not found on PATH: yt-dlp")
    limit = max(1, min(50, args.limit or 15))
    q = (args.search or "").strip()
    is_url = bool(YT_URL_RE.match(q))
    results = []
    for c in ytdlp_json(q if is_url else f"ytsearch{limit}:{q}", no_playlist=is_url):
        u = watch_url(c)
        if not u:
            continue
        results.append({
            "watchUrl": u,
            "title": cand_field(c, "title") or "",
            "uploader": cand_field(c, "uploader", "channel", "uploader_id") or "",
            "duration": c.get("duration") or None,
        })
    emit({"event": "search", "results": results})


def _run_ytdlp_streaming(dl_args, n):
    """Run yt-dlp, streaming its download progress as NDJSON `progress` events
    (throttled to ~0.4s). Returns the process return code. Lines that don't parse
    are skipped, so a progress-format change can never break the download itself."""
    proc = subprocess.Popen(
        dl_args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    start = last_emit = time.time()
    try:
        for line in proc.stdout:
            if line.startswith("AGPROG|"):
                now = time.time()
                if now - last_emit >= 0.4:
                    last_emit = now
                    p = line.strip().split("|")
                    if len(p) >= 6:
                        def _n(x):
                            try:
                                return float(x)
                            except (ValueError, TypeError):
                                return None
                        downloaded = _n(p[1]) or 0.0
                        total = _n(p[2]) or _n(p[3])
                        speed = _n(p[4])
                        eta = _n(p[5])
                        emit({"event": "progress", "n": n,
                              "albumBytes": int(_album_bytes[0] + downloaded),
                              "trackTotal": int(total) if total else None,
                              "speed": speed,
                              "eta": int(eta) if eta is not None else None})
            if time.time() - start > 600:
                proc.kill()
                break
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass
    return proc.wait()


def download_opus(url, out_base, meta, expected_sec):
    """Download `url` to `<out_base>.opus`, embed metadata, verify duration.
    Returns the .opus path on success, None on failure. One retry on transient
    error (Phase 2 retry policy)."""
    opus = out_base + ".opus"
    dl_args = [
        "yt-dlp",
        "-f", "bestaudio[ext=webm][acodec=opus]/bestaudio",
        "-x", "--audio-format", "opus", "--audio-quality", "0",
        "--no-write-info-json", "--no-write-thumbnail",
        "--newline",
        "--progress-template",
        "download:AGPROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|"
        "%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
        "-o", out_base + ".%(ext)s",
        url,
    ]
    n = meta.get("n", 0)
    for attempt in (1, 2):
        try:
            rc = _run_ytdlp_streaming(dl_args, n)
        except Exception as e:
            rc = 1
            log(f"  download attempt {attempt} crashed: {e}")
        if rc == 0:
            break
        log(f"  download attempt {attempt} failed: rc={rc}")
        if attempt == 1:
            time.sleep(15)
        else:
            return None
    if not os.path.exists(opus) or os.path.getsize(opus) == 0:
        return None

    # ffmpeg metadata embed (tmp + rename, idempotent).
    tmp = opus + ".tmp.opus"
    ff = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", opus,
        "-map_metadata", "-1",
        "-metadata", f"SOURCE_URL={meta['url']}",
        "-metadata", f"ARTIST={meta['artist']}",
        "-metadata", f"ALBUM={meta['album']}",
        "-metadata", f"TITLE={meta['title']}",
        "-metadata", f"TRACKNUMBER={meta['n']}",
        "-metadata", f"DATE={meta['year']}",
    ]
    if meta.get("disc"):
        ff += ["-metadata", f"DISCNUMBER={meta['disc']}"]
    ff += ["-c", "copy", tmp]
    try:
        subprocess.run(ff, capture_output=True, text=True, timeout=120, check=True)
        os.replace(tmp, opus)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        log(f"  ffmpeg metadata embed failed: {e}")
        if os.path.exists(tmp):
            os.remove(tmp)
        # The audio is fine even without the canonical tags — keep it.

    # Verify duration within 5s of MB expected.
    if expected_sec:
        actual = probe_duration(opus)
        if actual is not None and abs(actual - expected_sec) > 5:
            log(f"  duration verify failed: expected {expected_sec}s, got {actual:.0f}s")
            os.remove(opus)
            return None
    return opus


def probe_duration(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError):
        return None


# ── page writers ─────────────────────────────────────────────────────────────
def yaml_str(s):
    """Quote a scalar for YAML when it could be misparsed."""
    if s == "":
        return '""'
    if re.search(r'[:#\[\]{}",&*!|>%@`]|^\s|\s$|^-', s):
        return '"' + s.replace('"', '\\"') + '"'
    return s


def write_album_page(abs_path, fm, tracks_meta, image_url, failed, multi_disc):
    today = date.today().isoformat()
    lines = ["---"]
    lines.append("Type: Media-Entry")
    lines.append("Domain: Music")
    lines.append("Provider: musicbrainz")
    lines.append(f"Provider ID: {fm['rg_mbid']}")
    lines.append(f"Release ID: {fm['release_mbid']}")
    lines.append(f"Title: {yaml_str(fm['title'])}")
    # An explicit empty --status (Add to Library) writes no status.
    lines.append(f"Status: {fm.get('status', 'Plan-to-Listen')}")
    lines.append(f"Created: {today}")
    lines.append(f"Ingested: {today}")
    lines.append("Enriched: false")
    lines.append("Personal Rating: 0")
    lines.append('Started: ""')
    lines.append('Finished: ""')
    lines.append("Re Watches: 0")
    lines.append('Notes Link: ""')
    lines.append("Topics: []")
    if fm.get("year"):
        lines.append(f"Year: {fm['year']}")
    if fm.get("release_type"):
        lines.append(f"Release Type: {fm['release_type']}")
    if fm.get("artists"):
        lines.append(f"Artist: {yaml_str(fm['artists'][0])}")
        lines.append("Artists:")
        for a in fm["artists"]:
            lines.append(f"  - {yaml_str(a)}")
    lines.append("Label: []")
    lines.append(f"Track Count: {len(tracks_meta)}")
    if fm.get("length_ms"):
        lines.append(f'Length: "{fmt_hms(fm["length_ms"])}"')
    if fm.get("country"):
        lines.append(f"Country: {fm['country']}")
    if fm.get("genres"):
        lines.append("Genres:")
        for g in fm["genres"]:
            lines.append(f"  - {yaml_str(g)}")
    lines.append(f"Source URL: https://musicbrainz.org/release-group/{fm['rg_mbid']}")
    lines.append(f"Image: {image_url or ''}")
    lines.append("Track Sources:")
    for t in tracks_meta:
        lines.append(f'  "{t["key"]}": {t["url"]}')
    lines.append("---")
    lines.append("")
    lines.append("## Cover")
    lines.append("")
    lines.append(f"![Cover]({image_url})" if image_url else "_No cover art available._")
    lines.append("")
    lines.append("## Tracks")
    lines.append("")
    last_disc = None
    for t in tracks_meta:
        if multi_disc and t["disc"] != last_disc:
            lines.append(f"### Disc {t['disc']}")
            lines.append("")
            lines.append("| # | Title | Length |")
            lines.append("|---|---|---|")
            last_disc = t["disc"]
        elif last_disc is None:
            lines.append("| # | Title | Length |")
            lines.append("|---|---|---|")
            last_disc = t["disc"]
        dur = t["duration"] or ""
        title_cell = t["title"].replace("|", r"\|")
        # Plain title — Library is wikilink-free; the app resolves audio by
        # dir-scanning the track folder (NN prefix), not via this link.
        lines.append(f'| {t["nn"]} | {title_cell} | {dur} |')
    lines.append("")
    lines.append("## Errors")
    lines.append("")
    if failed:
        for f in failed:
            lines.append(f"- {f['nn']} - {f['title']} — {f['reason']}")
    else:
        lines.append("_None._")
    lines.append("")
    with open(abs_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def write_track_page(folder_abs, album_link, t, fm):
    today = date.today().isoformat()
    page = os.path.join(folder_abs, t["key"] + ".md")
    lines = ["---"]
    lines.append("Type: Music-Track")
    lines.append("Domain: Music")
    # A --single run never touches MusicBrainz — its source is the upload itself.
    lines.append(f"Provider: {fm.get('provider') or 'musicbrainz'}")
    if t.get("rec_id"):
        lines.append(f"Provider ID: {t['rec_id']}")
    lines.append(f"Title: {yaml_str(t['title'])}")
    lines.append(f"Album: {yaml_str(fm['title'])}")
    lines.append(f"Artist: {yaml_str(t.get('artist') or fm['artists'][0])}")
    lines.append("Artists:")
    for name in t.get("artists") or [t.get("artist") or fm["artists"][0]]:
        lines.append(f"  - {yaml_str(name)}")
    lines.append(f"Track Number: {t['n']}")
    lines.append(f"Disc Number: {t['disc']}")
    lines.append(f"Length: {t['duration'] or ''}")
    if fm.get("year"):
        lines.append(f"Year: {fm['year']}")
    if fm.get("genres"):
        lines.append("Genres:")
        for g in fm["genres"]:
            lines.append(f"  - {yaml_str(g)}")
    lines.append(f"Source URL: {t['url']}")
    lines.append(f'Audio: "{TRACKS_REL}/{t["folder"]}/{t["key"]}.opus"')
    lines.append(f"Created: {today}")
    lines.append(f"Ingested: {today}")
    lines.append("---")
    lines.append("")
    with open(page, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Stops urllib from chasing a 3xx, so the redirect itself can be inspected."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def cover_url(url):
    """Ask Cover Art Archive whether this cover exists. Returns `url` or "".

    Deliberately does NOT follow the redirect. CAA answers a 307 (pointing at
    the Internet Archive) when art exists and a 404 when it does not, so the
    redirect IS the answer and the redirect target never gets a vote on a mere
    existence question.

    That mattered: until 2026-09-03 this followed the 307, and on a Windows box
    whose certificate store had not yet cached the archive.org root, Python
    raised SSLCertVerificationError. The old `head_ok` caught every exception
    alike and returned False, so a TLS gap was indistinguishable from "this
    album has no cover art" -- albums shipped with an empty `Image:` field while
    a 2.2 MB JPEG sat at the other end of the link. Anything that is not a clean
    404 is now logged rather than silently swallowed.
    """
    try:
        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": MB_UA})
        with opener.open(req, timeout=15) as r:
            return url if 200 <= r.status < 300 else ""
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            return url
        if e.code != 404:
            log(f"cover: lookup returned HTTP {e.code} for {url}")
        return ""
    except Exception as e:
        log(f"cover: lookup failed for {url}: {e}")
        return ""


def fetch_cover(url, folder_abs):
    """Save the cover beside the album's audio. Returns the filename, or "".

    Never fatal, and never worse than before: if the bytes cannot be fetched the
    caller keeps the remote URL in the page, which is exactly the pre-2026-09-03
    behaviour. Following the redirect is unavoidable here -- we want the actual
    image -- so this is the one place the redirect target's reachability counts.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": MB_UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            ctype = (r.headers.get("Content-Type") or "").lower()
            data = r.read()
        if not data:
            log("cover: download returned an empty body")
            return ""
        name = "cover.png" if "png" in ctype else "cover.jpg"
        with open(os.path.join(folder_abs, name), "wb") as f:
            f.write(data)
        log(f"cover: saved {name} ({len(data)} bytes)")
        return name
    except Exception as e:
        log(f"cover: download failed for {url}: {e}")
        return ""


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rg-mbid")
    ap.add_argument("--vault")
    ap.add_argument("--only-missing", action="store_true")
    ap.add_argument("--only-track", type=int, default=0,
                    help="download only track N; every other track is skipped, not dropped")
    ap.add_argument("--max-tracks", type=int, default=0)
    ap.add_argument("--metadata-only", action="store_true",
                    help="write the album page only; no audio (Add to Library / imports)")
    ap.add_argument("--status", default="Plan-to-Listen",
                    choices=["Plan-to-Listen", "Currently-Listening", "Listened", "Dropped"])
    # Resolve mode (streaming) — one track, no download, no --rg-mbid/--vault.
    ap.add_argument("--resolve", action="store_true",
                    help="resolve one track to a live stream URL; no download")
    # Single mode — one loose song with no release group.
    ap.add_argument("--single", action="store_true",
                    help="download one loose song into Music/Tracks/Singles/")
    ap.add_argument("--watch-url")
    ap.add_argument("--artist")
    ap.add_argument("--album-title")
    ap.add_argument("--track-title")
    ap.add_argument("--duration-sec", type=int, default=0)
    ap.add_argument("--album-page")
    ap.add_argument("--track-key")
    ap.add_argument("--track-n", type=int, default=0)
    # Search mode — free-text YouTube search, metadata only.
    ap.add_argument("--search", help="free-text YouTube search; prints hits, downloads nothing")
    ap.add_argument("--limit", type=int, default=15)
    args = ap.parse_args()

    if args.resolve:
        run_resolve(args)
        return
    if args.search:
        run_search(args)
        return
    if args.single:
        run_single(args)
        return
    if not args.rg_mbid or not args.vault:
        ap.error("--rg-mbid and --vault are required")

    if not args.metadata_only:
        for dep in ("yt-dlp", "ffmpeg", "ffprobe"):
            if not shutil.which(dep):
                fatal(f"required tool not found on PATH: {dep}")

    vault = args.vault
    rg_mbid = args.rg_mbid

    # ── MusicBrainz: canonical release + tracklist ──
    try:
        rg = mb_get(f"release-group/{rg_mbid}?inc=releases+artist-credits+genres&fmt=json")
    except Exception as e:
        fatal(f"MusicBrainz release-group fetch failed: {e}")
    releases = rg.get("releases", []) or []
    canonical = pick_canonical(releases)
    if not canonical:
        fatal("MusicBrainz release-group has no releases.")
    release_mbid = canonical["id"]
    try:
        rel = mb_get(f"release/{release_mbid}?inc=recordings+artist-credits+genres&fmt=json")
    except Exception as e:
        fatal(f"MusicBrainz release fetch failed: {e}")

    title = rg.get("title") or "Untitled"
    artists = artist_credit_names(rg) or ["Unknown Artist"]
    artist_mbid = first_artist_mbid(rg)
    year = (rg.get("first-release-date") or "")[:4]
    release_type = rg.get("primary-type")
    country = rel.get("country")
    genres = [g["name"] for g in (rg.get("genres") or rel.get("genres") or []) if g.get("name")]
    genres = sorted(set(genres))

    media = rel.get("media", []) or []
    multi_disc = len(media) > 1
    tracks = []
    flat_n = 0
    for medium in media:
        disc = medium.get("position", 1)
        for t in medium.get("tracks", []) or []:
            flat_n += 1
            rec = t.get("recording") or {}
            names = artist_credit_names(t)
            tracks.append({
                "n": flat_n,
                "disc": disc,
                "title": t.get("title") or rec.get("title") or "Untitled",
                "length_ms": t.get("length") or rec.get("length"),
                "rec_id": rec.get("id"),
                # Comma-joined for the one-line Artist field and the ARTIST
                # tag; space-joined read as a single name (2026-09-29).
                "artist": ", ".join(names) or None,
                "artists": names,
                # The search uses the lead credit alone: the whole credit
                # ("ippo.tsk Eleanor Forte R1", singers included) is a query
                # YouTube matches nothing to (2026-09-29).
                "lead_artist": names[0] if names else None,
            })
    if not tracks:
        fatal("MusicBrainz release has no tracklist.")
    if args.max_tracks and args.max_tracks > 0:
        tracks = tracks[: args.max_tracks]

    # ── paths ──
    artist0 = artists[0]
    folder_name = f"{normalize_for_folder(artist0)} - {normalize_for_folder(title)}"
    folder_abs = os.path.join(vault, TRACKS_REL, folder_name)
    if not args.metadata_only:
        os.makedirs(folder_abs, exist_ok=True)
    album_basename = safe_filename(
        f"{title} (by {artist0} - {year})" if year else f"{title} (by {artist0})"
    )
    album_abs = os.path.join(vault, ALBUMS_REL, album_basename + ".md")
    album_link = f"{ALBUMS_REL}/{album_basename}"
    os.makedirs(os.path.dirname(album_abs), exist_ok=True)

    # ── cover (decision #10: rg cover, else release cover, else none) ──
    image_url = (cover_url(f"{CAA}/release-group/{rg_mbid}/front")
                 or cover_url(f"{CAA}/release/{release_mbid}/front"))
    # Save it next to the audio (user-directed 2026-09-03) so the catalog renders
    # offline and never re-fetches. `image_ref` is what goes in the page: the
    # Library-relative file when we got the bytes, else the remote URL as before.
    # Metadata-only cards have no track folder, so they keep the URL.
    image_ref = image_url
    if image_url and not args.metadata_only:
        name = fetch_cover(image_url, folder_abs)
        if name:
            image_ref = f"{TRACKS_REL}/{folder_name}/{name}"

    emit({
        "event": "release", "title": title, "artist": artist0,
        "trackTotal": 1 if args.only_track else len(tracks), "year": year,
        "albumPath": f"{ALBUMS_REL}/{album_basename}.md",
        "cover": image_url,
    })

    # ── metadata-only: write the album page (full tracklist, no audio) and stop ──
    if args.metadata_only:
        if os.path.exists(album_abs):
            # Already in the library — never clobber an existing card's
            # status/rating (the import's dedupe-skip / resume guard).
            emit({"event": "done", "ok": True, "metadataOnly": True, "skipped": True,
                  "albumPath": f"{ALBUMS_REL}/{album_basename}.md", "downloaded": 0,
                  "trackTotal": len(tracks), "savePath": "", "sizeBytes": 0, "failed": []})
            return
        track_sources = []
        total_ms = 0
        for t in tracks:
            nn = f"{t['n']:02d}"
            key = sanitize_segment(f"{nn} - {t['title']}")
            track_sources.append({"key": key, "url": "", "nn": nn, "title": t["title"],
                                  "disc": t["disc"], "duration": fmt_ms(t["length_ms"])})
            if t.get("length_ms"):
                total_ms += t["length_ms"]
        fm = {"rg_mbid": rg_mbid, "release_mbid": release_mbid, "title": title,
              "artists": artists, "year": year, "release_type": release_type,
              "country": country, "genres": genres, "length_ms": total_ms or None,
              "status": args.status}
        write_album_page(album_abs, fm, track_sources, image_ref, [], multi_disc)
        emit({"event": "done", "ok": True, "metadataOnly": True, "skipped": False,
              "albumPath": f"{ALBUMS_REL}/{album_basename}.md", "downloaded": 0,
              "trackTotal": len(tracks), "savePath": "", "sizeBytes": 0, "failed": []})
        return

    # ── per-track download ──
    done_meta = []
    failed = []
    fetched = 0
    # A one-track run is a one-track job to the Downloads popup: the album's 14
    # tracks would otherwise read as "Downloaded · 14 tracks" for a single song.
    ui_total = 1 if args.only_track else len(tracks)

    def ui_n(t):
        return 1 if args.only_track else t["n"]

    for t in tracks:
        nn = f"{t['n']:02d}"
        key = sanitize_segment(f"{nn} - {t['title']}")
        out_base = os.path.join(folder_abs, key)
        opus_path = out_base + ".opus"
        t["nn"], t["key"], t["folder"] = nn, key, folder_name

        # --only-track: every other track is a skip, NOT a drop. The album page is
        # a full rewrite from done_meta below, so a track missing here loses its row.
        if args.only_track and t["n"] != args.only_track:
            # No skip event: the popup is tracking a one-track job, not the album.
            try:
                _album_bytes[0] += os.path.getsize(opus_path)
            except OSError:
                pass
            _keep_row(done_meta, t, album_abs, key)
            continue

        if args.only_missing and os.path.exists(opus_path):
            emit({"event": "track", "n": t["n"], "total": len(tracks), "title": t["title"], "status": "skip"})
            try:
                _album_bytes[0] += os.path.getsize(opus_path)
            except OSError:
                pass
            _keep_row(done_meta, t, album_abs, key)
            continue

        emit({"event": "track", "n": ui_n(t), "total": ui_total, "title": t["title"], "status": "start"})
        url, info = resolve_source(t, artist0, title, artist_mbid)
        if not url:
            failed.append({"nn": nn, "title": t["title"], "reason": info or "no source"})
            # Real track number on a fail: the Rust worker files this into the
            # job's failed list, which has to name the track that actually failed.
            emit({"event": "track", "n": t["n"], "total": ui_total, "title": t["title"],
                  "status": "fail", "reason": info or "no source"})
            _keep_row(done_meta, t, album_abs, key)
            continue

        expected = round(t["length_ms"] / 1000) if t.get("length_ms") else None
        meta = {"url": url, "artist": t.get("artist") or artist0, "album": title,
                "title": t["title"], "n": t["n"], "year": year, "disc": t["disc"] if multi_disc else None}
        result = download_opus(url, out_base, meta, expected)
        if not result:
            failed.append({"nn": nn, "title": t["title"], "reason": "download/verify failed"})
            emit({"event": "track", "n": t["n"], "total": ui_total, "title": t["title"],
                  "status": "fail", "reason": "download/verify failed"})
            _keep_row(done_meta, t, album_abs, key)
            continue

        t["url"], t["duration"] = url, fmt_ms(t["length_ms"])
        done_meta.append(t)
        fetched += 1
        try:
            _album_bytes[0] += os.path.getsize(opus_path)
        except OSError:
            pass
        emit({"event": "track", "n": ui_n(t), "total": ui_total, "title": t["title"],
              "status": "ok", "flag": info})

    if not done_meta:
        fatal("No tracks could be downloaded.")

    # ── pages ──
    track_sources = []
    total_ms = 0
    for t in done_meta:
        track_sources.append({"key": t["key"], "url": t.get("url") or "",
                              "nn": t["nn"], "title": t["title"], "disc": t["disc"],
                              "duration": t.get("duration")})
        if t.get("length_ms"):
            total_ms += t["length_ms"]

    fm = {"rg_mbid": rg_mbid, "release_mbid": release_mbid, "title": title,
          "artists": artists, "year": year, "release_type": release_type,
          "country": country, "genres": genres, "length_ms": total_ms or None}
    write_album_page(album_abs, fm, track_sources, image_ref, failed, multi_disc)
    for t in done_meta:
        if t.get("url"):
            write_track_page(folder_abs, album_link, t, fm)

    emit({"event": "done", "ok": True, "albumPath": f"{ALBUMS_REL}/{album_basename}.md",
          "downloaded": fetched, "trackTotal": ui_total,
          "savePath": folder_abs, "sizeBytes": int(_album_bytes[0]),
          "failed": [{"n": int(f["nn"]), "title": f["title"]} for f in failed]})


def _keep_row(done_meta, t, album_abs, key):
    """Keep a track's row on the album page when this run didn't fetch it.

    The page is a full rewrite from done_meta, so a skipped OR failed track that
    never lands here loses its row — on a re-run over an existing album that
    DELETES a line the card already had. The row comes back sourceless (unless
    the page still knows its URL), which reads as not-downloaded. That is right."""
    done_meta.append({**t, "url": _existing_source(album_abs, key),
                      "duration": fmt_ms(t["length_ms"])})


def _existing_source(album_abs, key):
    """For --only-missing skips: recover the track's source URL from the album
    page's Track Sources map, so it survives a re-write."""
    try:
        with open(album_abs, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r'\s*"' + re.escape(key) + r'":\s*(\S+)', line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return ""


if __name__ == "__main__":
    main()
