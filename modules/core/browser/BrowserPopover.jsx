// Shared shell for the browser toolbar's click-popups (Shield, History, and the
// refactored vault SitePopover). Because the native WebKit view renders ABOVE
// the React chrome, these can't overlay a live page — instead BrowserPage shrinks
// the native view DOWN by POPOVER_HEIGHT (see its bounds effect) so this panel
// drops into the vacated full-width strip below the toolbar, page still visible
// beneath. No backdrop (the page below is a native layer DOM can't dim and
// click-outside can't reach); close via the ✕, re-toggling the trigger, or Esc.

import { useEffect } from 'react';

export const POPOVER_HEIGHT = 360;

const panel = {
  position: 'absolute', top: 0, left: 0, right: 0, height: POPOVER_HEIGHT, zIndex: 6,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  background: 'var(--surface)', borderBottom: '1px solid var(--border)',
  boxShadow: '0 10px 26px rgba(0,0,0,0.26)',
};
const head = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
  borderBottom: '1px solid var(--border)', flex: '0 0 auto',
};
const hostSpan = {
  fontSize: 12, color: 'var(--text-muted)', flex: 1,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const closeBtn = {
  width: 28, height: 28, flex: '0 0 auto', display: 'grid', placeItems: 'center',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer',
};
const bodyScroll = { flex: 1, minHeight: 0, overflow: 'auto' };
const bodyFixed = { flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' };

export default function BrowserPopover({ title, host, onClose, scroll = true, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hostText = host === undefined ? '' : (host || 'no site');

  return (
    <div style={panel} role="dialog" aria-label={title}>
      <div style={head}>
        <strong style={{ fontSize: 13, flex: '0 0 auto' }}>{title}</strong>
        <span style={hostSpan}>{hostText}</span>
        <button type="button" style={closeBtn} title="Close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div style={scroll ? bodyScroll : bodyFixed}>{children}</div>
    </div>
  );
}
