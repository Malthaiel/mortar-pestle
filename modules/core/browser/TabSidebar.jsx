// Browser left sidebar (renderSecondary) — the shared candy tree style: the
// config-driven TreeToolbar on top, then ungrouped tabs as leaf rows followed by
// in-memory tab groups (Chrome/Firefox-style folders) rendered with treeKit's
// CandyHeader + Collapsible + StaggerChild + TreeChildren. Tab rows keep their
// favicon + hover-× (a sibling overlay, since the candy face is pointer-events
// :none) and are pointer-draggable into groups (useTabDrag) or reorderable;
// right-click moves a tab between groups. The bottom "+" chip stays. Folder
// collapse lives on the folder object in the store; sort is display-only.

import { useState } from 'react';
import { useTabStore } from './useTabStore.js';
import { hostOf } from './tabStore.js';
import * as store from './tabStore.js';
import { useTabDrag } from './useTabDrag.js';
import { IconGlobe, IconX, IconPlus } from '@host/components/icons.jsx';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { useSettings } from '@host/hooks/useSettings.js';
import TreeToolbar from '@host/components/vault-tree/TreeToolbar.jsx';
import NameInputModal from '@host/components/vault-tree/NameInputModal.jsx';
import { usePersistedState } from '@host/components/vault-tree/useTreeExpansion.js';
import {
  AnimCtx, SuffixCtx, REVEAL, GAP, NAV_H,
  CandyHeader, Collapsible, StaggerChild, TreeChildren,
} from '@host/components/vault-tree/treeKit.jsx';

const SORT_MODES = [
  ['order',     'Manual order'],
  ['name-asc',  'Title (A → Z)'],
  ['name-desc', 'Title (Z → A)'],
  ['domain',    'By domain'],
  ['recency',   'Recently used'],
];

const titleOf = (t) => t.title || hostOf(t.url) || 'New tab';

function sortTabs(list, mode) {
  if (mode === 'order') return list;
  const arr = list.slice();
  if (mode === 'name-asc')  arr.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  else if (mode === 'name-desc') arr.sort((a, b) => titleOf(b).localeCompare(titleOf(a)));
  else if (mode === 'domain')    arr.sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url)));
  else if (mode === 'recency')   arr.sort((a, b) => store.tabRecency(b.id) - store.tabRecency(a.id));
  return arr;
}

