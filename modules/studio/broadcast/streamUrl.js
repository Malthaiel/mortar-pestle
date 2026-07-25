// SRT/RIST destination URL composition (SP5 SF4). Pure + dependency-free so the
// paired selftest can import it under bare node.
//
// SRT and RIST express the same two ideas under different names AND different
// units, and a wrong query key is silently IGNORED by the muxer rather than
// rejected — a 1000x-off delay would just quietly ship. So these are not
// guesses; they are what `ffmpeg -h protocol=srt|rist` reports on the bundled
// 8.1.1-full build:
//
//   SRT   latency      MICROseconds   passphrase
//   RIST  buffer_size  MILLIseconds   secret  (inert unless `encryption` rides along)
//
// The engine takes the finished URL opaque (service.json `type:"url"`), so this
// is the single place that knows either dialect.

/**
 * @param {'SRT'|'RIST'} proto
 * @param {string} base      user-typed address, may already carry a query
 * @param {string|number} delayMs  delay in MILLIseconds as typed; blank = service default
 * @param {string} password  blank = no encryption
 * @returns {string} the URL to hand the engine, '' when there is no address yet
 */
export function composeStreamUrl(proto, base, delayMs, password) {
  const b = String(base ?? '').trim();
  if (!b) return '';
  const q = [];
  const ms = Number(String(delayMs ?? '').trim());
  const pw = String(password ?? '').trim();
  if (Number.isFinite(ms) && ms > 0) {
    q.push(proto === 'RIST' ? `buffer_size=${ms}` : `latency=${ms * 1000}`);
  }
  if (pw) {
    q.push(proto === 'RIST'
      ? `secret=${encodeURIComponent(pw)}&encryption=128`
      : `passphrase=${encodeURIComponent(pw)}`);
  }
  if (!q.length) return b;
  return `${b}${b.includes('?') ? '&' : '?'}${q.join('&')}`;
}

export default composeStreamUrl;
