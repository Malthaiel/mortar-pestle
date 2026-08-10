// DEV side-by-side auditor — the third static checker, and the one whose absence
// cost the Planner Button Sizing chat (2026-08-10).
//
// The two existing static audits both look PAST the inside of a row:
//   candyCenterAudit — is a button level with the flat TEXT beside it. A row of
//                      pure buttons has no text sibling, so it is skipped whole.
//   spacingAudit     — is the gap between STACKED rows honest. Never looks within.
// So "the buttons sitting side by side don't match each other" — the single most
// reported visual fault in this app — had no checker at all. Six edits shipped
// against it with zero measurements and it was still fully present afterwards
// (30px close button, 23px task icons, 24px chips, 14px squeezed seg labels).
//
// Four faults, all measured, never predicted:
//   HEIGHT  border-box heights in one visual row disagree
//   BOTTOM  heights agree but PAINTED bottoms don't — the candy depth lip is a
//           box-shadow outside layout, so a .candy-seg (full --candy-depth 7px)
//           hangs 2px below a chip (--candy-depth-small 5px) at identical height.
//           A plain height check calls that row perfect. This is the blind spot.
//   GAP     the spaces between neighbours in one row disagree
//   EGG     a round control whose width and height differ — a circle pinned by
//           height alone with its width left free renders as an oval
//
// Every offender carries hFrom: 'INLINE 30px' or 'css'. That word is the fix.
// A size written on the tag beats any stylesheet rule without !important, so a
// scoped "every button in here is 24" rule silently loses on exactly the buttons
// that look wrong — invisible in the source, obvious in this field.
//
// ROWS ARE MEASURED, NOT ASSUMED: controls are grouped by actual vertical
// overlap of their rects, not by shared parent. A wrapped flex row is therefore
// several rows (correct — wrapped lines don't share a baseline), and inline-flex
// controls in a non-flex parent are still caught.
//
// Opt out a deliberately mixed row with data-spacing-intent on the row or on any
// control in it — the same attribute spacingAudit already honours, not a new one.
//
// Never shipped to prod: imported only behind import.meta.env.DEV in main.jsx.
// Run `rowAudit()` in any webview console; `rowSelfTest()` to prove the checker.

import { postAudit } from './auditBridge.js';

const TOL = 1.0;                       // px — absorbs sub-pixel rounding
const CTRL = '.candy-btn, .candy-seg';

// Downward lip = first box-shadow layer's offset-y, clamped >= 0. Same layer
// spacingAudit and candyCenterAudit read; inset paints inward so contributes 0.
function lipDown(cs) {
  const sh = cs.boxShadow;
  if (!sh || sh === 'none') return 0;
  const first = sh.split(/,(?![^(]*\))/)[0];
  if (/\binset\b/.test(first)) return 0;
  const m = first.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/);
  return m ? Math.max(0, parseFloat(m[2])) : 0;
}

// Which shapes are SQUARE BY DESIGN. Geometry alone cannot answer this: a chip
// and a seg tray also carry radius 999px, and calling those eggs flagged 45
// controls on the first real run — a checker that cries at every pill is a
// checker nobody reads. The house declares exactly two square shapes and gives
// both an explicit equal width/height (styles.css: icon 36×36, circle 28×28), so
// the shape name is the intent, read from the same attribute the CSS keys off.
const SQUARE_SHAPES = new Set(['icon', 'circle']);

// Only count what a person can actually see. Closed modals stay mounted at full
// size behind opacity:0, so without this every dialog in the app contributes its
// buttons to the reading (measured: 113 controls on a page showing ~28).
const visible = (el) =>
  el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })
  ?? el.getBoundingClientRect().height > 0;

const r1 = (n) => +n.toFixed(1);
const spread = (xs) => (xs.length < 2 ? 0 : r1(Math.max(...xs) - Math.min(...xs)));
const hasIntent = (el) => !!el.hasAttribute?.('data-spacing-intent');

