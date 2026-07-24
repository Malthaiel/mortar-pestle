// sectionJump.js — module-scope cross-pane signal for the report section sub-nav (M20). The GameWiki
// left tree (GameWikiTree, in the module sidebar) and the routed report content pane (VodReportView)
// live in separate React trees and only share the URL. When a section sub-leaf in the tree is clicked,
// this stashes the target + notifies; VodReportView — already on, or freshly navigated to, the Report
// tab — takes it (scrim-scoped, one-shot) and scrolls that heading into view. Module-scope (not React
// state) so it survives the route change that mounts VodReportView on a fresh navigation.

let pending = null; // { scrim, sectionId } | null
const subs = new Set();

// The tree asks for a scroll. Persists until a matching consumer takes it (a fresh VodReportView
// mount can take a request made just before it existed).
export function requestSectionJump(scrim, sectionId) {
  pending = { scrim, sectionId };
  subs.forEach((fn) => { try { fn(); } catch { /* one bad listener must not wedge the rest */ } });
}

// Consume the pending jump iff it targets this scrim. One-shot: returns the section id or null.
export function takeSectionJump(scrim) {
  if (pending && pending.scrim === scrim) { const id = pending.sectionId; pending = null; return id; }
  return null;
}

export function subscribeSectionJump(fn) { subs.add(fn); return () => subs.delete(fn); }
