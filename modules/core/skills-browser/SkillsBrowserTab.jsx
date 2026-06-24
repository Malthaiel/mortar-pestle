// Skills Browser settings tab UI. Lists every entry in registry.json with an
// Install button. After install, swaps to an Uninstall button. Both actions
// route through PUT/DELETE /api/file/Infrastructure/Skills/Slash/<id>.md.
//
// Overwrite: if a target file already exists at install time, show a confirm
// modal before overwriting. Uninstall always confirms.

import { useCallback, useEffect, useState } from 'react';

const INSTALL_DIR = 'Infrastructure/Skills/Slash';

export default function SkillsBrowserTab({ registry, skillsApi }) {
  const [installed, setInstalled] = useState({});
  const [busy, setBusy] = useState({});
  const [confirm, setConfirm] = useState(null);

  const refresh = useCallback(async () => {
    const next = {};
    await Promise.all(registry.map(async (s) => {
      next[s.id] = await skillsApi.isInstalled(s.id).catch(() => false);
    }));
    setInstalled(next);
  }, [registry, skillsApi]);

  useEffect(() => { refresh(); }, [refresh]);

  const doInstall = useCallback(async (skill, force) => {
    if (!force && installed[skill.id]) {
      setConfirm({ kind: 'overwrite', skill });
      return;
    }
    setBusy(b => ({ ...b, [skill.id]: true }));
    try {
      await skillsApi.install(skill.id, skill.content);
      setInstalled(prev => ({ ...prev, [skill.id]: true }));
    } finally {
      setBusy(b => ({ ...b, [skill.id]: false }));
    }
  }, [installed, skillsApi]);

  const doUninstall = useCallback(async (skill) => {
    setBusy(b => ({ ...b, [skill.id]: true }));
    try {
      await skillsApi.uninstall(skill.id);
      setInstalled(prev => ({ ...prev, [skill.id]: false }));
    } finally {
      setBusy(b => ({ ...b, [skill.id]: false }));
    }
  }, [skillsApi]);

  return (
    <div>
      <div style={{
        fontSize: 11, color: 'var(--text-faint)',
        marginBottom: 14, lineHeight: 1.5,
      }}>
        Demo skills from the static registry. Installing writes a file to
        <code style={{
          fontFamily: 'var(--font-mono)', fontSize: 11,
          padding: '0 4px',
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius-sm)',
          margin: '0 4px',
        }}>{INSTALL_DIR}/</code>
        — open in Obsidian to inspect.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {registry.map(s => (
          <SkillRow
            key={s.id}
            skill={s}
            installed={installed[s.id]}
            busy={busy[s.id]}
            onInstall={() => doInstall(s)}
            onUninstall={() => setConfirm({ kind: 'uninstall', skill: s })}
          />
        ))}
      </div>

      {confirm?.kind === 'overwrite' && (
        <ConfirmModal
          title={`Overwrite ${confirm.skill.id}.md?`}
          body={
            <>The file <code style={mono}>{INSTALL_DIR}/{confirm.skill.id}.md</code> already exists. Overwrite it?</>
          }
          confirmLabel="Overwrite"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const s = confirm.skill; setConfirm(null); doInstall(s, true); }}
        />
      )}
      {confirm?.kind === 'uninstall' && (
        <ConfirmModal
          title={`Delete ${confirm.skill.id}.md?`}
          body={
            <>This deletes <code style={mono}>{INSTALL_DIR}/{confirm.skill.id}.md</code> from the vault.</>
          }
          confirmLabel="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const s = confirm.skill; setConfirm(null); doUninstall(s); }}
        />
      )}
    </div>
  );
}

const mono = {
  fontFamily: 'var(--font-mono)', fontSize: 11,
  padding: '0 4px',
  background: 'var(--surface-2)',
  borderRadius: 'var(--radius-sm)',
};

function SkillRow({ skill, installed, busy, onInstall, onUninstall }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        background: hover ? 'var(--hover)' : 'transparent',
        transition: 'background 80ms ease',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{
            fontSize: 13, fontFamily: 'var(--font-body)',
            color: 'var(--text)',
          }}>{skill.name}</span>
          <span style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)',
          }}>{skill.category}</span>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-faint)',
          }}>{skill.version}</span>
        </div>
        <div style={{
          fontSize: 11, color: 'var(--text-muted)',
          marginTop: 2, lineHeight: 1.45,
        }}>{skill.description}</div>
      </div>
      <ActionButton
        installed={installed}
        busy={busy}
        onInstall={onInstall}
        onUninstall={onUninstall}
      />
    </div>
  );
}

function ActionButton({ installed, busy, onInstall, onUninstall }) {
  if (busy) {
    return <Btn disabled>Working…</Btn>;
  }
  if (installed) {
    return <Btn variant="ghost" onClick={onUninstall}>Uninstall</Btn>;
  }
  return <Btn variant="primary" onClick={onInstall}>Install</Btn>;
}

function Btn({ variant, disabled, onClick, children }) {
  const styles = {
    primary: {
      background: 'var(--text)',
      color: 'var(--surface)',
      border: 0,
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-muted)',
      border: '1px solid var(--border)',
    },
  }[variant] || {
    background: 'var(--surface-2)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        padding: '5px 12px',
        fontSize: 11,
        fontFamily: 'var(--font-body)',
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        ...styles,
      }}
    >{children}</button>
  );
}

function ConfirmModal({ title, body, confirmLabel, onCancel, onConfirm }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div onClick={onCancel} style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.52)',
      }}/>
      <div style={{
        position: 'relative',
        width: 380,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px 22px',
        boxShadow: 'var(--shadow-card)',
      }}>
        <div style={{
          fontSize: 14, fontWeight: 600,
          color: 'var(--text)',
          marginBottom: 8,
        }}>{title}</div>
        <div style={{
          fontSize: 12, lineHeight: 1.5,
          color: 'var(--text-muted)',
          marginBottom: 18,
        }}>{body}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
          <Btn variant="primary" onClick={onConfirm}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}
