#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const releaseDir = join(__dirname, '..', 'src-tauri', 'target', 'release');

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
  console.log('[rotate-binary] no target/release/ yet — first build, nothing to rotate');
  process.exit(0);
}

const current = join(releaseDir, 'iskariel');
const prev    = join(releaseDir, 'iskariel.prev');
const prev2   = join(releaseDir, 'iskariel.prev2');

function safeUnlink(p) {
  try { if (existsSync(p)) unlinkSync(p); } catch (e) { console.warn('[rotate-binary] unlink failed (ignored):', p, e.message); }
}
function safeRename(from, to) {
  try { if (existsSync(from)) renameSync(from, to); } catch (e) { console.warn('[rotate-binary] rename failed (ignored):', from, '->', to, e.message); }
}

safeUnlink(prev2);
safeRename(prev, prev2);
safeRename(current, prev);

console.log('[rotate-binary] rotation complete (current -> .prev -> .prev2)');
