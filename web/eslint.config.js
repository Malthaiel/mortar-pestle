// Minimal ESLint gate. Purpose: catch the React-hooks bug class. NOT a style
// gate — no Prettier, no formatting rules. See plans/008 for rationale.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';

// Source carries a single `eslint-disable react/no-danger` directive
// (RecyclingBinModal.jsx). Define a no-op so ESLint resolves that directive
// without pulling in all of eslint-plugin-react (a style plugin this gate avoids).
const reactShim = { rules: { 'no-danger': { create: () => ({}) } } };

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
      // Off: browser app with ambient globals (console, process in scripts);
      // not this gate's concern.
      'no-undef': 'off',
      // Pre-existing debt — surface as warnings, don't fail the gate on legacy code.
      'no-unused-vars': 'warn',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
    },
  },
];
