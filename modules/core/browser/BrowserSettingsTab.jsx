// Browser settings page (Settings → Modules › Browser). Four sub-tabs on the
// shared host Topbar: AD Blocker (Shield master + filter lists + per-site
// exceptions), Browsing Data (cache / cookies / history), Password Vault
// (backup, security, master password — managed here; the in-browser vault
// route keeps the generator + logins), and Browser Sidebar (stub for the
// Panel Sidebar plan). Controlled by the drawer address via
// {initialSection, onNavigateSection}; falls back to local state standalone.
// Replaces ShieldSettingsTab (its sections moved into the first two sub-tabs).

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useModuleSettings } from '@host/hooks/useSettings.js';
import { Topbar } from '@host/components/ui';
import * as creds from './credsStore.js';
import { useCredsStore } from './useCredsStore.js';
import { applyEnabled, applySiteAllowed, reloadShieldTabs } from './blocker.js';
import * as store from './tabStore.js';
import { ExportImport, SettingsPanel, ChangeMaster } from './VaultSettingsSections.jsx';

const SECTIONS = [
  { id: 'adblock', label: 'AD Blocker' },
  { id: 'data',    label: 'Browsing Data' },
  { id: 'vault',   label: 'Password Vault' },
  { id: 'sidebar', label: 'Browser Sidebar' },
];

function SectionBand({ title, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600, marginBottom: 8,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  );
}

function SettingRow({ label, hint, children, stacked }) {
  if (stacked) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>{label}</div>
          {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{hint}</div>}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </div>
  );
}

