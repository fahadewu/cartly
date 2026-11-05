import { describe, expect, it } from 'vitest';
import { fitSummary, fitVerdict, MIN_SIGNALS } from './fit.js';

describe('fitVerdict', () => {
  it('stays quiet until enough shoppers have said', () => {
    expect(fitVerdict(null)).toBeNull();
    expect(fitVerdict({ small: 2 })).toBeNull();
    expect(MIN_SIGNALS).toBe(3);
  });

  it('calls "runs small" on a clear majority, counting size returns as votes', () => {
    expect(fitVerdict({ small: 2, true: 1 })).toBe('small');
    expect(fitVerdict({ small: 1, returnsSmall: 1, true: 1 })).toBe('small');
    expect(fitVerdict({ large: 3, true: 1, small: 0 })).toBe('large');
  });

  it('needs at least two people for a direction, and more of them than the other way', () => {
    expect(fitVerdict({ small: 1, true: 1, large: 1 })).toBeNull();
    expect(fitVerdict({ small: 2, large: 2, true: 0 })).toBeNull();
  });

  it('calls "true to size" only when most agree', () => {
    expect(fitVerdict({ true: 3 })).toBe('true');
    expect(fitVerdict({ true: 3, small: 1, large: 1 })).toBe('true');
    expect(fitVerdict({ true: 2, small: 1, large: 1 })).toBeNull();
  });
});

describe('fitSummary', () => {
  it('is null when nobody has said anything', () => {
    expect(fitSummary({}, null)).toBeNull();
    expect(fitSummary(null, null)).toBeNull();
  });

  it('merges returns into the counts the storefront shows', () => {
    expect(fitSummary({ small: 1, true: 2, returnsSmall: 2 }, 'small')).toEqual({ verdict: 'small', small: 3, true: 2, large: 0, total: 5, returns: 2 });
  });
});
