// The app's own window titlebar, replacing the native Windows one (the main
// window runs `decorations: false` in tauri.conf.json). Rendered only in the
// main window; the overlay windows return early in App.jsx and never mount it.
//
// Two clusters ride the strip (Titlebar Overhaul):
//   left  — the brand button (logo + wordmark + version, jumps to Releases),
//           then ONE fused .candy-split shell carrying Settings / Recycling bin
//           / Processes / Downloads / Notifications, all relocated out of the
//           Dock so they no longer hover-expand into labelled pills; `title`
//           carries the label instead.
//   right — a fused [Command palette | Agents] run, then a three-part run
//           pairing the account button (avatar + display name in one candy
//           chip) with Feedback and Help, then the three window controls. All
//           four launchers left the Dock 2026-09-15.
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
import {
  IconMinus, IconSquare, IconRestore, IconX, IconSettings, IconTrash, IconChart,
  IconDownload, IconCommand, IconHelp, IconMessageSquare,
} from './icons.jsx';
import { CircleChip } from './ui/Button.jsx';
import { candyCenterOffset } from '../util/candy.js';
import { Popover, useAnchoredRect } from './ui';
import NotificationBell from '../notifications/NotificationBell.jsx';
import { useUpdateStatus } from '../hooks/useUpdateStatus.js';
import { useProcesses } from '../processes/ProcessesProvider.jsx';
import { useAllDownloads } from '../downloads/DownloadsProvider.jsx';
import { navigate } from '../router.js';
import { sharedEvents } from '../module-sdk/index.js';
import DockAgentsButton from './dock/DockAgentsButton.jsx';
import { makeFeedbackApi } from '@modules/core/feedback/feedbackApi.js';
import { useSession } from '@modules/core/feedback/useSession.js';
import UserAvatar from '@modules/core/feedback/UserAvatar.jsx';
import SignInModal from '@modules/core/feedback/SignInModal.jsx';

const BTN = 28;
const MENU_W = 220;
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

// Every badge on the strip is one shape — an accent pip pinned to its button's
// top-right corner, ringed in --surface so it reads against any band. Passing
// no children gives the bare 7px dot (Settings' update flag); a number gives
// the wider count pill (Processes, Downloads).
//
// It rides INSIDE .candy-face on purpose. .candy-face is position:static, so
// the badge anchors to the position:relative .candy-btn above it — which means
// no wrapper <span> around the button. That matters now the four are fused:
// .candy-split squares and overlaps its DIRECT .candy-btn children, and a
// wrapper sitting between them would swallow the :first-child / :last-child
// rounding rules and break the shell. Pinned at right:0 rather than -2 so it
// stops AT the seam instead of spilling over its neighbour; zIndex lifts it
// above the next half's overlapping frame either way.
function Badge({ children, accent, title }) {
  const dot = children == null;
  return (
    <span aria-hidden title={title} style={{
      position: 'absolute', top: 0, right: 0,
      minWidth: dot ? 7 : 13, height: dot ? 7 : 13,
      padding: dot ? 0 : '0 3px',
      borderRadius: dot ? '50%' : 7,
      background: accent || 'var(--accent, #c0392b)', color: '#fff',
      fontSize: 9, fontWeight: 700, lineHeight: '13px', textAlign: 'center',
      boxShadow: '0 0 0 2px var(--surface)',
      animation: dot ? 'newBadgePulse 2.5s ease-in-out infinite' : undefined,
      pointerEvents: 'none', zIndex: 5,
    }}>{children}</span>
  );
}

