#!/usr/bin/env node
// One-command verification baseline for mortar-pestle. Runs the Rust integration
// tests + the two bespoke web checks + a JS syntax gate, in sequence, exiting
// non-zero (naming the failure) if any step fails.
//
// HAZARD — Rust tests: NEVER run `cargo test --lib` OR `cargo test --tests`
// here. Cargo's `--tests` selects ALL test targets INCLUDING the library unit
// tests (~36 #[cfg(test)] mods) — the exact `--lib` surface that SIGTERMs the
// agent dev-sandbox (see the banners in src-tauri/tests/stt_roundtrip.rs and
// capture_roundtrip.rs). We enumerate the INTEGRATION targets explicitly with
// repeated `--test <name>` flags — the form the repo's own test-file run-hints
// document as safe — which never compiles or runs the lib unit tests.
// Re-including `--lib`/`--tests` is a separate follow-up (see the plan's
// Maintenance notes) that must first isolate the offending unit test.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// The coaching pipeline's pure-ESM harnesses. DISCOVERED, not enumerated: a new
// selftest joins the baseline by existing. (The hardcoded `files` list in the syntax
// step below is the cautionary counter-example — it has to be hand-grown, and these
// eight selftests sat outside `verify` entirely until 2026-07-20 for exactly that reason.)
const SELFTEST_DIR = 'modules/core/game-wiki';
const selftests = readdirSync(SELFTEST_DIR)
  .filter((f) => f.endsWith('.selftest.mjs'))
  .sort()
  .map((f) => `${SELFTEST_DIR}/${f}`);

// npm resolves to npm.cmd on Windows; spawnSync with shell:false won't find a
// bare `npm` there. Pick the platform binary explicitly (CI + dev are Windows).
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const steps = [
  {
    name: 'rust integration tests',
    cmd: 'cargo',
    args: [
      'test', '--manifest-path', 'src-tauri/Cargo.toml',
      '--test', 'integration',
      '--test', 'health_grammar',
      '--test', 'stt_roundtrip',
      '--test', 'capture_roundtrip',
      '--test', 'vault_io_sanity',
      '--test', 'recycle_bin',
      '--test', 'transcode_integration', // all #[ignore] → compiles, runs 0
    ],
  },
  { name: 'web: theme contrast (WCAG AA)', cmd: NPM, args: ['--prefix', 'web', 'run', 'check-themes'] },
  { name: 'web: drag math',                cmd: NPM, args: ['--prefix', 'web', 'run', 'check-drag'] },
  { name: 'web: planner time/frame math',  cmd: NPM, args: ['--prefix', 'web', 'run', 'check-time'] },
  { name: 'web: path marshalling',         cmd: NPM, args: ['--prefix', 'web', 'run', 'check-path'] },
  {
    name: 'game-wiki selftests',
    cmd: process.execPath, // node
    baseArgs: [],
    files: selftests,
  },
  {
    name: 'js syntax check (pure utils)',
    cmd: process.execPath, // node
    baseArgs: ['--check'],
    // JSX-free util modules only — `node --check` rejects JSX. Grow this list
    // as pure utils are added; a listed file that gains JSX must be removed
    // (it belongs to the vite-built surface, not this syntax gate).
    files: ['web/src/components/dragMath.js', 'web/src/themes/registry.js'],
  },
];

const failed = [];
for (const s of steps) {
  if (s.files) {
    for (const f of s.files) {
      console.log(`\n▶ ${s.name}: node --check ${f}`);
      const r = spawnSync(s.cmd, [...s.baseArgs, f], { stdio: 'inherit' });
      if (r.status !== 0) failed.push(`${s.name} (${f})`);
    }
  } else {
    console.log(`\n▶ ${s.name}: ${s.cmd} ${s.args.join(' ')}`);
    // npm.cmd is a batch file; recent Node refuses to spawn `.cmd`/`.bat` without
    // a shell (CVE-2024-27980 hardening). cargo/node resolve fine without one.
    const r = spawnSync(s.cmd, s.args, { stdio: 'inherit', shell: s.cmd === NPM });
    if (r.status !== 0) failed.push(s.name);
  }
}

if (failed.length) {
  console.error(`\n✗ verify FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\n✓ verify passed');
