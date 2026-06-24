// Debounced USDA food search (Health Column epic, sub-plan 2). Mirrors the
// AnimeHome search pattern: a 350ms trailing debounce + a reqId race guard so
// the last query wins and stale responses are dropped. The component owns the
// query string (controlled input) and passes it in; results clear on an empty
// query.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export function useFoodSearch(query, { limit = 40, delay = 350 } = {}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  useEffect(() => {
    const q = (query || '').trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      setError(null);
      return undefined;
    }
    const myId = ++reqId.current;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const r = await api.usda.search(q, limit);
        if (myId === reqId.current) setResults(r || []);
      } catch (e) {
        if (myId === reqId.current) setError(e?.message || 'Search failed');
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, delay);
    return () => clearTimeout(t);
  }, [query, limit, delay]);

  return { results, loading, error };
}
