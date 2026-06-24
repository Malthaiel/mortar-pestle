// The Downloads dock button + active-count badge. Mounted by Dock.jsx's
// renderBtn special-case (mirrors the notification bell). Reads the global
// active-download count so the badge + glow stay live from any route; tags
// itself [data-downloads-btn] so the popup can anchor above it and the panel's
// click-outside guard can exempt it.

import DockButton from '../components/dock/DockButton.jsx';
import { IconDownload } from '../components/icons.jsx';
import { useAllDownloads } from './DownloadsProvider.jsx';

export default function DownloadsDockButton({ label, onClick, isActive, accent, onContextMenu }) {
  const { activeCount } = useAllDownloads();
  const running = activeCount > 0;
  return (
    <span
      data-downloads-btn
      style={{
        display: 'inline-flex', position: 'relative',
        filter: running
          ? `drop-shadow(0 0 6px color-mix(in oklch, ${accent || 'var(--accent)'} 70%, transparent))`
          : undefined,
        transition: 'filter 240ms ease',
      }}
    >
      <DockButton Icon={IconDownload} label={label} onClick={onClick} isActive={isActive} accent={accent} onContextMenu={onContextMenu} />
      {running && (
        <span
          key={activeCount}
          aria-label={`${activeCount} active downloads`}
          style={{
            position: 'absolute', top: -3, right: -3, zIndex: 1,
            minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 8, background: accent || 'var(--accent)', color: '#fff',
            fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)', lineHeight: 1,
            border: '1.5px solid var(--dock-bg, oklch(0.190 0.005 78))', pointerEvents: 'none',
            animation: 'badgeTick 320ms cubic-bezier(0.34,1.56,0.64,1)',
          }}
        >{activeCount > 99 ? '99+' : activeCount}</span>
      )}
    </span>
  );
}
