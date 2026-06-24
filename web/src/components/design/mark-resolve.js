// Design Mode — element-level resolution for Markup/Edit modes.
//
// The aos-component-id Vite plugin stamps `data-aos-component` (the *enclosing
// component name*) + a unique `data-aos-source` on EVERY rendered element. So
// inside a single component (e.g. MusicPlayerWidget, built from plain div/button/span)
// every node shares the same component name — which is why the old
// `.closest('[data-aos-component]')` resolution always reported "MusicPlayerWidget".
//
// To mark "any and every" element we resolve the deepest node under the cursor
// directly. Named nodes are labelled from their own identity — data-aos-name
// (manual override), aria-label, title, or CSS class; anonymous nodes (inline-
// styled wrapper divs with none of those) get a synthesized tag-based label
// (e.g. "div 2") so they're still individually markable — they keep their own
// data-aos-source, so Edit still commits to the right line. A breadcrumb of the
// hit's named ancestors lets the user pick a shallower level (up to the whole
// component).

// Class tokens that describe state/behaviour, not identity — skipped when
// deriving a name from className.
const UTILITY_CLASS =
  /^(is-|has-|js-|aos-)|^(active|open|selected|dragging|hidden|disabled|hover|focus|pressed|loading|expanded|collapsed)$/;

function meaningfulClass(el) {
  // SVG elements expose className as SVGAnimatedString, not a string.
  const cls = typeof el.className === 'string' ? el.className : el.getAttribute?.('class') || '';
  for (const token of cls.trim().split(/\s+/)) {
    if (token && !UTILITY_CLASS.test(token)) return token;
  }
  return null;
}

function titleCase(token) {
  return token
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// A *specific* label identifies this element on its own — NOT the shared
// component name (which every element carries). Returns null when the element
// has no identity of its own (an anonymous, inline-styled wrapper).
export function specificLabel(el) {
  if (!el || el.nodeType !== 1) return null;
  const name = el.dataset?.aosName;
  if (name) return name;
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  const cls = meaningfulClass(el);
  if (cls) return titleCase(cls);
  return null;
}

// Synthesized identity for an anonymous element (no class/aria/title/aos-name):
// its tag, disambiguated by position among same-tag siblings, so distinct
// wrapper divs read as "div", "div 2", "div 3" instead of collapsing to the
// component name. The element keeps its own data-aos-source for Edit.
function syntheticLabel(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (sameTag.length <= 1) return tag;
  return `${tag} ${sameTag.indexOf(el) + 1}`;
}

// Display name for a crumb / mention: specific identity first, then a synthesized
// tag-based label (anonymous nodes), then the enclosing component, then raw tag.
export function resolveLabel(el) {
  return (
    specificLabel(el) ||
    syntheticLabel(el) ||
    el?.dataset?.aosComponent ||
    el?.tagName?.toLowerCase() ||
    'Unknown'
  );
}

// Whether an element carries its OWN identity (named) — used to choose which
// ancestors become breadcrumbs, NOT whether it can be marked (anything can).
function hasIdentity(el) {
  return !!el && el.nodeType === 1 && specificLabel(el) != null;
}

// Deepest element under the cursor — marked directly, even if anonymous (it gets
// a synthesized label + keeps its data-aos-source for Edit). Climbs only past
// non-element nodes. Respects the `[data-aos-no-mark]` opt-out used by the chat UI.
export function resolveTarget(hit) {
  if (!hit) return null;
  if (hit.closest?.('[data-aos-no-mark]')) return null;
  let el = hit;
  while (el && el.nodeType !== 1) el = el.parentElement;
  return el && el !== document.body ? el : null;
}

// Outermost element sharing target's component name, preferring the outermost
// *named* one — so the root crumb marks the visible container, not an
// invisible layout wrapper above it.
function componentRoot(el) {
  const name = el?.dataset?.aosComponent;
  if (!name) return el;
  let node = el;
  let outerNamed = hasIdentity(el) ? el : null;
  while (node.parentElement && node.parentElement.dataset?.aosComponent === name) {
    node = node.parentElement;
    if (hasIdentity(node)) outerNamed = node;
  }
  return outerNamed || node;
}

// Breadcrumb from the component root down to target: `[{ el, label }, ...]`.
// First crumb is the component (labelled by its component name, clicking it
// marks the whole thing); later crumbs are the target itself plus the *named*
// descendants on the path to it. e.g. [MusicPlayerWidget, AlbumCover] or
// [MusicPlayerWidget, Controls, div 2].
export function buildCrumbs(target) {
  if (!target || target.nodeType !== 1) return [];
  const root = componentRoot(target);
  const crumbs = [];
  let el = target;
  while (el && el !== root) {
    // Always include the target itself (deepest); above it, only named ancestors.
    if (el === target || hasIdentity(el)) crumbs.unshift({ el, label: resolveLabel(el) });
    el = el.parentElement;
  }
  crumbs.unshift({ el: root, label: root.dataset?.aosComponent || resolveLabel(root) });
  return crumbs;
}
