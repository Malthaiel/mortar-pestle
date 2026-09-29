// Unified Vault View sidebar — a single recursive, Obsidian-style file tree
// (Vault File Tree feature). Replaces the former one-level super-section nav;
// the folder card/table views are gone, so this tree is the only vault nav.
//
// Citadel-shaped vault → two accent-always sections (KNOWLEDGE with a "+" New
// Domain circle + per-domain ⚙; INFRASTRUCTURE plain). Foreign vault → the
// vault's real top-level folders as neutral collapsible sections. The shape
// probe refetches on a `manifest` event (e.g. after a vault switch + reindex).

import { useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.js';
import VaultTree from './vault-tree/VaultTree.jsx';
import { ROOTS_CHANGED } from './vault-tree/useVaultTree.js';

// `fixed: true` marks a STRUCTURAL section the drag-to-move tree must refuse to
// pick up: routing, section memory and the manifest all hardcode the Knowledge/ and
// Infrastructure/ prefixes, so relocating one would break those paths. Every other
// root folder — user-made in a Citadel vault, or any top folder of a foreign vault —
// is an ordinary folder and drags like one.
const CITADEL_SECTIONS = [
  { key: 'knowledge', label: 'Knowledge', section: 'Knowledge', icon: 'IconBrain', fixed: true, accentAlways: true, chipDomains: true, gearDomains: true, add: 'domain' },
  { key: 'infrastructure', label: 'Infrastructure', section: 'Infrastructure', icon: 'IconServer', fixed: true, accentAlways: true, chipDomains: true,
    // Pinned virtual leaf: the interactive Update Queue view has no .md file, so
    // it's surfaced here as a fixed entry that routes to /vault/infrastructure/update-queue.
    pins: [{ label: 'Update Queue', hash: '/vault/infrastructure/update-queue', icon: 'IconChecklist' }] },
];

export default function VaultSidebar({ route, accent }) {
  const [shape, setShape] = useState(null);
  const [rootFolders, setRootFolders] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.vaults.shape().then((s) => { if (!cancelled) setShape(s); }).catch(() => {});
      // Root-level folders → extra sections (so a folder created at the vault root
      // is visible). scan_dir skips dotfolders, so today this is just Knowledge/
      // Infrastructure; it grows when the toolbar's New folder creates one.
      api.getVaultFolder('', '').then((res) => { if (!cancelled) setRootFolders(res?.subfolders || []); }).catch(() => {});
    };
    load();
    const unsub = subscribeEvents((name) => { if (name === 'manifest') load(); });
    // A foreign vault never emits `manifest`, so the tree announces root changes itself.
    window.addEventListener(ROOTS_CHANGED, load);
    return () => { cancelled = true; unsub(); window.removeEventListener(ROOTS_CHANGED, load); };
  }, []);

  // Foreign (non-Citadel, unmapped) vault → its real top folders as sections.
  const foreign = shape && !shape.citadelShaped && !shape.mapped;
  // Citadel vault → the two fixed sections plus any other real root folder
  // (e.g. one just created at root), rendered as plain collapsible sections.
  const extraRoots = rootFolders
    .filter((f) => f.name !== 'Knowledge' && f.name !== 'Infrastructure')
    .map((f) => ({ key: 'root:' + f.name, label: f.name, section: f.name }));
  const sections = foreign
    ? (shape.topFolders || []).map((f) => ({ key: f.name, label: f.name, section: f.name }))
    : [...CITADEL_SECTIONS, ...extraRoots];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      <VaultTree sections={sections} route={route} accent={accent}/>
    </div>
  );
}
