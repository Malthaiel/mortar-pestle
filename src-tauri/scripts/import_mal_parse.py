#!/usr/bin/env python3
"""Parse a MyAnimeList XML export (.xml or .xml.gz) → NDJSON for library_import.rs.

Pure stdlib (gzip, xml.etree). Handles the gzipped export MAL hands out directly
(detected by the .gz extension OR the 1f8b magic, so a renamed file still works).
Reads the repeated <anime> nodes; manga exports (<manga> nodes) are out of scope.

Output (one JSON object per line):
  {"event":"anime","malId":<int>,"title":..,"status":<mapped>,"score":<int>,
   "watchedEpisodes":<int>,"timesWatched":<int>,"startDate":..,"finishDate":..,
   "seriesType":..}
  {"event":"parsed","count":<int>}
  {"event":"error","message":..}   (+ exit 1)

MAL <my_status> text → our anime status enum (1:1). Dates of 0000-00-00 → "".
"""

import argparse
import gzip
import json
import sys
import xml.etree.ElementTree as ET

STATUS_MAP = {
    "watching": "Currently-Watching",
    "completed": "Completed",
    "on-hold": "On-Hold",
    "on hold": "On-Hold",
    "dropped": "Dropped",
    "plan to watch": "Plan-to-Watch",
    "plantowatch": "Plan-to-Watch",
}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def open_maybe_gz(path):
    """Return a binary file object, transparently gunzipping .gz / 1f8b files."""
    with open(path, "rb") as probe:
        magic = probe.read(2)
    if path.lower().endswith(".gz") or magic == b"\x1f\x8b":
        return gzip.open(path, "rb")
    return open(path, "rb")


def text(el, tag):
    child = el.find(tag)
    if child is None or child.text is None:
        return ""
    return child.text.strip()


def as_int(s, default=0):
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return default


def clean_date(s):
    s = (s or "").strip()
    if not s or s.startswith("0000"):
        return ""
    return s


def map_status(raw):
    return STATUS_MAP.get((raw or "").strip().lower(), "Plan-to-Watch")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    args = ap.parse_args()

    try:
        fh = open_maybe_gz(args.file)
    except FileNotFoundError:
        emit({"event": "error", "message": f"File not found: {args.file}"})
        sys.exit(1)
    except OSError as e:
        emit({"event": "error", "message": f"Could not read file: {e}"})
        sys.exit(1)

    count = 0
    try:
        with fh:
            # iterparse keeps memory flat on big lists (500+ entries); clear each
            # <anime> after reading it.
            for _event, el in ET.iterparse(fh, events=("end",)):
                if el.tag != "anime":
                    continue
                mal_id = as_int(text(el, "series_animedb_id"), 0)
                title = text(el, "series_title")
                if mal_id <= 0 or not title:
                    el.clear()
                    continue
                emit({
                    "event": "anime",
                    "malId": mal_id,
                    "title": title,
                    "status": map_status(text(el, "my_status")),
                    "score": as_int(text(el, "my_score"), 0),
                    "watchedEpisodes": as_int(text(el, "my_watched_episodes"), 0),
                    "timesWatched": as_int(text(el, "my_times_watched"), 0),
                    "startDate": clean_date(text(el, "my_start_date")),
                    "finishDate": clean_date(text(el, "my_finish_date")),
                    "seriesType": text(el, "series_type"),
                })
                count += 1
                el.clear()
    except ET.ParseError as e:
        emit({"event": "error", "message": f"Malformed XML: {e}"})
        sys.exit(1)

    if count == 0:
        emit({"event": "error",
              "message": "No <anime> entries found — is this a MAL anime XML export? (manga exports aren't supported.)"})
        sys.exit(1)

    emit({"event": "parsed", "count": count})


if __name__ == "__main__":
    main()
