# Iskariel — Design Language

A reproducible reference for polishing any surface in the Iskariel web app to the established quality bar: modern, smooth, elegant, minimal where it counts.

This doc is written for an LLM/agent doing the next polish pass. Reach for tokens before colors, primitives before inline styles, and existing patterns before new ones.

## North Star

Hairline borders, dim accent fills via `color-mix(in oklch, ...)`, sweep-style visualizations instead of ticks and numerals, 9px mono uppercase captions over icon labels, and hover-revealed depth instead of always-on density. Motion is short (100–240ms), structural (max-height + opacity + margin in lockstep), and never sluggish. Color signals state; opacity dims; typography differentiates rhythm.

## How to use this doc

For every visual decision, in order:

1. **Token first** (§Tokens). A `#hex` or `rgba()` in source outside of token definitions is an anti-pattern.
2. **Primitive next** (§Primitives). If a shared component fits, use it. Don't reinvent `Dot`, `IconBtn`, `HeaderChip`, `Seg`, `FilterChip`, `SectionHeader`, `EmptyState`, `LoadingState`.
3. **Pattern recipe** (§Patterns). When a primitive doesn't fit, follow a canonical recipe. The recipes are paste-and-adapt.
4. **Anti-patterns** (§Anti-patterns). Cross-check before saving.

When a new pattern emerges that's load-bearing for the rest of the app, add a section here under §Patterns.

## Reference surfaces

When in doubt, read these files. They are the canonical implementations.

| Surface | File | What to learn |
|---|---|---|
| Sweep dial | `web/src/components/AnalogClock.jsx` | Perimeter ring + filled wedge + single hairline hand |
| Caption row (with state dot) | `web/src/components/PomodoroDock.jsx` (paused branch) | `Dot` + 9px mono uppercase pattern |
| Card/block accent tinting | `web/src/components/CalendarPanel.jsx` (`PlanBlock` non-fixed branch) | Three-state fill via mix ratio: 28% / 38% / 55% |
| Hour gutter + current-state band | `web/src/components/CalendarPanel.jsx` (gutter + day-col band) | Per-cell tint + translucent absolute-positioned band |
| Panel header | `web/src/components/CalendarPanel.jsx` (header) | IconBtn chevrons + HeaderChip + Seg + FilterChip |
| Slim media row + hover-reveal | `web/src/components/music/SidebarMusicSlot.jsx` | Cover/text row, inline-time scrub, hover-extras transition |
| Scrub/progress bar | `web/src/components/music/SidebarMusicSlot.jsx` | Hairline track, handle on hover/drag, inline times |

## Tokens

All colors, radii, type families, and surface tints come from CSS vars. Hard-coded values are anti-patterns outside the token definitions themselves.

```
Surface       --surface             primary surface (panel/dock body)
              --surface-2           one step deeper (input field, cell idle bg)
              --surface-3           furthest back (calendar grid background)
              --hover               hover overlay for buttons / cells
Border        --border              hairline (1px) divider — visible
              --divider             extra-faint divider — almost invisible
Text          --text                primary copy
              --text-2              secondary copy (sub-labels in cards)
              --text-muted          tertiary (artists, sublabels in rows)
              --text-faint          quaternary (mono captions, disabled, placeholder)
Radii         --radius-sm           4–6  (chips, tiny pills, scrub track)
              --radius-md           8–10 (cards, cover art, block fills)
              --radius-lg           14–16 (containers, hero panels)
              999                   full-pill (segmented controls, filter chips)
Type          --font-mono           DM Mono — every mono use goes through this var
              (DM Sans is the implicit body family; no token alias)
Accent        --accent              session/route accent (changes by context)
              --appAccent           static app brand accent (kept distinct on purpose)
```

`appAccent` and `accentColor` are intentionally split — don't unify them in a polish pass. Surfaces consume one or the other based on what they belong to (chrome vs. timer/music).

## Color: the `color-mix` idiom

Always `color-mix(in oklch, ...)`. Never `rgba()`, never hex with hand-encoded alpha. oklch keeps hue perceptually stable as alpha drops.

