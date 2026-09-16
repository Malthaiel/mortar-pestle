import { useLayoutEffect, useRef, useState } from 'react';
import UserAvatar from './UserAvatar.jsx';
import { timeAgo } from '@host/util/time.js';

// Who posted it and when: the avatar circle, then the handle over the post's age.
// The circle's diameter is READ off the text block beside it (layout effect + a
// ResizeObserver, so it is right on the first paint and follows a font change)
// rather than restated as a constant.
export default function PostIdentity({ author, createdAt, gap = 9 }) {
  const textRef = useRef(null);
  const [size, setSize] = useState(0);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const read = () => setSize(Math.round(el.getBoundingClientRect().height));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap, maxWidth: '100%' }}>
      <UserAvatar size={size} name={author?.handle} src={author?.avatar_url} />
      <div ref={textRef} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>@{author?.handle || 'user'}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{timeAgo(createdAt)}</span>
      </div>
    </div>
  );
}
