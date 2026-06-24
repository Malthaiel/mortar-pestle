// Domain Builder wizard — a portal modal (mounted globally by AppShell with no
// props) that reads all state from useDomainBuilder(). Six steps + a preview
// that runs `scaffold_domain` dry-run, then a Build that commits it.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { PrimaryBtn, OutlinedBtn, IconBtn, TextInput, Seg, FilterChip } from '@host/components/ui/index.js';

import {
  useDomainBuilder,
  deriveFrontmatter,
  defaultTranscriptSlug,
  PRESET_PACKS,
} from './state.jsx';

const STEPS = ['Identity', 'Pipeline', 'Extraction', 'Transcript', 'Glossary', 'Preview'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const splitList = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

const preStyle = {
  margin: '6px 0 0',
  padding: '8px 10px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  fontSize: 11,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 240,
  overflowY: 'auto',
};
const detailsStyle = { borderBottom: '1px solid var(--border-soft)', padding: '4px 0' };

function Field({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{hint}</div>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>{title}</div>
      {children}
    </div>
  );
}

function addedLines(before, after) {
  const prev = new Set((before || '').split('\n'));
  const adds = (after || '').split('\n').filter((l) => !prev.has(l)).map((l) => `+ ${l}`);
  return adds.join('\n') || '(no line-level changes)';
}

// ───────────────────────── Steps ─────────────────────────
const lockedStyle = { fontSize: 13, color: 'var(--text)', padding: '6px 0' };

function StepIdentity() {
  const { draft, update, contentVaults, reopen } = useDomainBuilder();
  const name = draft.domainName;
  const tslug = (draft.transcriptSlug || '').trim() || defaultTranscriptSlug(name);
  return (
    <>
      <Field label="Domain name" hint={reopen ? 'Locked — reopen reconfigures this domain in place.' : 'Title Case with spaces — e.g. Artificial Intelligence'}>
        {reopen
          ? <div style={lockedStyle}>{name}</div>
          : <TextInput value={name} onChange={(v) => update({ domainName: v })} placeholder="Domain name" autoFocus />}
      </Field>
      {name.trim() && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          Folder <code>Knowledge/{name.trim()}/</code> · <code>Domain: {deriveFrontmatter(name)}</code> · command{' '}
          <code>/transcript {tslug}</code>
        </div>
      )}
      <Field label="Transcript slug" hint={reopen ? 'Locked on reopen — changing it would orphan the existing sub-spec.' : 'Defaults to yt-<domain>; edit for a different command name.'}>
        {reopen
          ? <div style={lockedStyle}>{tslug}</div>
          : <TextInput
              value={draft.transcriptSlug}
              onChange={(v) => update({ transcriptSlug: v })}
              placeholder={defaultTranscriptSlug(name) || 'yt-...'}
            />}
      </Field>
      {!reopen && contentVaults.length > 1 && (
        <Field label="Target vault">
          <Seg
            options={contentVaults.map((v) => ({ value: v.id, label: v.name }))}
            value={draft.vaultId}
            onChange={(v) => update({ vaultId: v })}
          />
        </Field>
      )}
    </>
  );
}

function StepPipeline() {
  const { draft, update } = useDomainBuilder();
  const f = draft.pipeline.folders;
  const setFolder = (k, val) => update({ pipeline: { folders: { ...f, [k]: val } } });
  const cf = draft.customFolders;
  const setCf = (arr) => update({ customFolders: arr });
  return (
    <>
      <Field label="Pipeline folders" hint="Transcripts + Raw are always created.">
        <div className="candy-chip-row" style={{ '--candy-gap': '6px', flexWrap: 'wrap' }}>
          <FilterChip active disabled title="Always created">Transcripts</FilterChip>
          {['concepts', 'entities', 'topics', 'assets'].map((k) => (
            <FilterChip key={k} active={f[k]} onClick={() => setFolder(k, !f[k])}>{cap(k)}</FilterChip>
          ))}
        </div>
      </Field>
      <Field label="Custom subtype folders" hint="Extra folders, each with their own Type: value.">
        {cf.map((c, i) => (
          <div key={i} className="candy-chip-row" style={{ '--candy-gap': '6px' }}>
            <TextInput value={c.name} onChange={(v) => setCf(cf.map((x, j) => (j === i ? { ...x, name: v } : x)))} placeholder="Folder name" />
            <TextInput value={c.typeFrontmatter} onChange={(v) => setCf(cf.map((x, j) => (j === i ? { ...x, typeFrontmatter: v } : x)))} placeholder="Type:" />
            <IconBtn onClick={() => setCf(cf.filter((_, j) => j !== i))} title="Remove" size={28}>✕</IconBtn>
          </div>
        ))}
        <OutlinedBtn small onClick={() => setCf([...cf, { name: '', typeFrontmatter: '' }])}>+ Add folder</OutlinedBtn>
      </Field>
    </>
  );
}

