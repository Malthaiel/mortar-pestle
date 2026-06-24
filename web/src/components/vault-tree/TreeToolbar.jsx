// Tree sidebar toolbar — the Obsidian-style file-explorer header actions, pinned
// above the tree (the shell mounts it in a non-scroll header). Each is the one
// canonical candy button (data-shape="icon"). CONFIG-DRIVEN: every surface passes
// a `buttons` feature-flag set + a `controller`; the shared shell wires them. Only
// the requested buttons render, in the canonical order:
//   New · New folder · Sort · Collapse/Expand all · Reveal current · Reveal in files
//
// Buttons whose behaviour is intrinsic to the tree (Sort menu, Collapse/Expand
// toggle, Reveal current) read it off the `controller`; surface-specific ones (New,
// New folder, Reveal in files) carry their own `onClick` (+ optional title/icon).

import { useContextMenu } from '../../context-menu/useContextMenu.js';
import {
  IconFileText, IconFolder, IconSort, IconCrosshair, IconCheck,
  IconChevronsDownUp, IconChevronsUpDown, IconHardDrive,
} from '../icons.jsx';

// Toolbar buttons are candy icon buttons (data-shape="icon") sized to the tree
// rows' height (NAV_H) so they read as candy pills like the folder/file rows. The
// header band is transparent, so they ride the sidebar's circuit texture.
const ROW_H = 26; // = treeKit NAV_H

function ToolBtn({ title, accent, onClick, disabled, children }) {
  return (
    <button
      type="button" data-own-press title={title} onClick={onClick} disabled={disabled}
      className="candy-btn" data-shape="icon"
      style={{
        flexShrink: 0,
        // Size the BUTTON (square, at tree-row height) so the face fills it per the
        // base .candy-btn[data-shape="icon"] rule. Depth = nav rows.
        width: ROW_H, height: ROW_H, borderRadius: 8,
        '--cbtn-depth': 'var(--candy-depth-nav)',
        ...(accent ? { '--accent': accent } : {}),
        ...(disabled ? { opacity: 0.45 } : {}),
      }}
    >
      <span className="candy-face">{children}</span>
    </button>
  );
}

// buttons = {
//   new:           { show, title?, icon?, onClick },   // New note / New tab / New skill
//   newFolder:     { show, title?, icon?, onClick },   // New folder / New tab group
//   sort:          { show },                            // → controller.sortModes/sortMode/setSortMode
//   collapse:      { show },                            // → controller.anyExpanded/expandAll/collapseAll
//   revealCurrent: { show, title? },                   // → controller.revealCurrent/canReveal
//   revealInFiles: { show, title?, icon?, onClick },   // open OS file manager
// }
// controller = { sortMode, setSortMode, sortModes, anyExpanded, expandAll,
//                collapseAll, revealCurrent, canReveal }
export default function TreeToolbar({ buttons, controller, accent }) {
  const { openContextMenu } = useContextMenu();
  const b = buttons || {};
  const c = controller || {};
  const expanded = c.anyExpanded;

  // Drop the sort menu just below the button (a non-event caller → pass {x,y}).
  const onSort = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu({ x: r.left, y: r.bottom + 4 }, [
      { header: 'Sort order' },
      ...(c.sortModes || []).map(([mode, label]) => ({
        label,
        icon: c.sortMode === mode ? IconCheck : undefined,
        onClick: () => c.setSortMode(mode),
      })),
    ], { accent });
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
      {b.new?.show && (
        <ToolBtn title={b.new.title || 'New'} accent={accent} onClick={b.new.onClick}>
          {b.new.icon || <IconFileText/>}
        </ToolBtn>
      )}
      {b.newFolder?.show && (
        <ToolBtn title={b.newFolder.title || 'New folder'} accent={accent} onClick={b.newFolder.onClick}>
          {b.newFolder.icon || <IconFolder/>}
        </ToolBtn>
      )}
      {b.sort?.show && (
        <ToolBtn title="Change sort order" accent={accent} onClick={onSort}><IconSort/></ToolBtn>
      )}
      {b.collapse?.show && (
        <ToolBtn
          title={expanded ? 'Collapse all' : 'Expand all'} accent={accent}
          onClick={() => (expanded ? c.collapseAll() : c.expandAll())}
        >
          {expanded ? <IconChevronsDownUp/> : <IconChevronsUpDown/>}
        </ToolBtn>
      )}
      {b.revealCurrent?.show && (
        <ToolBtn title={b.revealCurrent.title || 'Reveal current file'} accent={accent}
          onClick={c.revealCurrent} disabled={!c.canReveal}>
          <IconCrosshair/>
        </ToolBtn>
      )}
      {b.revealInFiles?.show && (
        <ToolBtn title={b.revealInFiles.title || 'Reveal in files'} accent={accent} onClick={b.revealInFiles.onClick}>
          {b.revealInFiles.icon || <IconHardDrive/>}
        </ToolBtn>
      )}
    </div>
  );
}
