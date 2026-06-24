import { useTabStore } from './useTabStore.js';
import * as store from './tabStore.js';
import { IconGlobe, IconPlus } from '@host/components/icons.jsx';

// Collapsed 56px-rail body for the browser module (renderRail): a favicon stack
// — one dot per open tab (globe fallback), the active one highlighted, click to
// switch, middle-click to close — plus a "+" at the bottom. Reads the shared
// tab store.

export default function TabRail({ api }) {
  const { tabs, activeId } = useTabStore();

  const closeTab = (id) => {
    store.closeTab(id);
    api.invoke('browser_close_tab', { id }).catch(() => {});
  };

  return (
    <div style={rail}>
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`candy-btn${t.id === activeId ? ' is-active' : ''}`}
          data-shape="icon"
          data-own-press
          title={t.title || t.url || 'New tab'}
          onClick={() => store.switchTab(t.id)}
          onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
          style={dot}
        >
          <span className="candy-face" style={t.id === activeId ? undefined : { color: 'var(--text-muted)' }}>
            {t.favicon
              ? <img src={t.favicon} width={16} height={16} alt="" style={{ borderRadius: 3 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              : <IconGlobe size={16} />}
          </span>
        </button>
      ))}
      <button
        className="candy-btn"
        data-shape="icon"
        data-own-press
        title="New tab"
        aria-label="New tab"
        onClick={() => store.newTab()}
        style={{ ...dot, borderRadius: 999 }}
      >
        <span className="candy-face" style={{ color: 'var(--text)' }}><IconPlus size={16} /></span>
      </button>
    </div>
  );
}

const rail = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '4px 0' };
const dot = { width: 32, height: 32, borderRadius: 8, cursor: 'pointer' };
