// Two-button up/down vote control (promoted from Prototypes.md). UPVOTE / DOWNVOTE
// word + count, no glyph; the caller's current vote (myVote: +1 up / -1 down / 0 none)
// lights with .is-active. onVote(value) is called with +1 or -1 — the backend toggles
// off when the same direction is clicked and switches on the opposite.
export default function VoteButton({ up = 0, down = 0, myVote = 0, onVote, size = 'small' }) {
  return (
    <div className="fb-vote">
      <button
        type="button"
        className={`candy-btn fb-vote-up${myVote === 1 ? ' is-active' : ''}`}
        data-size={size}
        title={myVote === 1 ? 'Remove your upvote' : 'Upvote'}
        onClick={() => onVote(1)}
      >
        <span className="candy-face">UPVOTE<span className="fb-vote-n">{up}</span></span>
      </button>
      <button
        type="button"
        className={`candy-btn fb-vote-down${myVote === -1 ? ' is-active' : ''}`}
        data-size={size}
        title={myVote === -1 ? 'Remove your downvote' : 'Downvote'}
        onClick={() => onVote(-1)}
      >
        <span className="candy-face">DOWNVOTE<span className="fb-vote-n">{down}</span></span>
      </button>
    </div>
  );
}
