import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { CatalogCache } from '../common/cache.js';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { type ChatHint, type Interaction, type Taste, type TasteProduct, buildTaste, PERSONALITIES, recommend, tasteReason } from './taste.js';
import { DIRTY } from './track.js';

/*
 * Shopper profiles are rebuilt in the background, never during a request: whatever a shopper does marks
 * them "dirty" (a Redis set), and every REBUILD_MS each API instance takes up to REBUILD_BATCH of them.
 * The result goes to the database (for the admin panel) and to Redis, where Pip and the "Picked for you"
 * shelf read it in one lookup:
 *   profile:<userId>  summary for Pip     reco:<userId>  ranked product ids + the reason line
 * Pip adds what it hears in chat to profile:hints:<userId> (see backend/ai/app/brain/claude.py).
 */
const REBUILD_MS = 20_000;
const REBUILD_BATCH = 50;
const WINDOW_DAYS = 90;
const CACHE_SECONDS = 30 * 86400;
export const RECO_LIMIT = 12;

export interface Recommendations {
  ids: number[];
  reason: string;
  personalised: boolean;
}

@Injectable()
export class ProfileService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('Profiles');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly cache: CatalogCache,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.rebuildDirty().catch((e) => this.log.warn(`Rebuild failed: ${(e as Error).message}`)), REBUILD_MS);
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async rebuildDirty() {
    const ids = ((await this.redis.spop(DIRTY, REBUILD_BATCH)) ?? []) as string[];
    for (const id of ids) await this.rebuild(id).catch((e) => this.log.warn(`Profile ${id}: ${(e as Error).message}`));
    return ids.length;
  }

  /** Active products in the shape the taste model needs; shared with catalog reads' cache. */
  products(): Promise<(TasteProduct & { name: string; sizes: string[]; createdAt: Date })[]> {
    return this.cache.get('taste:products', 60_000, async () =>
      (
        await this.db.product.findMany({
          where: { active: true },
          select: {
            id: true, name: true, categorySlug: true, type: true, gender: true, price: true, compareAt: true, isNew: true, popularity: true,
            stock: true, styleTags: true, occasions: true, colors: true, sizes: true, createdAt: true,
          },
        })
      ).map((p) => ({ ...p, colors: p.colors as { name: string; hex: string }[], price: Number(p.price), compareAt: p.compareAt == null ? null : Number(p.compareAt) })),
    );
  }

  async rebuild(userId: string): Promise<Taste | null> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { personalise: true } });
    if (!user) return null;
    if (!user.personalise) {
      await this.forget(userId);
      return null;
    }
    const since = new Date(Date.now() - WINDOW_DAYS * 864e5);
    const [events, bought, routes, productSeconds, hintsRaw, products, told] = await Promise.all([
      this.db.demandEvent.findMany({
        where: { userId, productId: { not: null }, createdAt: { gte: since } },
        select: { type: true, productId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 3000,
      }),
      this.db.$queryRaw<{ productId: number; at: Date }[]>`
        SELECT i."productId", o."createdAt" AS at FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
        WHERE o."userId" = ${userId} AND o.status NOT IN ('CANCELLED', 'PENDING_PAYMENT') AND o."createdAt" >= ${new Date(Date.now() - 365 * 864e5)}`,
      this.db.$queryRaw<{ route: string; path: string; n: number }[]>`
        SELECT p.route, CASE WHEN p.path = '/collection/offers' THEN p.path ELSE '' END AS path, count(*)::int AS n
        FROM "PageView" p JOIN "Visit" v ON v.id = p."visitId"
        WHERE v."userId" = ${userId} AND p."enteredAt" >= ${since} GROUP BY 1, 2`,
      this.db.$queryRaw<{ s: number | null }[]>`
        SELECT avg(p."activeMs") / 1000.0 AS s FROM "PageView" p JOIN "Visit" v ON v.id = p."visitId"
        WHERE v."userId" = ${userId} AND p.route = 'product' AND p."enteredAt" >= ${since} AND p."activeMs" > 0`,
      this.redis.lrange(`profile:hints:${userId}`, 0, 49).catch(() => [] as string[]),
      this.products(),
      this.db.shopperPreferences.findUnique({ where: { userId }, select: { styles: true } }),
    ]);

    const interactions: Interaction[] = [
      ...events.map((e) => ({ type: e.type as Interaction['type'], productId: e.productId!, at: e.createdAt })),
      ...bought.map((b) => ({ type: 'purchase' as const, productId: b.productId, at: b.at })),
    ];
    const routeViews: Record<string, number> = {};
    let offersViews = 0;
    for (const r of routes) {
      routeViews[r.route] = (routeViews[r.route] ?? 0) + r.n;
      if (r.path) offersViews += r.n;
    }
    const hints = hintsRaw.flatMap((h) => {
      try {
        return [JSON.parse(h) as ChatHint];
      } catch {
        return [];
      }
    });
    // Styles picked in the style quiz weigh like something they said to Pip, one hint per style.
    const declared = (told?.styles ?? []).filter((k) => PERSONALITIES[k]);
    for (const k of declared) hints.push({ styles: PERSONALITIES[k].tags });
    const byId = new Map(products.map((p) => [p.id, p]));
    const taste = buildTaste(byId, interactions, { routeViews, offersViews, productPageSeconds: productSeconds[0]?.s == null ? null : Number(productSeconds[0].s) }, hints);

    const data = {
      personality: taste.personality,
      styles: taste.styles,
      tags: taste.tags,
      categories: taste.categories,
      genders: taste.genders,
      colors: taste.colors,
      priceRatio: taste.priceRatio,
      priceBand: taste.priceBand,
      traits: taste.traits,
      ageGroup: taste.ageGroup,
      ageConfidence: taste.ageConfidence,
      evidence: taste.evidence,
    };
    await this.db.shopperProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });

    const boughtIds = new Set(bought.map((b) => b.productId));
    const recent = new Set(events.filter((e) => e.createdAt.getTime() > Date.now() - 2 * 864e5).map((e) => e.productId!));
    const reco: Recommendations = {
      ids: recommend(taste, products, { bought: boughtIds, recent, limit: RECO_LIMIT }).map((p) => p.id),
      reason: taste.evidence > 0 || declared.length ? tasteReason(taste, declared) : 'Popular right now',
      personalised: taste.evidence > 0 || declared.length > 0,
    };
    await this.redis
      .multi()
      .set(`profile:${userId}`, JSON.stringify(summary(taste)), 'EX', CACHE_SECONDS)
      .set(`reco:${userId}`, JSON.stringify(reco), 'EX', CACHE_SECONDS)
      .exec();
    return taste;
  }

  /** The shopper turned personalisation off, or their account is going: the profile goes with it. */
  async forget(userId: string) {
    await this.db.shopperProfile.deleteMany({ where: { userId } });
    // What they looked for and didn't find is learned from behaviour too.
    await this.db.shopperWant.deleteMany({ where: { userId } });
    await this.redis.del(`profile:${userId}`, `reco:${userId}`, `profile:hints:${userId}`);
  }

  /** "Picked for you": from Redis when the profile has been built, otherwise built now (it's quick). */
  async recommendations(userId: string | null, limit = RECO_LIMIT): Promise<Recommendations> {
    if (userId) {
      const hit = await this.redis.get(`reco:${userId}`).catch(() => null);
      if (hit) {
        const r = JSON.parse(hit) as Recommendations;
        return { ...r, ids: r.ids.slice(0, limit) };
      }
      const user = await this.db.user.findUnique({ where: { id: userId }, select: { personalise: true } });
      if (user?.personalise) {
        await this.rebuild(userId);
        const built = await this.redis.get(`reco:${userId}`).catch(() => null);
        if (built) {
          const r = JSON.parse(built) as Recommendations;
          return { ...r, ids: r.ids.slice(0, limit) };
        }
      }
    }
    return { ids: recommend(null, await this.products(), { limit }).map((p) => p.id), reason: 'Popular right now', personalised: false };
  }
}

/** What Pip is told: short, readable, and clearly marked as a guess. */
export function summary(t: Taste) {
  return {
    personality: t.personality ? PERSONALITIES[t.personality].label : null,
    styles: Object.keys(t.styles).slice(0, 3).map((k) => PERSONALITIES[k]?.label ?? k),
    tags: Object.keys(t.tags).slice(0, 6),
    categories: Object.keys(t.categories).slice(0, 3),
    priceBand: t.priceBand,
    traits: t.traits,
    ageGroup: t.ageGroup && (t.ageConfidence ?? 0) >= 0.4 ? t.ageGroup : null,
    evidence: t.evidence,
  };
}
