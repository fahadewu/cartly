import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { PrismaService, RedisService } from './infra.module.js';
import { DIRTY } from '../journeys/track.js';
import { noteWant } from '../outreach/inbox.js';

export type DemandType = 'view' | 'search' | 'cart_add' | 'favourite' | 'tryon';
export interface Demand {
  type: DemandType;
  userId?: string | null;
  productId?: number | null;
  query?: string | null;
  results?: number | null;
}

/** "  Red  PANJABI " → "red panjabi": one spelling per search, so counts add up. */
export const normalizeQuery = (q: string) => q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);

// The same shopper viewing a product again (or searching the same thing) within this long counts once.
const DEDUPE_SECONDS: Partial<Record<DemandType, number>> = {
  view: 30 * 60,
  search: 10 * 60,
};

/**
 * Records what shoppers look at and want, for the analytics: product views and searches (sent by the
 * storefront), cart adds, favourites and try-ons (recorded here as they happen). Never gets in the way:
 * a failure is logged, not thrown.
 */
@Injectable()
export class DemandService {
  private readonly log = new Logger('Demand');

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async record(events: Demand[]) {
    const rows = [];
    for (const e of events) {
      const query = e.query ? normalizeQuery(e.query) : null;
      if (e.type === 'search' && !query) continue;
      const ttl = DEDUPE_SECONDS[e.type];
      if (ttl && e.userId) {
        const fresh = await this.redis.set(`demand:${e.type}:${e.userId}:${e.productId ?? ''}:${query ?? ''}`, '1', 'EX', ttl, 'NX').catch(() => 'OK');
        if (fresh !== 'OK') continue;
      }
      rows.push({
        type: e.type,
        userId: e.userId ?? null,
        productId: e.productId ?? null,
        query,
        results: e.results ?? null,
      });
    }
    if (!rows.length) return 0;
    try {
      // Only products that exist, so a stale or made-up id can't skew the numbers.
      const ids = [...new Set(rows.map((r) => r.productId).filter((x): x is number => x != null))];
      const found = await this.db.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, stock: true },
      });
      const known = new Map(found.map((p) => [p.id, p]));
      const valid = rows.filter((r) => r.productId == null || known.has(r.productId));
      await this.db.demandEvent.createMany({ data: valid });
      // What they wanted and didn't get, for "we found it" and "back in stock" emails (outreach/).
      for (const r of valid) {
        if (!r.userId) continue;
        if (r.type === 'search' && r.results === 0 && r.query) void noteWant(this.redis, { userId: r.userId, source: 'search', text: r.query });
        const p = r.productId != null ? known.get(r.productId) : undefined;
        if (p && p.stock <= 0 && (r.type === 'view' || r.type === 'favourite' || r.type === 'cart_add')) {
          void noteWant(this.redis, { userId: r.userId, source: 'soldout', text: p.name, productId: p.id });
        }
      }
      // Their taste may have moved: the shopper profile is rebuilt in the background.
      const users = [...new Set(valid.map((r) => r.userId).filter((x): x is string => !!x))];
      if (users.length) await this.redis.sadd(DIRTY, ...users).catch(() => 0);
      return valid.length;
    } catch (e) {
      this.log.warn(`Demand not recorded: ${(e as Error).message}`);
      return 0;
    }
  }

  /** Fire and forget, for hooks inside other requests. */
  note(e: Demand) {
    void this.record([e]);
  }
}

/** Available everywhere, like the database: cart, favourites and try-on all record into it. */
@Global()
@Module({ providers: [DemandService], exports: [DemandService] })
export class DemandModule {}
