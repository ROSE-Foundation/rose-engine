import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { CHAIN_CONFIG_KEYS, ChainConfigRefusalError, loadChainConfig } from './chain-config.js';

// Lower-case (un-checksummed) addresses WITH hex letters (a-f) so EIP-55 checksumming actually
// changes their case — `getAddress(X) !== X`. This makes the normalization assertion meaningful:
// a regression dropping `getAddress(raw)` in the loader would leave the value lower-cased and fail.
const PAIR = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const L = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const S = '0xfeedfacefeedfacefeedfacefeedfacefeedface';
const IDREG = '0xcafebabecafebabecafebabecafebabecafebabe';

/** A fully-populated, valid chain environment. */
function fullEnv(): Record<string, string> {
  return {
    SEPOLIA_RPC_URL: 'https://sepolia.example.test/rpc',
    ROSE_PAIR_ADDRESS: PAIR,
    ROSE_L_TOKEN_ADDRESS: L,
    ROSE_S_TOKEN_ADDRESS: S,
    ROSE_IDENTITY_REGISTRY_ADDRESS: IDREG,
    // Unrelated env vars must be ignored, not cause failure:
    PATH: '/usr/bin',
    NOTE_COUPON: '0.05',
  };
}

describe('loadChainConfig — happy path (AC-1, AC-2 wiring)', () => {
  it('returns a validated, typed config from a complete env, checksumming addresses', () => {
    const cfg = loadChainConfig(fullEnv());
    expect(cfg).toEqual({
      sepoliaRpcUrl: 'https://sepolia.example.test/rpc',
      pairAddress: getAddress(PAIR),
      lTokenAddress: getAddress(L),
      sTokenAddress: getAddress(S),
      identityRegistryAddress: getAddress(IDREG),
    });
  });

  it('normalizes addresses to EIP-55 (stored value differs from the lower-cased input)', () => {
    // Guards against a regression that drops the `getAddress` normalization: the input is lower-
    // cased and the four test addresses contain a-f, so the checksummed form must differ.
    const cfg = loadChainConfig(fullEnv());
    expect(cfg.pairAddress).toBe(getAddress(PAIR));
    expect(cfg.pairAddress).not.toBe(PAIR);
    expect(getAddress(PAIR)).not.toBe(PAIR);
  });

  it('accepts an http RPC URL (local dev / Anvil)', () => {
    const cfg = loadChainConfig({ ...fullEnv(), SEPOLIA_RPC_URL: 'http://127.0.0.1:8545' });
    expect(cfg.sepoliaRpcUrl).toBe('http://127.0.0.1:8545');
  });

  it('returns a frozen object (no mutation of validated config)', () => {
    const cfg = loadChainConfig(fullEnv());
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      (cfg as { sepoliaRpcUrl: string }).sepoliaRpcUrl = 'mutated';
    }).toThrow();
  });
});

describe('loadChainConfig — refuse-if-absent (AC-3, NFR-4)', () => {
  it('refuses an empty env, naming every required key', () => {
    let err: ChainConfigRefusalError | undefined;
    try {
      loadChainConfig({});
    } catch (e) {
      err = e as ChainConfigRefusalError;
    }
    expect(err).toBeInstanceOf(ChainConfigRefusalError);
    expect([...err!.missingOrInvalid].sort()).toEqual([...CHAIN_CONFIG_KEYS].sort());
  });

  it('refuses a non-object env (null), naming every key', () => {
    const err = (() => {
      try {
        loadChainConfig(null as unknown as Record<string, string | undefined>);
        return undefined;
      } catch (e) {
        return e as ChainConfigRefusalError;
      }
    })();
    expect(err).toBeInstanceOf(ChainConfigRefusalError);
    expect([...err!.missingOrInvalid].sort()).toEqual([...CHAIN_CONFIG_KEYS].sort());
  });

  it('refuses when SEPOLIA_RPC_URL is missing, naming exactly that key', () => {
    const env = fullEnv();
    delete env.SEPOLIA_RPC_URL;
    expect(() => loadChainConfig(env)).toThrow(ChainConfigRefusalError);
    try {
      loadChainConfig(env);
    } catch (e) {
      expect((e as ChainConfigRefusalError).missingOrInvalid).toEqual(['SEPOLIA_RPC_URL']);
    }
  });

  it('refuses a non-http(s) RPC URL (no placeholder accepted)', () => {
    const env = { ...fullEnv(), SEPOLIA_RPC_URL: 'ftp://nope' };
    try {
      loadChainConfig(env);
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(ChainConfigRefusalError);
      expect((e as ChainConfigRefusalError).missingOrInvalid).toEqual(['SEPOLIA_RPC_URL']);
    }
  });

  it('refuses an empty-string RPC URL (whitespace-only)', () => {
    const env = { ...fullEnv(), SEPOLIA_RPC_URL: '   ' };
    expect(() => loadChainConfig(env)).toThrow(ChainConfigRefusalError);
  });

  it.each([
    'ROSE_PAIR_ADDRESS',
    'ROSE_L_TOKEN_ADDRESS',
    'ROSE_S_TOKEN_ADDRESS',
    'ROSE_IDENTITY_REGISTRY_ADDRESS',
  ])('refuses when %s is missing, naming exactly that key', (key) => {
    const env = fullEnv();
    delete env[key];
    try {
      loadChainConfig(env);
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(ChainConfigRefusalError);
      expect((e as ChainConfigRefusalError).missingOrInvalid).toEqual([key]);
    }
  });

  it('refuses a malformed address (too short / non-hex), naming that key', () => {
    const env = { ...fullEnv(), ROSE_PAIR_ADDRESS: '0x1234' };
    try {
      loadChainConfig(env);
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(ChainConfigRefusalError);
      expect((e as ChainConfigRefusalError).missingOrInvalid).toEqual(['ROSE_PAIR_ADDRESS']);
    }
  });

  it('refuses the zero address (canonical placeholder), naming that key', () => {
    const env = { ...fullEnv(), ROSE_PAIR_ADDRESS: '0x0000000000000000000000000000000000000000' };
    try {
      loadChainConfig(env);
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(ChainConfigRefusalError);
      expect((e as ChainConfigRefusalError).missingOrInvalid).toEqual(['ROSE_PAIR_ADDRESS']);
    }
  });

  it('names ALL offenders when several are absent at once', () => {
    const env = fullEnv();
    delete env.SEPOLIA_RPC_URL;
    delete env.ROSE_S_TOKEN_ADDRESS;
    try {
      loadChainConfig(env);
      throw new Error('should have refused');
    } catch (e) {
      expect([...(e as ChainConfigRefusalError).missingOrInvalid].sort()).toEqual(
        ['ROSE_S_TOKEN_ADDRESS', 'SEPOLIA_RPC_URL'].sort(),
      );
    }
  });
});
