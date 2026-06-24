// Shared header label for every Planner pane.
//
// All four Planner headers — Events, Unorganized, the date sublabel, and Block
// Library — render through this one component so a size / weight / color change
// is a single edit here instead of a hunt across EventsPane, NotesPane, and
// LibraryPane (which is what it used to be). Default is a title-case section
// label; `variant="date"` tightens tracking for the date sublabel while sharing
// the same color, size, weight, and mono family.

const BASE = {
  color: 'var(--text)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  fontWeight: 700,
};

const VARIANT = {
  title: { letterSpacing: '0.08em' },
  date: { letterSpacing: '0.04em' },
};

export default function PaneHeader({ children, variant = 'title' }) {
  return (
    <div style={{ ...BASE, ...(VARIANT[variant] || VARIANT.title) }}>
      {children}
    </div>
  );
}