| Use | Formula |
|---|---|
| Selected chip / cell fill | `color-mix(in oklch, ${accent} 14%, transparent)` |
| Card idle on dark surface | `color-mix(in oklch, ${tint} 28%, var(--surface-3))` |
| Card hovered | `color-mix(in oklch, ${tint} 38%, var(--surface-3))` |
| Card active / selected | `color-mix(in oklch, ${tint} 55%, var(--surface-3))` |
| Card border idle | `color-mix(in oklch, ${tint} 38%, var(--border))` |
| Card border active | `color-mix(in oklch, ${tint} 70%, var(--border))` |
| Translucent state band (now-hour, current step) | `color-mix(in oklch, ${accent} 6%, transparent)` |
| Per-cell current-state highlight (gutter) | `color-mix(in oklch, ${accent} 10%, transparent)` |
| Scrub/volume track idle | `color-mix(in oklch, ${accent} 14%, transparent)` |

These percentages are calibrated — don't drift. If a card needs to read "more selected," raise to 55%, don't invent 70% / 85% intermediate steps; the steps below are the design vocabulary.

## Typography

| Use | Size | Weight | Family | Letter | Transform |
|---|---|---|---|---|---|
| Mono caption | 9 | 400 | mono | 0.08em | UPPERCASE |
| Inline time strip (scrub) | 9 | 400 | mono | 0.04em | — |
| Mono UI glyph ("Aa", "↻¹") | 9–12 | 700 | mono | -0.02em | — |
| Section sub-label, count chip | 10–11 | 500 | mono | 0.04em | — |
| Body sub-label (artist, secondary) | 11 | 400 | sans | — | — |
| Body primary (title, action label) | 13 | 600 | sans | -0.005em | — |
| Panel-header chip text | 12–14 | 600 | sans | — | — |
| Drag-mode emphasis (clock) | 18–22 | 500 | mono | 0.04em | UPPERCASE |
| Page-header title | 26–30 | 600 | sans | -0.01em | — |

Numeric mono runs always get tabular nums:

```jsx
fontFamily: 'var(--font-mono)',
fontVariantNumeric: 'tabular-nums',
```

Letter-spacing is part of the type identity, not optional. Mono captions without `0.08em` don't read as captions.

## Primitives

Live under `web/src/components/ui/` and re-export via `web/src/components/ui/index.js`. Import as `from './ui/index.js'` (or `'../ui/index.js'` etc.) — never deep-import the individual files.

### `Button`

| Component | When |
|---|---|
| `PrimaryBtn` | Primary CTA only. Solid accent fill, sm/md radius. |
| `OutlinedBtn` | Secondary action. Hairline border, transparent fill, accent text on hover. |
| `IconBtn` | Square icon button. Sizes: `24` (extras), `28` (secondary transport / chevrons), `32` (default), `40` (primary transport). Props: `primary`, `active`, `playing`, `accent`, `disabled`, `size`, `title`. |
| `CircleChip` | Round badge for status glyphs around a primary control. |
| `HeaderChip` | Outlined mono-uppercase pill used in panel headers ("Today", "All", "Open ↗"). Click-to-reset / click-to-act semantics. |

### `Pill`

| Component | When |
|---|---|
| `Seg` | Segmented control (D/W/M, list/grid). Pill container, accent@14% fill on selected segment, accent text on selected. Props: `value`, `onChange`, `options`, `accent`. |
| `FilterChip` | Toggleable filter/tag pill. Like Seg but can be multi-selected. Props: `active`, `onClick`, `accent`. |

### `Stat`

| Component | When |
|---|---|
| `Dot` | Colored dot. Props: `color`, `size` (default 6), `glow` (adds soft accent halo for "live" states). Replaces all inline `<span style={{width, height, borderRadius, background}}>`. |
| `StatTile` | Labeled number tile (title + big number + sub-label). |
| `FrontmatterChip` | Inline-codey rendering of a YAML frontmatter key/value. |

### `Section`

| Component | When |
|---|---|
| `SectionHeader` | Page-section header. 30px title, 32px top padding, optional subtitle, right-side action chip slot, optional accent progress sliver pinned to bottom edge. |
| `EmptyState` | Centered icon + line + optional CTA chip pointing at a vault page. Use whenever a section can be sparse. |
| `LoadingState` | Pulsing skeleton — never a spinner. |

