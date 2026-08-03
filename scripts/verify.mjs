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
const SELFTEST_DIRS = ['modules/core/game-wiki', 'modules/studio/broadcast'];
const selftests = SELFTEST_DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.selftest.mjs'))
    .sort()
    .map((f) => `${dir}/${f}`));

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
    ],
  },
  {
    // transcode_integration is COMPILE-ONLY on purpose. Every test in it is #[ignore]d (they shell
    // out to ffmpeg and run multi-second timing-sensitive workloads), so running it never executed
    // an assertion — its whole contribution here is "does it still compile and link".
    //
    // It also cannot be RUN on Windows any more: it is the one test target whose link graph reaches
    // TaskDialogIndirect (comctl32 v6, via app_lib::asset_protocol → tauri), and a `cargo test` exe
    // gets no SxS application manifest, so the loader binds it to the legacy comctl32 5.82 in
    // system32 — which exports SetWindowSubclass but NOT TaskDialogIndirect. The process dies at
    // LOAD with 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND before main runs. Proven 2026-07-24 by
    // dumpbin: the exe imports TaskDialogIndirect; system32 comctl32 is 5.82 and does not export it;
    // the passing test exes import no comctl32 at all. --no-run keeps every bit of coverage this
    // step ever had (compile + link) and drops only the load that can never succeed here.
    name: 'rust compile-only test target (transcode_integration)',
    cmd: 'cargo',
    args: ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--test', 'transcode_integration', '--no-run'],
  },
  { name: 'web: theme contrast (WCAG AA)', cmd: NPM, args: ['--prefix', 'web', 'run', 'check-themes'] },
  { name: 'web: drag math',                cmd: NPM, args: ['--prefix', 'web', 'run', 'check-drag'] },
  { name: 'web: planner time/frame math',  cmd: NPM, args: ['--prefix', 'web', 'run', 'check-time'] },
  { name: 'web: path marshalling',         cmd: NPM, args: ['--prefix', 'web', 'run', 'check-path'] },
  { name: 'web: availability busy math',   cmd: NPM, args: ['--prefix', 'web', 'run', 'check-busy'] },
  {
    name: 'module selftests',
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
