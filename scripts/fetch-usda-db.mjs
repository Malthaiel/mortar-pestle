#!/usr/bin/env node
// fetch-usda-db.mjs — populate src-tauri/resources/usda_foods.db before bundling.
// Chained into tauri.conf.json::beforeBuildCommand after rotate-binary.mjs.
// Zero-dep (Node 18+ global fetch). Gated on file-absence: no-op if the db is present.
// ponytail: no checksum file — HTTPS + Content-Length match + SQLite magic header validate.
// Exits via process.exitCode (NOT process.exit): an abrupt process.exit while a fetch
// keep-alive socket is closing trips a libuv assertion on Windows Node 24
// (UV_HANDLE_CLOSING). Letting the event loop drain closes the socket cleanly, then
// Node exits with exitCode. Cancelling the response body on the error path releases the
// connection so the drain is prompt.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dest = join(__dirname, '..', 'src-tauri', 'resources', 'usda_foods.db');
const RELEASE_URL = 'https://github.com/Malthaiel/mortar-pestle/releases/download/usda-db-v1/usda_foods.db';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

class FetchFail extends Error {}

async function run() {
  if (existsSync(dest)) {
    console.log('[fetch-usda-db] usda_foods.db present — skipping fetch');
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });
  console.log('[fetch-usda-db] db absent — fetching', RELEASE_URL);

  let res;
  try {
    res = await fetch(RELEASE_URL);
  } catch (e) {
    throw new FetchFail(`fetch threw: ${e.message}`);
  }
  if (!res.ok || !res.body) {
    try { await res.body?.cancel(); } catch { /* release the connection */ }
    throw new FetchFail(`HTTP ${res.status} — upload the usda-db-v1 Release asset first (SP10)`);
  }

  const expected = Number(res.headers.get('content-length')) || 0;
  try {
    await pipeline(res.body, createWriteStream(dest));
  } catch (e) {
    throw new FetchFail(`write failed: ${e.message}`);
  }

  const actual = statSync(dest).size;
  if (expected && actual !== expected) {
    throw new FetchFail(`size mismatch: wrote ${actual}, expected ${expected} (partial download)`);
  }

  let fh;
  try {
    fh = await open(dest, 'r');
    const buf = Buffer.alloc(16);
    await fh.read(buf, 0, 16, 0);
    await fh.close();
    if (!buf.equals(SQLITE_MAGIC)) throw new FetchFail('downloaded file is not a SQLite database (bad magic header)');
  } catch (e) {
    try { if (fh) await fh.close(); } catch { /* ignore */ }
    throw e instanceof FetchFail ? e : new FetchFail(`verify failed: ${e.message}`);
  }

  console.log(`[fetch-usda-db] populated usda_foods.db (${actual} bytes)`);
}

try {
  await run();
} catch (e) {
  console.error('[fetch-usda-db]', e instanceof FetchFail ? e.message : `unexpected: ${e}`);
  try { if (existsSync(dest)) unlinkSync(dest); } catch { /* ignore */ }
  process.exitCode = 1;
}