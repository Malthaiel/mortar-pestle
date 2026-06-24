#!/usr/bin/env python3
"""Parse a music playlist/album file (CSV or TXT) → NDJSON for library_import.rs.

Pure stdlib. Header-driven so it accepts real-world exporters (chosic, Exportify,
TuneMyMusic, our own canonical schema) — columns are matched by name aliases, not
position. TXT is treated as `Artist - Title` lines.

Output (one JSON object per line):
  {"event":"track","n":<int>,"title":..,"artist":..,"album":..,"albumArtist":..,
   "durationSecs":<int>,"trackId":..,"albumId":..}
  {"event":"parsed","kind":"playlist"|"album","trackCount":<int>,
   "distinctAlbums":[{"album":..,"albumArtist":..}, ...]}
  {"event":"error","message":..}   (+ exit 1)

`kind` auto-detects: TXT → playlist; CSV → "album" when every row shares ONE
(album, albumArtist) pair (≥2 tracks), else "playlist".
"""

import argparse
import csv
import json
import re
import sys

# Column name → canonical field. Keys are lowercased + space-collapsed headers.
ALIASES = {
    "title": ["track", "track name", "title", "song", "name", "song name", "track title"],
    "artist": ["artist", "artist name", "artist name(s)", "artists", "artist names", "performer"],
    "album": ["album", "album name", "release", "release name"],
    "album_artist": ["album artist", "album artist name", "album artist name(s)",
                     "albumartist", "album artist names", "release artist"],
    "n": ["#", "n", "no", "no.", "track number", "track_number", "position", "track #"],
    "duration": ["duration", "duration (ms)", "duration ms", "duration_ms", "length",
                 "time", "track duration (ms)", "track duration", "runtime"],
    "track_id": ["spotify track id", "track id", "track_id", "spotify_track_id",
                 "track uri", "uri", "spotify uri", "track url", "spotify track uri"],
    "album_id": ["spotify album id", "album id", "album_id", "spotify_album_id",
                 "album uri", "album url"],
}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def norm_header(h):
    return re.sub(r"\s+", " ", (h or "").strip().lower())


def build_colmap(header):
    """header (list of raw names) → {field: column_index}."""
    norm = [norm_header(h) for h in header]
    colmap = {}
    for field, names in ALIASES.items():
        for i, h in enumerate(norm):
            if h in names:
                colmap[field] = i
                break
    return colmap


def extract_id(raw):
    """spotify:track:ID / open.spotify.com/track/ID / bare ID → bare ID."""
    if not raw:
        return ""
    s = raw.strip()
    m = re.search(r"(?:spotify:(?:track|album):|/(?:track|album)/)([A-Za-z0-9]+)", s)
    if m:
        return m.group(1)
    # already a bare id (22-char base62) or unknown — return as-is sans URL noise
    return s.split("?")[0]


def parse_duration(raw, header_is_ms):
    """→ whole seconds. Handles ms columns, m:ss strings, and bare integers."""
    if raw is None:
        return 0
    s = str(raw).strip()
    if not s:
        return 0
    if ":" in s:  # m:ss or h:mm:ss
        parts = [p for p in s.split(":") if p != ""]
        try:
            nums = [int(float(p)) for p in parts]
        except ValueError:
            return 0
        secs = 0
        for p in nums:
            secs = secs * 60 + p
        return secs
    try:
        val = float(s)
    except ValueError:
        return 0
    if header_is_ms or val > 3600:  # >1h as a bare number ⇒ almost certainly ms
        return int(round(val / 1000.0))
    return int(round(val))


def cell(row, colmap, field):
    i = colmap.get(field)
    if i is None or i >= len(row):
        return ""
    return (row[i] or "").strip()


def parse_csv(path):
    rows = []
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            return rows
        colmap = build_colmap(header)
        if "title" not in colmap:
            # No recognizable title column — treat the whole thing as headerless
            # "Artist - Title"/"Title" by re-reading as TXT below.
            return None
        dur_is_ms = "ms" in norm_header(header[colmap["duration"]]) if "duration" in colmap else False
        n = 0
        for raw in reader:
            if not any((c or "").strip() for c in raw):
                continue
            title = cell(raw, colmap, "title")
            if not title:
                continue
            n += 1
            artist = cell(raw, colmap, "artist")
            album = cell(raw, colmap, "album")
            album_artist = cell(raw, colmap, "album_artist") or artist
            ncol = cell(raw, colmap, "n")
            try:
                num = int(float(ncol)) if ncol else n
            except ValueError:
                num = n
            rows.append({
                "n": num,
                "title": title,
                "artist": artist,
                "album": album,
                "albumArtist": album_artist,
                "durationSecs": parse_duration(cell(raw, colmap, "duration"), dur_is_ms),
                "trackId": extract_id(cell(raw, colmap, "track_id")),
                "albumId": extract_id(cell(raw, colmap, "album_id")),
            })
    return rows


def parse_txt(path):
    rows = []
    n = 0
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            n += 1
            if " - " in s:
                artist, title = s.split(" - ", 1)
            else:
                artist, title = "", s
            rows.append({
                "n": n, "title": title.strip(), "artist": artist.strip(),
                "album": "", "albumArtist": artist.strip(),
                "durationSecs": 0, "trackId": "", "albumId": "",
            })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    args = ap.parse_args()

    lower = args.file.lower()
    try:
        if lower.endswith(".txt"):
            rows = parse_txt(args.file)
        else:
            rows = parse_csv(args.file)
            if rows is None:  # CSV without a title column → fall back to TXT lines
                rows = parse_txt(args.file)
    except FileNotFoundError:
        emit({"event": "error", "message": f"File not found: {args.file}"})
        sys.exit(1)
    except OSError as e:
        emit({"event": "error", "message": f"Could not read file: {e}"})
        sys.exit(1)

    if not rows:
        emit({"event": "error", "message": "No tracks found in the file."})
        sys.exit(1)

    # Distinct (album, albumArtist) pairs, first-seen order, album non-empty.
    distinct = []
    seen = set()
    for r in rows:
        alb = r["album"].strip()
        if not alb:
            continue
        key = (alb.lower(), r["albumArtist"].strip().lower())
        if key in seen:
            continue
        seen.add(key)
        distinct.append({"album": alb, "albumArtist": r["albumArtist"].strip()})

    is_txt = lower.endswith(".txt")
    kind = "album" if (not is_txt and len(distinct) == 1 and len(rows) >= 2) else "playlist"

    for r in rows:
        emit({"event": "track", **r})
    emit({"event": "parsed", "kind": kind, "trackCount": len(rows), "distinctAlbums": distinct})


if __name__ == "__main__":
    main()
