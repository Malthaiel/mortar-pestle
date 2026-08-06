// Minimal ESLint gate. Purpose: catch the React-hooks bug class. NOT a style
// gate — no Prettier, no formatting rules. See plans/008 for rationale.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';

// Source carries a single `eslint-disable react/no-danger` directive
// (RecyclingBinModal.jsx). Define a no-op so ESLint resolves that directive
// without pulling in all of eslint-plugin-react (a style plugin this gate avoids).
//
// `jsx-uses-vars` is inlined for the same reason: core no-unused-vars can't see
// that `<App />` uses the `App` import, so every JSX-only import reported as
// unused (~10 per file) and buried the genuinely-dead ones. This is the whole
// of eslint-plugin-react's rule — mark the identifier at the root of a JSX
// element name as used.
const reactShim = {
  rules: {
    'no-danger': { create: () => ({}) },
    'jsx-uses-vars': {
      create(context) {
        return {
          JSXOpeningElement(node) {
            let name = node.name;
            // <Foo.Bar /> and <a:b /> — the binding is the leftmost identifier.
            while (name.type === 'JSXMemberExpression') name = name.object;
            if (name.type === 'JSXNamespacedName') name = name.namespace;
            if (name.type === 'JSXIdentifier') {
              context.sourceCode.markVariableAsUsed(name.name, name);
            }
          },
        };
      },
    },
  },
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'vite-plugins/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, react: reactShim },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Must be enabled for the shim above to mark JSX identifiers as used.
      'react/jsx-uses-vars': 'error',
      // Off: browser app with ambient globals (console, process in scripts);
      // not this gate's concern.
      'no-undef': 'off',
      // Pre-existing debt — surface as warnings, don't fail the gate on legacy code.
      // `caughtErrors: 'none'`: an ignored catch binding is deliberate, and
      // flagging all 29 of them buried the 22 genuinely-dead identifiers.
      'no-unused-vars': ['warn', { caughtErrors: 'none' }],
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
    },
  },
];
