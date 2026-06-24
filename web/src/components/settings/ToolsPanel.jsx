// Tools sub-tab (Modules › Tools). Unlike the four tier panels, these are NOT
// modules — there's no manifest, no module-loader entry, no tier. They're a
// hand-authored, static list of forthcoming first-party utilities, each
// rendered with the same card chrome as a ModuleCard (candy-section container +
// icon tile + title/description column) but stripped of all interactivity
// (no drag, no Install/Uninstall, no settings cog). TOOL_BLOCKS below is the
// entire "registry". Mirrors how CommunityPanel renders a static placeholder.

import { IconImage, IconMic, IconDroplet } from '../icons.jsx';

const TOOL_BLOCKS = [
  {
    id: 'screenshot',
    name: 'Screenshot',
    Icon: IconImage,
    description: 'Capture a region or window straight into the vault.',
    status: 'soon',
    // Later: src-tauri/src/commands/capture.rs
  },
  {
    id: 'whisper-stt',
    name: 'Whisper STT',
    Icon: IconMic,
    description: 'Local speech-to-text transcription powered by whisper.cpp.',
    status: 'planned',
    // Epic plan: Knowledge/Iskariel/Plans/Voice Transcription/
  },
  {
    id: 'color-picker',
    name: 'Color Picker',
    Icon: IconDroplet,
    description: 'Pick any colour on screen and copy its hex.',
    status: 'soon',
    // Later: web/src/components/ui/AccentPicker.jsx
  },
];

export default function ToolsPanel({ accent }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {TOOL_BLOCKS.map(t => (
        <ToolBlock key={t.id} tool={t} accent={accent}/>
      ))}
    </div>
  );
}

function ToolBlock({ tool, accent }) {
  const { Icon } = tool;
  const accentColor = accent || 'var(--text)';
  return (
    <div
      className="candy-section"
      data-tool-block={tool.id}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'flex-start', gap: 12,
        padding: '13px 15px',
      }}
    >
      <span style={{
        width: 34, height: 34, borderRadius: 'var(--radius-md)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface-2)', color: 'var(--text-muted)',
        flexShrink: 0, alignSelf: 'center',
      }}>
        {Icon ? <Icon size={18}/> : <span style={{ fontSize: 13, fontWeight: 600 }}>{tool.name[0]}</span>}
      </span>

      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{
            fontSize: 13.5, fontWeight: 600, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{tool.name}</span>
        </span>
        <span style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)' }}>
          {tool.description}
        </span>
      </span>

      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, alignSelf: 'center' }}>
        {tool.status === 'planned'
          ? <PlannedPill accent={accentColor}/>
          : <ComingSoonBtn/>}
      </span>
    </div>
  );
}

// Disabled candy-btn — same recipe as ModulesTab's CardActionBtn (candy-btn /
// data-shape="row" / .candy-face), plus the native disabled attr. The single
// opacity layer comes from `.candy-btn:disabled { opacity: 0.55 }` in
// styles.css — no extra row/chip opacity is stacked on top. title="Coming soon"
// is the only hint (no floating tooltip popover anywhere in the app).
function ComingSoonBtn() {
  return (
    <button
      type="button"
      disabled
      title="Coming soon"
      className="candy-btn"
      data-shape="row"
      style={{ width: 'auto', flexShrink: 0 }}
    >
      <span className="candy-face" style={{
        justifyContent: 'center',
        padding: '6px 12px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
      }}>Coming soon</span>
    </button>
  );
}

// Non-clickable, purely-informational accent-tinted pill marking the Voice
// Transcription epic (which lives in the vault — there is no in-app target to
// navigate to). Same accent-tint recipe as the `studio` TierBadge in
// ModulesTab (accent @ 18% over transparent + accent text).
function PlannedPill({ accent }) {
  return (
    <span style={{
      fontSize: 10, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '4px 9px',
      borderRadius: 'var(--radius-sm)',
      background: `color-mix(in oklch, ${accent} 18%, transparent)`,
      color: accent,
      whiteSpace: 'nowrap',
    }}>Planned</span>
  );
}
