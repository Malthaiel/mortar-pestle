// Settings → Agents tab (formerly Design (AI)). Three sub-tabs on the shared
// Topbar: General (auth backend, API key / Claude Code CLI, model, agent
// reach, pending edits), Atelier (persona + chat-window drag tuning), and
// Vault Agent (placeholder — planned under its own feature pass). The
// settings bag renamed design → agents; the Rust design_* IPC names, the
// components/design/ directory, and the dock design-mode button id stay.

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Seg, OutlinedBtn, TextInput, Slider, Topbar } from '../ui/index.js';
import EnableToggle from '../ui/EnableToggle.jsx';
import { AGENTS_DEFAULT, SETTINGS_DEFAULTS } from '../../hooks/useSettings.js';
import { TAB_SECTIONS, scopeFor, scopeModified } from './settings-registry.js';

export default function AgentsTab({ settings, setSetting, accent, section, onSectionChange }) {
  const active = section || TAB_SECTIONS.agents.default;
  return (
    <div>
      <Topbar
        tiles={TAB_SECTIONS.agents.sections.map(s => ({
          id: s.id, label: s.label,
          dot: scopeModified(scopeFor({ tab: 'agents', section: s.id }), settings, SETTINGS_DEFAULTS),
        }))}
        activeId={active}
        accent={accent}
        onSelect={onSectionChange}
        style={{ padding: '0 0 12px', background: 'transparent', marginBottom: 16 }}
      />
      {active === 'general'     && <GeneralPanel settings={settings} setSetting={setSetting} accent={accent}/>}
      {active === 'atelier'     && <AtelierPanel settings={settings} setSetting={setSetting} accent={accent}/>}
      {active === 'concierge'   && <ConciergePanel/>}
    </div>
  );
}

// ── General — backend, key/CLI, model, reach, pending edits ─────────────────

