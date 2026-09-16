import StatusBadge from './StatusBadge.jsx';

// The post's read-only facts fused into one run: roadmap status (leading, it is the
// one that carries colour), then category, then comment count. The two plain halves
// borrow StatusBadge's .fb-status treatment — inert, no
// hover-flip, no pointer — because none of the three is a control.
export default function MetaRun({ category, status, commentCount = 0 }) {
  return (
    <div className="candy-split">
      <StatusBadge status={status} />
      <span className="candy-btn fb-status" data-shape="chip">
        <span className="candy-face" style={{ textTransform: 'capitalize' }}>{category}</span>
      </span>
      <span className="candy-btn fb-status" data-shape="chip">
        <span className="candy-face">{commentCount} comments</span>
      </span>
    </div>
  );
}
