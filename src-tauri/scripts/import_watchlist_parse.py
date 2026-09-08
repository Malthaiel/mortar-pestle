#!/usr/bin/env python3
"""Parse a film/show watch list (Letterboxd or IMDb CSV) → NDJSON for library_import.rs.

Pure stdlib. Header-driven like `import_music_parse.py`, and for the same reason:
the two exporters name their columns differently and neither is stable enough to
address by position. The dialect is SNIFFED from the header, not asked for —
one import button, one job kind, one script.

  header has "letterboxd uri"            → letterboxd  (no ids; Rust must look them up)
  header has "const" AND "title type"    → imdb        (ids present; Rust writes directly)
  neither                                → one clear error

Output (one JSON object per line):
  {"event":"row","n":<int>,"domain":"Movies"|"TV Shows","imdbId":"tt…"|null,
   "name":..,"year":..,"rating":<float>|null,"finished":"YYYY-MM-DD"|null}
  {"event":"skipped","reason":"row-type","titleType":..,"name":..}
  {"event":"parsed","source":"letterboxd"|"imdb","rows":<int>,"skipped":<int>,
   "skippedTypes":{<titleType>:<count>}}
  {"event":"error","message":..}   (+ exit 1)

Letterboxd's 0.5–5 stars are doubled to the app's /10 scale HERE rather than in
Rust, so the conversion lives with the format that needs it. IMDb's "Your Rating"
is already /10 and passes through untouched.

Only three IMDb `Title Type` values are admitted (see the plan's decision table):
Movie → Movies, TV Series / TV Mini Series → TV Shows. Everything else is
reported as skipped, never written. Letterboxd exports films only, so every one
of its rows is a Movie.
"""

import argparse
import csv
import json
import re
import sys

# Column name → canonical field, lowercased + space-collapsed. Both exporters in
# one table: a name only ever means one thing across the two.
ALIASES = {
    "name": ["name", "title", "original title"],
    "year": ["year"],
    "rating": ["rating", "your rating"],
    "finished": ["watched date", "date rated", "date"],
    "imdb_id": ["const", "imdb id", "imdb_id"],
    "title_type": ["title type"],
    "lb_uri": ["letterboxd uri"],
}

# IMDb `Title Type` → our room. Anything absent here is skipped and reported.
# `TV Movie` and `Video` were considered and rejected: they route cleanly but are
# often missing from Cinemeta, so they would mostly become "not found" noise.
TITLE_TYPE_DOMAIN = {
    "movie": "Movies",
    "tv series": "TV Shows",
    "tv mini series": "TV Shows",
    "tvminiseries": "TV Shows",
    "tvseries": "TV Shows",
}

RE_YEAR = re.compile(r"(\d{4})")
RE_ISO_DATE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def die(msg):
    emit({"event": "error", "message": msg})
    sys.exit(1)


def norm_header(h):
    return re.sub(r"\s+", " ", (h or "").strip().lower())


def build_colmap(header):
    """header (list of raw names) → {field: column_index}.

    Alias order is PRIORITY order, unlike `import_music_parse.py`'s column-order
    scan: Letterboxd's diary export carries both `Date` (when the entry was
    written) and `Watched Date`, and `Date` comes first, so a column-first scan
    picks the wrong one. Most specific alias wins."""
    norm = [norm_header(h) for h in header]
    colmap = {}
    for field, names in ALIASES.items():
        for want in names:
            if want in norm:
                colmap[field] = norm.index(want)
                break
    return colmap


def cell(row, colmap, field):
    i = colmap.get(field)
    if i is None or i >= len(row):
        return ""
    return (row[i] or "").strip()


def sniff(colmap):
    """Which exporter wrote this file. Letterboxd is checked first because its
    URI column is unique to it; IMDb needs both of its markers so a random CSV
    with a stray `Const` column cannot pass as one."""
    if "lb_uri" in colmap:
        return "letterboxd"
    if "imdb_id" in colmap and "title_type" in colmap:
        return "imdb"
    return None


def parse_year(raw):
    """→ "1998" or "". Letterboxd writes a bare year, IMDb sometimes a range."""
    m = RE_YEAR.search(raw or "")
    return m.group(1) if m else ""


def parse_date(raw):
    """→ "YYYY-MM-DD" or None. Both exporters write ISO already; anything else
    is dropped rather than guessed, because a wrong watch date is worse than
    none. (The series reader's episode-row regex also refuses non-ISO — see the
    plan's format constraints.)"""
    m = RE_ISO_DATE.search(raw or "")
    return m.group(1) if m else None


def parse_rating(raw, source):
    """→ a /10 float, or None when unrated. Letterboxd stars are 0.5–5 and get
    doubled; IMDb's "Your Rating" is already /10."""
    s = (raw or "").strip()
    if not s:
        return None
    try:
        val = float(s)
    except ValueError:
        return None
    if val <= 0:
        return None
    if source == "letterboxd":
        val *= 2
    return round(val, 1)


def parse_rows(path):
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            die("The file is empty.")
        colmap = build_colmap(header)
        source = sniff(colmap)
        if not source:
            die(
                "Not a Letterboxd or IMDb export — no 'Letterboxd URI' column, and no "
                "'Const' plus 'Title Type' pair either."
            )
        if "name" not in colmap:
            die("No title column found in the file.")

        rows, skipped, skipped_types = [], [], {}
        n = 0
        for raw in reader:
            if not any((c or "").strip() for c in raw):
                continue
            name = cell(raw, colmap, "name")
            if not name:
                continue

            if source == "imdb":
                tt = cell(raw, colmap, "title_type")
                domain = TITLE_TYPE_DOMAIN.get(norm_header(tt))
                if domain is None:
                    label = tt or "(blank)"
                    skipped_types[label] = skipped_types.get(label, 0) + 1
                    skipped.append({"event": "skipped", "reason": "row-type",
                                    "titleType": label, "name": name})
                    continue
                imdb_id = cell(raw, colmap, "imdb_id") or None
            else:
                # Letterboxd exports films only, and carries no id at all.
                domain, imdb_id = "Movies", None

            n += 1
            rows.append({
                "event": "row", "n": n, "domain": domain, "imdbId": imdb_id,
                "name": name, "year": parse_year(cell(raw, colmap, "year")),
                "rating": parse_rating(cell(raw, colmap, "rating"), source),
                "finished": parse_date(cell(raw, colmap, "finished")),
            })
        return source, rows, skipped, skipped_types


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    args = ap.parse_args()

    try:
        source, rows, skipped, skipped_types = parse_rows(args.file)
    except FileNotFoundError:
        die(f"File not found: {args.file}")
    except OSError as e:
        die(f"Could not read file: {e}")

    if not rows and not skipped:
        die("No films or shows found in the file.")

    for s in skipped:
        emit(s)
    for r in rows:
        emit(r)
    emit({"event": "parsed", "source": source, "rows": len(rows),
          "skipped": len(skipped), "skippedTypes": skipped_types})


if __name__ == "__main__":
    main()
