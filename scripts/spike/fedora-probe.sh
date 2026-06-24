#!/usr/bin/env bash
# GPU & Codec Spike — stock-Fedora codec ground truth via throwaway container.
# No GPU inside the container: the h264_vaapi row demonstrates "listed != usable"
# by failing device init; on real stock hardware the failure mode is the mesa
# h264 strip instead. Spike artifact (Video Editor sub-plan 3).
set -uo pipefail

podman run --rm registry.fedoraproject.org/fedora:43 bash -c '
  set -u
  cat /etc/fedora-release
  echo "=== cisco/openh264 repo state (stock) ==="
  dnf -q repolist --all 2>/dev/null | grep -Ei "cisco|openh264" || echo "no cisco repo entry"
  echo "=== installing ffmpeg-free ==="
  dnf -q -y install ffmpeg-free >/dev/null 2>&1 && echo "ffmpeg-free installed" || { echo "ffmpeg-free INSTALL FAILED"; exit 1; }
  rpm -q ffmpeg-free libavcodec-free 2>&1
  echo "=== openh264 package state (noopenh264 = non-functional stub) ==="
  rpm -q openh264 noopenh264 libopenh264 2>&1
  ffmpeg -hide_banner -version | head -2
  echo "=== encoders (h264/vp9/av1/aac) ==="
  ffmpeg -hide_banner -encoders 2>/dev/null | grep -Ei "h264|vp9|av1|aac"
  echo "=== decoders (h264/hevc/vp9/av1) ==="
  ffmpeg -hide_banner -decoders 2>/dev/null | grep -Ei "(^| )(h264|hevc|vp9|av1|libdav1d|libopenh264)" | head -20
  echo "=== TEST ENCODES — listing != usable ==="
  for enc in libopenh264 libx264 libvpx-vp9 libsvtav1; do
    if ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x240:rate=30 \
         -t 1 -c:v "$enc" -f null - >/dev/null 2>&1; then
      echo "$enc: OK"
    else
      echo "$enc: FAILED"
    fi
  done
  ffmpeg -hide_banner -loglevel error -init_hw_device vaapi=v:/dev/dri/renderD128 \
    -f lavfi -i testsrc2=size=320x240:rate=30 -t 1 -vf format=nv12,hwupload \
    -c:v h264_vaapi -f null - >/dev/null 2>&1 && echo "h264_vaapi: OK" \
    || echo "h264_vaapi: init FAILED (no /dev/dri in container; on stock hw: mesa h264 strip)"
  echo "=== swap stub -> real cisco openh264, re-test ==="
  dnf -q -y --enablerepo=fedora-cisco-openh264 swap noopenh264 openh264 >/dev/null 2>&1 \
    && rpm -q openh264 \
    || echo "cisco swap FAILED (repo unreachable or stub not present)"
  if ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x240:rate=30 \
       -t 1 -c:v libopenh264 -f null - >/dev/null 2>&1; then
    echo "libopenh264 after swap: OK"
  else
    echo "libopenh264 after swap: FAILED"
  fi
'
