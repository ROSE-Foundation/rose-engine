// THROWAWAY (Story 7.1, AC #4) — model floor parameters are fail-closed (refuse-if-absent).
import { describe, expect, it } from 'vitest';
import { FloorParamRefusalError, loadFloorParams } from './floor-params.js';

describe('loadFloorParams (refuse-if-absent — NFR-4, §11.2)', () => {
  it('returns m and g when both are present', () => {
    const fp = loadFloorParams({ MODEL_FLOOR_M: '2', MODEL_FLOOR_G: '0.05' });
    expect(fp).toEqual({ m: '2', g: '0.05' });
  });

  it('refuses (never defaults) when m is absent, naming the offender', () => {
    try {
      loadFloorParams({ MODEL_FLOOR_G: '0.05' });
      expect.unreachable('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(FloorParamRefusalError);
      expect((err as FloorParamRefusalError).missingOrInvalid).toEqual(['MODEL_FLOOR_M']);
    }
  });

  it('refuses when g is absent', () => {
    expect(() => loadFloorParams({ MODEL_FLOOR_M: '2' })).toThrow(FloorParamRefusalError);
  });

  it('refuses naming BOTH offenders when both are absent', () => {
    try {
      loadFloorParams({});
      expect.unreachable('should have refused');
    } catch (err) {
      expect((err as FloorParamRefusalError).missingOrInvalid).toEqual([
        'MODEL_FLOOR_M',
        'MODEL_FLOOR_G',
      ]);
    }
  });

  it('refuses on invalid (non-decimal / empty) values rather than coercing', () => {
    expect(() => loadFloorParams({ MODEL_FLOOR_M: 'abc', MODEL_FLOOR_G: '0.05' })).toThrow(
      FloorParamRefusalError,
    );
    expect(() => loadFloorParams({ MODEL_FLOOR_M: '', MODEL_FLOOR_G: '0.05' })).toThrow(
      FloorParamRefusalError,
    );
  });

  it('refuses non-positive m or g (a zero/negative margin or gap would mask the model risk)', () => {
    // Review patch: m and g must be strictly positive.
    expect(() => loadFloorParams({ MODEL_FLOOR_M: '0', MODEL_FLOOR_G: '0.05' })).toThrow(
      FloorParamRefusalError,
    );
    expect(() => loadFloorParams({ MODEL_FLOOR_M: '-1', MODEL_FLOOR_G: '0.05' })).toThrow(
      FloorParamRefusalError,
    );
    expect(() => loadFloorParams({ MODEL_FLOOR_M: '1', MODEL_FLOOR_G: '0.0' })).toThrow(
      FloorParamRefusalError,
    );
    try {
      loadFloorParams({ MODEL_FLOOR_M: '0', MODEL_FLOOR_G: '-0.0' });
      expect.unreachable('should have refused');
    } catch (err) {
      expect((err as FloorParamRefusalError).missingOrInvalid).toEqual([
        'MODEL_FLOOR_M',
        'MODEL_FLOOR_G',
      ]);
    }
  });

  it('never substitutes a default for an absent value — it refuses instead of returning', () => {
    let captured: FloorParamRefusalError | undefined;
    let returned: unknown;
    try {
      returned = loadFloorParams({ MODEL_FLOOR_M: '1' });
    } catch (err) {
      captured = err as FloorParamRefusalError;
    }
    expect(returned).toBeUndefined(); // no permissive { g: '0' } default was produced
    expect(captured?.missingOrInvalid).toEqual(['MODEL_FLOOR_G']);
  });
});
