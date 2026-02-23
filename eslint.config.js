import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      'no-console': 'off',
      'no-empty': 'warn',
      'no-useless-catch': 'warn',
      'no-case-declarations': 'warn',
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
  // CommonJS files (.cjs) — Node.js globals, allow require
  {
    files: ['**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  // ESM scripts (.mjs) — Node.js globals
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // Test files — relax some rules
  {
    files: ['**/*.test.ts', '**/*.test.mts', '**/*.spec.ts'],
    rules: {
      'no-useless-assignment': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  }
);
