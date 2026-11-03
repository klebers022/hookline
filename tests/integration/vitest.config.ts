import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript source, as in development.
// The rest are Vite's default server conditions, which a custom list replaces.
const conditions = [
  '@hookline/source',
  'module',
  'node',
  'development|production',
];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