function StepExtraction() {
  const { draft, update } = useDomainBuilder();
  const ex = draft.extraction;
  const folders = draft.pipeline.folders;
  const setEx = (k, val) => update({ extraction: { ...ex, [k]: val } });
  const types = draft.entityTaxonomy.types;
  const setTypes = (arr) => update({ entityTaxonomy: { types: arr } });
  const applyPreset = (pack) => {
    const p = PRESET_PACKS[pack];
    if (!p) return;
    update({
      boldRules: { ...draft.boldRules, presetPack: pack, include: [...p.include] },
      entityTaxonomy: { types: p.types.map((name) => ({ name, promote: false })) },
    });
  };
  return (
    <>
      <Field label="Extract pages" hint="Page types each transcript spins off. Needs the matching folder enabled.">
        <div className="candy-chip-row" style={{ '--candy-gap': '6px' }}>
          {['entities', 'concepts', 'topics'].map((k) => {
            const off = !folders[k];
            return (
              <FilterChip
                key={k}
                active={ex[k] && !off}
                disabled={off}
                title={off ? `Enable the ${cap(k)} folder (Pipeline step) first` : undefined}
                onClick={() => !off && setEx(k, !ex[k])}
              >
                {cap(k)}
              </FilterChip>
            );
          })}
        </div>
      </Field>
      <Field label="Starter taxonomy" hint="Pick a pack, then tweak below.">
        <Seg
          options={[
            { value: 'generic', label: 'Generic' },
            { value: 'ai', label: 'AI' },
            { value: 'game', label: 'Game' },
            { value: 'media', label: 'Media' },
          ]}
          value={draft.boldRules.presetPack}
          onChange={applyPreset}
        />
      </Field>
      <Field label="Entity types" hint="Promote a type to give it its own folder.">
        {types.map((t, i) => (
          <div key={i} className="candy-chip-row" style={{ '--candy-gap': '6px', alignItems: 'center' }}>
            <TextInput value={t.name} onChange={(v) => setTypes(types.map((x, j) => (j === i ? { ...x, name: v } : x)))} placeholder="Type name" />
            <FilterChip active={t.promote} onClick={() => setTypes(types.map((x, j) => (j === i ? { ...x, promote: !x.promote } : x)))} title="Own folder">Folder</FilterChip>
            <IconBtn onClick={() => setTypes(types.filter((_, j) => j !== i))} title="Remove" size={28}>✕</IconBtn>
          </div>
        ))}
        <OutlinedBtn small onClick={() => setTypes([...types, { name: '', promote: false }])}>+ Add type</OutlinedBtn>
      </Field>
    </>
  );
}

function StepTranscript() {
  const { draft, update } = useDomainBuilder();
  const br = draft.boldRules;
  return (
    <>
      <Field label="Transcript mode" hint="Timestamped = clickable seek links. Summary = prose, no timestamps.">
        <Seg
          options={[
            { value: 'timestamped', label: 'Timestamped' },
            { value: 'summary', label: 'Summary' },
            { value: 'none', label: 'None' },
          ]}
          value={draft.transcriptMode}
          onChange={(v) => update({ transcriptMode: v })}
        />
      </Field>
      <Field label="Bold + wikilink on first mention" hint="Comma-separated categories.">
        <TextInput value={br.include.join(', ')} onChange={(v) => update({ boldRules: { ...br, include: splitList(v) } })} placeholder="entity, concept, ..." />
      </Field>
      <Field label="Never bold" hint="Comma-separated.">
        <TextInput value={br.exclude.join(', ')} onChange={(v) => update({ boldRules: { ...br, exclude: splitList(v) } })} placeholder="pronouns, common verbs, ..." />
      </Field>
    </>
  );
}

function StepGlossary() {
  const { draft, update } = useDomainBuilder();
  const g = draft.glossary;
  const setG = (patch) => update({ glossary: { ...g, ...patch } });
  const seeds = g.seedTerms;
  const setSeeds = (arr) => setG({ seedTerms: arr });
  return (
    <>
      <Field label="Auto-correction glossary" hint="Fixes transcription typos via a canonical-name table.">
        <div className="candy-chip-row" style={{ '--candy-gap': '6px' }}>
          <FilterChip active={g.enabled} onClick={() => setG({ enabled: !g.enabled })}>Glossary {g.enabled ? 'on' : 'off'}</FilterChip>
          {g.enabled && (
            <FilterChip active={g.wireAutoCorrection} onClick={() => setG({ wireAutoCorrection: !g.wireAutoCorrection })}>Wire into sub-spec</FilterChip>
          )}
        </div>
      </Field>
      {g.enabled && (
        <Field label="Seed terms" hint="Canonical · vault filename · misspellings (comma-separated).">
          {seeds.map((s, i) => (
            <div key={i} className="candy-chip-row" style={{ '--candy-gap': '6px' }}>
              <TextInput value={s.canonical} onChange={(v) => setSeeds(seeds.map((x, j) => (j === i ? { ...x, canonical: v } : x)))} placeholder="Canonical" />
              <TextInput value={s.filename} onChange={(v) => setSeeds(seeds.map((x, j) => (j === i ? { ...x, filename: v } : x)))} placeholder="Filename" />
              <TextInput value={(s.misspellings || []).join(', ')} onChange={(v) => setSeeds(seeds.map((x, j) => (j === i ? { ...x, misspellings: splitList(v) } : x)))} placeholder="Misspellings" />
              <IconBtn onClick={() => setSeeds(seeds.filter((_, j) => j !== i))} title="Remove" size={28}>✕</IconBtn>
            </div>
          ))}
          <OutlinedBtn small onClick={() => setSeeds([...seeds, { canonical: '', filename: '', misspellings: [] }])}>+ Add term</OutlinedBtn>
        </Field>
      )}
    </>
  );
}

