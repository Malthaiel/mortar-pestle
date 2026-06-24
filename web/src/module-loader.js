import { createApi } from './module-sdk/index.js';
import { setManifests } from './module-sdk/registry.js';

const VALID_SLOTS       = new Set(['left-sidebar', 'widget', 'settings-tab', 'route', 'provider', 'overlay']);
const VALID_PERMISSIONS = new Set(['vault.read', 'vault.write', 'vault.subscribe', 'localStorage', 'audio', 'pty']);
const VALID_TIERS       = new Set(['core', 'free', 'studio']);
const VALID_LICENSES    = new Set(['MIT', 'Apache-2.0', 'proprietary']);
const KEBAB             = /^[a-z0-9_][a-z0-9_-]*$/;

function validateManifest(manifest, path) {
  const errs = [];
  const here = `[module at ${path}]`;
  if (typeof manifest.id !== 'string' || !KEBAB.test(manifest.id)) {
    errs.push(`${here} manifest.id must be a kebab-case string`);
  }
  if (typeof manifest.name !== 'string')    errs.push(`${here} manifest.name must be string`);
  if (typeof manifest.version !== 'string') errs.push(`${here} manifest.version must be string`);
  if (!Array.isArray(manifest.slots) || !manifest.slots.every(s => VALID_SLOTS.has(s))) {
    errs.push(`${here} manifest.slots must be array of: ${[...VALID_SLOTS].join(', ')}`);
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.every(p => VALID_PERMISSIONS.has(p))) {
    errs.push(`${here} manifest.permissions must be array of: ${[...VALID_PERMISSIONS].join(', ')}`);
  }
  if (typeof manifest.license !== 'string' || !VALID_LICENSES.has(manifest.license)) {
    errs.push(`${here} manifest.license must be one of: ${[...VALID_LICENSES].join(', ')}`);
  }
  if (typeof manifest.tier !== 'string' || !VALID_TIERS.has(manifest.tier)) {
    errs.push(`${here} manifest.tier must be one of: ${[...VALID_TIERS].join(', ')}`);
  }
  if (manifest.requires != null && !Array.isArray(manifest.requires)) {
    errs.push(`${here} manifest.requires must be an array (or omitted)`);
  }
  if (manifest.platforms != null && (!Array.isArray(manifest.platforms) || !manifest.platforms.every(p => typeof p === 'string'))) {
    errs.push(`${here} manifest.platforms must be an array of strings (or omitted)`);
  }
  if (manifest.description != null && typeof manifest.description !== 'string') {
    errs.push(`${here} manifest.description must be a string (or omitted)`);
  }
  if (Array.isArray(manifest.slots) && manifest.slots.includes('left-sidebar')) {
    if (typeof manifest.routeBase !== 'string' || !manifest.routeBase.startsWith('/')) {
      errs.push(`${here} manifest.routeBase must be a string starting with "/" when "left-sidebar" slot is declared`);
    }
  }
  if (errs.length > 0) {
    throw new Error('Module manifest validation failed:\n' + errs.map(e => '  ' + e).join('\n'));
  }
}

function toposort(manifests) {
  const byId = new Map(manifests.map(m => [m.id, m]));
  const visited = new Set();
  const visiting = new Set();
  const result = [];

  function visit(id, stack) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Module dependency cycle: ${[...stack, id].join(' -> ')}`);
    }
    visiting.add(id);
    const m = byId.get(id);
    if (!m) {
      throw new Error(`Module "${id}" missing — required by chain: ${stack.join(' -> ')}`);
    }
    for (const dep of m.requires || []) visit(dep, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
    result.push(m);
  }

  for (const m of manifests) visit(m.id, []);
  return result;
}

// Tier gate at the GLOB level, not just the runtime manifest filter: a
// modules/*/* pattern would emit studio entries as (dead) lazy chunks even
// in core builds — a source leak for the closed-source studio tier. The
// exact `import.meta.env.VITE_BUILD_TIER` form is a Vite define constant,
// so the unused branch folds away at build and its chunks are never
// emitted. (The `?.` form in loadAll is NOT constant-folded — don't use it
// here.)
const IS_STUDIO_BUILD = import.meta.env.VITE_BUILD_TIER === 'studio';

const manifestModules = IS_STUDIO_BUILD
  ? import.meta.glob('../../modules/*/*/manifest.json', { eager: true })
  : import.meta.glob('../../modules/core/*/manifest.json', { eager: true });
const entryModulesJs = IS_STUDIO_BUILD
  ? import.meta.glob('../../modules/*/*/index.js')
  : import.meta.glob('../../modules/core/*/index.js');
const entryModulesJsx = IS_STUDIO_BUILD
  ? import.meta.glob('../../modules/*/*/index.jsx')
  : import.meta.glob('../../modules/core/*/index.jsx');
const entryModules    = { ...entryModulesJs, ...entryModulesJsx };

function entryKeyFor(manifestKey, entry) {
  const dir = manifestKey.replace(/\/manifest\.json$/, '');
  const rel = (entry || './index.jsx').replace(/^\.\//, '');
  return `${dir}/${rel}`;
}

export async function loadAll() {
  const buildTier = import.meta.env?.VITE_BUILD_TIER || 'core';

  const parsed = [];
  for (const [path, mod] of Object.entries(manifestModules)) {
    const manifest = mod.default || mod;
    validateManifest(manifest, path);
    parsed.push({ path, manifest });
  }

  // Windows-port (SF5) platform gate, parallel to the tier gate. A manifest may
  // declare `platforms: ["linux", ...]`; if present and the build target isn't
  // listed, the module is dropped — its register() never runs, so no dock
  // button / route / command-not-found. VITE_TARGET_OS is a Vite define
  // constant; reference it in exact form so the branch folds.
  const TARGET_OS = import.meta.env.VITE_TARGET_OS;
  const filtered = parsed.filter(({ manifest }) =>
    !(manifest.tier === 'studio' && buildTier !== 'studio') &&
    !(Array.isArray(manifest.platforms) && !manifest.platforms.includes(TARGET_OS))
  );
  const droppedForPlatform = parsed
    .filter(({ manifest }) => Array.isArray(manifest.platforms) && !manifest.platforms.includes(TARGET_OS))
    .map(({ manifest }) => manifest.id);
  if (droppedForPlatform.length) {
    console.info(`[module-loader] platform-gated off (${TARGET_OS}): ${droppedForPlatform.join(', ')}`);
  }

  const sorted = toposort(filtered.map(p => p.manifest));
  const byId   = new Map(filtered.map(p => [p.manifest.id, p]));

  const summary = [];
  const loadedManifests = {};
  for (const manifest of sorted) {
    const { path } = byId.get(manifest.id);
    const entryKey = entryKeyFor(path, manifest.entry);
    const loader = entryModules[entryKey];
    if (!loader) {
      throw new Error(
        `[${manifest.id}] entry file not found at "${entryKey}"; available: ${Object.keys(entryModules).join(', ') || '(none)'}`
      );
    }
    const mod = await loader();
    const entry = mod.default || mod;
    if (typeof entry?.register !== 'function') {
      throw new Error(`[${manifest.id}] module entry must default-export { register(api) }`);
    }
    entry.register(createApi(manifest.id));
    summary.push(manifest.id);
    loadedManifests[manifest.id] = manifest;
  }

  setManifests(loadedManifests);
  console.info(`[module-loader] registered: ${summary.join(', ') || '(none)'}`);
}
