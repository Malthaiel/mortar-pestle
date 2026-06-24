import { getCurrentVersion, getLastSeenVersion } from '../hooks/useLastSeenVersion.js';

/**
 * Small "New" badge that pulses subtly. Shows only if the feature was added
 * in the current release and the user hasn't dismissed the What's New overlay yet.
 *
 * Usage:
 *   <NewBadge />
 *   — always shows the current version badge
 *
 *   <NewBadge featureId="layout-edit-mode" />
 *   — shows only if the feature is in the current release and user hasn't seen it
 */
export default function NewBadge({ show = true }) {
  if (!show) return null;
  const last = getLastSeenVersion();
  const current = getCurrentVersion();
  // If the user has already seen this version, don't show
  if (last === current) return null;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
        fontSize: 8, fontWeight: 700,
        color: 'var(--surface)',
        background: 'var(--accent)',
        borderRadius: 4,
        padding: '1px 5px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        lineHeight: 1,
        animation: 'newBadgePulse 2.5s ease-in-out infinite',
        flexShrink: 0,
      }}
    >
      new
    </span>
  );
}
