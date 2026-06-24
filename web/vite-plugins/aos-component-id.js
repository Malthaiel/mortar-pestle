// SF1 of Design Mode plan — Vite plugin that injects data-aos-component +
// data-aos-source on every JSXOpeningElement so Markup mode can resolve any
// rendered DOM node back to its source file.
//
// Runs with enforce:'pre' before @vitejs/plugin-react so the React plugin
// still sees JSX as input. Gated by AOS_DESIGN env (default on in dev, off
// in production unless explicitly enabled).

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const isComponentName = (name) => typeof name === 'string' && /^[A-Z]/.test(name);

const basenameComponent = (absId) => {
  const base = path.basename(absId).replace(/\.(jsx|tsx|js|ts)$/, '');
  return isComponentName(base) ? base : null;
};

const toRel = (absId) => {
  const rel = path.relative(PROJECT_ROOT, absId);
  return rel.split(path.sep).join('/');
};

export default function aosComponentId(options = {}) {
  const enabled = options.enabled !== false;

  return {
    name: 'aos-component-id',
    enforce: 'pre',
    apply: () => true,
    transform(code, id) {
      if (!enabled) return null;

      const cleanId = id.split('?')[0];
      if (!cleanId.endsWith('.jsx')) return null;
      if (cleanId.includes('node_modules')) return null;

      let ast;
      try {
        ast = parse(code, {
          sourceType: 'module',
          plugins: ['jsx'],
          allowImportExportEverywhere: true,
          allowReturnOutsideFunction: true,
        });
      } catch {
        return null;
      }

      const componentStack = [];
      const fileFallback = basenameComponent(cleanId);
      const sourcePath = toRel(cleanId);

      const pushIfComponent = (name) => {
        if (isComponentName(name)) {
          componentStack.push(name);
          return true;
        }
        return false;
      };

      let touched = false;

      traverse(ast, {
        FunctionDeclaration: {
          enter(p) { p.node._aosPushed = pushIfComponent(p.node.id?.name); },
          exit(p)  { if (p.node._aosPushed) componentStack.pop(); },
        },
        ClassDeclaration: {
          enter(p) { p.node._aosPushed = pushIfComponent(p.node.id?.name); },
          exit(p)  { if (p.node._aosPushed) componentStack.pop(); },
        },
        VariableDeclarator: {
          enter(p) {
            const init = p.node.init;
            if (!init) return;
            if (init.type !== 'ArrowFunctionExpression' && init.type !== 'FunctionExpression') return;
            p.node._aosPushed = pushIfComponent(p.node.id?.name);
          },
          exit(p) { if (p.node._aosPushed) componentStack.pop(); },
        },
        JSXOpeningElement(p) {
          const owner = componentStack[componentStack.length - 1] || fileFallback;
          if (!owner) return;

          const attrs = p.node.attributes;
          const has = (attrName) =>
            attrs.some((a) => a.type === 'JSXAttribute' && a.name?.name === attrName);

          const loc = p.node.loc?.start;
          const lineCol = loc ? `${loc.line}:${loc.column}` : '0:0';

          if (!has('data-aos-component')) {
            attrs.push(
              t.jsxAttribute(t.jsxIdentifier('data-aos-component'), t.stringLiteral(owner)),
            );
            touched = true;
          }
          if (!has('data-aos-source')) {
            attrs.push(
              t.jsxAttribute(
                t.jsxIdentifier('data-aos-source'),
                t.stringLiteral(`${sourcePath}:${lineCol}`),
              ),
            );
            touched = true;
          }
        },
      });

      if (!touched) return null;

      const out = generate(ast, { retainLines: true, compact: false, jsescOption: { minimal: true } }, code);
      return { code: out.code, map: null };
    },
  };
}
