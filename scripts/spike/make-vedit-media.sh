#!/usr/bin/env bash
# Cuts NLE / Audio Post test fixtures — synthetic clips referenced by
# "Test Video Editor Project" (and friends) at /tmp/vedit-media/*. A reboot or
# tmp-cleanup wipes /tmp, so re-run this to restore them. Codecs/durations/fps
# match the project's stored media specs; the bin re-pin on project open
# re-probes hash + startTimeOffset, so exact byte-identity is not required.
# Distinct sine tones per clip make the audio swap audible. Low res + ultrafast
# presets keep the whole batch ~seconds. Safe to delete outputs.
set -uo pipefail

D="${1:-/tmp/vedit-media}"
mkdir -p "$D"
SZ=640x360

gen_av () { # $1 name  $2 ext  $3 rate  $4 dur  $5 freq  $6...: extra video/mux args
  local name="$1" ext="$2" rate="$3" dur="$4" freq="$5"; shift 5
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "testsrc2=size=$SZ:rate=$rate" \
    -f lavfi -i "sine=frequency=$freq:sample_rate=48000" \
    -t "$dur" -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$@" "$D/$name.$ext" \
    && echo "  $name.$ext ok" || echo "  $name.$ext FAIL"
}

gen_av a_h264_2397 mp4 24000/1001 30 220 -c:v libx264 -preset ultrafast -movflags +faststart
gen_av b_h264_30   mp4 30         25 330 -c:v libx264 -preset ultrafast -movflags +faststart
gen_av c_hevc      mp4 30         20 440 -c:v libx265 -preset ultrafast -tag:v hvc1 -movflags +faststart

# vp9/webm (opus audio), realtime to stay fast:
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "testsrc2=size=$SZ:rate=30" \
  -f lavfi -i "sine=frequency=550:sample_rate=48000" -t 15 -pix_fmt yuv420p \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 1M -c:a libopus -b:a 128k -shortest \
  "$D/d_vp9.webm" && echo "  d_vp9.webm ok" || echo "  d_vp9.webm FAIL"

# no-audio variant:
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "testsrc2=size=$SZ:rate=30" -t 15 \
  -pix_fmt yuv420p -c:v libx264 -preset ultrafast -an -movflags +faststart \
  "$D/e_noaudio.mp4" && echo "  e_noaudio.mp4 ok" || echo "  e_noaudio.mp4 FAIL"

# mpegts with a non-zero start PTS (exercises startTimeOffset):
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "testsrc2=size=$SZ:rate=30" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000" -t 15 -pix_fmt yuv420p \
  -c:v libx264 -preset ultrafast -c:a aac -b:a 128k -shortest -output_ts_offset 2.778667 -f mpegts \
  "$D/f_offset.ts" && echo "  f_offset.ts ok" || echo "  f_offset.ts FAIL"

echo "fixtures in $D:"; ls -1 "$D"
