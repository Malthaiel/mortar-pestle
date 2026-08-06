// Fold Up — the titlebar account dropdown flipped vertically, beside an
// unflipped copy of itself for comparison. Same FoldMenu, same chip skin, same
// rows, same live account on both; the ONLY difference between the pair is the
// `up` prop (FoldMenu.jsx), which moves the hinge pivot to each flap's bottom
// edge, lays the stack out bottom-to-top and pins the backing panel by its
// bottom, so the rows unfold upward out of the button.
//
// It lives here rather than in the titlebar because an upward fold needs room
// ABOVE the trigger and the titlebar has 6px of it. The row below reserves that
// room both ways at once — an upward stack in a scroll pane clips against
// whatever sits above it otherwise, and the downward one needs the same
// clearance below, so the pair sits centred in a box tall enough for both.
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

export default function FoldUpPanel() {
  // Same shim TitleBar uses: makeFeedbackApi only needs something with .invoke.
  const fb = useMemo(() => makeFeedbackApi({ invoke }), []);
  const { session } = useSession(fb);
  const profile = session?.profile || null;
  const name = profile?.display_name || profile?.handle || '';

  // One config, rendered twice — the pair differs by `up` and nothing else, so
  // it is written once. Two hand-kept copies would drift the moment either is
  // tuned, and a drifted control is worthless for comparing the two directions.
  const chip = (up, items) => (
    <FoldMenu
      up={up}
      style={CENTER}
      rowH={BTN}
      triggerClassName="titlebar-account is-hover-accent"
      triggerTitle={name || 'Account'}
      ariaLabel={`Account (${items.length} rows, fold ${up ? 'up' : 'down'})`}
      items={items}
    >
      <UserAvatar src={profile?.avatar_url} name={name} size={MARK} />
      {name || 'Account'}
    </FoldMenu>
  );

  // Clearance BOTH ways at once. The stacks are out of flow (FoldMenu's open
  // state is position: absolute), so a row must reserve the travel itself or an
  // upward stack clips against whatever sits above it and a downward one runs
  // into the panel below. Centred rather than one box per direction, so the two
  // triggers sit on the same line and the folds compare frame for frame.
  //
  // Derived from the row count, not a constant: a four-row stack is two rows
  // taller than a two-row one, and the 96 that fitted the pair leaves the longer
  // one clipped. ROW_STEP is FoldMenu's own row + GAP at chip depth (28 + 5 + 4).
  const pair = (items) => (
    <div style={{
      height: ((items.length - 1) * (BTN + 9) + 32) * 2 + BTN,
      display: 'flex', alignItems: 'center', gap: 24,
    }}>
      {chip(true, items)}
      {chip(false, items)}
    </div>
  );

  const TWO = [
    { label: 'Settings', onClick: () => {} },
    { label: 'Sign out', onClick: () => {} },
  ];
  // The duplicate pair: the same chip with two more rows, so the fold can be
  // watched at a row count the account menu never reaches (the video player's
  // Chapters menu will).
  const FOUR = [
    ...TWO,
    { label: 'Profile', onClick: () => {} },
    { label: 'Shortcuts', onClick: () => {} },
  ];

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        margin: '20px 0 10px',
      }}>Fold up / down</div>

      {pair(TWO)}
      {pair(FOUR)}
    </div>
  );
}