function GeneralPanel({ settings, setSetting, accent }) {
  const agents = { ...AGENTS_DEFAULT, ...(settings?.agents || {}) };
  const backend = agents.authBackend || 'api-key';
  const model = agents.model || 'opus';
  const cliPath = agents.claudeCliPath || '';

  const [pendingCount, setPendingCount] = useState(0);
  const [pendingBusy, setPendingBusy] = useState(false);

  const [keyDraft, setKeyDraft] = useState('');
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState(null);

  const [cliStatus, setCliStatus] = useState(null);
  const [cliStatusBusy, setCliStatusBusy] = useState(false);
  const [cliPathDraft, setCliPathDraft] = useState(cliPath);

  const refreshPending = useCallback(async () => {
    try {
      const edits = await invoke('design_pending_get');
      setPendingCount(Array.isArray(edits) ? edits.length : 0);
    } catch {
      setPendingCount(0);
    }
  }, []);
  useEffect(() => { refreshPending(); }, [refreshPending]);

  const refreshKey = useCallback(async () => {
    try {
      const present = await invoke('design_get_api_key');
      setKeyPresent(!!present);
    } catch {
      setKeyPresent(false);
    }
  }, []);

  const refreshCliStatus = useCallback(async () => {
    setCliStatusBusy(true);
    try {
      const status = await invoke('design_cli_auth_status', { cliPath });
      setCliStatus(status);
    } catch (e) {
      setCliStatus({ installed: false, loggedIn: false, error: e?.message || String(e) });
    } finally {
      setCliStatusBusy(false);
    }
  }, [cliPath]);

  useEffect(() => { refreshKey(); }, [refreshKey]);
  useEffect(() => {
    if (backend === 'claude-cli') refreshCliStatus();
  }, [backend, refreshCliStatus]);

  useEffect(() => { setCliPathDraft(cliPath); }, [cliPath]);

  const handleSaveKey = async () => {
    if (!keyDraft.trim() || keyBusy) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      await invoke('design_set_api_key', { key: keyDraft.trim() });
      setKeyDraft('');
      await refreshKey();
    } catch (e) {
      setKeyError(e?.message || String(e));
    } finally {
      setKeyBusy(false);
    }
  };

  const handleSaveCliPath = () => {
    setSetting('agents', { claudeCliPath: cliPathDraft.trim() });
  };

  const handleClearPending = async () => {
    if (pendingBusy) return;
    setPendingBusy(true);
    try {
      await invoke('design_pending_set', { edits: [] });
      await refreshPending();
    } catch (e) {
      console.warn('[agents] clear pending failed:', e);
    } finally {
      setPendingBusy(false);
    }
  };

  const handleCopyLogin = () => {
    try { navigator.clipboard?.writeText('claude /login'); } catch {}
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Section title="Auth backend">
        <Row
          anchor="set-agents-authBackend"
          label="Backend"
          hint="API key streams via the Anthropic Messages API. Claude Code spawns the local `claude` binary as a subprocess — uses your Pro/Max subscription, no API key required."
        >
          <Seg
            accent={accent}
            value={backend}
            options={[
              { value: 'api-key', label: 'API key' },
              { value: 'claude-cli', label: 'Claude Code' },
            ]}
            onChange={(v) => setSetting('agents', { authBackend: v })}
          />
        </Row>
        <Row
          anchor="set-agents-model"
          label="Model"
          hint="Shared across both backends. Opus is recommended for the best Atelier responses. CLI accepts the alias; API path overrides the hardcoded model."
        >
          <Seg
            accent={accent}
            value={model}
            options={[
              { value: 'opus',   label: 'Opus' },
              { value: 'sonnet', label: 'Sonnet' },
              { value: 'haiku',  label: 'Haiku' },
            ]}
            onChange={(v) => setSetting('agents', { model: v })}
          />
        </Row>
      </Section>

      {backend === 'api-key' && (
        <Section title="API key">
          <Row
            anchor="set-agents-apiKey"
            label="Anthropic key"
            hint="Stored in the OS keychain via libsecret. Never written to disk in plaintext. ANTHROPIC_API_KEY in env is the startup fallback when the keychain is empty."
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <KeyStatus present={keyPresent} accent={accent}/>
            </div>
          </Row>
          <Row label="" hint="">
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', width: 360 }}>
              <TextInput
                type="password"
                value={keyDraft}
                onChange={setKeyDraft}
                placeholder={keyPresent ? '••••••••  (replace)' : 'sk-ant-…'}
                accent={accent}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
              <OutlinedBtn small onClick={handleSaveKey} disabled={keyBusy || !keyDraft.trim()}>
                {keyBusy ? '…' : 'Save'}
              </OutlinedBtn>
            </div>
          </Row>
          {keyError && (
            <div style={{ fontSize: 11, color: 'var(--error)', fontFamily: 'var(--font-mono)' }}>{keyError}</div>
          )}
        </Section>
      )}

      {backend === 'claude-cli' && (
        <Section title="Claude Code">
          <Row
            label="Subscription"
            hint="Auth state of the `claude` CLI on this machine. If not detected, log in once via a terminal and Atelier will use that session."
          >
            <CliStatusBanner
              status={cliStatus}
              busy={cliStatusBusy}
              onRefresh={refreshCliStatus}
              onCopyLogin={handleCopyLogin}
              accent={accent}
            />
          </Row>
          <Row
            label="CLI path (advanced)"
            hint="Override the binary location. Leave empty to use PATH (`which claude`). Only set this if your install is in a non-standard location."
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', width: 420 }}>
              <TextInput
                value={cliPathDraft}
                onChange={setCliPathDraft}
                placeholder="empty = use PATH"
                accent={accent}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
              <OutlinedBtn
                small
                onClick={handleSaveCliPath}
                disabled={cliPathDraft.trim() === cliPath}
              >
                Save
              </OutlinedBtn>
            </div>
          </Row>
        </Section>
      )}

      <Section title="Agent reach">
        <ReachSummary backend={backend} accent={accent}/>
      </Section>

      <Section title="Pending edits">
        <Row
          label={pendingCount > 0 ? `${pendingCount} uncommitted token tweak${pendingCount === 1 ? '' : 's'}` : 'No uncommitted tweaks'}
          hint="Edits made via the Atelier token bubble that haven't been committed to source. Cleared here without writing."
        >
          <OutlinedBtn small onClick={handleClearPending} disabled={pendingCount === 0 || pendingBusy}>
            {pendingBusy ? '…' : 'Clear all'}
          </OutlinedBtn>
        </Row>
      </Section>
    </div>
  );
}

