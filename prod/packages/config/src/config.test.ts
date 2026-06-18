import { describe, expect, it } from 'vitest';
import {
  ConfigRefusalError,
  COVENANT_THRESHOLD_KEYS,
  loadConfig,
  loadCovenantThresholds,
  PARKED_PARAMETER_KEYS,
} from './config.js';

/** A fully-populated, valid environment for the six parked parameters. */
function fullEnv(): Record<string, string> {
  return {
    NOTE_COUPON: '0.05',
    USE_OF_PROCEEDS_SPLIT: '0.70',
    CONVERSION_TO_PARTICIPATION: '0.25',
    BACKING_FLOAT_FLOOR: '1000.00',
    MODEL_FLOOR_M: '2',
    MODEL_FLOOR_G: '0.01',
    // Unrelated env vars must be ignored, not cause failure:
    PATH: '/usr/bin',
    DATABASE_URL: 'postgres://x',
  };
}

describe('loadConfig — happy path (AC-1)', () => {
  it('returns a validated, typed config object from a complete env', () => {
    const cfg = loadConfig(fullEnv());
    expect(cfg).toEqual({
      noteCoupon: '0.05',
      useOfProceedsSplit: '0.70',
      conversionToParticipation: '0.25',
      backingFloatFloor: '1000.00',
      modelFloorM: '2',
      modelFloorG: '0.01',
    });
  });

  it('does not mutate the provided env', () => {
    const env = fullEnv();
    const snapshot = { ...env };
    loadConfig(env);
    expect(env).toEqual(snapshot);
  });
});

describe('loadConfig — refuse-if-absent (AC-2)', () => {
  it.each(PARKED_PARAMETER_KEYS)('refuses by name when %s is missing', (key) => {
    const env = fullEnv();
    delete env[key];
    expect(() => loadConfig(env)).toThrow(ConfigRefusalError);
    expect(() => loadConfig(env)).toThrow(new RegExp(key));
  });

  it('treats an empty-string value as absent (refused, not accepted)', () => {
    const env = fullEnv();
    env.BACKING_FLOAT_FLOOR = '';
    expect(() => loadConfig(env)).toThrow(/BACKING_FLOAT_FLOOR/);
  });

  it('refuses a non-decimal value, naming the key', () => {
    const env = fullEnv();
    env.MODEL_FLOOR_M = 'not-a-number';
    expect(() => loadConfig(env)).toThrow(/MODEL_FLOOR_M/);
  });

  it('NEVER substitutes a default (e.g. 0) for an absent value', () => {
    const env = fullEnv();
    delete env.BACKING_FLOAT_FLOOR;
    let captured: unknown;
    try {
      loadConfig(env);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConfigRefusalError);
    // No object returned, so no chance of a 0 default leaking through.
    expect(() => loadConfig(env)).toThrow();
  });

  it('names ALL offending parked parameters when several are absent', () => {
    const env = fullEnv();
    delete env.NOTE_COUPON;
    delete env.MODEL_FLOOR_G;
    try {
      loadConfig(env);
      throw new Error('expected refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigRefusalError);
      const err = e as ConfigRefusalError;
      expect(err.missingOrInvalid).toContain('NOTE_COUPON');
      expect(err.missingOrInvalid).toContain('MODEL_FLOOR_G');
    }
  });

  it('refuses a non-object env by naming every parked parameter (not "undefined")', () => {
    const badInputs = [null, 42, 'str'];
    for (const bad of badInputs) {
      let err: ConfigRefusalError | undefined;
      try {
        loadConfig(bad as unknown as Record<string, string | undefined>);
      } catch (e) {
        err = e as ConfigRefusalError;
      }
      expect(err).toBeInstanceOf(ConfigRefusalError);
      expect([...err!.missingOrInvalid].sort()).toEqual([...PARKED_PARAMETER_KEYS].sort());
      expect(err!.missingOrInvalid).not.toContain('undefined');
    }
  });
});

describe('value normalization', () => {
  it('trims incidental surrounding whitespace/newlines and returns the trimmed value', () => {
    const env = fullEnv();
    env.NOTE_COUPON = ' 0.05 ';
    env.MODEL_FLOOR_G = '0.01\n';
    const cfg = loadConfig(env);
    expect(cfg.noteCoupon).toBe('0.05');
    expect(cfg.modelFloorG).toBe('0.01');
  });

  it('still refuses whitespace-only values', () => {
    const env = fullEnv();
    env.MODEL_FLOOR_M = '   ';
    expect(() => loadConfig(env)).toThrow(/MODEL_FLOOR_M/);
  });
});

/** A fully-populated, valid environment for the three covenant thresholds. */
function covenantEnv(): Record<string, string> {
  return {
    COVENANT_BACKING_FLOAT_FLOOR: '0.60',
    COVENANT_CLIENT_COLLATERAL_RATIO: '1.00',
    COVENANT_DEPLOY_CEILING: '0.35',
    PATH: '/usr/bin',
  };
}

describe('loadCovenantThresholds', () => {
  it('returns the three validated thresholds from a complete env', () => {
    expect(loadCovenantThresholds(covenantEnv())).toEqual({
      backingFloatFloor: '0.60',
      clientCollateralRatio: '1.00',
      deployCeiling: '0.35',
    });
  });

  it.each(COVENANT_THRESHOLD_KEYS)('refuses by name when %s is missing', (key) => {
    const env = covenantEnv();
    delete env[key];
    expect(() => loadCovenantThresholds(env)).toThrow(ConfigRefusalError);
    expect(() => loadCovenantThresholds(env)).toThrow(new RegExp(key));
  });

  it('refuses a non-decimal threshold, naming the key', () => {
    const env = covenantEnv();
    env.COVENANT_DEPLOY_CEILING = 'thirty-five-percent';
    expect(() => loadCovenantThresholds(env)).toThrow(/COVENANT_DEPLOY_CEILING/);
  });

  it('never substitutes a default for an absent threshold', () => {
    const env = covenantEnv();
    delete env.COVENANT_BACKING_FLOAT_FLOOR;
    expect(() => loadCovenantThresholds(env)).toThrow(ConfigRefusalError);
  });

  it('refuses a negative threshold, naming the key (would otherwise 500 the group-view response)', () => {
    const env = covenantEnv();
    env.COVENANT_DEPLOY_CEILING = '-0.10';
    expect(() => loadCovenantThresholds(env)).toThrow(/COVENANT_DEPLOY_CEILING/);
  });

  it('refuses a threshold > 1 (e.g. 60 meaning 6000%, the silent-false-PASS footgun)', () => {
    const env = covenantEnv();
    env.COVENANT_DEPLOY_CEILING = '60';
    expect(() => loadCovenantThresholds(env)).toThrow(/COVENANT_DEPLOY_CEILING/);
  });
});
