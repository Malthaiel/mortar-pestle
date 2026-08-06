# Launch the Tauri dev surface with devrun.log always captured.
#
# Close the Loop mandates that dev runs through a Tee-Object pipe, because
# devrun.log is where the `hmr update <file>` lines that prove a change landed
# are read from. Relying on whoever launches to remember the pipe failed twice
# on 2026-08-05 alone — the log silently froze hours behind the running
# processes both times, and nobody noticed until a closeout went looking for
# proof that was never written.
#
# ponytail: the pipe lives here rather than in a doc, because the doc already
# said it and was skipped anyway. Run `.\dev.ps1` instead of `npm run tauri dev`.

Set-Location $PSScriptRoot

# Overwrite rather than append: the log's job is to prove THIS run's HMR, and a
# growing multi-session log makes "is this line from the current window?"
# unanswerable — which is the exact failure it exists to prevent.
npm run tauri dev 2>&1 | Tee-Object -FilePath devrun.log
