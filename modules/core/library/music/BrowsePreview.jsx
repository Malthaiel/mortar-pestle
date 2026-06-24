// Album preview — opened from a Browse result card or a discography row.
// Fetches the canonical release's full tracklist (music_releasegroup_detail),
// shows cover + metadata + tracklist + a Download button. The cover tries the
// release-group front, then the canonical release front, then a styled initials
// placeholder (decision #10). The Download button is inert until SF3 wires the
// engine — it calls an optional onDownload(detail) if the parent supplies one.

import { Fragment, useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useDownloads } from './DownloadProvider.jsx';
import { AddToLibraryButton } from '../QuickAdd.jsx';

const CAA = 'https://coverartarchive.org';
const LISTEN_STATUSES = ['Plan-to-Listen', 'Currently-Listening', 'Listened', 'Dropped'];

function initials(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '♪';
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

// ms → "m:ss", or "h:mm:ss" once it crosses an hour (works for both a single
// track and a whole-album total).
function fmtMs(ms) {
  if (ms == null) return '—';
  const total = Math.round(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function errText(e, fallback) {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return e.code;
  try { return JSON.stringify(e); } catch { return fallback; }
}

// Cover with a two-step hot-link fallback. Keyed on its src list by the parent
// so it resets cleanly when the release MBID arrives (enabling the 2nd source).
function PreviewCover({ srcs, accent, alt }) {
  const [step, setStep] = useState(0);
  const src = srcs[step];
  if (src) {
    return (
      <img
        src={src} alt={alt} loading="lazy" decoding="async"
        onError={() => setStep(s => s + 1)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `color-mix(in oklch, ${accent || 'var(--text-muted)'} 16%, var(--surface-2))`,
      color: 'var(--text-muted)',
      fontFamily: 'var(--font-mono)', fontSize: 44, fontWeight: 600,
      letterSpacing: '0.04em', userSelect: 'none',
    }}>{initials(alt)}</div>
  );
}

export default function BrowsePreview({ result, accent, onBack, libraryEntry }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  useEffect(() => {
    const myId = ++reqId.current;
    setLoading(true); setError(null); setDetail(null);
    musicApi.releaseGroupDetail(result.mbid)
      .then(d => { if (myId === reqId.current) setDetail(d); })
      .catch(e => { if (myId === reqId.current) setError(errText(e, 'Failed to load album.')); })
      .finally(() => { if (myId === reqId.current) setLoading(false); });
  }, [result.mbid]);

  // Title/artist/year come from the result immediately; detail fills the rest.
  const title = (detail && detail.title) || result.title;
  const artist = (detail && detail.artist) || result.artist;
  const year = (detail && detail.year) || result.year || null;
  const primaryType = (detail && detail.primaryType) || result.primaryType || null;
  const secondaryTypes = (detail && detail.secondaryTypes) || result.secondaryTypes || [];
  const typeLabel = [primaryType, ...secondaryTypes].filter(Boolean).join(' / ');

  // 500px thumbnails for the ~200px preview cover (retina-safe) instead of the
  // full-size original. The download still grabs `/front` (full res) below.
  const coverSrcs = [
    result.mbid && `${CAA}/release-group/${result.mbid}/front-500`,
    detail && detail.releaseMbid && `${CAA}/release/${detail.releaseMbid}/front-500`,
  ].filter(Boolean);

  const metaBits = [
    year,
    typeLabel || null,
    detail && `${detail.trackCount} track${detail.trackCount === 1 ? '' : 's'}`,
    detail && detail.lengthMs != null && fmtMs(detail.lengthMs),
  ].filter(Boolean);

  // Download enqueue + lightweight status polling. The job runs in the Rust
  // worker and survives navigation; SF4 replaces this per-component poll with a
  // global event-driven toast stack.
  const { jobs, enqueue } = useDownloads();
  const [jobId, setJobId] = useState(null);
  const [dlError, setDlError] = useState(null);
  const job = jobId ? (jobs.find(j => j.id === jobId) || { state: 'queued', queuePosition: 0 }) : null;
  const dlBusy = job && (job.state === 'queued' || job.state === 'downloading');
  const startDownload = async (onlyMissing) => {
    if (!detail || dlBusy) return;
    setDlError(null);
    const cover = result.mbid ? `${CAA}/release-group/${result.mbid}/front` : null;
    try {
      const id = await enqueue({
        rgMbid: detail.releaseGroupMbid, title: detail.title, artist: detail.artist, cover, onlyMissing: !!onlyMissing,
      });
      setJobId(id);
    } catch (e) {
      setDlError(errText(e, 'Failed to start download.'));
    }
  };

  // Metadata-only add — album page via the same job queue, no audio.
  const addJob = jobs.find(j => j.rgMbid === result.mbid && j.metadataOnly) || null;
  const addBusy = !!(addJob && (addJob.state === 'queued' || addJob.state === 'downloading'));
  const addToLibrary = async (status) => {
    if (addBusy || libraryEntry || !detail) return;
    setDlError(null);
    const cover = result.mbid ? `${CAA}/release-group/${result.mbid}/front` : null;
    try {
      await enqueue({
        rgMbid: detail.releaseGroupMbid, title: detail.title, artist: detail.artist, cover,
        metadataOnly: true, initialStatus: status,
      });
    } catch (e) {
      setDlError(errText(e, 'Failed to add to library.'));
    }
  };

  // Button reflects, in priority: an in-session job → the library state
  // (in-library / repair) → a fresh download.
  const missing = libraryEntry ? Math.max(0, (libraryEntry.total || 0) - (libraryEntry.present || 0)) : 0;
  const btn = (() => {
    if (job) {
      switch (job.state) {
        case 'queued': return { label: job.queuePosition > 0 ? `Queued — #${job.queuePosition}` : 'Queued…', busy: true };
        case 'downloading': return { label: `Downloading ${job.trackIndex}/${job.trackTotal}…`, busy: true };
        case 'done': return { label: (job.failed && job.failed.length) ? `Done · ${job.failed.length} failed` : 'Downloaded ✓', done: true };
        case 'error': return { label: 'Failed — retry' };
        case 'cancelled': return { label: 'Cancelled — retry' };
        default: return { label: 'Download' };
      }
    }
    if (libraryEntry && missing > 0) return { label: `Repair · ${missing} missing`, onlyMissing: true };
    if (libraryEntry) return { label: '✓ In library', done: true };
    return { label: 'Download' };
  })();

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Back bar */}
      <div style={{
        padding: '12px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <button
          onClick={onBack}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 12, padding: 0,
          }}
        >← Back to results</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24 }}>
        {/* Header: cover + meta */}
        <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{
            width: 200, height: 200, flexShrink: 0,
            borderRadius: 8, overflow: 'hidden',
            boxShadow: '0 8px 26px rgba(0,0,0,0.28)', background: 'var(--surface-2)',
          }}>
            <PreviewCover
              key={coverSrcs.join('|')}
              srcs={coverSrcs}
              accent={accent}
              alt={artist || title}
            />
          </div>

          <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text)', lineHeight: 1.2 }}>{title}</div>
            <div style={{ fontSize: 15, color: 'var(--text-muted)' }}>{artist}</div>
            {metaBits.length > 0 && (
              <div style={{
                fontSize: 12, color: 'var(--text-faint)', marginTop: 2,
                fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
                fontVariantNumeric: 'tabular-nums',
              }}>{metaBits.join('  ·  ')}</div>
            )}
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <DownloadButton
                  accent={accent}
                  disabled={!detail || btn.busy}
                  label={btn.label}
                  done={!!btn.done}
                  onClick={() => startDownload(btn.onlyMissing)}
                />
                {(!libraryEntry || addBusy) && (
                  <AddToLibraryButton
                    accent={accent}
                    statuses={LISTEN_STATUSES}
                    defaultStatus="Plan-to-Listen"
                    busy={addBusy}
                    added={false}
                    disabled={!detail}
                    onAdd={addToLibrary}
                  />
                )}
              </div>
              {(dlError || (job && job.state === 'error' && job.error)) && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#e07b7b' }}>{dlError || job.error}</div>
              )}
            </div>
          </div>
        </div>

        {/* Tracklist */}
        <div style={{ marginTop: 28 }}>
          {loading && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading tracklist…</div>}
          {!loading && error && (
            <div style={{ color: '#e07b7b', fontSize: 12, padding: '12px 0' }}>{error}</div>
          )}
          {!loading && !error && detail && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {detail.tracks.map((t, i) => {
                const showDisc = detail.multiDisc && (i === 0 || detail.tracks[i - 1].disc !== t.disc);
                return (
                  <Fragment key={`${t.disc}-${t.position}-${i}`}>
                    {showDisc && (
                      <div style={{
                        fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                        padding: '14px 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 2,
                      }}>Disc {t.disc}</div>
                    )}
                    <TrackRow track={t} />
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TrackRow({ track }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 8px', borderRadius: 6,
        background: hover ? 'var(--surface-2)' : 'transparent',
        transition: 'background 100ms ease',
      }}
    >
      <span style={{
        width: 26, flexShrink: 0, textAlign: 'right',
        fontSize: 12, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
      }}>{track.position}</span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} title={track.title}>{track.title}</span>
      <span style={{
        flexShrink: 0, fontSize: 12, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtMs(track.lengthMs)}</span>
    </div>
  );
}

function DownloadButton({ accent, disabled, label, done, onClick }) {
  const [hover, setHover] = useState(false);
  const a = accent || 'var(--text)';
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '8px 16px', borderRadius: 'var(--radius-md)',
        border: `1px solid ${disabled ? 'var(--border)' : a}`,
        background: !disabled && hover ? `color-mix(in oklch, ${a} 14%, transparent)` : 'transparent',
        color: disabled ? 'var(--text-faint)' : a,
        fontSize: 13, fontWeight: 500,
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background 120ms ease',
      }}
    >
      <span style={{ fontSize: 14 }}>{done ? '✓' : '↓'}</span> {label || 'Download'}
    </button>
  );
}
