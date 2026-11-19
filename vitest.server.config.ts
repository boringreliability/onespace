import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    // Every file gets its own schema, but they share one database; run files
    // one at a time so a failing file cannot disturb another.
    fileParallelism: false,
    reporters: ['default'],
  },
});