## Patterns

Each pattern: **principle** (the why), **recipe** (the canonical shape), **don't** (the anti-pattern, specific to this pattern).

### Caption row (state + label)

**Principle.** Above any content section, a 9px mono uppercase caption identifies state. The dot is colored when live, faint when idle. Color alone does not signal state — the dot does the heavy lifting.

**Recipe.**

```jsx
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  <Dot color={isLive ? accent : 'var(--text-faint)'} glow={isLive} size={5}/>
  <span style={{
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-faint)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  }}>
    {isLive
      ? 'Now Playing'
      : isPaused
        ? `Paused — ${fmtRemaining} left`
        : 'No Track'}
  </span>
</div>
```

**Don't.** Use color to indicate state without a dot. Capitalize the label in JSX (let CSS uppercase do it). Use sans-serif for captions. Drop the `glow` prop on live states — the soft halo is what makes the dot read as "active" instead of "decorative."

### Hover-reveal extras row

**Principle.** Secondary controls hide until intent is shown. Reveal on hover OR on a contextual flag (panel-open, drag-active). Three properties animate in lockstep: `max-height` (structural), `opacity` (visibility), `margin-top` (rhythm). Different durations on each give the reveal a layered feel.

**Recipe.**

```jsx
const [slotHover, setSlotHover] = useState(false);
const extrasOpen = hasContent && (slotHover || someContextualOpen);

<div
  onMouseEnter={() => setSlotHover(true)}
  onMouseLeave={() => setSlotHover(false)}
  style={{ /* parent */ }}
>
  {/* always-visible primary content above */}

  <div style={{
    marginTop: extrasOpen ? 8 : 0,
    maxHeight: extrasOpen ? 32 : 0,
    opacity: extrasOpen ? 1 : 0,
    overflow: 'hidden',
    transition:
      'max-height 200ms ease, opacity 160ms ease, margin-top 200ms ease',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <IconBtn title="Action A" onClick={a} size={24} accent={accent}>A</IconBtn>
      <IconBtn title="Action B" onClick={b} size={24} accent={accent}>B</IconBtn>
      {/* … */}
    </div>
  </div>
</div>
```

**Don't.** Animate `display` (not animatable). Animate `height: auto` (no transition). Reveal on idle hover with no contextual cue (twitchy on incidental cursor crossings). Use 300ms+ on a small UI element — it reads as lag. Collapse the extras when a panel they spawned is still open — keep `extrasOpen` true while the panel is open so the user can return their cursor without losing the active indicator.

### Card / block with accent tint

**Principle.** Solid dim fill over the deepest surface, hairline border, accent-driven through three states (idle / hover / active) by raising the mix ratio. Dashed outlines are reserved for placeholders/empty states — a populated card is always solid.

**Recipe.**

```jsx
const tint = accent; // or a per-category color
const isActive = /* selected/now/playing */;
const [hovered, setHovered] = useState(false);

<div
  onMouseEnter={() => setHovered(true)}
  onMouseLeave={() => setHovered(false)}
  style={{
    padding: '10px 12px',
    background: isActive
      ? `color-mix(in oklch, ${tint} 55%, var(--surface-3))`
      : `color-mix(in oklch, ${tint} ${hovered ? 38 : 28}%, var(--surface-3))`,
    border: `1px solid color-mix(in oklch, ${tint} ${isActive ? 70 : 38}%, var(--border))`,
    borderRadius: 'var(--radius-md)',
    position: 'relative',
    transition: 'background 120ms ease, border-color 120ms ease',
  }}
>
  {/* Optional left-edge stripe at high saturation for category tagging */}
  <div style={{
    position: 'absolute', left: 0, top: 0, bottom: 0,
    width: 3,
    background: `color-mix(in oklch, ${tint} ${isActive ? 95 : 65}%, var(--text-faint))`,
    borderRadius: 'var(--radius-md) 0 0 var(--radius-md)',
  }}/>

  <div style={{
    fontSize: 13, fontWeight: 600, color: 'var(--text)',
    letterSpacing: '-0.005em',
  }}>{title}</div>

  <div style={{
    fontSize: 11, color: 'var(--text-muted)', marginTop: 2,
  }}>{sub}</div>
</div>
```

