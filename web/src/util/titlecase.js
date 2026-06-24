// Smart title case for block titles: minor words stay lowercase unless first
// or last — "take out the trash" → "Take Out the Trash". Interior casing of
// other words is preserved (acronym-safe).
const MINOR = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'on', 'at', 'to', 'by', 'of', 'in']);

export function smartTitleCase(title) {
  const words = String(title).split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    if (i !== 0 && i !== words.length - 1 && MINOR.has(w.toLowerCase())) return w.toLowerCase();
    return w[0].toUpperCase() + w.slice(1);
  }).join(' ');
}
