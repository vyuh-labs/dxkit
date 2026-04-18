import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'templates/**',
      'src-templates/**',
      'node_modules/**',
      'coverage/**',
      'test/fixtures/**',
      // tmp/ holds gitignored ephemeral scripts (regression harness,
      // one-off migration scripts). Not part of the shipped code.
      'tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // Node CommonJS build scripts
    files: ['scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // TS source files run on Node — give them Node globals (process, console, etc.)
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
