// Obsidian-style Live Preview decoration engine for CodeMirror 6.
//
// One pane where markdown renders inline but stays editable. The line(s) that
// intersect the current selection reveal their raw markdown; every other line
// shows the decorated/rendered form. Driven by a StateField that rebuilds the
// DecorationSet on doc + selection changes.
//
// v1 (spine) constructs: headings, bold/italic/strike, inline code, blockquote,
// lists (• bullets), horizontal rules, clickable task checkboxes, wikilinks
// (regex — not in the grammar), and markdown links. Tables/callouts/embeds land
// in later slices.

import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { navigate } from '../router.js';

// ── Widgets ──────────────────────────────────────────────────────────────────

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lp-hr';
    return el;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lp-bullet';
    el.textContent = '•';
    return el;
  }
  ignoreEvent() { return false; }
}

class WikilinkWidget extends WidgetType {
  constructor(target, display, onWikilink, onLinkMenu) {
    super();
    this.target = target;
    this.display = display;
    this.onWikilink = onWikilink;
    this.onLinkMenu = onLinkMenu;
  }
  eq(o) { return o.target === this.target && o.display === this.display; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lp-wikilink';
    el.textContent = this.display;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;   // only left-click navigates; right-click falls through to contextmenu
      e.preventDefault();
      this.onWikilink?.(this.target);
    });
    el.addEventListener('contextmenu', (e) => {
      this.onLinkMenu?.(e, { kind: 'wikilink', target: this.target, display: this.display });
    });
    return el;
  }
  ignoreEvent() { return true; }
}

class MdLinkWidget extends WidgetType {
  constructor(text, url, onLinkMenu) {
    super();
    this.text = text;
    this.url = url;
    this.onLinkMenu = onLinkMenu;
  }
  eq(o) { return o.text === this.text && o.url === this.url; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lp-link';
    el.textContent = this.text;
    el.title = this.url;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;   // only left-click opens; right-click falls through to contextmenu
      e.preventDefault();
      const u = this.url;
      // External links open in the in-app sandboxed browser (/tools/browser).
      // It is https-only by design, so http:// falls back to the OS browser.
      if (/^https:\/\//i.test(u)) navigate('/tools/browser/' + encodeURIComponent(u));
      else if (/^http:\/\//i.test(u)) window.open(u, '_blank');
    });
    el.addEventListener('contextmenu', (e) => {
      this.onLinkMenu?.(e, { kind: 'external', url: this.url, text: this.text });
    });
    return el;
  }
  ignoreEvent() { return true; }
}

class TaskWidget extends WidgetType {
  constructor(checked, from, to) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }
  eq(o) { return o.checked === this.checked && o.from === this.from && o.to === this.to; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-lp-task';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => e.stopPropagation());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
      });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

// Block-level widgets (table / callout). Clicking dispatches a selection into
// the block (`pos`), which makes the line active → the widget vanishes and raw
// markdown is revealed for editing. They are NOT atomic — arrowing into the
// replaced lines also reveals raw.

class TableWidget extends WidgetType {
  constructor(html, pos) {
    super();
    this.html = html;
    this.pos = pos;
  }
  eq(o) { return o.html === this.html && o.pos === this.pos; }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-lp-table-wrap';
    el.innerHTML = this.html;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() { return true; }
}

class CalloutWidget extends WidgetType {
  constructor(kind, title, body, pos) {
    super();
    this.kind = kind;
    this.title = title;
    this.body = body;
    this.pos = pos;
  }
  eq(o) {
    return o.kind === this.kind && o.title === this.title && o.body === this.body && o.pos === this.pos;
  }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = `cm-lp-callout cm-lp-callout-${this.kind}`;
    const head = document.createElement('div');
    head.className = 'cm-lp-callout-title';
    head.textContent = this.title;
    box.appendChild(head);
    if (this.body) {
      const body = document.createElement('div');
      body.className = 'cm-lp-callout-body';
      body.textContent = this.body;
      box.appendChild(body);
    }
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() { return true; }
}

