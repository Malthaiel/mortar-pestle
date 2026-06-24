// Settings Drawer Rework SF12 — build-only manifest of per-module bundle
// weight. generateBundle walks every emitted chunk and attributes each
// chunk-module's renderedLength to the module id in its
// /modules/(core|studio)/<id>/ path, then emits module-sizes.json into the
// bundle root. The Modules settings cards fetch it over the app:// asset
// scheme; dev builds have no bundle, so the cards show "—" there.

const MODULE_PATH_RE = /[/\\]modules[/\\](?:core|studio)[/\\]([^/\\]+)[/\\]/;

export default function moduleSizes() {
  return {
    name: 'module-sizes',
    apply: 'build',
    generateBundle(_options, bundle) {
      const sizes = {};
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.modules) continue;
        for (const [modId, info] of Object.entries(chunk.modules)) {
          const m = MODULE_PATH_RE.exec(modId);
          if (!m) continue;
          sizes[m[1]] = (sizes[m[1]] || 0) + (info.renderedLength || 0);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'module-sizes.json',
        source: JSON.stringify(sizes, null, 2),
      });
    },
  };
}
