// The app's own window titlebar, replacing the native Windows one (the main
// window runs `decorations: false` in tauri.conf.json). Rendered only in the
// main window; the overlay windows return early in App.jsx and never mount it.
//
// Two clusters ride the strip (Titlebar Overhaul):
//   left  — Settings / Recycling bin, relocated out of the Dock so they no
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { IconMinus, IconSquare, IconRestore, IconX, IconSettings, IconTrash } from './icons.jsx';
import { CircleChip } from './ui/Button.jsx';
import { candyCenterOffset } from '../util/candy.js';
import { Popover, useAnchoredRect } from './ui';
import NotificationBell from '../notifications/NotificationBell.jsx';
import { useUpdateStatus } from '../hooks/useUpdateStatus.js';
import { makeFeedbackApi } from '@modules/core/feedback/feedbackApi.js';
import { useSession } from '@modules/core/feedback/useSession.js';
import UserAvatar from '@modules/core/feedback/UserAvatar.jsx';
import SignInModal from '@modules/core/feedback/SignInModal.jsx';

const BTN = 28;
const MENU_W = 220;

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const avatarRef = useRef(null);

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

  const menuPos = useAnchoredRect(
    () => avatarRef.current?.getBoundingClientRect(),
    { open: menuOpen, width: MENU_W, place: 'below' },
  );

  const win = getCurrentWindow();
  const name = profile?.display_name || profile?.handle || '';

  // 'modules/feedback', NOT the slot's own tab id ('feedback-account'):
  // normalizeAddress validates the first segment against the drawer's static
  // TABS list, and module-contributed settings render as a PAGE under the
  // 'modules' tab (pagesByModuleId, keyed by module id). A bare tab id fails
  // validation and silently lands on the last-visited tab instead.
  const openAccountSettings = () => {
    setMenuOpen(false);
    setSettingsTab?.('modules/feedback');
    setSettingsOpen?.(true);
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-cluster">
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
            the menu entirely, opening the modal on the first click. */}
        <button
          ref={avatarRef}
          type="button"
          data-own-press
          data-titlebar-avatar
          className="candy-btn titlebar-account is-hover-accent"
          data-shape="chip"
          style={{ height: BTN, ...CENTER }}
          title={signedIn ? (name || 'Account') : 'Sign in'}
          onClick={() => (signedIn ? setMenuOpen(o => !o) : setSignInOpen(true))}
        >
          <span className="candy-face">
            <UserAvatar src={profile?.avatar_url} name={name} size={20}/>
            {signedIn ? (name || 'Account') : 'Sign in'}
          </span>
        </button>

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

      {menuOpen && menuPos && (
        <Popover
          open
          onClose={() => setMenuOpen(false)}
          accent={accent}
          outsideExempt="[data-titlebar-avatar]"
          ariaLabel="Account"
          style={{
            position: 'fixed', left: menuPos.left, top: menuPos.top, width: MENU_W,
            zIndex: 130, transformOrigin: 'top center',
            animation: 'notifPanelInDown 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
          }}
          bodyStyle={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          {/* Signed out never reaches here — the button opens the modal directly. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px 8px' }}>
            <UserAvatar src={profile?.avatar_url} name={name} size={32}/>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name || 'Account'}
              </div>
              {profile?.handle && (
                <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>@{profile.handle}</div>
              )}
            </div>
          </div>
          <MenuRow label="Account settings" onClick={openAccountSettings}/>
          <MenuRow label="Sign out" onClick={async () => { setMenuOpen(false); await fb.signOut().catch(() => {}); refresh(); }}/>
        </Popover>
      )}

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

// The house menu-row skin — same candy row the context menu and settings tabs
// use, so it takes the identical accent flood on hover.
function MenuRow({ label, onClick }) {
  return (
    <button type="button" data-own-press onClick={onClick}
      className="candy-btn" data-shape="row" data-variant="menu">
      <span className="candy-face">{label}</span>
    </button>
  );
}
