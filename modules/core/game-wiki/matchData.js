// matchData.js — Match Data Ingestion (Deadlock Scrim Coaching, sub-plan 2) helpers.
//
// deadlock_fetch_match (Rust) returns a match's full deadlock-api metadata verbatim.
// We store that raw JSON in a dot-prefixed sibling file in the Scrim/ folder
// (invisible to the read-only Game Wiki tree — the vault's scan_dir skips dotfiles,
// the dotfile lives in the existing Scrim/ folder for tree-hiding only — vault_write_file
// now creates missing parent dirs, so this is a display choice, not a dir-creation limit)
// and write a small human summary + a pointer into the scrim's ### Match Data. MatchViewPopup
// reads the sidecar and renders the full match view over it. "Pull literally
// everything": the sidecar is the untouched source of truth; everything here is
// derived sugar that degrades to a gap (never throws) when a field is absent.

import { itemName, itemSlot, itemTier, isShopItem, structureName } from './matchAssets.js';

// Deadlock team sides: 0 = Amber (The Amber Hand), 1 = Sapphire (The Sapphire Flame).
export const TEAM_NAMES = { 0: 'Amber', 1: 'Sapphire' };

// The ### Match Data body emptyMatch() writes before a run (scrimSchema.js).
export const MATCH_DATA_PLACEHOLDER = '_(populated on Run Process)_';

// Baked hero id→name snapshot from the public deadlock-api assets
// (GET /v1/assets/heroes?only_active=true, fetched 2026-06-16). Unknown ids fall
// back to "Hero {id}", so a newly-released hero degrades gracefully, never breaks.
export const HERO_NAMES = {
  1: 'Infernus', 2: 'Seven', 3: 'Vindicta', 4: 'Lady Geist', 6: 'Abrams',
  7: 'Wraith', 8: 'McGinnis', 10: 'Paradox', 11: 'Dynamo', 12: 'Kelvin',
  13: 'Haze', 14: 'Holliday', 15: 'Bebop', 16: 'Calico', 17: 'Grey Talon',
  18: 'Mo & Krill', 19: 'Shiv', 20: 'Ivy', 25: 'Warden', 27: 'Yamato',
  31: 'Lash', 35: 'Viscous', 50: 'Pocket', 52: 'Mirage', 58: 'Vyper',
  60: 'Sinclair', 63: 'Mina', 64: 'Drifter', 65: 'Venator', 66: 'Victor',
  67: 'Paige', 69: 'The Doorman', 72: 'Billy', 76: 'Graves', 77: 'Apollo',
  79: 'Rem', 80: 'Silver', 81: 'Celeste',
};

export const heroName = (id) => HERO_NAMES[id] || `Hero ${id}`;
export const sideName = (t) => (t in TEAM_NAMES ? TEAM_NAMES[t] : `Team ${t}`);

// SteamID3 account_id → SteamID64 (the form the Steam Web API takes). Null-safe: a match
// payload without account_id (older sidecars) yields null, never a bogus id.
const STEAMID64_BASE = 76561197960265728n;
export const steamId64 = (accountId) => (accountId == null ? null : String(BigInt(accountId) + STEAMID64_BASE));

// A scrim is a FOLDER (`…/Scrim/<base>/` — GameWiki Unification, 2026-07-16): Overview.md +
// Matches/Match <n>.md + dot-sidecars scoped by the folder. Every sidecar consumer routes
// through the two helpers below, so they accept ANY path inside the scrim — the folder
// itself, Overview.md, or Matches/Match <n>.md — and normalize to the folder.
export function scrimFolderOf(p) {
  return String(p || '')
    .replace(/\/+$/, '')
    .replace(/\/(Overview\.md|Matches(\/[^/]*)?)$/, '')
    .replace(/\.md$/, '');
}

