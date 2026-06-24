#!/usr/bin/env bash
# GPU & Codec Spike encode-speed pass — wall-clock 10 s encodes to -f null -.
# Input H.264 decode cost is included DELIBERATELY: the editor's export pipeline
# also decodes its sources, so rows are comparable end-to-end, not encoder-only.
# Spike artifact (Video Editor sub-plan 3). Output: markdown table on stdout.
set -uo pipefail

DIR="${1:-$HOME/.local/share/dev.judeau.agentic-os/Library/Studio/Spike Fixtures}"
F1080="$DIR/spike-1080p30.mp4"
F4K="$DIR/spike-4k24.mp4"

# VAAPI device: AMD Raphael iGPU. By-path verified on this box:
#   pci-0000:01:00.0 -> renderD128 (NVIDIA RTX 4080 SUPER — VAAPI dead on NVIDIA)
#   pci-0000:11:00.0 -> renderD129 (AMD Raphael — the usable VAAPI node)
AMD_NODE="/dev/dri/renderD129"

echo "## Encode-speed pass — $(date '+%Y-%m-%d %H:%M')"
echo
echo "Host: $(uname -r) · $(ffmpeg -hide_banner -version 2>/dev/null | head -1)"
echo '```'
ls -l /dev/dri/by-path 2>/dev/null
echo '```'
echo
echo "| input | encoder / settings | wall s | fps | × realtime |"
echo "|---|---|---|---|---|"

row () { # $1 label  $2 input  $3 frames  $4... ffmpeg output args (before -f null)
  local label="$1" input="$2" frames="$3"; shift 3
  local t0 t1 wall fps rt err
  t0=$(date +%s.%N)
  err=$(ffmpeg -hide_banner -loglevel error -nostats -y -i "$input" -t 10 -an "$@" -f null - 2>&1)
  local rc=$?
  t1=$(date +%s.%N)
  if [ $rc -ne 0 ]; then
    echo "| $label | FAILED: $(echo "$err" | tail -1 | cut -c1-90) | — | — | — |"
    return
  fi
  wall=$(echo "$t1 $t0" | awk '{printf "%.2f", $1-$2}')
  fps=$(echo "$frames $wall" | awk '{printf "%.1f", $1/$2}')
  rt=$(echo "$frames $wall" | awk '{printf "%.1fx", ($1/$2)/30}')
  echo "| $label | ok | $wall | $fps | $rt |"
}

vrow () { # VAAPI needs -init_hw_device BEFORE -i (global option)
  local label="$1" input="$2" frames="$3" bitrate="$4"
  local t0 t1 wall fps err
  t0=$(date +%s.%N)
  err=$(ffmpeg -hide_banner -loglevel error -nostats -y \
        -init_hw_device "vaapi=amd:$AMD_NODE" -filter_hw_device amd \
        -i "$input" -t 10 -an -vf format=nv12,hwupload -c:v h264_vaapi -b:v "$bitrate" \
        -f null - 2>&1)
  local rc=$?
  t1=$(date +%s.%N)
  if [ $rc -ne 0 ]; then
    echo "| $label | FAILED: $(echo "$err" | tail -1 | cut -c1-90) | — | — | — |"
    return
  fi
  wall=$(echo "$t1 $t0" | awk '{printf "%.2f", $1-$2}')
  fps=$(echo "$frames $wall" | awk '{printf "%.1f", $1/$2}')
  echo "| $label | ok | $wall | $fps | $(echo "$frames $wall" | awk '{printf "%.1fx", ($1/$2)/30}') |"
}

# --- 1080p30 rows (300 frames in 10 s) ---
row "1080p30 · libx264 medium 8M"    "$F1080" 300 -c:v libx264 -preset medium   -b:v 8M
row "1080p30 · libx264 veryfast 8M"  "$F1080" 300 -c:v libx264 -preset veryfast -b:v 8M
row "1080p30 · libopenh264 8M"       "$F1080" 300 -c:v libopenh264 -b:v 8M
vrow "1080p30 · h264_vaapi 8M (AMD)" "$F1080" 300 8M
row "1080p30 · h264_nvenc p4 8M"     "$F1080" 300 -c:v h264_nvenc -preset p4 -b:v 8M
row "1080p30 · libvpx-vp9 4M"        "$F1080" 300 -c:v libvpx-vp9 -b:v 4M -row-mt 1 -cpu-used 4
row "1080p30 · libsvtav1 preset8"    "$F1080" 300 -c:v libsvtav1 -preset 8 -crf 35

# --- 4K24 rows (240 frames in 10 s), chain finalists + hw informational ---
row "4K24 · libx264 veryfast 24M"    "$F4K" 240 -c:v libx264 -preset veryfast -b:v 24M
vrow "4K24 · h264_vaapi 24M (AMD)"   "$F4K" 240 24M
row "4K24 · h264_nvenc p4 24M"       "$F4K" 240 -c:v h264_nvenc -preset p4 -b:v 24M

echo
echo "(fps = frames / wall; × realtime normalized to 30 fps content)"
