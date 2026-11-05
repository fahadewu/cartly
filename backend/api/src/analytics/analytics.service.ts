import { Injectable } from '@nestjs/common';
import { callAi } from '../common/ai.js';
import { PrismaService } from '../common/infra.module.js';
import { env } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { type Region, regionLabel, regionOf } from './regions.js';

/*
 * How everything here is counted (the admin panel shows the same notes):
 * - A sale is an order that isn't cancelled or still waiting to be paid online, counted on the day it was
 *   placed, in the store's time zone (STORE_TIMEZONE, Asia/Dhaka by default).
 * - Money is in dollars, the store's price currency. Refunds are paid in taka, so each is converted back at
 *   the rate its own order was charged at. Net sales = gross sales − refunds made in the period.
 * - Refunds come from two places, each counted once: gateway refunds (the payment's own log, on orders that
 *   weren't cancelled) and returns refunded by hand (bKash/Nagad transfer, cash).
 * - Views and searches are only known from when tracking started; rates that need them say so.
 * - A trend needs enough behind it: "rising" means at least MIN_UNITS units now and 50% more than the
 *   period before (or none before). Figures from fewer than LOW_SAMPLE orders are flagged.
 */
const DAY = 864e5;
const MIN_UNITS = 3;
const LOW_SAMPLE = 10;
const MIN_LIFT_UNITS = 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const change = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 1000) / 10 : null);
const SOLD = `o.status NOT IN ('CANCELLED', 'PENDING_PAYMENT')`;

/** Minutes the store's time zone is ahead of UTC right now. */
function tzOffsetMinutes(tz: string) {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}

export interface Range {
  days: number;
  from: Date;
  to: Date;
  prevFrom: Date;
  /** Store time zone offset, minutes. */
  offset: number;
  tz: string;
}

export function rangeOf(days: number): Range {
  const tz = env.storeTimezone;
  const offset = tzOffsetMinutes(tz);
  const now = Date.now();
  const localMidnight = Math.floor((now + offset * 60000) / DAY) * DAY;
  const from = new Date(localMidnight - (days - 1) * DAY - offset * 60000);
  return { days, from, to: new Date(now), prevFrom: new Date(from.getTime() - days * DAY), offset, tz };
}
const localDay = (d: Date, offset: number) => new Date(d.getTime() + offset * 60000).toISOString().slice(0, 10);
const ts = (d: Date) => d.toISOString();

type OrderRow = {
  id: string;
  userId: string;
  status: string;
  total: number;
  subtotal: number;
  discount: number;
  shipping: number;
  paymentMethod: string;
  promoCode: string | null;
  createdAt: Date;
  address: { city?: string; country?: string; street?: string };
  rate: number | null;
};
type ItemRow = { orderId: string; productId: number; qty: number; price: number; color: string; size: string };
type ProductInfo = { id: number; name: string; image: string; categorySlug: string; type: string; gender: string; stock: number; active: boolean; price: number; styleTags: string[]; occasions: string[]; material: string | null; fit: string | null };

/** Counts per key, for "units by colour" and the like, with the share of the total. */
function tally<T>(rows: T[], keyOf: (r: T) => string | string[] | null | undefined, weight: (r: T) => number) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    for (const one of Array.isArray(k) ? k : k ? [k] : []) m.set(one, (m.get(one) ?? 0) + weight(r));
  }
  return m;
}
function ranked(now: Map<string, number>, before: Map<string, number>, limit = 10) {
  const total = [...now.values()].reduce((a, b) => a + b, 0);
  return [...now.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, units]) => ({ name, units, share: pct(units, total), previous: before.get(name) ?? 0, change: change(units, before.get(name) ?? 0) }));
}
/**
 * Rising: enough units now, and half as many again as before (or new). Only claimed when the period
 * before had sales at all; otherwise everything would look new.
 */
