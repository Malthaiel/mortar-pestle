// Community Themes picker — the live preview-card grid in Settings →
// Appearance. Each card is a candy `tile` button rendering a mini-mock of the
// app's surfaces + text + accent in that theme. HOVERING a card live-applies
// the theme to the whole window after a short debounce (imperative paint, never
// touching the persisted blob); leaving the grid reverts to the committed
// theme; CLICKING commits via setSetting (the useSettings apply effect then
// repaints from persisted truth to the same DOM, so there's no flash).
//
// Preview state is component-local on purpose: a hover must not re-render the
// rest of the app or persist anything. The only things that change on hover are
// :root CSS vars (via the shared paintTheme/paintAccent helpers) and this
// component's own previewId (for the card ring).
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  THEMES, THEME_BY_ID, DEFAULT_THEME_ID, isCommunityTheme,
} from '../../themes/registry.js';
import { paintTheme, paintAccent } from '../../themes/applyTheme.js';
import { resolveActiveAccent } from '../../hooks/useSettings.js';
import { candyGap } from '../../util/candy.js';

const PREVIEW_DELAY = 120;

export default function ThemePicker({ settings, setSetting, setPreviewAccent, resolvedTheme }) {
  const committedId = settings.themePreset || DEFAULT_THEME_ID;
  // True committed accent, independent of any live hover preview (resolveActiveAccent
  // reads themeAccent/themePreset, which preview never mutates) — a stable revert
  // target even while settings.accentColor is showing the preview value.
  const committedAccent = resolveActiveAccent(settings);
  const timerRef = useRef(null);
  const [previewId, setPreviewId] = useState(null);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  // Repaint the committed theme + accent — the revert target. Reads from props
  // (committed truth), never a captured snapshot.
  const repaintCommitted = useCallback(() => {
    const root = document.documentElement;
    paintTheme(root, THEME_BY_ID[committedId] || THEME_BY_ID[DEFAULT_THEME_ID], resolvedTheme);
    paintAccent(root, committedAccent);   // CSS var(--accent) consumers
    setPreviewAccent(null);               // JS-prop consumers → back to committed
  }, [committedId, committedAccent, resolvedTheme, setPreviewAccent]);

  const onEnter = (id) => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      const root = document.documentElement;
      const t = THEME_BY_ID[id];
      // Preview always shows the theme's signature accent — that's what you're
      // evaluating. Monastic now carries its own defaultAccent (red), so every
      // card previews a real accent.
      const a = (t && t.defaultAccent) || committedAccent;
      paintTheme(root, t, resolvedTheme);
      paintAccent(root, a);        // CSS var(--accent) consumers
      setPreviewAccent(a);         // JS-prop accent consumers (whole app tree)
      setPreviewId(id);
    }, PREVIEW_DELAY);
  };

  const onLeaveGrid = () => {
    clearTimer();
    if (previewId != null) { repaintCommitted(); setPreviewId(null); }
  };

  const onPick = (id) => {
    clearTimer();
    setPreviewId(null);
    const target = isCommunityTheme(id) ? id : DEFAULT_THEME_ID;
    const switching = target !== committedId;
    // Accent the commit will land on: a theme switch re-seeds to the theme's
    // default (useSettings); re-clicking the active theme keeps the current
    // (possibly overridden) accent.
    const nextAccent = switching ? (THEME_BY_ID[target]?.defaultAccent || committedAccent) : committedAccent;
    const root = document.documentElement;
    paintTheme(root, THEME_BY_ID[target] || THEME_BY_ID[DEFAULT_THEME_ID], resolvedTheme);
    paintAccent(root, nextAccent);     // CSS var(--accent) consumers → final state now
    setPreviewAccent(nextAccent);      // JS-prop consumers → bridge until committed catches up
    setSetting('themePreset', target); // persists; apply effect repaints to the same DOM (no flash)
  };

  // Revert + clear on unmount only (drawer close mid-hover). A ref keeps the
  // cleanup pointed at the latest repaintCommitted without re-running on every
  // commit (which would flash the OLD committed theme).
  const repaintRef = useRef(repaintCommitted);
  repaintRef.current = repaintCommitted;
  useEffect(() => () => { clearTimer(); repaintRef.current(); }, []);

  return (
    <div
      onMouseLeave={onLeaveGrid}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))',
        columnGap: 12,
        rowGap: candyGap(12),
        // The candy `tile` band hangs below each card outside layout flow;
        // pad the bottom so the last row clears the container edge.
        paddingBottom: candyGap(10),
        width: '100%',
      }}
    >
      {THEMES.map(t => (
        <ThemeCard
          key={t.id}
          theme={t}
          resolvedTheme={resolvedTheme}
          committedAccent={committedAccent}
          onEnter={() => onEnter(t.id)}
          onPick={() => onPick(t.id)}
        />
      ))}
    </div>
  );
}

function ThemeCard({ theme, resolvedTheme, committedAccent, onEnter, onPick }) {
  const sw = theme.swatches[resolvedTheme] || theme.swatches.light;
  const cardAccent = theme.defaultAccent || committedAccent;
  // All-span markup (no <div> inside <button>): the mock chips are spans styled
  // as blocks/flex. The tile shape flips :where(div,span) text to white on
  // hover/active — harmless for the background-only chips. The selected-state
  // accent highlight is intentionally omitted (no is-selected): a dedicated
  // "which theme is active" indicator is planned as a separate piece of work.
  return (
    <button
      type="button"
      data-own-press
      className="candy-btn"
      data-shape="tile"
      title={`${theme.name} theme`}
      onMouseEnter={onEnter}
      onClick={onPick}
      style={{ '--accent': cardAccent }}
    >
      <span className="candy-face">
        <span style={{
          display: 'block', borderRadius: 6, overflow: 'hidden',
          background: sw.bg, padding: 6, border: `1px solid ${sw.border}`,
        }}>
          <span style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            background: sw.surface, border: `1px solid ${sw.border}`,
            borderRadius: 4, padding: '7px 8px',
          }}>
            <span style={{ display: 'block', height: 4, width: '62%', background: sw.text, borderRadius: 2 }} />
            <span style={{ display: 'block', height: 4, width: '44%', background: sw.textMuted, borderRadius: 2 }} />
            <span style={{ display: 'block', height: 7, width: 22, background: sw.accent, borderRadius: 3, marginTop: 3 }} />
          </span>
        </span>
        <span style={{ display: 'block', marginTop: 7, fontSize: 12, fontWeight: 600 }}>{theme.name}</span>
      </span>
    </button>
  );
}
