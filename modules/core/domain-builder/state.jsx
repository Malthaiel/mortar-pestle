// Domain Builder — provider, context hook, config model, and the dry-run /
// commit actions that call the `scaffold_domain` Tauri command. The overlay
// (Overlay.jsx) consumes everything here via useDomainBuilder(); no props are
// threaded (AppShell renders the overlay with none).

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { api } from '@host/api.js';
import { useVaults } from '@host/hooks/useVaults.jsx';
import { sharedEvents } from '@host/module-sdk/index.js';
import { navigate } from '@host/router.js';

export const OPEN_EVENT = 'domain-builder:open';

const EXCLUDE_DEFAULT = ['pronouns', 'common verbs', 'generic adjectives'];

// Editable starter packs: the bold-rule include list + a suggested entity
// taxonomy per domain flavour. Picking one in the wizard seeds both.
export const PRESET_PACKS = {
  generic: {
    include: ['entity', 'concept', 'significant proper noun'],
    types: ['Person', 'Organization', 'Software', 'Tool'],
  },
  ai: {
    include: ['model', 'lab', 'researcher', 'dataset', 'technique', 'benchmark', 'significant proper noun'],
    types: ['Model', 'Lab', 'Researcher', 'Dataset', 'Technique'],
  },
  game: {
    include: ['hero', 'ability', 'item', 'mechanic', 'map element', 'strategy', 'significant proper noun'],
    types: ['Hero', 'Item', 'Structure', 'Mechanic'],
  },
  media: {
    include: ['person', 'studio', 'work', 'character', 'significant proper noun'],
    types: ['Person', 'Studio', 'Work', 'Character'],
  },
};

export function emptyDraft() {
  return {
    domainName: '',
    transcriptSlug: '',
    vaultId: '',
    pipeline: { folders: { concepts: true, entities: true, topics: true, assets: true } },
    customFolders: [],
    extraction: { entities: true, concepts: true, topics: true },
    entityTaxonomy: { types: PRESET_PACKS.generic.types.map((name) => ({ name, promote: false })) },
    boldRules: {
      presetPack: 'generic',
      include: [...PRESET_PACKS.generic.include],
      exclude: [...EXCLUDE_DEFAULT],
      everywhereNotFirstMention: true,
    },
    transcriptMode: 'timestamped',
    glossary: { enabled: false, seedTerms: [], wireAutoCorrection: true },
  };
}

// Title-Case-hyphenated `Domain:` value: "Artificial Intelligence" → "Artificial-Intelligence".
export function deriveFrontmatter(name) {
  return name.trim().split(/\s+/).filter(Boolean).join('-');
}
export function deriveSlug(name) {
  return name.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-');
}
export function defaultTranscriptSlug(name) {
  const s = deriveSlug(name);
  return s ? `yt-${s}` : '';
}

function buildConfig(draft) {
  const name = draft.domainName.trim();
  const folders = draft.pipeline.folders;
  // Extraction requires its matching folder — you can't extract pages into a
  // folder you didn't create. Clamp so neither the persisted config nor the
  // generated sub-spec ever references an opted-out folder.
  const extraction = {
    entities: !!draft.extraction.entities && !!folders.entities,
    concepts: !!draft.extraction.concepts && !!folders.concepts,
    topics: !!draft.extraction.topics && !!folders.topics,
  };
  return {
    schemaVersion: 1,
    domainType: 'research',
    ...draft,
    extraction,
    domainName: name,
    domainFrontmatter: deriveFrontmatter(name),
    domainSlug: deriveSlug(name),
    transcriptSlug: (draft.transcriptSlug || '').trim() || defaultTranscriptSlug(name),
  };
}

const Ctx = createContext(null);
export function useDomainBuilder() {
  return useContext(Ctx);
}

export function DomainBuilderProvider({ children }) {
  const { vaults, activeVault, regenerateManifest } = useVaults();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(emptyDraft);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [reopen, setReopen] = useState(false);

  const contentVaults = (vaults || []).filter((v) => v.role === 'content');

  useEffect(() => {
    const unsub = sharedEvents.on(OPEN_EVENT, (payload = {}) => {
      const ro = payload.reopen && payload.reopen.name ? payload.reopen : null;
      const def =
        payload.vaultId ||
        (ro && ro.vaultId) ||
        (activeVault && activeVault.role === 'content' ? activeVault.id : null) ||
        (contentVaults[0] && contentVaults[0].id) ||
        '';
      setPlan(null);
      setError(null);
      setResult(null);
      setStep(0);
      setOpen(true);
      setReopen(!!ro);
      if (ro) {
        // Reopen: load the saved config from Infrastructure/Domains/<name>.md,
        // then hydrate the wizard with it (name/slug get locked in the UI).
        const vid = ro.vaultId || def;
        setDraft({ ...emptyDraft(), vaultId: vid, domainName: ro.name });
        setBusy(true);
        api.domains
          .readConfig(vid, ro.name)
          .then((cfg) => {
            if (cfg) setDraft({ ...emptyDraft(), ...cfg, vaultId: vid });
            else setError(`No saved Domain Builder config for “${ro.name}” — it may have been created outside the builder.`);
          })
          .catch((e) => setError(e?.message || String(e)))
          .finally(() => setBusy(false));
      } else {
        setDraft({ ...emptyDraft(), ...(payload.initialConfig || {}), vaultId: def });
      }
    });
    return unsub;
  }, [vaults, activeVault]);

  const update = useCallback((patch) => setDraft((d) => ({ ...d, ...patch })), []);
  const close = useCallback(() => setOpen(false), []);

  const runPreview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api.domains.scaffold(buildConfig(draft), true, reopen));
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, reopen]);

  const build = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const cfg = buildConfig(draft);
      const p = await api.domains.scaffold(cfg, false, reopen);
      setPlan(p);
      const target = (vaults || []).find((v) => v.id === cfg.vaultId);
      const builtIntoActive = !!activeVault && cfg.vaultId === activeVault.id;
      setResult({ name: cfg.domainName, slug: cfg.transcriptSlug, vaultName: target?.name, builtIntoActive });
      try {
        if (cfg.vaultId) await regenerateManifest(cfg.vaultId);
      } catch {
        /* manifest regen is best-effort */
      }
      try {
        // The knowledge route renders the ACTIVE vault, so only jump there when
        // we built into it — otherwise we'd show the wrong vault's tree.
        if (builtIntoActive) {
          navigate(`/vault/knowledge/${encodeURIComponent(cfg.domainName)}`);
        }
      } catch {
        /* navigation best-effort */
      }
      setStep(99);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, regenerateManifest, vaults, activeVault, reopen]);

  const value = { open, close, step, setStep, draft, update, plan, busy, error, result, reopen, runPreview, build, contentVaults };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
