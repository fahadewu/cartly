import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/infra.module.js';
import { rangeOf } from '../analytics/analytics.service.js';
import { PERSONALITIES } from './taste.js';

/*
 * How journeys are counted (the admin panel shows the same notes):
 * - A visit is one device's browsing until it's idle for 30 minutes. A visitor is one device (a random id it
 *   keeps), so the same person on a phone and a laptop counts twice until they sign in.
 * - Time on a page is the time it was actually on screen: a hidden tab or a locked phone doesn't count.
 * - A bounce is a visit that saw one page. The exit page is the last page of a visit.
 * - A visit converted when its signed-in shopper placed an order during it or within 30 minutes after.
 * - Locations are approximate (city from the CDN or GeoIP; otherwise just the country, from the device's
 *   time zone). Personalities and age groups are assumptions from behaviour, never facts.
 * - Tracking started when this was released, and visitors who send Do Not Track / Global Privacy Control
 *   aren't tracked at all, so totals undercount real traffic a little.
 */
const CONVERTED = `EXISTS (SELECT 1 FROM "Order" o WHERE o."userId" = v."userId" AND o.status NOT IN ('CANCELLED')
  AND o."createdAt" BETWEEN v."startedAt" AND v."lastSeenAt" + interval '30 minutes')`;
const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

type Count = { key: string | null; n: number };

@Injectable()
export class JourneyAnalytics {
  constructor(private readonly db: PrismaService) {}

