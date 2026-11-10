#!/usr/bin/env python3
"""Ask OSV.dev whether any package in Cargo.lock has a known hole. Sends package names and
versions only. Fails on a notice that is not in KNOWN, so a new one cannot pass unseen.
Run by .github/workflows/ci.yml; by hand: python3 .github/osv.py"""
import json
import sys
import tomllib
import urllib.request

# Notices read and accepted (Fable Sweep row C17, 2026-11-10). Drop a line when its package
# leaves Cargo.lock; add one only after reading the notice.
KNOWN = {
    "RUSTSEC-2026-0192": "ttf-parser: no longer maintained, no hole; we read only our built-in font",
    "RUSTSEC-2024-0436": "paste: no longer maintained, no hole (through lofty)",
    "RUSTSEC-2026-0253": "lru: a memory bug; not built on Linux (a Windows / Mac part of the tree)",
    "RUSTSEC-2026-0441": "pin-utils: no longer maintained, no hole; not built on Linux",
}

lock = tomllib.load(open("Cargo.lock", "rb"))
packages = [(p["name"], p["version"]) for p in lock["package"] if p.get("source", "").startswith("registry+")]
ask = {"queries": [{"package": {"ecosystem": "crates.io", "name": n}, "version": v} for n, v in packages]}
request = urllib.request.Request("https://api.osv.dev/v1/querybatch", json.dumps(ask).encode(), {"Content-Type": "application/json", "User-Agent": "MortarPestle/0.1 ( https://github.com/Malthaiel/mortar-pestle )"})
answer = json.load(urllib.request.urlopen(request, timeout=60))

new = 0
for (name, version), result in zip(packages, answer["results"]):
    for notice in result.get("vulns", []):
        known = KNOWN.get(notice["id"])
        new += known is None
        print(f"{'known' if known else 'NEW  '}  {notice['id']}  {name} {version}" + (f"  ({known})" if known else f"  https://osv.dev/vulnerability/{notice['id']}"))
print(f"{len(packages)} packages asked, {new} new notice(s)")
sys.exit(1 if new else 0)
