import { describe, expect, it } from 'vitest';

import { RELAY_VERSION } from '../src/version.js';

describe('relay version', () => {
  it('is a non-empty string', () => {
    expect(typeof RELAY_VERSION).toBe('string');
    expect(RELAY_VERSION.length).toBeGreaterThan(0);
  });
});
