// The public surface of @rose/api re-exports resolve (Story 6.1).
import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('@rose/api public surface', () => {
  it('exports the app factory, error contract, serializers, and schemas', () => {
    expect(typeof api.buildApp).toBe('function');
    expect(typeof api.installErrorHandling).toBe('function');
    expect(typeof api.mapErrorToResponse).toBe('function');
    expect(typeof api.ApiError).toBe('function');
    expect(typeof api.NotFoundError).toBe('function');
    expect(typeof api.serializeCoupledPair).toBe('function');
    expect(typeof api.serializeRoseNote).toBe('function');
    // A representative Zod schema is present and parses.
    expect(api.HealthSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(api.MoneySchema).toBeDefined();
    expect(api.GroupViewSchema).toBeDefined();
  });
});
