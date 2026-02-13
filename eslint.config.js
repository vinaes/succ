import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

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
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.js', '*.cjs'],
  }
);
