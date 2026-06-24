// The two non-button items the dock order can contain, inserted via the dock
// right-click menu (see Dock.jsx). Both are plain divs so DraggableSidebarList
// treats them as ordinary drag items (under dragFromInteractive it only blocks
// inputs / [data-no-drag]); each carries onContextMenu so it can be removed in
// place. Styling lives in styles.css (.dock-sep / .dock-spacer).
//
//   DockSeparator — a fixed ~24px vertical hairline that visually groups icons.
//   DockSpacer    — an invisible flex:1 zone divider; the grow lives on the list
//                   wrapper (Dock.jsx getItemStyle), this node is the right-click
//                   hit area and pushes neighbours toward the dock edges.

export function DockSeparator({ id, onContextMenu }) {
  return (
    <div
      className="dock-sep"
      data-dock-special="sep"
      onContextMenu={(e) => onContextMenu?.(e, id)}
      aria-hidden
    />
  );
}

export function DockSpacer({ id, onContextMenu }) {
  return (
    <div
      className="dock-spacer"
      data-dock-special="spacer"
      onContextMenu={(e) => onContextMenu?.(e, id)}
      aria-hidden
    />
  );
}
