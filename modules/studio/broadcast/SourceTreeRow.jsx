// SP3 tree-row adornments (approved net-new: SourceTreeRow) — the broadcast
// tree renders through the SHARED TreeSidebar shell (Library/Docs recipe);
// this file supplies only what the shell's node slots consume: the eye/lock
// trailing toggles (role="button" spans per the nested-clickable rule — the
// candy-face is pointer-events:none, spans re-enable) and the in-place
// RenamePill a node's renderRename swaps in (the approved inline-rename
// primitive).

import React, { useEffect, useRef, useState } from 'react';
import { IconEye, IconEyeOff, IconLock } from '@host/components/icons.jsx';

function FaceBtn({ title, onClick, dim, children }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      title={title}
      className="bcast-rowtoggle"
      style={{ pointerEvents: 'auto', opacity: dim ? 0.35 : 0.85 }}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </span>
  );
}

/// Eye + lock trailing pair for a source/group node.
export function RowToggles({ node, onToggleVisible, onToggleLock }) {
  return (
    <>
      <FaceBtn
        title={node.visible ? 'Hide (Alt-click: solo)' : 'Show'}
        dim={!node.visible}
        onClick={onToggleVisible}
      >
        {node.visible ? <IconEye size={12} /> : <IconEyeOff size={12} />}
      </FaceBtn>
      <FaceBtn title={node.locked ? 'Unlock' : 'Lock'} dim={!node.locked} onClick={onToggleLock}>
        <IconLock size={12} />
      </FaceBtn>
    </>
  );
}

export function ProgramDot() {
  return <span className="bcast-programdot" title="Program" />;
}

/// The in-place rename pill — Enter/blur commit, Esc cancel.
export function RenamePill({ initial, onCommit, onCancel }) {
  const ref = useRef(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const v = value.trim();
    if (!v || v === initial) onCancel();
    else onCommit(v);
  };
  return (
    <input
      ref={ref}
      className="candy-input bcast-rename"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      spellCheck={false}
    />
  );
}
