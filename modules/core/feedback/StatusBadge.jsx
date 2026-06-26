// Read-only roadmap status as a muted candy badge — the same low-key treatment as
// UserAvatar (colour-mixed 48% into surface-3), distinct from the interactive dev
// StatusDropdown. The whole badge is the status colour, held via inline --cbtn-band
// (so band + frame darken to match); inert, no hover-flip.
const STATUS = {
  open:         { label: 'Open',         hue: '#8a8f98' },
  under_review: { label: 'Under review', hue: '#d6a445' },
  planned:      { label: 'Planned',      hue: '#9b7fd4' },
  in_progress:  { label: 'In progress',  hue: 'var(--accent)' },
  done:         { label: 'Done',         hue: '#5bb98c' },
  declined:     { label: 'Declined',     hue: 'var(--error)' },
};

export default function StatusBadge({ status }) {
  const s = STATUS[status] || { label: status || 'Unknown', hue: '#8a8f98' };
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
