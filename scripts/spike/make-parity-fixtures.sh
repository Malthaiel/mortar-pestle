#!/usr/bin/env bash
# Color Grading SF5 — parity-battery fixtures (3 × 6 s, static chart + 440 Hz
# AAC):
#   parity-bt709-1080.mp4    1920×1080, pixels converted AND tagged bt709/tv
#   parity-bt601-sd.mp4      720×480,  pixels converted AND tagged smpte170m/tv
#   parity-untagged-1080.mp4 1920×1080, swscale-default pixels, NO color tags
#
# Content is a STATIC SMOOTH chart (geq, no N/T term):
#   top third     neutral luma ramp        (CDL / curves / range errors)
#   middle third  smooth saturated rainbow (matrix + hue-vs-sat errors)
#   bottom third  smooth RGB field         (LUT lattice interpolation)
# Why not testsrc2: the first battery run (2026-06-11) failed ALL 18 cells
# with the edge-noise signature (mean ~2, p99 20–50, max 255) — testsrc2 is
# wall-to-wall hard color edges and animation, so WebKit's GPU YUV→RGB and
# swscale legitimately disagree along every edge (chroma upsampling), and any
# frame misalignment adds motion deltas. Neither is what the battery tests.
# Smooth + static content keeps matrix/grade-math errors loud (broad-area
# shifts caught by mean) while the decoder noise floor stays in the LSBs.
# The untagged fixture proves the shared HD heuristic: both pipelines must
# assume bt709 and agree — wrong-but-consistent is a parity PASS by design.
# setparams pins frame-level props (the VUI source — argv tags alone lose to
# frame properties, the SF4 finding).
set -euo pipefail
OUT="${1:-/tmp}"

CHART="format=gbrp,geq=r='if(lt(Y,H/3), 255*X/W, if(lt(Y,2*H/3), 255*abs(sin(PI*X/W)), 255*X/W))':g='if(lt(Y,H/3), 255*X/W, if(lt(Y,2*H/3), 255*abs(sin(PI*X/W+PI/3)), 255*(1-X/W)))':b='if(lt(Y,H/3), 255*X/W, if(lt(Y,2*H/3), 255*abs(sin(PI*X/W+2*PI/3)), 255*Y/H))'"

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:size=1920x1080:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
  -vf "$CHART,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv" \
  -c:v libx264 -preset veryfast -crf 18 -g 30 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 128k -shortest "$OUT/parity-bt709-1080.mp4"

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:size=720x480:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
  -vf "$CHART,scale=out_color_matrix=bt601:out_range=tv,format=yuv420p,setparams=colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m:range=tv" \
  -c:v libx264 -preset veryfast -crf 18 -g 30 \
  -colorspace smpte170m -color_primaries smpte170m -color_trc smpte170m -color_range tv \
  -c:a aac -b:a 128k -shortest "$OUT/parity-bt601-sd.mp4"

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:size=1920x1080:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
  -vf "$CHART,format=yuv420p" \
  -c:v libx264 -preset veryfast -crf 18 -g 30 \
  -c:a aac -b:a 128k -shortest "$OUT/parity-untagged-1080.mp4"

echo "fixtures written to $OUT:"
for f in parity-bt709-1080 parity-bt601-sd parity-untagged-1080; do
  echo "— $f: $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,color_space,color_range -of csv=p=0 "$OUT/$f.mp4")"
done