function rising(now: Map<string, number>, before: Map<string, number>, limit = 8, comparable = true) {
  if (!comparable) return [];
  return [...now.entries()]
    .filter(([k, n]) => n >= MIN_UNITS && (!(before.get(k) ?? 0) || n >= 1.5 * (before.get(k) ?? 0)))
    .map(([name, units]) => ({ name, units, previous: before.get(name) ?? 0, change: change(units, before.get(name) ?? 0) }))
    .sort((a, b) => b.units - b.previous - (a.units - a.previous))
    .slice(0, limit);
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: PrismaService) {}

  /* ---------- shared loading ---------- */

  private async orders(from: Date, to: Date, sold = true): Promise<OrderRow[]> {
    const rows = await this.db.$queryRawUnsafe<OrderRow[]>(
      `SELECT o.id, o."userId", o.status::text AS status, o.total::float AS total, o.subtotal::float AS subtotal, o.discount::float AS discount,
              o.shipping::float AS shipping, o."paymentMethod", o."promoCode", o."createdAt", o.address, o."exchangeRate"::float AS rate
       FROM "Order" o WHERE o."createdAt" >= $1::timestamp AND o."createdAt" < $2::timestamp ${sold ? `AND ${SOLD}` : `AND o.status <> 'PENDING_PAYMENT'`}`,
      ts(from),
      ts(to),
    );
    return rows;
  }

  private async items(orderIds: string[]): Promise<ItemRow[]> {
    if (!orderIds.length) return [];
    return this.db.$queryRaw<ItemRow[]>`
      SELECT "orderId", "productId", qty, price::float AS price, color, size FROM "OrderItem" WHERE "orderId" = ANY(${orderIds})`;
  }

  private async products(ids?: number[]): Promise<Map<number, ProductInfo>> {
    const rows = await this.db.product.findMany({
      where: ids ? { id: { in: ids } } : {},
      select: { id: true, name: true, image: true, categorySlug: true, type: true, gender: true, stock: true, active: true, price: true, styleTags: true, occasions: true, material: true, fit: true },
    });
    return new Map(rows.map((p) => [p.id, { ...p, price: Number(p.price) }]));
  }

  /** Refunds made in a window, in dollars, by day: gateway refunds (from payment logs) + returns refunded by hand. */
  private async refunds(from: Date, to: Date, offset: number) {
    const gateway = await this.db.$queryRaw<{ at: string; bdt: number; rate: number | null; reason: string | null; orderId: string }[]>`
      SELECT e->>'at' AS at, (e->>'amount')::float AS bdt, o."exchangeRate"::float AS rate, e->>'reason' AS reason, o.id AS "orderId"
      FROM "Payment" p JOIN "Order" o ON o.id = p."orderId", jsonb_array_elements(p.log) e
      WHERE e->>'step' = 'refunded' AND o.status <> 'CANCELLED'
        AND (e->>'at')::timestamptz >= ${ts(from)}::timestamptz AND (e->>'at')::timestamptz < ${ts(to)}::timestamptz`;
    const manual = await this.db.returnRequest.findMany({
      // Gateway refunds are already in the payment logs; these are the ones sent by hand.
      where: { status: 'REFUNDED', refundedAt: { gte: from, lt: to }, refundMethod: { startsWith: 'manual' } },
      include: { order: { select: { exchangeRate: true } } },
    });
    const byDay = new Map<string, number>();
    let total = 0;
    const add = (at: Date, usd: number) => {
      total += usd;
      const d = localDay(at, offset);
      byDay.set(d, (byDay.get(d) ?? 0) + usd);
    };
    for (const g of gateway) add(new Date(g.at), g.rate ? g.bdt / g.rate : 0);
    for (const r of manual) {
      const rate = r.order.exchangeRate == null ? null : Number(r.order.exchangeRate);
      add(r.refundedAt!, r.refundBdt != null && rate ? Number(r.refundBdt) / rate : Number(r.refundUsd));
    }
    return { total: round2(total), byDay, count: gateway.length + manual.length };
  }

  /** When demand tracking (views, searches) began, or null if nothing has been recorded yet. */
  private async trackingSince() {
    const first = await this.db.demandEvent.findFirst({ where: { type: { in: ['view', 'search'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    return first?.createdAt ?? null;
  }

  /** Each shopper's region, from the address on their latest order. */
  private async shopperRegions(userIds: string[]) {
    if (!userIds.length) return new Map<string, Region>();
    const rows = await this.db.$queryRaw<{ userId: string; address: OrderRow['address'] }[]>`
      SELECT DISTINCT ON ("userId") "userId", address FROM "Order" WHERE "userId" = ANY(${userIds}) ORDER BY "userId", "createdAt" DESC`;
    return new Map(rows.map((r) => [r.userId, regionOf(r.address)]));
  }

  /* ---------- sales ---------- */

  async sales(days: number) {
    const r = rangeOf(days);
    const [now, before, placed, refunds, prevRefunds, tracking] = await Promise.all([
      this.orders(r.from, r.to),
      this.orders(r.prevFrom, r.from),
      this.orders(r.from, r.to, false),
      this.refunds(r.from, r.to, r.offset),
      this.refunds(r.prevFrom, r.from, r.offset),
      this.trackingSince(),
    ]);
    const items = await this.items(now.map((o) => o.id));
    const prevItems = await this.items(before.map((o) => o.id));
    const sum = (rows: OrderRow[], f: (o: OrderRow) => number) => round2(rows.reduce((a, o) => a + f(o), 0));
    const gross = sum(now, (o) => o.total);
    const prevGross = sum(before, (o) => o.total);
    const units = items.reduce((a, i) => a + i.qty, 0);
    const prevUnits = prevItems.reduce((a, i) => a + i.qty, 0);
    const buyers = new Set(now.map((o) => o.userId));

    // New or returning: did the buyer have a sale before this period?
    const firsts = buyers.size
      ? await this.db.$queryRaw<{ userId: string; first: Date }[]>`
          SELECT "userId", MIN("createdAt") AS first FROM "Order" o WHERE ${Prisma_sql(SOLD)} AND "userId" = ANY(${[...buyers]}) GROUP BY 1`
      : [];
    const firstOf = new Map(firsts.map((f) => [f.userId, f.first]));
    const newBuyers = [...buyers].filter((u) => (firstOf.get(u) ?? r.from) >= r.from);
    const newRevenue = sum(now.filter((o) => newBuyers.includes(o.userId)), (o) => o.total);
    const repeatBuyers = [...buyers].filter((u) => now.filter((o) => o.userId === u).length > 1 || (firstOf.get(u) ?? r.from) < r.from);

    // Shoppers who were around: anyone who viewed, searched or bought.
    const since = tracking && tracking > r.from ? tracking : r.from;
    const active = tracking
      ? await this.db.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(DISTINCT u) AS n FROM (
            SELECT "userId" AS u FROM "DemandEvent" WHERE "userId" IS NOT NULL AND "createdAt" >= ${ts(since)}::timestamp
            UNION SELECT "userId" FROM "Order" o WHERE ${Prisma_sql(SOLD)} AND o."createdAt" >= ${ts(since)}::timestamp) x`
      : [];
    const buyersSince = new Set(now.filter((o) => o.createdAt >= since).map((o) => o.userId)).size;

    // Daily series in the store's time zone.
    const series = Array.from({ length: days }, (_, i) => {
      const date = localDay(new Date(r.from.getTime() + i * DAY), r.offset);
      const day = now.filter((o) => localDay(o.createdAt, r.offset) === date);
      const g = sum(day, (o) => o.total);
      const refunded = round2(refunds.byDay.get(date) ?? 0);
      return { date, gross: g, refunds: refunded, net: round2(g - refunded), orders: day.length };
    });

    // When people buy: day of week × hour, store time.
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    for (const o of now) {
      const d = new Date(o.createdAt.getTime() + r.offset * 60000);
      heat[d.getUTCDay()][d.getUTCHours()]++;
    }
    const cancelled = placed.filter((o) => o.status === 'CANCELLED').length;

    const methods = tally(now, (o) => o.paymentMethod, () => 1);
    const methodRevenue = tally(now, (o) => o.paymentMethod, (o) => o.total);
    const promos = tally(now, (o) => o.promoCode, () => 1);
    const promoDiscount = tally(now, (o) => o.promoCode, (o) => o.discount);

    return {
      range: r,
      sample: { orders: now.length, low: now.length < LOW_SAMPLE },
      gross: { total: gross, previous: prevGross, change: change(gross, prevGross) },
      refunds: { total: refunds.total, count: refunds.count, previous: prevRefunds.total },
      net: { total: round2(gross - refunds.total), previous: round2(prevGross - prevRefunds.total), change: change(gross - refunds.total, prevGross - prevRefunds.total) },
      productSales: sum(now, (o) => o.subtotal - o.discount),
      shippingCharged: sum(now, (o) => o.shipping),
      discounts: sum(now, (o) => o.discount),
      orders: { total: now.length, previous: before.length, change: change(now.length, before.length) },
      units: { total: units, previous: prevUnits, change: change(units, prevUnits), perOrder: now.length ? round2(units / now.length) : 0 },
      aov: { total: now.length ? round2(gross / now.length) : 0, previous: before.length ? round2(prevGross / before.length) : 0, change: change(now.length ? gross / now.length : 0, before.length ? prevGross / before.length : 0) },
      buyers: {
        total: buyers.size,
        new: newBuyers.length,
        returning: buyers.size - newBuyers.length,
        newRevenue,
        returningRevenue: round2(gross - newRevenue),
        /** Buyers in the period who have bought more than once (in it or before). */
        repeatRate: pct(repeatBuyers.length, buyers.size),
      },
      cancellations: { cancelled, placed: placed.length, rate: pct(cancelled, placed.length) },
      conversion: tracking
        ? { since, shoppers: Number(active[0]?.n ?? 0), buyers: buyersSince, rate: pct(buyersSince, Number(active[0]?.n ?? 0)) }
        : { since: null, shoppers: null, buyers: null, rate: null },
      payments: [...methods.entries()].sort((a, b) => b[1] - a[1]).map(([method, orders]) => ({ method, orders, share: pct(orders, now.length), gross: round2(methodRevenue.get(method) ?? 0) })),
      promos: [...promos.entries()].sort((a, b) => b[1] - a[1]).map(([code, orders]) => ({ code, orders, discount: round2(promoDiscount.get(code) ?? 0) })),
      series,
      heatmap: heat,
    };
  }

  /* ---------- products and demand ---------- */

  async demand(days: number) {
    const r = rangeOf(days);
    const [now, before, tracking] = await Promise.all([this.orders(r.from, r.to), this.orders(r.prevFrom, r.from), this.trackingSince()]);
    const [items, prevItems] = await Promise.all([this.items(now.map((o) => o.id)), this.items(before.map((o) => o.id))]);
    const events = await this.db.$queryRaw<{ productId: number; type: string; n: bigint; people: bigint }[]>`
      SELECT "productId", type, COUNT(*) AS n, COUNT(DISTINCT "userId") AS people FROM "DemandEvent"
      WHERE "productId" IS NOT NULL AND "createdAt" >= ${ts(r.from)}::timestamp GROUP BY 1, 2`;
    // Of the people who viewed a product, how many bought it afterwards (both sides from tracking data only).
    const converted = await this.db.$queryRaw<{ productId: number; n: bigint }[]>`
      SELECT v."productId", COUNT(DISTINCT v."userId") AS n
      FROM (SELECT "productId", "userId", MIN("createdAt") AS first FROM "DemandEvent"
            WHERE type = 'view' AND "userId" IS NOT NULL AND "createdAt" >= ${ts(r.from)}::timestamp GROUP BY 1, 2) v
      WHERE EXISTS (SELECT 1 FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o.id
                    WHERE o."userId" = v."userId" AND i."productId" = v."productId" AND o."createdAt" >= v.first AND ${Prisma_sql(SOLD)})
      GROUP BY 1`;
    const convertedBy = new Map(converted.map((c) => [c.productId, Number(c.n)]));
    const returned = await this.db.$queryRaw<{ productId: number; units: bigint }[]>`
      SELECT oi."productId", SUM(ri.qty) AS units FROM "ReturnItem" ri JOIN "ReturnRequest" rr ON rr.id = ri."returnId" JOIN "OrderItem" oi ON oi.id = ri."orderItemId"
      WHERE rr.status IN ('REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED') AND rr."createdAt" >= ${ts(r.from)}::timestamp GROUP BY 1`;
    const catalog = await this.products();
    const per = new Map<number, { units: number; revenue: number; orders: Set<string>; prevUnits: number; views: number; viewers: number; carts: number; favourites: number; tryons: number; returned: number }>();
    const row = (id: number) => {
      let x = per.get(id);
      if (!x) per.set(id, (x = { units: 0, revenue: 0, orders: new Set(), prevUnits: 0, views: 0, viewers: 0, carts: 0, favourites: 0, tryons: 0, returned: 0 }));
      return x;
    };
    for (const i of items) {
      const x = row(i.productId);
      x.units += i.qty;
      x.revenue += i.qty * i.price;
      x.orders.add(i.orderId);
    }
    for (const i of prevItems) row(i.productId).prevUnits += i.qty;
    for (const e of events) {
      const x = row(e.productId);
      const n = Number(e.n);
      if (e.type === 'view') {
        x.views += n;
        x.viewers += Number(e.people);
      } else if (e.type === 'cart_add') x.carts += n;
      else if (e.type === 'favourite') x.favourites += n;
      else if (e.type === 'tryon') x.tryons += n;
    }
    for (const t of returned) row(t.productId).returned += Number(t.units);

    const list = [...per.entries()]
      .filter(([id]) => catalog.has(id))
      .map(([id, x]) => {
        const p = catalog.get(id)!;
        const velocity = x.units / days; // units a day
        return {
          id,
          name: p.name,
          image: p.image,
          category: p.categorySlug,
          type: p.type,
          stock: p.stock,
          active: p.active,
          units: x.units,
          revenue: round2(x.revenue),
          orders: x.orders.size,
          previousUnits: x.prevUnits,
          change: change(x.units, x.prevUnits),
          views: x.views,
          viewers: x.viewers,
          cartAdds: x.carts,
          favourites: x.favourites,
          tryOns: x.tryons,
          returned: x.returned,
          returnRate: pct(x.returned, x.units),
          // Of the people who looked at it, the share who then bought it.
          viewersWhoBought: convertedBy.get(id) ?? 0,
          viewToOrder: x.viewers ? pct(convertedBy.get(id) ?? 0, x.viewers) : null,
          daysOfCover: velocity > 0 ? Math.round(p.stock / velocity) : null,
        };
      });
    const by = <K extends keyof (typeof list)[number]>(k: K, n = 10, filter: (x: (typeof list)[number]) => boolean = () => true) =>
      list.filter(filter).sort((a, b) => Number(b[k] ?? 0) - Number(a[k] ?? 0)).slice(0, n);

    // Searches: what people want, and what the store didn't have.
    const searches = await this.db.$queryRaw<{ query: string; n: bigint; people: bigint; results: number | null; zero: bigint }[]>`
      SELECT query, COUNT(*) AS n, COUNT(DISTINCT "userId") AS people, ROUND(AVG(results))::int AS results, COUNT(*) FILTER (WHERE results = 0) AS zero
      FROM "DemandEvent" WHERE type = 'search' AND "createdAt" >= ${ts(r.from)}::timestamp AND query IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 200`;
    const searchRows = searches.map((s) => ({ query: s.query, searches: Number(s.n), people: Number(s.people), avgResults: s.results, zeroResults: Number(s.zero) }));
    const requests = await this.db.productRequest.findMany({ where: { createdAt: { gte: r.from } }, orderBy: { createdAt: 'desc' }, take: 200 });

    // What sells, by attribute, against the period before.
    const productOf = (i: ItemRow) => catalog.get(i.productId);
    const attr = (f: (i: ItemRow) => string | string[] | null | undefined) => ranked(tally(items, f, (i) => i.qty), tally(prevItems, f, (i) => i.qty));
    const categories = new Map((await this.db.category.findMany({ select: { slug: true, title: true } })).map((c) => [c.slug, c.title]));

    return {
      range: r,
      sample: { orders: now.length, low: now.length < LOW_SAMPLE, previousOrders: before.length, comparable: before.length > 0 },
      tracking: { since: tracking },
      topSellers: by('units'),
      topRevenue: by('revenue'),
      mostWanted: by('views', 10, (x) => x.views > 0),
      // Looked at a lot, rarely bought: price, photos or sizes may be putting people off.
      viewedNotBought: list.filter((x) => x.viewers >= 5 && (x.viewToOrder ?? 0) < 10).sort((a, b) => (a.viewToOrder ?? 0) - (b.viewToOrder ?? 0) || b.viewers - a.viewers).slice(0, 10),
      // Wanted but not there to sell.
      lostDemand: list.filter((x) => x.stock <= 0 && (x.views + x.cartAdds) > 0).sort((a, b) => b.cartAdds + b.views - (a.cartAdds + a.views)).slice(0, 10),
      runningOut: list.filter((x) => x.daysOfCover != null && x.daysOfCover <= 14 && x.stock > 0).sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0)).slice(0, 10),
      mostReturned: list.filter((x) => x.returned > 0).sort((a, b) => (b.returnRate ?? 0) - (a.returnRate ?? 0)).slice(0, 10),
      rising: !before.length ? [] : list.filter((x) => x.units >= MIN_UNITS && (x.previousUnits === 0 || x.units >= 1.5 * x.previousUnits)).sort((a, b) => b.units - b.previousUnits - (a.units - a.previousUnits)).slice(0, 10),
      searches: {
        total: searchRows.reduce((a, s) => a + s.searches, 0),
        top: searchRows.slice(0, 20),
        // Asked for and found nothing: the clearest sign of what to stock.
        unmet: searchRows.filter((s) => s.zeroResults > 0).sort((a, b) => b.zeroResults - a.zeroResults).slice(0, 20),
      },
      requests: {
        total: requests.length,
        byCategory: [...tally(requests, (q) => q.category, () => 1).entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
        latest: requests.slice(0, 10).map((q) => ({ product: q.product, category: q.category, size: q.size, budget: q.budget == null ? null : Number(q.budget), status: q.status, createdAt: q.createdAt })),
      },
      attributes: {
        category: attr((i) => categories.get(productOf(i)?.categorySlug ?? '') ?? productOf(i)?.categorySlug),
        type: attr((i) => productOf(i)?.type),
        gender: attr((i) => productOf(i)?.gender),
        color: attr((i) => i.color),
        size: attr((i) => i.size),
        style: attr((i) => productOf(i)?.styleTags),
        occasion: attr((i) => productOf(i)?.occasions),
        material: attr((i) => productOf(i)?.material),
        fit: attr((i) => productOf(i)?.fit),
      },
    };
  }

  /* ---------- customers ---------- */

  /** `identities`: whether the caller may see who the customers are (customers.read); analytics alone sees only numbers. */
  async customers(days: number, identities = false) {
    const r = rangeOf(days);
    // Every sale ever, per customer: recency, frequency, spend (RFM).
    const all = await this.db.$queryRaw<{ userId: string; name: string; email: string; orders: bigint; spent: number; first: Date; last: Date }[]>`
      SELECT o."userId", u.name, u.email, COUNT(*) AS orders, SUM(o.total)::float AS spent, MIN(o."createdAt") AS first, MAX(o."createdAt") AS last
      FROM "Order" o JOIN "User" u ON u.id = o."userId" WHERE ${Prisma_sql(SOLD)} GROUP BY 1, 2, 3`;
    const [signups, signupsPrev, customersTotal] = await Promise.all([
      this.db.user.count({ where: { role: 'CUSTOMER', createdAt: { gte: r.from } } }),
      this.db.user.count({ where: { role: 'CUSTOMER', createdAt: { gte: r.prevFrom, lt: r.from } } }),
      this.db.user.count({ where: { role: 'CUSTOMER' } }),
    ]);
    const nowMs = Date.now();
    const segment = (c: (typeof all)[number]) => {
      const recency = (nowMs - c.last.getTime()) / DAY;
      const f = Number(c.orders);
      if (recency <= 30 && f >= 3) return 'Champions';
      if (f >= 3 && recency <= 90) return 'Loyal';
      if (f === 1 && (nowMs - c.first.getTime()) / DAY <= 30) return 'New';
      if (recency <= 60) return 'Promising';
      if (f >= 2 && recency <= 180) return 'At risk';
      return 'Lapsed';
    };
    const SEGMENTS = ['Champions', 'Loyal', 'Promising', 'New', 'At risk', 'Lapsed'];
    const seg = new Map(SEGMENTS.map((s) => [s, { customers: 0, spent: 0 }]));
    for (const c of all) {
      const s = seg.get(segment(c))!;
      s.customers++;
      s.spent += c.spent;
    }

    // Cohorts: customers by the month of their first purchase, and the share who bought again each month after.
    const orders = await this.db.$queryRaw<{ userId: string; createdAt: Date }[]>`SELECT "userId", "createdAt" FROM "Order" o WHERE ${Prisma_sql(SOLD)}`;
    const month = (d: Date) => new Date(d.getTime() + r.offset * 60000).toISOString().slice(0, 7);
    const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
    const firstMonth = new Map(all.map((c) => [c.userId, month(c.first)]));
    const cohortSize = new Map<string, number>();
    for (const [, m] of firstMonth) cohortSize.set(m, (cohortSize.get(m) ?? 0) + 1);
    const seen = new Set<string>();
    const cohortActive = new Map<string, number[]>();
    for (const o of orders) {
      const c = firstMonth.get(o.userId);
      if (!c) continue;
      const k = monthIndex(month(o.createdAt)) - monthIndex(c);
      const id = `${o.userId}|${k}`;
      if (k < 1 || k > 6 || seen.has(id)) continue;
      seen.add(id);
      const arr = cohortActive.get(c) ?? Array(6).fill(0);
      arr[k - 1]++;
      cohortActive.set(c, arr);
    }
    const thisMonth = monthIndex(month(new Date()));
    const cohorts = [...cohortSize.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 12)
      .map(([m, size]) => ({
        month: m,
        customers: size,
        // Months that haven't finished yet are null, not zero.
        retention: (cohortActive.get(m) ?? Array(6).fill(0)).map((n, i) => (monthIndex(m) + i + 1 >= thisMonth ? null : pct(n, size))),
      }));

    const gaps: number[] = [];
    const byUser = new Map<string, Date[]>();
    for (const o of orders) byUser.set(o.userId, [...(byUser.get(o.userId) ?? []), o.createdAt]);
    for (const list of byUser.values()) {
      list.sort((a, b) => a.getTime() - b.getTime());
      for (let i = 1; i < list.length; i++) gaps.push((list[i].getTime() - list[i - 1].getTime()) / DAY);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10 : null;
    const inPeriod = all.filter((c) => c.last >= r.from);
    const lifetime = all.reduce((a, c) => a + c.spent, 0);

    return {
      range: r,
      totals: {
        customers: customersTotal,
        buyersEver: all.length,
        neverBought: Math.max(0, customersTotal - all.length),
        signups: { total: signups, previous: signupsPrev, change: change(signups, signupsPrev) },
        avgLifetimeValue: all.length ? round2(lifetime / all.length) : 0,
        avgOrdersPerBuyer: all.length ? round2(all.reduce((a, c) => a + Number(c.orders), 0) / all.length) : 0,
        repeatBuyers: all.filter((c) => Number(c.orders) > 1).length,
        repeatShare: pct(all.filter((c) => Number(c.orders) > 1).length, all.length),
        medianDaysBetweenOrders: median,
        gapsMeasured: gaps.length,
      },
      segments: SEGMENTS.map((name) => ({ name, customers: seg.get(name)!.customers, share: pct(seg.get(name)!.customers, all.length), spent: round2(seg.get(name)!.spent) })),
      cohorts,
      top: [...inPeriod]
        .sort((a, b) => b.spent - a.spent)
        .slice(0, 10)
        .map((c) => ({
          id: c.userId,
          name: identities ? c.name : 'A customer',
          email: identities ? c.email : null,
          orders: Number(c.orders),
          spent: round2(c.spent),
          lastOrderAt: c.last,
          segment: segment(c),
        })),
    };
  }

  /* ---------- regions and fashion trends ---------- */

  async regions(days: number, level: 'region' | 'place' = 'region') {
    const r = rangeOf(days);
    const [now, before] = await Promise.all([this.orders(r.from, r.to), this.orders(r.prevFrom, r.from)]);
    const [items, prevItems] = await Promise.all([this.items(now.map((o) => o.id)), this.items(before.map((o) => o.id))]);
    const catalog = await this.products();
    const categories = new Map((await this.db.category.findMany({ select: { slug: true, title: true } })).map((c) => [c.slug, c.title]));
    const regionKey = (o: OrderRow) => {
      const g = regionOf(o.address);
      return level === 'place' ? (g.country === 'Bangladesh' ? `${g.district ?? 'Area unknown'}, ${g.division ?? 'Bangladesh'}` : `${g.place ?? 'City unknown'}, ${g.country}`) : regionLabel(g);
    };
    const regionOfOrder = new Map([...now, ...before].map((o) => [o.id, regionKey(o)]));
    const unmatched = [...now].filter((o) => {
      const g = regionOf(o.address);
      return g.country === 'Unknown' || (g.country === 'Bangladesh' && !g.district);
    });

    const ids = now.map((o) => o.id);
    const returns = !ids.length ? [] : await this.db.$queryRaw<{ orderId: string; units: bigint }[]>`
      SELECT rr."orderId", SUM(ri.qty) AS units FROM "ReturnRequest" rr JOIN "ReturnItem" ri ON ri."returnId" = rr.id
      WHERE rr.status IN ('REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED') AND rr."orderId" = ANY(${now.map((o) => o.id)}) GROUP BY 1`;
    const returnedBy = new Map(returns.map((x) => [x.orderId, Number(x.units)]));
    const deliveredIn = !ids.length ? [] : await this.db.$queryRaw<{ orderId: string; hours: number }[]>`
      SELECT "orderId", EXTRACT(EPOCH FROM ("deliveredAt" - "createdAt")) / 3600 AS hours FROM "Shipment"
      WHERE kind = 'delivery' AND status = 'DELIVERED' AND "orderId" = ANY(${now.map((o) => o.id)})`;
    const hoursBy = new Map(deliveredIn.map((x) => [x.orderId, Number(x.hours)]));

    const names = [...new Set(now.map((o) => regionOfOrder.get(o.id)!))];
    const totalGross = now.reduce((a, o) => a + o.total, 0);
    const totalUnits = items.reduce((a, i) => a + i.qty, 0);
    const attrOf = {
      category: (i: ItemRow) => categories.get(catalog.get(i.productId)?.categorySlug ?? '') ?? null,
      type: (i: ItemRow) => catalog.get(i.productId)?.type ?? null,
      color: (i: ItemRow) => i.color,
      size: (i: ItemRow) => i.size,
      style: (i: ItemRow) => catalog.get(i.productId)?.styleTags ?? null,
      occasion: (i: ItemRow) => catalog.get(i.productId)?.occasions ?? null,
      product: (i: ItemRow) => catalog.get(i.productId)?.name ?? null,
    };
    const overall = Object.fromEntries(Object.entries(attrOf).map(([k, f]) => [k, tally(items, f, (i) => i.qty)])) as Record<keyof typeof attrOf, Map<string, number>>;

    const regions = names
      .map((name) => {
        const orders = now.filter((o) => regionOfOrder.get(o.id) === name);
        const prev = before.filter((o) => regionOfOrder.get(o.id) === name);
        const ids = new Set(orders.map((o) => o.id));
        const prevIds = new Set(prev.map((o) => o.id));
        const its = items.filter((i) => ids.has(i.orderId));
        const prevIts = prevItems.filter((i) => prevIds.has(i.orderId));
        const gross = orders.reduce((a, o) => a + o.total, 0);
        const units = its.reduce((a, i) => a + i.qty, 0);
        const returned = orders.reduce((a, o) => a + (returnedBy.get(o.id) ?? 0), 0);
        const hours = orders.map((o) => hoursBy.get(o.id)).filter((h): h is number => h != null);
        const tastes = Object.fromEntries(
          Object.entries(attrOf).map(([k, f]) => {
            const mine = tally(its, f, (i) => i.qty);
            const theirs = tally(prevIts, f, (i) => i.qty);
            const all = overall[k as keyof typeof attrOf];
            // Lift: how much more this region buys it than the store as a whole (1 = the same).
            // Only where the region has bought enough for the comparison to mean something.
            const top = ranked(mine, theirs, 6).map((t) => ({ ...t, lift: units >= MIN_LIFT_UNITS && all.get(t.name) ? round2(t.units / units / ((all.get(t.name) ?? 0) / totalUnits)) : null }));
            return [k, { top, rising: rising(mine, theirs, 5, before.length > 0) }];
          }),
        );
        return {
          name,
          orders: orders.length,
          previousOrders: prev.length,
          change: change(orders.length, prev.length),
          buyers: new Set(orders.map((o) => o.userId)).size,
          gross: round2(gross),
          share: pct(gross, totalGross),
          aov: orders.length ? round2(gross / orders.length) : 0,
          units,
          codShare: pct(orders.filter((o) => o.paymentMethod === 'cod').length, orders.length),
          returnRate: pct(returned, units),
          avgDeliveryHours: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
          deliveriesMeasured: hours.length,
          lowSample: orders.length < LOW_SAMPLE,
          tastes,
        };
      })
      .sort((a, b) => b.gross - a.gross);

    // What people in each region search for (region from their latest order's address).
    const searches = await this.db.$queryRaw<{ userId: string; query: string; n: bigint; zero: bigint }[]>`
      SELECT "userId", query, COUNT(*) AS n, COUNT(*) FILTER (WHERE results = 0) AS zero FROM "DemandEvent"
      WHERE type = 'search' AND "userId" IS NOT NULL AND "createdAt" >= ${ts(r.from)}::timestamp GROUP BY 1, 2`;
    const shopperRegion = await this.shopperRegions([...new Set(searches.map((s) => s.userId))]);
    const searchBy = new Map<string, Map<string, { n: number; zero: number }>>();
    for (const s of searches) {
      const g = shopperRegion.get(s.userId);
      const name = g ? (level === 'place' ? (g.country === 'Bangladesh' ? `${g.district ?? 'Area unknown'}, ${g.division ?? 'Bangladesh'}` : `${g.place ?? 'City unknown'}, ${g.country}`) : regionLabel(g)) : 'No orders yet';
      const m = searchBy.get(name) ?? new Map();
      const x = m.get(s.query) ?? { n: 0, zero: 0 };
      x.n += Number(s.n);
      x.zero += Number(s.zero);
      m.set(s.query, x);
      searchBy.set(name, m);
    }

    // Season by season: units per category per month over the last 12 months, all regions.
    const monthly = await this.db.$queryRaw<{ month: string; category: string; units: bigint }[]>`
      SELECT to_char(o."createdAt" + make_interval(mins => ${r.offset}), 'YYYY-MM') AS month, p."categorySlug" AS category, SUM(i.qty) AS units
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" JOIN "Product" p ON p.id = i."productId"
      WHERE ${Prisma_sql(SOLD)} AND o."createdAt" >= (now() - interval '365 days') GROUP BY 1, 2 ORDER BY 1`;

    return {
      range: r,
      level,
      sample: { orders: now.length, low: now.length < LOW_SAMPLE, previousOrders: before.length, comparable: before.length > 0 },
      unmatched: { orders: unmatched.length, examples: [...new Set(unmatched.map((o) => [o.address.city, o.address.country].filter(Boolean).join(', ')))].slice(0, 10) },
      regions,
      searches: [...searchBy.entries()].map(([name, m]) => ({
        name,
        top: [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([query, x]) => ({ query, searches: x.n, zeroResults: x.zero })),
      })),
      seasonality: {
        months: [...new Set(monthly.map((m) => m.month))],
        categories: [...new Set(monthly.map((m) => m.category))].map((slug) => ({
          name: categories.get(slug) ?? slug,
          units: [...new Set(monthly.map((m) => m.month))].map((mo) => Number(monthly.find((m) => m.month === mo && m.category === slug)?.units ?? 0)),
        })),
      },
    };
  }

  /* ---------- returns ---------- */

  async returns(days: number) {
    const r = rangeOf(days);
    const rows = await this.db.returnRequest.findMany({
      where: { createdAt: { gte: r.from } },
      include: { items: { include: { orderItem: { include: { product: { select: { name: true, categorySlug: true } } } } } }, order: { select: { address: true, exchangeRate: true, shipments: { where: { kind: 'delivery', status: 'DELIVERED' }, select: { deliveredAt: true } } } } },
    });
    const live = rows.filter((x) => !['REJECTED', 'CANCELLED'].includes(x.status));
    const now = await this.orders(r.from, r.to);
    const sold = (await this.items(now.map((o) => o.id))).reduce((a, i) => a + i.qty, 0);
    const units = live.reduce((a, x) => a + x.items.reduce((b, i) => b + i.qty, 0), 0);
    const refunded = rows.filter((x) => x.status === 'REFUNDED');
    const refundUsd = refunded.reduce((a, x) => {
      const rate = x.order.exchangeRate == null ? null : Number(x.order.exchangeRate);
      return a + (x.refundBdt != null && rate ? Number(x.refundBdt) / rate : Number(x.refundUsd));
    }, 0);
    const lines = live.flatMap((x) => x.items.map((i) => ({ ...i, reason: x.reason, region: regionLabel(regionOf(x.order.address as OrderRow['address'])) })));
    const hoursTo = (a: (x: (typeof rows)[number]) => Date | null | undefined, b: (x: (typeof rows)[number]) => Date | null | undefined) => {
      const hs = rows.map((x) => (a(x) && b(x) ? (b(x)!.getTime() - a(x)!.getTime()) / 3600000 : null)).filter((h): h is number => h != null && h >= 0);
      return hs.length ? Math.round((hs.reduce((s, h) => s + h, 0) / hs.length) * 10) / 10 : null;
    };
    const categories = new Map((await this.db.category.findMany({ select: { slug: true, title: true } })).map((c) => [c.slug, c.title]));
    const group = (f: (l: (typeof lines)[number]) => string) =>
      [...tally(lines, f, (l) => l.qty).entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, units: n, share: pct(n, units) }));
    return {
      range: r,
      totals: {
        requests: rows.length,
        open: rows.filter((x) => ['REQUESTED', 'APPROVED', 'RECEIVED'].includes(x.status)).length,
        rejected: rows.filter((x) => x.status === 'REJECTED').length,
        unitsReturned: units,
        unitsSold: sold,
        returnRate: pct(units, sold),
        refunded: refunded.length,
        refundUsd: round2(refundUsd),
        refundBdt: round2(refunded.reduce((a, x) => a + Number(x.refundBdt ?? 0), 0)),
        restocked: lines.filter((l) => l.restocked === true).reduce((a, l) => a + l.qty, 0),
        writtenOff: lines.filter((l) => l.restocked === false).reduce((a, l) => a + l.qty, 0),
        hoursDeliveredToRequest: hoursTo((x) => x.order.shipments[0]?.deliveredAt, (x) => x.createdAt),
        hoursRequestToRefund: hoursTo((x) => x.createdAt, (x) => x.refundedAt),
      },
      byStatus: [...tally(rows, (x) => x.status, () => 1).entries()].map(([status, count]) => ({ status, count })),
      byReason: group((l) => l.reason),
      byCategory: group((l) => categories.get(l.orderItem.product.categorySlug) ?? l.orderItem.product.categorySlug),
      byProduct: group((l) => l.orderItem.product.name).slice(0, 10),
      byRegion: group((l) => l.region),
      // Sizes sent back for fit: a size that's mostly "too small" runs small.
      fit: [...tally(lines.filter((l) => l.reason === 'TOO_SMALL' || l.reason === 'TOO_LARGE'), (l) => l.orderItem.size, (l) => l.qty).entries()].map(([size]) => ({
        size,
        tooSmall: lines.filter((l) => l.orderItem.size === size && l.reason === 'TOO_SMALL').reduce((a, l) => a + l.qty, 0),
        tooLarge: lines.filter((l) => l.orderItem.size === size && l.reason === 'TOO_LARGE').reduce((a, l) => a + l.qty, 0),
      })),
    };
  }

  /* ---------- delivery ---------- */

  async delivery(days: number) {
    const r = rangeOf(days);
    const ships = await this.db.shipment.findMany({
      where: { kind: 'delivery', createdAt: { gte: r.from } },
      include: { events: { select: { status: true } }, rider: { include: { user: { select: { name: true } } } } },
    });
    const byCarrier = [...new Set(ships.map((s) => s.carrier))].map((carrier) => {
      const list = ships.filter((s) => s.carrier === carrier);
      const done = list.filter((s) => s.status === 'DELIVERED');
      const hours = done.filter((s) => s.deliveredAt).map((s) => (s.deliveredAt!.getTime() - s.createdAt.getTime()) / 3600000).sort((a, b) => a - b);
      const finished = list.filter((s) => ['DELIVERED', 'RETURNED'].includes(s.status)).length;
      return {
        carrier,
        shipments: list.length,
        delivered: done.length,
        onTheWay: list.filter((s) => !['DELIVERED', 'RETURNED', 'CANCELLED'].includes(s.status)).length,
        returned: list.filter((s) => s.status === 'RETURNED').length,
        cancelled: list.filter((s) => s.status === 'CANCELLED').length,
        // Of the parcels that reached an end, how many were delivered (a courier's success rate).
        successRate: pct(done.length, finished),
        withFailedAttempt: pct(list.filter((s) => s.events.some((e) => e.status === 'FAILED_ATTEMPT')).length, list.length),
        avgHours: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
        medianHours: hours.length ? Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10 : null,
        charges: round2(list.reduce((a, s) => a + Number(s.charge ?? 0), 0)),
        avgCharge: list.some((s) => s.charge != null) ? round2(list.reduce((a, s) => a + Number(s.charge ?? 0), 0) / list.filter((s) => s.charge != null).length) : null,
        codCollected: round2(done.reduce((a, s) => a + Number(s.codCollected ?? 0), 0)),
      };
    });
    const riders = [...new Set(ships.filter((s) => s.rider).map((s) => s.riderId!))].map((id) => {
      const list = ships.filter((s) => s.riderId === id);
      const done = list.filter((s) => s.status === 'DELIVERED');
      const hours = done.filter((s) => s.deliveredAt && s.pickedUpAt).map((s) => (s.deliveredAt!.getTime() - s.pickedUpAt!.getTime()) / 3600000);
      return {
        name: list[0].rider!.user.name,
        assigned: list.length,
        delivered: done.length,
        failedAttempts: list.filter((s) => s.events.some((e) => e.status === 'FAILED_ATTEMPT')).length,
        avgHoursPickupToDoor: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
        cashCollected: round2(done.reduce((a, s) => a + Number(s.codCollected ?? 0), 0)),
      };
    });
    const byRegion = [...tally(ships, (s) => regionLabel(regionOf({ city: (s.recipient as { city?: string }).city, country: 'Bangladesh', street: (s.recipient as { address?: string }).address })), () => 1).entries()].map(([name, n]) => {
      const list = ships.filter((s) => regionLabel(regionOf({ city: (s.recipient as { city?: string }).city, country: 'Bangladesh', street: (s.recipient as { address?: string }).address })) === name);
      const finished = list.filter((s) => ['DELIVERED', 'RETURNED'].includes(s.status)).length;
      return { name, shipments: n, successRate: pct(list.filter((s) => s.status === 'DELIVERED').length, finished) };
    });
    return { range: r, total: ships.length, byCarrier: byCarrier.sort((a, b) => b.shipments - a.shipments), riders: riders.sort((a, b) => b.delivered - a.delivered), byRegion: byRegion.sort((a, b) => b.shipments - a.shipments) };
  }

  /* ---------- AI costs ---------- */

  async aiCosts(days: number) {
    // The AI service's meter: one row per UTC day (it keeps 40), estimated at list prices.
    const want = Math.min(days, 40);
    const usage = (await callAi(`/usage?days=${want}`, { timeoutMs: 4000 }).catch(() => null)) as {
      days: Record<string, number | string>[];
      budgets?: Record<string, number>;
      models?: Record<string, string>;
    } | null;
    const rate = await this.db.storeSetting.findUnique({ where: { key: 'usdToBdt' } });
    const usdToBdt = Number(rate?.value) > 0 ? Number(rate?.value) : null;
    if (!usage) return { available: false, days: want, usdToBdt };
    const rows = usage.days.map((d) => ({ ...d, day: String(d.day) }));
    const f = (d: Record<string, unknown>, k: string) => Number(d[k] ?? 0);
    const features = [...new Set(rows.flatMap((d) => Object.keys(d).filter((k) => /^claude:[a-z-]+:cost$/.test(k)).map((k) => k.split(':')[1])))];
    const series = [...rows].reverse().map((d) => ({
      day: `${d.day.slice(0, 4)}-${d.day.slice(4, 6)}-${d.day.slice(6, 8)}`,
      claude: round4(f(d, 'claude:cost')),
      tryOn: round4(f(d, 'fashn:cost')),
      voice: round4(f(d, 'voice:cost')),
      total: round4(f(d, 'claude:cost') + f(d, 'fashn:cost') + f(d, 'voice:cost')),
    }));
    const total = series.reduce((a, d) => a + d.total, 0);
    const sumOf = (k: string) => rows.reduce((a, d) => a + f(d, k), 0);

    // Sales over the same UTC days, to put the spend in proportion.
    const from = new Date(`${series[0].day}T00:00:00Z`);
    const sales = await this.db.$queryRaw<{ orders: bigint; gross: number | null; shoppers: bigint }[]>`
      SELECT COUNT(*) AS orders, SUM(total)::float AS gross, COUNT(DISTINCT "userId") AS shoppers FROM "Order" o WHERE ${Prisma_sql(SOLD)} AND o."createdAt" >= ${ts(from)}::timestamp`;
    const orders = Number(sales[0]?.orders ?? 0);
    const gross = Number(sales[0]?.gross ?? 0);
    // This month so far (UTC), projected to the month's end at the same daily pace.
    const today = new Date();
    const monthPrefix = today.toISOString().slice(0, 7);
    const mtd = series.filter((d) => d.day.startsWith(monthPrefix)).reduce((a, d) => a + d.total, 0);
    const daysIn = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
    const cacheRead = sumOf('claude:cache_read');
    const input = sumOf('claude:input');

    return {
      available: true,
      days: want,
      note: 'Estimated from list prices by the AI service’s meter, per UTC day. The vendor’s invoice is the final word.',
      usdToBdt,
      total: round4(total),
      byVendor: [
        { name: 'Claude (Pip, suggestions, photo checks)', cost: round4(sumOf('claude:cost')), calls: sumOf('claude:calls') },
        { name: 'FASHN (AI try-on)', cost: round4(sumOf('fashn:cost')), calls: sumOf('fashn:renders'), credits: sumOf('fashn:credits') },
        { name: 'ElevenLabs (voice)', cost: round4(sumOf('voice:cost')), calls: sumOf('tts:calls') + sumOf('stt:calls') },
      ],
      byFeature: features.map((k) => ({ feature: k, cost: round4(sumOf(`claude:${k}:cost`)), calls: sumOf(`claude:${k}:calls`), perCall: sumOf(`claude:${k}:calls`) ? round4(sumOf(`claude:${k}:cost`) / sumOf(`claude:${k}:calls`)) : null })).sort((a, b) => b.cost - a.cost),
      tokens: {
        input,
        output: sumOf('claude:output'),
        cacheRead,
        cacheWrite: sumOf('claude:cache_write'),
        // Share of prompt tokens served from Anthropic's prompt cache (cheaper).
        cacheHitRate: pct(cacheRead, cacheRead + input),
        webSearches: sumOf('claude:searches'),
        speechSeconds: round2(sumOf('stt:seconds')),
        spokenChars: sumOf('tts:chars'),
      },
      // Paid calls answered from a cache instead.
      saved: Object.fromEntries(Object.keys(rows.reduce((a, d) => ({ ...a, ...d }), {})).filter((k) => k.startsWith('saved:')).map((k) => [k.slice(6), sumOf(k)])),
      perOrder: orders ? round4(total / orders) : null,
      perBuyer: Number(sales[0]?.shoppers ?? 0) ? round4(total / Number(sales[0]?.shoppers)) : null,
      shareOfSales: gross ? pct(total, gross) : null,
      orders,
      gross: round2(gross),
      monthToDate: round4(mtd),
      projectedMonth: round4((mtd / today.getUTCDate()) * daysIn),
      // Daily caps in dollars (0 = none): past one, the feature falls back to its free version for the day.
      caps: usage.budgets ?? null,
      today: series.at(-1) ?? null,
      models: usage.models ?? null,
      series,
    };
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** A fixed SQL fragment from this file (never user input). */
function Prisma_sql(s: string): Prisma.Sql {
  return Prisma.raw(s);
}
