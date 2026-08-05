// The app's own window titlebar, replacing the native Windows one (the main
// window runs `decorations: false` in tauri.conf.json). Rendered only in the
// main window; the overlay windows return early in App.jsx and never mount it.
//
// Two clusters ride the strip (Titlebar Overhaul):
//   left  — the brand button (logo + wordmark + version, jumps to Releases),
//           then Settings / Recycling bin, relocated out of the Dock so they no
//           longer hover-expand into labelled pills; `title` carries the label
//           instead.
//   right — Notifications, the account button (avatar + display name in one
//           candy chip), then the three window controls.
// Everything BETWEEN the clusters is bare strip carrying
// `data-tauri-drag-region`, so Tauri owns dragging and double-click-to-maximize
// with no pointer handlers here. Only the element with the attribute drags, so
// every button stays clickable.
//
// The window controls are candy `CircleChip`s with `is-hover-accent` — the same
// accent flood the settings tabs take on hover. Close has NO red state; it flips
// accent like its neighbours.
//
// The four `core:window:` permissions this needs (minimize / toggle-maximize /
// close / start-dragging) are listed in capabilities/default.json; without
// them every control silently no-ops.

import { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { IconMinus, IconSquare, IconRestore, IconX, IconSettings, IconTrash } from './icons.jsx';
import { CircleChip } from './ui/Button.jsx';
import { candyCenterOffset } from '../util/candy.js';
import FoldMenu from './ui/FoldMenu.jsx';
import NotificationBell from '../notifications/NotificationBell.jsx';
import { useUpdateStatus } from '../hooks/useUpdateStatus.js';
import { navigate } from '../router.js';
import { makeFeedbackApi } from '@modules/core/feedback/feedbackApi.js';
import { useSession } from '@modules/core/feedback/useSession.js';
import UserAvatar from '@modules/core/feedback/UserAvatar.jsx';
import SignInModal from '@modules/core/feedback/SignInModal.jsx';

const BTN = 28;
const VERSION = import.meta.env.PACKAGE_VERSION || '0.0.0';
// Logo and avatar share one size so the strip's two chips stay twins — 2px under
// the 20px they started at, which read a touch heavy in a 28px button.
const MARK = 18;

// A candy button's depth lip is a box-shadow drawn OUTSIDE layout, so flex
// centring centres the BOX and leaves the visible ink sitting half a band low.
// candyCenterOffset() lifts it back — the same correction every Dock button
// uses. Every control on the strip takes it, the account chip included: it is a
// candy button too, and the offset reads its own --cbtn-depth.
const CENTER = candyCenterOffset();

export default function TitleBar({
  settings, accent,
  setSettingsOpen, setSettingsTab,
  setNotifOpen, notifOpen,
  setRecycleBinOpen,
}) {
  const [maximized, setMaximized] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);

  // The feedback module's Rust commands are the app's only account backend, and
  // makeFeedbackApi only needs something with `.invoke` — so the host shim is
  // the bare Tauri invoke.
  const fb = useMemo(() => makeFeedbackApi({ invoke }), []);
  const { session, refresh } = useSession(fb);
  const profile = session?.profile || null;
  const signedIn = !!session?.signedIn;

  // Update-available dot, relocated with the gear it has always ridden on.
  const { available: updateAvailable } = useUpdateStatus();
  const showUpdateDot = !!updateAvailable && settings?.dev?.autoCheckUpdates !== false;

  // Maximized state drives the middle glyph (square vs. two offset frames).
  // onResized fires for maximize, restore, snap, and plain edge-drags alike,
  // so one listener covers every path in and out of the maximized state.
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => w.isMaximized().then(setMaximized).catch(() => {});
    sync();
    const un = w.onResized(sync);
    return () => { un.then(f => f()).catch(() => {}); };
  }, []);

  const win = getCurrentWindow();
  const name = profile?.display_name || profile?.handle || '';

  // 'modules/feedback', NOT the slot's own tab id ('feedback-account'):
  // normalizeAddress validates the first segment against the drawer's static
  // TABS list, and module-contributed settings render as a PAGE under the
  // 'modules' tab (pagesByModuleId, keyed by module id). A bare tab id fails
  // validation and silently lands on the last-visited tab instead.
  const openAccountSettings = () => {
    setSettingsTab?.('modules/feedback');
    setSettingsOpen?.(true);
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-cluster">
        {/* Brand button — same chip skin as the account button on the far right,
            so the strip is bookended by one shape. Jumps to the Releases page;
            it is the app's only version display now (the sideways VersionChip on
            the collapsed rail was removed rather than print the number twice). */}
        <button
          type="button"
          data-own-press
          className="candy-btn titlebar-brand is-hover-accent"
          data-shape="chip"
          style={{ height: BTN, ...CENTER }}
          title={`Mortar & Pestle v${VERSION} — open Releases`}
          onClick={() => navigate('/docs/releases')}
        >
          <span className="candy-face">
            <img src="/mortar.png" alt="" width={MARK} height={MARK} style={{ borderRadius: 4, flexShrink: 0 }}/>
            MORTAR &amp; PESTLE v{VERSION}
          </span>
        </button>

        {/* --cbtn-depth re-declared because CENTER sits on this WRAPPER (so the
            update dot rides along) and the var is only defined on .candy-btn —
            without it the fallback is the full 7px and the gear lifts 1px more
            than its neighbours. Same fix as NotificationBell's wrapper. */}
        <span style={{ display: 'inline-flex', '--cbtn-depth': 'var(--candy-depth-small)', ...CENTER }}>
          <CircleChip title="Settings" size={BTN} className="is-hover-accent"
            onClick={() => setSettingsOpen?.(true)}>
            <IconSettings size={16}/>
          </CircleChip>
          {showUpdateDot && (
            <span aria-hidden title="Update available — open Settings → System" style={{
              position: 'absolute', top: 0, right: 0, width: 7, height: 7,
              borderRadius: '50%', background: accent || 'var(--accent, #c0392b)',
              boxShadow: '0 0 0 2px var(--surface)',
              animation: 'newBadgePulse 2.5s ease-in-out infinite',
              pointerEvents: 'none', zIndex: 5,
            }}/>
          )}
        </span>
        <CircleChip title="Recycling bin" size={BTN} className="is-hover-accent"
          style={CENTER} onClick={() => setRecycleBinOpen?.(true)}>
          <IconTrash size={16}/>
        </CircleChip>
      </div>

      <div className="titlebar-cluster">
        <NotificationBell
          variant="titlebar"
          label="Notifications"
          onClick={() => setNotifOpen?.(o => !o)}
          isActive={!!notifOpen}
          accent={accent}
        />

        {/* Account button — the house candy `chip` shape, avatar left of the
            display name in one frame. Signed out it reads "Sign in" and skips
            the menu entirely, opening the modal on the first click.
            Signed in it is a FoldMenu: the chip unfolds into its own rows like
            a letter and folds back into itself, the Dev tab's fold generalized
            to any row count. It replaced a floating Popover panel, and with it
            the avatar/display-name/@handle header that panel carried — that
            block does not fit the fold's grammar (every pane is one row tall)
            and the name is on the button you just clicked anyway. */}
        {signedIn ? (
          <FoldMenu
            style={CENTER}
            rowH={BTN}
            triggerClassName="titlebar-account is-hover-accent"
            triggerTitle={name || 'Account'}
            data-titlebar-avatar
            ariaLabel="Account"
            items={[
              // "Settings", not "Account settings": the fold's rows are one
              // rectangle wide and the shut state is the trigger, so a label
              // longer than the display name widens the whole stack and the
              // handover has to change size. Short enough to fit inside the
              // chip, the paper and the button are the same rectangle.
              { label: 'Settings', onClick: openAccountSettings },
              { label: 'Sign out', onClick: async () => { await fb.signOut().catch(() => {}); refresh(); } },
            ]}
          >
            <UserAvatar src={profile?.avatar_url} name={name} size={MARK}/>
            {name || 'Account'}
          </FoldMenu>
        ) : (
          <button
            type="button"
            data-own-press
            data-titlebar-avatar
            className="candy-btn titlebar-account is-hover-accent"
            data-shape="chip"
            style={{ height: BTN, ...CENTER }}
            title="Sign in"
            onClick={() => setSignInOpen(true)}
          >
            <span className="candy-face">
              <UserAvatar src={profile?.avatar_url} name={name} size={MARK}/>
              Sign in
            </span>
          </button>
        )}

        <CircleChip title="Minimize" size={BTN} className="is-hover-accent" style={CENTER} onClick={() => win.minimize()}>
          <IconMinus size={14}/>
        </CircleChip>
        <CircleChip
          title={maximized ? 'Restore' : 'Maximize'}
          size={BTN}
          className="is-hover-accent"
          style={CENTER}
          onClick={() => win.toggleMaximize()}
        >{maximized ? <IconRestore size={14}/> : <IconSquare size={14}/>}</CircleChip>
        <CircleChip title="Close" size={BTN} className="is-hover-accent" style={CENTER} onClick={() => win.close()}>
          <IconX size={14}/>
        </CircleChip>
      </div>

      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        fb={fb}
        accent={accent}
        onSignedIn={() => refresh()}
      />
    </div>
  );
}
