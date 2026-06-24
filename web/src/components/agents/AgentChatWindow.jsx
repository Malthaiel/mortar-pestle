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
import { useDragChat, DRAG_CHAT_WIDTH, DRAG_CHAT_HEIGHT } from '../design/useDragChat.js';

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
  animIn = 'atelierChatIn',
  animOut = 'atelierChatOut',
}) {
  const { position, pressed, dragHandleProps, dragRef } = useDragChat({ settings, setSetting, posKey });

  // Portaled to document.body so the window escapes #root's stacking context
  // (a design-mode filter on #root would otherwise trap it below body-portaled
  // modals; z-index alone can't lift it out).
  return createPortal(
    <>
      {preWindow}
      <div
        ref={dragRef}
        data-aos-no-mark
        className={'aos-chat-window' + (pressed ? ' is-pressed' : '')}
        style={{
          position: 'fixed',
          left: position.x,
          top: position.y,
          width,
          height,
          display: 'flex', flexDirection: 'column',
          zIndex: 'var(--z-design)',
          animation: exiting
            ? `${animOut} 200ms cubic-bezier(0.7, 0, 0.84, 0) both`
            : `${animIn} 240ms cubic-bezier(0.16, 1, 0.3, 1) backwards`,
          transformOrigin: 'bottom right',
          transition: 'none',
        }}
      >
        <div className="aos-chat-face">
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
      {...dragHandleProps}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px',
        borderBottom: '1px solid var(--border-soft)',
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {controls}
        <button
          type="button"
          onClick={onClose}
          title={closeTitle}
          aria-label={closeTitle}
          data-own-press
          className="candy-btn"
          data-shape="icon"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0 }}
        >
          <span className="candy-face" style={{ padding: 0 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18"/>
              <line x1="6" y1="18" x2="18" y2="6"/>
            </svg>
          </span>
        </button>
      </div>
    </div>
  );
}
