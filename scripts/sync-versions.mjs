#!/usr/bin/env node
// Propagate `web/package.json` version → root package.json + src-tauri/tauri.conf.json + src-tauri/Cargo.toml.
// web/package.json is the source of truth. Run after bumping web/package.json.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const webPkgPath   = join(repoRoot, 'web', 'package.json');
const rootPkgPath  = join(repoRoot, 'package.json');
const tauriConfPath = join(repoRoot, 'src-tauri', 'tauri.conf.json');
const cargoPath    = join(repoRoot, 'src-tauri', 'Cargo.toml');

const webPkg = JSON.parse(readFileSync(webPkgPath, 'utf8'));
const target = webPkg.version;
if (!target) {
  console.error('[sync-versions] web/package.json has no version field');
  process.exit(1);
}

let touched = 0;

function updateJson(path, label, mutator) {
  const raw = readFileSync(path, 'utf8');
  const obj = JSON.parse(raw);
  const before = obj.version;
  mutator(obj);
  if (obj.version === before) return;
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  writeFileSync(path, JSON.stringify(obj, null, 2) + trailingNewline);
  console.log(`[sync-versions] ${label}: ${before} -> ${obj.version}`);
  touched++;
}

updateJson(rootPkgPath,   'package.json',         obj => { obj.version = target; });
updateJson(tauriConfPath, 'tauri.conf.json',      obj => { obj.version = target; });

// Cargo.toml — first `version = "..."` line in [package] section.
const cargo = readFileSync(cargoPath, 'utf8');
const cargoFixed = cargo.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${target}"`);
if (cargoFixed !== cargo) {
  writeFileSync(cargoPath, cargoFixed);
  console.log(`[sync-versions] Cargo.toml -> ${target}`);
  touched++;
}

if (touched === 0) {
  console.log(`[sync-versions] all 4 files already at ${target}`);
} else {
  console.log(`[sync-versions] done — ${touched} file(s) updated to ${target}`);
}
