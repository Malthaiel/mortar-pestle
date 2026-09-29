#!/usr/bin/env python3
"""Self-check for download_album.py's source picker. Run it:
`python test_download_album_match.py`.

Real search results, verbatim (2026-09-29): the song is MusicBrainz's
"rose‐tinted bitter grudge" (U+2010 dash, 3:29). Duration alone picked another
song within 30s and saved it under this title.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import download_album as d

MB_TITLE = "rose‐tinted bitter grudge"
EXPECTED = 209

# What the typographic-dash search actually returned: nothing that is the song.
WRONG = [
    {"id": "m1Dz2hnPcig", "duration": 159, "title": "「Loser's Anthem」-【ippo.tsk+The Overlord Bear】", "channel": "ippo.tsk"},
    {"id": "xWjzWpBY3JY", "duration": 237, "title": "【SynthV - Original】 A Price For This Power【Eleanor Forte】 | Lyric Video", "channel": "Savala The Lost AngL"},
    {"id": "sb7ICcn5F3M", "duration": 206, "title": "JKTmelts", "channel": "ippo.tsk"},
]
# What the plain-dash search returned.
RIGHT = [
    {"id": "NQoozExC1cA", "duration": 209, "title": "rose-tinted bitter grudge", "channel": "ippo.tsk"},
    {"id": "hpivMfdYWhg", "duration": 215, "title": "rose-tinted bitter grudge - ippo.tsk | Eleanor Forte (Synthesizer V)", "channel": "ippo.tsk"},
    {"id": "qSFeJXmVFTM", "duration": 212, "title": "rose-tinted bitter grudge (instrumental)", "channel": "ippo.tsk"},
    {"id": "GyjpqeKqzaQ", "duration": 307, "title": "oyasumination - ippo.tsk | Eleanor Forte (Synth V)", "channel": "ippo.tsk"},
]

title = MB_TITLE.translate(d.PLAIN_PUNCT)
assert title == "rose-tinted bitter grudge", title

# A same-length stranger must never win: no pick beats a wrong pick.
best, _ = d.score_candidates(WRONG, EXPECTED, title)
assert best is None, best

best, delta = d.score_candidates(RIGHT, EXPECTED, title)
assert best["id"] == "NQoozExC1cA" and delta == 0, (best, delta)

# A title with no Latin words leaves duration in charge (old albums rely on it).
best, _ = d.score_candidates([{"id": "x", "duration": 290, "title": "Macroblank - 防水"}], 289, "防水")
assert best["id"] == "x", best

print("ok")
