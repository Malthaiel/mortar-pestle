// The whole Boxicons Filled folder (web/src/assets/icons/filled, 1,884 files) for
// the right-click icon pickers. icons.jsx carries only the icons the app names —
// it is imported with `import * as`, so everything in it ships — while the folder
// arrives here as ONE lazy chunk (iconLibraryFiles.js), the first time a picker
// opens. A folder pick is saved as its SVG markup; svgComponent draws it back.

import { useEffect, useState } from 'react';

let files = null;
let pending = null;

// → [[stem, markup], …] sorted by stem ('plus-big', '<svg …>').
export function loadIconLibrary() {
  pending ||= import('./iconLibraryFiles.js').then((m) => (files = m.default));
  return pending;
}

// The folder once it has loaded ([] until then), so a picker can draw the app's
// own icons immediately and append the folder a moment later. `open` = false for
// a picker that stays mounted while shut, so nothing loads until it opens.
export function useIconLibrary(open = true) {
  const [list, setList] = useState(files);
  useEffect(() => { if (open && !files) loadIconLibrary().then(setList); }, [open]);
  return list || [];
}

// Markup is re-framed to the requested size; a source with no `fill` of its own
// takes currentColor, so it follows the text like every pack icon.
export const sizeSvg = (markup, size) => markup
  .replace(/\swidth="[^"]*"/i, '')
  .replace(/\sheight="[^"]*"/i, '')
  .replace(/<svg/i, `<svg width="${size}" height="${size}" fill="currentColor"`);

// One component per distinct markup string, so a re-render doesn't hand React a
// brand-new component type and remount the icon on every paint.
const svgComponents = new Map();
export function svgComponent(markup) {
  let C = svgComponents.get(markup);
  if (!C) {
    C = ({ size = 18 }) => (
      <span
        style={{ display: 'inline-flex', width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: sizeSvg(markup, size) }}
      />
    );
    svgComponents.set(markup, C);
  }
  return C;
}

// What a picker's search matches: 'IconBookOpen' → 'book open', 'plus-big' → 'plus big'.
export const iconWords = (name) => name.replace(/^Icon/, '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/-/g, ' ').toLowerCase();

export const isMarkup = (value) => typeof value === 'string' && value.trim().startsWith('<');
