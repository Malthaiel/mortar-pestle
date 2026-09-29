import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { FilterChip } from '@host/components/ui/Pill.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import SignInModal from './SignInModal.jsx';
import ComposeModal from './ComposeModal.jsx';
import { useSession } from './useSession.js';
import VoteButton from './VoteButton.jsx';
import PostIdentity from './PostIdentity.jsx';
import MetaRun from './MetaRun.jsx';
import { candyGap } from '@host/util/candy.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { IconLayoutGrid, IconAlert, IconPackage, IconWrench, IconTag, IconSort, IconChart, IconPin } from '@host/components/icons.jsx';

// Leading icons follow Seg's shape ({ value, label, Icon } rendered at size 12
// inside .candy-face, which is already an inline-flex with a 6px gap).
const CATEGORY_FILTERS = [
  { value: 'all', label: 'All', Icon: IconLayoutGrid },
  { value: 'bug', label: 'Bugs', Icon: IconAlert },
  { value: 'feature', label: 'Features', Icon: IconPackage },
  { value: 'improvement', label: 'Improvements', Icon: IconWrench },
  { value: 'other', label: 'Other', Icon: IconTag },
];
const SORTS = [
  { value: 'new', label: <><IconSort size={12} />Newest</> },
  { value: 'top', label: <><IconChart size={12} />Top voted</> },
];

export default function BoardPage({ fb, accent, onOpen }) {
  const { session, refresh: refreshSession, ensureHandle } = useSession(fb);
  const [posts, setPosts] = useState([]);
  const [voted, setVoted] = useState(new Map());
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('new');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showSignIn, setShowSignIn] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const needsHandle = session?.signedIn && !session?.profile?.handle;

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
    if (!(await ensureHandle())) return;          // banner below explains
    try {
      const r = await fb.voteSet(post.id, value);
      setVoted((prev) => { const n = new Map(prev); r.value ? n.set(post.id, r.value) : n.delete(post.id); return n; });
      setPosts((prev) => prev.map((p) =>
        p.id === post.id ? { ...p, upvote_count: r.upvote_count, downvote_count: r.downvote_count, score: r.score } : p));
    } catch (e) { console.error('vote failed', e); }
  };

  // Right-click a post: picture actions + delete on your own, copy link on any.
  const { openContextMenu } = useContextMenu();
  const fileRef = useRef(null);
  const pendingPost = useRef(null);
  const isMine = (post) => !!session?.signedIn && !!post.author_id && post.author_id === session.userId;

  const onPickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';                                  // same file twice still fires
    const postId = pendingPost.current;
    if (!file || !postId) return;
    try {
      await fb.postImageUpload(postId, Array.from(new Uint8Array(await file.arrayBuffer())), file.type);
      load();
    } catch (err) { setError(err.message || 'Could not attach that image'); }
  };

  const postMenu = (e, post) => {
    const items = [];
    if (isMine(post)) {
      items.push({
        label: post.image_url ? 'Replace picture' : 'Add picture',
        onClick: () => { pendingPost.current = post.id; fileRef.current?.click(); },
      });
      if (post.image_url) items.push({
        label: 'Remove picture',
        onClick: async () => { try { await fb.postImageClear(post.id); load(); } catch (err) { setError(err.message); } },
      });
      items.push({ sep: true });
    }
    items.push({ label: 'Copy link', onClick: () => navigator.clipboard?.writeText(`mortar-pestle://feedback/${post.id}`) });
    if (isMine(post)) items.push(
      { sep: true },
      { label: 'Delete post', danger: true,
        onClick: async () => { try { await fb.postDeleteOwn(post.id); load(); } catch (err) { setError(err.message); } } },
    );
    openContextMenu(e, items, { accent, header: 'Post' });
  };

  const newPost = async () => {
    if (!session?.signedIn) return setShowSignIn(true);
    if (await ensureHandle()) setShowCompose(true);   // else banner below explains
  };

  return (
    <div style={{ padding: 20 }}>
      {needsHandle && (
        <div style={{
          fontSize: 13, color: 'var(--text)', marginBottom: 16, padding: '10px 14px',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
          background: 'color-mix(in oklch, var(--accent) 10%, var(--surface-2))',
        }}>
          Pick a handle in <strong>Settings → Feedback</strong> before you can post, vote, or comment.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {/* Standalone, not welded to the run. `fuse` is still what sizes it: it
            takes the run's own height and lets the menu size to its content — and
            a lone fused trigger is a Fragment, so this wrapper is what its
            absolute menu anchors to. Every control on this row is therefore the
            same height as a filter chip by construction, not by a copied number. */}
        <div style={{ position: 'relative' }}>
          <CandySelect icon={IconSort} value={sort} options={SORTS} onChange={setSort} title="Sort"
            fuse shape="chip" />
        </div>
        {/* position:relative — a fused CandySelect renders as a Fragment, so its
            absolute menu anchors to this run (see CandySelect's `fuse` note). */}
        <div className="candy-split">
          {CATEGORY_FILTERS.map((c) => (
            <FilterChip key={c.value} active={category === c.value}
              accent={accent} onClick={() => setCategory(c.value)}>
              <c.Icon size={12} />{c.label}
            </FilterChip>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {/* No sign-in / handle chip here (user-directed 2026-09-16): signing in is
            prompted by SignInModal when you vote or post, and the handle lives in
            Settings → Feedback. */}
        <FilterChip active accent={accent} onClick={newPost}>New post</FilterChip>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading</div>}
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
            onOpen={() => onOpen(post.id)}
            onContextMenu={(e) => postMenu(e, post)}
          />
        ))}
      </div>

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp"
        onChange={onPickImage} style={{ display: 'none' }} />

      <SignInModal open={showSignIn} onClose={() => setShowSignIn(false)} fb={fb} accent={accent}
        onSignedIn={() => { refreshSession(); load(); }} />
      <ComposeModal open={showCompose} onClose={() => setShowCompose(false)} fb={fb} accent={accent}
        onCreated={() => load()} />
    </div>
  );
}