**Don't.** Use `opacity: 0.5` on the whole card to indicate inactive — kills text legibility. Use dashed borders for active or hovered states. Reach for `box-shadow` to elevate within a panel (mix ratio is the elevation). Invent intermediate ratios — stick to 28 / 38 / 55 / 70 / 95.

### Time/value gutter with current-state highlight

**Principle.** A column of labels (hours, days, steps) where one is "current." Three signals stack: a tinted background cell, faded past-state labels, a stronger divider between structural halves (AM/PM, week-end, phase-boundary). Together they give the current step strong figure/ground without shouting.

**Recipe.**

```jsx
{hours.map(h => {
  const isCurrent = h === currentHour && todayVisible;
  const isPast = h < currentHour && todayVisible;
  const isAMPMSplit = h === 12;

  return (
    <div key={h} style={{
      height: hourHeight,
      background: isCurrent
        ? `color-mix(in oklch, ${accent} 10%, transparent)`
        : 'transparent',
      borderTop:
        h === 0
          ? 'none'
          : isAMPMSplit
            ? '1px solid var(--border)'
            : '1px solid var(--divider)',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'flex-end',
      paddingTop: 2,
      paddingRight: 6,
    }}>
      <span style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        color: isCurrent ? accent : 'var(--text-faint)',
        opacity: isPast ? 0.4 : 1,
        fontWeight: isCurrent ? 700 : 400,
        letterSpacing: '0.04em',
        padding: isCurrent
          ? '0 3px'
          : 0,
        borderRadius: isCurrent ? 'var(--radius-sm)' : 0,
        background: isCurrent
          ? `color-mix(in oklch, ${accent} 18%, transparent)`
          : 'transparent',
      }}>
        {hourLabel(h)}
      </span>
    </div>
  );
})}
```

**Don't.** Apply more than one state signal to the same axis (don't bold past labels AND fade them AND tint them). Skip the `--border` vs `--divider` distinction — the AM/PM split is structural, the others are decorative. Tint the gutter cell with `--accent` solid (50%+) — at that weight the data on top stops reading.

### Translucent state band across columns

**Principle.** When several parallel columns share a "current time" or "current step," a single translucent band beats N per-column highlights. The band is one absolutely-positioned div inside each column at the same Y.

**Recipe.**

```jsx
{/* Inside each day column, as the FIRST child so it sits behind block content */}
{todayVisible && (
  <div style={{
    position: 'absolute',
    top: currentHour * hourHeight,
    left: 0, right: 0,
    height: hourHeight,
    background: `color-mix(in oklch, ${accent} 6%, transparent)`,
    pointerEvents: 'none',
    zIndex: 0,
  }}/>
)}

{/* Blocks render at zIndex 10–30 above; now-line at zIndex 20 */}
```

**Don't.** Tint every cell in the current row separately — doubles the visual weight at column boundaries. Omit `pointerEvents: 'none'` — it'll eat clicks on whatever sits behind. Raise the percentage above 8% — the band stops being ambient and starts competing with block fills.

### Slim media row (cover + title/artist)

**Principle.** Square cover at fixed size, two-line text stack flexes to the right, ellipsis-truncate on overflow. Title is sans 13/600 with a tight letter-spacing pull (-0.005em); secondary line is sans 11 muted. The whole row is one rhythm unit — don't break it into separate cover-row / text-row stacks.

**Recipe.**

```jsx
<div style={{
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginTop: 10,
}}>
  <button
    onClick={openTarget}
    title={hasItem ? 'Open' : undefined}
    disabled={!hasItem}
    style={{
      width: 64, height: 64, padding: 0, border: 'none',
      background: 'transparent',
      cursor: hasItem ? 'pointer' : 'default',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      flexShrink: 0,
    }}
  >
    {imgSrc ? (
      <img src={imgSrc} alt="" style={{
        width: '100%', height: '100%',
        objectFit: 'cover',
        display: 'block',
        background: 'var(--surface-2)',
      }}/>
    ) : (
      <div style={{
        width: '100%', height: '100%',
        background: 'var(--surface-2)',
        border: '1px dashed var(--border)',  /* dashed OK: placeholder */
        borderRadius: 'var(--radius-md)',
      }}/>
    )}
  </button>

  <div style={{
    flex: 1,
    minWidth: 0,                    /* required for ellipsis to fire */
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  }}>
    <div style={{
      fontSize: 13, fontWeight: 600,
      color: hasItem ? 'var(--text)' : 'var(--text-faint)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      letterSpacing: '-0.005em',
    }}>{hasItem ? title : '—'}</div>

    <div style={{
      fontSize: 11, color: 'var(--text-muted)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>{sub || ' '}</div>
  </div>
</div>
```

