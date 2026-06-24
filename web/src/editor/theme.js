// Editor surface for Live Preview — a curated CodeMirror 6 base (no line-number
// or fold gutter, so it reads as prose, not code) plus an accent-aware theme
// that mirrors the rendered `.reference-render` column (920px, 48px gutters).

import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

export function baseEditorExtensions() {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    // Native (WebView2) spellcheck — red squiggles + right-click suggestions on
    // the contenteditable surface. Obsidian-parity; autocorrect/autocapitalize
    // left off so the markdown source is never silently rewritten.
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ];
}

export function editorTheme(accent) {
  const a = accent || 'var(--text)';
  return EditorView.theme(
    {
      '&': { fontSize: '15px', backgroundColor: 'transparent', color: 'var(--text)', height: '100%' },
      '.cm-scroller': { fontFamily: 'var(--font-body)', lineHeight: '1.7', overflow: 'auto' },
      '.cm-content': { maxWidth: '920px', margin: '0 auto', padding: '16px 0 64px', caretColor: a },
      '.cm-line': { padding: '0 48px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: a, borderLeftWidth: '2px' },
      '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--surface-2) 45%, transparent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, ' + (accent || 'var(--accent, #6aa3ff)') + ' 30%, transparent)',
      },
      '.cm-selectionMatch': { backgroundColor: 'transparent' },
      // Slash-command (autocomplete) menu — mirrors the app's CandySelect /
      // CommandPalette candy menu: rounded surface with a 4px inner inset, 7px
      // row pills, and accent-tinted DM Mono category chips.
      '.cm-tooltip.cm-tooltip-autocomplete': {
        background: 'var(--surface-3, var(--surface))',
        border: '1px solid color-mix(in oklch, var(--surface), #000 22%)',
        borderRadius: '10px',
        boxShadow: '0 12px 32px color-mix(in oklch, #000 40%, transparent)',
        overflow: 'hidden',
      },
      '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-body)', maxHeight: '17em', padding: '4px', margin: '0' },
      '.cm-tooltip-autocomplete > ul > li': {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '7px 10px',
        margin: '1px 0',
        borderRadius: '7px',
        color: 'var(--text-muted)',
        lineHeight: '1.2',
        transition: 'background 100ms ease, color 100ms ease',
      },
      '.cm-tooltip-autocomplete > ul > li:hover': { background: 'var(--hover, var(--surface-2))', color: 'var(--text)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: a, color: '#fff' },
      '.cm-completionLabel': { fontSize: '13px', fontWeight: 500, color: 'inherit' },
      '.cm-completionDetail': {
        marginLeft: 'auto',
        fontStyle: 'normal',
        fontFamily: 'var(--font-mono)',
        fontSize: '9px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        padding: '1px 5px',
        borderRadius: '3px',
        border: '1px solid color-mix(in oklch, ' + a + ' 32%, transparent)',
        color: 'color-mix(in oklch, ' + a + ' 80%, var(--text-muted))',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': {
        border: '1px solid color-mix(in oklch, #fff 55%, transparent)',
        color: '#fff',
      },
      '.cm-completionInfo': {
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md, 8px)',
        boxShadow: '0 12px 32px color-mix(in oklch, #000 40%, transparent)',
        color: 'var(--text-muted)',
        padding: '8px 10px',
        fontSize: '12px',
      },
    },
    { dark: false },
  );
}
