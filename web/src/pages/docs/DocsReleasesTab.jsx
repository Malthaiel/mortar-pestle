import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconSearch } from '../../components/icons.jsx';
import { useReleases, latestPublishedVersion, bumpVersion, inferBumpLevel } from '../../hooks/useReleases.js';
import {
  useReleaseQueue, mergeQueue, parseReleaseQueue,
  composeReleaseBlock, composeFullReleases, composeQueueRetaining,
  AREA_PALETTE, orderAreaNames,
} from '../../hooks/useReleaseQueue.js';
import { PrimaryBtn, OutlinedBtn } from '../../components/ui/Button.jsx';
import { Seg } from '../../components/ui/Pill.jsx';
import { renderInline } from '../../components/ui/inlineMarkdown.jsx';
import { api } from '../../api.js';
import { sharedEvents } from '../../module-sdk/index.js';
import { useManifests } from '../../module-sdk/useModuleRegistry.js';
import { moduleIdForArea } from '../../hooks/useModuleAreas.js';

const BUMP_LEVELS = ['patch', 'minor', 'major'];
// Two-tier 0.x scheme: patch is the default ship, minor is a deliberate
// milestone judgment, major (1.0.0) is reserved for public readiness.
const BUMP_LABELS = { patch: 'Patch', minor: 'Minor (milestone)', major: 'Major (1.0, reserved)' };
const CANON = ['New', 'Changed', 'Removed', 'Performance', 'Fixed', 'Migration', 'Known Issues', 'Process'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Section heading + bullet-dot color by type (accent for the neutral ones).
const sectionColor = (name, accent) => ({
  New: accent, Changed: accent, Removed: 'var(--text)', Performance: '#8b5cf6',
  Fixed: '#2a9d4a', Migration: '#c78a1a', 'Known Issues': '#c78a1a',
  Process: 'var(--text-faint)',
}[name] || accent);

// ── Releases search index + ranking (mirrors the Settings drawer recipe) ────

const plainText = (s) => String(s || '').replace(/\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g, (_, a, b, c) => a || b || c || '');

// One release-level row per release (version / Was / date / summary hay) plus
// one bullet-level row per bullet (name / prose / area / section / versions).
function buildSearchIndex(releases) {
  const rows = [];
  releases.forEach((r, releaseIndex) => {
    const versionLabel = r.versionLabel || `v${r.version}`;
    rows.push({
      kind: 'release',
      id: `rel|${r.version}`,
      releaseIndex,
      version: r.version,
      versionLabel,
      date: r.date,
      summary: r.summary || '',
      hay: [
        versionLabel, r.version,
        ...(r.wasLabel ? [r.wasLabel] : []), ...(r.was ? [r.was, `v${r.was}`] : []),
        r.date, plainText(r.summary || ''), r.tag || '',
      ].join(' ').toLowerCase(),
    });
    for (const area of (r.areas || [])) {
      for (const section of CANON) {
        const items = area.sections?.[section];
        if (!items?.length) continue;
        items.forEach((text, i) => {
          const name = plainText((text.match(/^\*\*(.+?)\*\*/) || [])[1] || text.split(/\s+/).slice(0, 6).join(' '));
          rows.push({
            kind: 'bullet',
            id: `${r.version}|${area.name}|${section}|${i}`,
            releaseIndex,
            version: r.version,
            versionLabel,
            area: area.name,
            section,
            name,
            hay: [name, plainText(text), area.name, section, r.version, ...(r.was ? [r.was] : [])]
              .join('').toLowerCase(),
          });
        });
      }
    }
  });
  return rows;
}

const VERSIONISH = /^v?\d+(\.\d+)*$/;

// Ranked substring search: 0 = release row on a version-like query / bullet
// name prefix, 1 = name contains, 2 = area/section/summary, 3 = prose.
// Stable by (rank, release order, file order); capped at 60.
function searchReleaseIndex(rows, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const versionish = VERSIONISH.test(q);
  const ranked = [];
  rows.forEach((row, order) => {
    if (!row.hay.includes(q)) return;
    let rank;
    if (row.kind === 'release') {
      rank = versionish ? 0 : (row.summary.toLowerCase().includes(q) ? 2 : 1);
    } else {
      const name = row.name.toLowerCase();
      if (name.startsWith(q)) rank = 0;
      else if (name.includes(q)) rank = 1;
      else if (row.area.toLowerCase().includes(q) || row.section.toLowerCase().includes(q)) rank = 2;
      else rank = 3;
    }
    ranked.push({ row, rank, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.row.releaseIndex - b.row.releaseIndex || a.order - b.order);
  return ranked.slice(0, 60).map(r => r.row);
}

export default function DocsReleasesTab({ accent }) {
  const { releases, loading, reload: reloadReleases } = useReleases();
  const queue = useReleaseQueue();
  const [expanded, setExpanded] = useState(new Set());
  const [visibleNodes, setVisibleNodes] = useState(new Set());
  const nodeRefs = useRef(new Map());
  const [query, setQuery] = useState('');
  const [searchSel, setSearchSel] = useState(0);
  const searchInputRef = useRef(null);
  const flashTimer = useRef(null);

  const accentColor = accent || 'var(--accent)';

  const searchIndex = useMemo(() => buildSearchIndex(releases), [releases]);
  const results = useMemo(() => searchReleaseIndex(searchIndex, query), [searchIndex, query]);
  const searching = query.trim().length > 0;

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Pick a result: restore the timeline, expand the release, force its node
  // visible (a never-scrolled node sits at opacity 0 until the observer fires),
  // then scroll + flash — the bullet itself once the 260ms expand settles.
  const jumpTo = (row) => {
    setQuery('');
    setSearchSel(0);
    setExpanded(prev => new Set(prev).add(row.version));
    setVisibleNodes(prev => new Set(prev).add(String(row.releaseIndex)));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const card = nodeRefs.current.get(String(row.releaseIndex));
      card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const flash = (el) => {
        if (!el) return;
        el.classList.remove('settings-search-flash');
        void el.offsetWidth; // restart the animation if re-triggered
        el.classList.add('settings-search-flash');
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => el.classList.remove('settings-search-flash'), 1300);
      };
      if (row.kind === 'bullet') {
        setTimeout(() => {
          const sel = row.id.replace(/["\\]/g, '\\$&');
          const el = document.querySelector(`[data-bullet-id="${sel}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            flash(el);
          } else {
            flash(card);
          }
        }, 320);
      } else {
        flash(card);
      }
    }));
  };

  // IntersectionObserver for scroll-triggered node entrance
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const next = new Set(visibleNodes);
        for (const entry of entries) {
          const idx = entry.target.dataset.idx;
          if (entry.isIntersecting && idx != null) {
            next.add(idx);
          }
        }
        setVisibleNodes(next);
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    for (const el of nodeRefs.current.values()) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [releases.length, visibleNodes]);

  const toggleExpand = (version) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  // Bump base + carried Tag come from the newest published release.
  const latestVersion = (releases[0]?.version || '').match(/(\d+\.\d+\.\d+)/)?.[1] || '0.0.0';
  const tag = releases[0]?.tag || 'Early Stage';

  return (
    <div style={pageStyle}>
      <ReleaseQueuePanel
        accent={accentColor}
        queue={queue}
        latestVersion={latestVersion}
        tag={tag}
        onShipped={() => { reloadReleases(); queue.reload(); }}
      />

      {loading ? (
        <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Loading release history…</div>
      ) : !releases.length ? (
        <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>No releases found.</div>
      ) : (
        <>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 28 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 21, fontWeight: 600, color: 'var(--text)',
                letterSpacing: '-0.01em', marginBottom: 4,
              }}>
                Release History
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                Every change, every fix, every moment the app grew.
              </div>
            </div>
            <ReleasesSearchPill
              inputRef={searchInputRef}
              value={query}
              onChange={(v) => { setQuery(v); setSearchSel(0); }}
              resultCount={searching ? results.length : 0}
              onArrow={(dir) => setSearchSel(s => {
                if (!results.length) return 0;
                return dir === 'down' ? Math.min(s + 1, results.length - 1) : Math.max(s - 1, 0);
              })}
              onEnter={() => { if (results[searchSel]) jumpTo(results[searchSel]); }}
              onClear={() => { setQuery(''); setSearchSel(0); }}
            />
          </div>

          {searching ? (
            <ReleasesResultsView
              results={results}
              selected={searchSel}
              accent={accentColor}
              onHover={setSearchSel}
              onPick={jumpTo}
            />
          ) : (
          <>
          {/* Timeline */}
          <div style={{ position: 'relative', paddingLeft: 24 }}>
            {/* Vertical line */}
            <div style={{
              position: 'absolute',
              left: 7, top: 8, bottom: 8,
              width: 2,
              background: 'var(--border-2)',
              borderRadius: 1,
            }} />

            {releases.map((release, index) => {
              const isVisible = visibleNodes.has(String(index));
              const isExpanded = expanded.has(release.version);
              const isLatest = index === 0;

              return (
                <div
                  key={release.version}
                  data-idx={String(index)}
                  ref={el => { nodeRefs.current.set(String(index), el); }}
                  style={{
                    position: 'relative',
                    marginBottom: index === releases.length - 1 ? 0 : 20,
                    opacity: isVisible ? 1 : 0,
                    transform: isVisible ? 'translateY(0)' : 'translateY(16px)',
                    transition: 'opacity 0.32s ease, transform 0.32s ease',
                  }}
                >
                  {/* Node */}
                  <div style={{
                    position: 'absolute',
                    left: -24 + 4,
                    top: 6,
                    width: 10, height: 10,
                    borderRadius: '50%',
                    background: isLatest ? accentColor : 'var(--surface-2)',
                    border: `2px solid ${isLatest ? accentColor : 'var(--border-2)'}`,
                    boxShadow: isLatest
                      ? `0 0 0 4px color-mix(in oklch, ${accentColor} 18%, transparent)`
                      : 'none',
                    transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
                    zIndex: 1,
                  }}
                    className="release-node"
                  />

                  {/* Card */}
                  <button
                    onClick={() => toggleExpand(release.version)}
                    className="release-card"
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      borderRadius: 'var(--radius-lg)',
                      padding: '14px 18px',
                      cursor: 'pointer',
                      display: 'flex', flexDirection: 'column', gap: 6,
                      fontFamily: 'var(--font-body)',
                      position: 'relative',
                      overflow: 'hidden',
                    }}
                  >
                    {/* Top row: version + tag + date */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    }}>
                      <span style={{
                        fontSize: 13, fontWeight: 700, color: 'var(--text)',
                        fontFamily: 'var(--font-mono)',
                        letterSpacing: '0.02em',
                      }}>
                        {release.versionLabel || release.version}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 600,
                        color: isLatest ? accentColor : 'var(--text-muted)',
                        border: `1px solid ${isLatest
                          ? `color-mix(in oklch, ${accentColor} 30%, transparent)`
                          : 'var(--border-2)'}`,
                        borderRadius: 4, padding: '1px 7px',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>
                        {release.tag}
                      </span>
                      <span style={{
                        fontSize: 11, color: 'var(--text-faint)',
                        marginLeft: 'auto', fontFamily: 'var(--font-mono)',
                      }}>
                        {release.date}
                      </span>
                    </div>

                    {/* Collapsed-card summary — the navigate-without-expanding hook */}
                    {release.summary ? (
                      <div style={{
                        fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5,
                      }}>
                        {renderInline(release.summary)}
                      </div>
                    ) : null}

                    {/* Expand indicator */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      marginTop: 2,
                    }}>
                      <span style={{
                        fontSize: 11, color: 'var(--text-faint)',
                        fontWeight: 500,
                      }}>
                        {isExpanded ? 'Collapse' : 'Expand'}
                      </span>
                      <span style={{
                        display: 'inline-block',
                        fontSize: 10, color: 'var(--text-faint)',
                        animation: isExpanded
                          ? 'chevronFlipDown 280ms cubic-bezier(0.32, 0.72, 0, 1) forwards'
                          : 'chevronFlipUp 280ms cubic-bezier(0.32, 0.72, 0, 1) forwards',
                      }}>
                        ▼
                      </span>
                    </div>

                    {/* Expanded details — grid-rows reveal animates to true height, no clip */}
                    <div style={{
                      display: 'grid',
                      gridTemplateRows: isExpanded ? '1fr' : '0fr',
                      opacity: isExpanded ? 1 : 0,
                      transition: 'grid-template-rows 260ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 180ms ease',
                      marginTop: isExpanded ? 8 : 0,
                    }}>
                      <div style={{ overflow: 'hidden', minHeight: 0 }}>
                        <div style={{
                          paddingTop: 12,
                          borderTop: '1px solid var(--border-soft)',
                          display: 'flex', flexDirection: 'column', gap: 14,
                        }}>
                          {release.wasLabel && (
                            <div style={{
                              fontSize: 10, fontFamily: 'var(--font-mono)',
                              color: 'var(--text-faint)', letterSpacing: '0.03em',
                            }}>
                              Was {release.wasLabel}
                            </div>
                          )}
                          {(release.areas || []).map(area => (
                            <AreaGroup
                              key={area.name}
                              area={area}
                              version={release.version}
                              accent={accentColor}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
          </>
          )}

          {/* Footer spacing */}
          <div style={{ height: 40 }} />
        </>
      )}
    </div>
  );
}

// --- Release Queue panel (pinned atop the page) ---

function ReleaseQueuePanel({ accent, queue, latestVersion, tag, onShipped }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [shipped, setShipped] = useState(null);

  const { entries = [], pending, loading, error } = queue;
  const merged = mergeQueue(entries);
  const level = inferBumpLevel(merged.sections);
  const nextVersion = bumpVersion(latestVersion, level);
  const isEmpty = !pending;

  return (
    <div className="candy-panel" style={{
      position: 'relative',
      padding: '14px 18px',
      marginBottom: 24,
      overflow: 'hidden',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em',
            textTransform: 'uppercase', color: isEmpty ? 'var(--text-faint)' : accent,
            fontWeight: 600, marginBottom: 3,
          }}>
            Release Queue
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {loading ? 'Loading queue…'
              : error ? 'Could not read the queue.'
              : isEmpty ? 'Nothing staged — entries land here as features close out.'
              : <>
                  <strong style={{ color: 'var(--text)' }}>{pending}</strong> pending
                  {' · '}→ {cap(level)}
                  {' '}
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>v{nextVersion}</span>
                </>}
          </div>
        </div>

        <PrimaryBtn
          accent={accent}
          small
          disabled={isEmpty || loading}
          onClick={() => { queue.reload(); setModalOpen(true); }}
        >
          Ship Release
        </PrimaryBtn>
      </div>

      {shipped && (
        <div style={{
          marginTop: 10, fontSize: 12, color: '#2a9d4a',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          ✓ Shipped <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>v{shipped}</span> — queue cleared.
        </div>
      )}

      {/* Queued entry list */}
      {!isEmpty && !loading && (
        <div style={{
          marginTop: 12, paddingTop: 12,
          borderTop: '1px solid var(--border-soft)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {entries.map((e, i) => {
            const counts = Object.entries(e.sections)
              .map(([k, v]) => `${k} ${v.length}`).join(' · ');
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{
                  width: 4, height: 4, borderRadius: '50%', background: accent,
                  marginTop: 6, flexShrink: 0, opacity: 0.7, alignSelf: 'center',
                }} />
                <span style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>
                  {renderInline(e.feature)}
                </span>
                {counts && (
                  <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                    {counts}
                  </span>
                )}
                {e.queuedDate && (
                  <span style={{
                    fontSize: 11, color: 'var(--text-faint)', marginLeft: 'auto',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {e.queuedDate}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <ShipReleaseModal
          accent={accent}
          queue={queue}
          latestVersion={latestVersion}
          tag={tag}
          onClose={() => setModalOpen(false)}
          onShipped={(v) => { setShipped(v); onShipped(); }}
        />
      )}
    </div>
  );
}

// --- Ship Release preview + confirm modal ---

function ShipReleaseModal({ accent, queue, latestVersion, tag, onClose, onShipped }) {
  const allEntries = queue.entries || [];
  const keyOf = (e) => `${e.feature}::${e.queuedDate || ''}`;
  // Unselected by default — shipping is opt-in per entry (Confirm stays disabled
  // until ≥1 is checked), so a stray Enter never ships the whole queue.
  const [selKeys, setSelKeys] = useState(() => new Set());
  const [level, setLevel] = useState('patch');
  const [levelTouched, setLevelTouched] = useState(false);
  const [summary, setSummary] = useState('');
  const [areaByKey, setAreaByKey] = useState({});
  const [areaEditKey, setAreaEditKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const effAreaOf = (e) => areaByKey[keyOf(e)] ?? e.area ?? 'General';
  const selected = allEntries
    .filter(e => selKeys.has(keyOf(e)))
    .map(e => ({ ...e, area: effAreaOf(e) }));
  const merged = mergeQueue(selected);
  // Bump defaults to patch (0.x scheme); minor/major are deliberate picks.
  const effectiveLevel = levelTouched ? level : inferBumpLevel(merged.sections);
  const version = bumpVersion(latestVersion, effectiveLevel);
  const date = new Date().toISOString().slice(0, 10);
  const block = composeReleaseBlock({
    date, version, tag,
    surfaces: merged.surfaces, summary, areas: merged.areas,
  });
  const allOn = allEntries.length > 0 && selected.length === allEntries.length;

  // Include list grouped by each entry's effective Area, palette-ordered
  // (no-area → General). Recomputed every render so a per-entry area override
  // re-buckets the entry live.
  const groups = (() => {
    const byArea = new Map();
    for (const e of allEntries) {
      const a = (effAreaOf(e) || 'General').trim() || 'General';
      if (!byArea.has(a)) byArea.set(a, []);
      byArea.get(a).push(e);
    }
    return orderAreaNames(new Set(byArea.keys())).map(name => ({ name, entries: byArea.get(name) }));
  })();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  function toggle(k) {
    setSelKeys(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }
  function toggleAll() {
    setSelKeys(allOn ? new Set() : new Set(allEntries.map(keyOf)));
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      // Re-read both files at confirm-time for fresh mtimes + content.
      const [rel, q] = await Promise.all([api.releases.readRaw(), api.releaseQueue.read()]);
      const parsed = parseReleaseQueue(q.content);
      const sel = parsed.entries
        .filter(e => selKeys.has(keyOf(e)))
        .map(e => ({ ...e, area: areaByKey[keyOf(e)] ?? e.area ?? 'General' }));
      if (!sel.length) { setError('Nothing selected to ship.'); setBusy(false); return; }
      const m2 = mergeQueue(sel);
      const base = latestPublishedVersion(rel.content) || latestVersion;
      const v2 = bumpVersion(base, effectiveLevel);
      const d2 = new Date().toISOString().slice(0, 10);
      const b2 = composeReleaseBlock({
        date: d2, version: v2, tag,
        surfaces: m2.surfaces, summary, areas: m2.areas,
      });
      const releasesContent = composeFullReleases(rel.content, b2, v2, d2);
      const queueContent = composeQueueRetaining(q.content, new Set(sel.map(keyOf)), d2);
      await api.releasePublish({
        releasesContent, queueContent, version: v2,
        releasesBaseMtime: rel.mtime, queueBaseMtime: q.mtime,
      });
      onShipped(v2);
      onClose();
    } catch (e) {
      setError(e?.code === 'CONFLICT'
        ? 'Releases.md or the queue changed since you opened this. Close and reopen to retry.'
        : (e?.message || String(e)));
      setBusy(false);
    }
  }

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div className="candy-backdrop" onMouseDown={() => { if (!busy) onClose(); }} />
      <div
        role="dialog" aria-modal="true"
        className="candy-modal"
        style={{
          position: 'relative',
          width: 'min(1150px, 96vw)', maxHeight: '86vh',
          display: 'flex', flexDirection: 'column',
          animation: 'plannerModalIn 280ms cubic-bezier(0.16, 1, 0.3, 1)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 18px', borderBottom: '1px solid var(--border-soft)',
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Ship Release</div>
          <span style={{
            fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 700,
            color: accent, padding: '1px 8px', borderRadius: 5,
            border: `1px solid color-mix(in oklch, ${accent} 30%, transparent)`,
          }}>
            v{version}
          </span>
          <button
            onClick={() => !busy && onClose()}
            style={{
              marginLeft: 'auto', background: 'transparent', border: 'none',
              color: 'var(--text-faint)', fontSize: 18, cursor: busy ? 'default' : 'pointer',
              lineHeight: 1, padding: 4,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Two-column body: left = Include + Bump, right = Summary + Preview */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* LEFT — Include (scrolls) over a pinned Bump */}
          <div style={{
            flex: '1 1 48%', minWidth: 0, display: 'flex', flexDirection: 'column',
            minHeight: 0, borderRight: '1px solid var(--border-soft)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px 8px' }}>
              <span style={{
                fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
              }}>
                Include
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {selected.length} of {allEntries.length} selected
              </span>
              <button
                onClick={toggleAll}
                disabled={busy || !allEntries.length}
                style={{
                  marginLeft: 'auto', background: 'transparent', border: 'none',
                  color: accent, fontSize: 11, fontWeight: 600,
                  cursor: busy ? 'default' : 'pointer', fontFamily: 'var(--font-body)',
                }}
              >
                {allOn ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 18px 12px' }}>
              <div style={{ border: '1px solid var(--border-soft)', borderRadius: 8, overflow: 'hidden' }}>
                {groups.map((group, gi) => (
                  <div key={group.name}>
                    {/* Area subheader — the #3 grouping */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '6px 10px', background: 'var(--surface-2)',
                      borderTop: gi === 0 ? 'none' : '1px solid var(--border-soft)',
                    }}>
                      <span aria-hidden style={{
                        width: 3, height: 11, borderRadius: 2, flexShrink: 0,
                        background: `color-mix(in oklch, ${accent} 65%, transparent)`,
                      }} />
                      <span style={{
                        fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
                        textTransform: 'uppercase', fontWeight: 700, color: 'var(--text)',
                      }}>
                        {group.name}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                        {group.entries.length}
                      </span>
                    </div>
                    {group.entries.map((e) => {
                      const k = keyOf(e);
                      const on = selKeys.has(k);
                      const effArea = effAreaOf(e);
                      const editing = areaEditKey === k;
                      return (
                        <div key={k} style={{ borderTop: '1px solid var(--border-soft)' }}>
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 10px', opacity: on ? 1 : 0.5,
                          }}>
                            <label style={{
                              display: 'flex', alignItems: 'center', gap: 10,
                              flex: 1, minWidth: 0, cursor: busy ? 'default' : 'pointer',
                            }}>
                              <input
                                type="checkbox" checked={on} disabled={busy}
                                onChange={() => toggle(k)}
                                style={{ accentColor: accent, cursor: busy ? 'default' : 'pointer' }}
                              />
                              <span style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500, flex: 1, minWidth: 0 }}>
                                {renderInline(e.feature)}
                              </span>
                            </label>
                            <button
                              type="button"
                              title="Assign area"
                              disabled={busy}
                              onClick={() => setAreaEditKey(editing ? null : k)}
                              style={{
                                fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600,
                                color: accent, background: 'transparent',
                                border: `1px solid color-mix(in oklch, ${accent} 30%, transparent)`,
                                borderRadius: 5, padding: '1px 7px',
                                cursor: busy ? 'default' : 'pointer', flexShrink: 0,
                              }}
                            >
                              {effArea}
                            </button>
                          </div>
                          {editing && (
                            <div style={{
                              display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center',
                              padding: '0 10px 10px 34px',
                            }}>
                              {AREA_PALETTE.map(name => {
                                const active = name === effArea;
                                return (
                                  <button
                                    key={name}
                                    type="button"
                                    disabled={busy}
                                    onClick={() => { setAreaByKey(prev => ({ ...prev, [k]: name })); setAreaEditKey(null); }}
                                    style={{
                                      fontSize: 10.5, padding: '3px 9px', borderRadius: 6,
                                      cursor: busy ? 'default' : 'pointer',
                                      fontFamily: 'var(--font-body)', fontWeight: 500,
                                      color: active ? accent : 'var(--text-muted)',
                                      background: active
                                        ? `color-mix(in oklch, ${accent} 12%, var(--surface))`
                                        : 'var(--surface-2)',
                                      border: `1px solid ${active
                                        ? `color-mix(in oklch, ${accent} 45%, var(--border))`
                                        : 'var(--border-2)'}`,
                                    }}
                                  >
                                    {name}
                                  </button>
                                );
                              })}
                              <input
                                type="text"
                                className="candy-input"
                                placeholder="Custom…"
                                defaultValue={AREA_PALETTE.includes(effArea) ? '' : effArea}
                                disabled={busy}
                                onKeyDown={(ev) => {
                                  if (ev.key === 'Enter') {
                                    const v = ev.currentTarget.value.trim();
                                    if (v) { setAreaByKey(prev => ({ ...prev, [k]: v })); setAreaEditKey(null); }
                                  }
                                }}
                                style={{ width: 110, padding: '3px 8px', fontSize: 11, outline: 'none' }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
                {!groups.length && (
                  <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-faint)' }}>
                    Nothing in the queue to ship.
                  </div>
                )}
              </div>
            </div>
            {/* Bump (pinned to the bottom of the left column) */}
            <div style={{
              padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 10,
              borderTop: '1px solid var(--border-soft)', flexWrap: 'wrap',
            }}>
              <span style={{
                fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
              }}>
                Bump
              </span>
              <Seg
                accent={accent}
                disabled={busy}
                value={effectiveLevel}
                onChange={(l) => { setLevelTouched(true); setLevel(l); }}
                options={BUMP_LEVELS.map(l => ({ value: l, label: `${BUMP_LABELS[l]} · v${bumpVersion(latestVersion, l)}` }))}
              />
            </div>
          </div>

          {/* RIGHT — Summary over the .md preview (scrolls) */}
          <div style={{ flex: '1 1 52%', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: '12px 18px 0' }}>
              <div style={{
                fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
                marginBottom: 6,
              }}>
                Summary
              </div>
              <textarea
                className="candy-input"
                rows={2}
                value={summary}
                disabled={busy}
                placeholder="1–2 sentences for the collapsed card — what arrived and why it matters."
                onChange={(e) => setSummary(e.target.value)}
                style={{
                  width: '100%', resize: 'vertical', outline: 'none',
                  fontSize: 12, lineHeight: 1.5, color: 'var(--text)',
                  fontFamily: 'var(--font-body)',
                }}
              />
            </div>
            <div style={{ padding: '12px 18px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
              {selected.length > 12 && (
                <div style={{
                  marginBottom: 10, fontSize: 12, color: '#c78a1a',
                  background: 'color-mix(in oklch, #c78a1a 8%, transparent)',
                  border: '1px solid color-mix(in oklch, #c78a1a 25%, transparent)',
                  borderRadius: 6, padding: '8px 10px',
                }}>
                  {selected.length} entries selected — consider shipping smaller batches more often to keep releases readable.
                </div>
              )}
              {!selected.length ? (
                <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '12px 0' }}>
                  Select at least one entry on the left to preview the release.
                </div>
              ) : (
              <pre className="candy-section" style={{
                margin: 0, padding: '12px 14px',
                fontSize: 11.5, lineHeight: 1.5,
                fontFamily: 'var(--font-mono)', color: 'var(--text)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {block}
              </pre>
              )}
              {error && (
                <div style={{
                  marginTop: 10, fontSize: 12, color: 'var(--text)',
                  background: 'color-mix(in oklch, var(--text) 8%, transparent)',
                  border: '1px solid color-mix(in oklch, var(--text) 25%, transparent)',
                  borderRadius: 6, padding: '8px 10px',
                }}>
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '12px 18px', borderTop: '1px solid var(--border-soft)',
        }}>
          {!summary.trim() && (
            <span style={{
              marginRight: 'auto', alignSelf: 'center',
              fontSize: 11, color: 'var(--text-faint)',
            }}>
              Summary required to ship
            </span>
          )}
          <OutlinedBtn onClick={() => !busy && onClose()} disabled={busy} small>Cancel</OutlinedBtn>
          <PrimaryBtn accent={accent} onClick={confirm} disabled={busy || !selKeys.size || !summary.trim()} small>
            {busy ? 'Shipping…' : 'Confirm & Ship'}
          </PrimaryBtn>
        </div>
      </div>
    </div>,
    document.body
  );
}

// One `### Area` group inside an expanded release — area header + that area's
// canonical sections. Synthetic areas (legacy flat blocks) render header-less
// and flush, i.e. exactly the pre-area layout. When `headerLink` (the default
// in the timeline), the header is a candy button that deep-links into Settings:
// a module sub-page when the Area maps to a module, else the standalone
// Releases tab. AreaReleasesView passes headerLink={false} so the in-drawer
// header — which IS the destination — stays a plain, non-pressable label.
export function AreaGroup({ area, version, accent, headerLink = true }) {
  const manifests = useManifests();
  const names = CANON.filter(n => area.sections?.[n]?.length);
  const navToArea = (e) => {
    // Inside the release card's <button>; stop the click toggling the card.
    e.stopPropagation();
    const modId = moduleIdForArea(area.name, manifests);
    sharedEvents.emit('host:open-settings', modId
      ? { tab: 'modules', page: modId, section: 'releases' }
      : { tab: 'releases', section: area.name });
  };
  const headerInner = (
    <>
      <span aria-hidden style={{
        width: 3, height: 12, borderRadius: 2, flexShrink: 0,
        background: `color-mix(in oklch, ${accent} 65%, transparent)`,
      }} />
      {area.name}
    </>
  );
  return (
    <div>
      {!area.synthetic && (headerLink ? (
        <div style={{ marginBottom: 10 }}>
          {/* role=button span (not <button>) — a nested <button> is invalid inside
              the release card's own <button>. .candy-btn is element-agnostic. */}
          <span
            role="button"
            tabIndex={0}
            title={`Open ${area.name} releases`}
            className="candy-btn"
            data-shape="row"
            data-own-press
            onClick={navToArea}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navToArea(e); }}
            style={{ '--accent': accent, width: 'auto' }}
          >
            <span className="candy-face" style={{
              justifyContent: 'flex-start', gap: 7, padding: '5px 10px',
              fontSize: 11.5, fontWeight: 700, color: 'var(--text)',
              fontFamily: 'var(--font-body)', letterSpacing: '0.02em', textTransform: 'none',
            }}>
              {headerInner}
            </span>
          </span>
        </div>
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          fontSize: 11.5, fontWeight: 700, color: 'var(--text)',
          letterSpacing: '0.02em', marginBottom: 10,
        }}>
          {headerInner}
        </div>
      ))}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 14,
        paddingLeft: area.synthetic ? 0 : 10,
      }}>
        {names.map(n => (
          <Section
            key={n}
            title={n}
            items={area.sections[n]}
            color={sectionColor(n, accent)}
            bulletIdPrefix={`${version}|${area.name}|${n}`}
          />
        ))}
      </div>
    </div>
  );
}

function Section({ title, items, color, bulletIdPrefix }) {
  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color, fontWeight: 600,
        marginBottom: 8,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {items.map((item, i) => (
          <div
            key={i}
            data-bullet-id={bulletIdPrefix ? `${bulletIdPrefix}|${i}` : undefined}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}
          >
            <span style={{
              width: 4, height: 4, borderRadius: '50%',
              background: color, marginTop: 7,
              flexShrink: 0, opacity: 0.7,
            }} />
            <span style={{
              fontSize: 12, color: 'var(--text)',
              lineHeight: 1.45,
            }}>
              {renderInline(item)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Releases search pill + results view — mirrors the Settings drawer recipe ──

function ReleasesSearchPill({ inputRef, value, onChange, resultCount, onArrow, onEnter, onClear }) {
  return (
    <div style={{ position: 'relative', width: 'min(100%, 260px)', flexShrink: 0 }}>
      <span aria-hidden style={{
        position: 'absolute', left: 10, top: 0, bottom: 0,
        display: 'flex', alignItems: 'center',
        color: 'var(--text-faint)', pointerEvents: 'none',
      }}><IconSearch size={14}/></span>
      <input
        ref={inputRef}
        type="text"
        className="candy-input"
        value={value}
        placeholder="Search releases…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); onArrow('down'); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); onArrow('up'); }
          else if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
          else if (e.key === 'Escape') {
            // Handled here so it never reaches the Ship modal's window listener.
            e.preventDefault(); e.stopPropagation();
            onClear(); e.currentTarget.blur();
          }
        }}
        style={{
          width: '100%',
          padding: '7px 28px 7px 30px',
          fontSize: 12,
          color: 'var(--text)',
          fontFamily: 'var(--font-body)',
          outline: 'none',
        }}
      />
      {resultCount > 0 && (
        <span style={{
          position: 'absolute', right: 10, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center',
          fontSize: 10, fontFamily: 'var(--font-mono)',
          color: 'var(--text-faint)', pointerEvents: 'none',
        }}>{resultCount}</span>
      )}
    </div>
  );
}

function ReleasesResultsView({ results, selected, accent, onHover, onPick }) {
  useEffect(() => {
    document.querySelector(`[data-res-idx="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!results.length) {
    return (
      <div style={{
        padding: '14px 16px', fontSize: 12, color: 'var(--text-muted)',
        background: 'var(--surface-2)', border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-md)',
      }}>No releases match.</div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        marginBottom: 8,
      }}>Search results · {results.length}</div>
      {results.map((row, i) => {
        const sel = i === selected;
        return (
          <button
            key={row.id}
            type="button"
            data-res-idx={i}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(row)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, padding: '9px 12px', textAlign: 'left', cursor: 'pointer',
              border: `1px solid ${sel ? `color-mix(in oklch, ${accent} 45%, var(--border))` : 'transparent'}`,
              background: sel ? `color-mix(in oklch, ${accent} 10%, var(--surface))` : 'transparent',
              borderRadius: 'var(--radius-md)',
              transition: 'background 80ms ease, border-color 80ms ease',
            }}
          >
            {row.kind === 'release' ? (
              <>
                <span style={{
                  display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0,
                  fontSize: 12.5, fontWeight: 600, color: 'var(--text)',
                }}>
                  <span style={{ fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{row.versionLabel}</span>
                  <span style={{
                    fontWeight: 400, color: 'var(--text-muted)', fontSize: 11.5,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {row.summary || row.date}
                  </span>
                </span>
                <span style={{
                  fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
                  color: 'var(--text-faint)', flexShrink: 0,
                }}>
                  Release · {row.date}
                </span>
              </>
            ) : (
              <>
                <span style={{
                  fontSize: 12.5, fontWeight: 500, color: 'var(--text)', minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {row.name}
                </span>
                <span style={{
                  fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
                  color: 'var(--text-faint)', flexShrink: 0,
                }}>
                  {row.versionLabel} · {row.area} · {row.section}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

const pageStyle = {
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  padding: '24px 28px',
  maxWidth: 720,
  margin: '0 auto',
};
