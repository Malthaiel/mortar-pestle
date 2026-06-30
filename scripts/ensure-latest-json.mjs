#!/usr/bin/env node
// ensure-latest-json.mjs — guarantee the v* GitHub Release carries an updater
// `latest.json`. tauri-action skips updater-JSON generation when the bundle
// name contains spaces / `&` (productName "Mortar & Pestle" →
// "Signature not found for the updater JSON. Skipping upload"). This rebuilds
// latest.json from the published `<name>-setup.exe` + `<name>-setup.exe.sig`
// (the .sig IS the minisign signature, made with the same key the in-app
// pubkey trusts) and uploads it. Idempotent: no-op if latest.json is already
// attached — harmless once/if tauri-action handles the name itself.
//
// Run as a workflow step AFTER tauri-action. Env (all auto-provided by Actions
// except the token, which is passed explicitly):
//   GITHUB_TOKEN       repo-scoped token (contents: write)
//   GITHUB_REPOSITORY  owner/repo
//   GITHUB_REF_NAME    the v* tag
// Node 20+ (global fetch). Zero-dep.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY; // owner/repo
const tag = process.env.GITHUB_REF_NAME;    // v0.8.2

const api = `https://api.github.com/repos/${repo}`;
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function gh(url, opts = {}) {
  const res = await fetch(url.startsWith('http') ? url : `${api}${url}`, {
    ...opts,
    headers: { ...H, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url} → HTTP ${res.status}`);
  return res;
}

async function run() {
  if (!token || !repo || !tag) {
    throw new Error('missing GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_REF_NAME');
  }

  // version source-of-truth (sync-versions keeps these aligned)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const conf = JSON.parse(readFileSync(join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const version = conf.version;

  const rel = await (await gh(`/releases/tags/${tag}`)).json();
  const assets = rel.assets || [];

  if (assets.some((a) => a.name === 'latest.json')) {
    console.log('[ensure-latest-json] latest.json already present — skipping');
    return;
  }

  const exe = assets.find((a) => /-setup\.exe$/.test(a.name));
  const sig = exe && assets.find((a) => a.name === `${exe.name}.sig`);
  if (!exe || !sig) {
    throw new Error(`missing setup.exe + .sig among: ${assets.map((a) => a.name).join(', ') || '(none)'}`);
  }

  // .sig asset body = the minisign signature text
  const signature = (await (await gh(sig.browser_download_url, {
    headers: { Accept: 'application/octet-stream' },
  })).text()).trim();

  const platform = { signature, url: exe.browser_download_url };
  const doc = {
    version,
    notes: rel.body || `${repo.split('/')[1]} ${tag}.`,
    pub_date: rel.published_at || null,
    platforms: {
      'windows-x86_64': platform,
      'windows-x86_64-nsis': { ...platform },
    },
  };

  const upload = `https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=latest.json`;
  const up = await gh(upload, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc, null, 2),
  });
  console.log(`[ensure-latest-json] uploaded latest.json (HTTP ${up.status}) for ${tag} v${version}`);
}

run().catch((e) => {
  console.error('[ensure-latest-json]', e.message);
  process.exitCode = 1;
});
