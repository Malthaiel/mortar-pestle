// DEV vertical-rhythm auditor — the spacing counterpart to candyCenterAudit.js.
//
// candyCenterAudit answers ONE question — "is this button optically centered
// against the TEXT beside it" — so it only looks at centered rows and skips any
// row with no flat-text sibling. This one asks a different question and skips
// NOTHING: for every vertically-stacking container it measures each child row's
// layout height, the downward candy shadow band it (or a candy button inside it)
// casts BELOW its box, the resulting VISUAL height, and the gap to the next row.
//
// The band is the whole point. The candy depth lip is a box-shadow drawn OUTSIDE
// layout, so getBoundingClientRect — and therefore the naive "measure the gaps"
// snippet — drops it entirely. That dropped ink is exactly the vertical space the
// eye reads as "too tall / too far apart" while the numbers swear it's fine. This
// audit adds it back: `band` = how far a row's shadow overhangs its border-box,
// `visualH` = box + band, `gapAfterBand` = the real whitespace left to the next
// row (negative → the shadow is overlapping the next row). A band that overruns
// its gap is flagged.
//
// Never shipped to prod: imported only behind import.meta.env.DEV in main.jsx.
// Run `spacingAudit()` in any webview console, including the overlay host, or
// `copy(spacingAudit())` to grab the whole report as JSON.

const TOL = 1.0; // px — absorbs sub-pixel rounding

// Downward box-shadow offset (px) — the candy depth band. First shadow layer's
// offset-y, clamped to >=0 (only a downward lip adds visible height). Same layer
// candyCenterAudit reads for its optical-centre correction.
function shadowDown(cs) {
  const sh = cs.boxShadow;
  if (!sh || sh === 'none') return 0;
  const m = sh.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/); // first layer: offset-x offset-y
  return m ? Math.max(0, parseFloat(m[2])) : 0;
}

// Lowest painted pixel of `el`: its border-box bottom plus its own shadow, OR
// that of any candy button inside it — buttons sit on the row's baseline and their
// bands overhang below the row's border-box, which the row's own rect never sees.
function visualBottom(el) {
  let low = el.getBoundingClientRect().bottom + shadowDown(getComputedStyle(el));
  for (const btn of el.querySelectorAll('.candy-btn')) {
    const b = btn.getBoundingClientRect().bottom + shadowDown(getComputedStyle(btn));
    if (b > low) low = b;
  }
  return low;
}

const isVStack = (cs) =>
  (cs.display.includes('flex') && cs.flexDirection.startsWith('column')) ||
  (cs.display.includes('grid') && cs.gridTemplateColumns === 'none');

export function spacingAudit(root = document.body, { quiet = false } = {}) {
  const flags = [];
  const stacks = [];
  for (const cont of [root, ...root.querySelectorAll('*')]) {
    const cs = getComputedStyle(cont);
    if (!isVStack(cs)) continue;
    const kids = [...cont.children].filter((c) => c.getBoundingClientRect().height > 0);
    if (kids.length < 2) continue;
    const cssGap = parseFloat(cs.rowGap) || 0;
    const rows = kids.map((k, i) => {
      const r = k.getBoundingClientRect();
      const band = +(visualBottom(k) - r.bottom).toFixed(1);
      const next = kids[i + 1];
      const gap = next ? +(next.getBoundingClientRect().top - r.bottom).toFixed(1) : null;       // border-box gap
      const gapAfterBand = next ? +(gap - band).toFixed(1) : null;                                // whitespace past the band
      if (gapAfterBand != null && gapAfterBand < -TOL) {
        flags.push({ el: k, cls: k.className || k.tagName.toLowerCase(), band, gap, overlap: +(-gapAfterBand).toFixed(1) });
      }
      return { row: k.className || k.tagName.toLowerCase(), h: +r.height.toFixed(1), band, visualH: +(r.height + band).toFixed(1), gap, gapAfterBand };
    });
    stacks.push({ stack: cont.className || cont.tagName.toLowerCase(), cssGap, rows });
  }
  if (!quiet || flags.length) {
    // Plain-text block (not console.table) so the whole thing selects + copies as
    // one paste — collapsed tables and console.table don't survive a copy.
    const pad = (v, n) => String(v ?? '—').padEnd(n);
    const out = [`spacing audit — ${stacks.length} stack(s), ${flags.length} band-overrun(s)`];
    if (!quiet) for (const s of stacks) {
      out.push('', `[${s.stack}]  row-gap ${s.cssGap}px  (${s.rows.length} rows)`);
      out.push('  ' + pad('row', 26) + pad('h', 7) + pad('band', 7) + pad('visualH', 9) + pad('gap', 7) + 'after');
      for (const r of s.rows) {
        out.push('  ' + pad(String(r.row).slice(0, 24), 26) + pad(r.h, 7) + pad(r.band, 7) + pad(r.visualH, 9) + pad(r.gap, 7) + pad(r.gapAfterBand, 7));
      }
    }
    for (const f of flags) out.push(`  ! ${f.cls}: band ${f.band}px overruns its ${f.gap}px gap (overlap ${f.overlap}px)`);
    console.log(out.join('\n'));
  }
  return { flags: flags.map(({ el, ...rest }) => rest), stacks };
}

let timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; spacingAudit(document.body, { quiet: true }); }, 400);
}

// Expose window.spacingAudit() for manual runs; loud once after settle, then quiet
// re-audits on DOM changes (only band-overruns print thereafter). Parallels
// startCandyCenterAudit so both verifiers wire in the same way.
export function startSpacingAudit() {
  if (typeof window === 'undefined') return;
  window.spacingAudit = spacingAudit;
  const first = () => setTimeout(() => spacingAudit(), 700);
  if (document.readyState === 'complete') first();
  else window.addEventListener('load', first, { once: true });
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
