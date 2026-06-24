export function groupItems(items, groupBy, getValue) {
  if (!groupBy?.field) return null;
  const groups = new Map();
  for (const item of items) {
    const v = getValue(item, groupBy.field);
    const key = (v == null || v === '')
      ? null
      : (Array.isArray(v) ? v.join(', ') : String(v));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const noneItems = groups.get(null);
  groups.delete(null);
  const sign = groupBy.order === 'desc' ? -1 : 1;
  const sortedKeys = [...groups.keys()].sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }) * sign,
  );
  const result = sortedKeys.map(k => ({ key: k, items: groups.get(k) }));
  if (noneItems?.length) result.push({ key: null, items: noneItems });
  return result;
}
