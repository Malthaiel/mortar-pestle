// Sentiment tint for a chess.com-style classification label — accent for positive,
// error for negative, muted otherwise. Shared by the Scrim Viewer notes list, the
// read-only AI provenance list, the retag menu, and the review modal so the color
// vocabulary lives in one place. Pure (returns a CSS-var string; no React).
export const GOOD_LABELS = ['Brilliant', 'Great', 'Best', 'Excellent', 'Good'];
export const BAD_LABELS = ['Inaccuracy', 'Mistake', 'Miss', 'Blunder'];
export const classColor = (label) =>
  GOOD_LABELS.includes(label) ? 'var(--accent)' : BAD_LABELS.includes(label) ? 'var(--error)' : 'var(--text-muted)';
