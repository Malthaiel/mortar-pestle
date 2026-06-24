// Shared horizontal strip of candy row-tiles — the one topbar used by the
// library module (anime + music stat strips) and the Settings drawer's
// sub-tab strips. Tiles read "Label" or "Label: count"; static tiles are
// inert read-outs; dividers are explicit entries so consumers control
// grouping; `dot: true` appends a modified-from-default marker. `leading`
// renders ahead of the tiles (e.g. the library Home icon button).

const fmt = (v) => (typeof v === 'number' ? v.toLocaleString() : v);

export default function Topbar({ tiles, activeId, onSelect, accent, leading, style }) {
  return (
    <div style={{
      flexShrink: 0,
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 14px 12px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface)',
      overflowX: 'auto',
      ...style,
    }}>
      {leading}
      {tiles.map((t, i) => t.divider
        ? <Divider key={'div-' + i} />
        : <Tile key={t.id} tile={t} accent={accent} active={t.id === activeId} onSelect={onSelect} />)}
    </div>
  );
}

function Divider() {
  return <div aria-hidden style={{ width: 1, height: 22, background: 'var(--border)', flexShrink: 0 }} />;
}

// Candy tab: grey shell, accent fill when active. Box props ride the base;
// layout / type props ride the face. Weight pinned at 500 — the .is-active
// 600 bold would widen the auto-sized tile and shift its neighbors.
function Tile({ tile, accent, active, onSelect }) {
  const text = tile.count !== undefined ? `${tile.label}: ${fmt(tile.count)}` : tile.label;
  const btnStyle = { '--accent': accent, width: 'auto', flexShrink: 0 };
  const faceStyle = {
    justifyContent: 'center',
    padding: '7px 13px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
  };
  if (tile.static) {
    return (
      <button
        type="button"
        disabled
        className="candy-btn"
        data-shape="row"
        style={{ ...btnStyle, cursor: 'default', opacity: 0.7, pointerEvents: 'none' }}
      ><span className="candy-face" style={faceStyle}>{text}</span></button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect?.(tile.id)}
      data-own-press
      disabled={tile.disabled}
      title={tile.title}
      className={'candy-btn' + (active ? ' is-active' : '')}
      data-shape="row"
      style={btnStyle}
    ><span className="candy-face" style={faceStyle}>
      {text}
      {tile.dot && (
        <span aria-hidden title="Modified from default" style={{
          width: 5, height: 5, borderRadius: '50%', background: 'currentColor',
          opacity: 0.8, marginLeft: 6, flexShrink: 0, display: 'inline-block',
        }}/>
      )}
    </span></button>
  );
}
