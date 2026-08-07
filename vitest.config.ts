import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The generation layer is pure and runs in node. Rendering is verified by
    // scripts/ship-review.mjs against a real GL context, not here — a mocked
    // WebGL context tests the mock.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
  },
});
