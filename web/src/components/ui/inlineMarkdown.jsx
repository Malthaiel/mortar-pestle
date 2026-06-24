// Minimal inline-markdown → React renderer: **bold** and *italic* / _italic_.
// No dependency. Used by the release / changelog surfaces (DocsReleasesTab,
// WhatsNewOverlay) that render Releases.md bullet text — which carries bold
// lead-in phrases and the occasional italic. `**bold**` is matched before
// `*italic*` by alternation order, so leading bold phrases parse correctly.
// Returns an array of strings + <strong>/<em> nodes, or the input untouched
// when falsy / markup-free.
export function renderInline(text) {
  if (!text) return text;
  const out = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] != null
      ? <strong key={k++}>{m[1]}</strong>
      : <em key={k++}>{m[2] ?? m[3]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
