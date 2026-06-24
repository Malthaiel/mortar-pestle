// Address-bar key/lock button. Sits next to the Shield button in BrowserPage's
// toolbar (a candy icon button, like its neighbors). Reflects vault state and
// badges the count of saved logins for the active site. Click toggles the vault
// popover.

import { useCredsStore } from './useCredsStore.js';
import { KeyGlyph, LockGlyph } from './vaultIcons.jsx';
import { candyCenterOffset } from '@host/util/candy.js';

export default function VaultKeyButton({ accent, host, open, onToggle }) {
  const { status, entries } = useCredsStore();
  const initialized = !!status?.initialized;
  const unlocked = !!status?.unlocked;
  const h = (host || '').toLowerCase();
  const matchCount = unlocked && h
    ? entries.filter(e => (e.host || '') === h).length
    : 0;
  const active = open || (unlocked && matchCount > 0);

  const title = !status ? 'Password vault'
    : !initialized ? 'Set up the password vault'
      : !unlocked ? 'Vault locked — click to unlock'
        : matchCount > 0 ? `${matchCount} saved login${matchCount === 1 ? '' : 's'} for ${h}`
          : 'Password vault';

  return (
    <button
      type="button"
      className={`candy-btn${active ? ' is-active' : ''}`}
      data-shape="icon"
      data-own-press
      style={{ ...candyCenterOffset(), '--accent': accent }}
      title={title}
      aria-label="Password vault"
      aria-haspopup="dialog"
      aria-expanded={!!open}
      onClick={onToggle}
    >
      <span className="candy-face">{initialized ? <LockGlyph open={unlocked} /> : <KeyGlyph />}</span>
      {matchCount > 0 && (
        <span style={{
          position: 'absolute', top: -4, right: -4, minWidth: 14, height: 14,
          padding: '0 3px', borderRadius: 7, background: accent, color: '#fff',
          fontSize: 9, fontWeight: 700, lineHeight: '14px', textAlign: 'center', zIndex: 1,
        }}>{matchCount}</span>
      )}
    </button>
  );
}
