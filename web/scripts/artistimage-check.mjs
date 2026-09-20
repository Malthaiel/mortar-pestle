// Self-check for modules/core/library/music/artistImage.js — the artist-photo
// fetcher behind the album header. Runs the REAL module against a stub
// localStorage and a stub fetch, no browser, no network, no deps.
//
//   node web/scripts/artistimage-check.mjs
//
// Four things it must never stop doing: cache a hit, cache a MISS (so a
// photoless artist is probed once ever), swallow a dead network, and collapse
// two simultaneous asks for the same artist into one request.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO, 'modules/core/library/music/artistImage.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artistimg-'));
const bundle = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [SRC], bundle: true, format: 'esm', outfile: bundle, logLevel: 'silent' });

// ── stubs, installed before the module body runs ────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let calls = [];
let responder = null;
globalThis.fetch = async (url) => { calls.push(url); return responder(url); };
const ok = (body) => ({ ok: true, json: async () => body });

const { artistImage, __resetArtistImageCache } =
  await import('file://' + bundle.split(path.sep).join('/'));

const fresh = () => { __resetArtistImageCache(); store.clear(); calls = []; };

// 1. a hit returns the thumb and is cached — a second ask makes no request
fresh();
responder = () => ok({ artists: [{ strArtistThumb: 'https://x/deftones.jpg' }] });
assert.equal(await artistImage('Deftones'), 'https://x/deftones.jpg');
assert.equal(await artistImage('Deftones'), 'https://x/deftones.jpg');
assert.equal(calls.length, 1, 'a cached hit must not re-request');
assert.ok(calls[0].includes('Deftones'), 'the artist name must reach the query');

// 2. the cache is case/space-insensitive on the name
assert.equal(await artistImage('  deftones '), 'https://x/deftones.jpg');
assert.equal(calls.length, 1, 'the same artist spelled loosely must not re-request');

// 3. a MISS is cached too — a photoless artist is probed once ever
fresh();
responder = () => ok({ artists: null });
assert.equal(await artistImage('alyzea'), '');
assert.equal(await artistImage('alyzea'), '');
assert.equal(calls.length, 1, 'a cached miss must not re-request');

// 4. a dead network resolves to '' rather than rejecting
fresh();
responder = () => { throw new Error('offline'); };
assert.equal(await artistImage('Deftones'), '', 'a throwing fetch must resolve empty');

// 5. an empty name asks nothing at all
fresh();
responder = () => { throw new Error('should not be called'); };
assert.equal(await artistImage(''), '');
assert.equal(await artistImage(null), '');
assert.equal(calls.length, 0, 'a nameless album must not hit the network');

// 6. two simultaneous asks share one request
fresh();
let release;
responder = () => new Promise((r) => { release = () => r(ok({ artists: [{ strArtistThumb: 'u' }] })); });
const both = Promise.all([artistImage('Tennis'), artistImage('Tennis')]);
release();
assert.deepEqual(await both, ['u', 'u']);
assert.equal(calls.length, 1, 'concurrent asks must collapse into one request');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('artistImage: 6 checks passed');
