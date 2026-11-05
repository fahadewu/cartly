/*
 * The shopper's festivals (Eid, Durga Puja, Pohela Boishakh…) with honest "order by" dates: the last day to
 * order for delivery the day before the festival starts, from the store's own posted delivery times. A real
 * deadline, unlike a countdown timer, which shows no effect on sign-ups in a large experiment (Luguri &
 * Strahilevitz 2021) and reads as manipulation.
 *
 * The festival calendar lives in the AI service (app/culture.py, which Pip uses too). Without it the list is
 * simply empty: nothing on the storefront depends on it.
 */
import { Controller, Get, Header, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { callAi } from '../common/ai.js';
import { pricing } from '../config.js';

export class FestivalQuery {
  @IsOptional() @IsString() @MaxLength(64) @Matches(/^[A-Za-z0-9_+\-/]+$/) tz?: string;
  @IsOptional() @IsString() @MaxLength(35) @Matches(/^[A-Za-z0-9-]+$/) locale?: string;
}

interface Moment {
  name: string;
  start: string;
  end: string;
  daysAway: number;
  angle: string;
}

/** Courier weekend in Bangladesh: Friday. Deliveries and dispatch skip it. */
const WEEKEND = new Set([5]);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const back = (d: Date, n: number) => new Date(d.getTime() - n * 864e5);

/** The longest a delivery option promises, in working days: "3–5 business days" → 5. */
export const maxDays = (eta: string) => Math.max(0, ...(eta.match(/\d+/g) ?? []).map(Number));

/**
 * The last day to order so it arrives the day before `start` (YYYY-MM-DD), or null when that day has passed:
 * the posted maximum in working days, plus one working day to pack it, counted back without Fridays.
 */
export function orderBy(start: string, etaDays: number, today: string): string | null {
  let d = back(day(start), 1); // arrive by the eve: outfits are wanted before the day, not on it
  for (let left = etaDays + 1; left > 0; ) {
    d = back(d, 1);
    if (!WEEKEND.has(d.getUTCDay())) left--;
  }
  while (WEEKEND.has(d.getUTCDay())) d = back(d, 1);
  return iso(d) >= today ? iso(d) : null;
}

@Injectable()
export class FestivalsService {
  private cache = new Map<string, { at: number; value: unknown }>();

  async upcoming(q: FestivalQuery) {
    const key = `${q.tz ?? ''}|${q.locale ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
    const params = new URLSearchParams({ ...(q.tz ? { tz: q.tz } : {}), ...(q.locale ? { locale: q.locale } : {}), days: '75' });
    const res = await callAi<{ country: string | null; today: string; moments: Moment[] }>(`/culture/moments?${params}`, { timeoutMs: 2500 }).catch(() => null);
    if (!res) return { country: null, moments: [] }; // not cached: try again next time
    const options = Object.entries(pricing.shipping).map(([id, o]) => ({ id, label: o.label, days: maxDays(o.eta) }));
    const value = {
      country: res.country,
      today: res.today,
      moments: res.moments.map((m) => ({
        ...m,
        /** Last day to order, per delivery option, to have it the day before; null once it's too late. */
        orderBy: Object.fromEntries(options.map((o) => [o.id, orderBy(m.start, o.days, res.today)])),
      })),
    };
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

@ApiTags('catalog')
@Controller('festivals')
export class FestivalsController {
  constructor(private readonly festivals: FestivalsService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=600')
  upcoming(@Query() q: FestivalQuery) {
    return this.festivals.upcoming(q);
  }
}

@Module({ controllers: [FestivalsController], providers: [FestivalsService] })
export class FestivalsModule {}
