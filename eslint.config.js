import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
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
  // and When steps may still seed inputs through it.
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
