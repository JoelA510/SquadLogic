import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.features-gen/**',
      '**/.features-gen-local/**',
      '**/.features-gen-backup/**',
      '**/trace/**',
      '**/.claude/**',
      '**/.gemini/**',
      '**/.github/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      prettier,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'prettier/prettier': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  // Accessibility (plan item M4.2): the recommended set on the app's own JSX. Tests render
  // fixtures, not UI, so they are left out. Waive a genuine false positive on its line, with the
  // reason beside it; never turn a rule off here to get green.
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ['frontend/src/**/*.{js,jsx}'],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // `Toggle` renders a `<button role="switch">`, which a wrapping <label> names; and a radio
      // label's text can sit three elements deep (HeatSafetyModule).
      'jsx-a11y/label-has-associated-control': [
        'error',
        { controlComponents: ['Toggle'], depth: 3 },
      ],
    },
  },
  {
    // A follow-up, not a waiver: the "Select Team" <label> above the game page's team buttons
    // labels nothing (it wants a group named by aria-labelledby). M4.3 has this file open in a
    // parallel PR, so the fix is recorded in the plan's "Discovered during execution" for after
    // that lands. Delete this block with the fix.
    files: ['frontend/src/pages/GameSchedulingPage.jsx'],
    rules: { 'jsx-a11y/label-has-associated-control': 'off' },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  eslintConfigPrettier
);
