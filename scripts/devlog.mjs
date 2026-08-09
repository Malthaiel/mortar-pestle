// Run the Tauri CLI with `dev` output always teed into devrun.log.
//
// devrun.log is where the `hmr update <file>` lines that prove a change landed
// are read from. Two prior fixes put the pipe in a DOC (Close the Loop) and
// then in a LAUNCHER (dev.ps1); both were skipped at launch time, and the log
// silently froze hours behind the running processes on 2026-08-05, 08-06 and
// 08-07. The pipe only sticks if it lives in the command people actually type,
// which is `npm run tauri dev` — so it lives here.
//
// Raw bytes are forwarded through, so the log is UTF-8 like the console.
// PowerShell's Tee-Object wrote UTF-16, which made the log awkward to grep.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

// Run the CLI's real entrypoint under this same node, rather than the
// node_modules/.bin shim. Bare `tauri` only resolves when npm injects
// node_modules/.bin (a direct `node scripts/devlog.mjs` died with "'tauri' is
// not recognized"), and going through a shell to reach the .cmd shim trips
// node's DEP0190 unescaped-args warning. This needs neither.
const cli = join(repo, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

const args = process.argv.slice(2);

// ponytail: only `dev` gets a log. It is the only run whose output is read back
// as proof; teeing `build` would just churn the file. Truncate rather than
// append — a multi-session log makes "is this line from the current window?"
// unanswerable, which is the exact failure the log exists to prevent.
const log = args[0] === 'dev' ? createWriteStream(join(repo, 'devrun.log')) : null;

const child = spawn(process.execPath, [cli, ...args], { stdio: ['inherit', 'pipe', 'pipe'], cwd: repo });

for (const [src, dst] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  src.on('data', (chunk) => {
    dst.write(chunk);
    if (log) log.write(chunk);
  });
}

child.on('error', (err) => {
  process.stderr.write(`[devlog] failed to start tauri: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (log) log.end();
  process.exit(code ?? (signal ? 1 : 0));
});