// One board row: who posted it, the title and the vote run down the left; the post's
// facts and its picture down the right. The whole card is the link into the post.
//
// The card's height is the LEFT column's, and the picture is OUT OF FLOW so it can
// never widen the right column: an in-flow <img> hands the column its natural width
// (1600px here), which won the sizing round and squeezed the left column to 0 —
// title clipped to nothing, the date wrapped to two lines, card 151 vs 135
// (measured 2026-09-15). Absolutely positioned, it contributes no width at all; its
// height comes from the top/bottom inset and its width from the 16:9 ratio.
//
// Vertical gaps: a candy control's depth lip is a box-shadow drawn OUTSIDE layout, so
// the gap FOLLOWING one has to add that depth to paint the same as a plain gap —
// candyGap() does it from the one base number (util/candy.js).
//
// INSET is the single number every PAINTED gap to the card's edge is derived from:
// all four sides, and the picture's own top and bottom. Measured before the fix the
// four read 12 / 14 / 14 / 10 and the picture 8 above, 15 below (2026-09-15).
// ONE number: every painted gap on the card — all four edges, both row gaps in each
// column, and the picture's own top and bottom — is derived from GAP.
const GAP = 10;

function PostRow({ post, myVote, onVote, onOpen, onContextMenu }) {
  // The right column is PINNED to the left column's measured height. Flex alone
  // could not do it: the picture's own 16:9 preferred height won the sizing round
  // and grew the card by 16px (measured 150.8 vs 134.8, 2026-09-15).
  const leftRef = useRef(null);
  const [leftH, setLeftH] = useState(0);
  useLayoutEffect(() => {
    const el = leftRef.current;
    if (!el) return;
    const read = () => setLeftH(Math.round(el.getBoundingClientRect().height));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      onClick={onOpen}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12,
        padding: GAP, paddingBottom: candyGap(GAP, true), cursor: 'pointer',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)',
      }}
    >
      <div ref={leftRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: GAP, flex: 1, minWidth: 0 }}>
        <PostIdentity author={post.author} createdAt={post.created_at} />

        {/* marginLeft: the title is bare text with no frame around it, so it reads a
            touch further left than the framed avatar and vote run beside it. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 5, maxWidth: '100%', minWidth: 0 }}>
          {post.pinned && <span title="Pinned" style={{ fontSize: 12 }}><IconPin size="1em"/></span>}
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {post.title}
          </span>
        </span>

        <VoteButton up={post.upvote_count ?? 0} down={post.downvote_count ?? 0} myVote={myVote} onVote={onVote} />
      </div>

      {/* Still pinned to the left column's measured box, so the LEFT column keeps
          setting the card's height. The gap under the MetaRun is candyGap(INSET), the
          same as the one under the vote run, so both paint INSET. */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: candyGap(GAP, true), minHeight: 0, height: leftH || undefined,
      }}>
        <MetaRun category={post.category} status={post.status} commentCount={post.comment_count ?? 0} />
        {post.image_url && (
          <div style={{ flex: '1 1 0', minHeight: 0, alignSelf: 'stretch', position: 'relative' }}>
            <div style={{
              // Reaches BELOW the column by the vote run's depth lip — that lip is a
              // box-shadow outside layout, so stopping at the column's box left the
              // picture 5px short of the run's painted bottom and the card's two
              // bottom gaps could never match.
              position: 'absolute', top: 0, right: 0, aspectRatio: '16 / 9', overflow: 'hidden',
              bottom: 'calc(-1 * var(--candy-depth-small))',
              borderRadius: 'var(--radius-md)', background: 'var(--surface-3)',
              // Same frame a candy chip wears, from the same tokens — the outer boxes
              // already line up, but a 1px border let the picture's face paint 1px
              // past the "0 comments" chip's (measured 1113 vs 1112, 2026-09-15).
              border: '2px solid color-mix(in oklch, var(--cbtn-rest), black 22%)',
            }}>
              <img src={post.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
