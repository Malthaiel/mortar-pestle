import { useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribeEvents, mediaUrl, hydrateVaultImages } from '../api.js';
import { navigate } from '../router.js';
import { timeAgo } from '../util/obsidian.js';
import { markEditorDirty, clearEditorDirty, BEFORE_VAULT_SWITCH } from '../hooks/editorDirty.js';
import VaultTaskSection from '../components/VaultTaskSection.jsx';
import { usePlanner } from '../hooks/usePlanner.js';
import { STATUS_DOT_COLOR, resolveDot } from '../util/media-status.js';
import { StatChip, FrontmatterChip, FilterChip } from '../components/ui/index.js';
import PageMinimap from '../components/PageMinimap.jsx';
import PageLinksPanel from '../components/PageLinksPanel.jsx';
import { useContextMenu } from '../context-menu/useContextMenu.js';
import { buildWikilinkMenu, buildExternalLinkMenu, openExternalUrl } from '../context-menu/defaultMenus.js';
import { openConcierge } from '../agents/concierge/ConciergeProvider.jsx';
import { todayLocalStr } from '../util/time.js';

function dailyLogDsFromPath(path) {
  if (typeof path !== 'string' || !path.startsWith('Pulse/Daily Logs/')) return null;
  const base = path.replace(/\.md$/, '').split('/').pop() || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(base) ? base : null;
}

// Live Preview embed resolvers (passed to livePreview()). Kept at module scope
// so the image cache survives editor re-mounts. Images resolve to an
// mortar-pestle-asset:// URL; note transclusions fetch the target's rendered HTML.
const _embedImgCache = new Map();
async function resolveEmbedImage(target, direct) {
  const key = (direct ? 'd|' : 'w|') + target;
  if (_embedImgCache.has(key)) return _embedImgCache.get(key);
  let src = '';
  try {
    if (direct) {
      src = mediaUrl(target);
    } else {
      const r = await api.resolveLink(target, true);
      if (r && r.path) src = mediaUrl(r.path);
    }
  } catch { /* unresolved → blank */ }
  _embedImgCache.set(key, src);
  return src;
}
async function resolveEmbedNote(target) {
  try {
    const r = await api.resolveLink(target, false);
    if (r && r.resolved && r.path) {
      const page = await api.getPage(r.path);
      return page?.html ?? null;
    }
  } catch { /* unresolved → placeholder */ }
  return null;
}

function parseFrontmatter(raw) {
  if (!raw || typeof raw !== 'string') return {};
  if (!raw.startsWith('---\n')) return {};
  const end = raw.indexOf('\n---\n', 4);
  const endAlt = raw.indexOf('\n---', 4);
  const fmEnd = end >= 0 ? end : (endAlt >= 0 ? endAlt : -1);
  if (fmEnd < 0) return {};
  const block = raw.slice(4, fmEnd);
  const out = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_\- ]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (!v) continue;
    if (v.startsWith('[[') && v.endsWith(']]')) continue; // wikilinks — skip for chips
    if (v.startsWith('[')) continue; // array values — skip
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1].trim()] = v;
  }
  return out;
}

const EXCLUDED_FRONTMATTER = new Set(['title', 'aliases', 'cssclass', 'cover', 'icon', 'banner', 'source']);

