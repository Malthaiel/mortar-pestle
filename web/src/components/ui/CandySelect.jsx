// THE app dropdown (Unified Dropdown, 2026-09-17). The trigger is a candy
// button; the menu it opens IS the app-wide right-click menu (useMenuTrigger ->
// openContextMenu -> ContextMenuRoot), 1-1: same rows, same keyboard (arrows,
// Home/End, type-ahead, Enter, Esc), same close rules. Every row leads with an
// icon; the selected option shows in the accent colour. Fullscreen-safe: ContextMenuRoot portals into
// document.fullscreenElement when there is one. Near the screen bottom the menu
// flips above the trigger on its own, measured -- there is no direction prop.
//
// Props:
//   value        current value (matched against options for the trigger label).
//                An ARRAY picks several at once: first match labels the trigger,
//                the rest ride after it as icons. Header/divider rows pass through.
//   options      [{ value, label, icon?, dot? }] -- `icon` is the row's icon, and
//                the trigger wears the CURRENT option's one before its label, so
//                button and menu row read as the same thing (user-directed
//                2026-09-18). `dot` is a colour painted there instead, for an
//                option that carries no icon at all
//   icon         menu icon for every option without its own (a list of one kind:
//                speeds, folders, languages); the trigger falls back to it too
//   onChange     (value) => void   -- receives the raw option value
//   clearable    re-picking the current option calls onChange('') (status pickers)
//   title        tooltip / aria-label on the trigger
//   placeholder  shown when no option matches value (default '')
//   accent       --accent for the trigger and the menu (default: inherited / app)
//   compact      smaller trigger, fills its row -- for the subtitle panel
//   disabled     disables the trigger
//   shape        data-shape for the trigger (default 'select') -- 'chip' makes it
//                the same control as the chips it sits beside
//   fuse         render the bare button (no wrapper) so it welds into a .candy-split
//   className    extra classes on the trigger
//   style        extra inline style on the trigger -- `pointerEvents: 'none'`
//                leaves one part of a run drawn but inert (disabled fades it)

import { useMenuTrigger } from '../../context-menu/useContextMenu.js';
import { TREE_TEXT } from '../vault-tree/treeKit.jsx';

export default function CandySelect({
  value, options, onChange, title, placeholder = '', clearable = false, accent, icon,
  compact = false, disabled = false, fuse = false,
  shape = 'select', className = '', style,
}) {
  // `value` may be an ARRAY: several independent picks in one menu (a status AND
  // a downloaded/not state, say). The FIRST match in option order drives the
  // label; the rest ride after it as bare icons, so the trigger stays short in a
  // narrow column. Array mode never synthesises '' — the consumer owns the
  // toggle, because '' cannot say WHICH of the two groups it clears.
  const multi = Array.isArray(value);
  const picked = multi ? options.filter(o => value.includes(o.value)) : [];
  const isPicked = (o) => multi ? value.includes(o.value) : o.value === value;
  const current = multi ? picked[0] : options.find(o => o.value === value);
  const extras = multi ? picked.slice(1) : [];
  // The trigger wears the row's own icon, else the list's shared one — the button
  // and the menu row it mirrors always show the same mark (user-directed 2026-09-18).
  const CurIcon = current?.icon || icon;
  const menu = useMenuTrigger(() => options.map(o => (
    o.header || o.divider ? o : {
      label: o.label,
      icon: o.icon || icon,
      checked: isPicked(o),
      onClick: () => onChange(clearable && !multi && isPicked(o) ? '' : o.value),
    }
  )), accent ? { accent } : undefined);

  // is-fused: honour the run's --cbtn-size for height (see styles.css § select).
  const cls = 'candy-btn' + (compact ? ' is-compact' : '') + (fuse ? ' is-fused' : '') + (className ? ' ' + className : '');
  const button = (
    <button
      type="button"
      className={cls}
      data-shape={shape}
      data-own-press
      title={title}
      aria-label={title}
      disabled={disabled}
      style={{ ...(accent && { '--accent': accent }), ...style }}
      {...menu}
    >
      {/* Same lettering as the menu rows this button opens (TREE_TEXT, the
          sidebar tree's) so the trigger and its options read as one thing —
          user-directed 2026-09-19. */}
      <span className="candy-face" style={TREE_TEXT}>
        {/* inline-flex so a JSX label (leading icon + text) sits on the row's
            centre line instead of the text baseline. No-op for plain strings. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {CurIcon ? <CurIcon size={14} /> : current?.dot !== undefined && (
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: current.dot || 'transparent',
              border: current.dot ? 'none' : '1px solid var(--border-2)',
            }}/>
          )}
          {current ? current.label : placeholder}
          {extras.map(o => o.icon ? <o.icon key={o.value} size={12}/> : null)}
        </span>
      </span>
    </button>
  );
  // A fused trigger is the bare button: .candy-split fuses only its DIRECT
  // .candy-btn children, so a wrapper would leave it unfused beside its run.
  return fuse ? button : <div style={{ position: 'relative' }}>{button}</div>;
}
