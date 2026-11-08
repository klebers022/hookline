import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // Plain Node scripts, which TypeScript does not check for globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // k6 scripts, which run in k6's own JavaScript runtime.
    files: ['load-tests/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __ITER: 'readonly', __VU: 'readonly' },
    },
  },
);
