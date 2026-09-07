// The Processes window — a centred AppWindow listing everything the app is
// running right now, plus the handful that just finished. Same shell and same
// open/onClose/accent contract as RecyclingBinModal; AppWindow portals itself.
//
// The window tells the provider it is open, which is what gates the one polled
// lane (skill runs) and, from phase 2, the CPU/memory sampler. Closed window =
// zero polling.

import { useEffect } from 'react';
import { AppWindow, EmptyState } from '../components/ui';
import { IconCpu } from '../components/icons.jsx';
import { useProcesses } from './ProcessesProvider.jsx';
import ProcessRow from './ProcessRow.jsx';

export default function ProcessesModal({ open, onClose, accent }) {
  const { active, recent, cancel, setWindowOpen } = useProcesses();

  useEffect(() => {
    setWindowOpen(open);
    return () => setWindowOpen(false);
  }, [open, setWindowOpen]);

  return (
    <AppWindow
      open={open}
      onClose={onClose}
      title="Processes"
      icon={<IconCpu size={16} />}
      accent={accent}
      width={640}
      height="min(560px, 80vh)"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="section-title section-title--sub">Running{active.length ? ` (${active.length})` : ''}</div>
          {active.length === 0
            ? <EmptyState message="Nothing is running." />
            : active.map((r) => <ProcessRow key={r.id} row={r} accent={accent} onCancel={cancel} />)}
        </div>

        {recent.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="section-title section-title--sub">Recently finished</div>
            {recent.map((r) => <ProcessRow key={r.id} row={r} accent={accent} onCancel={cancel} />)}
          </div>
        )}
      </div>
    </AppWindow>
  );
}