export default function TabSidebar({ api, accent }) {
  const { tabs, activeId, folders } = useTabStore();
  const { settings } = useSettings();
  const { openContextMenu } = useContextMenu();
  const { drag, startDrag } = useTabDrag();
  const [sortMode, setSortMode] = usePersistedState('browser:tree:sort', 'order');
  const [modal, setModal] = useState(null);
  const anim = REVEAL[settings.vaultTreeReveal] || REVEAL.normal;

  const closeTab = (id) => { store.closeTab(id); api.invoke('browser_close_tab', { id }).catch(() => {}); };

  const topLevel = sortTabs(tabs.filter((t) => !t.folderId), sortMode);
  const groupTabs = (fid) => sortTabs(tabs.filter((t) => t.folderId === fid), sortMode);

  const anyExpanded = folders.some((f) => !f.collapsed);
  const controller = {
    sortMode, setSortMode, sortModes: SORT_MODES,
    anyExpanded,
    expandAll: () => folders.forEach((f) => { if (f.collapsed) store.toggleFolder(f.id); }),
    collapseAll: () => folders.forEach((f) => { if (!f.collapsed) store.toggleFolder(f.id); }),
    canReveal: !!activeId,
    revealCurrent: () => {
      const act = tabs.find((t) => t.id === activeId);
      if (act?.folderId) {
        const f = folders.find((x) => x.id === act.folderId);
        if (f?.collapsed) store.toggleFolder(f.id);
      }
      setTimeout(() => {
        const el = document.querySelector('[data-current-file="true"]');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 280);
    },
  };

  const buttons = {
    new:           { show: true, title: 'New tab', icon: <IconPlus/>, onClick: () => store.newTab() },
    newFolder:     { show: true, title: 'New tab group', onClick: () => store.createFolder() },
    sort:          { show: true },
    collapse:      { show: true },
    revealCurrent: { show: true, title: 'Reveal active tab' },
    revealInFiles: { show: false },
  };

  const tabMenu = (e, tab) => {
    const items = [
      { label: 'Close tab', onClick: () => closeTab(tab.id) },
      { divider: true },
      ...folders.filter((f) => f.id !== tab.folderId)
        .map((f) => ({ label: `Move to ${f.name}`, onClick: () => store.moveTab(tab.id, f.id) })),
      ...(tab.folderId ? [{ label: 'Move to top level', onClick: () => store.moveTab(tab.id, null) }] : []),
      { label: 'New group with tab', onClick: () => { const id = store.createFolder(); store.moveTab(tab.id, id); } },
    ];
    openContextMenu(e, items, { accent });
  };
  const folderMenu = (e, folder) => {
    openContextMenu(e, [
      { label: 'Rename group', onClick: () => setModal({ kind: 'rename-folder', folder }) },
      { label: 'Delete group', onClick: () => store.deleteFolder(folder.id) },
    ], { accent });
  };

  const renderRow = (t, inFolder) => (
    <TabRow
      key={t.id} tab={t} accent={accent} active={t.id === activeId}
      dragging={drag?.tabId === t.id}
      dropBefore={drag?.target?.kind === 'before-tab' && drag.target.beforeId === t.id}
      onClick={() => store.switchTab(t.id)} onClose={() => closeTab(t.id)}
      onContextMenu={(e) => tabMenu(e, t)} onPointerDown={(e) => startDrag(t, e)}
    />
  );

  return (
    <AnimCtx.Provider value={anim}>
    <SuffixCtx.Provider value={false}>
      <div style={shell}>
        <style>{TAB_CSS}</style>
        <div style={{ flexShrink: 0, padding: `8px 8px ${GAP}` }}>
          <TreeToolbar buttons={buttons} controller={controller} accent={accent}/>
        </div>
        <div data-top-level-drop style={list}>
          {topLevel.map((t) => renderRow(t, false))}

          {folders.map((f) => {
            const fts = groupTabs(f.id);
            const open = !f.collapsed;
            const isDrop = drag?.target?.kind === 'into-folder' && drag.target.folderId === f.id;
            return (
              <div key={f.id} data-folder-drop={f.id} style={{
                display: 'flex', flexDirection: 'column',
                ...(isDrop ? { outline: '2px solid var(--accent)', outlineOffset: 2, borderRadius: 12 } : {}),
              }}>
                <CandyHeader
                  label={f.name} open={open} accent={accent}
                  onToggle={() => store.toggleFolder(f.id)} onContextMenu={(e) => folderMenu(e, f)}
                  trailing={<span style={{ opacity: 0.5, fontSize: 9 }}>{fts.length}</span>}
                />
                <Collapsible open={open} count={fts.length}>
                  <TreeChildren>
                    {fts.length === 0
                      ? <div style={EMPTY}>empty — drop tabs here</div>
                      : fts.map((t, i) => (
                        <StaggerChild key={t.id} index={i} count={fts.length} open={open}>
                          {renderRow(t, true)}
                        </StaggerChild>
                      ))}
                  </TreeChildren>
                </Collapsible>
              </div>
            );
          })}

          <div style={plusWrap}>
            <button
              type="button" className="candy-btn" data-shape="chip" data-own-press
              title="New tab" aria-label="New tab" onClick={() => store.newTab()}
              style={{ '--cbtn-depth': 'var(--candy-depth-nav)', ...(accent ? { '--accent': accent } : {}) }}
            >
              <span className="candy-face" style={{ padding: '4px 12px' }}><IconPlus size={14}/></span>
            </button>
          </div>
          <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
        </div>
      </div>

      {drag && (
        <div style={{
          position: 'fixed', left: drag.x + 12, top: drag.y + 10, zIndex: 9999, pointerEvents: 'none',
          background: 'var(--bg, #1b1b1f)', color: 'var(--text, #eee)',
          border: '1px solid var(--accent)', borderRadius: 999, padding: '4px 11px',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
          maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          boxShadow: '0 6px 16px rgba(0,0,0,0.35)',
        }}>{drag.label}</div>
      )}

      {modal?.kind === 'rename-folder' && (
        <NameInputModal open title={`Rename ${modal.folder.name}`} label="Group name" confirmLabel="Rename"
          initialValue={modal.folder.name}
          onCancel={() => setModal(null)}
          onSubmit={(name) => { setModal(null); store.renameFolder(modal.folder.id, name); }}/>
      )}
    </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}

// A <button> can't nest inside the row <button> (invalid HTML) and the candy face
// is pointer-events:none, so the close × is a sibling candy icon button overlaying
// the row's right edge. The relative wrapper carries data-tab-id/data-folder-id
// (drag drop-target resolution) + the dragging/drop visual; the row button keeps
// the pointer-drag start + middle-click close. Hug-width like the vault rows.
function TabRow({ tab, accent, active, dragging, dropBefore, onClick, onClose, onContextMenu, onPointerDown }) {
  return (
    <div
      className="aos-tab-row" data-tab-id={tab.id} data-folder-id={tab.folderId || undefined}
      style={{
        position: 'relative', alignSelf: 'flex-start', width: 'fit-content', maxWidth: '100%',
        opacity: dragging ? 0.4 : 1,
        ...(dropBefore ? { boxShadow: 'inset 0 2px 0 0 var(--accent)' } : {}),
      }}
    >
      <button
        type="button" className={`candy-btn${active ? ' is-active' : ''}`} data-shape="row" data-own-press
        data-current-file={active ? 'true' : undefined}
        onPointerDown={onPointerDown} onClick={onClick} onContextMenu={onContextMenu}
        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
        title={titleOf(tab)}
        style={{ '--cbtn-depth': 'var(--candy-depth-nav)', ...(accent ? { '--accent': accent } : {}), borderRadius: 999 }}
      >
        <span className="candy-face" style={{
          justifyContent: 'flex-start', gap: 6, minWidth: 0,
          minHeight: NAV_H, boxSizing: 'border-box', padding: '0 28px 0 11px',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          <span style={favWrap}>
            {tab.favicon
              ? <img src={tab.favicon} width={16} height={16} alt="" style={{ borderRadius: 3 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              : <IconGlobe size={14} />}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{titleOf(tab)}</span>
        </span>
      </button>
      <button
        type="button" className="candy-btn aos-tab-x" data-shape="icon" data-own-press
        aria-label="Close tab" title="Close tab"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
        style={closeX}
      >
        <span className="candy-face"><IconX /></span>
      </button>
    </div>
  );
}

const shell = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)' };
const list = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: GAP, padding: '0 8px' };
const plusWrap = { display: 'grid', placeItems: 'center', padding: '4px 0 2px' };
const favWrap = { flexShrink: 0, width: 16, height: 16, display: 'grid', placeItems: 'center' };
const EMPTY = { fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', padding: '4px 12px' };
const closeX = { position: 'absolute', right: 5, top: 0, bottom: 0, margin: 'auto 0', width: 18, height: 18, minWidth: 0, borderRadius: 6, cursor: 'pointer' };

const TAB_CSS = `
.aos-tab-row .aos-tab-x {
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 120ms ease,
    box-shadow 150ms cubic-bezier(0, 0, 0.58, 1);
}
.aos-tab-row:hover .aos-tab-x { opacity: 1; pointer-events: auto; }
`;