function describe(el) {
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const lip = lipDown(cs);
  return {
    el,
    rect,
    shape: el.getAttribute('data-shape') || (el.classList.contains('candy-seg') ? 'seg-tray' : 'text'),
    label: (el.getAttribute('aria-label') || el.title || el.textContent || '')
      .trim().replace(/\s+/g, ' ').slice(0, 24),
    h: r1(rect.height),
    w: r1(rect.width),
    lip: r1(lip),
    bottom: r1(rect.bottom + lip),
    square: SQUARE_SHAPES.has(el.getAttribute('data-shape')),
    hFrom: el.style.height ? `INLINE ${el.style.height}` : 'css',
    wFrom: el.style.width ? `INLINE ${el.style.width}` : 'css',
  };
}

const pub = (c) => ({ shape: c.shape, label: c.label, h: c.h, w: c.w, lip: c.lip, bottom: c.bottom, hFrom: c.hFrom, wFrom: c.wFrom });

// Consecutive controls (left to right) whose rects overlap vertically by more
// than half the shorter one share a visual row.
function groupRows(controls) {
  const laid = controls.filter((c) => c.rect.width > 0 && c.rect.height > 0);
  laid.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const rows = [];
  for (const c of laid) {
    const row = rows.find((g) => g.some((o) => {
      const ov = Math.min(o.rect.bottom, c.rect.bottom) - Math.max(o.rect.top, c.rect.top);
      return ov > 0.5 * Math.min(o.rect.height, c.rect.height);
    }));
    if (row) row.push(c); else rows.push([c]);
  }
  for (const g of rows) g.sort((a, b) => a.rect.left - b.rect.left);
  return rows;
}

