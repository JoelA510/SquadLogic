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
      '**/.features-gen-real-backend/**',
      '**/.real-backend-dist/**',
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
      // Off in the recommended set, and the one rule that catches a button with no name (an
      // icon-only <button> without aria-label). The plugin's own options, plus `td`: an empty
      // table cell (a virtualiser's spacer, a loading skeleton) is not a control.
      'jsx-a11y/control-has-associated-label': [
        'error',
        {
          ...jsxA11y.flatConfigs.recommended.rules['jsx-a11y/control-has-associated-label'][1],
          ignoreElements: [
            ...jsxA11y.flatConfigs.recommended.rules['jsx-a11y/control-has-associated-label'][1]
              .ignoreElements,
            'td',
          ],
          depth: 3,
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  // AGENTS.md §8, E2E rule 2: assert on the DOM, never on the mock's store. A
  // `Then` step that reads `__MOCK_DB__` checks what a step (or the mock)
  // wrote, not what the page shows -- the Pillar 1 scenarios passed for months
  // that way while forging the engines' results (plan M4.6, audit 6.6). Given
  // and When steps may still seed inputs through it. It sees only text inside
  // the `Then(...)` call: a helper defined elsewhere that reads the store, or
  // the key held in a module-level constant, gets past it.
  {
    files: ['tests/e2e/steps/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          "CallExpression[callee.name='Then'] Literal[value=/__MOCK_DB__/]",
          "CallExpression[callee.name='Then'] TemplateElement[value.raw=/__MOCK_DB__/]",
          "CallExpression[callee.name='Then'] Identifier[name='__MOCK_DB__']",
        ].map((selector) => ({
          selector,
          message:
            'A Then step asserts on the page, not on __MOCK_DB__ (AGENTS.md §8, E2E rule 2).',
        })),
      ],
    },
  },
  eslintConfigPrettier
);
