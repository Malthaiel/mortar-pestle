// CollapsibleRail — the shared collapse/expand rail shell. Extracted from the
// primary Sidebar so any left rail (the app nav, the coaching-scrim tree) gets
// the SAME behaviour and edits propagate to both (Scrim Tree Consolidation,
// 2026-07-14). Owns: the width animation (expanded width <-> a thin rail), the
// `overflow:hidden` clip that keeps the expanded body mounted while collapsed,
// the expanded<->rail opacity crossfade, an optional background-texture backdrop,
// the toggle header slot, and an optional resize seam.
//
// CONTROLLED: the host owns `expanded` (persist wherever it likes) + `onToggle`,
// and supplies `peek` (a hold-to-peek boolean, e.g. from useKeybindHold). The
// body is `children` (rendered at the full `width`, clipped when collapsed); the
// thin-rail content is the optional `railContent` (rendered at `railWidth`).
// `header` (the toggle button) is always visible; `seam` (a fully-configured
// resize handle) shows only while effectively expanded.

const DEFAULT_TRANSITION = 'opacity 180ms ease';

export default function CollapsibleRail({
  expanded,
  peek = false,
  width = 280,
  railWidth = 56,
  header,
  children,
  railContent,
  seam,
  patternClass,
  containerStyle,
  layerStyle,
  bodyMounted = true,
}) {
  const effectiveExpanded = expanded || peek;
  const renderedWidth = effectiveExpanded ? width : railWidth;

  return (
    <div style={{
      position: 'relative',
      width: renderedWidth,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      ...containerStyle,
    }}>
      {/* Background-texture backdrop (host supplies the class); hidden when collapsed. */}
      {effectiveExpanded && patternClass && (
        <div className={patternClass} aria-hidden="true" style={{
          position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none',
        }}/>
      )}

      {header}

      <div style={{
        flex: 1, minHeight: 0,
        position: 'relative',
        display: 'flex', flexDirection: 'column',
      }}>
        {bodyMounted && (
          <>
            {/* Expanded body — kept mounted at full width, clipped by the outer
                overflow when collapsed, so re-expanding is instant + state-preserving. */}
            <div style={{
              position: 'absolute', top: 0, bottom: 0, left: 0,
              width,
              display: 'flex', flexDirection: 'column',
              opacity: effectiveExpanded ? 1 : 0,
              pointerEvents: effectiveExpanded ? 'auto' : 'none',
              transition: DEFAULT_TRANSITION,
              ...layerStyle,
            }}>
              {children}
            </div>
            {/* Thin-rail content — crossfaded in when collapsed. */}
            {railContent && (
              <div style={{
                position: 'absolute', top: 0, bottom: 0, left: 0,
                width: railWidth,
                display: 'flex', flexDirection: 'column',
                opacity: effectiveExpanded ? 0 : 1,
                pointerEvents: effectiveExpanded ? 'none' : 'auto',
                transition: DEFAULT_TRANSITION,
                ...layerStyle,
              }}>
                {railContent}
              </div>
            )}
          </>
        )}
      </div>

      {/* Resize seam — shown only while effectively expanded. */}
      {effectiveExpanded && seam}
    </div>
  );
}
