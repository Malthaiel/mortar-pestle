import Spine from './Spine.jsx';
import VinylSpindle from './VinylSpindle.jsx';
import LiveWaveform from './LiveWaveform.jsx';
import AlbumStack from './AlbumStack.jsx';
import { useRailVariant } from '@host/hooks/useRailVariant.js';

export const MUSIC_RAIL_VARIANTS = [
  { id: 'spine',    label: 'Spine Player' },
  { id: 'vinyl',    label: 'Vinyl Spindle' },
  { id: 'waveform', label: 'Live Waveform' },
  { id: 'stack',    label: 'Album Stack' },
];

const DEFAULT_VARIANT = 'spine';

export function MusicMiniRail({ accent }) {
  const [variant] = useRailVariant('music', DEFAULT_VARIANT);
  switch (variant) {
    case 'vinyl':    return <VinylSpindle accent={accent}/>;
    case 'waveform': return <LiveWaveform accent={accent}/>;
    case 'stack':    return <AlbumStack accent={accent}/>;
    case 'spine':
    default:         return <Spine accent={accent}/>;
  }
}
