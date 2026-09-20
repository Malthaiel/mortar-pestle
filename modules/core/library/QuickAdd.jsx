// Shared add-to-library affordance for the discovery surfaces (anime + music).
//
// AddToLibraryButton — full candy button for detail pages: the main segment
// adds with the default status, the chevron segment opens the context menu (useMenuTrigger) so the
// initial status can be picked at click time (quick-status). Presentational:
// the caller owns the enqueue + in-library detection. (A hover quick-add chip
// for browse cards was built and removed by request at the SF2 gate.)

import { useMenuTrigger } from '@host/context-menu/useContextMenu.js';
import { STATUS_ICON } from '@host/util/media-status.js';

export function AddToLibraryButton({ accent, statuses, defaultStatus, busy, added, disabled, onAdd }) {
  const dead = !!(busy || added || disabled);
  const text = added ? '✓ In library' : busy ? 'Adding' : '+ Add to Library';
  const menu = useMenuTrigger(() => statuses.map(s => ({
    label: s.replace(/-/g, ' '),
    icon: STATUS_ICON[s],
    shortcut: s === defaultStatus ? 'Default' : undefined,
    onClick: () => onAdd(s),
  })));

  return (
    <div style={{ display: 'inline-flex', gap: 3 }}>
      <button
        type="button"
        className="candy-btn"
        data-own-press
        disabled={dead}
        onClick={() => onAdd(defaultStatus)}
        title={added ? 'Already in your library' : `Add to library as ${String(defaultStatus).replace(/-/g, ' ')}`}
        style={{ '--accent': accent, height: 33, opacity: dead ? 0.65 : 1 }}
      ><span className="candy-face" style={{ padding: '0 14px', fontSize: 13 }}>{text}</span></button>

      <button
        type="button"
        className="candy-btn"
        data-own-press
        disabled={dead}
        {...menu}
        title="Add with a different status"
        aria-label="Add with a different status"
        style={{ '--accent': accent, height: 33, opacity: dead ? 0.65 : 1 }}
      ><span className="candy-face" style={{ padding: '0 9px', fontSize: 11 }}>▾</span></button>
    </div>
  );
}

