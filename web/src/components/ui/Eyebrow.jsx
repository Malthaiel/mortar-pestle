// The app's small uppercase label treatment — the "eyebrow" that sits above a
// value, a field, or a group of rows.
//
// `eyebrowStyle` is an OBJECT, not a component, on purpose: every call site
// spreads it into a larger inline style (`{ ...eyebrowStyle, marginBottom: 8 }`),
// which a wrapper element would fight. It is the exact recipe that was declared
// byte-identically at 19 sites before this file existed.
//
// Deliberately NOT a catch-all. A survey of every uppercase label in the app
// (2026-08-28) found ~20 distinct recipes, not one — sizes 9 / 10 / 10.5 / 11 /
// 12, letter-spacings 0.06 / 0.08 / 0.1 / 0.14em, some bold and some not. Only
// the two clusters that were genuinely identical live here; folding the rest in
// would have moved pixels nobody asked to move. Match this recipe exactly or
// keep your own — do not widen this one to fit a near-miss.
export const eyebrowStyle = {
  fontSize: 9,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.08em',
  color: 'var(--text-faint)',
  fontWeight: 600,
};

// The ruled sub-heading used across the Anime and Music detail pages: same
// eyebrow family, but larger, unbolded, and closed with a hairline rule. Was a
// byte-identical local `SectionHeader` in seven files. Named `EyebrowHeading`
// because `SectionHeader` is already taken by the 30px page-level header in
// Section.jsx — a completely different thing.
export function EyebrowHeading({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em',       padding: '0 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 12,
    }}>{children}</div>
  );
}
