import { useState, useEffect, useCallback } from 'react';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { FilterChip } from '@host/components/ui/Pill.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import SignInModal from './SignInModal.jsx';
import ComposeModal from './ComposeModal.jsx';
import { useSession } from './useSession.js';
import VoteButton from './VoteButton.jsx';
import StatusBadge from './StatusBadge.jsx';
import UserAvatar from './UserAvatar.jsx';

const CATEGORY_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'bug', label: 'Bugs' },
  { value: 'feature', label: 'Features' },
  { value: 'improvement', label: 'Improvements' },
  { value: 'other', label: 'Other' },
];
const SORTS = [{ value: 'new', label: 'Newest' }, { value: 'top', label: 'Top voted' }];

export default function BoardPage({ api, fb, accent }) {
  const { session, refresh: refreshSession } = useSession(fb);
  const [posts, setPosts] = useState([]);
  const [voted, setVoted] = useState(new Map());
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('new');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showSignIn, setShowSignIn] = useState(false);
  const [showCompose, setShowCompose] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const list = await fb.postsList(category, null, sort);
      setPosts(Array.isArray(list) ? list : []);
    } catch (e) { setError(e.message || 'Could not load posts'); }
    finally { setLoading(false); }
  }, [fb, category, sort]);

  useEffect(() => { load(); }, [load]);

  // Which posts the signed-in user voted on (for the highlight).
  useEffect(() => {
    if (!session?.signedIn) { setVoted(new Map()); return; }
    fb.myInteractions()
      .then((r) => setVoted(new Map((r?.votes || []).map((v) => [v.post_id, v.value]))))
      .catch(() => {});
  }, [session, fb]);

  const onVote = async (post, value) => {
    if (!session?.signedIn) { setShowSignIn(true); return; }
    try {
      const r = await fb.voteSet(post.id, value);
      setVoted((prev) => { const n = new Map(prev); r.value ? n.set(post.id, r.value) : n.delete(post.id); return n; });
      setPosts((prev) => prev.map((p) =>
        p.id === post.id ? { ...p, upvote_count: r.upvote_count, downvote_count: r.downvote_count, score: r.score } : p));
    } catch (e) { console.error('vote failed', e); }
  };

  const newPost = () => (session?.signedIn ? setShowCompose(true) : setShowSignIn(true));

  return (
    <div style={{ padding: '24px 28px', maxWidth: 860, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text)' }}>Feedback</div>
        <div style={{ flex: 1 }} />
        {session?.signedIn
          ? <OutlinedBtn small title="Manage in Settings → Feedback">@{session.profile?.handle || 'you'}</OutlinedBtn>
          : <OutlinedBtn small onClick={() => setShowSignIn(true)}>Sign in</OutlinedBtn>}
        <PrimaryBtn small onClick={newPost}>New post</PrimaryBtn>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {CATEGORY_FILTERS.map((c) => (
          <FilterChip key={c.value} active={category === c.value} accent={accent} onClick={() => setCategory(c.value)}>
            {c.label}
          </FilterChip>
        ))}
        <div style={{ flex: 1 }} />
        <CandySelect value={sort} options={SORTS} onChange={setSort} title="Sort" compact />
      </div>

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
      {error && <div style={{ color: 'var(--error)', fontSize: 13 }}>{error}</div>}
      {!loading && !error && posts.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '32px 0', textAlign: 'center' }}>
          No posts yet — be the first.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {posts.map((post) => (
          <PostRow
            key={post.id}
            post={post}
            myVote={voted.get(post.id) || 0}
            onVote={(value) => onVote(post, value)}
            onOpen={() => api.router.navigate(`/tools/feedback/post/${post.id}`)}
          />
        ))}
      </div>

      <SignInModal open={showSignIn} onClose={() => setShowSignIn(false)} fb={fb} accent={accent}
        onSignedIn={() => { refreshSession(); load(); }} />
      <ComposeModal open={showCompose} onClose={() => setShowCompose(false)} fb={fb} accent={accent}
        onCreated={() => load()} />
    </div>
  );
}

// One board row. Vote (two-button up/down), status badge, and author avatar are the
// promoted Prototypes components; the rest stays plain candy primitives.
function PostRow({ post, myVote, onVote, onOpen }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 14px',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)',
    }}>
      <div style={{ flexShrink: 0 }}>
        <VoteButton up={post.upvote_count ?? 0} down={post.downvote_count ?? 0} myVote={myVote} onVote={onVote} />
      </div>
      <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={onOpen}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          {post.pinned && <span title="Pinned" style={{ fontSize: 12 }}>📌</span>}
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {post.title}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
          <span style={{ textTransform: 'capitalize' }}>{post.category}</span>
          <span>·</span>
          <StatusBadge status={post.status} />
          <span>·</span>
          <span>{post.comment_count ?? 0} comments</span>
          {post.author?.handle && (
            <><span>·</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <UserAvatar name={post.author.handle} src={post.author.avatar_url} size={16} />@{post.author.handle}
            </span></>
          )}
        </div>
      </div>
    </div>
  );
}
