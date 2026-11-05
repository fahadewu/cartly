import { describe, expect, it } from 'vitest';
import { card } from './loyalty.module.js';

describe('stamp card', () => {
  const s = { enabled: true, target: 10, headStart: 2, percentOff: 10 };
  it('starts every card with the head start stamped', () => {
    expect(card(s, 0)).toEqual({ earned: 0, progress: 0, slots: 12, filled: 2, toGo: 10 });
  });
  it('earns a reward per full card and starts the next one', () => {
    expect(card(s, 9)).toMatchObject({ earned: 0, filled: 11, toGo: 1 });
    expect(card(s, 10)).toMatchObject({ earned: 1, filled: 2, toGo: 10 });
    expect(card(s, 23)).toMatchObject({ earned: 2, progress: 3, filled: 5 });
  });
});