export default function TitleBar({
  settings, accent,
  setSettingsOpen, setSettingsTab,
  setNotifOpen, notifOpen,
  setRecycleBinOpen,
  setProcessesOpen,
  setDownloadsOpen, downloadsOpen,
  setPaletteOpen, paletteOpen,
  setHintsOpen, hintsOpen,
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

  // Feedback is a POP-UP window, not a route, so its button reads the window's
  // own open state: the overlay echoes `feedback:state` whenever it toggles
  // (modules/core/feedback/FeedbackWindow.jsx).
  const [feedbackActive, setFeedbackActive] = useState(false);
  useEffect(() => sharedEvents.on('feedback:state', ({ open }) => setFeedbackActive(!!open)), []);

  // 'modules/feedback', NOT the slot's own tab id ('feedback-account'):
  // normalizeAddress validates the first segment against the drawer's static
  // TABS list, and module-contributed settings render as a PAGE under the
  // 'modules' tab (pagesByModuleId, keyed by module id). A bare tab id fails
  // validation and silently lands on the last-visited tab instead.
  const { activeCount: runningCount } = useProcesses();
  const { activeCount: downloadCount } = useAllDownloads();

  const openAccountSettings = () => {
    setMenuOpen(false);
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
            Mortar &amp; Pestle v{VERSION}
          </span>
        </button>

        {/* The four utility buttons — Settings, Recycling bin, Processes,
            Downloads — fused into ONE shell (user-directed 2026-09-11), the
            same .candy-split the Planner header uses for
            [date | Today | ‹ | ›]. The class is written for any number of
            parts: only the run's two outer ends stay round, every interior
            edge squares off and overlaps its neighbour into one line. Each
            half keeps its own press, lip and hover flood.

            Downloads MOVED here from the Dock, the same trip Settings,
            Notifications and the Recycling bin already took; its entry is gone
            from dock-buttons.js and effectiveOrder() drops the stale id out of
            saved dock orders on its own.

            No wrapper <span>s: .candy-split's rounding rules match its DIRECT
            .candy-btn children, so the three badges live inside their buttons
            now (see Badge above). */}
        <div className="candy-split">
          <CircleChip title="Settings" size={BTN} className="is-hover-accent"
            style={CENTER} onClick={() => setSettingsOpen?.(true)}>
            <IconSettings size={16}/>
            {showUpdateDot && <Badge accent={accent} title="Update available — open Settings → System"/>}
          </CircleChip>

          <CircleChip title="Recycling bin" size={BTN} className="is-hover-accent"
            style={CENTER} onClick={() => setRecycleBinOpen?.(true)}>
            <IconTrash size={16}/>
          </CircleChip>

          {/* Processes — everything the app is currently running. Rising bars,
              NOT the chip glyph it wore until 2026-09-11: at 16px that chip's
              leg-notches read as gear teeth, so fused a seam away from the
              Settings gear the two were a matched pair of cogs. The gap in the
              old un-fused cluster was all that hid it. */}
          <CircleChip title={runningCount ? `Processes — ${runningCount} running` : 'Processes'}
            size={BTN} className="is-hover-accent"
            style={CENTER} onClick={() => setProcessesOpen?.(true)}>
            <IconChart size={16}/>
            {runningCount > 0 && <Badge accent={accent}>{runningCount}</Badge>}
          </CircleChip>

          {/* Downloads — [data-downloads-btn] stays on the BUTTON so
              DownloadsPanel still finds its anchor rect and its click-outside
              guard still exempts the trigger. The panel drops DOWN from here
              now instead of rising off the dock. */}
          <CircleChip title={downloadCount ? `Downloads — ${downloadCount} active` : 'Downloads'}
            size={BTN} className={`is-hover-accent${downloadsOpen ? ' is-active' : ''}`} data-downloads-btn
            style={CENTER} onClick={() => setDownloadsOpen?.(o => !o)}>
            <IconDownload size={16}/>
            {downloadCount > 0 && (
              <Badge accent={accent}>{downloadCount > 99 ? '99+' : downloadCount}</Badge>
            )}
          </CircleChip>

          {/* Notifications — the last of the old dock tools to fuse in
              (2026-09-15). `variant="split"` is the bell's no-wrapper skin: it
              renders a bare CircleChip as a DIRECT child so the run's rounding
              rules still match it, and moves its unread pill inside .candy-face
              in the Badge shape above, which stops AT the seam instead of
              painting over Downloads. The toast fly-target is the button now. */}
          <NotificationBell
            variant="split"
            label="Notifications"
            onClick={() => setNotifOpen?.(o => !o)}
            isActive={!!notifOpen}
            accent={accent}
          />
        </div>
      </div>

      <div className="titlebar-cluster">
        {/* The launcher pair — one fused run, both of them jumps to somewhere
            else in the app. */}
        <div className="candy-split">
          <CircleChip title="Command palette" size={BTN}
            className={`is-hover-accent${paletteOpen ? ' is-active' : ''}`}
            style={CENTER} onClick={() => setPaletteOpen?.(true)}>
            <IconCommand size={16}/>
          </CircleChip>

          {/* Its own launcher popover comes with it out of the Dock — the
              titlebar variant wears the CircleChip skin and drops the menu DOWN
              instead of up off the bar. */}
          <DockAgentsButton variant="titlebar" label="Agents" accent={accent}/>
        </div>

        {/* Account + Feedback + Help fuse into ONE three-part run
            (user-directed 2026-09-15): all three are about the person using the
            app, so they read as a set. .candy-split mixes shapes happily — its
            --corner-max override is derived from --cbtn-size, which is exactly
            why a `chip` and two `circle`s curve by the same amount once fused,
            and the class was already written for any number of parts. */}
        <div className="candy-split">
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
              <UserAvatar src={profile?.avatar_url} name={name} size={MARK}/>
              {signedIn ? (name || 'Account') : 'Sign in'}
            </span>
          </button>

          {/* Feedback is a POP-UP window (modules/core/feedback/FeedbackWindow.jsx),
              not a route or a dock panel — this chip is its only launcher, and it
              toggles by emitting on sharedEvents rather than navigating. */}
          <CircleChip title="Feedback" size={BTN}
            className={`is-hover-accent${feedbackActive ? ' is-active' : ''}`}
            style={CENTER} onClick={() => sharedEvents.emit('feedback:open', {})}>
            <IconMessageSquare size={16}/>
          </CircleChip>

          {/* Help — a query mark, not the keyboard glyph it wore for one
              afternoon. Today it opens the keyboard-shortcuts overlay and
              nothing else, which is what `title` still says; the icon is the
              wider promise, because this is where the rest of the help surface
              is going to hang off (user-directed 2026-09-15). */}
          <CircleChip title="Keyboard shortcuts" size={BTN}
            className={`is-hover-accent${hintsOpen ? ' is-active' : ''}`}
            style={CENTER} onClick={() => setHintsOpen?.(true)}>
            <IconHelp size={16}/>
          </CircleChip>
        </div>

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
