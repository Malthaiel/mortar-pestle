// scrimSchema.js — all that survives the 2026-07-26 Scrim Teardown: the rule for
// naming a scrim folder. Everything else this module held (the Overview/Match
// markdown parse+serialize round-trip, the seed skeletons, the notes accessors)
// went with the pages that used it. A scrim is now a folder and nothing more;
// whatever gets built inside it next brings its own schema.
//
// Pure ESM (no React, no @host) so it stays standalone-harnessable.

// Where scrims live in the GameWiki vault. Lives here rather than in
// GameWikiTree so CoachPopup can read it without importing the tree that
// renders it (a cycle: the tree mounts the popup).
export const SCRIM_BASE = 'Deadlock/Coaching/Scrim';

// Filename-safe team name.
const sanitizeTeam = (name) => String(name || '').replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();

// `<Team 1> VS <Team 2> (MM-DD-YY)` for today. The caller dedups against the
// existing folder listing and creates the folder itself.
export function newScrimName({ team1, team2 } = {}) {
  const t1 = sanitizeTeam(team1) || 'Team 1';
  const t2 = sanitizeTeam(team2) || 'Team 2';
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const short = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${String(d.getFullYear()).slice(2)}`;
  return `${t1} VS ${t2} (${short})`;
}
