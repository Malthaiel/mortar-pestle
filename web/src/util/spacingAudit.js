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

import { postAudit } from './auditBridge.js';

const TOL = 1.0; // px — absorbs sub-pixel rounding

// Downward box-shadow offset (px) — the candy depth band. First shadow layer's
// offset-y, clamped to >=0 (only a downward lip adds visible height). Same layer
// candyCenterAudit reads for its optical-centre correction. An INSET first layer
// paints inward, casting no downward lip → 0 (Move 5: without this guard the
// regex reads an inset offset as a false band). Split layers on commas that are
// NOT inside rgb()/color functions.
function shadowDown(cs) {
  const sh = cs.boxShadow;
  if (!sh || sh === 'none') return 0;
  const first = sh.split(/,(?![^(]*\))/)[0];
  if (/\binset\b/.test(first)) return 0;
  const m = first.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/); // offset-x offset-y
  return m ? Math.max(0, parseFloat(m[2])) : 0;
}

// The Y coordinate of `el`'s OWN lowest painted pixel (excluding descendants),
// or -Infinity if its own box paints nothing there. Sources, max wins:
//   downward shadow → r.bottom + ownShadow
//   visible bottom border → r.bottom
//   visible background → r.bottom pulled UP by the clipped-away band:
//     background-clip:content-box → minus paddingBottom + borderBottomWidth
//     background-clip:padding-box → minus borderBottomWidth
//     border-box (default) → r.bottom
//     background-clip:text paints glyphs, no box → contributes nothing
// backgroundClip is a comma-separated PER-LAYER list (multiple backgrounds); the
// outermost-reaching clip across layers wins. Replaces the old boolean
// hasPaintedBox, which over-reported a content-/padding-box-clipped bg by the
// padding/border it doesn't actually cover (Move 5). A transparent container
// returns -Infinity, so visualBottom falls through to its descendants — the
// trapped-marginBottom false-0 and the lower-painted-sibling cases still resolve.
function ownPaintedBottom(cs, r, ownShadow) {
  let y = -Infinity;
  if (ownShadow > 0) y = Math.max(y, r.bottom + ownShadow);
  const bw = parseFloat(cs.borderBottomWidth) || 0;
  if (bw > 0 && cs.borderBottomStyle !== 'none' &&
      cs.borderBottomColor !== 'rgba(0, 0, 0, 0)' && cs.borderBottomColor !== 'transparent') {
    y = Math.max(y, r.bottom);
  }
  const bg = cs.backgroundColor;
  const hasBg = (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') ||
    (cs.backgroundImage && cs.backgroundImage !== 'none');
  if (hasBg) {
    for (const clip of cs.backgroundClip.split(',').map((s) => s.trim())) {
      if (clip === 'text') continue;
      if (clip === 'content-box') y = Math.max(y, r.bottom - (parseFloat(cs.paddingBottom) || 0) - bw);
      else if (clip === 'padding-box') y = Math.max(y, r.bottom - bw);
      else y = Math.max(y, r.bottom); // border-box / initial
    }
  }
  return y;
}

// Lowest painted pixel of `el` — recursive. A leaf (no in-flow element kids) paints
// its own box (ownPaintedBottom), falling back to rect.bottom for a transparent
// text/content leaf (glyphs fill the line-box). A container starts from its OWN
// painted bottom (-Infinity when transparent) and takes the max with every in-flow
// descendant's painted bottom. A transparent container's rect.bottom can sit BELOW
// its content — a grid track sizes to the item margin box (trapped marginBottom) OR
// a flex row's height is set by one child while a lower-painted sibling sits above
// its edge — so recursing into ALL in-flow kids gets the true lowest painted pixel.
// In-flow, laid-out child elements. A display:contents child generates no box
// (rect height 0) but ITS children lay out as if direct children of `el`, so
// splice them in (recursively) instead of height-filtering the wrapper away —
// otherwise the audit never visits them (Move 4: the display:contents blind
// spot). Absolute/fixed children overlap geometrically and are dropped.
function flowChildren(el) {
  const out = [];
  for (const c of el.children) {
    const cs = getComputedStyle(c);
    if (cs.position === 'absolute' || cs.position === 'fixed') continue;
    if (cs.display === 'contents') { out.push(...flowChildren(c)); continue; }
    if (c.getBoundingClientRect().height <= 0) continue;
    out.push(c);
  }
  return out;
}

function visualBottom(el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const ownShadow = shadowDown(cs);
  const own = ownPaintedBottom(cs, r, ownShadow);
  const inFlowKids = flowChildren(el);
  // Leaf: its own painted box, or rect.bottom for a transparent text/content leaf.
  if (inFlowKids.length === 0) return own > -Infinity ? own : r.bottom + ownShadow;
  let low = own;
  for (const child of inFlowKids) {
    const b = visualBottom(child);
    if (b > low) low = b;
  }
  return low;
}

const isVStack = (cs) =>
  (cs.display.includes('flex') && cs.flexDirection.startsWith('column')) ||
  (cs.display.includes('grid') && cs.gridTemplateColumns === 'none');

// Plain block-flow container whose children stack vertically and at least one
// child is (or holds) a candy control — its band overhangs the margin gap to
// the next block child, which the flex/grid vstack filter above misses. Catches
// the case-2 "gap directly below a candy control" defect in mixed candy+flat
// sections wrapped in a plain <div> (e.g. ScrimViewer Auto Classification).
const isCandyBlock = (el, cs) => {
  if (cs.display.includes('flex') || cs.display.includes('grid') || cs.display.includes('inline')) return false;
  // Only in-flow (static/relative) children form a vertical stack; absolute/fixed
  // children overlap geometrically (e.g. overlay panels at the same top/left), so
  // flowChildren drops them (and splices display:contents through).
  const kids = flowChildren(el);
  if (kids.length < 2) return false;
  return kids.some((k) => k.matches?.('.candy-btn') || k.querySelector?.('.candy-btn'));
};

// Rhythm helpers (Move 6). off-grid = gapAfterBand not within TOL of a 4px
// multiple. data-spacing-intent on the child OR the stack opts a gap out of BOTH
// rhythm and variance (a deliberate non-8 gap). candyClassOf surfaces the matched
// candy class as EVIDENCE — the reader concludes the cause; the audit NEVER emits
// a slack/lift verdict (that mis-attribution is what ate three chats).
const offGrid = (g) => Math.abs(g - 4 * Math.round(g / 4)) > TOL;
const hasIntent = (el) => !!el.hasAttribute?.('data-spacing-intent');
const candyClassOf = (k) => {
  if (k.matches?.('.candy-btn')) return k.className || '.candy-btn';
  const c = k.querySelector?.('.candy-btn');
  return c ? (c.className || '.candy-btn') : null;
};

export function spacingAudit(root = document.body, { quiet = false, bridge = true, rhythm: showRhythm = false } = {}) {
  const flags = [];
  const stacks = [];
  const rhythm = [];    // off-grid gaps (evidence, not verdicts) — always computed, printed only on {rhythm:true}
  const variance = [];  // stacks whose sibling gaps disagree by >TOL (each may be on-grid — the 8-then-4 case)
  for (const cont of [root, ...root.querySelectorAll('*')]) {
    const cs = getComputedStyle(cont);
    if (!isVStack(cs) && !isCandyBlock(cont, cs)) continue;
    const kids = flowChildren(cont);
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
    const stackName = cont.className || cont.tagName.toLowerCase();
    // Rhythm + within-stack variance (Move 6). A gap opted out via
    // data-spacing-intent (on the child or the stack) is excluded from both.
    const contIntent = hasIntent(cont);
    const spread = [];
    kids.forEach((k, i) => {
      const g = rows[i].gapAfterBand;
      if (g == null || contIntent || hasIntent(k)) return;
      spread.push(g);
      if (offGrid(g)) {
        const kcs = getComputedStyle(k);
        rhythm.push({ stack: stackName, row: rows[i].row, gapAfterBand: g, band: rows[i].band,
          lineHeight: kcs.lineHeight, fontSize: kcs.fontSize,
          candyCenterRow: !!cont.matches?.('.candy-center-row'), candyClass: candyClassOf(k) });
      }
    });
    if (spread.length >= 2) {
      const mx = Math.max(...spread), mn = Math.min(...spread);
      if (mx - mn > TOL) variance.push({ stack: stackName, gaps: spread, spread: +(mx - mn).toFixed(1) });
    }
    stacks.push({ stack: stackName, cssGap, rows });
  }
  if (!quiet || flags.length || showRhythm) {
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
    if (showRhythm) {
      // Evidence per off-grid row — the reader concludes; no slack/lift verdict.
      out.push('', `off-grid rows: ${rhythm.length}`);
      for (const r of rhythm) out.push(`  ~ [${r.stack}] ${r.row}: gapAfterBand ${r.gapAfterBand} (band ${r.band}, line-height ${r.lineHeight}, font ${r.fontSize}${r.candyCenterRow ? ', candy-center-row' : ''}${r.candyClass ? ', candy: ' + r.candyClass : ''})`);
      out.push(`within-stack variance: ${variance.length}`);
      for (const v of variance) out.push(`  ≈ [${v.stack}] gaps [${v.gaps.join(', ')}] spread ${v.spread}`);
    }
    console.log(out.join('\n'));
  }
  const result = { flags: flags.map(({ el, ...rest }) => rest), stacks, rhythm, variance };
  if (bridge) postAudit('spacing', result); // DEV-only bridge — Claude reads web/.audit/<label>.json
  return result;
}

// ── DEV self-test: audit-of-the-audit (Spacing Correctness System, Move 3) ──
// Known-answer fixtures rendered with REAL app classes into a laid-out but
// off-screen host. Each asserts the audit's reported band against a band derived
// DIRECTLY from the live DOM geometry (never a hardcoded px — so every depth
// setting passes). Against the CURRENT audit fixtures 1-4 pass and 5/6/8 fail —
// the failures PROVE the known blind spots (display:contents, background-clip,
// inset shadow); Moves 4/5 flip them green. FX7 pends the rhythm array (Move 6).
// Run window.spacingAuditSelfTest() after any edit to THIS file; once Moves 4/5
// land, require pass:true (Move 9 protocol).

const mk = (tag, cls, style, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) Object.assign(e.style, style);
  if (text != null) e.textContent = text;
  return e;
};
const bottomOf = (el) => el.getBoundingClientRect().bottom;
// First box-shadow layer's downward offset (px), clamped >=0 — the same value
// visualBottom's shadowDown reads, used to derive expected painted bottoms.
const shadowY = (el) => {
  const m = getComputedStyle(el).boxShadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/);
  return m ? Math.max(0, parseFloat(m[2])) : 0;
};
const findRow = (result, marker) => {
  for (const s of result.stacks) for (const r of s.rows) if (String(r.row).includes(marker)) return r;
  return null;
};
const near = (a, b) => a != null && Math.abs(a - b) <= TOL;

