import MiniRadialDial from './MiniRadialDial.jsx';
import ProgressPillar from './ProgressPillar.jsx';
import SessionTally from './SessionTally.jsx';
import SandTimer from './SandTimer.jsx';
import { useRailVariant } from '@host/hooks/useRailVariant.js';

export const PLANNER_RAIL_VARIANTS = [
  { id: 'dial',   label: 'Mini Radial Dial' },
  { id: 'pillar', label: 'Progress Pillar' },
  { id: 'tally',  label: 'Session Tally' },
  { id: 'sand',   label: 'Sand Timer' },
];

const DEFAULT_VARIANT = 'dial';

export function PlannerMiniRail({ accent }) {
  const [variant] = useRailVariant('planner', DEFAULT_VARIANT);
  switch (variant) {
    case 'pillar': return <ProgressPillar accent={accent}/>;
    case 'tally':  return <SessionTally accent={accent}/>;
    case 'sand':   return <SandTimer accent={accent}/>;
    case 'dial':
    default:       return <MiniRadialDial accent={accent}/>;
  }
}