  /** `identities`: whether the caller may see who the signed-in visitors are (customers.read). */
  async visitors(days: number, identities = false) {
    const r = rangeOf(days);
    const q = <T>(sql: string, ...params: unknown[]) => this.db.$queryRawUnsafe<T[]>(sql, r.from, r.to, ...params);
    const inRange = `v."startedAt" >= $1 AND v."startedAt" <= $2`;
    const top = (col: string, limit = 10) =>
      q<Count>(`SELECT ${col} AS key, count(*)::int AS n FROM "Visit" v WHERE ${inRange} GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`);

    const [totals, prev, daily, sources, referrers, landings, exits, pages, flows, devices, browsers, countries, cities, people, recent] = await Promise.all([
      q<{ visits: number; visitors: number; signed: number; bounces: number; ms: number; pages: number; converted: number }>(`
        SELECT count(*)::int AS visits, count(DISTINCT v."visitorId")::int AS visitors,
          count(*) FILTER (WHERE v."userId" IS NOT NULL)::int AS signed, count(*) FILTER (WHERE v."pageCount" <= 1)::int AS bounces,
          coalesce(avg(v."activeMs"), 0)::float AS ms, coalesce(avg(v."pageCount"), 0)::float AS pages,
          count(*) FILTER (WHERE ${CONVERTED})::int AS converted
        FROM "Visit" v WHERE ${inRange}`),
      this.db.$queryRawUnsafe<{ visits: number }[]>(`SELECT count(*)::int AS visits FROM "Visit" v WHERE v."startedAt" >= $1 AND v."startedAt" < $2`, r.prevFrom, r.from),
      q<{ day: string; visits: number; visitors: number }>(`
        SELECT to_char(v."startedAt" + make_interval(mins => $3::int), 'YYYY-MM-DD') AS day, count(*)::int AS visits,
          count(DISTINCT v."visitorId")::int AS visitors
        FROM "Visit" v WHERE ${inRange} GROUP BY 1 ORDER BY 1`, r.offset),
      q<{ key: string; n: number; converted: number; ms: number }>(`
        SELECT v.source AS key, count(*)::int AS n, count(*) FILTER (WHERE ${CONVERTED})::int AS converted, avg(v."activeMs")::float AS ms
        FROM "Visit" v WHERE ${inRange} GROUP BY 1 ORDER BY 2 DESC`),
      top('v.referrer'),
      q<{ key: string; n: number; bounces: number }>(`
        SELECT v.landing AS key, count(*)::int AS n, count(*) FILTER (WHERE v."pageCount" <= 1)::int AS bounces
        FROM "Visit" v WHERE ${inRange} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      // Exit rate: of all the times a page was seen, how often it was the last page of the visit.
      q<{ key: string; n: number; views: number }>(`
        WITH e AS (SELECT v."exitPath" AS key, count(*)::int AS n FROM "Visit" v WHERE ${inRange} AND v."exitPath" IS NOT NULL GROUP BY 1)
        SELECT e.key, e.n, (SELECT count(*)::int FROM "PageView" p JOIN "Visit" v ON v.id = p."visitId" WHERE ${inRange} AND p.path = e.key) AS views
        FROM e ORDER BY e.n DESC LIMIT 10`),
      q<{ route: string; views: number; avg: number; median: number; scroll: number | null }>(`
        SELECT p.route, count(*)::int AS views, avg(p."activeMs")::float / 1000 AS avg,
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY p."activeMs"))::float / 1000 AS median, avg(p."scrollPct")::float AS scroll
        FROM "PageView" p JOIN "Visit" v ON v.id = p."visitId" WHERE ${inRange} GROUP BY 1 ORDER BY 2 DESC`),
      // The most common next step from each kind of page, plus where visits end.
      q<{ from: string; to: string | null; n: number }>(`
        SELECT a.route AS "from", coalesce(b.route, '(left)') AS "to", count(*)::int AS n
        FROM "PageView" a JOIN "Visit" v ON v.id = a."visitId"
        LEFT JOIN "PageView" b ON b."visitId" = a."visitId" AND b.seq = a.seq + 1
        WHERE ${inRange} AND (b.route IS NULL OR b.route <> a.route OR b.path <> a.path)
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`),
      top('v.device'),
      top('v.browser'),
      top('v.country', 15),
      top(`concat_ws(', ', v.city, v.country)`, 15),
      // Personalities and assumed age groups of the signed-in shoppers who visited.
      q<{ personality: string | null; age: string | null; band: string | null; n: number }>(`
        SELECT s.personality, CASE WHEN s."ageConfidence" >= 0.4 THEN s."ageGroup" END AS age, s."priceBand" AS band, count(DISTINCT s."userId")::int AS n
        FROM "ShopperProfile" s WHERE s."userId" IN (SELECT DISTINCT v."userId" FROM "Visit" v WHERE ${inRange} AND v."userId" IS NOT NULL)
        GROUP BY 1, 2, 3`),
      q<Record<string, unknown>>(`
        SELECT v.id, v."startedAt", v."lastSeenAt", v.landing, v."exitPath", v.source, v.referrer, v.device, v.browser, v.os,
          v.country, v.region, v.city, v."pageCount", v."activeMs", v."userId", u.name, u.email, ${CONVERTED} AS converted
        FROM "Visit" v LEFT JOIN "User" u ON u.id = v."userId" WHERE ${inRange} ORDER BY v."startedAt" DESC LIMIT 50`),
    ]);

    const t = totals[0];
    const tally = (key: 'personality' | 'age' | 'band') => {
      const m = new Map<string, number>();
      for (const p of people) m.set(p[key] ?? 'unknown', (m.get(p[key] ?? 'unknown') ?? 0) + p.n);
      return [...m].map(([k, n]) => ({ key: k, label: key === 'personality' ? (PERSONALITIES[k]?.label ?? 'Still learning') : k, n })).sort((a, b) => b.n - a.n);
    };
    return {
      range: { days, from: r.from, to: r.to, tz: r.tz },
      totals: {
        visits: t.visits,
        visitors: t.visitors,
        visitsChange: prev[0].visits ? round1(((t.visits - prev[0].visits) / prev[0].visits) * 100) : null,
        signedInRate: pct(t.signed, t.visits),
        bounceRate: pct(t.bounces, t.visits),
        avgVisitSeconds: Math.round(t.ms / 1000),
        pagesPerVisit: round1(t.pages),
        conversionRate: pct(t.converted, t.visits),
        lowSample: t.visits < 30,
      },
      daily,
      sources: sources.map((s) => ({ ...s, conversionRate: pct(s.converted, s.n), avgSeconds: Math.round((s.ms ?? 0) / 1000) })),
      referrers,
      landings: landings.map((l) => ({ ...l, bounceRate: pct(l.bounces, l.n) })),
      exits: exits.map((e) => ({ ...e, exitRate: pct(e.n, e.views) })),
      pages: pages.map((p) => ({ ...p, avg: round1(p.avg), median: round1(p.median), scroll: p.scroll == null ? null : Math.round(p.scroll) })),
      flows,
      devices,
      browsers,
      countries,
      cities: cities.filter((c) => c.key),
      personalities: tally('personality'),
      ageGroups: tally('age'),
      priceBands: tally('band'),
      recent: identities ? recent : recent.map((r) => ({ ...r, name: r.userId ? 'A shopper' : null, email: null })),
    };
  }

  /** One visit, step by step: pages with time on each, what the shopper did on them, and any order placed. */
  async visit(id: string) {
    const v = await this.db.visit.findUnique({
      where: { id },
      include: { pages: { orderBy: { seq: 'asc' } }, user: { select: { id: true, name: true, email: true } } },
    });
    if (!v) throw new NotFoundException('Visit not found');
    const until = new Date(v.lastSeenAt.getTime() + 60_000);
    const [events, orders] = v.userId
      ? await Promise.all([
          this.db.demandEvent.findMany({
            where: { userId: v.userId, createdAt: { gte: v.startedAt, lte: until } },
            select: { type: true, productId: true, query: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          }),
          this.db.order.findMany({
            where: { userId: v.userId, createdAt: { gte: v.startedAt, lte: new Date(v.lastSeenAt.getTime() + 30 * 60_000) } },
            select: { id: true, total: true, status: true, createdAt: true },
          }),
        ])
      : [[], []];
    const names = new Map(
      (await this.db.product.findMany({ where: { id: { in: [...new Set(events.map((e) => e.productId).filter((x): x is number => x != null))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
    );
    const timeline = [
      ...v.pages.map((p) => ({ kind: 'page' as const, at: p.enteredAt, path: p.path, route: p.route, seconds: Math.round(p.activeMs / 1000), scroll: p.scrollPct })),
      ...events.map((e) => ({ kind: e.type, at: e.createdAt, productId: e.productId, product: e.productId ? names.get(e.productId) : null, query: e.query })),
      ...orders.map((o) => ({ kind: 'order' as const, at: o.createdAt, orderId: o.id, total: Number(o.total), status: o.status })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    const { pages: _pages, ...visit } = v;
    return { visit, timeline, exitPath: v.exitPath };
  }

  /** Everything the store assumes about one customer, for the customer page. */
  async shopper(userId: string) {
    const [profile, visits, stats] = await Promise.all([
      this.db.shopperProfile.findUnique({ where: { userId } }),
      this.db.visit.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        take: 10,
        select: { id: true, startedAt: true, landing: true, exitPath: true, pageCount: true, activeMs: true, source: true, city: true, country: true, device: true },
      }),
      this.db.$queryRaw<{ visits: number; ms: number; places: string[] }[]>`
        SELECT count(*)::int AS visits, coalesce(sum("activeMs"), 0)::float AS ms,
          coalesce(array_agg(DISTINCT concat_ws(', ', city, country)) FILTER (WHERE country IS NOT NULL), '{}') AS places
        FROM "Visit" WHERE "userId" = ${userId}`,
    ]);
    return {
      profile: profile && { ...profile, personalityLabel: profile.personality ? PERSONALITIES[profile.personality]?.label : null },
      visits,
      totals: { visits: stats[0].visits, minutes: Math.round(stats[0].ms / 60000), places: stats[0].places },
    };
  }
}