function PageHeaderTile({ mtime, frontmatter, accent }) {
  const accentColor = accent || 'var(--text)';
  const fm = frontmatter || {};

  const mtimeMs = mtime
    ? (typeof mtime === 'number' ? mtime * 1000 : Date.parse(mtime))
    : null;
  const mtimeAbs = mtimeMs ? new Date(mtimeMs).toISOString().slice(0, 10) : null;
  const mtimeAgoStr = mtimeMs ? timeAgo(mtimeMs) : null;

  const status = fm.Status || fm.status;
  const statusDot = resolveDot(STATUS_DOT_COLOR, status, accentColor);

  const chipFields = Object.entries(fm)
    .filter(([k, v]) => !EXCLUDED_FRONTMATTER.has(k.toLowerCase()) && k !== 'Status' && k !== 'status' && v.length < 80)
    .slice(0, 8);

  if (!mtimeAbs && !status && chipFields.length === 0) return null;

  return (
    <div style={{
      maxWidth: 920, width: '100%', margin: '0 auto',
      padding: '20px 48px 0',
    }}>
      <div style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '14px 16px',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          flexWrap: 'wrap',
        }}>
          {mtimeAbs && (
            <StatChip label="Updated" value={mtimeAbs} sub={mtimeAgoStr} accent={accentColor}/>
          )}
          {status && (
            <StatChip
              label="Status"
              value={status}
              accent={accentColor}
              dot={statusDot}
            />
          )}
          <div style={{ flex: 1 }}/>
        </div>
        {chipFields.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 6,
            paddingTop: 6,
            borderTop: '1px solid var(--border-soft, var(--border))',
          }}>
            {chipFields.map(([k, v]) => (
              <FrontmatterChip key={k} field={k} value={v} accent={accentColor}/>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


export default function PageView({ path, accent }) {
  const [mode, setMode] = useState('live');
  const [showLinks, setShowLinks] = useState(false);
  const { openContextMenu } = useContextMenu();
  const [html, setHtml] = useState('');
  const scrollContainerRef = useRef(null);
  const [raw, setRaw] = useState('');
  const [mtime, setMtime] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);
  const [saveState, setSaveState] = useState('idle'); // 'idle' | 'saving' | 'saved'
  const [conflict, setConflict] = useState(false);
  const [rawUnavailable, setRawUnavailable] = useState(false);

  const editorHostRef = useRef(null);
  const readingRef = useRef(null);
  const editorViewRef = useRef(null);
  const draftRef = useRef('');
  const lastSavedRef = useRef('');
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef(null);
  const mtimeRef = useRef(null);
  const conflictMtimeRef = useRef(null);
  const scheduleSaveRef = useRef(() => {});
  const flushSaveRef = useRef(() => {});
  const modeRef = useRef(mode);

  const planner = usePlanner();

  const filePath = path && path.endsWith('.md') ? path : path + '.md';

  const dailyDs = useMemo(() => dailyLogDsFromPath(path), [path]);
  const isDailyLog = !!dailyDs;
  const [todayDs, setTodayDs] = useState(todayLocalStr);
  const isToday = isDailyLog && dailyDs === todayDs;
  const frontmatter = useMemo(() => parseFrontmatter(raw), [raw]);

  useEffect(() => {
    if (!isDailyLog) return;
    const id = setInterval(() => setTodayDs(todayLocalStr()), 60_000);
    return () => clearInterval(id);
  }, [isDailyLog]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    setConflict(false);
    setRawUnavailable(false);
    setSaveState('idle');
    dirtyRef.current = false;
    setMode('live');
    Promise.all([
      api.getPage(path),
      api.getRawFile(filePath).catch(() => ''),
    ])
      .then(([renderResult, rawText]) => {
        if (cancelled) return;
        const html = renderResult.html || '';
        setHtml(html);
        setMtime(renderResult.mtime || null);
        mtimeRef.current = renderResult.mtime || null;
        setRaw(rawText || '');
        draftRef.current = rawText || '';
        lastSavedRef.current = rawText || '';
        const unavailable = !rawText && !!html;
        setRawUnavailable(unavailable);
        if (unavailable) setMode('reading');
      })
      .catch(err => {
        if (cancelled) return;
        if (err.status === 404) setNotFound(true);
        else setError(err.message || 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    if (!isDailyLog) return;
    const unsub = subscribeEvents((name, payload) => {
      const matches =
        (name === 'today' && isToday) ||
        (name === 'day' && payload === dailyDs);
      if (!matches) return;
      // While editing, route an app-side write (session / vault-activity append)
      // through the conflict reconciler so it never silently clobbers the editor
      // buffer. In reading mode, just refresh the rendered HTML.
      if (modeRef.current === 'live') { reconcileDisk(); return; }
      api.getPage(path).then(renderResult => {
        if (!renderResult) return;
        setHtml(renderResult.html || '');
        setMtime(renderResult.mtime || null);
      }).catch(() => {});
    });
    return () => unsub();
  }, [isDailyLog, isToday, dailyDs, path]);

  useEffect(() => {
    if (mode !== 'live' || loading || notFound || error || rawUnavailable || !editorHostRef.current) return;
    const targetPath = filePath;
    let view = null;
    let cancelled = false;
    (async () => {
      const [{ EditorView, keymap }, { EditorState }, { markdown, markdownLanguage }, theme, live, slash] = await Promise.all([
        import('@codemirror/view'),
        import('@codemirror/state'),
        import('@codemirror/lang-markdown'),
        import('../editor/theme.js'),
        import('../editor/livePreview.js'),
        import('../editor/slashCommands.js'),
      ]);
      if (cancelled || !editorHostRef.current) return;
      const state = EditorState.create({
        doc: draftRef.current || '',
        extensions: [
          theme.baseEditorExtensions(),
          markdown({ base: markdownLanguage }),
          theme.editorTheme(accent),
          live.livePreview({
            onWikilink: handleWikilinkNav,
            onLinkMenu: handleLinkMenu,
            resolveImage: resolveEmbedImage,
            resolveTransclusion: resolveEmbedNote,
            hydrate: hydrateVaultImages,
          }),
          slash.slashCommands(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              draftRef.current = update.state.doc.toString();
              scheduleSaveRef.current();
            }
          }),
          EditorView.domEventHandlers({ blur: () => { flushSaveRef.current(); return false; } }),
          keymap.of([{
            key: 'Mod-s',
            preventDefault: true,
            run: () => { flushSaveRef.current({ force: true }); return true; },
          }]),
        ],
      });
      view = new EditorView({ state, parent: editorHostRef.current });
      editorViewRef.current = view;
    })();
    return () => {
      cancelled = true;
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      // Flush the outgoing file using its captured path + base mtime.
      if (dirtyRef.current && draftRef.current !== lastSavedRef.current) {
        api.savePage(targetPath, draftRef.current, mtimeRef.current).catch(() => {});
        lastSavedRef.current = draftRef.current;
        dirtyRef.current = false;
      }
      clearEditorDirty(targetPath);
      view?.destroy();
      editorViewRef.current = null;
    };
  }, [mode, path, loading, rawUnavailable, notFound, error]);

  useEffect(() => { mtimeRef.current = mtime; }, [mtime]);

  // Reading mode: rewrite dead `/api/file/` embed image srcs after HTML inject.
  useEffect(() => {
    if (mode === 'reading') hydrateVaultImages(readingRef.current);
  }, [html, mode, loading, notFound]);

  // Smart conflict — focus re-stat fallback (fires when the OS window regains
  // focus, e.g. after editing in Obsidian without the app focused).
  useEffect(() => {
    if (loading || notFound) return;
    const onFocus = () => reconcileDisk();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [path, loading, notFound]);

  // Smart conflict — instant reaction via the generic `file` watcher event
  // (reconciles even while the app is focused, the moment the file changes).
  useEffect(() => {
    if (loading || notFound) return;
    const unsub = subscribeEvents((name, payload) => {
      if (name === 'file' && payload === filePath) reconcileDisk();
    });
    return () => unsub();
  }, [filePath, loading, notFound]);

  // Vault switch is a hard reload — discard this buffer before the remount so
  // the unmount-flush above can't write it into the newly-activated vault.
  useEffect(() => {
    const onSwitch = () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      lastSavedRef.current = draftRef.current;
      dirtyRef.current = false;
      clearEditorDirty(filePath);
    };
    window.addEventListener(BEFORE_VAULT_SWITCH, onSwitch);
    return () => window.removeEventListener(BEFORE_VAULT_SWITCH, onSwitch);
  }, [filePath]);

  async function flushSave(opts = {}) {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    if (!dirtyRef.current && !opts.force) return;
    const content = draftRef.current;
    if (content === lastSavedRef.current && !opts.force) { dirtyRef.current = false; return; }
    const targetPath = opts.path || filePath;
    const baseMtime = opts.mtime !== undefined ? opts.mtime : mtimeRef.current;
    setSaveState('saving');
    try {
      const result = await api.savePage(targetPath, content, baseMtime);
      lastSavedRef.current = content;
      dirtyRef.current = false;
      clearEditorDirty(filePath);
      if (targetPath === filePath) {
        mtimeRef.current = result.mtime;
        setMtime(result.mtime);
        setRaw(content);
        setConflict(false);
      }
      setSaveState('saved');
    } catch (err) {
      if (err.code === 'CONFLICT' || err.status === 409) {
        conflictMtimeRef.current = err.currentMtime ?? null;
        setConflict(true);
      } else {
        setError(err.message || 'Save failed');
      }
      setSaveState('idle');
    }
  }

  function scheduleSave() {
    dirtyRef.current = true;
    markEditorDirty(filePath);
    if (saveState !== 'idle') setSaveState('idle');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { flushSave(); }, 1500);
  }

  flushSaveRef.current = flushSave;
  scheduleSaveRef.current = scheduleSave;
  modeRef.current = mode;

  async function handleWikilinkNav(target) {
    try {
      const r = await api.resolveLink(target, false);
      if (!r || !r.resolved || !r.path) return;
      const anchor = r.anchor ? '#' + encodeURIComponent(r.anchor).replace(/%20/g, '+') : '';
      navigate(r.scope === 'internal'
        ? '/infrastructure/reference?path=' + encodeURIComponent(r.path) + anchor
        : '/page/' + encodeURIComponent(r.path) + anchor);
    } catch { /* unresolved — no-op */ }
  }

  // Right-click a live-preview wikilink/link widget → app-wide context menu with
  // the same actions the read-mode classifier produces (shared defaultMenus
  // builders). Live mode hands a raw target; the builder resolves it lazily.
  function handleLinkMenu(e, desc) {
    if (!desc) return;
    const items = desc.kind === 'external'
      ? buildExternalLinkMenu({ url: desc.url, text: desc.text })
      : buildWikilinkMenu({ target: desc.target, display: (desc.display || '').replace(/^↳\s*/, '') });
    openContextMenu(e, items);
  }

  async function reloadFromDisk() {
    try {
      const [fresh, freshRaw] = await Promise.all([
        api.getPage(path),
        api.getRawFile(filePath),
      ]);
      setHtml(fresh.html || '');
      setRaw(freshRaw);
      draftRef.current = freshRaw;
      lastSavedRef.current = freshRaw;
      dirtyRef.current = false;
      clearEditorDirty(filePath);
      setMtime(fresh.mtime || null);
      mtimeRef.current = fresh.mtime || null;
      setConflict(false);
      setSaveState('idle');
      const view = editorViewRef.current;
      if (view) {
        const sel = view.state.selection;
        const keepSel = sel.main.head <= freshRaw.length && sel.main.anchor <= freshRaw.length;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: freshRaw },
          selection: keepSel ? sel : undefined,
        });
      }
    } catch (err) {
      setError(err.message || 'Reload failed');
    }
  }

  async function keepMine() {
    const theirs = conflictMtimeRef.current;
    setConflict(false);
    await flushSave({ force: true, mtime: theirs });
  }

  // Re-stat the open file and reconcile with the buffer. Clean buffer + on-disk
  // change → silent reload; dirty buffer + change → conflict banner. Shared by
  // the focus re-stat and the instant `file` watcher event.
  async function reconcileDisk() {
    if (saveTimerRef.current) return; // mid-edit flush pending — skip
    try {
      const fresh = await api.getPage(path);
      const disk = fresh.mtime || 0;
      if (Math.abs(disk - (mtimeRef.current || 0)) <= 1) return; // our own write / no change
      if (!dirtyRef.current && draftRef.current === lastSavedRef.current) {
        reloadFromDisk();
      } else {
        conflictMtimeRef.current = disk;
        setConflict(true);
      }
    } catch { /* ignore */ }
  }

  function handleViewClick(e) {
    // External links in read mode: open via the app convention instead of letting
    // the click navigate the SPA webview away. Wikilinks use #/ hash hrefs, so the
    // http(s) test skips them — they navigate natively.
    const a = e.target.closest?.('a[href]');
    if (a) {
      const href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) { e.preventDefault(); openExternalUrl(href); return; }
    }
    const cb = e.target.closest?.('input.task-checkbox');
    if (!cb) return;
    const line = parseInt(cb.dataset.line, 10);
    if (Number.isNaN(line)) return;
    const wasChecked = !cb.checked;
    api.toggleTaskAtLine(filePath, line)
      .then(r => {
        if (r && typeof r.mtime === 'number') setMtime(r.mtime);
      })
      .catch(err => {
        cb.checked = wasChecked;
        console.warn('toggle-task failed:', err);
      });
  }

  const detail = (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {!loading && !notFound && !error && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 20px 0', flexShrink: 0 }}>
          {!rawUnavailable && raw && (
            <FilterChip
              onClick={() => openConcierge({ recipe: 'organize-md', target: filePath })}
              accent={accent}
            >✦ Organize with Concierge</FilterChip>
          )}
          <FilterChip
            onClick={() => setShowLinks(v => !v)}
            active={showLinks}
            accent={accent}
          >⇄ Links</FilterChip>
        </div>
      )}
      {!loading && !notFound && mode === 'live' && saveState === 'saving' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: 8, padding: '8px 20px 4px', flexShrink: 0,
        }}>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)',
          }}>Saving…</span>
        </div>
      )}

      {conflict && (
        <div style={{
          margin: '0 20px 12px',
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'color-mix(in oklch, #d9a55a 10%, transparent)',
          border: '1px solid color-mix(in oklch, #d9a55a 30%, transparent)',
          color: 'var(--text)', fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#d9a55a', flexShrink: 0,
          }}/>
          <span style={{ flex: 1 }}>File changed on disk while you were editing.</span>
          <FilterChip onClick={keepMine} accent={accent}>Keep mine</FilterChip>
          <FilterChip onClick={reloadFromDisk} accent={accent}>Load theirs</FilterChip>
        </div>
      )}

      {rawUnavailable && (
        <div style={{
          margin: '0 20px 12px',
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          color: 'var(--text-muted)', fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: 'var(--text-faint)', flexShrink: 0,
          }}/>
          Raw markdown unavailable — this page is view-only.
        </div>
      )}

      {isToday && !loading && !notFound && (planner.vaultTasks.length > 0 || planner.routineItems.length > 0) && (
        <div style={{ maxWidth: 920, width: '100%', margin: '0 auto', padding: '0 48px 12px' }}>
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            <VaultTaskSection
              tasks={planner.vaultTasks}
              activeRaw={planner.activeVaultRaw}
              onSelect={planner.selectVaultTask}
              onToggle={planner.toggleVaultTask}
              accent={accent}
              onDragStart={planner.startTaskDrag}
              routineItems={planner.routineItems}
              onToggleRoutine={planner.toggleRoutineTask}
            />
          </div>
        </div>
      )}

      <div ref={scrollContainerRef} style={{ flex: 1, overflow: 'auto', minHeight: 0, position: 'relative' }}>
        {loading && (
          <div style={{ padding: 48, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        )}
        {!loading && notFound && (
          <div style={{ padding: 48, fontSize: 14 }}>
            <div style={{ color: 'var(--text)', marginBottom: 12 }}>
              Can&apos;t open <code style={{ background: 'var(--surface-3)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>{path}</code> — file not found.
            </div>
            <button onClick={() => { if (window.history.length > 1) window.history.back(); else navigate('/vault'); }}
              style={{ background: 'transparent', border: 'none', color: accent || 'var(--text)', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontSize: 13 }}>← Go back</button>
          </div>
        )}
        {!loading && !notFound && error && (
          <div style={{ padding: 48, color: 'var(--text)', fontSize: 13 }}>{error}</div>
        )}
        {!loading && !notFound && !error && mode === 'reading' && (
          <>
            <PageHeaderTile mtime={mtime} frontmatter={frontmatter} accent={accent}/>
            <div className="reference-render"
              ref={readingRef}
              onClick={handleViewClick}
              dangerouslySetInnerHTML={{ __html: html }}
              style={{ maxWidth: 920, width: '100%', margin: '0 auto', padding: '16px 48px 48px' }}/>
            <PageMinimap containerRef={scrollContainerRef} contentKey={html} accent={accent}/>
          </>
        )}
        {!loading && !notFound && !error && mode === 'live' && (
          <div ref={editorHostRef} style={{ height: '100%' }}/>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      {detail}
      {showLinks && !loading && !notFound && !error && (
        <PageLinksPanel filePath={filePath} accent={accent} onClose={() => setShowLinks(false)}/>
      )}
    </div>
  );
}
