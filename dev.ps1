# Launch the Tauri dev surface with devrun.log always captured.
#
# Close the Loop mandates that dev runs through a Tee-Object pipe, because
# devrun.log is where the `hmr update <file>` lines that prove a change landed
# are read from. Relying on whoever launches to remember the pipe failed twice
# on 2026-08-05 alone — the log silently froze hours behind the running
# processes both times, and nobody noticed until a closeout went looking for
# proof that was never written.
#
# SUPERSEDED 2026-08-08: this launcher was ALSO skipped, three more times. The
# tee now lives in `scripts/devlog.mjs`, which every npm script routes through,
# so the plain `npm run tauri dev` that everyone actually types writes the log
# on its own. This file is kept only so existing muscle memory still works, and
# it deliberately does no logging of its own — one tee, one place to change.

Set-Location $PSScriptRoot
npm run dev
