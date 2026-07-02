// Slim overlay-scrim controller: picks WHICH scrim the overlay edits. The full
// editor is ScrimViewer (rendered by ScrimOverlayPanel in `overlay` mode), which
// owns ALL saving, the Rust live-target, and dictation/screenshot capture. This
// hook only loads the scrim list, tracks the selected scrim path (persisted so the
// overlay reopens where it was left), and creates a new scrim. Cross-window-safe:
// plain Tauri-backed api + the shared schema; nothing React-context-bound, so it
// runs in the provider-less overlay host.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { newScrimContent } from '@modules/core/game-wiki/scrimSchema.js';

const SCRIM_DIR = 'Deadlock/Coaching/Scrim';
const SEL_KEY = 'overlay-scrim-selected';

export function useScrimOverlay() {
  const [scrims, setScrims] = useState([]);
  const [selectedPath, setSelectedPath] = useState(() => {
    try { return localStorage.getItem(SEL_KEY) || null; } catch { return null; }
  });

  const load = useCallback(() => {
    api.getVaultFolder('Deadlock', 'Coaching/Scrim', 'gamewiki')
      .then((res) => {
        const pages = (res?.pages || [])
          .map((p) => { const full = (p.path || '').replace(/^\/+/, '').replace(/\.md$/, ''); return { path: `${full}.md`, base: full.split('/').pop() }; })
          .sort((a, b) => b.base.localeCompare(a.base)); // date-prefixed → newest first
        setScrims(pages);
      })
      .catch(() => setScrims([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const selectScrim = useCallback((p) => {
    setSelectedPath(p || null);
    try { if (p) localStorage.setItem(SEL_KEY, p); else localStorage.removeItem(SEL_KEY); } catch { /* quota / private mode */ }
  }, []);

  const closeScrim = useCallback(() => selectScrim(null), [selectScrim]);

  // Create + open a new scrim. Reuses newScrimContent (shared with ScrimListLanding);
  // dedups the filename against the loaded list. mtime 0 = create.
  const createScrim = useCallback(async (team1, team2) => {
    const { base, content } = newScrimContent({ team1, team2 });
    const bases = new Set(scrims.map((s) => s.base));
    let uniq = base;
    if (bases.has(uniq)) { let n = 2; while (bases.has(`${base} (${n})`)) n++; uniq = `${base} (${n})`; }
    const path = `${SCRIM_DIR}/${uniq}.md`;
    await api.savePage(path, content, 0, 'gamewiki');
    load();
    selectScrim(path);
    return path;
  }, [scrims, load, selectScrim]);

  return { scrims, selectedPath, selectScrim, closeScrim, createScrim };
}
