import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotate } from './rotate-binary.mjs';

function tempReleaseDir() {
  return mkdtempSync(join(tmpdir(), 'rotate-'));
}

test('rotate moves current -> .prev and .prev -> .prev2', () => {
  const dir = tempReleaseDir();
  try {
    writeFileSync(join(dir, 'mortar-pestle'), 'GEN0-current');
    writeFileSync(join(dir, 'mortar-pestle.prev'), 'GEN1-prev');
    writeFileSync(join(dir, 'mortar-pestle.prev2'), 'GEN2-prev2-should-be-dropped');

    rotate(dir);

    // current was moved into .prev, so it no longer exists (build recreates it).
    assert.equal(existsSync(join(dir, 'mortar-pestle')), false);
    // .prev now holds the former current; .prev2 holds the former .prev.
    assert.equal(readFileSync(join(dir, 'mortar-pestle.prev'), 'utf8'), 'GEN0-current');
    assert.equal(readFileSync(join(dir, 'mortar-pestle.prev2'), 'utf8'), 'GEN1-prev');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotate tolerates a missing .prev2 (first rotations)', () => {
  const dir = tempReleaseDir();
  try {
    writeFileSync(join(dir, 'mortar-pestle'), 'GEN0-current');
    writeFileSync(join(dir, 'mortar-pestle.prev'), 'GEN1-prev');
    // no .prev2 present

    rotate(dir);

    assert.equal(readFileSync(join(dir, 'mortar-pestle.prev'), 'utf8'), 'GEN0-current');
    assert.equal(readFileSync(join(dir, 'mortar-pestle.prev2'), 'utf8'), 'GEN1-prev');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotate on a non-existent dir creates it and does not throw', () => {
  const base = mkdtempSync(join(tmpdir(), 'rotate-'));
  const missing = join(base, 'does-not-exist-yet');
  try {
    rotate(missing);                       // must return, not exit/throw
    assert.equal(existsSync(missing), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
