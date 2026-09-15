// Shared floating-chat-window shell for agents. Extracted from AtelierChatWindow
// (SF1 of the Agents plan) so Atelier and Concierge share the same portaled,
// draggable window chrome — the frame, the header (avatar / title / subtitle /
// close + an optional controls slot), and the entrance/exit animation. Each
// agent composes its own body as `children` and may inject `preWindow` siblings
// (e.g. Atelier's MarkupOverlay / TokenBubble that live outside the window) and
// `headerControls` (e.g. Atelier's pointer toggle + pending-edits button).
//
// Drag is owned here via useDragChat — its onMouseDown ignores clicks on
// buttons, so header controls + close never start a drag.

import { createPortal } from 'react-dom';
import { useDragChat, DRAG_CHAT_WIDTH, DRAG_CHAT_HEIGHT } from '../agent-chat/useDragChat.js';

import { IconX } from '../icons.jsx';
import { ChipIconBtn } from '../planner/ItemChips.jsx';
import { CHAT_BTN_SIZE } from '../agent-chat/ChatInput.jsx';
export default function AgentChatWindow({
  settings,
  setSetting,
  avatar,
  title,
  subtitle = null,
  onClose,
  closeTitle = 'Close',
  headerControls = null,
  preWindow = null,
  children,
  exiting = false,
  posKey,
  width = DRAG_CHAT_WIDTH,
  height = DRAG_CHAT_HEIGHT,
  animIn = 'agentChatIn',
  animOut = 'agentChatOut',
}) {
  const { pressed, dragStyle, dragHandleProps, dragRef } = useDragChat({ settings, setSetting, posKey });

  // Portaled to document.body so the window escapes #root's stacking context
  // (a design-mode filter on #root would otherwise trap it below body-portaled
  // modals; z-index alone can't lift it out).
  return createPortal(
    <>
      {preWindow}
      {/* Two layers on purpose: the OUTER carries the drag translate + the app's
          glide (the overlay panel's exact mechanism), the INNER carries the
          entrance/exit animation. One element cannot do both — an animation
          driving `transform` would clobber the drag position for its whole
          duration. */}
      <div ref={dragRef} style={{ position: 'fixed', left: 0, top: 0, zIndex: 'var(--z-design)', ...dragStyle }}>
      <div
        data-aos-no-mark
        className={'candy-card aos-chat-window' + (pressed ? ' is-pressed' : '')}
        style={{
          width,
          height,
          display: 'flex', flexDirection: 'column',
          padding: 'var(--ov-gap)',
          overflow: 'hidden',
          animation: exiting
            ? `${animOut} 200ms cubic-bezier(0.7, 0, 0.84, 0) both`
            : `${animIn} 240ms cubic-bezier(0.16, 1, 0.3, 1) backwards`,
          transformOrigin: 'bottom right',
        }}
      >
        <AgentChatHeader
          avatar={avatar}
          title={title}
          subtitle={subtitle}
          onClose={onClose}
          closeTitle={closeTitle}
          dragHandleProps={dragHandleProps}
          pressed={pressed}
          controls={headerControls}
        />
        {children}
      </div>
      </div>
    </>
  , document.body);
}

function AgentChatHeader({ avatar, title, subtitle, onClose, closeTitle, dragHandleProps, pressed, controls }) {
  return (
    <div
      data-aos-chat-drag-handle
      className="candy-center-row ov-studio-head"
      {...dragHandleProps}
      style={{
        touchAction: 'none',
        justifyContent: 'space-between',
        cursor: pressed ? 'grabbing' : 'grab',
        userSelect: 'none',
        flexShrink: 0,
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {avatar}
        <div className="aos-chat-titlecol" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1 }}>{title}</span>
          {subtitle && (
            <span style={{
              fontSize: 9.5, color: 'var(--text-faint)',
              fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
              textTransform: 'uppercase', marginTop: 3,
            }}>{subtitle}</span>
          )}
        </div>
      </div>
      {/* .candy-center-row so the close button gets the shared candy lift: the
          rule is `> .candy-btn`, and a plain wrapper div made the X read
          depth/2 low against the band (photographed 2026-09-13). The lift is
          depth-derived, so it stays centred at any size.

          Close IS ChipIconBtn at CHAT_BTN_SIZE — the same component and the same
          size token as the send button below it (user-directed 2026-09-14),
          replacing a hand-rolled copy that duplicated its every attribute. */}
      <div className="candy-center-row" style={{ gap: 6 }}>
        {controls}
        <ChipIconBtn title={closeTitle} size={CHAT_BTN_SIZE} onClick={onClose}>
          <IconX size={13} />
        </ChipIconBtn>
      </div>
    </div>
  );
}
