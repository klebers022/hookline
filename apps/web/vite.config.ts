import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The dashboard calls the API on its own origin, so the API needs no CORS.
// In development Vite forwards /v1 to the API; in the container nginx does.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/v1': process.env.API_URL ?? 'http://127.0.0.1:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
