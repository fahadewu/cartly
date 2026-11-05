import { describe, expect, it } from 'vitest';
import { maxDays, orderBy } from './festivals.module.js';

describe('festival order-by dates', () => {
  it('reads the longest promise from a delivery estimate', () => {
    expect(maxDays('3–5 business days')).toBe(5);
    expect(maxDays('1–2 business days')).toBe(2);
    expect(maxDays('next day')).toBe(0);
  });

  it('counts back from the eve in working days, skipping Fridays', () => {
    // Eid on Fri 20 Mar 2026: arrive by Thu 19th. Express (2 days) + 1 to pack = 3 working days back, no Fridays
    // in between: Wed 18, Tue 17, Mon 16.
    expect(orderBy('2026-03-20', 2, '2026-03-01')).toBe('2026-03-16');
    // Standard (5 days) + 1: Wed 18, Tue 17, Mon 16, Sun 15, Sat 14, (Fri 13 skipped) Thu 12.
    expect(orderBy('2026-03-20', 5, '2026-03-01')).toBe('2026-03-12');
  });

  it('says so when it is too late', () => {
    expect(orderBy('2026-03-20', 5, '2026-03-13')).toBeNull();
    expect(orderBy('2026-03-20', 5, '2026-03-12')).toBe('2026-03-12');
  });
});
