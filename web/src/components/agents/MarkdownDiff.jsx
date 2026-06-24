// SF6 — inline unified line-diff for the organize-md recipe's confirm tray.
// Hand-rolled LCS (no new dependency); var-token + mono styling to match
// PendingEditsTray. Inline (not side-by-side) suits the narrow floating window.
// Apply / Discard live here so a recipe's renderConfirm is self-contained.

// O(m·n) LCS — fine for typical notes. Guard against pathologically large
// inputs (a whole-file rewrite of a huge note) so the DP can't lock the UI;
// past the cap we skip the alignment and show a plain before→after summary.
const MAX_CELLS = 4_000_000; // ~2000 × 2000 lines

function lineDiff(before, after) {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');
  const m = a.length, n = b.length;
  if (m * n > MAX_CELLS) return null; // too big — caller renders the fallback
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { rows.push({ t: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: 'del', text: a[i] }); i++; }
    else { rows.push({ t: 'add', text: b[j] }); j++; }
  }
  while (i < m) rows.push({ t: 'del', text: a[i++] });
  while (j < n) rows.push({ t: 'add', text: b[j++] });
  return rows;
}

const ROW_STYLE = {
  add: { bg: 'color-mix(in oklch, #4fae6e 16%, transparent)', fg: 'var(--text)', gutter: '+', gutterFg: '#3f9c5e' },
  del: { bg: 'color-mix(in oklch, var(--error) 14%, transparent)', fg: 'var(--text-muted)', gutter: '-', gutterFg: 'var(--error)' },
  ctx: { bg: 'transparent', fg: 'var(--text-faint)', gutter: ' ', gutterFg: 'var(--text-faint)' },
};

export default function MarkdownDiff({ before, after, onApply, onDiscard, applying = false }) {
  const rows = lineDiff(before, after);
  const adds = rows ? rows.filter((r) => r.t === 'add').length : (after || '').split('\n').length;
  const dels = rows ? rows.filter((r) => r.t === 'del').length : (before || '').split('\n').length;
  const noChange = rows && adds === 0 && dels === 0;

  return (
    <div data-aos-no-mark style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)', fontSize: 10,
        color: 'var(--text-faint)',
        borderBottom: '1px solid var(--border-soft)',
      }}>
        <span style={{ color: '#3f9c5e' }}>+{adds}</span>
        <span style={{ color: 'var(--error)' }}>−{dels}</span>
        {noChange && <span>· no changes</span>}
      </div>

      <div style={{ overflow: 'auto', maxHeight: 280, fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5 }}>
        {rows ? (
          rows.map((r, i) => {
            const s = ROW_STYLE[r.t];
            return (
              <div key={i} style={{ display: 'flex', background: s.bg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                <span style={{ width: 16, flexShrink: 0, textAlign: 'center', color: s.gutterFg, userSelect: 'none' }}>{s.gutter}</span>
                <span style={{ flex: 1, minWidth: 0, color: s.fg, paddingRight: 8 }}>{r.text || ' '}</span>
              </div>
            );
          })
        ) : (
          <div style={{ padding: '10px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
            File is large — showing the reorganized result (line-by-line diff skipped). Apply replaces the file in place; the original is recoverable from the recycle bin.
            <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>{after}</pre>
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', justifyContent: 'flex-end', gap: 6,
        padding: '8px 10px', borderTop: '1px solid var(--border-soft)',
      }}>
        <button
          type="button"
          onClick={onDiscard}
          disabled={applying}
          style={{
            padding: '4px 10px', background: 'transparent', color: 'var(--text-muted)',
            border: '1px solid var(--border-soft)', borderRadius: 6,
            fontSize: 11, fontWeight: 600, cursor: applying ? 'default' : 'pointer',
            fontFamily: 'var(--font-mono)', opacity: applying ? 0.5 : 1,
          }}
        >Discard</button>
        <button
          type="button"
          onClick={onApply}
          disabled={applying || noChange}
          title={noChange ? 'No changes to apply' : 'Overwrite the file (original goes to the recycle bin)'}
          style={{
            padding: '4px 12px', background: (applying || noChange) ? 'var(--surface-2)' : 'var(--text)',
            color: (applying || noChange) ? 'var(--text-faint)' : '#fff',
            border: 'none', borderRadius: 6,
            fontSize: 11, fontWeight: 700, cursor: (applying || noChange) ? 'default' : 'pointer',
            fontFamily: 'var(--font-mono)',
          }}
        >{applying ? 'Applying…' : 'Apply'}</button>
      </div>
    </div>
  );
}
