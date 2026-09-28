// Tree sidebar toolbar — the Obsidian-style file-explorer header actions, pinned
// above the tree (the shell mounts it in a non-scroll header). Each is the one
// canonical candy button (data-shape="icon"), all fused into ONE .candy-split run
// (user-directed 2026-09-25) — so every part, `children` included, must be a
// DIRECT child of the run: no wrapper spans. CONFIG-DRIVEN: every surface passes
// a `buttons` feature-flag set + a `controller`; the shared shell wires them. Only
// the requested buttons render, in the canonical order:
//   New · New folder · Sort · Collapse/Expand all · Reveal current · Reveal in files
//
// Buttons whose behaviour is intrinsic to the tree (Sort menu, Collapse/Expand
// toggle, Reveal current) read it off the `controller`; surface-specific ones (New,
// New folder, Reveal in files) carry their own `onClick` (+ optional title/icon).

import { useContextMenu } from '../../context-menu/useContextMenu.js';
import SearchRun from '../ui/SearchRun.jsx';
import { NAV_H } from './treeKit.jsx';
// TEMPORARY icon picker — removed once the icon set is baked in. See IconPicker.jsx.
// Hooked inside ToolBtn (not per call site) so `extra` buttons and surface-owned
// ones passed through `children` are covered for free; the key is the tooltip.
import { useIconOverrides, resolveIconEl, openIconPicker } from '../IconPicker.jsx';
import {
  IconFileText, IconFolder, IconSort, IconCrosshair, IconCheck,
  IconChevronsDownUp, IconChevronsUpDown, IconHardDrive,
} from '../icons.jsx';

// Toolbar buttons are candy icon buttons (data-shape="icon") sized to the tree
// rows' height (NAV_H) so they read as candy pills like the folder/file rows. The
// header band is transparent, so they ride the sidebar's circuit texture.

// Exported so a surface can mount its OWN toolbar control (one that carries its
// own popover/state, e.g. TreeVaultSwitcher) through the `children` slot and still
// render the identical square candy icon button. `title` is optional — omit it for
// a button that should show no tooltip at all. onMouseDown/onKeyDown ride on the
// button itself so a menu trigger needs no wrapper (a wrapper breaks the run).
// `disabled` never fades the button: a see-through part reads as a hole in the
// fused run, so it stays fully painted and the click just no-ops (`tipDesc` can
// say why).
export function ToolBtn({ title, tipDesc, accent, onClick, onMouseDown, onKeyDown, disabled, dataAttr, active, activeAccent, children }) {
  const iconOverrides = useIconOverrides();
  const overrideKey = title ? `tree:${title}` : null;
  return (
    <button
      type="button" data-own-press title={title} data-tip-desc={tipDesc}
      onClick={disabled ? undefined : onClick} onMouseDown={onMouseDown} onKeyDown={onKeyDown}
      aria-disabled={disabled || undefined}
      onContextMenu={overrideKey ? (e) => { e.preventDefault(); openIconPicker(overrideKey, title); } : undefined}
      aria-pressed={active ? true : undefined}
      className={`candy-btn${active ? ' is-active' : ''}`} data-shape="icon"
      {...(dataAttr ? { ['data-' + dataAttr]: '' } : {})}
      style={{
        flexShrink: 0,
        // Size through --cbtn-size, never an inline width/height: the icon shape
        // derives its square + corner from it, and so does .candy-split's seam
        // (an inline size would beat the run's rules and break the seam). Depth = nav rows.
        '--cbtn-size': `${NAV_H}px`,
        '--cbtn-depth': 'var(--candy-depth-nav)',
        // An active toggle can override the fill colour (e.g. a red "live on" band):
        // is-active reads --accent, so a per-button activeAccent re-tints just this one.
        ...(accent ? { '--accent': accent } : {}),
        ...(active && activeAccent ? { '--accent': activeAccent } : {}),
      }}
    >
      <span className="candy-face">{overrideKey ? resolveIconEl(iconOverrides, overrideKey, children) : children}</span>
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
// extra = [{ title, icon, onClick, disabled?, dataAttr?, active?, activeAccent? }]
//   surface-specific icon buttons appended after the row; active holds the .is-active
//   fill (activeAccent re-tints it, e.g. red for a "live on" toggle)
// children = surface-owned toolbar controls (each rendering its own <ToolBtn/>),
//   appended after `extra` — for a control that needs its own popover/state.
// search = { value, onChange } → the run leads with a compact SearchRun field (a
//   square magnifier; clicking it slides every button out for typing room). The
//   surface owns the text and filters its own rows (treeSearch.js).
export default function TreeToolbar({ buttons, controller, accent, extra, search, children }) {
  const { openContextMenu } = useContextMenu();
  const b = buttons || {};
  const c = controller || {};
  const expanded = c.anyExpanded;

  // Drop the sort menu just below the button (a non-event caller → pass {x,y}).
  const onSort = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu({ x: r.left, y: r.bottom + 4 }, [
      { header: 'Sort Order' },
      ...(c.sortModes || []).map(([mode, label]) => ({
        label,
        icon: c.sortMode === mode ? IconCheck : undefined,
        onClick: () => c.setSortMode(mode),
      })),
    ], { accent });
  };

  const parts = (
    <>
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
          onClick={c.revealCurrent} disabled={!c.canReveal} tipDesc={c.canReveal ? undefined : 'Nothing open to show'}>
          <IconCrosshair/>
        </ToolBtn>
      )}
      {b.revealInFiles?.show && (
        <ToolBtn title={b.revealInFiles.title || 'Reveal in files'} accent={accent} onClick={b.revealInFiles.onClick}>
          {b.revealInFiles.icon || <IconHardDrive/>}
        </ToolBtn>
      )}
      {(extra || []).map((x, i) => (
        <ToolBtn key={i} title={x.title} accent={accent} onClick={x.onClick} disabled={!!x.disabled} dataAttr={x.dataAttr}
          active={!!x.active} activeAccent={x.activeAccent}>
          {x.icon}
        </ToolBtn>
      ))}
      {children}
    </>
  );

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      {search
        ? <SearchRun compact value={search.value} onChange={search.onChange} size={`${NAV_H}px`}
            onKeyDown={search.onKeyDown} inputRef={search.inputRef} placeholder={search.placeholder}>{parts}</SearchRun>
        : <div className="candy-split">{parts}</div>}
    </div>
  );
}
