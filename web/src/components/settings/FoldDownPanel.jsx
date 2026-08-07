// Fold — the titlebar account dropdown, unflipped, at a four-row count the
// account menu itself never reaches (the video player's Chapters menu will).
// Same FoldMenu, same chip skin, same rows, same live account.
//
// It lives here rather than in the titlebar because the open stack needs room
// BELOW the trigger and the titlebar has none to spare. The box below reserves
// that travel — FoldMenu's open state is position: absolute, so it is out of
// flow and would otherwise run into whatever panel sits underneath.
import { useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import FoldMenu from '../ui/FoldMenu.jsx';
import { candyCenterOffset } from '../../util/candy.js';
import { makeFeedbackApi } from '@modules/core/feedback/feedbackApi.js';
import { useSession } from '@modules/core/feedback/useSession.js';
import UserAvatar from '@modules/core/feedback/UserAvatar.jsx';

// TitleBar's own BTN and MARK, so this is the same rectangle holding the same
// avatar — not a lookalike sized by eye.
const BTN = 28;
const MARK = 18;
const CENTER = candyCenterOffset();

const ITEMS = [
  { label: 'Settings', onClick: () => {} },
  { label: 'Sign out', onClick: () => {} },
  { label: 'Profile', onClick: () => {} },
  { label: 'Shortcuts', onClick: () => {} },
];

export default function FoldDownPanel() {
  // Same shim TitleBar uses: makeFeedbackApi only needs something with .invoke.
  const fb = useMemo(() => makeFeedbackApi({ invoke }), []);
  const { session } = useSession(fb);
  const profile = session?.profile || null;
  const name = profile?.display_name || profile?.handle || '';

  // One menu, twice, differing only in `up` — the direction is a PROP, not a
  // second component. The up one is pinned to the BOTTOM of the same reserve
  // box because its stack grows the other way; that is the only difference the
  // host owes it.
  const menu = (up) => (
    <FoldMenu
      up={up}
      style={CENTER}
      rowH={BTN}
      triggerClassName="titlebar-account is-hover-accent"
      triggerTitle={name || 'Account'}
      ariaLabel={`Account (${ITEMS.length} rows, folds ${up ? 'up' : 'down'})`}
      items={ITEMS}
    >
      <UserAvatar src={profile?.avatar_url} name={name} size={MARK} />
      {name || 'Account'}
    </FoldMenu>
  );

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        margin: '20px 0 10px',
      }}>Fold</div>

      {/* Derived from the row count, not a constant — a four-row stack is two
          rows taller than a two-row one. ROW_STEP is FoldMenu's own row + GAP
          at chip depth (28 + 5 + 4). Both menus share it: the down one hangs
          into it, the up one sits at its floor and grows back through it. */}
      <div style={{
        display: 'flex', gap: 32, alignItems: 'stretch',
        height: BTN + (ITEMS.length - 1) * (BTN + 9) + 32,
      }}>
        <div>{menu(false)}</div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>{menu(true)}</div>
      </div>
    </div>
  );
}
