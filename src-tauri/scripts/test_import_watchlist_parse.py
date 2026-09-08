#!/usr/bin/env python3
"""Self-check for import_watchlist_parse.py. Run it: `python test_import_watchlist_parse.py`.

Real headers from both exporters, verbatim — the whole point of a header-driven
parser is that it survives the columns the sites actually write, so a made-up
header would test nothing.
"""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "import_watchlist_parse.py")

# Letterboxd diary.csv — carries BOTH `Date` and `Watched Date`, with `Date`
# first. The one that must win is `Watched Date`.
LB_DIARY = """Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2026-01-02,Practical Magic,1998,https://boxd.it/aaa,3.5,No,,2026-03-14
2026-01-03,Inception,2010,https://boxd.it/bbb,5,Yes,,2026-03-15
2026-01-04,Obsession,2026,https://boxd.it/ccc,,No,,
"""

# IMDb list export.
IMDB = """Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors,Your Rating,Date Rated
1,tt1375666,2026-01-01,,,Inception,Inception,https://www.imdb.com/title/tt1375666/,Movie,8.8,148,2010,"Action, Sci-Fi",2000000,2010-07-16,Christopher Nolan,9,2026-02-01
2,tt0903747,2026-01-01,,,Breaking Bad,Breaking Bad,https://www.imdb.com/title/tt0903747/,TV Series,9.5,49,2008,Drama,1900000,2008-01-20,,10,2026-02-02
3,tt7366338,2026-01-01,,,Chernobyl,Chernobyl,https://www.imdb.com/title/tt7366338/,TV Mini Series,9.3,330,2019,Drama,800000,2019-05-06,,,
4,tt0959621,2026-01-01,,,Pilot,Pilot,https://www.imdb.com/title/tt0959621/,TV Episode,9.0,58,2008,Drama,40000,2008-01-20,,,
5,tt0111161,2026-01-01,,,Some Game,Some Game,https://www.imdb.com/title/tt0111161/,Video Game,8.0,,2011,Action,1000,,,,
"""

NEITHER = """Foo,Bar,Baz
1,2,3
"""


def run(text, suffix=".csv"):
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    try:
        # The same env `proc_util::python_cmd()` hands every spawn. Without it,
        # Windows pipes stdout in the console codepage and the em dash in the
        # "not an export" message arrives as cp1252 — undecodable here and in
        # the Rust reader alike.
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        p = subprocess.run([sys.executable, SCRIPT, "--file", path],
                           capture_output=True, text=True, encoding="utf-8", env=env)
        events = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
        return p.returncode, events
    finally:
        os.unlink(path)


def by(events, name):
    return [e for e in events if e.get("event") == name]


def test_letterboxd():
    code, ev = run(LB_DIARY)
    assert code == 0, ev
    rows = by(ev, "row")
    parsed = by(ev, "parsed")[0]
    assert parsed["source"] == "letterboxd", parsed
    assert len(rows) == 3, rows
    assert all(r["domain"] == "Movies" for r in rows), rows
    assert all(r["imdbId"] is None for r in rows), "Letterboxd carries no ids"
    # Stars doubled onto /10.
    assert rows[0]["name"] == "Practical Magic" and rows[0]["year"] == "1998"
    assert rows[0]["rating"] == 7.0, rows[0]
    assert rows[1]["rating"] == 10.0, rows[1]
    assert rows[2]["rating"] is None, "an unrated row must not become 0"
    # `Watched Date` must beat the `Date` column that sits before it.
    assert rows[0]["finished"] == "2026-03-14", rows[0]
    assert rows[2]["finished"] is None, rows[2]


def test_imdb():
    code, ev = run(IMDB)
    assert code == 0, ev
    rows = by(ev, "row")
    parsed = by(ev, "parsed")[0]
    assert parsed["source"] == "imdb", parsed
    assert len(rows) == 3, [r["name"] for r in rows]
    assert rows[0]["domain"] == "Movies" and rows[0]["imdbId"] == "tt1375666"
    assert rows[1]["domain"] == "TV Shows", rows[1]
    assert rows[2]["domain"] == "TV Shows", "TV Mini Series routes to TV Shows"
    # `Your Rating` is already /10 and must not be doubled, and `IMDb Rating`
    # (8.8, the crowd's) must not be mistaken for it.
    assert rows[0]["rating"] == 9.0, rows[0]
    assert rows[2]["rating"] is None, rows[2]
    assert rows[0]["finished"] == "2026-02-01", rows[0]
    # TV Episode and Video Game are skipped and reported, never written.
    skipped = by(ev, "skipped")
    assert len(skipped) == 2, skipped
    assert {s["titleType"] for s in skipped} == {"TV Episode", "Video Game"}
    assert parsed["skipped"] == 2 and parsed["skippedTypes"] == {
        "TV Episode": 1, "Video Game": 1}


def test_unknown_header():
    code, ev = run(NEITHER)
    assert code == 1, ev
    assert by(ev, "error"), ev


if __name__ == "__main__":
    for fn in (test_letterboxd, test_imdb, test_unknown_header):
        fn()
        print("ok  " + fn.__name__)
    print("all passed")