// ── Atelier — persona + chat-window drag tuning ──────────────────────────────

function AtelierPanel({ settings, setSetting, accent }) {
  const agents = { ...AGENTS_DEFAULT, ...(settings?.agents || {}) };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Section title="Atelier">
        <Row
          label="Persona"
          hint="Atelier is the designer-in-residence — calm, opinionated, references DESIGN.md tokens by name. One persona ships in v1."
        >
          <PersonaChip accent={accent}/>
        </Row>
        <Row
          anchor="set-agents-magnetRadius"
          label="Edge magnetism"
          hint="The Atelier chat drags freely and snaps flush to the nearest content-area edge when released within this range. 0 = off (free drag anywhere)."
        >
          <Slider
            accent={accent}
            value={agents.magnetRadius}
            min={0} max={200} step={10} unit="px"
            onChange={(v) => setSetting('agents', { magnetRadius: v })}
          />
        </Row>
        <Row
          anchor="set-agents-snapCorners"
          label="Snap to corners"
          hint="Also dock to the corners, not just the four edges, when you drag into one."
        >
          <EnableToggle
            accent={accent}
            enabled={agents.snapCorners}
            title="Snap to corners"
            onChange={(v) => setSetting('agents', { snapCorners: v })}
          />
        </Row>
        <Row
          anchor="set-agents-dragSmoothness"
          label="Drag glide"
          hint="How much the chat trails your cursor while you drag it. None pins it exactly (1:1); heavier gives a weightier, smoother trail."
        >
          <Seg
            accent={accent}
            value={agents.dragSmoothness}
            options={[
              { value: 'none',   label: 'None' },
              { value: 'light',  label: 'Light' },
              { value: 'medium', label: 'Medium' },
              { value: 'heavy',  label: 'Heavy' },
            ]}
            onChange={(v) => setSetting('agents', { dragSmoothness: v })}
          />
        </Row>
        <Row
          anchor="set-agents-resetPosition"
          label="Chat position"
          hint="Snap the Atelier chat back to its default bottom-right corner."
        >
          <OutlinedBtn small onClick={() => setSetting('agents', { chatPosition: null })}>
            Reset position
          </OutlinedBtn>
        </Row>
      </Section>
    </div>
  );
}

// ── Concierge — the app-wide helper agent ──────────────────────────────────

function ConciergePanel() {
  return (
    <div className="candy-section" style={{ padding: '28px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Concierge</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.55 }}>
        The app-wide helper — launch it from the Agents button in the dock. Auth
        backend and model are shared with Atelier in the General tab; more Concierge
        controls arrive as its capabilities ship.
      </div>
    </div>
  );
}

// ── Shared chrome (verbatim from the former DesignTab) ──────────────────────

function Section({ title, children }) {
  return (
    <div>
      <SectionHeader title={title}/>
      <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12, padding: '14px 16px' }}>
        {children}
      </div>
    </div>
  );
}

function SectionHeader({ title }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.12em', textTransform: 'uppercase',
      color: 'var(--text-faint)', fontWeight: 700,
    }}>{title}</div>
  );
}

function Row({ label, hint, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {label && (
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
      )}
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{hint}</div>
      )}
      <div style={{ marginTop: 2 }}>{children}</div>
    </div>
  );
}

function KeyStatus({ present }) {
  const color = present ? '#6fb56f' : 'var(--text-faint)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color,
        boxShadow: present ? `0 0 0 3px color-mix(in oklch, ${color} 22%, transparent)` : 'none',
        flexShrink: 0,
      }}/>
      <span style={{
        fontSize: 11.5, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.04em',
        color: present ? 'var(--text)' : 'var(--text-muted)',
      }}>
        {present ? 'Stored in keychain' : 'No key set — using ANTHROPIC_API_KEY env if present'}
      </span>
    </div>
  );
}

