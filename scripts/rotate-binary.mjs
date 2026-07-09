#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function safeUnlink(p) {
  try { if (existsSync(p)) unlinkSync(p); } catch (e) { console.warn('[rotate-binary] unlink failed (ignored):', p, e.message); }
}
function safeRename(from, to) {
  try { if (existsSync(from)) renameSync(from, to); } catch (e) { console.warn('[rotate-binary] rename failed (ignored):', from, '->', to, e.message); }
}

/** Rotate mortar-pestle -> .prev -> .prev2 inside `releaseDir`. Best-effort. */
export function rotate(releaseDir) {
  if (!existsSync(releaseDir)) {
    mkdirSync(releaseDir, { recursive: true });
    console.log('[rotate-binary] no target/release/ yet — first build, nothing to rotate');
    return;                       // NOTE: return, not process.exit — safe to call in-process
  }
  const current = join(releaseDir, 'mortar-pestle');
  const prev    = join(releaseDir, 'mortar-pestle.prev');
  const prev2   = join(releaseDir, 'mortar-pestle.prev2');
  safeUnlink(prev2);
  safeRename(prev, prev2);
  safeRename(current, prev);
  console.log('[rotate-binary] rotation complete (current -> .prev -> .prev2)');
}

// Run against the real release dir only when invoked directly (the build hook does
// `node scripts/rotate-binary.mjs`). Importing this module must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rotate(join(__dirname, '..', 'src-tauri', 'target', 'release'));
}