**Don't.** Use ≥80px covers in sidebars (crowds the column; 56–64 is the working range). Omit `minWidth: 0` on the flex child — text won't truncate, the whole row will overflow silently. Default to `objectFit: contain` — covers should fill (`cover`), not letterbox.

### Scrub / progress bar with inline times

**Principle.** Hairline track at `accent@14%`, accent fill via `width:%`, handle hidden until hover/drag. Inline times in mono 9px with a `:` separator. The track is 3px idle / 4px on hover — the height change is the only "I am interactive" cue beyond the handle.

**Recipe.**

```jsx
const [scrubHover, setScrubHover] = useState(false);
const pct = hasItem && duration > 0
  ? Math.min(100, (position / duration) * 100)
  : 0;

<div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
  <div
    onMouseDown={onScrubDown}
    onMouseEnter={() => setScrubHover(true)}
    onMouseLeave={() => setScrubHover(false)}
    style={{
      flex: 1, height: 14,           /* 14px hit target around 3-4px track */
      display: 'flex', alignItems: 'center',
      cursor: hasItem && duration ? 'pointer' : 'default',
    }}
  >
    <div style={{
      width: '100%',
      height: scrubHover && hasItem ? 4 : 3,
      background: `color-mix(in oklch, ${accent} 14%, transparent)`,
      borderRadius: 2,
      position: 'relative',
      transition: 'height 100ms ease',
    }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: pct + '%',
        background: accent,
        borderRadius: 2,
        transition: 'width 100ms linear',
      }}/>
      {hasItem && (
        <div style={{
          position: 'absolute',
          top: '50%', left: `calc(${pct}% - 5px)`,
          width: 10, height: 10,
          borderRadius: '50%',
          background: accent,
          transform: 'translateY(-50%)',
          opacity: scrubHover ? 1 : 0,
          pointerEvents: 'none',
          transition: 'opacity 120ms ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        }}/>
      )}
    </div>
  </div>

  <span style={{
    fontSize: 9, color: 'var(--text-muted)', flexShrink: 0,
    fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '0.04em',
  }}>{fmt(position)} / {fmt(duration)}</span>
</div>
```

**Don't.** Show the handle always (visual noise on idle). Place labels above/below the bar — inline-right with `:` is the canonical position. Use a solid `--text` track background — `accent@14%` carries the brand into the smallest details.

### Sweep dial (analog clock, radial progress)

**Principle.** Drop tick marks and numerals. The circle is a perimeter ring; a single filled wedge shows progress/remaining; a single 1.5-stroke hairline hand indicates position. A small center hub anchors the eye. Interactive states (drag, hover) layer in a transparent halo and an optional mono label below.

**Recipe.**

