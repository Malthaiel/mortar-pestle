// The Downloads popup — an anchored popover above the Downloads dock button
// (mirrors NotificationPanel). Renders through the shared Popover template:
// candy floating surface, anchored to the [data-downloads-btn] rect via
// useAnchoredRect (falls back to centered-above-dock if the dock collapsed it
// away); Esc + click-outside close (the dock button is exempt so it toggles).
// Two sections: Active (in-flight, progress bars) on top, Recent (finished/
// failed, deduped from persisted history) below — flat across music, video, and
// voice-model (STT) sources with a per-row source glyph. Row actions: Cancel
// (active); Open / Reveal (done); Retry (failed/cancelled); Clear (recent).
// Monitor-only — downloads are still started from the Library module or Settings
// → Voice.

import { useAllDownloads } from './DownloadsProvider.jsx';
import { Popover, useAnchoredRect, OutlinedBtn } from '../components/ui';
import { IconX, IconMusic, IconFilm, IconMic, IconExternal, IconFolder, IconRotateCw, IconMaximize } from '../components/icons.jsx';
import { timeAgo } from '../util/time.js';

const PANEL_W = 360;
const GREEN = '#6fb56f';
const RED = '#e07b7b';

function rowColor(r) {
  if (r.state === 'error') return RED;
  if (r.state === 'done') return r.failedCount ? RED : GREEN;
  if (r.state === 'cancelled') return 'var(--text-muted)';
  return GREEN;
}

const sectionLabel = {
  fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
  textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
  padding: '8px 8px 4px',
};
const titleRow = { display: 'flex', alignItems: 'baseline', gap: 8 };
const titleText = {
  flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const subText = {
  fontSize: 11, color: 'var(--text-muted)', marginTop: 1,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const iconBtn = {
  flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--text-faint)', padding: 3, display: 'flex', lineHeight: 1, borderRadius: 6,
};
function rowWrap(color) {
  return {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: '10px', borderRadius: 8, marginBottom: 2,
    background: `color-mix(in oklch, ${color} 7%, transparent)`,
  };
}
function statusText(color) {
  return {
    marginTop: 6, fontSize: 11, color, fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums', overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
}

function SourceGlyph({ source }) {
  const Icon = source === 'music' ? IconMusic : source === 'stt' ? IconMic : IconFilm;
  return (
    <span aria-hidden="true" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 22, height: 22, borderRadius: 6, flexShrink: 0, marginTop: 1,
      background: 'var(--surface-2)', color: 'var(--text-muted)',
    }}><Icon size={13} /></span>
  );
}

function ActionLink({ onClick, Icon, children }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
      color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, lineHeight: 1,
    }}>
      <Icon size={12} />{children}
    </button>
  );
}

function ActiveRow({ row, accent, onCancel }) {
  const pct = Math.round((row.progress || 0) * 100);
  return (
    <div style={rowWrap(rowColor(row))}>
      <SourceGlyph source={row.source} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={titleRow}>
          <span title={row.title} style={titleText}>{row.title}</span>
          <button onClick={onCancel} title="Cancel" aria-label="Cancel download" style={iconBtn}><IconX size={14} /></button>
        </div>
        {row.subtitle && <div style={subText} title={row.subtitle}>{row.subtitle}</div>}
        {row.state === 'downloading' && (
          <div style={{ marginTop: 8, height: 4, borderRadius: 2, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: accent, transition: 'width 240ms ease' }} />
          </div>
        )}
        <div style={statusText('var(--text-faint)')} title={row.statusLine}>{row.statusLine}</div>
      </div>
    </div>
  );
}

function RecentRow({ row, onOpen, onReveal, onRetry, onClear }) {
  const color = rowColor(row);
  const failed = row.state === 'error' || row.state === 'cancelled';
  return (
    <div style={rowWrap(color)}>
      <SourceGlyph source={row.source} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={titleRow}>
          <span title={row.title} style={titleText}>{row.title}</span>
          <button onClick={onClear} title="Clear from history" aria-label="Clear from history" style={iconBtn}><IconX size={14} /></button>
        </div>
        {row.subtitle && <div style={subText} title={row.subtitle}>{row.subtitle}</div>}
        <div style={statusText(failed ? RED : 'var(--text-faint)')} title={row.statusLine}>{row.statusLine}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 7, flexWrap: 'wrap' }}>
          {row.finishedAt ? (
            <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
              {timeAgo(new Date(row.finishedAt).toISOString())}
            </span>
          ) : null}
          {row.state === 'done' && row.openPath && <ActionLink onClick={onOpen} Icon={IconExternal}>Open</ActionLink>}
          {row.state === 'done' && row.revealPath && <ActionLink onClick={onReveal} Icon={IconFolder}>Reveal</ActionLink>}
          {failed && row.args && <ActionLink onClick={onRetry} Icon={IconRotateCw}>Retry</ActionLink>}
        </div>
      </div>
    </div>
  );
}

export default function DownloadsPanel({ open, onClose, accent = GREEN, onOpenManager }) {
  const { active, recent, cancel, retry, clear, open: openRow, reveal } = useAllDownloads();
  const pos = useAnchoredRect(
    () => document.querySelector('[data-downloads-btn]')?.getBoundingClientRect(),
    { open, width: PANEL_W },
  );

  if (!open || !pos) return null;

  const empty = active.length === 0 && recent.length === 0;

  return (
    <Popover
      open
      onClose={onClose}
      accent={accent}
      title="Downloads"
      outsideExempt="[data-downloads-btn]"
      headerActions={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {recent.length > 0 && (
            <OutlinedBtn small onClick={() => clear(recent.map(r => r.id))}>Clear recent</OutlinedBtn>
          )}
          <button onClick={onOpenManager} title="Open downloads manager" aria-label="Open downloads manager" style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-faint)', display: 'flex', padding: 3, borderRadius: 5,
          }}><IconMaximize size={14} /></button>
        </div>
      )}
      style={{
        position: 'fixed', left: pos.left, bottom: pos.bottom, width: PANEL_W,
        maxHeight: 460, zIndex: 130, transformOrigin: 'bottom center',
        animation: 'notifPanelIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      {empty ? (
        <div style={{ padding: '32px 20px', textAlign: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>No downloads yet</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Music, anime, and voice-model downloads show up here while they run and after they finish.
          </div>
        </div>
      ) : (
        <div style={{ padding: 6 }}>
          {active.length > 0 && <div style={sectionLabel}>Active</div>}
          {active.map(row => (
            <ActiveRow key={row.id} row={row} accent={accent} onCancel={() => cancel(row)} />
          ))}
          {recent.length > 0 && <div style={sectionLabel}>Recent</div>}
          {recent.map(row => (
            <RecentRow
              key={row.id}
              row={row}
              onOpen={() => { openRow(row); onClose?.(); }}
              onReveal={() => reveal(row)}
              onRetry={() => retry(row)}
              onClear={() => clear([row.id])}
            />
          ))}
        </div>
      )}
    </Popover>
  );
}
