// SF11 — the editor's keyboard map, registered with the HOST keybind
// registry at module load (user decision 2026-06-10: editor binds must be
// visible + rebindable in Settings ▸ Keybinds). Tier safety is dynamic, not
// static: index.jsx calls registerModuleKeybinds() from register(api), so a
// core build (module absent) never sees these rows — no registry.js entries
// to leak. The keydown handler resolves bindings at EVENT time via
// getLiveKeybinds(), so a rebind in Settings applies instantly.
// J is stepped jump-back, not reverse shuttle — negative playbackRate is
// unsupported on WebKitGTK (SF1 spike).

import { matchChord } from '@host/keybinds/match.js';
import { getLiveKeybinds } from '@host/keybinds/registry.js';

// Module-local by host convention (App.jsx / SettingsDrawer / SidebarSeam
// each carry their own copy — it is deliberately not exported from the host).
export function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

const chord = (key, modifiers = []) => ({ kind: 'chord', key, modifiers });

// One row per action, one default per row (the registry model). The old
// hardcoded Backspace / Shift+ArrowLeft aliases are gone — hidden alternates
// would dodge the conflict detector; users rebind instead.
const DEFS = [
  { id: 'vedit.play-toggle',   label: 'Play / pause',            default: chord(' '),                     run: a => a.toggle() },
  { id: 'vedit.pause',         label: 'Pause',                   default: chord('k'),                     run: a => a.pause() },
  { id: 'vedit.speed-cycle',   label: 'Cycle playback speed',    default: chord('l'),                     run: a => a.rateUp() },
  { id: 'vedit.jump-back',     label: 'Jump back 1 second',      default: chord('j'),                     run: a => a.jumpBy(-1) },
  { id: 'vedit.jump-forward',  label: 'Jump forward 1 second',   default: chord('ArrowRight', ['shift']), run: a => a.jumpBy(1) },
  { id: 'vedit.step-back',     label: 'Step back 1 frame',       default: chord('ArrowLeft'),             run: a => a.step(-1) },
  { id: 'vedit.step-forward',  label: 'Step forward 1 frame',    default: chord('ArrowRight'),            run: a => a.step(1) },
  { id: 'vedit.blade',         label: 'Toggle blade mode',       default: chord('b'),                     run: a => a.blade() },
  { id: 'vedit.delete',        label: 'Delete selection',        default: chord('Delete'),                run: a => a.del(false) },
  { id: 'vedit.ripple-delete', label: 'Ripple delete selection', default: chord('Delete', ['shift']),     run: a => a.del(true) },
  { id: 'vedit.undo',          label: 'Undo edit',               default: chord('z', ['meta']),           run: a => a.undo() },
  { id: 'vedit.redo',          label: 'Redo edit',               default: chord('z', ['meta', 'shift']),  run: a => a.redo() },
  { id: 'vedit.save',          label: 'Save project',            default: chord('s', ['meta']),           run: a => a.save() },
  { id: 'vedit.go-start',      label: 'Go to start',             default: chord('Home'),                  run: a => a.home() },
  { id: 'vedit.go-end',        label: 'Go to end',               default: chord('End'),                   run: a => a.end() },
  { id: 'vedit.zoom-in',       label: 'Zoom timeline in',        default: chord('='),                     run: a => a.zoom(1) },
  { id: 'vedit.zoom-out',      label: 'Zoom timeline out',       default: chord('-'),                     run: a => a.zoom(-1) },
  { id: 'vedit.color-mode',    label: 'Toggle Color mode',       default: chord('c'),                     run: a => a.colorMode() },
  { id: 'vedit.grade-bypass',  label: 'Toggle grade bypass',     default: chord('d'),                     run: a => a.gradeBypass() },
  { id: 'vedit.copy-grade',    label: 'Copy grade',              default: chord('c', ['meta', 'shift']),  run: a => a.copyGrade() },
  { id: 'vedit.paste-grade',   label: 'Paste grade',             default: chord('v', ['meta', 'shift']),  run: a => a.pasteGrade() },
];

// Registry shape (no run fns) for registerModuleKeybinds in index.jsx.
export const VEDIT_KEYBIND_ENTRIES = DEFS.map(({ id, label, default: def }) => (
  { id, group: 'Video Editor', label, default: def }
));

export function makeEditorKeydown(actions) {
  return (e) => {
    if (isEditableTarget(e.target)) return;
    const kb = getLiveKeybinds();
    for (const d of DEFS) {
      if (matchChord(e, kb[d.id] ?? d.default)) {
        e.preventDefault();
        d.run(actions);
        return;
      }
    }
  };
}
