import { useEffect, useState } from 'react';
import { api, subscribeEvents } from '../../api.js';

export default function UpdateQueue({ accent }) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const accentBg = accent || 'var(--text)';

  const load = () => {
    setLoading(true);
    api.getUpdateQueue()
      .then(({ html }) => setHtml(html))
      .catch(err => setHtml(`<p style="color:#e07b7b">${err.message}</p>`))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const unsub = subscribeEvents((name) => { if (name === 'queue') load(); });
    return () => unsub();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{
        padding: '10px 24px', borderBottom: '1px solid var(--border)',
        fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
        color: 'var(--text)', textTransform: 'uppercase',
        borderLeft: `3px solid ${accentBg}`,
      }}>Update Queue</div>
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
        {loading
          ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
          : <div
              className="reference-render"
              style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.6 }}
              dangerouslySetInnerHTML={{ __html: html }}
            />}
      </div>
    </div>
  );
}
