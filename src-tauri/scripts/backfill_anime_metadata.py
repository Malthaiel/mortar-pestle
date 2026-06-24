#!/usr/bin/env python3
"""backfill_anime_metadata.py — one-time enrich of existing anime cards.

Walks every `Type: Media-Entry` card under `<library>/Anime/Catalog/`, reads its
`Provider ID`, fetches Jikan `/anime/{id}`, and patches in the MAL metadata the
earlier card writer never captured:

  Studio (when `[]`), Themes, Demographics, Producers, Premiered, Format,
  Rank, Popularity, Members, Scored By.

Idempotent + non-destructive: a field already present (any value, including a
populated `Studio:` block) is left untouched, and the script NEVER writes
`Personal Rating`, `Status*`, `Watched Episodes*`, `Started*`, `Finished*`,
`Re Watches*`, or the body. A card with no `Provider ID`, or already complete, is
skipped without a network call.

  backfill_anime_metadata.py [--library <dir>] [--limit N] [--force] [--dry-run]

Prints a one-line JSON summary on stdout; human diagnostics → stderr.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

JIKAN_BASE = "https://api.jikan.moe/v4"
JIKAN_UA = "Citadel/1.0 (agentic-os)"
CATALOG_REL = "Anime/Catalog"
DEFAULT_LIBRARY = os.path.expanduser("~/.local/share/dev.judeau.agentic-os/Library")

# List fields (YAML block lists) and scalar fields, with their Jikan source.
LIST_FIELDS = [
    ("Studio", "studios"),
    ("Themes", "themes"),
    ("Demographics", "demographics"),
    ("Producers", "producers"),
]
SCALAR_FIELDS = [
    ("Rank", "rank"),
    ("Popularity", "popularity"),
    ("Members", "members"),
    ("Scored By", "scored_by"),
]

_last_jikan = [0.0]


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def jikan_get(path):
    """Throttled (>=0.5s) Jikan GET; one retry on HTTP 429."""
    for attempt in range(2):
        elapsed = time.monotonic() - _last_jikan[0]
        if elapsed < 0.5:
            time.sleep(0.5 - elapsed)
        req = urllib.request.Request(
            f"{JIKAN_BASE}/{path}",
            headers={"User-Agent": JIKAN_UA, "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                _last_jikan[0] = time.monotonic()
                return json.load(r)
        except urllib.error.HTTPError as e:
            _last_jikan[0] = time.monotonic()
            if e.code == 429 and attempt == 0:
                time.sleep(1.5)
                continue
            raise
    raise RuntimeError("Jikan rate-limited after retry")


def yaml_scalar(v):
    return json.dumps("" if v is None else str(v), ensure_ascii=False)


def write_text(path, text):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def names(detail, key):
    return [x.get("name") for x in (detail.get(key) or []) if x.get("name")]


def has_field(text, key):
    """A key is 'present' if it appears AND (for lists) isn't the empty `[]`."""
    m = re.search(rf"^{re.escape(key)}:[ \t]*(.*)$", text, re.M)
    if not m:
        return False
    return m.group(1).strip() != "[]"


def list_lines(label, values):
    if values:
        return [f"{label}:"] + [f"  - {yaml_scalar(v)}" for v in values]
    return [f"{label}: []"]


def premiered_str(detail):
    season = detail.get("season")
    if not season:
        return None
    if detail.get("year"):
        return f"{str(season).capitalize()} {int(detail['year'])}"
    return str(season).capitalize()


