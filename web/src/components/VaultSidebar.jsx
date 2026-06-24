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

const CITADEL_SECTIONS = [
  { key: 'knowledge', label: 'Knowledge', section: 'Knowledge', accentAlways: true, chipDomains: true, gearDomains: true, add: 'domain' },
  { key: 'infrastructure', label: 'Infrastructure', section: 'Infrastructure', accentAlways: true, chipDomains: true,
    // Pinned virtual leaf: the interactive Update Queue view has no .md file, so
    // it's surfaced here as a fixed entry that routes to /vault/infrastructure/update-queue.
    pins: [{ label: 'Update Queue', hash: '/vault/infrastructure/update-queue' }] },
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
    return () => { cancelled = true; unsub(); };
  }, []);

  // Foreign (non-Citadel, unmapped) vault → its real top folders as sections.
  const foreign = shape && !shape.citadelShaped && !shape.mapped;
  // Citadel vault → the two fixed sections plus any other real root folder
  // (e.g. one just created at root), rendered as plain collapsible sections.
  const extraRoots = rootFolders
    .filter((f) => f.name !== 'Knowledge' && f.name !== 'Infrastructure')
    .map((f) => ({ key: 'root:' + f.name, label: f.name, section: f.name, deletable: true }));
  const sections = foreign
    ? (shape.topFolders || []).map((f) => ({ key: f.name, label: f.name, section: f.name }))
    : [...CITADEL_SECTIONS, ...extraRoots];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      <VaultTree sections={sections} route={route} accent={accent}/>
    </div>
  );
}