// Match-level sidecar: `<folder>/Matches/.matchdata.Match 1.json`. Dot-prefix keeps it out of the
// tree (scan_dir hides dotfiles); the folder scopes the scrim, so the name no longer carries the
// scrim base. An unknown kind falls back to matchdata (was a ternary chain; a map so a new kind is
// one line, not a fifth nesting level).
const SIDECAR_PREFIX = {
  matchdata: 'matchdata',
  comms: 'commstranscript',
  autoclass: 'autoclass',
  tfcomms: 'tfcomms',
  matchreport: 'matchreport', // WS4 M22: the per-match AI coaching report
  matchfeedback: 'matchfeedback', // WS4 M23: coach Mark/Wrong corrections on that report
  matchfinal: 'matchfinal', // M4: the coach-voiced final report (Process 2) — replaces matchreport in views
  reviewcomms: 'reviewcomms', // per-match VOD-review transcript (Recording B, per-match by design)
};

export function sidecarPath(scrim, matchN, kind = 'matchdata') {
  return `${scrimFolderOf(scrim)}/Matches/.${SIDECAR_PREFIX[kind] || 'matchdata'}.Match ${matchN}.json`;
}

// The match page itself (moved here from scrimShared so path-free modules — the
// tree, the router pane — can build it without importing the JSX module; it is
// also the sectionJump key the match report view listens on).
export const matchPath = (scrimFolder, n) => `${scrimFolder}/Matches/Match ${n}.md`;

// Scrim-level twin (no per-match suffix): the VOD Review recording is one file for the
// whole scrim. `<folder>/.vodcomms.json` (`kind: 'vodreport'` → `.vodreport.json`).
export function scrimSidecarPath(scrim, kind) {
  return `${scrimFolderOf(scrim)}/.${kind}.json`;
}

// The ONE accessor for a match's REVIEW transcript (Recording B) — every consumer (Review Segments
// page, Process 2 generate, M8 adoption) resolves through here, never by inlining paths: the
// per-match `.reviewcomms` sidecar when present, else — single-match scrims only (M8 legacy
// adoption, North's case) — the scrim-level `.vodcomms`. Read-only either way; the legacy file is
// never moved or rewritten. Multi-match legacy scrims get no fallback (adoption is forbidden there).
export async function resolveReviewTranscript(api, scrim, matchN) {
  const folder = scrimFolderOf(scrim);
  const per = sidecarPath(folder, matchN, 'reviewcomms');
  try { await api.getRawFileMeta(per, 'gamewiki'); return { path: per, scrimLevel: false }; } catch { /* no per-match review yet */ }
  try {
    const list = await api.listFolderRaw(`${folder}/Matches`, 'gamewiki');
    const mds = (list?.files || []).filter((f) => /^Match \d+\.md$/.test(f));
    if (mds.length !== 1) return null;
    const legacy = scrimSidecarPath(folder, 'vodcomms');
    await api.getRawFileMeta(legacy, 'gamewiki');
    return { path: legacy, scrimLevel: true };
  } catch { return null; }
}

