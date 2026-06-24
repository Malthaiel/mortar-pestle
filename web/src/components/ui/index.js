// Shared UI primitive exports. Import from this barrel:
//   import { PrimaryBtn, OutlinedBtn, Seg, FilterChip, ... } from '../components/ui';

export { PrimaryBtn, OutlinedBtn, DangerOutlinedBtn, CircleChip, IconBtn, HeaderChip } from './Button.jsx';
export { default as AppWindow } from './AppWindow.jsx';
export { default as Popover, useAnchoredRect } from './Popover.jsx';
export { default as Toast } from './Toast.jsx';
export { default as Topbar } from './Topbar.jsx';
export { Seg, FilterChip } from './Pill.jsx';
export { renderInline } from './inlineMarkdown.jsx';
export { TextInput, Select } from './Input.jsx';
export { Slider } from './Slider.jsx';
export { Dot, StatTile, StatChip, FrontmatterChip } from './Stat.jsx';
export { SectionHeader, EmptyState, LoadingState } from './Section.jsx';
export { AccentGrid, HexInput, ACCENT_PRESETS, HEX_RE } from './AccentPicker.jsx';
