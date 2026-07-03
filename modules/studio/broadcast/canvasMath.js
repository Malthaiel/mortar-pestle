// SP3 canvas math — THE one px↔canvas mapper (locked #4): hit-testing,
// snapping, and drop-positioning all route through here so webview px and
// engine canvas units can never drift apart. The preview region is an
// exact-fit CSS aspect box (the page background is the letterbox), so the
// mapping is a single linear scale — no letterbox math, no DPI (logical px
// on both sides of the ratio).
//
// Geometry ground truth is the engine-computed `corners` (canvas units,
// TL/TR/BR/BL via obs_sceneitem_get_box_transform) — hit-testing is generic
// point-in-quad, no OBS-derived math app-side (GPL boundary).

export const SNAP_SCREEN_PX = 10;
export const HANDLE_SCREEN_PX = 8;

export function scaleOf(rect, canvas) {
  return canvas.width / Math.max(1, rect.width);
}

export function toCanvas(clientX, clientY, rect, canvas) {
  const s = scaleOf(rect, canvas);
  return [(clientX - rect.left) * s, (clientY - rect.top) * s];
}

/// Point-in-quad via consistent cross-product signs (handles rotation).
export function pointInQuad(p, corners) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/// Topmost hit among top-level items (display order = topmost first).
/// Grouped children hit as their GROUP (v1: group is the preview unit).
export function hitTest(p, displayItems) {
  for (const it of displayItems) {
    if (!it.visible || it.locked) continue;
    if (pointInQuad(p, it.corners)) return it;
  }
  return null;
}

/// 8 handle centers for an item's corners: 4 corners + 4 edge midpoints,
/// index order [TL, TR, BR, BL, top, right, bottom, left].
export function handleCenters(corners) {
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [
    corners[0], corners[1], corners[2], corners[3],
    mid(corners[0], corners[1]),
    mid(corners[1], corners[2]),
    mid(corners[2], corners[3]),
    mid(corners[3], corners[0]),
  ];
}

/// Which handle (index into handleCenters) is under p, within radius hs.
export function handleAt(p, corners, hs) {
  const hc = handleCenters(corners);
  for (let i = 0; i < hc.length; i++) {
    if (Math.abs(p[0] - hc[i][0]) <= hs && Math.abs(p[1] - hc[i][1]) <= hs) return i;
  }
  return -1;
}

export function aabb(corners) {
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/// Snap a moved AABB to canvas edges + center (locked v1 targets), per axis
/// independently: smallest in-threshold correction wins its axis. Returns
/// { dx, dy, guides:[{axis,pos}] }.
export function snapMove(box, canvas, threshold) {
  const midX = (box.left + box.right) / 2;
  const midY = (box.top + box.bottom) / 2;
  const pick = (cands) => {
    let best = null;
    for (const c of cands) {
      if (Math.abs(c.d) <= threshold && (best == null || Math.abs(c.d) < Math.abs(best.d))) best = c;
    }
    return best;
  };
  const bx = pick([
    { d: 0 - box.left, g: 0 },
    { d: canvas.width - box.right, g: canvas.width },
    { d: canvas.width / 2 - midX, g: canvas.width / 2 },
  ]);
  const by = pick([
    { d: 0 - box.top, g: 0 },
    { d: canvas.height - box.bottom, g: canvas.height },
    { d: canvas.height / 2 - midY, g: canvas.height / 2 },
  ]);
  const guides = [];
  if (bx) guides.push({ axis: 'v', pos: bx.g });
  if (by) guides.push({ axis: 'h', pos: by.g });
  return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, guides };
}

/// Cursor per handle index (rot≈0 assumption — rotated items are move-only
/// on-preview, v1 ceiling).
export function handleCursor(i) {
  return ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'][i] || 'default';
}
