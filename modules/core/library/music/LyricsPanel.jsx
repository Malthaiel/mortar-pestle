// Slide-out lyrics panel anchored to the right sidebar's left edge.
// Reads the current track's .md page, extracts its `## Lyrics` section,
// parses LRC timecodes if present, and highlights the active line.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';

const DOCK_WIDTH = 300;

export default function LyricsPanel({ open, onClose, accent }) {
  const { currentTrack, position } = useMusicPlayer();
  const [raw, setRaw] = useState(null);    // body of `## Lyrics` section
  const [status, setStatus] = useState('idle'); // idle | loading | ok | missing | error
  const scrollRef = useRef(null);
  const activeRef = useRef(null);

  const mdPath = useMemo(() => {
    if (!currentTrack || !currentTrack.audioPath || !currentTrack.wikilink) return null;
    const folder = currentTrack.audioPath.split('/').slice(0, -1).join('/');
    return folder + '/' + currentTrack.wikilink + '.md';
  }, [currentTrack?.audioPath, currentTrack?.wikilink]);

  // Fetch the track page when path changes (only while open).
  useEffect(() => {
    if (!open || !mdPath) { setRaw(null); setStatus('idle'); return; }
    let cancelled = false;
    setStatus('loading');
    const url = '/api/file/' + mdPath.split('/').map(encodeURIComponent).join('/');
    fetch(url)
      .then(r => r.ok ? r.text() : Promise.reject(r.status))
      .then(text => {
        if (cancelled) return;
        const section = extractLyricsSection(text);
        if (!section) { setRaw(null); setStatus('missing'); return; }
        setRaw(section);
        setStatus('ok');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [open, mdPath]);

  const lines = useMemo(() => parseLyrics(raw), [raw]);
  const synced = lines.some(l => l.time != null);

  // Active line index for synced lyrics.
  const activeIdx = useMemo(() => {
    if (!synced) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time != null && lines[i].time <= position) idx = i;
      else if (lines[i].time != null && lines[i].time > position) break;
    }
    return idx;
  }, [lines, synced, position]);

  // Auto-scroll the active line into view.
  useEffect(() => {
    if (!open || !synced || activeIdx < 0) return;
    const el = activeRef.current;
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [activeIdx, open, synced]);

  return (
    <div className="candy-modal" style={{
      position: 'fixed', right: DOCK_WIDTH + 8, bottom: 16,
      width: 360, maxHeight: '70vh',
      transform: open ? 'translateX(0)' : 'translateX(20px)',
      opacity: open ? 1 : 0,
      pointerEvents: open ? 'auto' : 'none',
      transition: 'all 0.18s ease',
      zIndex: 1000,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div className="candy-center-row" style={{
        padding: '12px 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--border)',
        gap: 12,
      }}>
        <span style={{
          fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1,
        }}>
          Lyrics{currentTrack ? ' · ' + currentTrack.title : ''}
        </span>
        <button onClick={onClose} title="Close" data-own-press className="candy-btn" data-shape="circle" style={{ flexShrink: 0 }}><span className="candy-face">×</span></button>
      </div>

      <div ref={scrollRef} style={{ overflowY: 'auto', flex: 1, padding: '14px 18px' }}>
        {status === 'loading' && <LyricsState message="Loading…" tone="muted"/>}
        {status === 'missing' && <LyricsState message="No lyrics on this track page." tone="faint"/>}
        {status === 'error' && <LyricsState message="Couldn't load track page." tone="error"/>}
        {status === 'ok' && lines.length === 0 && (
          <LyricsState message="Lyrics section is empty." tone="faint"/>
        )}
        {status === 'ok' && lines.map((line, i) => {
          const active = i === activeIdx;
          const dim = synced && activeIdx >= 0 && i !== activeIdx;
          return (
            <div
              key={i}
              ref={active ? activeRef : null}
              style={{
                fontSize: 13, lineHeight: 1.55,
                padding: '2px 0',
                color: active ? accent : (dim ? 'var(--text-faint)' : 'var(--text)'),
                fontWeight: active ? 600 : 400,
                transition: 'color 0.2s ease',
                minHeight: '1em',
              }}
            >{line.text || ' '}</div>
          );
        })}
      </div>
    </div>
  );
}

function LyricsState({ message, tone }) {
  const color = tone === 'error' ? '#e07b7b' : (tone === 'muted' ? 'var(--text-muted)' : 'var(--text-faint)');
  const dotColor = tone === 'error' ? '#e07b7b' : 'var(--text-faint)';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 12, padding: '32px 16px',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: dotColor, opacity: 0.5,
      }}/>
      <div style={{ color, fontSize: 13, textAlign: 'center' }}>{message}</div>
    </div>
  );
}

// Pulls the body of the first `## Lyrics` heading out of a markdown document.
// Returns null if no such section. Stops at the next `## ` heading.
function extractLyricsSection(md) {
  if (!md) return null;
  const lines = md.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Lyrics\s*$/.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

// Parses either an LRC fenced code block or plain text into [{ time?, text }].
function parseLyrics(body) {
  if (!body) return [];
  const fence = body.match(/```(?:lrc)?\s*\n([\s\S]*?)\n```/i);
  const text = fence ? fence[1] : body;
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) { out.push({ text: '' }); continue; }
    // Match one or more leading [mm:ss.xx] timestamps.
    const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    if (stamps.length === 0) {
      out.push({ text: line.trim() });
      continue;
    }
    const lyric = line.slice(stamps[stamps.length - 1].index + stamps[stamps.length - 1][0].length).trim();
    for (const m of stamps) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
      out.push({ time: min * 60 + sec + frac, text: lyric });
    }
  }
  // Sort synced lines by time (LRC may list multiple stamps per line out of order).
  if (out.some(l => l.time != null)) {
    out.sort((a, b) => {
      if (a.time == null) return -1;
      if (b.time == null) return 1;
      return a.time - b.time;
    });
  }
  return out;
}