function ToggleButton({ on, accent, onToggle }) {
  const accentColor = accent || 'var(--text)';
  return (
    <button
      type="button" onClick={onToggle} aria-pressed={on}
      style={{
        width: 44, height: 24, borderRadius: 999,
        background: on ? accentColor : 'var(--border-2)',
        border: 'none', position: 'relative', cursor: 'pointer', padding: 0,
        transition: 'background 160ms ease',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 2, left: on ? 22 : 2,
        width: 20, height: 20, borderRadius: '50%', background: 'white',
        boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
        transition: 'left 160ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}/>
    </button>
  );
}

const statNum = { fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 600 };
const hintText = { fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5, padding: '4px 0' };
const removeBtn = {
  fontSize: 11, padding: '3px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--surface-2)',
  color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit',
};
const fieldInput = { padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', font: 'inherit' };

export default function BrowserSettingsTab({ accent, initialSection, onNavigateSection }) {
  const [localSection, setLocalSection] = useState('adblock');
  const section = initialSection || localSection;
  const select = (id) => { if (onNavigateSection) onNavigateSection(id); else setLocalSection(id); };

  return (
    <div>
      <Topbar
        tiles={SECTIONS.map(s => ({ id: s.id, label: s.label }))}
        activeId={section}
        accent={accent}
        onSelect={select}
        style={{ padding: '0 0 12px', background: 'transparent', marginBottom: 16 }}
      />
      {section === 'adblock' && <AdBlockPanel accent={accent}/>}
      {section === 'data'    && <BrowsingDataPanel accent={accent}/>}
      {section === 'vault'   && <VaultPanel accent={accent}/>}
      {section === 'sidebar' && <SidebarStubPanel/>}
    </div>
  );
}

// ── AD Blocker ───────────────────────────────────────────────────────────────

function AdBlockPanel({ accent }) {
  const { settings, setSetting } = useModuleSettings('browser');
  const blocker = settings.blocker || {};
  const enabled = blocker.enabled !== false;
  const allowlist = Array.isArray(blocker.allowlist) ? blocker.allowlist : [];
  const [stats, setStats] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    invoke('blocker_get_state').then(s => { if (live) setStats(s); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, allowlist.length]);

  const toggleEnabled = () => {
    const next = !enabled;
    setSetting('blocker', { ...blocker, enabled: next, allowlist });
    applyEnabled(next);
    reloadShieldTabs();
  };

  const removeSite = (h) => {
    const next = allowlist.filter(x => x !== h);
    setSetting('blocker', { ...blocker, enabled, allowlist: next });
    applySiteAllowed(h, false);
    reloadShieldTabs();
  };

  const refreshLists = () => {
    setBusy(true); setErr('');
    invoke('blocker_refresh_lists')
      .then((s) => { setStats(s); reloadShieldTabs(); })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  const fmtUpdated = (ts) => {
    if (!ts) return 'vendored with app';
    const days = Math.floor((Date.now() / 1000 - ts) / 86400);
    const d = new Date(ts * 1000).toLocaleDateString();
    return days <= 0 ? `today (${d})` : days === 1 ? `1 day ago (${d})` : `${days} days ago (${d})`;
  };

  return (
    <div>
      <SectionBand title="Ad & tracker blocking" anchor="set-browser-shield">
        <SettingRow stacked
          label="Block ads & trackers (Shield)"
          hint="Refuses ad/tracker requests at the proxy, hides ad slots with cosmetic filters, and runs anti-adblock + best-effort YouTube scriptlets. On by default. Changes apply on the next page load.">
          <ToggleButton on={enabled} accent={accent} onToggle={toggleEnabled} />
        </SettingRow>
      </SectionBand>

      <SectionBand title="Filter lists" anchor="set-browser-filterLists">
        <SettingRow label="Blocked domains">
          <span style={statNum}>{stats ? stats.hostRules.toLocaleString() : '—'}</span>
        </SettingRow>
        <SettingRow label="Scriptlet rules">
          <span style={statNum}>{stats ? stats.scriptletRules.toLocaleString() : '—'}</span>
        </SettingRow>
        <SettingRow label="Lists updated">
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {stats ? fmtUpdated(stats.listsUpdatedAt) : '—'}
          </span>
        </SettingRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6 }}>
          <button type="button" onClick={refreshLists} disabled={busy}
            style={{ ...removeBtn, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Updating…' : 'Update now'}
          </button>
          {err && <span style={{ fontSize: 11, color: 'var(--danger, var(--text))' }}>{err}</span>}
        </div>
        <div style={hintText}>Refreshes blocked domains + cosmetic filters from EasyList/EasyPrivacy (auto on launch when &gt;7 days old). Scriptlets and path-level filters refresh with app updates.</div>
      </SectionBand>

      <SectionBand title="Per-site exceptions">
        {allowlist.length === 0 ? (
          <div style={hintText}>No exceptions. Use the shield button in the address bar to turn Shield off for a specific site.</div>
        ) : (
          allowlist.slice().sort().map(h => (
            <div key={h} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
              <span style={{ fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{h}</span>
              <button type="button" onClick={() => removeSite(h)} style={removeBtn} title={`Re-enable Shield on ${h}`}>Remove</button>
            </div>
          ))
        )}
      </SectionBand>
    </div>
  );
}

// ── Browsing Data ────────────────────────────────────────────────────────────

function BrowsingDataPanel({ accent }) {
  const { settings, setSetting } = useModuleSettings('browser');
  const historyPaused = !!settings.historyPaused;
  const [dataInfo, setDataInfo] = useState({ cacheBytes: null, cookies: null });
  const [dataBusy, setDataBusy] = useState(false);
  const [dataMsg, setDataMsg] = useState('');
  const [confirmCookies, setConfirmCookies] = useState(false);

  const refreshData = () => {
    setDataBusy(true);
    Promise.allSettled([invoke('browser_cache_size'), invoke('browser_cookie_sites')])
      .then(([cache, cookies]) => setDataInfo({
        cacheBytes: cache.status === 'fulfilled' ? cache.value : null,
        cookies: cookies.status === 'fulfilled' ? cookies.value : null,
      }))
      .finally(() => setDataBusy(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refreshData(); }, []);

  const fmtBytes = (n) => {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
  };

  const clearCache = () => {
    invoke('browser_clear_cache')
      .then(() => { setDataMsg('Cache cleared.'); refreshData(); })
      .catch(() => setDataMsg('Clear cache failed.'));
  };
  const clearCookies = () => {
    if (!confirmCookies) {
      setConfirmCookies(true);
      setDataMsg('Clears all cookies — signs you out everywhere. Click again to confirm.');
      return;
    }
    setConfirmCookies(false);
    invoke('browser_clear_cookies')
      .then(() => { setDataMsg('Cookies cleared — signed out. Reload pages to see it.'); refreshData(); })
      .catch(() => setDataMsg('Clear cookies failed.'));
  };
  const clearHistory = () => { store.clearHistory(); setDataMsg('Browsing history cleared.'); };

  return (
    <div>
      <SectionBand title="Browsing data" anchor="set-browser-clearData">
        <SettingRow label="Cache">
          <span style={statNum}>{dataBusy && dataInfo.cacheBytes == null ? '…' : fmtBytes(dataInfo.cacheBytes)}</span>
        </SettingRow>
        <SettingRow label="Cookies">
          <span style={statNum}>
            {dataInfo.cookies
              ? `${dataInfo.cookies.count.toLocaleString()} cookie${dataInfo.cookies.count === 1 ? '' : 's'} · ${dataInfo.cookies.sites.length} site${dataInfo.cookies.sites.length === 1 ? '' : 's'}`
              : (dataBusy ? '…' : 'unavailable')}
          </span>
        </SettingRow>
        {dataInfo.cookies && dataInfo.cookies.sites.length > 0 && (
          <details style={{ padding: '2px 0 4px' }}>
            <summary style={{ fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer' }}>Show sites</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 6 }}>
              {dataInfo.cookies.sites.map(s => (
                <span key={s} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', padding: '2px 6px' }}>{s}</span>
              ))}
            </div>
          </details>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 6 }}>
          <button type="button" onClick={clearCache} style={removeBtn}>Clear cache</button>
          <button type="button" onClick={clearCookies}
            style={{ ...removeBtn, ...(confirmCookies ? { borderColor: accent || 'var(--text)', color: accent || 'var(--text)' } : {}) }}>
            {confirmCookies ? 'Confirm — sign out' : 'Clear cookies'}
          </button>
          <button type="button" onClick={clearHistory} style={removeBtn}>Clear history</button>
        </div>
        {dataMsg && <div style={hintText}>{dataMsg}</div>}
        <SettingRow stacked
          label="Record history"
          hint="Log the pages you visit so they show on the History page. On by default; turn off to pause (the New-Tab Recent shortcuts still update).">
          <ToggleButton on={!historyPaused} accent={accent} onToggle={() => setSetting('historyPaused', !historyPaused)} />
        </SettingRow>
      </SectionBand>
    </div>
  );
}

// ── Password Vault ───────────────────────────────────────────────────────────

function VaultPanel({ accent }) {
  const { status } = useCredsStore();
  useEffect(() => { creds.refresh(); }, []);

  if (!status) return <div style={hintText}>Loading…</div>;
  if (!status.unlocked) return <InlineUnlock initialized={!!status.initialized} accent={accent}/>;

  return (
    <div>
      <SectionBand title="Backup & restore" anchor="set-browser-vaultBackup">
        <ExportImport accent={accent}/>
      </SectionBand>
      <SectionBand title="Security">
        <SettingsPanel accent={accent} status={status}/>
      </SectionBand>
      <SectionBand title="Master password" anchor="set-browser-masterPassword">
        <ChangeMaster accent={accent}/>
      </SectionBand>
      <SectionBand title="Session">
        <SettingRow label="Vault is unlocked">
          <button type="button" style={removeBtn} onClick={() => creds.lock()}>Lock now</button>
        </SettingRow>
      </SectionBand>
    </div>
  );
}

function InlineUnlock({ initialized, accent, }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [stay, setStay] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      if (initialized) { await creds.unlock(pw, stay); }
      else {
        if (pw !== confirm) { setErr('Passwords do not match.'); setBusy(false); return; }
        await creds.initMaster(pw, stay);
      }
      setPw(''); setConfirm('');
    } catch (e) { setErr(e?.message || 'Failed.'); } finally { setBusy(false); }
  };

  return (
    <SectionBand title={initialized ? 'Unlock vault' : 'Create your vault'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360, padding: '4px 0' }}>
        {!initialized && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            The master password encrypts everything and is never stored — there's no recovery, so export a backup once set up.
          </span>
        )}
        {initialized && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Unlock the vault to manage backups, security, and the master password.
          </span>
        )}
        <input type="password" style={fieldInput} placeholder="Master password" value={pw}
          onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
        {!initialized && <input type="password" style={fieldInput} placeholder="Confirm" value={confirm}
          onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={stay} onChange={e => setStay(e.target.checked)} /> Stay unlocked on this device
        </label>
        {err && <span style={{ fontSize: 12, color: 'var(--danger,var(--text))' }}>{err}</span>}
        <button type="button" disabled={busy} onClick={submit}
          style={{ padding: '7px 12px', borderRadius: 'var(--radius-md)', border: `1px solid ${accent}`, background: accent, color: '#fff', fontWeight: 600, cursor: 'pointer', font: 'inherit' }}>
          {busy ? '…' : (initialized ? 'Unlock' : 'Create vault')}
        </button>
      </div>
    </SectionBand>
  );
}

// ── Browser Sidebar (stub) ───────────────────────────────────────────────────

function SidebarStubPanel() {
  return (
    <div data-search-anchor="set-browser-sidebar" style={{
      padding: '14px 16px',
      background: 'var(--surface-2)',
      border: '1px dashed var(--border)',
      borderRadius: 'var(--radius-md)',
      fontSize: 12, lineHeight: 1.55,
      color: 'var(--text-muted)',
    }}>
      Panels — pinned sites (mail, chat, docs) that slide out from the app's right
      edge beside whatever you're doing, each a persistent live web view. Add,
      remove, and reorder them here once the Panel Sidebar ships. Nothing to
      configure yet.
    </div>
  );
}