// Whole seconds → m:ss ("—" for missing/NaN).
export function clock(s) {
  if (s == null || !Number.isFinite(Number(s))) return '—';
  const v = Math.max(0, Math.floor(Number(s)));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

// Unix seconds (match_info.start_time) → local wall-clock time-of-day ("7:42 PM").
// '' for missing/zero/NaN, so an auto-fill of a gap is a no-op rather than "Invalid Date".
export function fmtLocalTime(unixS) {
  const n = Number(unixS);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Structured view-model from raw deadlock-api metadata. Tolerant: any absent field
// becomes a null/0/empty, never a throw — schema drift degrades to a gap.
export function extractMatch(raw) {
  const mi = (raw && raw.match_info) || {};
  const players = Array.isArray(mi.players) ? mi.players : [];
  const rows = players.map((p) => ({
    team: p.team,
    side: sideName(p.team),
    heroId: p.hero_id,
    hero: heroName(p.hero_id),
    kills: p.kills ?? 0, deaths: p.deaths ?? 0, assists: p.assists ?? 0,
    netWorth: p.net_worth ?? 0,
    lastHits: p.last_hits ?? 0, denies: p.denies ?? 0,
    level: p.level ?? 0,
    // active items = purchased and not sold (sold_time_s 0/absent), counted (item names deferred).
    items: Array.isArray(p.items)
      ? p.items.filter((it) => it && it.item_id && !(it.sold_time_s > 0)).length
      : 0,
  }));
  // objectives[].team = the OWNER of the destroyed structure (verified 2026-06-16:
  // the loser owns the latest-destroyed objective ≈ its Patron at match end).
  const objectives = (Array.isArray(mi.objectives) ? mi.objectives : [])
    .filter((o) => o && o.destroyed_time_s > 0) // 0 = survived (sentinel), not destroyed at 0:00
    .map((o) => ({ t: Number(o.destroyed_time_s), lostBy: sideName(o.team) }))
    .sort((a, b) => a.t - b.t);
  const midBoss = (Array.isArray(mi.mid_boss) ? mi.mid_boss : [])
    .filter((b) => b && b.destroyed_time_s > 0) // 0 = not claimed
    .map((b) => ({ t: Number(b.destroyed_time_s), claimedBy: sideName(b.team_claimed) }))
    .sort((a, b) => a.t - b.t);
  const winningTeam = mi.winning_team;
  return {
    matchId: mi.match_id ?? null,
    durationS: mi.duration_s ?? null,
    winningTeam,
    winningSide: winningTeam == null ? null : sideName(winningTeam),
    rows, objectives, midBoss,
  };
}

// Match-level meta for the Scoreboard header. Raw badge numbers — resolve via
// rankFromBadge() at render. 0-duration pause events (per-slot echoes) are dropped.
export function extractMeta(raw) {
  const mi = (raw && raw.match_info) || {};
  return {
    matchId: mi.match_id ?? null,
    durationS: mi.duration_s ?? null,
    winningTeam: mi.winning_team,
    winningSide: mi.winning_team == null ? null : sideName(mi.winning_team),
    startTime: mi.start_time ?? null,
    gameMode: mi.game_mode ?? null,
    matchMode: mi.match_mode ?? null,
    badge0: mi.average_badge_team0 ?? 0,
    badge1: mi.average_badge_team1 ?? 0,
    pauses: (Array.isArray(mi.match_pauses) ? mi.match_pauses : [])
      .map((p) => ({ t: Number(p.game_time_s) || 0, dur: Number(p.pause_duration_s) || 0, slot: p.player_slot }))
      .filter((p) => p.dur > 0)
      .sort((a, b) => a.t - b.t),
  };
}

// ── Player Stats (SF-B) ──────────────────────────────────────────────────────

// match-level custom-stat legend: id → { group, metric }. Names use a "Group##Metric"
// convention; a name without "##" (e.g. "Parry Success") falls under the "Misc" group.
function customLegend(mi) {
  const map = new Map();
  for (const e of (Array.isArray(mi.custom_user_stats) ? mi.custom_user_stats : [])) {
    if (!e || e.id == null) continue;
    const parts = String(e.name || '').split('##');
    map.set(e.id, parts.length > 1 ? { group: parts[0], metric: parts[1] } : { group: 'Misc', metric: parts[0] });
  }
  return map;
}

// focus-fire: dealerSlot → Map(targetSlot → gross damage). damage[] is cumulative per
// (source, target), so the last element is that source's running total; sum across the
// dealer's sources. This is GROSS hero damage (all sources, pre-mitigation) — larger than
// the net `player_damage` stat, so the render must label it as gross.
function damageDealtMap(mi) {
  const dm = mi.damage_matrix || {};
  const dealt = new Map();
  for (const dealer of (Array.isArray(dm.damage_dealers) ? dm.damage_dealers : [])) {
    const tmap = dealt.get(dealer.dealer_player_slot) || new Map();
    for (const src of (Array.isArray(dealer.damage_sources) ? dealer.damage_sources : [])) {
      for (const t of (Array.isArray(src.damage_to_players) ? src.damage_to_players : [])) {
        const ser = t.damage;
        const last = Array.isArray(ser) && ser.length ? Number(ser[ser.length - 1]) || 0 : 0;
        tmap.set(t.target_player_slot, (tmap.get(t.target_player_slot) || 0) + last);
      }
    }
    dealt.set(dealer.dealer_player_slot, tmap);
  }
  return dealt;
}

// Rich per-player view-models for the Player Stats tab (one pass over all 12). Tolerant:
// every field degrades to a gap, never a throw.
export function extractPlayers(raw) {
  const mi = (raw && raw.match_info) || {};
  const players = Array.isArray(mi.players) ? mi.players : [];
  const legend = customLegend(mi);
  const dealt = damageDealtMap(mi);

  return players.map((p) => {
    const purchases = (Array.isArray(p.items) ? p.items : [])
      .filter((it) => it && it.item_id)
      .map((it) => ({
        id: it.item_id, name: itemName(it.item_id), slot: itemSlot(it.item_id), tier: itemTier(it.item_id),
        shop: isShopItem(it.item_id), t: Number(it.game_time_s) || 0,
        soldT: it.sold_time_s > 0 ? Number(it.sold_time_s) : null, imbued: !!it.imbued_ability_id,
      }))
      .sort((a, b) => a.t - b.t);

    const last = (Array.isArray(p.stats) && p.stats.length) ? p.stats[p.stats.length - 1] : {};

    // decoded custom stats grouped by legend group (the exhaustive "all other stats")
    const groups = new Map();
    for (const c of (Array.isArray(last.custom_user_stats) ? last.custom_user_stats : [])) {
      const L = legend.get(c.id); if (!L) continue;
      const arr = groups.get(L.group) || []; arr.push({ metric: L.metric, value: c.value }); groups.set(L.group, arr);
    }
    const customGroups = [...groups.entries()].map(([group, items]) => ({ group, items }));

    // focus-fire per enemy (gross damage dealt / taken)
    const myDealt = dealt.get(p.player_slot) || new Map();
    const enemies = players.filter((q) => q.team !== p.team);
    const dmgDealt = enemies
      .map((q) => ({ hero: heroName(q.hero_id), dmg: Math.round(myDealt.get(q.player_slot) || 0) }))
      .sort((a, b) => b.dmg - a.dmg);
    const dmgTaken = enemies
      .map((q) => ({ hero: heroName(q.hero_id), dmg: Math.round((dealt.get(q.player_slot) || new Map()).get(p.player_slot) || 0) }))
      .sort((a, b) => b.dmg - a.dmg);

    return {
      slot: p.player_slot, team: p.team, side: sideName(p.team),
      accountId: p.account_id ?? null,
      heroId: p.hero_id, hero: heroName(p.hero_id),
      kills: p.kills ?? 0, deaths: p.deaths ?? 0, assists: p.assists ?? 0,
      netWorth: p.net_worth ?? 0, lastHits: p.last_hits ?? 0, denies: p.denies ?? 0,
      level: p.level ?? 0, abilityPoints: p.ability_points ?? 0,
      assignedLane: p.assigned_lane ?? null, mvpRank: p.mvp_rank ?? null,
      build: purchases.filter((x) => x.shop),
      abilities: purchases.filter((x) => !x.shop),
      stats: last,
      customGroups,
      accolades: (Array.isArray(p.accolades) ? p.accolades : []).map((a) => ({ id: a.accolade_id, value: a.accolade_stat_value, tier: a.accolade_threshold_achieved })),
      powerups: (Array.isArray(p.power_up_buffs) ? p.power_up_buffs : []).map((b) => ({ type: b.type, value: b.value, permanent: !!b.is_permanent })),
      dmgDealt, dmgTaken,
    };
  });
}

// ── Lanes (SF-C) ─────────────────────────────────────────────────────────────

// Group players by assigned_lane into 2v2 (or NvN) matchups with combined souls.
export function extractLanes(raw) {
  const mi = (raw && raw.match_info) || {};
  const players = Array.isArray(mi.players) ? mi.players : [];
  const laneMap = new Map();
  for (const p of players) {
    const lane = p.assigned_lane ?? 0;
    const arr = laneMap.get(lane) || [];
    arr.push({
      team: p.team, side: sideName(p.team), hero: heroName(p.hero_id),
      netWorth: p.net_worth ?? 0, lastHits: p.last_hits ?? 0, denies: p.denies ?? 0,
      kills: p.kills ?? 0, deaths: p.deaths ?? 0, assists: p.assists ?? 0, level: p.level ?? 0,
    });
    laneMap.set(lane, arr);
  }
  const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
  return [...laneMap.entries()].sort((a, b) => a[0] - b[0]).map(([lane, ps]) => {
    const amber = ps.filter((x) => x.team === 0);
    const sapphire = ps.filter((x) => x.team === 1);
    return { lane, amber, sapphire, amberNet: sum(amber, 'netWorth'), sapphireNet: sum(sapphire, 'netWorth') };
  });
}

// ── Objectives + mid-boss (SF-C structures summary + SF-E Map) ────────────────
// objectives[].team = the OWNER of the structure; destroyed_time_s 0 = survived.
// No lane field exists on objectives, so structures can't be attributed to a lane.
export function extractObjectives(raw) {
  const mi = (raw && raw.match_info) || {};
  const objectives = (Array.isArray(mi.objectives) ? mi.objectives : []).map((o) => ({
    id: o.team_objective_id, name: structureName(o.team_objective_id),
    team: o.team, side: sideName(o.team),
    destroyed: o.destroyed_time_s > 0 ? Number(o.destroyed_time_s) : null,
    firstDamage: o.first_damage_time_s > 0 ? Number(o.first_damage_time_s) : null,
    creepDmg: o.creep_damage ?? 0, playerDmg: o.player_damage ?? 0, spiritDmg: o.player_spirit_damage ?? 0,
  }));
  const midBoss = (Array.isArray(mi.mid_boss) ? mi.mid_boss : [])
    .filter((b) => b && b.destroyed_time_s > 0)
    .map((b) => ({ destroyed: Number(b.destroyed_time_s), claimedBy: sideName(b.team_claimed) }))
    .sort((a, b) => a.destroyed - b.destroyed);
  return { objectives, midBoss };
}

// ── Time-series (SF-D) ───────────────────────────────────────────────────────
// Per-player series from the stats[] frames (x = time_stamp_s). souls/min derived.
export function extractSeries(raw) {
  const mi = (raw && raw.match_info) || {};
  const players = Array.isArray(mi.players) ? mi.players : [];
  return players.map((p) => {
    const frames = Array.isArray(p.stats) ? p.stats : [];
    const pts = frames.map((f) => {
      const t = Number(f.time_stamp_s) || 0;
      const net = Number(f.net_worth) || 0;
      return {
        t, net_worth: net,
        cs: (Number(f.creep_kills) || 0) + (Number(f.neutral_kills) || 0),
        damage: Number(f.player_damage) || 0,
        level: Number(f.level) || 0,
        soulsmin: t > 0 ? net / (t / 60) : 0,
      };
    }).sort((a, b) => a.t - b.t);
    return { slot: p.player_slot, team: p.team, side: sideName(p.team), hero: heroName(p.hero_id), pts };
  });
}

// ── Spatial (SF-E) ───────────────────────────────────────────────────────────
// Death positions (world coords) + per-player movement paths (quantized 0..res with
// per-player world min/max → world coords), plus the global SQUARE bounds across both
// so the death map + heatmap share one undistorted normalized space. No map image →
// the render normalizes to a bounding box (overlay deferred).
export function extractSpatial(raw) {
  const mi = (raw && raw.match_info) || {};
  const players = Array.isArray(mi.players) ? mi.players : [];
  const duration = Number(mi.duration_s) || 1;

  const deaths = [];
  for (const p of players) {
    for (const d of (Array.isArray(p.death_details) ? p.death_details : [])) {
      if (d && d.death_pos) deaths.push({ team: p.team, hero: heroName(p.hero_id), x: d.death_pos.x, y: d.death_pos.y, t: Number(d.game_time_s) || 0 });
    }
  }

  const mp = mi.match_paths || {};
  const res = Number(mp.x_resolution) || 16383;
  const paths = (Array.isArray(mp.paths) ? mp.paths : []).map((pa) => {
    const xs = Array.isArray(pa.x_pos) ? pa.x_pos : [];
    const ys = Array.isArray(pa.y_pos) ? pa.y_pos : [];
    const n = Math.min(xs.length, ys.length);
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
      pts[i] = { x: pa.x_min + (xs[i] / res) * (pa.x_max - pa.x_min), y: pa.y_min + (ys[i] / res) * (pa.y_max - pa.y_min) };
    }
    const pl = players.find((q) => q.player_slot === pa.player_slot);
    return { slot: pa.player_slot, team: pl ? pl.team : 0, hero: pl ? heroName(pl.hero_id) : `Slot ${pa.player_slot}`, pts };
  });

  // global square bounds (loop, not spread — paths hold ~32k points)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const see = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const d of deaths) see(d.x, d.y);
  for (const p of paths) for (const q of p.pts) see(q.x, q.y);
  let bounds = null;
  if (Number.isFinite(minX)) {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const half = (Math.max(maxX - minX, maxY - minY) / 2) * 1.04 || 1;
    bounds = { cx, cy, half };
  }
  return { deaths, paths, bounds, duration };
}

// Combined, time-sorted objective + mid-boss events (used by the view + summary).
export function timeline(m) {
  return [
    ...m.objectives.map((o) => ({ t: o.t, label: `${o.lostBy} structure destroyed` })),
    ...m.midBoss.map((b) => ({ t: b.t, label: `Mid-boss claimed by ${b.claimedBy}` })),
  ].sort((a, b) => a.t - b.t);
}

// Small markdown summary written into ### Match Data — Obsidian-legible + a fallback
// when the sidecar is unavailable. The sidecar holds the full raw JSON (source of truth).
export function renderSummary(raw, sidecarFileName) {
  const m = extractMatch(raw);
  const lines = ['_(Run-Process-owned — regenerated each run)_'];
  const head = [];
  if (m.matchId != null) head.push(`Match ${m.matchId}`);
  if (m.winningSide) head.push(`${m.winningSide} win`);
  if (m.durationS != null) head.push(clock(m.durationS));
  lines.push(`**${head.join(' · ') || 'Match data'}**`);
  for (const side of [0, 1]) {
    const rs = m.rows.filter((r) => r.team === side);
    if (!rs.length) continue;
    lines.push('', `**${sideName(side)}**`);
    for (const r of rs) {
      lines.push(`- ${r.hero} — ${r.kills}/${r.deaths}/${r.assists} · ${r.netWorth.toLocaleString()} souls · lvl ${r.level}`);
    }
  }
  const ev = timeline(m);
  if (ev.length) {
    lines.push('', '**Timeline**');
    for (const e of ev) lines.push(`- ${clock(e.t)} — ${e.label}`);
  }
  if (sidecarFileName) lines.push('', `_Raw data: \`${sidecarFileName}\`_`);
  return lines.join('\n');
}
