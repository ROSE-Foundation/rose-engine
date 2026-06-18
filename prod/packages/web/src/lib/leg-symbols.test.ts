import { describe, expect, it } from 'vitest';
import { legTokenSymbols } from './leg-symbols.js';

describe('legTokenSymbols', () => {
  it('derives r<ASSET>-L / r<ASSET>-S, stripping separators', () => {
    expect(legTokenSymbols('EUR/USD')).toEqual({ long: 'rEURUSD-L', short: 'rEURUSD-S' });
    expect(legTokenSymbols('BTC')).toEqual({ long: 'rBTC-L', short: 'rBTC-S' });
    expect(legTokenSymbols('10Y USD')).toEqual({ long: 'r10YUSD-L', short: 'r10YUSD-S' });
  });

  it('upper-cases the asset so a lowercase reference yields the canonical form', () => {
    expect(legTokenSymbols('btc')).toEqual({ long: 'rBTC-L', short: 'rBTC-S' });
    expect(legTokenSymbols('eth/usd')).toEqual({ long: 'rETHUSD-L', short: 'rETHUSD-S' });
  });
});