```jsx
const cx = size / 2;
const cy = size / 2;
const r  = size / 2 - 6;
const handLen = r - 8;

const angle = progress * Math.PI * 2 - Math.PI / 2;
const handX = cx + Math.cos(angle) * handLen;
const handY = cy + Math.sin(angle) * handLen;

// Wedge from 12 o'clock sweeping clockwise to the hand
const startX = cx;
const startY = cy - r;
const sweepX = cx + Math.cos(angle) * r;
const sweepY = cy + Math.sin(angle) * r;
const largeArc = progress > 0.5 ? 1 : 0;

<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
  {/* Perimeter ring */}
  <circle cx={cx} cy={cy} r={r}
          fill="none" stroke="var(--border)" strokeWidth="1"/>

  {/* Filled wedge */}
  {progress > 0 && progress < 1 && (
    <path
      d={`M ${startX} ${startY}
          A ${r} ${r} 0 ${largeArc} 1 ${sweepX} ${sweepY}
          L ${cx} ${cy} Z`}
      fill={phaseColor}
      opacity={isDragMode ? 0.22 : 0.18}
    />
  )}

  {/* Drag halo */}
  {isDragMode && (
    <circle cx={cx} cy={cy} r={r + 6}
            fill="none" stroke={phaseColor}
            strokeWidth="1" opacity={0.3}/>
  )}

  {/* Single hairline hand */}
  <line
    x1={cx} y1={cy} x2={handX} y2={handY}
    stroke={phaseColor} strokeWidth="1.5"
    strokeLinecap="round"
    opacity={running || isDragMode ? 1 : 0.85}
  />

  {/* Center hub: filled outer + surface-colored inner */}
  <circle cx={cx} cy={cy} r={3} fill={phaseColor}/>
  <circle cx={cx} cy={cy} r={1.5} fill="var(--surface)"/>

  {/* Drag-mode label */}
  {isDragMode && (
    <text x={cx} y={cy + 42} textAnchor="middle"
          fontSize="18" fontFamily="var(--font-mono)"
          letterSpacing="0.04em" fill="var(--text)">
      {dragMins} MIN
    </text>
  )}
</svg>
```

**Don't.** Add 60 tick marks "for reference." Draw 12/3/6/9 numerals — the perimeter + hand carry the read. Use multiple hands (hour + minute + second). Skip the surface-colored inner hub — the two-layer hub is what reads as a clock instead of a dot at center.

### Segmented control / pill switcher

**Principle.** 999 radius, accent@14% fill on selected segment, hairline border on the container, sans 11/500 type. Active segment switches text color to accent. Whole control is `inline-flex` — it owns only the width its content needs.

**Recipe.**

```jsx
<div style={{
  display: 'inline-flex',
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: 2,
  gap: 2,
  background: 'var(--surface)',
}}>
  {options.map(opt => {
    const selected = opt.value === value;
    return (
      <button
        key={opt.value}
        onClick={() => onChange(opt.value)}
        style={{
          padding: '4px 10px',
          border: 'none',
          borderRadius: 999,
          background: selected
            ? `color-mix(in oklch, ${accent} 14%, transparent)`
            : 'transparent',
          color: selected ? accent : 'var(--text-2)',
          fontSize: 11, fontWeight: 500,
          letterSpacing: '0.02em',
          cursor: 'pointer',
          transition: 'background 120ms ease, color 120ms ease',
        }}
      >
        {opt.label}
      </button>
    );
  })}
</div>
```

**Don't.** Use a solid `accent` fill on the selected segment (too loud). Drop the container border — without it the floating tints read as standalone buttons. Use a different radius on the segments vs. the container — both must be 999 or both must match.

### Panel header

**Principle.** Title chip + nav controls on the left, view-switcher and filters on the right. Generous padding (`12px 18px`) signals "this is a section, not a row." Chevrons are `IconBtn`, today/range is a `HeaderChip`, period switcher is a `Seg`, filters are `FilterChip`. No raw `<button>text</button>` — every action goes through a primitive.

**Recipe.**

```jsx
<div style={{
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 18px',
  borderBottom: '1px solid var(--border)',
}}>
  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    <IconBtn title="Previous" onClick={prev} size={26} accent={accent}>‹</IconBtn>
    <HeaderChip onClick={resetToToday}>Today</HeaderChip>
    <IconBtn title="Next" onClick={next} size={26} accent={accent}>›</IconBtn>
    <span style={{
      marginLeft: 6,
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0.04em',
      color: 'var(--text-muted)',
    }}>{dateRangeLabel}</span>
  </div>

  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <Seg
      value={view}
      onChange={setView}
      accent={accent}
      options={[
        { value: 'D', label: 'D' },
        { value: 'W', label: 'W' },
        { value: 'M', label: 'M' },
      ]}
    />
    <FilterChip active={showCustom} onClick={toggleCustom} accent={accent}>
      {customDays}d
    </FilterChip>
  </div>
</div>
```

**Don't.** Pack the header with text buttons when icons exist (chevrons are universal). Use a different padding than the body suggests — the header should feel structurally one with the panel underneath. Drop the date-range label — context cost-free.

