import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'relay', 'web', 'test/gates/bridge'],
  },
});
