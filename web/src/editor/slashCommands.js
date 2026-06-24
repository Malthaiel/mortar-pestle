// In-editor "/" command menu (Obsidian-parity), built on @codemirror/autocomplete.
// Typing "/" at the start of a line (after optional indentation) opens a
// filterable menu that inserts markdown structures — headings, callouts, tables,
// code, lists, wikilinks, etc. The "/query" text is replaced by the snippet and
// the cursor (and any selection) is positioned for immediate typing.

import { autocompletion } from '@codemirror/autocomplete';

// Build an `apply` that replaces the matched "/query" [from,to] with `text`,
// then places the cursor at from+cursor, optionally selecting `selectLen` chars.
function insert(text, cursor, selectLen = 0) {
  return (view, _completion, from, to) => {
    const anchor = from + cursor;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor, head: anchor + selectLen },
      scrollIntoView: true,
    });
  };
}

const COMMANDS = [
  { label: 'Heading 1',     kw: 'h1 title',         detail: 'heading', apply: insert('# ', 2) },
  { label: 'Heading 2',     kw: 'h2',               detail: 'heading', apply: insert('## ', 3) },
  { label: 'Heading 3',     kw: 'h3',               detail: 'heading', apply: insert('### ', 4) },
  { label: 'Bold',          kw: 'strong b',         detail: 'inline',  apply: insert('****', 2) },
  { label: 'Italic',        kw: 'em i emphasis',    detail: 'inline',  apply: insert('**', 1) },
  { label: 'Inline code',   kw: 'mono',             detail: 'inline',  apply: insert('``', 1) },
  { label: 'Code block',    kw: 'fence pre',        detail: 'block',   apply: insert('```\n\n```', 4) },
  { label: 'Quote',         kw: 'blockquote',       detail: 'block',   apply: insert('> ', 2) },
  { label: 'Callout',       kw: 'admonition note',  detail: 'block',   info: 'Obsidian callout', apply: insert('> [!note] ', 10) },
  { label: 'Bullet list',   kw: 'ul unordered',     detail: 'list',    apply: insert('- ', 2) },
  { label: 'Numbered list', kw: 'ol ordered',       detail: 'list',    apply: insert('1. ', 3) },
  { label: 'Task',          kw: 'todo checkbox',    detail: 'list',    apply: insert('- [ ] ', 6) },
  { label: 'Divider',       kw: 'hr rule',          detail: 'block',   apply: insert('---\n', 4) },
  { label: 'Table',         kw: 'grid',             detail: 'block',   apply: insert('| Column | Column |\n| --- | --- |\n| Cell | Cell |\n', 2, 6) },
  { label: 'Wikilink',      kw: 'internal link',    detail: 'link',    apply: insert('[[]]', 2) },
  { label: 'Embed',         kw: 'transclude image', detail: 'link',    info: 'Embed a note or image', apply: insert('![[]]', 3) },
  { label: 'Link',          kw: 'url external',     detail: 'link',    apply: insert('[]()', 1) },
];

// Completion source: trigger on a line-leading "/" (only whitespace before it),
// filter the command list ourselves, and anchor `from` at the "/" so applying a
// command removes it.
function slashSource(context) {
  const word = context.matchBefore(/\/[\w-]*/);
  if (!word) return null;
  const line = context.state.doc.lineAt(word.from);
  const before = context.state.sliceDoc(line.from, word.from);
  if (before.trim() !== '') return null; // only at line start (after indentation)
  const query = word.text.slice(1).toLowerCase();
  const options = COMMANDS
    .filter(c => !query || (c.label + ' ' + c.kw).toLowerCase().includes(query))
    .map(c => ({ label: c.label, detail: c.detail, info: c.info, apply: c.apply }));
  if (!options.length) return null;
  return { from: word.from, options, filter: false };
}

export function slashCommands() {
  return autocompletion({
    override: [slashSource],
    activateOnTyping: true,
    icons: false,
  });
}
