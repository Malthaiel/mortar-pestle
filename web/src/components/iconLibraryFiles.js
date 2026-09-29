// The whole Boxicons Filled folder as [[stem, markup], …]. Imported ONLY through
// iconLibrary.jsx's dynamic import(), so the 1,884 files land in their own chunk
// and never in the app bundle.

const raw = import.meta.glob('../assets/icons/filled/*.svg', { query: '?raw', import: 'default', eager: true });

export default Object.entries(raw)
  .map(([path, svg]) => [path.slice(path.lastIndexOf('/bx-') + 4, -4), svg.replace(/<!--[\s\S]*?-->/, '')])
  .sort((a, b) => a[0].localeCompare(b[0]));
