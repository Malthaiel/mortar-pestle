# Regenerate src/bindings.rs from the vendored (pinned) libobs headers.
# Run ONLY when the OBS pin moves (fetch-obs.ps1 re-vendors headers first).
# Output is committed — builds never need bindgen/libclang.
$ErrorActionPreference = "Stop"
$crate   = Split-Path -Parent $PSScriptRoot
$vendor  = Join-Path $crate "vendor\obs-headers"
$wrapper = Join-Path $PSScriptRoot "bindings-wrapper.h"
$out     = Join-Path $crate "src\bindings.rs"

bindgen $wrapper -o $out `
    --allowlist-function "obs_.*" `
    --allowlist-function "base_set_log_handler" `
    --allowlist-function "base_get_log_handler" `
    --allowlist-function "blog" `
    --allowlist-type "obs_.*" `
    --allowlist-var "OBS_.*" `
    --allowlist-var "LIBOBS_.*" `
    --no-layout-tests `
    --raw-line "#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals, dead_code, improper_ctypes, clippy::all)]" `
    -- --target=x86_64-pc-windows-msvc -I $vendor
if ($LASTEXITCODE -ne 0) { throw "bindgen failed ($LASTEXITCODE)" }
$lines = (Get-Content $out | Measure-Object -Line).Lines
Write-Host "DONE: $out ($lines lines)"
