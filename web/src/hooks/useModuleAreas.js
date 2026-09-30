// Module ↔ release-Area bridge. Releases.md has no per-release "type" — entries
// are grouped by Area (AREA_PALETTE in useReleaseQueue.js). A module's releases
// are therefore the shipped history filtered to the Areas it owns. A module
// whose name equals an Area (Planner) owns just that one; the map below covers
// the rest, including modules that own several Areas (Library). Modules whose
// Areas have no shipped releases simply render an empty state.

// Module display-name → the release Areas it owns, for names that don't match 1:1.
const MODULE_NAME_TO_AREAS = {
  'Library': ['Music', 'Movies & TV', 'Anime'],
  'Broadcast': ['Broadcast & Game Capture'],
  'Overlay': ['Broadcast & Game Capture'],
  'Video Editor': ['Broadcast & Game Capture'],
  'Deadlock': ['Deadlock & Coaching'],
  'Vault View': ['Vault & Notes'],
};

// The Areas a module's releases live under. Override map first, else the name.
export function areasForModule(manifest) {
  if (!manifest) return [];
  return MODULE_NAME_TO_AREAS[manifest.name] || [manifest.name];
}

// Reverse lookup: the first module id that owns `areaName`, else null. Lets a
// release-history Area header deep-link to a module sub-page when one exists,
// and fall back to the standalone Releases tab when the Area is module-less.
export function moduleIdForArea(areaName, manifests) {
  for (const m of Object.values(manifests || {})) {
    if (areasForModule(m).includes(areaName)) return m.id;
  }
  return null;
}
