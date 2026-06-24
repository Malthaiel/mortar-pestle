// Block Library popover — the calendar-header home of the Block Library after
// Pivot 2 (the bottom-right pane + its sidebar widget retired). Anchored below
// the "Block Library" chip; block chips drag straight out onto the calendar —
// the popover dismisses the moment a block drag actually starts (pointer
// hysteresis means a plain click keeps it open), and PlannerProvider's
// window-level drag listeners survive the chip unmount so the drop lands.
// Right-click keeps the Edit / Delete / Open-in-Obsidian menu; "+ Add Block"
// opens BlockEditorModal above the popover (its own z1100 portal, mounted
// later in the DOM — the popover holds position behind it).

import { useEffect, useLayoutEffect, useState } from 'react';
import { useBlockLibrary } from '../../hooks/useBlockLibrary.js';
import { useContextMenu } from '../../context-menu/useContextMenu.js';
import { IconPlus, IconExternal } from '../icons.jsx';
import Popover from '../ui/Popover.jsx';
import BlockEditorModal from './BlockEditorModal.jsx';
import { usePlanner } from '@modules/core/planner/PlannerProvider.jsx';

const BLOCK_LIBRARY_OBSIDIAN_URI = 'obsidian://open?vault=Pulse&file=Agentic%20OS%2FBlock%20Library.md';

const KIND_LABEL = {
  'fixed-recurring': 'Fixed',
  'variable-recurring': 'Variable',
  'floating': 'Floating',
};

const PANEL_W = 300;

export default function BlockLibraryPopover({ open, onClose, anchorRef, accent }) {
  const { blocks, loading, error, upsertBlock, deleteBlock } = useBlockLibrary();
  const { openContextMenu } = useContextMenu();
  const { taskDrag } = usePlanner();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingBlock, setEditingBlock] = useState(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const r = anchorRef?.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8));
    setPos({ top: r.bottom + 10, left });
  }, [open, anchorRef]);

  // A block drag that actually starts dismisses the popover; the closed panel
  // can't intercept pointer events over the calendar drop targets.
  useEffect(() => {
    if (open && taskDrag?.kind === 'block') onClose?.();
  }, [taskDrag, open, onClose]);

  // Esc closes only this popover (capture beats PlannerModal's bubble-phase
  // close); inert while the editor modal is stacked above (it owns Esc then).
  useEffect(() => {
    if (!open || editorOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, editorOpen, onClose]);

  const openCreate = () => { setEditingBlock(null); setEditorOpen(true); };
  const openEdit = (block) => { setEditingBlock(block); setEditorOpen(true); };
  const closeEditor = () => { setEditorOpen(false); setEditingBlock(null); };
  const handleSave = async (block) => {
    await upsertBlock(block);
    closeEditor();
  };

  // Right-click a chip → app-wide context menu. openContextMenu preventDefaults
  // and marks the event handled, so the global suppressor skips its default menu.
  const openBlockMenu = (e, block) => {
    openContextMenu(e, [
      { label: 'Edit…', onClick: () => openEdit(block) },
      { label: 'Delete', danger: true, onClick: () => { deleteBlock(block.id); } },
      { label: 'Open in Obsidian', icon: IconExternal, onClick: () => { try { window.location.href = BLOCK_LIBRARY_OBSIDIAN_URI; } catch (err) {} } },
    ], { accent });
  };

  return (
    <>
      <Popover
        open={open && !!pos}
        onClose={onClose}
        ariaLabel="Block Library"
        accent={accent}
        escToClose={false}
        closeOnOutside={!editorOpen}
        outsideExempt=".planner-blocklib-chip"
        style={{ position: 'fixed', zIndex: 1100, top: pos?.top, left: pos?.left, width: PANEL_W, maxHeight: 420 }}
        bodyStyle={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {loading ? (
          <Subdued>Loading…</Subdued>
        ) : error ? (
          <Subdued>Couldn’t read Block Library.</Subdued>
        ) : blocks.length === 0 ? (
          <Subdued>No blocks yet.</Subdued>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {blocks.map(b => (
              <BlockChip
                key={b.id}
                block={b}
                accent={accent}
                onContextMenu={(e) => openBlockMenu(e, b)}
              />
            ))}
          </div>
        )}
        <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          <button
            type="button"
            data-own-press
            onClick={openCreate}
            title="Add block"
            className="candy-btn"
            data-shape="chip"
          ><span className="candy-face" style={{ fontSize: 10, padding: '5px 11px', gap: 4 }}><IconPlus size={11}/>Add Block</span></button>
        </div>
      </Popover>

      {editorOpen && (
        <BlockEditorModal
          open={editorOpen}
          block={editingBlock}
          accent={accent}
          onSave={handleSave}
          onCancel={closeEditor}
        />
      )}
    </>
  );
}

function BlockChip({ block, accent, onContextMenu }) {
  const [hover, setHover] = useState(false);
  const { startPaneDrag } = usePlanner();
  return (
    <div
      onMouseDown={e => { e.stopPropagation(); if (e.button === 0) startPaneDrag('block', { blockId: block.id }, block.name, e); }}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${block.name} — ${KIND_LABEL[block.kind] || block.kind}, ${block.default_duration} min`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '6px 10px 6px 8px',
        background: hover ? 'var(--hover)' : 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        cursor: 'grab',
        fontSize: 12, color: 'var(--text)',
        transition: 'background 80ms ease',
        userSelect: 'none',
      }}
    >
      <span aria-hidden style={{
        width: 8, height: 8, borderRadius: 999,
        background: block.color || 'var(--text-faint)',
        flexShrink: 0,
      }}/>
      <span style={{ whiteSpace: 'nowrap' }}>{block.name}</span>
      <span style={{
        color: 'var(--text-faint)',
        fontFamily: 'var(--font-mono)',
        fontSize: 9, letterSpacing: '0.04em',
        marginLeft: 2,
      }}>{block.default_duration}m</span>
    </div>
  );
}

function Subdued({ children }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 0' }}>
      {children}
    </div>
  );
}
