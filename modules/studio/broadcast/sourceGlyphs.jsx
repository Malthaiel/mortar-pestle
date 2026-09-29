// Source-type → category glyph map (SP3 locked: ~12 category glyphs, not
// per-type art). Shared by the tree rows (SF1) and the add-source menu (SF3).

import React from 'react';
import {
  IconAppWindow, IconCamera, IconFilm, IconFolder, IconGamepad,
  IconGlobe, IconImage, IconLayers, IconMic, IconMonitor, IconPalette,
  IconSpeaker, IconTypeText, IconVideo,
} from '@host/components/icons.jsx';
import { NAV_ICON } from '@host/components/vault-tree/treeKit.jsx';

const MAP = {
  monitor_capture: IconMonitor,
  window_capture: IconAppWindow,
  game_capture: IconGamepad,
  dshow_input: IconCamera,
  wasapi_input_capture: IconMic,
  wasapi_output_capture: IconSpeaker,
  image_source: IconImage,
  slideshow: IconImage,
  ffmpeg_source: IconVideo,
  text_ft2_source: IconTypeText,
  text_ft2_source_v2: IconTypeText,
  color_source: IconPalette,
  color_source_v3: IconPalette,
  browser_source: IconGlobe,
  scene: IconFilm,
  group: IconFolder,
};

// Default = the tree's nav icon size, so a source row matches every other row.
export function glyphFor(typeId, size = NAV_ICON) {
  const base = (typeId || '').replace(/_v\d+$/, '');
  const Icon = MAP[typeId] || MAP[base] || IconLayers;
  return <Icon size={size} />;
}
