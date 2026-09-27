// The cover waiting line (musicApi.cover): one shared trip per cover, at most 6
// in flight, and an ask every asker has walked away from (the page was left)
// leaves the line unsent. Rust's own 6-slot line is first-come and can't be
// cancelled, so a repeat ask (StrictMode's double effect, a remount) or a left
// page's leftovers made the visible covers wait behind every queued download
// (2026-09-27). Own file, no imports, so node --test can load it.

const covers = new Map(); // key -> { k, args, askers, sent, promise, resolve, reject }
const line = [];
let slots = 6;

// `send(args)` makes the real trip; `signal` aborting = this asker left.
export function askCover(send, args, signal) {
  const k = `${args.kind}/${args.mbid}/${args.size}/${args.image || ''}`;
  let e = covers.get(k);
  if (!e) {
    e = { k, args, askers: 0, sent: false };
    e.promise = new Promise((resolve, reject) => { e.resolve = resolve; e.reject = reject; });
    covers.set(k, e);
    line.push(e);
  }
  e.askers++;
  signal?.addEventListener('abort', () => {
    if (--e.askers === 0 && !e.sent) {
      covers.delete(k); // pump skips it in the line
      e.reject(new DOMException('Left the page', 'AbortError'));
    }
  }, { once: true });
  pump(send);
  return e.promise;
}

function pump(send) {
  while (slots > 0 && line.length) {
    const e = line.shift();
    if (e.askers === 0) continue;
    e.sent = true;
    slots--;
    send(e.args).then(e.resolve, e.reject).finally(() => {
      covers.delete(e.k);
      slots++;
      pump(send);
    });
  }
}
