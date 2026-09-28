// Sidebar search (Tree Sidebar Search, 2026-09-25) — which rows of a tree stay
// while a search is typed into TreeToolbar's field. A row stays when its name
// holds the text, or when it is a folder with such a row somewhere inside; those
// folders are also forced open. A folder that matches by NAME only keeps its own
// open state and shows everything in it. Pure and shape-agnostic: each tree says
// how to read a node.

export const hit = (text, q) => typeof text === 'string' && text.toLowerCase().includes(q.trim().toLowerCase());

// -> { keep, open }: Sets of node ids to show / folders to force open.
// `match(n)` (optional) replaces the name test, for a tree whose search finds
// things other than its row names (the Settings tree keeps the pages holding a
// matching setting).
export function searchTree(roots, q, { id, text, kids, match }) {
  const keep = new Set(), open = new Set();
  const visit = (n) => {
    const inside = (kids(n) || []).map(visit).some(Boolean); // map, not some: every branch
    if (inside) open.add(id(n));
    const k = inside || (match ? match(n) : hit(text(n), q));
    if (k) keep.add(id(n));
    return k;
  };
  (roots || []).forEach(visit);
  return { keep, open };
}

// A lazy (disk-backed) tree seen through a search: same surface as the tree hook
// (isOpen / childrenOf / ...), filtered. `raw` is the unfiltered tree for code
// that must see every child (a name-collision check). Nodes are keyed by vaultPath.
export function searchView(tree, q, roots) {
  if (!q.trim()) return { view: tree, keep: null };
  const { keep, open } = searchTree(roots, q, {
    id: (n) => n.vaultPath,
    text: (n) => n.title || n.name,
    kids: (n) => n.isFolder && tree.childrenOf(n.vaultPath)?.nodes,
  });
  const childrenOf = (vp) => {
    const e = tree.childrenOf(vp);
    return open.has(vp) && e?.nodes ? { ...e, nodes: e.nodes.filter((n) => keep.has(n.vaultPath)) } : e;
  };
  return { keep, view: { ...tree, raw: tree, childrenOf, isOpen: (vp) => open.has(vp) || tree.isOpen(vp) } };
}

// Lists every folder under `frontier` level by level (parallel per level), so a
// search can see inside folders nobody opened. `list(vp)` resolves to a folder's
// child nodes. -> { [vaultPath]: nodes }; a folder that failed to list is left out.
export async function walkFolders(frontier, list) {
  const out = {};
  while (frontier.length) {
    const lists = await Promise.all(frontier.map((vp) => list(vp).then((nodes) => (out[vp] = nodes), () => [])));
    frontier = lists.flat().filter((n) => n.isFolder).map((n) => n.vaultPath);
  }
  return out;
}

// Folds a walk into a { [vaultPath]: { loading, nodes } } cache without
// replacing any entry that already has nodes.
export const mergeWalk = (cache, got) => {
  const next = { ...cache };
  for (const [vp, nodes] of Object.entries(got)) if (!cache[vp]?.nodes) next[vp] = { loading: false, nodes };
  return next;
};