// Plan box — a Live-Preview treatment for ```plan fenced blocks. Accent-tinted
// callout titled "Plan"; the fenced lines render as bullets/checkboxes (see
// planBodyHtml). Block widget — clicking reveals the raw fence for editing.
class PlanWidget extends WidgetType {
  constructor(body, pos) {
    super();
    this.body = body;
    this.pos = pos;
  }
  eq(o) { return o.body === this.body && o.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'cm-lp-plan';
    const head = document.createElement('div');
    head.className = 'cm-lp-plan-title';
    head.textContent = 'Plan';
    box.appendChild(head);
    const body = document.createElement('div');
    body.className = 'cm-lp-plan-body';
    body.innerHTML = planBodyHtml(this.body);
    box.appendChild(body);
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() { return true; }
}

// Frontmatter → a Properties panel. Renders the YAML key/value pairs as a clean
// block; clicking reveals the raw `---…---` for editing. Built from the line
// range (not the grammar — Lezer mis-parses YAML as hr + setext heading).
class PropsWidget extends WidgetType {
  constructor(props, pos) {
    super();
    this.props = props;
    this.pos = pos;
    this.key = props.map((p) => p[0] + '\0' + p[1]).join('\n');
  }
  eq(o) { return o.pos === this.pos && o.key === this.key; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'cm-lp-props';
    for (const [k, v] of this.props) {
      const row = document.createElement('div');
      row.className = 'cm-lp-props-row';
      const key = document.createElement('span');
      key.className = 'cm-lp-props-key';
      key.textContent = k;
      const val = document.createElement('span');
      val.className = 'cm-lp-props-val';
      val.textContent = v;
      row.appendChild(key);
      row.appendChild(val);
      box.appendChild(row);
    }
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() { return true; }
}

// Embeds. `resolve` callbacks are injected by the host (PageView) so this
// module stays free of the api/IPC layer. They're not part of eq() — the
// callback is stable per editor instance; only the target identity matters.

class ImageWidget extends WidgetType {
  constructor(target, alt, direct, resolve) {
    super();
    this.target = target;   // wiki basename (direct=false) or literal url/path (direct=true)
    this.alt = alt || '';
    this.direct = direct;
    this.resolve = resolve;
  }
  eq(o) { return o.target === this.target && o.alt === this.alt && o.direct === this.direct; }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-lp-embed-img';
    img.alt = this.alt || this.target;
    img.loading = 'lazy';
    Promise.resolve(this.resolve?.(this.target, this.direct))
      .then((src) => { if (src) img.src = src; })
      .catch(() => {});
    return img;
  }
  ignoreEvent() { return true; }
}

class TransclusionWidget extends WidgetType {
  constructor(target, pos, resolve, hydrate) {
    super();
    this.target = target;
    this.pos = pos;
    this.resolve = resolve;
    this.hydrate = hydrate;
  }
  eq(o) { return o.target === this.target && o.pos === this.pos; }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-embed-note';
    const head = document.createElement('div');
    head.className = 'cm-lp-embed-note-title';
    head.textContent = this.target;
    head.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    });
    const body = document.createElement('div');
    body.className = 'reference-render cm-lp-embed-note-body';
    body.textContent = 'Loading…';
    wrap.appendChild(head);
    wrap.appendChild(body);
    Promise.resolve(this.resolve?.(this.target))
      .then((html) => {
        if (html == null) { body.textContent = `⚠ Cannot embed “${this.target}”`; return; }
        body.innerHTML = html;
        this.hydrate?.(body);
      })
      .catch(() => { body.textContent = `⚠ Cannot embed “${this.target}”`; });
    return wrap;
  }
  ignoreEvent() { return true; }
}

// ── Active-line + frontmatter helpers ────────────────────────────────────────

