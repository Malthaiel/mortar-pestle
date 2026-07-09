// deathAudit.js — Silent-Death Audit (Deadlock Scrim Coaching, sub-plan 10). Pure ESM
// (no React, no @host) so it round-trips through a Node harness like scrimSchema.js /
// commsCompile.js. Cross-refs coached-team deaths (match clock, from the .matchdata
// sidecar via extractSpatial) against comms segments (recording clock, from the
// .commstranscript sidecar via parseSegments): a death with no spoken segment in the
// windowS before it is a "silent death" — a missed callout. The two clocks differ by
// the recording's pre-game footage; recording time = game time + offsetS (the
// per-match `Comms Offset` field, user-calibrated, default 0).

// deaths: [{ team, hero, t }] (extractSpatial shape; t = game_time_s)
// segments: [{ t0Ms, t1Ms, text }] (parseSegments shape; recording clock)
// → { total, silent: [{ hero, t }] } — silent sorted by t ascending; side null = both teams.
export function auditSilentDeaths(deaths, segments, { side = null, offsetS = 0, windowS = 10 } = {}) {
  const spoken = (Array.isArray(segments) ? segments : [])
    .filter((s) => s && String(s.text ?? '').trim() !== '');
  const rows = (Array.isArray(deaths) ? deaths : [])
    .filter((d) => d && (side == null || d.team === side))
    .map((d) => ({ hero: d.hero, t: Number(d.t) || 0 }))
    .sort((a, b) => a.t - b.t);
  const silent = rows.filter((d) => {
    const endMs = (d.t + offsetS) * 1000;
    const startMs = endMs - windowS * 1000;
    return !spoken.some((s) => s.t0Ms < endMs && s.t1Ms > startMs);
  });
  return { total: rows.length, silent };
}
