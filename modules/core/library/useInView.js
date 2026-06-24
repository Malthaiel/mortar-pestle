// Fire once when an element scrolls within `rootMargin` of the viewport. Used to
// defer off-screen Jikan poster fetches (Related rows) until they're nearly
// visible, instead of firing every card's network call on mount. Degrades to
// "always in view" where IntersectionObserver is unavailable.

import { useEffect, useRef, useState } from 'react';

export default function useInView(rootMargin = '250px') {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { setInView(true); io.disconnect(); }
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [inView, rootMargin]);
  return [ref, inView];
}
