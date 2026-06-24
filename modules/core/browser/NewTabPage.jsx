import { useTabStore } from './useTabStore.js';
import { hostOf } from './tabStore.js';
import * as store from './tabStore.js';
import { IconGlobe, IconX, IconPlus } from '@host/components/icons.jsx';

// The New-Tab Page, shown in the content region when the active tab has no URL.
// Two rows of candy shortcut buttons: Pinned (curated — remove via hover-×) and
// Recent (auto-tracked from visited sites — pin via hover-＋). Each button is a
// `button-settings-tab` (leading favicon + title) — the same candy button as the
// Knowledge / Infrastructure secondary nav — laid out in a responsive grid.
// Clicking navigates the active tab. Empty states say what each row is for.

export default function NewTabPage({ api, accent, onNavigate }) {
  const { pinned, recent } = useTabStore();
  const open = (url) => { if (url) onNavigate(url); };

  return (
    <div style={wrap}>
      <style>{TILE_CSS}</style>
      <div style={{ width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 28 }}>
        <Section
          title="Pinned"
          empty="Pin a site from Recent to keep it here."
          items={pinned}
          accent={accent}
          onOpen={open}
          action={{ kind: 'remove', icon: <IconX />, title: 'Unpin', run: (it) => store.removePinned(it.url) }}
        />
        <Section
          title="Recent"
          empty="Sites you visit will show up here."
          items={recent}
          accent={accent}
          onOpen={open}
          action={{ kind: 'pin', icon: <IconPlus size={13} />, title: 'Pin', run: (it) => store.addPinned(it.url, it.title, it.favicon) }}
        />
        <button type="button" style={seeAllStyle} onClick={() => api?.router?.navigate('/tools/browser/history')}>
          See all history →
        </button>
      </div>
    </div>
  );
}

function Section({ title, empty, items, accent, onOpen, action }) {
  return (
    <section>
      <h2 style={headingStyle}>{title}</h2>
      {items.length === 0 ? (
        <p style={emptyStyle}>{empty}</p>
      ) : (
        <div style={grid}>
          {items.map((it) => (
            <div key={it.url} className="aos-ntp-tile" style={{ position: 'relative' }}>
              <button
                type="button"
                className="candy-btn"
                data-shape="row"
                data-own-press
                title={it.url}
                onClick={() => onOpen(it.url)}
                style={{ width: '100%', ...(accent ? { '--accent': accent } : {}) }}
              >
                <span className="candy-face" style={{ paddingRight: 30 }}>
                <span style={faviconWrap}>
                  {it.favicon
                    ? <img src={it.favicon} width={18} height={18} alt="" style={{ borderRadius: 4 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    : <IconGlobe size={16} />}
                </span>
                <span style={tileLabel}>{it.title || hostOf(it.url)}</span>
                </span>
              </button>
              <button
                type="button"
                className="aos-ntp-action"
                title={action.title}
                aria-label={action.title}
                onClick={(e) => { e.stopPropagation(); action.run(it); }}
                style={actionBtn}
              >
                {action.icon}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const wrap = {
  position: 'absolute',
  inset: 0,
  overflowY: 'auto',
  display: 'flex',
  justifyContent: 'center',
  padding: '48px 32px',
  background: 'var(--bg)',
};

const headingStyle = {
  margin: '0 0 12px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const emptyStyle = { margin: 0, fontSize: 13, color: 'var(--text-faint)' };

const seeAllStyle = { alignSelf: 'flex-start', marginTop: -12, padding: '4px 0', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', font: 'inherit', fontSize: 12.5 };

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: 10,
};

const faviconWrap = { flexShrink: 0, width: 18, height: 18, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' };
const tileLabel = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' };

const actionBtn = {
  position: 'absolute',
  top: 6,
  right: 6,
  width: 20,
  height: 20,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 6,
  border: 'none',
  background: 'var(--surface-2)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 120ms ease',
  zIndex: 1,
};

// Hover-reveal the per-tile action (pin / unpin); inline styles can't do :hover.
const TILE_CSS = `
.aos-ntp-tile:hover .aos-ntp-action { opacity: 1; }
.aos-ntp-action:hover { color: var(--text); background: var(--hover); }
`;
