// cssVarAudit — DEV-only watchdog for the silent CSS killer class: an inline
// style referencing `var(--x)` with NO fallback where `--x` doesn't resolve at
// that element. CSS's failure mode is invisible — the ENTIRE declaration
// (shorthand included) is dropped with no error, no log, no crash. Born from
// the GameWikiRail toolbar band (2026-07-17): its `padding: 8px 8px calc(4px +
// var(--candy-depth-nav))` sat outside the wrapper declaring the var, so ALL
// padding vanished and the tree ran ~18px tight vs the vault sidebar.
//
// Scans every element whose inline style mentions var(--…), verifies each
// referenced custom property resolves via getComputedStyle. `var(--x, fb)`
// (explicit fallback) is legal-by-design and skipped. Violations print loud and
// land in web/.audit/<label>.json under `cssvars` (auditBridge picks the label
// per window, so the overlay host is covered too). Wires in exactly like
// spacingAudit/candyCenterAudit: loud once after settle, quiet re-audits on DOM
// mutations (including style-attribute changes).

import { postAudit } from './auditBridge.js';

// Capture the var name AND the char after it: ')' = no fallback (must resolve),
// ',' = fallback present (skip).
const VAR_RE = /var\(\s*(--[\w-]+)\s*([,)])/g;

// Short ancestor breadcrumb so a violation is locatable without a live picker.
function domPath(el) {
  const parts = [];
  for (let n = el; n && n !== document.body && parts.length < 5; n = n.parentElement) {
    parts.unshift(
      n.tagName.toLowerCase() +
      (n.id ? `#${n.id}` : '') +
      (n.classList && n.classList[0] ? `.${n.classList[0]}` : '')
    );
  }
  return parts.join('>');
}

export function cssVarAudit(root = document, { quiet = false, bridge = true } = {}) {
  const els = root.querySelectorAll('[style*="var(--"]');
  const violations = [];
  for (const el of els) {
    const style = el.getAttribute('style') || '';
    let cs = null; // lazy — most elements resolve everything
    const seen = new Set();
    let m;
    VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(style))) {
      const [, name, next] = m;
      if (next === ',' || seen.has(name)) continue; // fallback present / done
      seen.add(name);
      if (!cs) cs = getComputedStyle(el);
      if (cs.getPropertyValue(name).trim() === '') {
        violations.push({ var: name, path: domPath(el) });
      }
    }
  }
  const result = {
    ts: Date.now(),
    route: (typeof location !== 'undefined' && (location.hash || location.pathname)) || '',
    scanned: els.length,
    ok: violations.length === 0,
    violations,
  };
  if (violations.length) {
    console.warn(`[cssVarAudit] ${violations.length} UNRESOLVED inline CSS var(s) — the whole declaration is silently dropped:`, violations);
  } else if (!quiet) {
    console.log(`[cssVarAudit] ok — ${els.length} inline-var elements, every var resolves`);
  }
  if (bridge) postAudit('cssvars', result);
  return result;
}

let timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; cssVarAudit(document, { quiet: true }); }, 500);
}

// Expose window.cssVarAudit() for manual runs; loud once after settle, then
// quiet re-audits on DOM/style changes. Parallels startSpacingAudit.
export function startCssVarAudit() {
  if (typeof window === 'undefined') return;
  window.cssVarAudit = cssVarAudit;
  const first = () => setTimeout(() => cssVarAudit(document), 900);
  if (document.readyState === 'complete') first();
  else window.addEventListener('load', first, { once: true });
  new MutationObserver(schedule).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['style'],
  });
}
