// Library settings page (Settings → Modules › Library). Two sub-tabs on the
// shared host Topbar: Anime (qBittorrent + subtitles — VideoSettingsTab) and
// Music (Spotify credentials + playlist/album export — MusicSettingsTab).
// Controlled by the drawer address via {initialSection, onNavigateSection}
// per PAGE_SECTIONS.library; falls back to local state standalone. The module
// registers ONE settings tab rendering this — pagesByModuleId keeps only the
// first tab per module, so sibling registrations would be silently dropped.

import { useState } from 'react';
import { Topbar } from '@host/components/ui';
import VideoSettingsTab from './VideoSettingsTab.jsx';
import MusicSettingsTab from './music/MusicSettingsTab.jsx';

const SECTIONS = [
  { id: 'anime', label: 'Anime' },
  { id: 'music', label: 'Music' },
];

export default function LibrarySettingsTab({ accent, initialSection, onNavigateSection }) {
  const [localSection, setLocalSection] = useState('anime');
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
      {section === 'anime' && <VideoSettingsTab accent={accent}/>}
      {section === 'music' && <MusicSettingsTab accent={accent}/>}
    </div>
  );
}