function StepPreview() {
  const { plan, busy, error, runPreview } = useDomainBuilder();
  useEffect(() => {
    runPreview();
  }, [runPreview]);
  if (busy && !plan) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Generating preview…</div>;
  if (error) return <div style={{ color: '#e07b7b', fontSize: 13 }}>Error: {error}</div>;
  if (!plan) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No preview yet.</div>;
  return (
    <>
      {plan.warnings?.length > 0 && (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {plan.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
      <Section title={`Folders (${plan.createdDirs.length})`}>
        <pre style={preStyle}>{plan.createdDirs.join('\n')}</pre>
      </Section>
      <Section title={`New files (${plan.newFiles.length})`}>
        {plan.newFiles.map((f, i) => (
          <details key={i} style={detailsStyle}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text)' }}>
              {f.root !== 'content' ? `[${f.root}] ` : ''}
              {f.path}
            </summary>
            <pre style={preStyle}>{f.content}</pre>
          </details>
        ))}
      </Section>
      <Section title={`Convention-doc edits (${plan.edits.length})`}>
        {plan.edits.map((e, i) => (
          <details key={i} style={detailsStyle}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text)' }}>
              {e.path} — {e.anchorDesc}
            </summary>
            <pre style={preStyle}>{addedLines(e.before, e.after)}</pre>
          </details>
        ))}
      </Section>
    </>
  );
}

function ResultScreen() {
  const { result, plan } = useDomainBuilder();
  return (
    <div className="candy-stack" style={{ '--candy-gap': '8px' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>✓ {result?.name} created</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {plan?.createdDirs?.length} folders · {plan?.newFiles?.length} files · {plan?.edits?.length} doc edits. The{' '}
        <code>/transcript {result?.slug}</code> command is live.
      </div>
      {result && result.builtIntoActive === false && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Built into <b>{result.vaultName || 'another vault'}</b> — switch to that vault to open it.
        </div>
      )}
      {plan?.warnings?.length > 0 && (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{plan.warnings.length} warning(s) — skipped:</div>
          {plan.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const STEP_COMPONENTS = [StepIdentity, StepPipeline, StepExtraction, StepTranscript, StepGlossary, StepPreview];

// ───────────────────────── Shell ─────────────────────────
export function DomainBuilderOverlay() {
  const ctx = useDomainBuilder();
  const modalRef = useRef(null);
  const open = !!ctx?.open;
  const close = ctx?.close;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.stopImmediatePropagation();
        close?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => modalRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(t);
    };
  }, [open, close]);

  if (!ctx || !open) return null;

  const { step, setStep, draft, busy, build, reopen } = ctx;
  const onResult = step === 99;
  const isPreview = step === STEPS.length - 1;
  const Body = onResult ? ResultScreen : STEP_COMPONENTS[step];
  const canNext = step !== 0 || draft.domainName.trim().length > 0;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.32)' }} />
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        style={{
          position: 'relative',
          width: 'min(640px, 95vw)',
          maxHeight: 'min(82vh, 760px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          outline: 'none',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
            {reopen ? 'Reconfigure' : 'New Domain'}{!onResult && draft.domainName.trim() ? ` — ${draft.domainName.trim()}` : ''}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {!onResult && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{STEPS[step]} · {step + 1}/{STEPS.length}</div>}
            <IconBtn onClick={close} title="Close" size={28}>✕</IconBtn>
          </div>
        </div>

        <div className="candy-stack" style={{ flex: 1, minHeight: 0, padding: '16px 18px', overflowY: 'auto', '--candy-gap': '12px' }}>
          <Body />
        </div>

        <div className="candy-chip-row" style={{ padding: '12px 18px', borderTop: '1px solid var(--border-soft)', justifyContent: 'flex-end', '--candy-gap': '8px', flexShrink: 0 }}>
          {onResult ? (
            <PrimaryBtn onClick={close}>Done</PrimaryBtn>
          ) : (
            <>
              <OutlinedBtn onClick={close}>Cancel</OutlinedBtn>
              {step > 0 && <OutlinedBtn onClick={() => setStep(step - 1)} disabled={busy}>Back</OutlinedBtn>}
              {isPreview ? (
                <PrimaryBtn onClick={build} disabled={busy}>{busy ? 'Building…' : 'Build domain'}</PrimaryBtn>
              ) : (
                <PrimaryBtn onClick={() => setStep(step + 1)} disabled={!canNext}>Next</PrimaryBtn>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
