// Module ↔ release-Area bridge. Releases.md has no per-release "type" — entries
// are grouped by Area (AREA_PALETTE in useReleaseQueue.js). A module's releases
// are therefore the shipped history filtered to its matching Area name. Most
// module display names equal an Area name (Planner, Browser, Library, Domain
// Builder); the few mismatches live in the override map below. Modules whose
// name maps to no shipped Area simply render an empty state.

// Module display-name → release Area, for the names that don't match 1:1.
const MODULE_NAME_TO_AREA = {
  'Vault View': 'Vault',
  'Video Editor': 'Video',
};

// The Area a module's releases live under. Override map first, else the name.
export function areaForModule(manifest) {
  if (!manifest) return null;
  return MODULE_NAME_TO_AREA[manifest.name] || manifest.name;
}

// Reverse lookup: the module id whose Area equals `areaName`, else null. Lets a
// release-history Area header deep-link to a module sub-page when one exists,
// and fall back to the standalone Releases tab when the Area is module-less.
export function moduleIdForArea(areaName, manifests) {
  for (const m of Object.values(manifests || {})) {
    if (areaForModule(m) === areaName) return m.id;
  }
  return null;
}
