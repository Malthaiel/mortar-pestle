// Official Docs page. Two-pane layout: left TOC sidebar (categories →
// entries), main reading pane (vault_render_reference body) with sticky
// header, breadcrumbs, prev/next nav. Manifest comes from `docs_get_manifest`;
// bodies from the existing `vault_render_reference` pipeline.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { navigate } from '../../router.js';
import { useDocsManifest } from './useDocsManifest.js';
import DocsHeader from './DocsHeader.jsx';
import DocsPrevNext from './DocsPrevNext.jsx';
import DocsReleasesTab from './DocsReleasesTab.jsx';
import { readSectionPage } from '../../hooks/useSectionMemory.js';

export default function DocsPage({ route, accent }) {
  const { manifest, error } = useDocsManifest();

  // 'releases' is a reserved sub (not a manifest category) — the Releases view
  // folded in from the retired standalone page. Independent of the docs manifest.
  const isReleases = route.sub === 'releases';

  // Flatten manifest into an ordered list for prev/next walking.
  const flatEntries = useMemo(() => {
    if (!manifest) return [];
    const out = [];
    for (const cat of manifest.categories) {
      for (const e of cat.entries) {
        out.push({ ...e, category: cat });
      }
    }
    return out;
  }, [manifest]);

  // Resolve current entry from route.sub (category id) + route.rest (slug).
  const currentIdx = useMemo(() => {
    if (!flatEntries.length) return -1;
    if (!route.sub) return 0;
    const idx = flatEntries.findIndex(
      e => e.category.id === route.sub && e.id === (route.rest || flatEntries.find(x => x.category.id === route.sub)?.id),
    );
    if (idx >= 0) return idx;
    // Fall back to first entry in the matched category
    const catIdx = flatEntries.findIndex(e => e.category.id === route.sub);
    return catIdx >= 0 ? catIdx : 0;
  }, [flatEntries, route.sub, route.rest]);

  const current = currentIdx >= 0 ? flatEntries[currentIdx] : null;
  const prev = currentIdx > 0 ? flatEntries[currentIdx - 1] : null;
  const next = currentIdx >= 0 && currentIdx < flatEntries.length - 1 ? flatEntries[currentIdx + 1] : null;

  const [body, setBody] = useState(null);
  const [mtime, setMtime] = useState(null);

  useEffect(() => {
    if (!current || isReleases) return;
    let alive = true;
    setBody(null);
    api.getPage(current.path, 'app')
      .then(r => { if (alive) { setBody(r.html); setMtime(r.mtime); } })
      .catch(e => { if (alive) { setBody(`<p style="color:var(--text-muted)">Failed to load: ${e.message || e}</p>`); } });
    return () => { alive = false; };
  }, [current?.path, isReleases]);

  // On a bare /docs visit, restore the last-viewed entry (mirrors KnowledgePage);
  // fall back to the first entry if nothing saved or the saved path no longer exists.
  useEffect(() => {
    if (manifest && !route.sub && flatEntries.length) {
      const remembered = readSectionPage('docs');
      const saved = remembered
        ? flatEntries.find(e => `/docs/${e.category.id}/${e.id}` === remembered)
        : null;
      const target = saved || flatEntries[0];
      navigate(`/docs/${target.category.id}/${target.id}`);
    }
  }, [manifest, route.sub, flatEntries]);

  if (isReleases) {
    return (
      <div className="docs-page">
        <div className="docs-main">
          <DocsReleasesTab accent={accent}/>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="docs-page">
        <div style={{ padding: 32, color: 'var(--text-muted)' }}>
          Docs manifest could not be loaded: {error}
        </div>
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="docs-page">
        <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading docs…</div>
      </div>
    );
  }

  return (
    <div className="docs-page">
      <div className="docs-main">
        <DocsHeader
          title={current?.title || ''}
          category={current?.category.label || ''}
          mtime={mtime}
          accent={accent}
        />
        <div className="docs-body-wrap">
          {body == null ? (
            <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading…</div>
          ) : (
            <div
              className="reference-render docs-body"
              dangerouslySetInnerHTML={{ __html: body }}
            />
          )}
          <DocsPrevNext prev={prev} next={next} accent={accent}/>
        </div>
      </div>
    </div>
  );
}