function activeLines(state) {
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

// Line number where YAML frontmatter closes (0 = no frontmatter). Decorations
// are suppressed for every line <= this so raw YAML is never mangled.
function frontmatterEndLine(state) {
  if (state.doc.lines < 2 || state.doc.line(1).text !== '---') return 0;
  for (let n = 2; n <= state.doc.lines; n++) {
    if (state.doc.line(n).text === '---') return n;
  }
  return 0;
}

// ── Decoration builder ───────────────────────────────────────────────────────

const HEADING_LEVELS = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3,
  ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6,
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif']);

function escHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Render the body of a ```plan block, line by line: task markers → checkboxes,
// list markers → bullets, everything else → a plain line. Inline markdown
// beyond this stays literal — the box reveals its raw fence on click for full
// editing. Checkboxes are display-only (disabled); toggling happens in raw.
function planBodyHtml(text) {
  const lines = text.replace(/\n+$/, '').split('\n');
  let html = '';
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      const checked = task[1].toLowerCase() === 'x';
      html += `<div class="cm-lp-plan-item"><input type="checkbox" class="cm-lp-task" disabled${checked ? ' checked' : ''}/>` +
        `<span${checked ? ' class="cm-lp-plan-done"' : ''}>${escHtml(task[2])}</span></div>`;
      continue;
    }
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      html += `<div class="cm-lp-plan-item"><span class="cm-lp-plan-bullet">•</span><span>${escHtml(li[1])}</span></div>`;
      continue;
    }
    html += `<div class="cm-lp-plan-line">${escHtml(line)}</div>`;
  }
  return html || '<div class="cm-lp-plan-line"></div>';
}

// Build a `<table>` from a Lezer GFM Table node (TableHeader / TableRow /
// TableCell). Cell text is plain (inline markdown inside cells isn't rendered
// in v1). Returns null if the node has no rows.
function tableHtml(tableNode, doc) {
  let header = null;
  const rows = [];
  for (let c = tableNode.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableHeader') header = rowCells(c, doc);
    else if (c.name === 'TableRow') rows.push(rowCells(c, doc));
  }
  if (!header && rows.length === 0) return null;
  let h = '<table class="cm-lp-table"><thead><tr>';
  for (const cell of header || []) h += `<th>${escHtml(cell)}</th>`;
  h += '</tr></thead><tbody>';
  for (const r of rows) {
    h += '<tr>';
    for (const cell of r) h += `<td>${escHtml(cell)}</td>`;
    h += '</tr>';
  }
  return h + '</tbody></table>';
}

function rowCells(rowNode, doc) {
  const cells = [];
  for (let c = rowNode.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableCell') cells.push(doc.sliceString(c.from, c.to).trim());
  }
  return cells;
}

function buildDecorations(state, opts) {
  const deco = [];
  const atomic = [];
  const codeRanges = [];
  const active = activeLines(state);
  const fmEnd = frontmatterEndLine(state);
  const doc = state.doc;

  const lineActive = (from, to) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };
  const hide = (from, to) => { if (to > from) deco.push(Decoration.replace({}).range(from, to)); };
  const markRange = (cls, from, to) => { if (to > from) deco.push(Decoration.mark({ class: cls }).range(from, to)); };
  const lineDeco = (cls, pos) => deco.push(Decoration.line({ class: cls }).range(pos));
  const replaceWidget = (from, to, widget) => {
    deco.push(Decoration.replace({ widget }).range(from, to));
    atomic.push(Decoration.replace({}).range(from, to));
  };
  // Block-replace widgets (table/callout) span whole lines and are not atomic.
  const blockLines = new Set();
  const blockWidget = (a, b, widget) => deco.push(Decoration.replace({ widget, block: true }).range(a, b));
  const markBlock = (n1, n2) => { for (let n = n1; n <= n2; n++) blockLines.add(n); };

  syntaxTree(state).iterate({
    enter: (node) => {
      const { from, to, name } = node;
      if (fmEnd > 0 && doc.lineAt(from).number <= fmEnd) {
        // Skip the subtree only when it lies wholly inside the frontmatter. A
        // container that spills into the body (notably the root Document node,
        // which starts at line 1) must still be descended, or every body node
        // gets skipped and nothing renders.
        return doc.lineAt(to).number <= fmEnd ? false : undefined;
      }

      const level = HEADING_LEVELS[name];
      if (level) {
        if (lineActive(from, to)) return false;
        lineDeco(`cm-lp-h cm-lp-h${level}`, doc.lineAt(from).from);
        const mark = node.node.getChild('HeaderMark');
        if (mark) {
          let end = mark.to;
          if (doc.sliceString(end, end + 1) === ' ') end += 1;
          hide(mark.from, end);
        }
        return false;
      }

      // Setext headings (`text` underlined by `===`/`---`). Style the content
      // line(s) and collapse the underline line so it reads as a header.
      if (name === 'SetextHeading1' || name === 'SetextHeading2') {
        if (lineActive(from, to)) return false;
        const lvl = name === 'SetextHeading1' ? 1 : 2;
        const mark = node.node.getChild('HeaderMark');
        const underline = doc.lineAt(mark ? mark.from : to);
        for (let n = doc.lineAt(from).number; n < underline.number; n++) {
          lineDeco(`cm-lp-h cm-lp-h${lvl}`, doc.line(n).from);
        }
        hide(underline.from, underline.to); // collapse the === / --- underline
        return false;
      }

      switch (name) {
        case 'StrongEmphasis':
          if (lineActive(from, to)) return false;
          markRange('cm-lp-strong', from, to);
          for (const m of node.node.getChildren('EmphasisMark')) hide(m.from, m.to);
          return;
        case 'Emphasis':
          if (lineActive(from, to)) return false;
          markRange('cm-lp-em', from, to);
          for (const m of node.node.getChildren('EmphasisMark')) hide(m.from, m.to);
          return;
        case 'Strikethrough':
          if (lineActive(from, to)) return false;
          markRange('cm-lp-strike', from, to);
          for (const m of node.node.getChildren('StrikethroughMark')) hide(m.from, m.to);
          return;
        case 'InlineCode':
          codeRanges.push([from, to]);
          if (lineActive(from, to)) return false;
          markRange('cm-lp-code', from, to);
          for (const m of node.node.getChildren('CodeMark')) hide(m.from, m.to);
          return false;
        case 'FencedCode': {
          codeRanges.push([from, to]);
          const infoNode = node.node.getChild('CodeInfo');
          const info = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim().toLowerCase() : '';
          if (info === 'plan') {
            if (lineActive(from, to)) return false;
            const textNode = node.node.getChild('CodeText');
            const body = textNode ? doc.sliceString(textNode.from, textNode.to) : '';
            const lf = doc.lineAt(from).from;
            const ll = doc.lineAt(to);
            blockWidget(lf, ll.to, new PlanWidget(body, lf));
            markBlock(doc.lineAt(from).number, ll.number);
          }
          return false;
        }
        case 'Blockquote': {
          if (lineActive(from, to)) return false;
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          // Callout? `> [!type] optional title` on the first line.
          const co = first.text.match(/^\s*>\s*\[!(\w+)\]([+-]?)\s*(.*)$/);
          if (co) {
            const kind = co[1].toLowerCase();
            const title = co[3].trim() || cap(kind);
            const bodyLines = [];
            for (let n = first.number + 1; n <= last.number; n++) {
              bodyLines.push(doc.line(n).text.replace(/^\s*>\s?/, ''));
            }
            blockWidget(first.from, last.to, new CalloutWidget(kind, title, bodyLines.join('\n'), first.from));
            markBlock(first.number, last.number);
            return false;
          }
          const a = first.number;
          const b = last.number;
          for (let n = a; n <= b; n++) lineDeco('cm-lp-blockquote', doc.line(n).from);
          for (const qm of node.node.getChildren('QuoteMark')) {
            let end = qm.to;
            if (doc.sliceString(end, end + 1) === ' ') end += 1;
            hide(qm.from, end);
          }
          return;
        }
        case 'Table': {
          if (lineActive(from, to)) return false;
          const html = tableHtml(node.node, doc);
          if (html) {
            const lf = doc.lineAt(from).from;
            const ll = doc.lineAt(to);
            blockWidget(lf, ll.to, new TableWidget(html, lf));
            markBlock(doc.lineAt(from).number, ll.number);
          }
          return false;
        }
        case 'HorizontalRule': {
          if (lineActive(from, to)) return false;
          const line = doc.lineAt(from);
          replaceWidget(line.from, line.to, new HrWidget());
          return false;
        }
        case 'ListMark': {
          if (lineActive(from, to)) return false;
          const line = doc.lineAt(from);
          if (/^\s*[-*+]\s+\[[ xX]\]/.test(line.text)) {
            let end = to;
            if (doc.sliceString(end, end + 1) === ' ') end += 1;
            hide(from, end);
          } else if (/^[-*+]$/.test(doc.sliceString(from, to))) {
            replaceWidget(from, to, new BulletWidget());
          }
          return false;
        }
        case 'TaskMarker': {
          if (lineActive(from, to)) return false;
          const checked = /x/i.test(doc.sliceString(from, to));
          replaceWidget(from, to, new TaskWidget(checked, from, to));
          return false;
        }
        case 'Link': {
          if (lineActive(from, to)) return false;
          const txt = doc.sliceString(from, to);
          const m = txt.match(/^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)$/);
          if (m) replaceWidget(from, to, new MdLinkWidget(m[1] || m[2], m[2], opts.onLinkMenu));
          return false;
        }
        case 'Image': {
          if (lineActive(from, to)) return false;
          const txt = doc.sliceString(from, to);
          const m = txt.match(/^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)$/);
          if (m) replaceWidget(from, to, new ImageWidget(m[2], m[1], true, opts.resolveImage));
          return false;
        }
        default:
          return;
      }
    },
  });

  // Frontmatter → Properties panel. Replace the whole `---…---` block with a
  // key/value widget, unless the cursor is inside it (then raw YAML shows so it
  // stays editable). Built from the line range — Lezer mis-parses YAML.
  if (fmEnd >= 2) {
    // Show raw YAML only while the cursor is actively inside the block. The
    // just-opened cursor sits at position 0 (head === 0), so treat that as
    // "not editing" and render the panel on open. Clicking the panel drops the
    // cursor onto the first YAML line (head > 0) to reveal raw for editing.
    const head = state.selection.main.head;
    const fmActive = head > 0 && head <= doc.line(fmEnd).to;
    if (!fmActive) {
      const props = [];
      for (let n = 2; n < fmEnd; n++) {
        const text = doc.line(n).text;
        const m = text.match(/^([A-Za-z0-9_][\w \-]*?):\s*(.*)$/);
        if (m) props.push([m[1].trim(), m[2].trim()]);
        else if (text.trim()) props.push(['', text.trim()]);
      }
      if (props.length) {
        blockWidget(doc.line(1).from, doc.line(fmEnd).to, new PropsWidget(props, doc.line(2).from));
        markBlock(1, fmEnd);
      }
    }
  }

  // Wikilinks/embeds aren't in the markdown grammar — scan non-active,
  // non-frontmatter, non-code lines for `[[...]]` (link) and `![[...]]` (embed:
  // image by basename, or whole-line note transclusion).
  const inCode = (pos) => codeRanges.some(([a, b]) => pos >= a && pos < b);
  const WL = /(!?)\[\[([^\]\n]+)\]\]/g;
  for (let n = 1; n <= doc.lines; n++) {
    if (active.has(n)) continue;
    if (blockLines.has(n)) continue;
    if (fmEnd > 0 && n <= fmEnd) continue;
    const line = doc.line(n);
    if (!line.text.includes('[[')) continue;
    WL.lastIndex = 0;
    let m;
    while ((m = WL.exec(line.text))) {
      const start = line.from + m.index;
      if (inCode(start)) continue;
      const end = start + m[0].length;
      const inner = m[2];
      if (m[1] === '!') {
        const target = inner.split('|')[0].split('#')[0].trim();
        const ext = (target.split('.').pop() || '').toLowerCase();
        if (IMG_EXTS.has(ext)) {
          replaceWidget(start, end, new ImageWidget(target, null, false, opts.resolveImage));
        } else if (line.text.trim() === m[0]) {
          blockWidget(line.from, line.to, new TransclusionWidget(target, line.from, opts.resolveTransclusion, opts.hydrate));
          blockLines.add(n);
        } else {
          replaceWidget(start, end, new WikilinkWidget(target, '↳ ' + (target.split('/').pop() || target), opts.onWikilink, opts.onLinkMenu));
        }
        continue;
      }
      const wlTarget = inner.split('|')[0].trim();
      const alias = inner.includes('|') ? inner.slice(inner.indexOf('|') + 1).trim() : null;
      const base = wlTarget.split('#')[0].split('/').pop() || wlTarget;
      replaceWidget(start, end, new WikilinkWidget(wlTarget, alias || base, opts.onWikilink, opts.onLinkMenu));
    }
  }

  return {
    decorations: Decoration.set(deco, true),
    atomics: Decoration.set(atomic, true),
  };
}

// ── Extension ────────────────────────────────────────────────────────────────

export function livePreview(opts = {}) {
  const field = StateField.define({
    create: (state) => buildDecorations(state, opts),
    update: (value, tr) => {
      if (tr.docChanged || tr.selection || tr.reconfigured) return buildDecorations(tr.state, opts);
      return value;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(f, false)?.atomics ?? Decoration.none),
    ],
  });
  return [field];
}

// ── Dev-only HMR guard ───────────────────────────────────────────────────────
// livePreview() is pulled in via a dynamic import() inside PageView, so Vite
// can't hot-update this module in place: it bubbles the change up to PageView's
// React-Fast-Refresh boundary, which re-renders the component without re-running
// the cached import — leaving the editor on a stale copy of this file. Self-
// accept and force a full reload so edits here actually reach the running
// window (Ctrl+R is unbound in the Tauri webview). Stripped from prod builds,
// where import.meta.hot is undefined.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
