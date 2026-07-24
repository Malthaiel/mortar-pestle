// Read-only roadmap status as a muted candy badge — the same low-key treatment as
// UserAvatar (colour-mixed 48% into surface-3), distinct from the interactive dev
// StatusDropdown. The whole badge is the status colour, held via inline --cbtn-band
// (so band + frame darken to match); inert, no hover-flip.
// Hues come from the app's named palette (styles.css --hue-*), never a local hex — the same seven
// colours the avatar circles and the VOD report's stamp chips draw from, so a retune is one edit.
const STATUS = {
  open:         { label: 'Open',         hue: 'var(--hue-slate)' },
  under_review: { label: 'Under review', hue: 'var(--hue-amber)' },
  planned:      { label: 'Planned',      hue: 'var(--hue-violet)' },
  in_progress:  { label: 'In progress',  hue: 'var(--accent)' },
  done:         { label: 'Done',         hue: 'var(--hue-green)' },
  declined:     { label: 'Declined',     hue: 'var(--error)' },
};

export default function StatusBadge({ status }) {
  const s = STATUS[status] || { label: status || 'Unknown', hue: 'var(--hue-slate)' };
  return (
    <span
      className="candy-btn fb-status"
      data-size="small"
      style={{ '--cbtn-band': `color-mix(in oklch, ${s.hue} 48%, var(--surface-3))` }}
    >
      <span className="candy-face" style={{ background: 'var(--cbtn-band)', color: 'var(--text)' }}>
        {s.label}
      </span>
    </span>
  );
}
