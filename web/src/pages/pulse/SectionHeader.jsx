// Page-level header for Pulse routes. The implementations now live in
// components/ui/ — this file is kept as a re-export so existing
// `from '../pulse/SectionHeader.jsx'` imports keep working across the codebase.

export { SectionHeader as default, EmptyState, LoadingState } from '../../components/ui/Section.jsx';
export { HeaderChip } from '../../components/ui/Button.jsx';