function CliStatusBanner({ status, busy, onRefresh, onCopyLogin }) {
  if (busy && !status) {
    return (
      <div style={{
        fontSize: 11.5, fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)',
      }}>
        Checking…
      </div>
    );
  }
  const installed = !!status?.installed;
  const loggedIn  = !!status?.loggedIn;
  const ok = installed && loggedIn;
  const color = ok ? '#6fb56f' : '#d9a55a';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: color,
          boxShadow: `0 0 0 3px color-mix(in oklch, ${color} 22%, transparent)`,
          flexShrink: 0,
        }}/>
        <span style={{
          fontSize: 11.5, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
          color: 'var(--text)',
        }}>
          {ok && `Logged in as ${status.email || '—'} · ${status.subscriptionType || 'unknown'}`}
          {installed && !loggedIn && 'CLI installed but not logged in'}
          {!installed && 'Binary not found on PATH'}
        </span>
      </div>
      {status?.resolvedPath && (
        <div style={{
          fontSize: 10.5, fontFamily: 'var(--font-mono)',
          color: 'var(--text-faint)', paddingLeft: 16,
        }}>
          path: {status.resolvedPath}
        </div>
      )}
      {!ok && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {!installed
              ? 'Install Claude Code (https://docs.claude.com/en/docs/claude-code), or set a custom path below.'
              : 'Run this once in a terminal:'}
          </div>
          {installed && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              fontSize: 12, fontFamily: 'var(--font-mono)',
              padding: '6px 10px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-soft)',
              borderRadius: 'var(--radius-md)',
              width: 'fit-content',
            }}>
              <span style={{ color: 'var(--text)' }}>$ claude /login</span>
              <OutlinedBtn small onClick={onCopyLogin}>copy</OutlinedBtn>
            </div>
          )}
        </div>
      )}
      <div>
        <OutlinedBtn small onClick={onRefresh} disabled={busy}>
          {busy ? 'checking…' : 'Re-check'}
        </OutlinedBtn>
      </div>
    </div>
  );
}

function PersonaChip({ accent }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      padding: '6px 10px 6px 8px',
      background: 'var(--surface-2)',
      border: '1px solid var(--border-soft)',
      borderRadius: 'var(--radius-md)',
    }}>
      <span style={{
        width: 10, height: 10, borderRadius: '50%',
        background: accent || 'var(--text)',
        boxShadow: `0 0 0 3px color-mix(in oklch, ${accent || 'var(--text)'} 22%, transparent)`,
      }}/>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Atelier</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· designer-in-residence</span>
    </div>
  );
}

function ReachSummary({ backend }) {
  const cliRows = [
    { glyph: '✓', tone: '#6fb56f', label: 'Read',  detail: 'Read/Glob/Grep over the repo (Claude Code native)' },
    { glyph: '✓', tone: '#6fb56f', label: 'Edit',  detail: 'web/src/, web/styles/ (system-prompt scope rule)' },
    { glyph: '⊘', tone: 'var(--text-faint)', label: 'Block', detail: 'No Bash, no WebSearch — pure read+edit' },
  ];
  const apiRows = [
    { glyph: '✓', tone: '#6fb56f', label: 'Read',  detail: 'all of C:\\Users\\malth\\Code\\iskariel\\' },
    { glyph: '✓', tone: '#6fb56f', label: 'Write', detail: 'web/src/, web/styles/' },
    { glyph: '⚠', tone: '#d9a55a', label: 'Confirm', detail: 'src-tauri/, tauri.conf.json, modules/, package.json' },
  ];
  const rows = backend === 'claude-cli' ? cliRows : apiRows;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map(r => (
        <div key={r.label} style={{
          display: 'flex', alignItems: 'baseline', gap: 10,
          fontSize: 12, fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
        }}>
          <span style={{ color: r.tone, fontWeight: 700, width: 12 }}>{r.glyph}</span>
          <span style={{ color: 'var(--text)', fontWeight: 600, width: 60 }}>{r.label}</span>
          <span>{r.detail}</span>
        </div>
      ))}
    </div>
  );
}
