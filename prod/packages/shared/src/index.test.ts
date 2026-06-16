import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE_NAME } from './index.js';

describe('@rose/shared seed', () => {
  it('exposes the package name', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@rose/shared');
  });
});
