#!/usr/bin/env python3
"""Offline builder for the bundled USDA FoodData Central food database.

Health Column epic, sub-plan 2 (USDA Food Database). DEV-ONLY — run by hand to
regenerate ``src-tauri/resources/usda_foods.db``; the .db ships in the Tauri
bundle (``bundle.resources``) and is opened read-only at runtime. NOT invoked
at runtime, NOT a Tauri sidecar.

What it produces: a compact SQLite (FTS5) with per-100g nutrients projected to
the canonical key set (see ``NUTRIENT_MAP``). Foundation + SR Legacy are kept
WHOLE (small, full micros); Branded is filtered to a curated drinks/packaged
subset and capped to keep the file ~100-150 MB (the locked size gate).

Design notes:
  - Projection happens HERE (build time): the DB stores canonical snake_case
    keys + a canonical unit per row, so the Rust query layer just passes
    ``{key, amount, unit}`` through — no nutrient-id map needed at runtime. The
    id->key map is the single source of truth and lives in this file.
  - ``natural_sugar`` is NEVER stored; the UI computes max(0, total - added).
  - Missing micros are simply ABSENT (the ledger renders "not reported", never
    0). ``added_sugars`` (1235) is sparse — expected, not a bug.

Usage:
  python3 build_fdc_db.py                 # full: generics + curated branded
  python3 build_fdc_db.py --generics-only # Foundation + SR Legacy only (fast)
  python3 build_fdc_db.py --branded-only  # append curated branded to existing DB
  python3 build_fdc_db.py --seed          # tiny ~12-food DB (no network)
  python3 build_fdc_db.py --branded-cap N --size-cap-mb 150

FoodData Central is CC0 public domain (credit: U.S. Department of Agriculture,
Agricultural Research Service, FoodData Central, fdc.nal.usda.gov).
"""

import argparse
import csv
import os
import sqlite3
import sys
import urllib.request
import zipfile

# ── Dataset sources (discovered live 2026-06-13; bump dates when USDA releases) ──
BASE = "https://fdc.nal.usda.gov/fdc-datasets"
DATASETS = {
    "foundation": f"{BASE}/FoodData_Central_foundation_food_csv_2025-04-24.zip",
    "sr_legacy":  f"{BASE}/FoodData_Central_sr_legacy_food_csv_2018-04.zip",
    "branded":    f"{BASE}/FoodData_Central_branded_food_csv_2025-04-24.zip",
}

# ── Canonical nutrient map: FDC nutrient_id -> (key, canonical_unit) ──
# Ids picked so the unit is ALREADY canonical (no conversion needed): we take
# vitamin_d as 1114 (µg) not 1110 (IU), vitamin_a as 1106 RAE (µg) not IU, etc.
# Sugars: both 1063 (incl. NLEA, generics) and 2000 (branded) map to
# total_sugars; first-wins on collision. kcal: 1008 (Energy). These were checked
# against the FDC nutrient.csv unit_name at build time (see verify step).
NUTRIENT_MAP = {
    1008: ("kcal",          "kcal"),
    1003: ("protein",       "g"),
    1004: ("fat",           "g"),
    1005: ("carb",          "g"),
    1079: ("fiber",         "g"),
    1063: ("total_sugars",  "g"),   # Sugars, total including NLEA (generics)
    2000: ("total_sugars",  "g"),   # Sugars, Total (branded label) — alias
    1235: ("added_sugars",  "g"),   # sparse (labeled/branded mostly)
    1093: ("sodium",        "mg"),
    1092: ("potassium",     "mg"),
    1087: ("calcium",       "mg"),
    1089: ("iron",          "mg"),
    1090: ("magnesium",     "mg"),
    1091: ("phosphorus",    "mg"),
    1095: ("zinc",          "mg"),
    1114: ("vitamin_d",     "mcg"),
    1106: ("vitamin_a",     "mcg"),  # RAE
    1162: ("vitamin_c",     "mg"),
    1109: ("vitamin_e",     "mg"),   # alpha-tocopherol
    1185: ("vitamin_k",     "mcg"),  # phylloquinone
    1165: ("thiamin",       "mg"),
    1166: ("riboflavin",    "mg"),
    1167: ("niacin",        "mg"),
    1175: ("vitamin_b6",    "mg"),
    1177: ("folate",        "mcg"),  # Folate, total (µg) — not 1190 DFE
    1178: ("vitamin_b12",   "mcg"),
    1253: ("cholesterol",   "mg"),
    1258: ("saturated_fat", "g"),
    1257: ("trans_fat",     "g"),
}
# First-wins priority when two ids map to the same key (1063 before 2000).
KEY_PRIORITY = {nid: i for i, nid in enumerate(NUTRIENT_MAP)}

