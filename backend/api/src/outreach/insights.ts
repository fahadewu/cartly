// What the admin panel charts: one shopper's likeness (Customers → a shopper → What they like) and the
// store-wide view of interests, unmet wants and outreach results (Analytics → Interests & emails).
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/infra.module.js';
import { env } from '../config.js';
import { COLOUR_FAMILIES, rankByLikeness, suitingShades, type TasteLike } from '../journeys/likeness.js';
import { ProfileService } from '../journeys/profile.js';
import { categoryMedians, PERSONALITIES } from '../journeys/taste.js';
import { KIND_LABEL, KINDS } from './email.js';
import { prefsOf } from './outreach.service.js';

const WEEKS = 12;
const WEIGHT: Record<string, number> = { view: 1, favourite: 3, tryon: 3, cart_add: 4, purchase: 6 };
/** Groups smaller than this are not shown, so no one shopper's colouring can be picked out of a chart. */
export const MIN_GROUP = 5;

/** Monday of the week, in the store's time zone, as YYYY-MM-DD. */
export function weekOf(at: Date, tz = env.storeTimezone) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at).split('-').map(Number);
  const local = new Date(Date.UTC(y, m - 1, d));
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  return local.toISOString().slice(0, 10);
}
function lastWeeks(n: number, now = new Date()) {
  const out: string[] = [];
  const start = new Date(`${weekOf(now)}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) out.push(new Date(start.getTime() - i * 7 * 864e5).toISOString().slice(0, 10));
  return out;
}
const TAG_TO_STYLE = new Map<string, string>();
for (const [key, p] of Object.entries(PERSONALITIES)) for (const t of p.tags) if (!TAG_TO_STYLE.has(t)) TAG_TO_STYLE.set(t, key);

@Injectable()
export class InsightsService {
  constructor(
    private readonly db: PrismaService,
    private readonly profiles: ProfileService,
  ) {}

  /** Everything "What they like" shows for one shopper. */
  async shopper(userId: string) {
    const [user, profile, prefs, products, wants, emails] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, personalise: true } }),
      this.db.shopperProfile.findUnique({ where: { userId } }),
      this.db.shopperPreferences.findUnique({ where: { userId } }),
      this.profiles.products(),
      this.db.shopperWant.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.db.outreach.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const byId = new Map(products.map((p) => [p.id, p]));

    // Interest over the weeks: what they engaged with, by category and by style.
    const since = new Date(Date.now() - WEEKS * 7 * 864e5);
    const [events, bought] = await Promise.all([
      this.db.demandEvent.findMany({ where: { userId, productId: { not: null }, createdAt: { gte: since } }, select: { type: true, productId: true, createdAt: true }, take: 5000 }),
      this.db.$queryRaw<{ productId: number; at: Date }[]>`
        SELECT i."productId", o."createdAt" AS at FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
        WHERE o."userId" = ${userId} AND o.status NOT IN ('CANCELLED', 'PENDING_PAYMENT') AND o."createdAt" >= ${since}`,
    ]);
    const weeks = lastWeeks(WEEKS).map((week) => ({ week, total: 0, categories: {} as Record<string, number>, styles: {} as Record<string, number> }));
    const index = new Map(weeks.map((w, i) => [w.week, i]));
    for (const e of [...events.map((e) => ({ type: e.type, productId: e.productId!, at: e.createdAt })), ...bought.map((b) => ({ type: 'purchase', productId: b.productId, at: b.at }))]) {
      const w = weeks[index.get(weekOf(e.at)) ?? -1];
      const p = byId.get(e.productId);
      if (!w || !p) continue;
      const weight = WEIGHT[e.type] ?? 1;
      w.total += weight;
      w.categories[p.categorySlug] = (w.categories[p.categorySlug] ?? 0) + weight;
      const styles = [...new Set(p.styleTags.map((t) => TAG_TO_STYLE.get(t.toLowerCase())).filter((s): s is string => !!s))];
      for (const s of styles) w.styles[s] = (w.styles[s] ?? 0) + weight / styles.length;
    }

    const taste = profile as unknown as TasteLike | null;
    const p = prefsOf(prefs);
    const boughtIds = new Set(bought.map((b) => b.productId));
    const matches = rankByLikeness(taste, p, products, { exclude: boughtIds, medians: categoryMedians(products), limit: 8 }).map((m) => {
      const prod = byId.get(m.id)!;
      return { ...m, name: prod.name, price: prod.price, type: prod.type };
    });

    return {
      user,
      profile: profile && {
        personality: profile.personality,
        personalityLabel: profile.personality ? PERSONALITIES[profile.personality]?.label ?? profile.personality : null,
        styles: Object.entries(profile.styles as Record<string, number>).map(([key, share]) => ({ key, label: PERSONALITIES[key]?.label ?? key, share })),
        categories: profile.categories,
        genders: profile.genders,
        colors: profile.colors,
        tags: profile.tags,
        priceBand: profile.priceBand,
        priceRatio: profile.priceRatio,
        traits: profile.traits,
        ageGroup: profile.ageGroup,
        ageConfidence: profile.ageConfidence,
        evidence: profile.evidence,
        updatedAt: profile.updatedAt,
      },
      preferences: prefs && {
        skinTone: prefs.skinTone,
        undertone: prefs.undertone,
        toneSource: prefs.toneSource,
        suits: prefs.skinTone || prefs.undertone ? suitingShades(prefs.skinTone, prefs.undertone) : [],
        sizes: prefs.sizes,
        fit: prefs.fit,
        marketingEmails: prefs.marketingEmails,
        marketingSince: prefs.marketingSince,
        emailLang: prefs.emailLang,
      },
      weeks,
      matches,
      wants: wants.map((w) => ({ ...w, matchedName: w.matchedProductId ? byId.get(w.matchedProductId)?.name ?? null : null })),
      emails: emails.map((o) => ({ id: o.id, kind: o.kind, kindLabel: KIND_LABEL[o.kind as keyof typeof KIND_LABEL] ?? o.kind, status: o.status, subject: o.subject, createdAt: o.createdAt, sentAt: o.sentAt, clicks: o.clicks })),
    };
  }

  /** Analytics → Interests & emails, for the last `days`. */
  async interests(days: number) {
    const since = new Date(Date.now() - days * 864e5);
    const [wantsBySource, topOpen, matchedLater, funnel, audience, colouring, profiles] = await Promise.all([
      this.db.$queryRaw<{ source: string; total: number; matched: number }[]>`
        SELECT source, count(*)::int AS total, count("matchedAt")::int AS matched FROM "ShopperWant" WHERE "createdAt" >= ${since} GROUP BY 1 ORDER BY 2 DESC`,
      this.db.$queryRaw<{ text: string; shoppers: number; times: number; last: Date }[]>`
        SELECT lower(text) AS text, count(DISTINCT "userId")::int AS shoppers, count(*)::int AS times, max("createdAt") AS last
        FROM "ShopperWant" WHERE "createdAt" >= ${since} AND "matchedAt" IS NULL AND "closedAt" IS NULL AND source IN ('search', 'chat', 'request')
        GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 15`,
      this.db.shopperWant.count({ where: { matchedAt: { gte: since } } }),
      this.db.$queryRaw<{ kind: string; drafted: number; sent: number; clicked: number; ordered: number; revenue: number }[]>`
        SELECT o.kind, count(*)::int AS drafted, count(o."sentAt")::int AS sent, count(o."clickedAt")::int AS clicked,
               count(DISTINCT o.id) FILTER (WHERE ord.id IS NOT NULL)::int AS ordered, coalesce(sum(ord.total), 0)::float AS revenue
        FROM "Outreach" o
        LEFT JOIN LATERAL (
          SELECT r.id, r.total FROM "Order" r WHERE r."userId" = o."userId" AND o."sentAt" IS NOT NULL
            AND r."createdAt" BETWEEN o."sentAt" AND o."sentAt" + interval '7 days' AND r.status NOT IN ('CANCELLED', 'PENDING_PAYMENT')
          ORDER BY r."createdAt" LIMIT 1
        ) ord ON true
        WHERE o."createdAt" >= ${since} GROUP BY 1`,
      this.db.$queryRaw<{ shoppers: number; opted: number; colouring: number; sizes: number }[]>`
        SELECT (SELECT count(*)::int FROM "User" WHERE role = 'CUSTOMER') AS shoppers,
               count(*) FILTER (WHERE "marketingEmails")::int AS opted,
               count(*) FILTER (WHERE "skinTone" IS NOT NULL OR undertone IS NOT NULL)::int AS colouring,
               count(*) FILTER (WHERE sizes <> '{}'::jsonb)::int AS sizes
        FROM "ShopperPreferences"`,
      this.db.$queryRaw<{ undertone: string; n: number }[]>`
        SELECT coalesce(undertone, 'not given') AS undertone, count(*)::int AS n FROM "ShopperPreferences" WHERE "skinTone" IS NOT NULL OR undertone IS NOT NULL GROUP BY 1`,
      this.db.shopperProfile.findMany({ select: { colors: true, evidence: true, userId: true } }),
    ]);

    // Colour families shoppers engage with, store-wide and (groups of MIN_GROUP+ only) by undertone.
    const undertoneOf = new Map(
      (await this.db.shopperPreferences.findMany({ where: { undertone: { not: null } }, select: { userId: true, undertone: true } })).map((p) => [p.userId, p.undertone!]),
    );
    const families = (filter?: string) => {
      const sum: Record<string, number> = {};
      let n = 0;
      for (const p of profiles) {
        if (filter && undertoneOf.get(p.userId) !== filter) continue;
        n++;
        for (const [k, v] of Object.entries(p.colors as Record<string, number>)) sum[k] = (sum[k] ?? 0) + v * Math.min(p.evidence, 20);
      }
      const total = Object.values(sum).reduce((a, b) => a + b, 0) || 1;
      const shares = COLOUR_FAMILIES.map((f) => ({ family: f, share: Math.round(((sum[f] ?? 0) / total) * 1000) / 1000 })).filter((x) => x.share > 0);
      return { shoppers: n, shares: shares.sort((a, b) => b.share - a.share) };
    };
    const byUndertone = ['warm', 'cool', 'neutral'].map((u) => ({ undertone: u, ...families(u) })).filter((g) => g.shoppers >= MIN_GROUP);

    const kinds = KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k], ...(funnel.find((f) => f.kind === k) ?? { drafted: 0, sent: 0, clicked: 0, ordered: 0, revenue: 0 }) }));
    const a = audience[0] ?? { shoppers: 0, opted: 0, colouring: 0, sizes: 0 };
    return {
      days,
      wants: { bySource: wantsBySource, matched: matchedLater, topOpen },
      emails: kinds,
      audience: { ...a, undertones: colouring.reduce((n, c) => n + c.n, 0) >= MIN_GROUP ? colouring : null },
      colours: { all: families(), byUndertone },
      minGroup: MIN_GROUP,
    };
  }
}
