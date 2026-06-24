// Curated, static search index for the Settings drawer header search.
//
// There is no global settings registry — every setting is hardcoded JSX across
// the tabs — so this file is the single source of truth for "what is
// searchable". Each entry maps a setting to the tab that owns it and the DOM
// anchor on its row (set via data-search-anchor=<anchor>), so a result can
// switch tabs, scroll to the exact row, and flash-highlight it.
//
// Entry shape:
//   { id, label, tabId, anchor, keywords?, description?, settingsKey?, valueText? }
//     id          stable unique key (React key)
//     label       visible setting label (always matched)
//     tabId       owning tab: a built-in id (appearance…dev) OR a module
//                 settings-tab id ('video-settings', 'planner')
//     anchor      the data-search-anchor value on the owning row (jump target)
//     keywords    curated synonyms so natural terms hit (e.g. 'dark mode')
//     description optional helper text mirrored from the tab (matched)
//     settingsKey optional dotted path into the host `settings` blob for
//                 live-value match (HOST settings only — module settings live
//                 in a separate store and are matched on text fields only)
//     valueText   optional (settings) => string for labelled/derived values;
//                 wins over settingsKey when present
//
// SOURCE-OF-TRUTH FILES (keep this index in sync when settings change):
//   components/SettingsDrawer.jsx          — AppearanceTab (Motion + Press & depth)
//   components/settings/NavigationTab.jsx  — dock/left/right/general sub-tab rows
//   components/settings/SystemTab.jsx      — build, updates, downloads, recycle rows
//   components/settings/PulseViewsPage.jsx — pulse module-page rows
//   components/settings/AgentsTab.jsx      — general/atelier sub-tab rows
//   components/settings/AnimationRows.jsx  — ROWS (11 toggles), relocated into
//                                            Appearance / Navigation / Planner
//   components/settings/SoundsTab.jsx      — ROWS (3 sound toggles)
//   components/settings/DockTab.jsx        — dock rows
//   modules/core/browser/BrowserSettingsTab.jsx — browser page rows (page: 'browser')
//   modules/core/library/VideoSettingsTab.jsx + music/MusicSettingsTab.jsx
//                                          (Anime/Music sub-tabs of page: 'library')
//   modules/core/planner/SettingsTab.jsx
//
// Anchor convention: set-<key> / set-<tab>-<key> / set-anim-<key> /
//   set-sound-<key> / set-<module>-<key>.

// 14 animation toggles (mirror AnimationRows ROWS). The 4th tuple field is the
// tab the toggle now lives in after the Animations tab was retired (appearance /
// navigation / planner). Anchors (set-anim-<key>) are unchanged.
const ANIM_TOGGLES = [
  ['clock-ambient',          'Clock breath + aura',    ['glow', 'aura', 'breathing', 'dial'],   'planner'],
  ['spring-press',           'Spring press',           ['button', 'depress', 'tactile', 'bounce'], 'appearance'],
  ['page-transitions',       'Page transitions',       ['route', 'navigate', 'slide'],          'navigation'],
  ['drawer-modal',           'Drawer + modal slides',  ['overlay', 'popup', 'fade'],            'appearance'],
  ['flyout',                 'Flyout pop-in/out',      ['collapsed', 'hover', 'spring'],        'navigation'],
  ['section-accordion',      'Section accordion',      ['collapse', 'expand', 'chevron'],       'navigation'],
  ['pulse-indicators',       'Pulse indicators',       ['badge', 'dot', 'glow'],                'navigation'],
  ['drag-tile-follow',       'Drag tile follow',       ['reorder', 'clone', 'cursor'],          'navigation'],
  ['drag-tile-smoothness',   'Drag tile smoothness',   ['lag', 'drag', 'trail'],                'navigation'],
  ['drag-drop-glide',        'Drop release glide',     ['snap', 'settle', 'duration'],          'navigation'],
  ['theme-transition',       'Theme color transition', ['crossfade', 'dark', 'light'],          'appearance'],
  ['planner-day-slide',      'Planner day slide',      ['planner', 'slide', 'day', 'pivot'],    'planner'],
  ['counter-tick',           'Section counter tick',   ['planner', 'counter', 'count', 'tick'], 'planner'],
  ['task-celebration',       'Task celebration',       ['confetti', 'chime', 'task', 'done'],   'planner'],
];