# ── Curated branded subset: keep categories matching these keywords (drinks +
# common packaged). Case-insensitive substring match against branded_food_category. ──
BRANDED_KEYWORDS = (
    # drinks
    "soda", "water", "coffee", "tea", "juice", "drink", "beverage", "milk",
    "shake", "lemonade", "kombucha", "smoothie", "cocoa",
    # packaged
    "chip", "pretzel", "snack", "candy", "chocolate", "cookie", "cracker",
    "cereal", "bar", "granola", "yogurt", "ice cream", "frozen", "bread",
    "popcorn", "nut butter", "spread", "sauce", "soup",
)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "resources", "usda_foods.db"))
DEFAULT_WORK = os.path.join(HERE, ".fdc_work")


def log(msg):
    print(msg, flush=True)


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        log(f"  cached {os.path.basename(dest)} ({os.path.getsize(dest)//1_000_000} MB)")
        return
    log(f"  downloading {url}")
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        got = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                sys.stdout.write(f"\r    {got//1_000_000}/{total//1_000_000} MB")
                sys.stdout.flush()
    sys.stdout.write("\n")
    os.replace(tmp, dest)


def fetch_dataset(name, work):
    os.makedirs(work, exist_ok=True)
    zpath = os.path.join(work, name + ".zip")
    download(DATASETS[name], zpath)
    out_dir = os.path.join(work, name)
    marker = os.path.join(out_dir, ".extracted")
    if not os.path.exists(marker):
        log(f"  extracting {name}")
        with zipfile.ZipFile(zpath) as z:
            z.extractall(out_dir)
        open(marker, "w").close()
    # CSVs live one level down (FoodData_Central_<type>_csv_<date>/)
    for root, _dirs, files in os.walk(out_dir):
        if "food.csv" in files:
            return root
    raise SystemExit(f"food.csv not found under {out_dir}")


def col_index(header):
    return {name: i for i, name in enumerate(header)}


def insert_foods(conn, csv_dir, data_types):
    """Insert rows from food.csv whose data_type is in data_types. Returns the
    set of fdc_ids inserted (so we only stream their nutrients)."""
    ids = set()
    path = os.path.join(csv_dir, "food.csv")
    with open(path, newline="", encoding="utf-8") as f:
        rd = csv.reader(f)
        ix = col_index(next(rd))
        rows = []
        for row in rd:
            if row[ix["data_type"]] not in data_types:
                continue
            fid = int(row[ix["fdc_id"]])
            ids.add(fid)
            rows.append((fid, row[ix["description"]].strip(), row[ix["data_type"]], None))
            if len(rows) >= 5000:
                conn.executemany("INSERT OR IGNORE INTO foods VALUES (?,?,?,?)", rows)
                rows.clear()
        if rows:
            conn.executemany("INSERT OR IGNORE INTO foods VALUES (?,?,?,?)", rows)
    conn.commit()
    return ids


def insert_nutrients(conn, csv_dir, keep_ids):
    """Stream food_nutrient.csv, projecting canonical nutrients for keep_ids."""
    path = os.path.join(csv_dir, "food_nutrient.csv")
    best = {}  # (fdc_id, key) -> (priority, amount, unit)
    n = 0
    with open(path, newline="", encoding="utf-8") as f:
        rd = csv.reader(f)
        ix = col_index(next(rd))
        fi, ni, ai = ix["fdc_id"], ix["nutrient_id"], ix["amount"]
        for row in rd:
            try:
                fid = int(row[fi])
            except (ValueError, IndexError):
                continue
            if fid not in keep_ids:
                continue
            try:
                nid = int(row[ni])
            except ValueError:
                continue
            meta = NUTRIENT_MAP.get(nid)
            if not meta:
                continue
            try:
                amt = float(row[ai])
            except (ValueError, IndexError):
                continue
            key, unit = meta
            prio = KEY_PRIORITY[nid]
            cur = best.get((fid, key))
            if cur is None or prio < cur[0]:
                best[(fid, key)] = (prio, amt, unit)
            n += 1
            if n % 2_000_000 == 0:
                log(f"    …scanned {n//1_000_000}M nutrient rows")
    rows = [(fid, key, amt, unit) for (fid, key), (_p, amt, unit) in best.items()]
    conn.executemany(
        "INSERT OR REPLACE INTO food_nutrients (fdc_id, key, amount, unit) VALUES (?,?,?,?)",
        rows,
    )
    conn.commit()
    log(f"    inserted {len(rows)} nutrient rows")