export function spacingAuditSelfTest() {
  if (typeof document === 'undefined') return { pass: false, failures: ['no document'] };
  const host = mk('div', 'spacing-selftest-host', {
    position: 'fixed', left: '-10000px', top: '0', width: '400px',
  });
  document.body.appendChild(host); // must be in the render tree, or every rect is 0
  const sib = () => mk('div', 'sst-sib', { height: '20px', background: '#333' });
  const fixtures = [];

  // FX1 — trapped marginBottom (the false-0): overflow:hidden makes a BFC that
  // traps the child's marginBottom inside a transparent box → box.bottom sits
  // below the child's painted bottom → negative band = child.bottom - box.bottom.
  {
    const stack = mk('div', 'sst-fx1', { display: 'flex', flexDirection: 'column', gap: '0px' });
    const box = mk('div', 'fx1-row', { overflow: 'hidden', background: 'transparent' });
    const leaf = mk('div', 'fx1-leaf', { height: '20px', background: '#c33', marginBottom: '12px' });
    box.appendChild(leaf); stack.append(box, sib()); host.appendChild(stack);
    fixtures.push({ n: 1, name: 'trapped-marginBottom', stack, verify: (r) => {
      const row = findRow(r, 'fx1-row'); const exp = bottomOf(leaf) - bottomOf(box);
      return { pass: near(row?.band, exp), detail: `band=${row?.band} exp≈${exp.toFixed(1)}` };
    } });
  }

  // FX2 — non-candy text painting lower than a candy sibling: visualBottom must
  // return the LOWEST painted pixel across candy shadow AND flat text, not only
  // the candy descendant. Text is lowest here → band≈0; a candy-only audit would
  // report a large negative band. Expected = max(paints) - row.bottom.
  {
    const stack = mk('div', 'sst-fx2', { display: 'flex', flexDirection: 'column', gap: '8px' });
    const row = mk('div', 'fx2-row', { display: 'flex', alignItems: 'flex-start', background: 'transparent' });
    const btn = mk('button', 'candy-btn fx2-btn', { height: '20px' }, 'B');
    const text = mk('div', 'fx2-text', {}, 'lower text');
    text.style.height = '50px';
    row.append(btn, text); stack.append(row, sib()); host.appendChild(stack);
    fixtures.push({ n: 2, name: 'non-candy-text-lower', stack, verify: (r) => {
      const rr = findRow(r, 'fx2-row');
      const exp = Math.max(bottomOf(text), bottomOf(btn) + shadowY(btn)) - bottomOf(row);
      return { pass: near(rr?.band, exp), detail: `band=${rr?.band} exp≈${exp.toFixed(1)}` };
    } });
  }

  // FX3 — candy-center-row head lift (the ov-scrim-head case): the lifted candy
  // button (top:-depth/2) + its downward shadow inside a transparent head with
  // padding-bottom → band = depth/2 - padding-bottom (negative when pad>depth/2).
  // Expected derived from the button's live rect+shadow, so any depth passes.
  {
    const stack = mk('div', 'sst-fx3', { display: 'flex', flexDirection: 'column', gap: '8px' });
    const head = mk('div', 'candy-center-row fx3-head', { paddingBottom: '4px', background: 'transparent' });
    const btn = mk('button', 'candy-btn fx3-btn', { height: '24px' }, 'H');
    head.appendChild(btn); stack.append(head, sib()); host.appendChild(stack);
    fixtures.push({ n: 3, name: 'candy-center-lift', stack, verify: (r) => {
      const row = findRow(r, 'fx3-head'); const exp = (bottomOf(btn) + shadowY(btn)) - bottomOf(head);
      return { pass: near(row?.band, exp), detail: `band=${row?.band} exp≈${exp.toFixed(1)}` };
    } });
  }

  // FX4 — painted bottom above box bottom (line-height-slack class): a transparent
  // box with padding-bottom over a tall-line-height text leaf → band = -paddingBottom.
  {
    const stack = mk('div', 'sst-fx4', { display: 'flex', flexDirection: 'column', gap: '8px' });
    const box = mk('div', 'fx4-row', { background: 'transparent', paddingBottom: '8px' });
    const text = mk('div', 'fx4-text', { lineHeight: '2', background: 'transparent' }, 'slack');
    box.appendChild(text); stack.append(box, sib()); host.appendChild(stack);
    fixtures.push({ n: 4, name: 'slack-padding', stack, verify: (r) => {
      const row = findRow(r, 'fx4-row'); const exp = bottomOf(text) - bottomOf(box);
      return { pass: near(row?.band, exp), detail: `band=${row?.band} exp≈${exp.toFixed(1)}` };
    } });
  }

  // FX5 — display:contents wrapper (BLIND SPOT until Move 4): the wrapper makes no
  // box (rect height 0) → v1 filters it and never visits boxB. A correct audit
  // treats it as pass-through → a row for fx5-b exists. FAILS on v1.
  {
    const stack = mk('div', 'sst-fx5', { display: 'flex', flexDirection: 'column', gap: '8px' });
    const a = mk('div', 'fx5-a', { height: '20px', background: '#39c' });
    const wrap = mk('div', 'fx5-wrap', { display: 'contents' });
    const b = mk('div', 'fx5-b', { height: '20px', background: '#3c9' });
    wrap.appendChild(b); stack.append(a, wrap); host.appendChild(stack);
    fixtures.push({ n: 5, name: 'display-contents', blindSpot: true, stack, verify: (r) => {
      const row = findRow(r, 'fx5-b');
      return { pass: !!row, detail: row ? 'fx5-b measured' : 'fx5-b invisible (contents blind spot)' };
    } });
  }

  // FX6 — background-clip:content-box (BLIND SPOT until Move 5): a visible bg
  // clipped to the content box, so the painted bottom is paddingBottom above the
  // border-box bottom. v1's hasPaintedBox reports the border-box bottom → band 0;
  // correct band = -(paddingBottom+borderBottom). FAILS on v1.
  {
    const stack = mk('div', 'sst-fx6', { display: 'flex', flexDirection: 'column', gap: '8px' });
    const clip = mk('div', 'fx6-row', { background: '#c93', backgroundClip: 'content-box', paddingBottom: '16px' });
    clip.appendChild(mk('div', 'fx6-tiny', { height: '5px' }));
    stack.append(clip, sib()); host.appendChild(stack);
    fixtures.push({ n: 6, name: 'background-clip', blindSpot: true, stack, verify: (r) => {
      const row = findRow(r, 'fx6-row'); const cs = getComputedStyle(clip);
      const exp = -(parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth));
      return { pass: near(row?.band, exp), detail: `band=${row?.band} exp≈${exp.toFixed(1)}` };
    } });
  }

  // FX7 — data-spacing-intent excludes a gap from rhythm (PENDS Move 6): the
  // off-grid gap (10px) carries an intent opt-out → must not appear in rhythm.
  // Until Move 6 adds result.rhythm, this fixture is pending, not failing.
  {
    const stack = mk('div', 'sst-fx7', { display: 'flex', flexDirection: 'column', gap: '10px' });
    const a = mk('div', 'fx7-a', { height: '20px', background: '#93c' });
    a.setAttribute('data-spacing-intent', 'test');
    stack.append(a, mk('div', 'fx7-b', { height: '20px', background: '#c39' })); host.appendChild(stack);
    fixtures.push({ n: 7, name: 'intent-opt-out', stack, verify: (r) => {
      if (!Array.isArray(r.rhythm)) return { pending: true, detail: 'rhythm not built (Move 6)' };
      const hit = r.rhythm.some((x) => String(x.row || x).includes('fx7-a'));
      return { pass: !hit, detail: hit ? 'fx7-a wrongly in rhythm' : 'fx7-a excluded' };
    } });
  }

  // FX8 — inset first-layer box-shadow (BLIND SPOT until Move 5): shadowDown grabs
  // the first "Xpx Ypx" pair with no inset guard → reads an INSET offset as a
  // downward lip → false band. Correct: inset contributes 0 → band 0. FAILS on v1.
  {
    const stack = mk('div', 'sst-fx8', { display: 'flex', flexDirection: 'column', gap: '8px' });
    const inset = mk('div', 'fx8-row', { height: '20px', boxShadow: 'inset 0 6px 0 0 #c33' });
    stack.append(inset, sib()); host.appendChild(stack);
    fixtures.push({ n: 8, name: 'inset-shadow', blindSpot: true, stack, verify: (r) => {
      const row = findRow(r, 'fx8-row');
      return { pass: near(row?.band, 0), detail: `band=${row?.band} exp≈0` };
    } });
  }

  const results = [];
  for (const fx of fixtures) {
    let res;
    try { res = fx.verify(spacingAudit(fx.stack, { quiet: true, bridge: false })); }
    catch (e) { res = { pass: false, detail: 'threw: ' + e.message }; }
    results.push({ n: fx.n, name: fx.name, blindSpot: fx.blindSpot || false, ...res });
  }
  host.remove();

  const graded = results.filter((r) => !r.pending);
  const failures = graded.filter((r) => !r.pass)
    .map((r) => `FX${r.n} ${r.name}${r.blindSpot ? ' [blind spot until Move 4/5]' : ''}: ${r.detail}`);
  const pass = failures.length === 0;
  const summary = {
    pass, failures,
    fixtures: results.map((r) => ({ n: r.n, name: r.name, pass: r.pending ? 'pending' : r.pass, detail: r.detail })),
  };
  console.log(`spacingAudit selfTest — ${pass ? 'PASS' : 'FAIL'} (${graded.filter((r) => r.pass).length}/${graded.length} graded pass, ${results.length - graded.length} pending)`);
  for (const f of failures) console.warn('  ✗ ' + f);
  postAudit('selftest', summary);
  return summary;
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
  window.spacingAuditSelfTest = spacingAuditSelfTest;
  // Boot the audit loud-once, then the audit-of-the-audit once (Move 9): its
  // {pass,failures} lands in web/.audit/<label>.json under `selftest`, so the
  // selfTest gate after any spacingAudit.js edit is a file Read, not a console run.
  const first = () => setTimeout(() => { spacingAudit(); spacingAuditSelfTest(); }, 700);
  if (document.readyState === 'complete') first();
  else window.addEventListener('load', first, { once: true });
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