def patch_card(text, detail, force=False):
    """Return (new_text, changed_field_names). Replaces an empty `Studio: []` in
    place; inserts every other missing field as a group before the closing `---`."""
    changed = []

    # Studio: replace an empty `[]` in place (so it stays in its schema slot).
    studios = names(detail, "studios")
    if studios and re.search(r"^Studio:[ \t]*\[\][ \t]*$", text, re.M):
        block = "\n".join(list_lines("Studio", studios))
        text = re.sub(r"^Studio:[ \t]*\[\][ \t]*$", block, text, count=1, flags=re.M)
        changed.append("Studio")

    insert = []

    # Premiered / Format (scalars, only when source present).
    if (force or not has_field(text, "Premiered")):
        prem = premiered_str(detail)
        if prem:
            insert.append(f"Premiered: {yaml_scalar(prem)}")
            changed.append("Premiered")
    if (force or not has_field(text, "Format")) and detail.get("type"):
        insert.append(f"Format: {yaml_scalar(detail['type'])}")
        changed.append("Format")

    # List fields (Studio handled above unless it was entirely absent).
    for label, key in LIST_FIELDS:
        if label == "Studio" and "Studio" in changed:
            continue
        if force or not has_field(text, label):
            vals = names(detail, key)
            # Only add a brand-new key if there's something to say (or it's Studio,
            # which the schema always carries).
            if vals or label == "Studio":
                insert.extend(list_lines(label, vals))
                changed.append(label)

    # Numeric stats.
    for label, key in SCALAR_FIELDS:
        if (force or not has_field(text, label)) and detail.get(key) is not None:
            insert.append(f"{label}: {int(detail[key])}")
            changed.append(label)

    if insert:
        # Insert before the closing frontmatter fence (second `---`).
        m = re.search(r"^---[ \t]*$", text, re.M)
        if not m:
            return text, []  # no opening fence — malformed, skip
        close = re.search(r"^---[ \t]*$", text[m.end():], re.M)
        if not close:
            return text, []
        pos = m.end() + close.start()
        block = "\n".join(insert) + "\n"
        text = text[:pos] + block + text[pos:]

    return text, changed


def provider_id(text):
    m = re.search(r"^Provider ID:[ \t]*(\d+)", text, re.M)
    return int(m.group(1)) if m else None


def card_complete(text):
    """All target fields already present → no fetch needed."""
    if re.search(r"^Studio:[ \t]*\[\][ \t]*$", text, re.M):
        return False
    for label, _ in LIST_FIELDS + SCALAR_FIELDS:
        if not has_field(text, label):
            return False
    for label in ("Premiered", "Format"):
        if not has_field(text, label):
            return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", default=DEFAULT_LIBRARY)
    ap.add_argument("--limit", type=int, default=0, help="cap cards processed (0 = all)")
    ap.add_argument("--force", action="store_true", help="re-fetch + overwrite even if present")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    catalog = os.path.join(os.path.expanduser(args.library), CATALOG_REL)
    if not os.path.isdir(catalog):
        print(json.dumps({"error": "no_catalog", "path": catalog}))
        sys.exit(1)

    names_md = sorted(n for n in os.listdir(catalog) if n.endswith(".md"))
    patched = skipped = no_id = errors = complete = 0
    processed = 0

    for name in names_md:
        if args.limit and processed >= args.limit:
            break
        path = os.path.join(catalog, name)
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except OSError as e:
            log(f"read failed {name}: {e}")
            errors += 1
            continue

        pid = provider_id(text)
        if not pid:
            no_id += 1
            continue
        if not args.force and card_complete(text):
            complete += 1
            continue

        processed += 1
        try:
            detail = jikan_get(f"anime/{pid}").get("data")
        except Exception as e:  # noqa: BLE001
            log(f"jikan failed {name} (mal {pid}): {e}")
            errors += 1
            continue
        if not detail:
            log(f"no jikan data {name} (mal {pid})")
            errors += 1
            continue

        new_text, changed = patch_card(text, detail, force=args.force)
        if changed and new_text != text:
            if args.dry_run:
                log(f"[dry-run] {name}: would add {', '.join(changed)}")
            else:
                write_text(path, new_text)
                log(f"{name}: +{', '.join(changed)}")
            patched += 1
        else:
            skipped += 1

    summary = {
        "ok": True, "total": len(names_md), "patched": patched,
        "alreadyComplete": complete, "skippedNoChange": skipped,
        "noProviderId": no_id, "errors": errors, "dryRun": args.dry_run,
    }
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