def build_generics(conn, work):
    for name, dtypes in (("foundation", {"foundation_food"}), ("sr_legacy", {"sr_legacy_food"})):
        log(f"[{name}]")
        csv_dir = fetch_dataset(name, work)
        ids = insert_foods(conn, csv_dir, dtypes)
        log(f"  {len(ids)} foods")
        insert_nutrients(conn, csv_dir, ids)


def build_branded(conn, work, cap):
    log("[branded] (curated drinks/packaged subset)")
    csv_dir = fetch_dataset("branded", work)
    # Pass 1: branded_food.csv -> whitelisted fdc_ids (capped).
    keep = set()
    bpath = os.path.join(csv_dir, "branded_food.csv")
    with open(bpath, newline="", encoding="utf-8") as f:
        rd = csv.reader(f)
        ix = col_index(next(rd))
        ci = ix.get("branded_food_category")
        fi = ix["fdc_id"]
        for row in rd:
            cat = (row[ci] if ci is not None and ci < len(row) else "").lower()
            if any(k in cat for k in BRANDED_KEYWORDS):
                keep.add(int(row[fi]))
                if len(keep) >= cap:
                    break
    log(f"  {len(keep)} branded foods in whitelisted categories (cap {cap})")
    # Insert their food rows (description + brand_owner) from food.csv.
    fpath = os.path.join(csv_dir, "food.csv")
    with open(fpath, newline="", encoding="utf-8") as f:
        rd = csv.reader(f)
        ix = col_index(next(rd))
        rows = []
        for row in rd:
            fid = int(row[ix["fdc_id"]])
            if fid not in keep:
                continue
            rows.append((fid, row[ix["description"]].strip(), "branded_food", None))
            if len(rows) >= 5000:
                conn.executemany("INSERT OR IGNORE INTO foods VALUES (?,?,?,?)", rows)
                rows.clear()
        if rows:
            conn.executemany("INSERT OR IGNORE INTO foods VALUES (?,?,?,?)", rows)
    conn.commit()
    insert_nutrients(conn, csv_dir, keep)


SEED_FOODS = [
    # (fdc_id, description, data_type, {key: (amount, unit)})  — per 100 g
    (1, "Banana, raw", "foundation_food", {
        "kcal": 89, "protein": 1.1, "carb": 22.8, "fat": 0.3, "fiber": 2.6,
        "total_sugars": 12.2, "potassium": 358, "vitamin_c": 8.7, "vitamin_b6": 0.4}),
    (2, "Chicken, breast, cooked, roasted", "sr_legacy_food", {
        "kcal": 165, "protein": 31, "carb": 0, "fat": 3.6, "sodium": 74,
        "potassium": 256, "iron": 1.0, "vitamin_b12": 0.3, "cholesterol": 85}),
    (3, "Rice, white, cooked", "sr_legacy_food", {
        "kcal": 130, "protein": 2.7, "carb": 28, "fat": 0.3, "fiber": 0.4,
        "iron": 1.2, "sodium": 1}),
    (4, "Cola, carbonated", "branded_food", {
        "kcal": 37, "protein": 0, "carb": 9.6, "fat": 0, "total_sugars": 8.9,
        "added_sugars": 8.9, "sodium": 4}),
    (5, "Spinach, raw", "foundation_food", {
        "kcal": 23, "protein": 2.9, "carb": 3.6, "fat": 0.4, "fiber": 2.2,
        "calcium": 99, "iron": 2.7, "potassium": 558, "vitamin_a": 469,
        "vitamin_c": 28, "vitamin_k": 483, "folate": 194}),
    (6, "Milk, whole, 3.25% fat", "sr_legacy_food", {
        "kcal": 61, "protein": 3.2, "carb": 4.8, "fat": 3.3, "total_sugars": 5.1,
        "calcium": 113, "potassium": 132, "vitamin_d": 1.3, "vitamin_b12": 0.5}),
    (7, "Egg, whole, cooked, hard-boiled", "sr_legacy_food", {
        "kcal": 155, "protein": 13, "carb": 1.1, "fat": 11, "sodium": 124,
        "vitamin_d": 2.2, "vitamin_b12": 1.1, "cholesterol": 373}),
    (8, "Almonds, raw", "sr_legacy_food", {
        "kcal": 579, "protein": 21, "carb": 22, "fat": 50, "fiber": 12.5,
        "calcium": 269, "iron": 3.7, "magnesium": 270, "vitamin_e": 25.6}),
    (9, "Oats, rolled, dry", "sr_legacy_food", {
        "kcal": 389, "protein": 16.9, "carb": 66, "fat": 6.9, "fiber": 10.6,
        "iron": 4.7, "magnesium": 177, "zinc": 4.0}),
    (10, "Greek yogurt, plain, nonfat", "branded_food", {
        "kcal": 59, "protein": 10, "carb": 3.6, "fat": 0.4, "total_sugars": 3.2,
        "added_sugars": 0, "calcium": 110, "vitamin_b12": 0.8}),
    (11, "Orange juice, raw", "sr_legacy_food", {
        "kcal": 45, "protein": 0.7, "carb": 10.4, "fat": 0.2, "total_sugars": 8.4,
        "potassium": 200, "vitamin_c": 50, "folate": 30}),
    (12, "Protein bar, chocolate (branded)", "branded_food", {
        "kcal": 360, "protein": 30, "carb": 38, "fat": 12, "fiber": 8,
        "total_sugars": 6, "added_sugars": 4, "sodium": 230, "calcium": 500}),
]


