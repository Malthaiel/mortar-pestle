// Browser loading screen: shown in the content holder while a tab is loading,
// in place of the native WebKit view (which BrowserPage keeps hidden until the
// page commits + paints — see its `revealReady` gate). Kills the white flash
// WebKit paints pre-first-paint by covering it with a dark panel: a candy-accent
// spinner ring + the target site's favicon (when known) + host + a "Loading…"
// label. A ~120ms grace keeps the spinner from popping on instant/cached loads —
// the dark field shows immediately, the decorations only fade in past the grace.

import { useEffect, useMemo, useState } from 'react';
import { useTabStore } from './useTabStore.js';
import { hostOf } from './tabStore.js';
import { IconGlobe } from '@host/components/icons.jsx';

export default function LoadingScreen({ host, accent }) {
  const { pinned, recent } = useTabStore();
  const [show, setShow] = useState(false);

  // Grace: only reveal the spinner/host once the load outlasts ~120ms, so
  // cached/instant loads just blink the dark field with no decoration pop.
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 120);
    return () => clearTimeout(t);
  }, []);

  // Favicon for the host being loaded, pulled from the recents/pinned the
  // History view already tracks (the live tab's own favicon is still the
  // previous page's at this point). Globe fallback when the host is unseen.
  const favicon = useMemo(() => {
    if (!host) return null;
    for (const it of [...(recent || []), ...(pinned || [])]) {
      if (it.url && it.favicon && hostOf(it.url) === host) return it.favicon;
    }
    return null;
  }, [host, pinned, recent]);

  return (
    <div style={fill}>
      <style>{SPIN_CSS}</style>
      {show && (
        <div style={col}>
          <div className="aos-bspin" style={{ ...ring, borderTopColor: accent || 'var(--accent)' }} />
          <div style={hostRow}>
            <span style={favWrap}>
              {favicon
                ? <img src={favicon} width={16} height={16} alt="" style={{ borderRadius: 3 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                : <IconGlobe size={15} />}
            </span>
            <span style={hostText}>{host || 'Loading'}</span>
          </div>
          <div style={label}>Loading…</div>
        </div>
      )}
    </div>
  );
}

const fill = {
  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2,
  background: 'var(--bg)', display: 'grid', placeItems: 'center',
};
const col = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 };
const ring = {
  width: 38, height: 38, borderRadius: '50%', boxSizing: 'border-box',
  border: '3px solid var(--border-2)',
};
const hostRow = { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' };
const favWrap = { width: 16, height: 16, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' };
const hostText = { fontSize: 13, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 };
const label = { fontSize: 11, color: 'var(--text-faint)', letterSpacing: '0.02em' };

const SPIN_CSS = `@keyframes aos-bspin { to { transform: rotate(360deg); } } .aos-bspin { animation: aos-bspin 0.7s linear infinite; }`;
