// Icon grid for one tree row — what "Change Icon" opens. Reuses Popover (the
// app's floating-panel master, positioned by the caller) + TreeToolbar's own
// ToolBtn for every cell (already a 26px square candy icon button at nav depth)
// + TextInput for the filter. No new CSS class, no new button, no new
// interaction primitive.

import { useState } from 'react';
import Popover from '../ui/Popover.jsx';
import { TextInput } from '../ui/Input.jsx';
import { IconX } from '../icons.jsx';
import { ToolBtn } from './TreeToolbar.jsx';
import { ICON_CATALOG, ICON_SIZE } from './treeIcons.jsx';
import { NAV_H } from './treeKit.jsx';

const COLS = 7;
const CELL = NAV_H;
const GAP = 6;
const PAD = 12;    // body padding — the SAME on all four sides
const RING = 4;    // slack for the candy hover ring, cancelled by a negative margin
const W = COLS * CELL + (COLS - 1) * GAP + PAD * 2;
const H = 320;

// "IconBookOpen" → "book open", so typing "book" finds it.
const words = (n) => n.replace(/^Icon/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

// `at` = the click point ({x, y} from the context-menu event). `current` = the
// row's icon name, or null.
export default function TreeIconPicker({ at, current, accent, onPick, onClose }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const list = term ? ICON_CATALOG.filter(([n]) => words(n).includes(term)) : ICON_CATALOG;
  // Clamp so the panel never opens off-screen.
  const left = Math.max(8, Math.min(at.x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - H - 8));

  return (
    <Popover
      open onClose={onClose} accent={accent} ariaLabel="Icon"
      style={{ position: 'fixed', left, top, width: W, height: H, zIndex: 1200,
        // The candy depth knob the tree shells declare. The picker is PORTALLED to
        // <body>, outside any tree, so without this the buttons' --cbtn-depth
        // resolves to nothing and the row gap below cannot be computed from it.
        '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)' }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: PAD, padding: PAD, overflow: 'hidden' }}
    >
      <TextInput value={q} onChange={setQ} placeholder="Search" accent={accent} autoFocus
        style={{ padding: '4px 9px', fontSize: 12 }}/>
      {/* No scrollbar at all (`.cal-noscrollbar`, the app's existing hide-the-bar
          utility) — a visible bar either lands on the icons or needs a lane, and a
          lane makes the left and right margins uneven. Wheel and drag still scroll.
          With the bar gone the column count can be EXACT again: auto-fill left
          leftover width that `center` split into two extra side margins, so the
          space beside the icons read wider than the space above them. Seven fixed
          columns exactly fill the body, and PAD is the same on all four sides. */}
      {/* RING = the slack a candy button paints OUTSIDE its 26px box (hover ring /
          frame). overflowX:hidden clipped it on the last column, so the right-hand
          icons read cut off. The scroller carries that slack as padding and gives
          it straight back as a negative margin, so the four visible margins stay
          PAD and nothing is clipped — no width guessing either way. */}
      <div className="cal-noscrollbar" style={{
        display: 'grid', gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
        columnGap: GAP,
        // A candy button hangs its depth slab BELOW itself, OUTSIDE layout — the
        // same reason treeKit's GAP is `calc(4px + var(--candy-depth-nav))`. A
        // plain 6px row gap is eaten by that slab and the rows read touching, so
        // the vertical gap carries the slab on top of the horizontal 6px.
        rowGap: `calc(${GAP}px + var(--candy-depth-nav))`,
        padding: `${RING}px`, margin: `-${RING}px`,
        overflowY: 'auto', overflowX: 'hidden', minHeight: 0, alignContent: 'start',
      }}>
        <ToolBtn title="No icon" accent={accent} active={!current} onClick={() => onPick(null)}>
          <IconX size={ICON_SIZE}/>
        </ToolBtn>
        {list.map(([name, C]) => (
          <ToolBtn key={name} title={words(name)} accent={accent} active={current === name}
            onClick={() => onPick(name)}>
            <C size={ICON_SIZE}/>
          </ToolBtn>
        ))}
      </div>
    </Popover>
  );
}
