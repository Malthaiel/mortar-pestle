// Terminal module Settings tab. The terminal's look is fixed to Zed (Gruvbox
// Dark); the one knob is the monospace font family, module-scoped via
// useModuleSettings('terminal') → settings.modules.terminal.font, which
// propagates live (sharedEvents 'settings:change') to the mounted Terminal.

import { useModuleSettings } from '@host/hooks/useSettings.js';
import { Select } from '@host/components/ui/index.js';
import { TERMINAL_FONTS, DEFAULT_TERMINAL_FONT } from './themes.js';

function SectionBand({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600,
        marginBottom: 8,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {children}
      </div>
    </div>
  );
}

export default function SettingsTab({ accent }) {
  const { settings, setSetting } = useModuleSettings('terminal');
  const font = settings.font ?? DEFAULT_TERMINAL_FONT;

  return (
    <div>
      <SectionBand title="Appearance">
        <div
          data-search-anchor="set-terminal-appearance"
          style={{ padding: '8px 0' }}
        >
          <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>Look</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Zed (Gruvbox Dark) — the terminal is styled to match Zed's terminal exactly.
          </div>
        </div>

        <div
          data-search-anchor="set-terminal-font"
          style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}
        >
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>Font</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Monospace family. Lilex is Zed's default; every option is a Nerd Font Mono variant with the box-drawing / icon glyphs Claude Code uses.</div>
          </div>
          <Select
            options={TERMINAL_FONTS}
            value={font}
            onChange={(v) => setSetting('font', v)}
            accent={accent}
          />
        </div>
      </SectionBand>
    </div>
  );
}
