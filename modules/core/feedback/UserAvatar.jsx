// A user's avatar: a cover image in a circle, else a hue-hashed initial (low-key,
// 48% colour-mixed into surface-3 — the same treatment as StatusBadge). Centred via
// line-height:1 + flex. size is the px diameter.
// The app's named palette (styles.css --hue-*), never local hexes — slate is left out on purpose,
// it reads as "no colour" and is the neutral/unknown hue everywhere else.
const HUES = ['var(--hue-teal)', 'var(--hue-rose)', 'var(--hue-indigo)', 'var(--hue-green)', 'var(--hue-amber)', 'var(--hue-violet)'];

function hueFor(name) {
  let h = 0;
  const s = name || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export default function UserAvatar({ src, name, size = 24 }) {
  const initial = ((name || '?').trim().charAt(0) || '?').toUpperCase();
  return (
    <span
      className="fb-avatar"
      title={name || ''}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: src ? 'var(--surface-3)' : `color-mix(in oklch, ${hueFor(name)} 48%, var(--surface-3))`,
      }}
    >
      {src ? <img src={src} alt={name || ''} /> : initial}
    </span>
  );
}
