#!/usr/bin/env bash
# GPU & Codec Spike fixtures — synthetic, deterministic, entropy-bearing.
# Spike artifact (Video Editor sub-plan 3). Regenerable; safe to delete outputs.
# Output: <Library vault>/Studio/Spike Fixtures/spike-{1080p30,4k24}.{mp4,h264}
set -euo pipefail

OUT="${1:-$HOME/.local/share/dev.judeau.agentic-os/Library/Studio/Spike Fixtures}"
mkdir -p "$OUT"

gen () { # $1 size  $2 rate  $3 keyint  $4 bitrate  $5 maxrate  $6 bufsize  $7 name
  echo "=== generating $7 ($1 @ $2fps, GOP $3) ==="
  ffmpeg -hide_banner -loglevel warning -y -f lavfi \
    -i "testsrc2=size=$1:rate=$2,noise=alls=12:allf=t+u,format=yuv420p" \
    -t 45 -an -c:v libx264 -preset veryfast -pix_fmt yuv420p \
    -b:v "$4" -maxrate "$5" -bufsize "$6" \
    -x264-params "keyint=$3:min-keyint=$3:scenecut=0:aud=1" \
    -movflags +faststart "$OUT/$7.mp4"
  # Annex-B elementary-stream sibling for the WebCodecs bench (~12.5 s).
  ffmpeg -hide_banner -loglevel warning -y -i "$OUT/$7.mp4" -t 12.5 -an -c:v copy \
    -bsf:v h264_mp4toannexb -f h264 "$OUT/$7.h264"
}

gen 1920x1080 30 150  8M 10M 16M spike-1080p30
gen 3840x2160 24 120 24M 30M 48M spike-4k24

echo "=== ffprobe sanity ==="
for f in "$OUT/spike-1080p30.mp4" "$OUT/spike-4k24.mp4"; do
  echo "$f:"
  ffprobe -hide_banner -loglevel error -select_streams v:0 \
    -show_entries "stream=codec_name,profile,level,width,height,r_frame_rate,pix_fmt" \
    -of compact "$f"
done
ls -lh "$OUT"