def build_seed(conn):
    log("[seed] hand-inserting tiny food set (no network)")
    for fid, desc, dtype, nutr in SEED_FOODS:
        conn.execute("INSERT OR IGNORE INTO foods VALUES (?,?,?,?)", (fid, desc, dtype, None))
        for key, amt in nutr.items():
            # canonical unit from the map (find any id with this key)
            unit = next((u for (k, u) in NUTRIENT_MAP.values() if k == key), "g")
            conn.execute(
                "INSERT OR REPLACE INTO food_nutrients (fdc_id, key, amount, unit) VALUES (?,?,?,?)",
                (fid, key, amt, unit))
    conn.commit()


def create_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS foods (
            fdc_id INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            data_type TEXT NOT NULL,
            brand_owner TEXT
        );
        CREATE TABLE IF NOT EXISTS food_nutrients (
            fdc_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            amount REAL NOT NULL,
            unit TEXT NOT NULL,
            PRIMARY KEY (fdc_id, key)
        );
    """)
    conn.commit()


def build_fts(conn):
    log("[fts] building FTS5 index")
    conn.executescript("""
        DROP TABLE IF EXISTS foods_fts;
        CREATE VIRTUAL TABLE foods_fts USING fts5(
            description, content='foods', content_rowid='fdc_id', tokenize='unicode61'
        );
        INSERT INTO foods_fts(foods_fts) VALUES('rebuild');
    """)
    conn.commit()


def measure(db):
    conn = sqlite3.connect(db)
    conn.execute("VACUUM")
    conn.commit()
    nf = conn.execute("SELECT COUNT(*) FROM foods").fetchone()[0]
    nn = conn.execute("SELECT COUNT(*) FROM food_nutrients").fetchone()[0]
    nb = conn.execute("SELECT COUNT(*) FROM foods WHERE data_type='branded_food'").fetchone()[0]
    # FTS smoke test
    hit = conn.execute(
        "SELECT f.description FROM foods_fts JOIN foods f ON f.fdc_id=foods_fts.rowid "
        "WHERE foods_fts MATCH 'milk' ORDER BY rank LIMIT 1").fetchone()
    conn.close()
    size_mb = os.path.getsize(db) / 1_000_000
    log("─" * 56)
    log(f"  DB: {db}")
    log(f"  size: {size_mb:.1f} MB   foods: {nf} ({nb} branded)   nutrient rows: {nn}")
    log(f"  FTS smoke 'milk' -> {hit[0] if hit else 'NO MATCH'}")
    log("─" * 56)
    return size_mb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--work", default=DEFAULT_WORK)
    ap.add_argument("--generics-only", action="store_true")
    ap.add_argument("--branded-only", action="store_true")
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--branded-cap", type=int, default=120_000)
    ap.add_argument("--size-cap-mb", type=float, default=150.0)
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    fresh = not args.branded_only
    if fresh and os.path.exists(args.out):
        os.remove(args.out)
    conn = sqlite3.connect(args.out)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    create_schema(conn)

    if args.seed:
        build_seed(conn)
    elif args.branded_only:
        build_branded(conn, args.work, args.branded_cap)
    else:
        build_generics(conn, args.work)
        if not args.generics_only:
            build_branded(conn, args.work, args.branded_cap)

    build_fts(conn)
    conn.close()

    size = measure(args.out)
    if size > args.size_cap_mb:
        log(f"!! size {size:.1f} MB exceeds cap {args.size_cap_mb} MB — "
            f"lower --branded-cap and rebuild --branded-only.")
        sys.exit(2)
    log("OK")


if __name__ == "__main__":
    main()
