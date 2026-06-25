// The Downloads Manager — a full-screen modal table of every download (active +
// history), launched from the Downloads popover's header. Columns, left→right:
// FILE · SIZE · STATUS · SPEED · ETA · DATE · SAVE TO, plus a trailing actions
// cell. Reads the same useAllDownloads() seam as the popover; active rows sort
// first, then recent by date. Backdrop + Esc close. SPEED/ETA are live-only
// (active rows); SIZE/SAVE TO come from the engines + persisted history.

import { useAllDownloads } from './DownloadsProvider.jsx';
import { IconBtn, AppWindow } from '../components/ui';
import { IconX, IconMusic, IconFilm, IconMic, IconExternal, IconFolder, IconRotateCw } from '../components/icons.jsx';

const GREEN = '#6fb56f';
const RED = '#e07b7b';
const ACTIVE = new Set(['queued', 'preparing', 'downloading']);

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
function fmtSpeed(bps) { return bps == null || bps <= 0 ? '—' : `${fmtBytes(bps)}/s`; }
function fmtEta(secs) {
  if (secs == null || secs < 0) return '—';
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60), s = secs % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function fmtDate(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  catch { return '—'; }
}
function statusText(r) {
  if (r.state === 'downloading') return `Downloading ${Math.round((r.progress || 0) * 100)}%`;
  if (r.state === 'preparing') return 'Preparing';
  if (r.state === 'queued') return 'Queued';
  if (r.state === 'done') return r.failedCount ? `Done (${r.failedCount} failed)` : 'Done';
  if (r.state === 'error') return 'Failed';
  if (r.state === 'cancelled') return 'Cancelled';
  return r.state;
}
function statusColor(r) {
  if (r.state === 'error') return RED;
  if (r.state === 'done') return r.failedCount ? RED : GREEN;
  if (r.state === 'cancelled') return 'var(--text-muted)';
  if (r.state === 'downloading' || r.state === 'preparing') return GREEN;
  return 'var(--text-faint)';
}

export default function DownloadsManager({ open, onClose, accent = GREEN }) {
  const { active, recent, cancel, retry, clear, open: openRow, reveal, reload } = useAllDownloads();

  if (!open) return null;

  const rows = [...active, ...recent]; // active already state-sorted, recent date-desc
  const th = {
    textAlign: 'left', padding: '8px 12px', fontSize: 11.5, fontFamily: 'var(--font-mono)',
    letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text)',
    fontWeight: 600, position: 'sticky', top: 0, background: 'var(--surface)',
    borderBottom: '1px solid var(--border)', zIndex: 1,
  };
  const thR = { ...th, textAlign: 'right' };
  const td = {
    padding: '9px 12px', fontSize: 12.5,
    borderBottom: '1px solid color-mix(in oklch, var(--border) 50%, transparent)', whiteSpace: 'nowrap',
  };
  const mono = { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' };

  return (
    <AppWindow
      open={open}
      onClose={onClose}
      accent={accent}
      title="Downloads"
      width="min(1100px, 92vw)"
      height="86vh"
      headerActions={(
        <IconBtn title="Reload" size={30} onClick={reload}><IconRotateCw size={15}/></IconBtn>
      )}
      bodyStyle={{ padding: 0 }}
    >

        {rows.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No downloads yet
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>File</th>
                  <th style={thR}>Size</th>
                  <th style={th}>Status</th>
                  <th style={thR}>Speed</th>
                  <th style={thR}>ETA</th>
                  <th style={th}>Date</th>
                  <th style={th}>Save to</th>
                  <th style={thR} aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const Glyph = r.source === 'music' ? IconMusic : r.source === 'stt' ? IconMic : IconFilm;
                  const isActive = ACTIVE.has(r.state);
                  return (
                    <tr key={r.id}>
                      <td style={{ ...td, maxWidth: 300 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ color: 'var(--text-muted)', display: 'flex', flexShrink: 0 }}><Glyph size={14}/></span>
                          <div style={{ minWidth: 0 }}>
                            <div title={r.title} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{r.title}</div>
                            {r.subtitle && <div title={r.subtitle} style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subtitle}</div>}
                          </div>
                        </div>
                      </td>
                      <td style={{ ...td, ...mono, textAlign: 'right' }}>{fmtBytes(r.sizeBytes)}</td>
                      <td style={{ ...td, color: statusColor(r), fontWeight: 600 }}>{statusText(r)}</td>
                      <td style={{ ...td, ...mono, textAlign: 'right' }}>{isActive ? fmtSpeed(r.speed) : '—'}</td>
                      <td style={{ ...td, ...mono, textAlign: 'right' }}>{isActive ? fmtEta(r.eta) : '—'}</td>
                      <td style={{ ...td, ...mono }}>{fmtDate(r.finishedAt)}</td>
                      <td style={{ ...td, ...mono, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-muted)' }} title={r.savePath || ''}>{r.savePath || '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          {isActive && <IconBtn title="Cancel" size={26} onClick={() => cancel(r)}><IconX size={13}/></IconBtn>}
                          {r.state === 'done' && r.openPath && <IconBtn title="Open in library" size={26} onClick={() => { openRow(r); onClose?.(); }}><IconExternal size={13}/></IconBtn>}
                          {r.state === 'done' && r.revealPath && <IconBtn title="Reveal folder" size={26} onClick={() => reveal(r)}><IconFolder size={13}/></IconBtn>}
                          {(r.state === 'error' || r.state === 'cancelled') && r.args && <IconBtn title="Retry" size={26} onClick={() => retry(r)}><IconRotateCw size={13}/></IconBtn>}
                          {!isActive && <IconBtn title="Clear from history" size={26} onClick={() => clear([r.id])}><IconX size={13}/></IconBtn>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        )}
      </AppWindow>
  );
}
