// DEV-only candy-centering verifier.
//
// The candy depth lip is a downward box-shadow OUTSIDE layout flow, so
// align-items:center centers the BORDER-BOX and getBoundingClientRect (which
// excludes box-shadow) ALWAYS reports the button as "centered" (Δ=0) even when
// the lip makes it read low. That blind spot is exactly what hid past centering
// bugs and produced multi-round eyeballing.
//
// This audit sidesteps the trap by ADDING depth/2 ANALYTICALLY — taken from the
// live box-shadow, which always computes to px — to the button's rect center to
// get its OPTICAL center, then comparing that to the center of each non-candy
// TEXT sibling in the same align-items:center flex row. A miss prints the signed
// Δ and the offending nodes. It auto-covers every depth setting, shape, and
// inline override because it reads each button's actual rendered geometry.
//
// Never shipped to prod: imported only behind import.meta.env.DEV in main.jsx.

const TOL = 0.75; // px — absorbs sub-pixel rounding; a real depth/2 miss is >= 1.5px

const center = (r) => r.top + r.height / 2;

// The lip == the first box-shadow layer's offset-y. Computed box-shadow is always
// px, and is `none` when the depth animation is off (no lip → 0, matching the CSS
// gate --candy-center-on:0 that zeroes the lift in that mode).
function lipDepth(cs) {
  const sh = cs.boxShadow;
  if (!sh || sh === 'none') return 0;
  const m = sh.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/); // first layer: offset-x offset-y
  return m ? parseFloat(m[2]) : 0;
}

export function candyCenterAudit(root = document.body, { quiet = false } = {}) {
  const offenders = [];
  for (const btn of root.querySelectorAll('.candy-btn')) {
    const row = btn.parentElement;
    if (!row) continue;
    const rcs = getComputedStyle(row);
    if (!rcs.display.includes('flex') || rcs.alignItems !== 'center') continue;
    // Compare only against siblings that are a FLAT text baseline — no lip of
    // their own. A peer candy control (.candy-btn, .candy-seg, a tile, anything
    // with its own downward depth shadow) sits equally low and is correctly
    // aligned to the button, so it must NOT count as a reference (else every
    // candy-vs-candy row false-flags at +depth/2). Form fields count as text: an
    // <input>'s value lives in .value, so its .textContent is empty.
    const isFlatText = (el) =>
      el !== btn &&
      !el.classList.contains('candy-btn') && !el.classList.contains('candy-seg') &&
      lipDepth(getComputedStyle(el)) === 0 &&
      (el.textContent.trim() || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const texts = [...row.children].filter(isFlatText);
    if (!texts.length) continue;
    const b = btn.getBoundingClientRect();
    if (!b.height) continue; // not laid out / hidden
    const optical = center(b) + lipDepth(getComputedStyle(btn)) / 2;
    for (const t of texts) {
      const delta = +(optical - center(t.getBoundingClientRect())).toFixed(2);
      if (Math.abs(delta) > TOL) offenders.push({ btn, sibling: t, delta });
    }
  }
  if (offenders.length) {
    console.group(`%ccandy-center audit — ${offenders.length} offender(s)`, 'color:#c0392b;font-weight:700');
    for (const o of offenders) {
      console.warn(`Δ${o.delta > 0 ? '+' : ''}${o.delta}px — reads ${o.delta > 0 ? 'LOW' : 'HIGH'}`, o.btn, 'vs text', o.sibling);
    }
    console.groupEnd();
  } else if (!quiet) {
    console.info('%ccandy-center audit — 0 offenders', 'color:#27ae60');
  }
  return offenders;
}

let timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; candyCenterAudit(document.body, { quiet: true }); }, 400);
}

// Run once after the app settles (loud, to confirm wiring), then quietly re-audit
// on DOM changes (route/modal mounts) — only offenders print thereafter. Also
// exposes window.candyCenterAudit() for manual re-runs during verification.
export function startCandyCenterAudit() {
  if (typeof window === 'undefined') return;
  window.candyCenterAudit = candyCenterAudit;
  const first = () => setTimeout(() => candyCenterAudit(), 600);
  if (document.readyState === 'complete') first();
  else window.addEventListener('load', first, { once: true });
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