export function rowAudit(root = document.body, { quiet = false, bridge = true } = {}) {
  const controls = [...root.querySelectorAll(CTRL)].filter(visible).map(describe);

  const flags = [];
  const eggs = [];

  for (const c of controls) {
    // A control whose author wrote the SAME value for both axes is square by
    // declaration; any residual difference is sub-pixel rounding, not a squashed
    // circle. The music transport does this with calc(40 * var(--tile-px)) and
    // lands 22 × 23.3 — seven permanent false flags that would have trained the
    // eggs list to be ignored. An egg is a LAYOUT fault: one axis pinned, the
    // other left free (the Planner circles, 28 wide × 24 tall, off by 4).
    const declaredSquare = !!c.el.style.width && c.el.style.width === c.el.style.height;
    if (c.square && !declaredSquare && Math.abs(c.w - c.h) > TOL && !hasIntent(c.el)) {
      eggs.push({ ...pub(c), off: r1(c.w - c.h) });
    }
  }

  // Group per parent so a control never rows up with an unrelated one that merely
  // shares a screen line (two panes side by side).
  const byParent = new Map();
  for (const c of controls) {
    const p = c.el.parentElement;
    if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(c);
  }

  // SCOPE — a window that DECLARES one height for every control inside it, via
  // data-uniform-height="--the-css-var-that-sets-it". The attribute names the
  // variable rather than repeating its value, so the audit checks the stylesheet's
  // own intent against the screen and can never drift from it (a restated constant
  // is a bug with a delay on it). This is the check that catches the fault the
  // row-local ones structurally cannot: a lone button in a header row has no
  // sibling to disagree with, so the 30px Close button sat there unflagged while
  // being the most visibly wrong control in the window.
  //
  // seg-options are excluded: they live inside a tray whose padding makes them
  // legitimately shorter, and it is the TRAY that has to match the row.
  const scopes = [];
  for (const scope of root.querySelectorAll('[data-uniform-height]')) {
    const prop = scope.getAttribute('data-uniform-height');
    const want = parseFloat(getComputedStyle(scope).getPropertyValue(prop));
    if (!Number.isFinite(want)) {
      scopes.push({ scope: scope.className, prop, error: 'variable does not resolve here' });
      continue;
    }
    const kids = controls.filter((c) => scope.contains(c.el) && c.shape !== 'seg-option' && !hasIntent(c.el));
    const off = kids.filter((c) => Math.abs(c.h - want) > TOL);
    scopes.push({ scope: scope.className, prop, want, controls: kids.length, offenders: off.length });
    if (off.length) flags.push({ kind: 'SCOPE', row: scope.className, want, spread: spread([want, ...off.map((c) => c.h)]), controls: off.map(pub) });
  }

  // TIGHT — a gap on a visual line that is SMALLER than that line's usual gap.
  // Grouped across parents on purpose: the per-parent grouping below can only
  // compare siblings, so the boundary BETWEEN two groups is invisible to it —
  // which is exactly where Today and Block Library sat 1.4px apart on a line of
  // 8px gaps, inside a justify-content:space-between header with no gap floor.
  // Only the TOO-TIGHT half is flagged. A big gap on such a line is layout intent
  // (space-between pushing groups to the edges measured 40px and 517px on that
  // same line); a gap under the line's own norm is never intent.
  const mode = (xs) => {
    const tally = new Map();
    for (const x of xs) { const k = Math.round(x); tally.set(k, (tally.get(k) || 0) + 1); }
    return [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  };
  // The line container is the nearest ancestor that actually lays things out in a
  // ROW. Vertical overlap alone is not enough to say "same line": two controls in
  // separate panes overlap vertically while sharing nothing, and grouping on that
  // produced negative gaps and a nonsense norm on the first run. The row container
  // is what makes them neighbours.
  // The OUTERMOST row in an unbroken chain of them, not the nearest. Stopping at
  // the nearest returns the button's own little group — so the two groups either
  // side of a boundary land in different lines and the boundary between them is
  // invisible all over again. That is precisely the miss this check exists for,
  // and the self-test caught the locator making it a second time.
  const lineBox = (el) => {
    let best = null;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/flex/.test(cs.display) && !/column/.test(cs.flexDirection)) best = n;
      else if (best) break;                       // chain broken — keep the last row
    }
    return best;
  };
  const byLine = new Map();
  for (const c of controls) {
    const box = lineBox(c.el);
    if (!box) continue;
    if (!byLine.has(box)) byLine.set(box, []);
    byLine.get(box).push(c);
  }
  for (const [box, members] of byLine) {
    for (const line of groupRows(members)) {
      if (line.length < 3) continue;               // < 3 controls = no "usual" gap
      if (hasIntent(box) || line.some((c) => hasIntent(c.el))) continue;
      const gaps = line.slice(1).map((c, i) => r1(c.rect.left - line[i].rect.right));
      if (gaps.some((g) => g < 0)) continue;       // overlapping = not a plain line
      const norm = mode(gaps);
      const tight = gaps.filter((g) => g < norm - TOL);
      if (norm > 0 && tight.length) {
        flags.push({
          kind: 'TIGHT', row: (box.className || box.tagName).toString().slice(0, 30),
          spread: r1(norm - Math.min(...tight)), norm, gaps, controls: line.map(pub),
        });
      }
    }
  }

  // RHYTHM — a stack whose declared gap is one number but whose PAINTED gaps are
  // not. A candy control's depth lip hangs below its box without occupying layout,
  // so a row that ends in a button gives back less air than a row that doesn't:
  // a 16px gap read 11px under the More micros button while its neighbour read
  // 5.5px, on containers that both declared a single uniform gap. Equal declared
  // spacing that lands unequal is the whole fault, and no height or gap number
  // anywhere in the source shows it — only the painted geometry does.
  const rhythm = [];
  const deepLip = (el) => {
    let m = lipDown(getComputedStyle(el));
    for (const d of el.querySelectorAll('.candy-btn, .candy-seg')) m = Math.max(m, lipDown(getComputedStyle(d)));
    return m;
  };
  const stacks = new Set();
  for (const c of controls) for (let n = c.el.parentElement; n && n !== root.parentElement; n = n.parentElement) stacks.add(n);
  for (const box of stacks) {
    const cs = getComputedStyle(box);
    if (!/flex|grid/.test(cs.display) || !/column/.test(cs.flexDirection)) continue;
    const declared = parseFloat(cs.rowGap);
    if (!Number.isFinite(declared) || declared <= 0) continue;      // 'normal' = no promise made
    if (hasIntent(box)) continue;
    // Out-of-flow children don't participate in the gap, and counting them yields
    // wild negatives that swamp the real finding (measured -311px on the first run).
    const kids = [...box.children].filter((k) => {
      if (k.getBoundingClientRect().height <= 0) return false;
      return !/absolute|fixed/.test(getComputedStyle(k).position);
    });
    if (kids.length < 3) continue;
    const painted = kids.slice(1).map((k, i) =>
      r1(k.getBoundingClientRect().top - (kids[i].getBoundingClientRect().bottom + deepLip(kids[i]))));
    if (painted.some((p) => p < 0)) continue;      // overlapping rows are not a stack
    const d = spread(painted);
    if (d > TOL) {
      rhythm.push({ box: (box.className || box.tagName).toString().slice(0, 30), declared, painted, spread: d });
      flags.push({ kind: 'RHYTHM', row: (box.className || box.tagName).toString().slice(0, 30), spread: d, declared, painted, controls: [] });
    }
  }

  let rowCount = 0;
  for (const [parent, kids] of byParent) {
    for (const g of groupRows(kids)) {
      if (g.length < 2) continue;
      rowCount++;
      if (hasIntent(parent) || g.some((c) => hasIntent(c.el))) continue;
      const where = parent.className || parent.tagName.toLowerCase();

      const dH = spread(g.map((c) => c.h));
      if (dH > TOL) flags.push({ kind: 'HEIGHT', row: where, spread: dH, controls: g.map(pub) });

      const dB = spread(g.map((c) => c.bottom));
      if (dB > TOL && dH <= TOL) {
        // Heights already agree — this is the lip-only case a height check misses.
        flags.push({ kind: 'BOTTOM', row: where, spread: dB, note: 'equal heights, unequal depth lip', controls: g.map(pub) });
      }

      if (g.length > 2) {
        const gaps = g.slice(1).map((c, i) => r1(c.rect.left - g[i].rect.right));
        const dG = spread(gaps);
        if (dG > TOL) flags.push({ kind: 'GAP', row: where, spread: dG, gaps, controls: g.map(pub) });
      }
    }
  }

  if (!quiet || flags.length || eggs.length) {
    const bad = flags.length + eggs.length;
    if (bad) {
      console.group(`%crow audit — ${bad} offender(s) across ${rowCount} row(s)`, 'color:#c0392b;font-weight:700');
      for (const f of flags) console.warn(`${f.kind} spread ${f.spread}px in .${f.row}`, f.controls);
      for (const e of eggs) console.warn(`EGG ${e.label} — ${e.w}×${e.h} but round (off ${e.off}px)`, e);
      console.groupEnd();
    } else if (!quiet) {
      console.info(`%crow audit — 0 offenders across ${rowCount} row(s)`, 'color:#27ae60');
    }
  }

  const result = { rows: rowCount, controls: controls.length, flags, eggs, scopes, rhythm };
  if (bridge) postAudit('rows', result);
  return result;
}

