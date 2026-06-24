// Page shell for /tools/terminal: the tab bar at top, the active xterm
// underneath. Persistent shell state lives in TerminalProvider (mounted at
// AppShell). This component is responsible only for:
//   - Telling the provider the panel is currently visible (markPanelOpen).
//   - Rendering the tab bar (one chip per tab + new-tab button).
//   - Mounting one <Terminal/> per tab and toggling visibility via CSS so
//     xterm instances survive intra-route tab switches without rebuild.
//
// The look is fixed to Zed (Gruvbox Dark): the pane + tab strip use the
// Gruvbox background, and the active-tab accent is Gruvbox aqua (#83a598) so
// the whole surface reads as Zed's terminal, not the app's accent-red chrome.

import { useEffect } from 'react';
import { useTerminal } from './TerminalProvider.jsx';
import Terminal from './Terminal.jsx';
import { IconBtn } from '@host/components/ui/index.js';
import { IconX } from '@host/components/icons.jsx';

// Pane chrome tones (match GRUVBOX_THEME in themes.js; bg is the user's #151411).
const GRUVBOX_BG = '#151411';
const GRUVBOX_BORDER = '#3c3836';
const GRUVBOX_ACCENT = '#83a598';

function TabChip({ tab, active, accent, onActivate, onClose }) {
  const bg = active
    ? `color-mix(in oklch, ${accent} 14%, transparent)`
    : 'transparent';
  const borderColor = active
    ? `color-mix(in oklch, ${accent} 38%, ${GRUVBOX_BORDER})`
    : 'transparent';
  const color = active ? accent : '#a89984';
  const dotColor = tab.status === 'open'
    ? accent
    : tab.status === 'closed' || tab.status === 'error'
      ? '#928374'
      : '#7c6f64';

  return (
    <div
      onClick={onActivate}
      title={`${tab.title} (${tab.status})`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 6px 4px 10px',
        border: `1px solid ${borderColor}`,
        borderRadius: 999,
        background: bg,
        color,
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.02em',
        transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
      }}
    >
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: dotColor,
        flexShrink: 0,
      }}/>
      <span>{tab.title}</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close terminal"
        style={{
          width: 16, height: 16, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none',
          borderRadius: '50%',
          background: 'transparent',
          color: '#928374',
          cursor: 'pointer',
          transition: 'background 120ms ease, color 120ms ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#3c3836'; e.currentTarget.style.color = '#ebdbb2'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#928374'; }}
      >
        <IconX/>
      </button>
    </div>
  );
}

export default function TerminalPage() {
  const { tabs, activeId, addTab, closeTab, setActive, markPanelOpen } = useTerminal();

  useEffect(() => {
    markPanelOpen(true);
    return () => markPanelOpen(false);
  }, [markPanelOpen]);

  return (
    <div
      className="term-page"
      data-skin="zed"
      style={{
        flex: 1, minWidth: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        background: GRUVBOX_BG,
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 12px',
        borderBottom: `1px solid ${GRUVBOX_BORDER}`,
        flexShrink: 0,
        background: GRUVBOX_BG,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          flexWrap: 'nowrap',
        }}>
          {tabs.map((tab) => (
            <TabChip
              key={tab.id}
              tab={tab}
              accent={GRUVBOX_ACCENT}
              active={tab.id === activeId}
              onActivate={() => setActive(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </div>
        <IconBtn
          size={24}
          accent={GRUVBOX_ACCENT}
          title="New terminal"
          onClick={() => addTab()}
        >
          +
        </IconBtn>
      </div>

      <div style={{
        flex: 1, minHeight: 0, minWidth: 0,
        position: 'relative',
      }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: tab.id === activeId ? 'flex' : 'none',
              flexDirection: 'column',
            }}
          >
            <Terminal tabId={tab.id} visible={tab.id === activeId}/>
          </div>
        ))}
      </div>
    </div>
  );
}
