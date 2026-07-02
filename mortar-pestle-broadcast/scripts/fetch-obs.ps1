# SF0a — fetch + stage the pinned OBS runtime and produce link artifacts.
#
# Downloads the official (signed) OBS Windows x64 release zip + Sources tarball,
# stages the runtime payload at <crate>/obs/, vendors the libobs headers at
# <crate>/vendor/obs-headers/, and generates an import library from obs.dll's
# export table (dumpbin -> .def -> lib.exe). Zero OBS compile.
#
# Re-runnable: downloads cache in <crate>/obs-cache/; staging dirs are rebuilt.
param(
    [string]$Tag = "32.1.2"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$crate   = Split-Path -Parent $PSScriptRoot
$cache   = Join-Path $crate "obs-cache"
$payload = Join-Path $crate "obs"
$vendor  = Join-Path $crate "vendor\obs-headers"

$zipName = "OBS-Studio-$Tag-Windows-x64.zip"
$srcName = "OBS-Studio-$Tag-Sources.tar.gz"
$base    = "https://github.com/obsproject/obs-studio/releases/download/$Tag"

New-Item -ItemType Directory -Force $cache | Out-Null

foreach ($n in @($zipName, $srcName)) {
    $dest = Join-Path $cache $n
    if (-not (Test-Path $dest)) {
        Write-Host "downloading $n ..."
        Invoke-WebRequest "$base/$n" -OutFile $dest
    } else {
        Write-Host "cached $n"
    }
}

# --- stage runtime payload -------------------------------------------------
if (Test-Path $payload) { Remove-Item -Recurse -Force $payload }
$tmp = Join-Path $cache "zip-extract"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Write-Host "extracting $zipName ..."
Expand-Archive (Join-Path $cache $zipName) -DestinationPath $tmp
# zip may extract flat (bin/, data/, obs-plugins/) or under one top-level dir
$root = $tmp
if (-not (Test-Path (Join-Path $root "bin"))) {
    $root = (Get-ChildItem $root -Directory | Select-Object -First 1).FullName
}
New-Item -ItemType Directory -Force $payload | Out-Null
foreach ($d in @("bin", "obs-plugins", "data")) {
    if (-not (Test-Path (Join-Path $root $d))) { throw "zip layout missing $d under $root" }
    Move-Item (Join-Path $root $d) (Join-Path $payload $d)
}
Remove-Item -Recurse -Force $tmp

# --- vendor libobs headers ---------------------------------------------------
if (Test-Path $vendor) { Remove-Item -Recurse -Force $vendor }
$srcTmp = Join-Path $cache "src-extract"
if (Test-Path $srcTmp) { Remove-Item -Recurse -Force $srcTmp }
New-Item -ItemType Directory -Force $srcTmp | Out-Null
Write-Host "extracting $srcName (libobs subtree only - full tree has symlinks Windows tar can't create) ..."
tar -xzf (Join-Path $cache $srcName) -C $srcTmp "*/libobs/*"
if ($LASTEXITCODE -ne 0) { throw "tar extract failed ($LASTEXITCODE)" }
$topDir = (Get-ChildItem $srcTmp -Directory | Select-Object -First 1).FullName
$libobsSrc = Join-Path $topDir "libobs"
if (-not (Test-Path $libobsSrc)) { throw "libobs/ not found under $topDir" }
Get-ChildItem $libobsSrc -Recurse -Filter *.h | ForEach-Object {
    $rel   = $_.FullName.Substring($libobsSrc.Length + 1)
    $destH = Join-Path $vendor $rel
    New-Item -ItemType Directory -Force (Split-Path -Parent $destH) | Out-Null
    Copy-Item $_.FullName $destH
}
Remove-Item -Recurse -Force $srcTmp

# obsconfig.h is CMake-generated (absent from the tarball; obs-config.h hard-includes it).
# Synthesize the Windows values from libobs/obsconfig.h.in — bindgen-time only.
@(
    "/* Synthesized by scripts/fetch-obs.ps1 - obsconfig.h is CMake-generated and",
    " * absent from the source tarball. Values mirror the official OBS Windows",
    " * build (libobs/obsconfig.h.in, tag $Tag); Linux-only feature defines",
    " * intentionally omitted. Only used at bindgen time - obs.dll carries its own",
    " * compiled-in values at runtime. */",
    "#pragma once",
    "",
    "#define OBS_DATA_PATH `"../../data`"",
    "#define OBS_PLUGIN_PATH `"../../obs-plugins/64bit`"",
    "#define OBS_PLUGIN_DESTINATION `"obs-plugins/64bit`"",
    "",
    "#define OBS_RELEASE_CANDIDATE 0",
    "#define OBS_BETA 0"
) | Set-Content (Join-Path $vendor "obsconfig.h") -Encoding ascii
$headerCount = (Get-ChildItem $vendor -Recurse -Filter *.h | Measure-Object).Count

# --- generate import library from obs.dll exports ---------------------------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found - VS Build Tools required" }
$vcRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$dumpbin = Get-ChildItem "$vcRoot\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" |
    Sort-Object FullName -Descending | Select-Object -First 1
if ($null -eq $dumpbin) { throw "dumpbin.exe not found under $vcRoot" }
$libexe = Join-Path (Split-Path $dumpbin.FullName) "lib.exe"

$obsDll = Join-Path $payload "bin\64bit\obs.dll"
$libDir = Join-Path $payload "lib"
New-Item -ItemType Directory -Force $libDir | Out-Null
$names = & $dumpbin.FullName /exports $obsDll | ForEach-Object {
    if ($_ -match "^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]{8}\s+(\S+)") { $Matches[1] }
} | Where-Object { $_ }
if ($names.Count -lt 100) { throw "suspiciously few exports parsed ($($names.Count))" }
$defPath = Join-Path $libDir "obs.def"
@("LIBRARY obs.dll", "EXPORTS") + $names | Set-Content $defPath -Encoding ascii
& $libexe /nologo /machine:x64 "/def:$defPath" ("/out:" + (Join-Path $libDir "obs.lib"))
if ($LASTEXITCODE -ne 0) { throw "lib.exe failed ($LASTEXITCODE)" }

# --- pin manifest ------------------------------------------------------------
$zipHash = (Get-FileHash (Join-Path $cache $zipName) -Algorithm SHA256).Hash
$srcHash = (Get-FileHash (Join-Path $cache $srcName) -Algorithm SHA256).Hash
@(
    "tag: $Tag",
    "zip: $zipName sha256=$zipHash",
    "sources: $srcName sha256=$srcHash",
    "exports: $($names.Count)",
    "headers: $headerCount",
    "layout: bin/64bit (obs.dll + deps, SIGNED - ship unmodified), obs-plugins/64bit, data/, lib/ (generated obs.lib + obs.def - link-time only, never shipped)",
    "generated-by: scripts/fetch-obs.ps1"
) | Set-Content (Join-Path $payload "PINNED.txt") -Encoding ascii

Write-Host "DONE tag=$Tag exports=$($names.Count) headers=$headerCount"
Write-Host "payload: $payload"
Write-Host "vendor:  $vendor"