/* ── Self-test ───────────────────────────────────────────────────────────────
 * A green checker and a broken checker look identical from outside, so every
 * flag type is proven in BOTH directions against a built fixture: a clean row
 * must stay silent, a row with one known fault must name exactly that fault.
 * Runs off-screen, tears itself down, reports to disk under `rowselftest`. */
function mk(tag, cls, style, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  Object.assign(el.style, style || {});
  if (text) el.textContent = text;
  return el;
}
// A fixture control declares its own geometry inline so the house .candy-btn
// rules can't drift the expected numbers out from under the test.
const fxBtn = (extra) => mk('div', 'candy-btn', {
  display: 'inline-flex', width: '40px', height: '24px', boxShadow: '0 5px 0 0 #333',
  borderRadius: '4px', ...extra,
});

export function rowSelfTest({ quiet = false } = {}) {
  const host = mk('div', 'row-selftest-host', {
    position: 'fixed', left: '-99999px', top: '0', width: '600px',
  });
  document.body.appendChild(host);
  const fixtures = [];
  const row = (cls) => mk('div', cls, { display: 'flex', alignItems: 'center', gap: '8px' });

  // FX1 — clean row: three identical controls, even gaps. Must stay silent.
  {
    const r = row('fx1'); r.append(fxBtn(), fxBtn(), fxBtn()); host.appendChild(r);
    fixtures.push({ n: 1, name: 'clean-row', verify: (res) => {
      const hit = res.flags.filter((f) => f.row === 'fx1');
      return { pass: hit.length === 0, detail: hit.length ? `false-flagged ${hit.map((h) => h.kind)}` : 'silent' };
    } });
  }
  // FX2 — one control 6px taller → HEIGHT.
  {
    const r = row('fx2'); r.append(fxBtn(), fxBtn({ height: '30px' })); host.appendChild(r);
    fixtures.push({ n: 2, name: 'height-mismatch', verify: (res) => {
      const f = res.flags.find((x) => x.row === 'fx2' && x.kind === 'HEIGHT');
      return { pass: !!f && Math.abs(f.spread - 6) <= TOL, detail: f ? `spread=${f.spread} exp≈6` : 'not flagged' };
    } });
  }
  // FX3 — BLIND SPOT of any height-only check: equal heights, unequal depth lip
  // (the .candy-seg 7px vs chip 5px case). Painted bottoms differ by 2px.
  {
    const r = row('fx3'); r.append(fxBtn(), fxBtn({ boxShadow: '0 7px 0 0 #333' })); host.appendChild(r);
    fixtures.push({ n: 3, name: 'lip-only-mismatch', blindSpot: true, verify: (res) => {
      const f = res.flags.find((x) => x.row === 'fx3' && x.kind === 'BOTTOM');
      return { pass: !!f && Math.abs(f.spread - 2) <= TOL, detail: f ? `spread=${f.spread} exp≈2` : 'not flagged' };
    } });
  }
  // FX4 — even flex gap, one control pushed by a margin → GAP.
  {
    const r = row('fx4'); r.append(fxBtn(), fxBtn({ marginLeft: '20px' }), fxBtn()); host.appendChild(r);
    fixtures.push({ n: 4, name: 'uneven-gap', verify: (res) => {
      const f = res.flags.find((x) => x.row === 'fx4' && x.kind === 'GAP');
      return { pass: !!f && Math.abs(f.spread - 20) <= TOL, detail: f ? `spread=${f.spread} exp≈20 gaps=${f.gaps}` : 'not flagged' };
    } });
  }
  // FX5 — a square-by-design shape 40 wide × 24 tall → EGG. Paired with FX5b, a
  // chip of the SAME oblong geometry and the same 999px radius, which must stay
  // silent: that pair is what separates "circle squashed into an oval" from "pill,
  // working as intended" — the distinction that cost 45 false flags on run one.
  {
    const r = row('fx5');
    const egg = fxBtn({ borderRadius: '999px' }); egg.setAttribute('data-shape', 'circle');
    const pill = fxBtn({ borderRadius: '999px' }); pill.setAttribute('data-shape', 'chip');
    r.append(egg, pill); host.appendChild(r);
    fixtures.push({ n: 5, name: 'egg-not-pill', verify: (res) => {
      const e = res.eggs.filter((x) => Math.abs(x.off - 16) <= TOL);
      const shapes = res.eggs.map((x) => x.shape);
      return {
        pass: e.length === 1 && !shapes.includes('chip'),
        detail: `eggs=${shapes.join(',') || 'none'} exp=circle only`,
      };
    } });
  }
  // FX7 — a declared-height window: the scope names the CSS variable that sets it,
  // one control obeys, one doesn't. Must flag exactly the disobedient one, and must
  // read the wanted height from the variable rather than from anything restated.
  {
    const r = row('fx7'); r.style.setProperty('--fx-h', '24px');
    r.setAttribute('data-uniform-height', '--fx-h');
    r.append(fxBtn(), fxBtn({ height: '30px' })); host.appendChild(r);
    fixtures.push({ n: 7, name: 'declared-height-scope', verify: (res) => {
      const f = res.flags.find((x) => x.kind === 'SCOPE' && x.row === 'fx7');
      const s = res.scopes.find((x) => x.scope === 'fx7');
      return {
        pass: !!f && f.want === 24 && f.controls.length === 1 && f.controls[0].h === 30,
        detail: f ? `want=${f.want} offenders=${f.controls.map((c) => c.h)}` : `not flagged (scope=${JSON.stringify(s)})`,
      };
    } });
  }
  // FX8 — a lone control in a scope, no sibling to disagree with. Row-local checks
  // are blind to it by construction; the scope check must still catch it. This is
  // the Planner's 30px Close button, reduced.
  {
    const r = row('fx8'); r.style.setProperty('--fx-h', '24px');
    r.setAttribute('data-uniform-height', '--fx-h');
    r.append(mk('span', 'fx8-title', {}, 'Planner'), fxBtn({ height: '30px' })); host.appendChild(r);
    fixtures.push({ n: 8, name: 'lone-control-scope', blindSpot: true, verify: (res) => {
      const f = res.flags.find((x) => x.kind === 'SCOPE' && x.row === 'fx8');
      const rowLocal = res.flags.some((x) => x.row === 'fx8' && x.kind !== 'SCOPE');
      return { pass: !!f && !rowLocal, detail: f ? 'caught by scope' : 'MISSED — no sibling, no flag' };
    } });
  }
  // FX9 — declared square, rendered oblong (min-width forces it). The author wrote
  // one value for both axes, so this is rounding/clamping, not a squashed circle.
  // Must NOT be an egg — the guard that keeps the music transport out of the list.
  {
    const r = row('fx9');
    const dq = fxBtn({ width: '20px', height: '20px', minWidth: '26px', borderRadius: '999px' });
    dq.setAttribute('data-shape', 'circle'); dq.setAttribute('aria-label', 'fx9-declared');
    r.append(dq, fxBtn()); host.appendChild(r);
    fixtures.push({ n: 9, name: 'declared-square-exempt', verify: (res) => {
      const hit = res.eggs.some((e) => e.label === 'fx9-declared');
      return { pass: !hit, detail: hit ? 'rounding artefact flagged as egg' : 'exempt' };
    } });
  }
  // FX10 — TIGHT across a group boundary. Two groups in one space-between line
  // with no gap floor: gaps read 8, 8, ~0, 8. The per-parent check cannot see the
  // boundary gap at all — this is the Today / Block Library miss, reduced.
  {
    // 5 buttons (200) + inner gaps (24) = 224 of content. At 228 the boundary is
    // left 4px — under the 8px norm, so TIGHT must fire. (At 260 the boundary is
    // 36px, WIDER than the norm, which is space-between working: see FX11.)
    const line = mk('div', 'fx10', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '228px' });
    const gA = mk('div', 'fx10-a', { display: 'flex', gap: '8px' });
    const gB = mk('div', 'fx10-b', { display: 'flex', gap: '8px' });
    gA.append(fxBtn(), fxBtn(), fxBtn()); gB.append(fxBtn(), fxBtn());
    line.append(gA, gB); host.appendChild(line);
    fixtures.push({ n: 10, name: 'tight-across-groups', blindSpot: true, verify: (res) => {
      const f = res.flags.find((x) => x.kind === 'TIGHT');
      return { pass: !!f && f.norm === 8, detail: f ? `norm=${f.norm} gaps=${f.gaps}` : 'MISSED — boundary gap invisible' };
    } });
  }
  // FX11 — a WIDE gap on the same kind of line must NOT flag: space-between doing
  // its job is intent, not a fault. Without this the check would cry on every
  // header in the app and be ignored within a day.
  {
    const line = mk('div', 'fx11', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '600px' });
    const gA = mk('div', 'fx11-a', { display: 'flex', gap: '8px' });
    const gB = mk('div', 'fx11-b', { display: 'flex', gap: '8px' });
    gA.append(fxBtn(), fxBtn(), fxBtn()); gB.append(fxBtn(), fxBtn());
    line.append(gA, gB); host.appendChild(line);
    fixtures.push({ n: 11, name: 'wide-gap-is-intent', verify: (res) => {
      const f = res.flags.find((x) => x.kind === 'TIGHT' && String(x.row).includes('fx11'));
      return { pass: !f, detail: f ? 'space-between flagged as a fault' : 'ignored' };
    } });
  }
  // FX12 — RHYTHM: one declared 12px gap, three rows, the middle one ending in a
  // control with a 5px lip. Painted gaps land 12 and 7. Every number in the source
  // says 12; only the painted geometry disagrees.
  {
    const st = mk('div', 'fx12', { display: 'flex', flexDirection: 'column', gap: '12px', width: '200px' });
    const plain = () => mk('div', 'fx12-row', { height: '20px', background: '#345' });
    const withBtn = mk('div', 'fx12-btnrow', { display: 'flex' }); withBtn.append(fxBtn());
    st.append(plain(), withBtn, plain()); host.appendChild(st);
    fixtures.push({ n: 12, name: 'lip-eats-rhythm', blindSpot: true, verify: (res) => {
      const r = res.rhythm.find((x) => x.box === 'fx12');
      return { pass: !!r && Math.abs(r.spread - 5) <= TOL, detail: r ? `declared=${r.declared} painted=${r.painted}` : 'not flagged' };
    } });
  }
  // FX13 — the same stack with NO lip anywhere: painted gaps all equal, silent.
  {
    const st = mk('div', 'fx13', { display: 'flex', flexDirection: 'column', gap: '12px', width: '200px' });
    for (let i = 0; i < 3; i++) st.appendChild(mk('div', 'fx13-row', { height: '20px', background: '#345' }));
    st.appendChild(fxBtn({ boxShadow: 'none' }));   // a control, so the stack is visited
    host.appendChild(st);
    fixtures.push({ n: 13, name: 'even-rhythm-silent', verify: (res) => {
      const r = res.rhythm.find((x) => x.box === 'fx13');
      return { pass: !r, detail: r ? `false-flagged painted=${r.painted}` : 'silent' };
    } });
  }
  // FX6 — the SAME fault as FX2, opted out with data-spacing-intent. Must be silent.
  {
    const r = row('fx6'); r.setAttribute('data-spacing-intent', 'selftest');
    r.append(fxBtn(), fxBtn({ height: '30px' })); host.appendChild(r);
    fixtures.push({ n: 6, name: 'intent-opt-out', verify: (res) => {
      const hit = res.flags.filter((x) => x.row === 'fx6');
      return { pass: hit.length === 0, detail: hit.length ? 'opt-out ignored' : 'excluded' };
    } });
  }

  const res = rowAudit(host, { quiet: true, bridge: false });
  const results = fixtures.map((f) => ({ n: f.n, name: f.name, blindSpot: !!f.blindSpot, ...f.verify(res) }));
  host.remove();

  const failures = results.filter((r) => !r.pass);
  const payload = { pass: failures.length === 0, failures: failures.map((f) => `FX${f.n} ${f.name}: ${f.detail}`), fixtures: results };
  if (!quiet) {
    console[payload.pass ? 'info' : 'error'](
      `%crow self-test — ${payload.pass ? 'PASS' : 'FAIL'} (${results.length - failures.length}/${results.length})`,
      `color:${payload.pass ? '#27ae60' : '#c0392b'};font-weight:700`,
    );
    for (const f of failures) console.error(`  FX${f.n} ${f.name} — ${f.detail}`);
  }
  postAudit('rowselftest', payload);
  return payload;
}

let timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; rowAudit(document.body, { quiet: true }); }, 400);
}

export function startRowAudit() {
  if (typeof window === 'undefined') return;
  window.rowAudit = rowAudit;
  window.rowSelfTest = rowSelfTest;
  const first = () => setTimeout(() => { rowSelfTest({ quiet: true }); rowAudit(); }, 700);
  if (document.readyState === 'complete') first();
  else window.addEventListener('load', first, { once: true });
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
