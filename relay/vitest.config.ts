import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'relay',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
