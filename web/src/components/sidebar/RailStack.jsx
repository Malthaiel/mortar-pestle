// Host container for the collapsed-sidebar rail. Reads the active module's
// `slot.renderRail` callback (registered via api.slots.registerLeftSidebar)
// and lays the result out as a top-anchored vertical column. Modules that
// don't define `renderRail` fall back to a rotated display-name label.

import RailEmptyState from './RailEmptyState.jsx';

export default function RailStack({ slot, manifest, accent }) {
  const renderRail = slot?.renderRail;
  if (typeof renderRail !== 'function') {
    return <RailEmptyState manifest={manifest} accent={accent}/>;
  }
  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: 10,
      paddingTop: 12,
      overflow: 'hidden',
    }}>
      {renderRail({ accent })}
    </div>
  );
}