## Motion

| Use | Duration | Easing |
|---|---|---|
| Width fill (progress, scrub) | 100ms | linear |
| Height pulse (scrub hover thickness) | 100ms | ease |
| Background / color state changes | 120ms | ease |
| Handle opacity in/out (scrub, volume) | 120ms | ease |
| Opacity reveals (hover-extras body) | 160ms | ease |
| Structural reveals (max-height, margin-top) | 200ms | ease |
| Modal fade | 180ms | ease |
| Drawer / sheet slide | 240ms | cubic-bezier(0.22, 1, 0.36, 1) |
| Sidebar overlay width | 180ms | ease |
| Choreographed entry (opacity + translateX) | 220ms (60ms delay) | ease |

Hard caps: nothing over 240ms on small UI; nothing under 100ms on hover-driven state.

When animating multiple properties together (max-height + opacity + margin-top in hover-extras), give them different durations on purpose — the slight stagger reads as depth.

## Anti-patterns

These come up. Watch for them.

- **Hard-coded colors.** Any `#abc123`, `rgba(...)`, `hsl(...)` in source outside the token definitions themselves. Use `var(--*)` or `color-mix(in oklch, ${accent} N%, ...)`.
- **`'DM Mono'` string literals.** Always `'var(--font-mono)'`. The literal couples the file to the font choice.
- **`display: none` toggles for animated reveals.** Won't animate. Use the `max-height + opacity + margin-top` trio.
- **Inline status dots.** `<span style={{width, height, borderRadius: '50%', background}}/>` is forbidden. Use `Dot` — it carries `glow` and standardized sizes.
- **Dashed borders on non-empty states.** Dashed = placeholder/empty. A populated card is solid.
- **Spinners.** Use `LoadingState` (pulsing skeleton). Spinners are foreign to this UI.
- **Multi-pixel borders for elevation.** Stick to 1px. Elevation is the mix ratio, not border weight.
- **Mixed font families in one line of running text.** Don't mix mono and sans within a single line. (Inline mono tokens wrapped in a `<code>`-style span are OK; the wrapper is the visual cue.)
- **Tick marks and numerals on radial visualizations.** Perimeter ring + filled wedge + single hand.
- **Opacity dimming for "inactive" cards.** Lowers text contrast. Use the lower color-mix ratio on the fill.
- **300ms+ transitions on small UI.** Slow enough to read as lag. Cap at 240ms.
- **Captions in mixed case sans-serif.** Captions are 9px mono uppercase with 0.08em letter-spacing — full stop.
- **Box-shadow for layering on the same surface.** Shadow is for sheets/modals/floating panels only. Within a panel, layering is mix-ratio.
- **Per-cell tinting when a translucent band would do.** When several parallel columns share a row-current state, paint one absolutely-positioned band, not N tints.
- **Deep imports of primitives.** Always `from './ui/index.js'` (or relative equivalent). Direct imports of `./ui/Button.jsx` couple the consumer to the internal file layout.
- **Always-on density.** If a control isn't load-bearing, hide it behind hover or a contextual flag. Less chrome on idle is the brand.
- **Click handlers without `title`.** Every `IconBtn` and `HeaderChip` gets a `title` — tooltips are the accessibility backstop for icon-only controls.
- **Hand-coded `width: ...px` on rows that should ellipsis-truncate.** Use `flex: 1, minWidth: 0` on the flex child, and `overflow: hidden; textOverflow: ellipsis; whiteSpace: nowrap` on the text node. Forgetting `minWidth: 0` is the silent killer.

## When inventing new patterns

1. Read this file. If anything close exists, follow it.
2. Pick from §Tokens before defining new sizes/colors.
3. Reach for an existing §Primitives entry before writing inline styles.
4. Time motion against §Motion; pick the closest existing duration before inventing a new one.
5. After implementation, if the pattern is load-bearing for the rest of the app, add a section here under §Patterns — principle, recipe, anti-pattern.

The goal is not consistency for its own sake — it's that polished surfaces share a vocabulary, and the next polished surface should feel of-a-piece without having to re-derive the rules from scratch.
