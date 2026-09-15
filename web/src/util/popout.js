// Module pop-out windows — a module in its own OS window.
//
// Gesture (dock only): hover a module's dock icon and scroll UP to open it in a
// new window, scroll DOWN to close that window. The same open action sits in the
// icon's right-click menu ("Open in New Window"). One window per module: a second
// scroll-up raises the one that already exists instead of spawning a twin.
//
// The popped-out window loads the SAME app at the module's routeBase, so it gets
// the full provider stack, sidebar and titlebar for free (App.jsx hides the Dock
// and suppresses the app-wide background helpers there — see isPopoutWindow).
//
// Identity is the WINDOW LABEL (`popout-<moduleId>`), never a URL flag: the hash
// router (router.js) matches `/tools/([^/]+)` with no query-string handling, so a
// `?popout=…` suffix would land inside route.sub and break the module's route.
//
// `window.open` is NOT an option — it returns null in WebView2 and creates no OS
// window (the old Library pop-out arrow died of exactly that).

import { getCurrentWindow, availableMonitors } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const PREFIX = 'popout-';
const DEFAULT_SIZE = { w: 1200, h: 800 };
const MIN = { w: 720, h: 480 };
const GESTURE_COOLDOWN_MS = 600;

const geomKey = (moduleId) => `popout:geom:${moduleId}`;

export function isPopoutWindow() {
  try { return getCurrentWindow().label.startsWith(PREFIX); } catch { return false; }
}

export function popoutModuleId() {
  try {
    const { label } = getCurrentWindow();
    return label.startsWith(PREFIX) ? label.slice(PREFIX.length) : null;
  } catch { return null; }
}

function readGeom(moduleId) {
  try {
    const g = JSON.parse(localStorage.getItem(geomKey(moduleId)) || 'null');
    return g && Number.isFinite(g.w) && Number.isFinite(g.h) ? g : null;
  } catch { return null; }
}

// A saved position is only good while the monitor it was saved on still exists —
// reopening at coordinates from an unplugged second screen puts the window where
// nobody can see it (and reads as "it won't open"). Drop x/y unless a chunk of
// the titlebar still lands on a live monitor; the window then centres itself.
// ponytail: one corner + a 120x40 titlebar bite is the whole test, not full
// rect intersection — enough to guarantee the window is grabbable.
async function clampToMonitors(g) {
  if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) return g;
  try {
    const monitors = await availableMonitors();
    const grabbable = monitors.some((m) => {
      const f = m.scaleFactor || 1;
      const x = m.position.x / f, y = m.position.y / f;
      const w = m.size.width / f, h = m.size.height / f;
      return g.x + 120 > x && g.x < x + w && g.y + 40 > y && g.y < y + h - 40;
    });
    return grabbable ? g : { w: g.w, h: g.h };
  } catch { return { w: g.w, h: g.h }; }
}

export async function openModulePopout(moduleId, routeBase, title) {
  if (!moduleId || !routeBase) return null;
  const label = PREFIX + moduleId;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.unminimize().catch(() => {});
    await existing.setFocus().catch(() => {});
    return existing;
  }
  const g = await clampToMonitors(readGeom(moduleId));
  const win = new WebviewWindow(label, {
    url: 'index.html#' + routeBase,
    title: title ? `${title} — Mortar & Pestle` : 'Mortar & Pestle',
    width: g?.w ?? DEFAULT_SIZE.w,
    height: g?.h ?? DEFAULT_SIZE.h,
    ...(Number.isFinite(g?.x) ? { x: g.x, y: g.y } : {}),
    minWidth: MIN.w,
    minHeight: MIN.h,
    decorations: false,   // the app's own TitleBar drives getCurrentWindow()
  });
  // A creation failure is silent otherwise — the commonest cause is the label
  // missing from the `popout-*` glob in capabilities/default.json.
  win.once('tauri://error', (e) => console.error('[popout] create failed', label, e));
  return win;
}

export async function closeModulePopout(moduleId) {
  const win = await WebviewWindow.getByLabel(PREFIX + moduleId);
  if (win) await win.close();
}

// One wheel gesture = one action. A single flick emits dozens of wheel events;
// without the cooldown the window opens and closes for the rest of the flick.
let lastGestureAt = 0;
export function popoutWheelGesture(e, { moduleId, routeBase, label }) {
  if (!moduleId || !routeBase || !e.deltaY) return;
  const now = performance.now();
  if (now - lastGestureAt < GESTURE_COOLDOWN_MS) return;
  lastGestureAt = now;
  if (e.deltaY < 0) openModulePopout(moduleId, routeBase, label);
  else closeModulePopout(moduleId);
}

// Called once inside a pop-out window: remembers where the user put it and how
// big they made it, per module. Same-origin localStorage, so the main window
// reads it back when reopening.
export function installPopoutGeometryMemory() {
  const moduleId = popoutModuleId();
  if (!moduleId) return undefined;
  const win = getCurrentWindow();
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const f = await win.scaleFactor();
        const p = (await win.outerPosition()).toLogical(f);
        const s = (await win.innerSize()).toLogical(f);
        localStorage.setItem(geomKey(moduleId), JSON.stringify({
          x: Math.round(p.x), y: Math.round(p.y),
          w: Math.round(s.width), h: Math.round(s.height),
        }));
      } catch { /* geometry memory is a convenience, never a hard failure */ }
    }, 400);
  };
  const unlisteners = [];
  win.onMoved(save).then((u) => unlisteners.push(u));
  win.onResized(save).then((u) => unlisteners.push(u));
  return () => { clearTimeout(timer); unlisteners.forEach((u) => u()); };
}
