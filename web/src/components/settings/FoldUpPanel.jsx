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
  const chip = (up) => (
    <FoldMenu
      up={up}
      style={CENTER}
      rowH={BTN}
      triggerClassName="titlebar-account is-hover-accent"
      triggerTitle={name || 'Account'}
      ariaLabel={`Account (fold ${up ? 'up' : 'down'})`}
      items={[
        { label: 'Settings', onClick: () => {} },
        { label: 'Sign out', onClick: () => {} },
      ]}
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
      }}>Fold up / down</div>

      {/* Clearance BOTH ways at once. Two rows plus the gap plus FOLD_PAD is
          under 80px at the 28px row height, so 96 of travel either side of a
          centred trigger clears the heading above and the panel below alike.
          Centred rather than one box per direction, so the two triggers sit on
          the same line and the folds can be compared frame for frame.
          The stacks are out of flow (FoldMenu's open state is position:
          absolute), so neither one pushes the other sideways when it opens. */}
      <div style={{
        height: 96 * 2 + BTN, display: 'flex',
        alignItems: 'center', gap: 24,
      }}>
        {chip(true)}
        {chip(false)}
      </div>
    </div>
  );
}