// 3 sound toggles (mirrors SoundsTab ROWS).
const SOUND_TOGGLES = [
  ['tactile-button-thock', 'Button thock',      ['click', 'tap', 'press']],
  ['reorder-pickup-thock', 'Drag pickup thock', ['lift', 'reorder', 'pill']],
  ['reorder-drop-thock',   'Drag drop thock',   ['release', 'reorder', 'pill']],
];

const animBool = (settings, key) => {
  const v = settings?.animations?.[key];
  return v !== false && v !== 'off' ? 'on' : 'off';
};

export const SETTINGS_SEARCH_INDEX = [
  // ── Appearance ──────────────────────────────────────────────────────────
  { id: 'appearance.mode', label: 'Color mode', tabId: 'appearance', anchor: 'set-themeMode',
    keywords: ['theme', 'dark', 'light', 'system'], description: 'Light / Dark / System.',
    settingsKey: 'themeMode' },
  { id: 'appearance.accent', label: 'Accent color', tabId: 'appearance', anchor: 'set-accentColor',
    keywords: ['color', 'tint', 'custom', 'hex', 'preset'],
    description: 'The global accent used across chrome.', settingsKey: 'accentColor' },
  { id: 'appearance.density', label: 'Density', tabId: 'appearance', anchor: 'set-density',
    keywords: ['compact', 'cozy', 'comfortable', 'spacing'], settingsKey: 'density' },
  { id: 'appearance.radius', label: 'Radius', tabId: 'appearance', anchor: 'set-radiusScale',
    keywords: ['rounded', 'sharp', 'pill', 'corners', 'shape'], settingsKey: 'radiusScale' },
  { id: 'appearance.sidebarPattern', label: 'Sidebar pattern', tabId: 'appearance', anchor: 'set-sidebarPattern',
    keywords: ['texture', 'background', 'lines', 'grid', 'hatch', 'arcs', 'crosshatch', 'rail', 'pattern'],
    description: 'Faint line texture behind the left + right sidebars.', settingsKey: 'sidebarPattern' },

  // ── Relocated motion scalars (was the Animations tab) ─────────────────────
  // ids keep their historical 'animations.*' prefix (stable React keys); tabId
  // now points at the tab each control moved into.
  { id: 'animations.hoverPress', label: 'Hover press strength', tabId: 'appearance', anchor: 'set-hoverPressIntensity',
    keywords: ['button', 'depress', 'tactile'], settingsKey: 'hoverPressIntensity' },
  { id: 'animations.largeDepth', label: 'Large button depth', tabId: 'appearance', anchor: 'set-largeButtonDepth',
    keywords: ['shadow', 'candy', 'pill', '3d'], settingsKey: 'largeButtonDepth' },
  { id: 'animations.smallDepth', label: 'Small button depth', tabId: 'appearance', anchor: 'set-smallButtonDepth',
    keywords: ['shadow', 'dock', 'icon', '3d'], settingsKey: 'smallButtonDepth' },
  { id: 'animations.musicTileDepth', label: 'Music tile depth', tabId: 'appearance', anchor: 'set-musicTileDepth',
    keywords: ['player', 'sidebar', 'shadow'], settingsKey: 'musicTileDepth' },
  { id: 'animations.surfaceDepth', label: 'Surface depth', tabId: 'appearance', anchor: 'set-surfaceDepth',
    keywords: ['shadow', 'card', 'modal', 'panel'], settingsKey: 'surfaceDepth' },
  { id: 'animations.followDrag', label: 'Preview follow drag', tabId: 'appearance', anchor: 'set-previewFollowDrag',
    keywords: ['hover', 'card', 'lag', 'trail'], settingsKey: 'previewFollowDrag' },
  { id: 'animations.scroll', label: 'Scroll smoothness', tabId: 'appearance', anchor: 'set-scrollSmoothness',
    keywords: ['wheel', 'easing', 'smooth'],
    description: 'Eases mouse-wheel scrolling so each notch glides to its target.',
    settingsKey: 'scrollSmoothness' },
  { id: 'animations.vaultTreeReveal', label: 'Folder reveal', tabId: 'navigation', section: 'left', anchor: 'set-vaultTreeReveal',
    keywords: ['vault', 'tree', 'folder', 'cascade', 'expand', 'collapse', 'sidebar'],
    description: 'How the vault file-tree folders expand and collapse.',
    settingsKey: 'vaultTreeReveal' },
  { id: 'animations.vaultTreeSuffix', label: 'Show name suffixes', tabId: 'navigation', section: 'left', anchor: 'set-vaultTreeSuffix',
    keywords: ['vault', 'tree', 'extension', 'slash', 'filename', 'suffix', 'md'],
    description: 'Append a trailing / after folder names and .md after note names in the vault file tree.',
    valueText: (s) => (s?.vaultTreeSuffix ? 'on' : 'off') },

  // ── Relocated motion toggles (was the Animations tab) — per-key tabId ──────
  ...ANIM_TOGGLES.map(([key, label, keywords, tabId]) => ({
    id: `animations.${key}`, label, tabId, anchor: `set-anim-${key}`,
    // Navigation hosts its motion toggles on the General sub-tab; other tabs
    // have no strip (planner routes through its module-page alias).
    section: tabId === 'navigation' ? 'general' : undefined,
    keywords: ['animation', ...keywords],
    valueText: (s) => animBool(s, key),
  })),

  // ── Sounds — 5 toggles ────────────────────────────────────────────────────
  ...SOUND_TOGGLES.map(([key, label, keywords]) => ({
    id: `sounds.${key}`, label, tabId: 'sounds', anchor: `set-sound-${key}`,
    keywords: ['sound', 'audio', ...keywords],
    valueText: (s) => (s?.sounds?.[key] === true ? 'on' : 'off'),
  })),

  // ── Navigation / Sidebar ──────────────────────────────────────────────────
  { id: 'nav.groupMode', label: 'Group collapse mode', tabId: 'navigation', section: 'left', anchor: 'set-sidebarGroupMode',
    keywords: ['sidebar', 'accordion', 'expand', 'collapse', 'section'], settingsKey: 'sidebarGroupMode' },

  // ── Navigation / Dock ─────────────────────────────────────────────────────
  { id: 'dock.edge', label: 'Edge depth', tabId: 'navigation', section: 'dock', anchor: 'set-dock-edgeStyle',
    keywords: ['dock', 'flush', 'hairline', 'band', 'shadow'], settingsKey: 'dock.edgeStyle' },
  { id: 'dock.bgShade', label: 'Dock color', tabId: 'navigation', section: 'dock', anchor: 'set-dock-bgShade',
    keywords: ['dock', 'color', 'colour', 'background', 'grey', 'gray', 'charcoal', 'graphite', 'slate', 'dark'], settingsKey: 'dock.bgShade' },
  { id: 'dock.iconStyle', label: 'Icon style', tabId: 'navigation', section: 'dock', anchor: 'set-dock-iconStyle',
    keywords: ['dock', 'icon', 'chip', 'button', 'light', 'dark', 'native'], settingsKey: 'dock.iconStyle' },
  { id: 'dock.defaultMode', label: 'Default module on launch', tabId: 'navigation', section: 'dock', anchor: 'set-dock-defaultMode',
    keywords: ['dock', 'boot', 'startup', 'last', 'specific'], settingsKey: 'dock.modules.defaultMode' },
  { id: 'dock.clickBehavior', label: 'Dock button click', tabId: 'navigation', section: 'dock', anchor: 'set-dock-clickBehavior',
    keywords: ['dock', 'navigate', 'swap', 'sidebar'], settingsKey: 'dock.modules.clickBehavior' },
  { id: 'dock.navSync', label: 'Route → sidebar sync', tabId: 'navigation', section: 'dock', anchor: 'set-dock-navSync',
    keywords: ['dock', 'auto', 'sticky', 'route'], settingsKey: 'dock.modules.navSync' },
  { id: 'dock.slideDuration', label: 'Swap duration', tabId: 'navigation', section: 'dock', anchor: 'set-dock-slideDuration',
    keywords: ['dock', 'animation', 'speed', 'staggered'], settingsKey: 'dock.modules.slideDuration' },
  { id: 'dock.activeIndicator', label: 'Active indicator', tabId: 'navigation', section: 'dock', anchor: 'set-dock-activeIndicator',
    keywords: ['dock', 'marker', 'beam', 'dot', 'lift'], settingsKey: 'dock.modules.activeIndicator' },
  { id: 'dock.expandMs', label: 'Dock hover expand speed', tabId: 'navigation', section: 'dock', anchor: 'set-dock-expandMs',
    keywords: ['dock', 'animation', 'speed', 'duration', 'hover', 'expand'], settingsKey: 'dock.expandMs' },
  { id: 'dock.collapseMs', label: 'Dock hover collapse speed', tabId: 'navigation', section: 'dock', anchor: 'set-dock-collapseMs',
    keywords: ['dock', 'animation', 'speed', 'duration', 'hover', 'collapse'], settingsKey: 'dock.collapseMs' },
  { id: 'dock.order', label: 'Dock order', tabId: 'navigation', section: 'dock', anchor: 'set-dock-order',
    keywords: ['dock', 'rearrange', 'reset', 'reorder'] },

  // ── Pulse Views ────────────────────────────────────────────────────────────
  { id: 'pulse.timeFormat', label: 'Time format', tabId: 'pulse', anchor: 'set-timeFormat24h',
    keywords: ['24h', '12h', 'clock', 'am', 'pm'], valueText: (s) => (s?.timeFormat24h ? '24h' : '12h') },
  { id: 'pulse.hourHeight', label: 'Calendar hour height', tabId: 'pulse', anchor: 'set-calendarHourHeight',
    keywords: ['calendar', 'zoom', 'row', 'planner'], settingsKey: 'calendarHourHeight' },
  { id: 'pulse.hourGutter', label: 'Hour gutter', tabId: 'pulse', anchor: 'set-showCalendarHourGutter',
    keywords: ['calendar', 'labels', 'times'], valueText: (s) => (s?.showCalendarHourGutter !== false ? 'show' : 'hide') },
  { id: 'pulse.fitnessStreak', label: 'Workout streak counter', tabId: 'pulse', anchor: 'set-showFitnessStreak',
    keywords: ['health', 'fitness', 'streak', 'workout', 'planner', 'dumbbell'], valueText: (s) => (s?.showFitnessStreak === true ? 'show' : 'hide') },
  // ── Agents ────────────────────────────────────────────────────────────────
  { id: 'agents.backend', label: 'Auth backend', tabId: 'agents', section: 'general', anchor: 'set-agents-authBackend',
    keywords: ['api key', 'claude code', 'anthropic', 'atelier', 'design'], settingsKey: 'agents.authBackend' },
  { id: 'agents.model', label: 'Model', tabId: 'agents', section: 'general', anchor: 'set-agents-model',
    keywords: ['opus', 'sonnet', 'haiku', 'atelier', 'design'], settingsKey: 'agents.model' },
  { id: 'agents.apiKey', label: 'Anthropic key', tabId: 'agents', section: 'general', anchor: 'set-agents-apiKey',
    keywords: ['api key', 'secret', 'keychain', 'token', 'design'] },
  { id: 'agents.magnetRadius', label: 'Edge magnetism', tabId: 'agents', section: 'atelier', anchor: 'set-agents-magnetRadius',
    keywords: ['atelier', 'snap', 'free', 'magnet', 'edge', 'drag', 'window'], settingsKey: 'agents.magnetRadius' },
  { id: 'agents.snapCorners', label: 'Snap chat to corners', tabId: 'agents', section: 'atelier', anchor: 'set-agents-snapCorners',
    keywords: ['atelier', 'snap', 'corner', 'dock', 'drag', 'window'], valueText: (s) => (s?.agents?.snapCorners ? 'on' : 'off') },
  { id: 'agents.dragSmoothness', label: 'Drag glide', tabId: 'agents', section: 'atelier', anchor: 'set-agents-dragSmoothness',
    keywords: ['atelier', 'drag', 'smooth', 'glide', 'trail', 'lag', 'weight', 'window'], settingsKey: 'agents.dragSmoothness' },
  { id: 'agents.resetPosition', label: 'Reset chat position', tabId: 'agents', section: 'atelier', anchor: 'set-agents-resetPosition',
    keywords: ['atelier', 'reset', 'position', 'default', 'window', 'drag'] },

  // ── System ────────────────────────────────────────────────────────────────
  { id: 'system.vault', label: 'Vault connection', tabId: 'vaults', anchor: 'set-vaultConnection',
    keywords: ['reload', 'status', 'obsidian', 'markdown'] },
  { id: 'system.autoUpdate', label: 'Notify me about new builds', tabId: 'system', anchor: 'set-autoCheckUpdates',
    keywords: ['update', 'rebuild', 'toast'], valueText: (s) => (s?.dev?.autoCheckUpdates !== false ? 'on' : 'off') },
  { id: 'system.pollInterval', label: 'Update check cadence', tabId: 'system', anchor: 'set-updatePollInterval',
    keywords: ['update', 'poll', 'interval'], settingsKey: 'dev.updatePollInterval' },
  { id: 'system.downloadsHistoryCap', label: 'Downloads — keep recent', tabId: 'system', section: 'downloads', anchor: 'set-downloadsHistoryCap',
    keywords: ['download', 'history', 'cap', 'recent', 'limit'], settingsKey: 'downloads.historyCap' },
  { id: 'system.downloadsHistoryExpiry', label: 'Downloads — expire after', tabId: 'system', section: 'downloads', anchor: 'set-downloadsHistoryExpiryDays',
    keywords: ['download', 'history', 'days', 'expire', 'prune'], settingsKey: 'downloads.historyExpiryDays' },
  { id: 'system.recycleBinMaxItems', label: 'Recycling bin — keep deleted items', tabId: 'system', section: 'recycle', anchor: 'set-recycleBinMaxItems',
    keywords: ['recycle', 'trash', 'bin', 'restore', 'undo', 'delete', 'retention', 'cap'], settingsKey: 'recycleBinMaxItems' },
  { id: 'system.recycleBinRetentionDays', label: 'Recycling bin — expire after', tabId: 'system', section: 'recycle', anchor: 'set-recycleBinRetentionDays',
    keywords: ['recycle', 'trash', 'bin', 'restore', 'purge', 'days', 'retention', 'expire'], settingsKey: 'recycleBinRetentionDays' },

  // ── Module page: Browser (rows live on the page's sub-tabs) ───────────────
  { id: 'browser.shield', label: 'AD blocker shield', tabId: 'modules', page: 'browser', section: 'adblock', anchor: 'set-browser-shield',
    keywords: ['ad', 'block', 'shield', 'filter', 'tracker', 'browser'] },
  { id: 'browser.filterLists', label: 'Filter lists', tabId: 'modules', page: 'browser', section: 'adblock', anchor: 'set-browser-filterLists',
    keywords: ['adblock', 'easylist', 'rules', 'domains', 'scriptlet', 'browser'] },
  { id: 'browser.clearData', label: 'Clear browsing data', tabId: 'modules', page: 'browser', section: 'data', anchor: 'set-browser-clearData',
    keywords: ['cache', 'cookies', 'history', 'clear', 'wipe', 'browser'] },
  { id: 'browser.vaultBackup', label: 'Password vault backup', tabId: 'modules', page: 'browser', section: 'vault', anchor: 'set-browser-vaultBackup',
    keywords: ['export', 'import', 'backup', 'restore', 'passwords', 'browser'] },
  { id: 'browser.masterPassword', label: 'Master password', tabId: 'modules', page: 'browser', section: 'vault', anchor: 'set-browser-masterPassword',
    keywords: ['password', 'vault', 'master', 'change', 'security', 'browser'] },
  { id: 'browser.sidebar', label: 'Browser sidebar', tabId: 'modules', page: 'browser', section: 'sidebar', anchor: 'set-browser-sidebar',
    keywords: ['panel', 'sidebar', 'web', 'mail', 'browser'] },

  // ── Module cards (Install/Uninstall + cog live on the card) ───────────────
  ...[
    ['browser', 'Browser', 'core'], ['domain-builder', 'Domain Builder', 'core'],
    ['library', 'Library', 'core'], ['planner', 'Planner', 'core'],
    ['pulse', 'Pulse', 'core'], ['skills', 'Skills', 'core'],
    ['skills-browser', 'Skills Browser', 'core'], ['terminal', 'Terminal', 'core'],
    ['vault', 'Vault', 'core'], ['video-editor', 'Video Editor', 'studio'],
  ].map(([id, name, tier]) => ({
    id: `module.${id}`, label: `Install ${name}`, tabId: 'modules', section: tier, anchor: `module-card-${id}`,
    keywords: ['module', 'install', 'uninstall', 'enable', 'disable', name.toLowerCase()],
  })),

  // ── Module: Video / Anime (text-only match; live values live elsewhere) ────
  { id: 'video.qbitHost', label: 'qBittorrent host', tabId: 'video-settings', anchor: 'set-video-qbitHost',
    keywords: ['anime', 'video', 'torrent', 'download', 'webui'] },
  { id: 'video.subSize', label: 'Subtitle size', tabId: 'video-settings', anchor: 'set-video-subSize',
    keywords: ['anime', 'video', 'caption', 'font'] },
  { id: 'video.subStyle', label: 'Subtitle style', tabId: 'video-settings', anchor: 'set-video-subStyle',
    keywords: ['anime', 'video', 'caption', 'box', 'shadow', 'outline'] },
  { id: 'video.subPosition', label: 'Subtitle position', tabId: 'video-settings', anchor: 'set-video-subPosition',
    keywords: ['anime', 'video', 'caption', 'vertical'] },
  { id: 'video.subFont', label: 'Subtitle font', tabId: 'video-settings', anchor: 'set-video-subFont',
    keywords: ['anime', 'video', 'caption', 'serif', 'sans', 'mono'] },

  // ── Module: Library / Music sub-tab. Explicit page+section shape — the
  // 'video-settings' alias substitution would drop section, landing on Anime. ──
  { id: 'music.import', label: 'Import playlist / album file', tabId: 'modules', page: 'library', section: 'music', anchor: 'set-music-importFile',
    keywords: ['music', 'import', 'csv', 'txt', 'playlist', 'album', 'exportify', 'chosic', 'spotify'] },
  { id: 'music.spotifyExport', label: 'Export from Spotify (Exportify)', tabId: 'modules', page: 'library', section: 'music', anchor: 'set-music-spotifyExport',
    keywords: ['music', 'spotify', 'export', 'playlist', 'exportify', 'csv'] },

  // ── Module: Planner (text-only match). 'tempo'/'pomodoro' stay in the
  // keyword arrays deliberately — muscle-memory search for the old brand. ──
  { id: 'planner.focus', label: 'Focus duration', tabId: 'planner', anchor: 'set-planner-focusMinutes',
    keywords: ['planner', 'tempo', 'pomodoro', 'timer', 'minutes', 'work'] },
  { id: 'planner.break', label: 'Break duration', tabId: 'planner', anchor: 'set-planner-breakMinutes',
    keywords: ['planner', 'tempo', 'pomodoro', 'timer', 'minutes', 'rest'] },
  { id: 'planner.accent', label: 'Planner accent color', tabId: 'planner', anchor: 'set-planner-accent',
    keywords: ['planner', 'tempo', 'pomodoro', 'color', 'music', 'dock'] },
  { id: 'planner.autoCaps', label: 'Auto caps session titles', tabId: 'planner', anchor: 'set-planner-autoCaps',
    keywords: ['planner', 'tempo', 'pomodoro', 'title', 'case', 'capitalize', 'caps', 'rename'] },
];

// Dotted-path getter into the host settings blob. Hyphenated keys are fine
// (e.g. 'animations.theme-transition').
export function readSettingsPath(settings, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), settings);
}

// Case-insensitive substring match across label + description + keywords +
// live-value text. Lightly ranked: label-prefix < label-contains < other-field.
export function searchSettings(index, query, settings) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const e of index) {
    const valueStr = e.valueText
      ? (e.valueText(settings) || '')
      : (e.settingsKey != null ? String(readSettingsPath(settings, e.settingsKey) ?? '') : '');
    const labelLc = e.label.toLowerCase();
    const hay = [labelLc, (e.description || '').toLowerCase(), (e.keywords || []).join(' ').toLowerCase(), String(valueStr).toLowerCase()].join('\u0001');
    if (hay.indexOf(q) === -1) continue;
    const rank = labelLc.startsWith(q) ? 0 : labelLc.includes(q) ? 1 : 2;
    out.push({ e, rank });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out.map(r => r.e);
}
