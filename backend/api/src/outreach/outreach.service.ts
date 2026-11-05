/*
 * Outreach: from "what shoppers wanted and didn't get" and "what they liked" to an email that brings them back.
 *
 * A worker on every API instance (one at a time, by a Redis lock) runs every TICK_MS:
 *   1. wants:inbox → ShopperWant rows (signed-in shoppers with personalisation on; repeats within 30 days merge);
 *   2. outreach:changes → matches: a restock answers sold-out wants and favourites (back_in_stock), a price drop
 *      answers favourites, cart adds and repeat views (price_drop), a new or updated product answers search and
 *      chat wants it really fits (found_it: a strong search score, a shared word, the colour they named);
 *   3. hourly, carts left for a day (cart); daily, new arrivals that score high for a shopper (picked_for_you);
 *   4. queued emails whose shopper hasn't had one for capDays get sent.
 * Emails are drafted only for shoppers who opted in, at most one waiting per shopper (new products join it), never a
 * product they were told about in the last 30 days. Each kind is a draft for staff (Admin → Emails) until it's
 * switched to automatic in the settings.
 */
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { env } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { colourFamily, rankByLikeness, type Preferences, type TasteLike } from '../journeys/likeness.js';
import { ProfileService } from '../journeys/profile.js';
import { categoryMedians } from '../journeys/taste.js';
import { KINDS, Mailer, PRIORITY, renderEmail, type Kind } from './email.js';
import { CHANGES, drain, WANTS_INBOX, type CatalogChange, type WantNote } from './inbox.js';

const TICK_MS = 60_000;
const SETTINGS_KEY = 'outreach';
const WANT_DAYS = 90;
const REPEAT_DAYS = 30;
const MAX_PRODUCTS = 4;
/** A search score this high, plus a shared word, before telling a shopper "we found what you looked for". */
export const FOUND_SCORE = 0.28;

export interface OutreachSettings {
  /** Kinds that send without staff (still within the frequency cap). */
  auto: Record<Kind, boolean>;
  /** At most one email per shopper in this many days. */
  capDays: number;
  /** Picks need a likeness at least this high (0–1). */
  minLikeness: number;
}
export const DEFAULT_SETTINGS: OutreachSettings = {
  auto: Object.fromEntries(KINDS.map((k) => [k, false])) as Record<Kind, boolean>,
  capDays: 3,
  minLikeness: 0.55,
};
export interface Pick {
  productId: number;
  reason: string;
  score?: number;
  was?: number;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'a', 'an', 'of', 'in', 'on', 'to', 'my', 'me', 'i', 'some', 'any', 'under', 'below', 'over', 'less', 'than', 'cheap', 'size', 'want', 'need', 'looking', 'show', 'something', 'like', 'please', 'new', 'nice', 'good', 'best']);
const COLOUR_WORDS = new Set(['black', 'white', 'grey', 'gray', 'beige', 'cream', 'brown', 'tan', 'red', 'maroon', 'pink', 'orange', 'yellow', 'gold', 'green', 'olive', 'blue', 'navy', 'purple']);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{M}\p{N}]+/u) // \p{M}: Bangla and Hindi vowel signs are marks, not letters
    .map((t) => t.replace(/(es|s)$/, '')) // shoes → shoe, dresses → dress
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
const FAMILY_OF_WORD: Record<string, string> = { gray: 'grey', cream: 'beige', tan: 'brown', maroon: 'red', gold: 'yellow', olive: 'green' };

/** Does a product really answer what they asked for? Shared words, and the colour they named if they named one. */
export function answers(want: string, p: { name: string; type: string; label: string; keywords: string[]; styleTags: string[]; colors: { name: string; hex: string }[] }) {
  const words = tokens(want);
  const colours = want
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => COLOUR_WORDS.has(w))
    .map((w) => FAMILY_OF_WORD[w] ?? w);
  const own = new Set(tokens([p.name, p.type, p.label, ...p.keywords, ...p.styleTags, ...p.colors.map((c) => c.name)].join(' ')));
  const nouns = words.filter((w) => !COLOUR_WORDS.has(w));
  const shared = nouns.filter((w) => own.has(w));
  if (!nouns.length || !shared.length) return false;
  if (colours.length) {
    const families = new Set(p.colors.map((c) => colourFamily(c.hex)));
    const names = p.colors.map((c) => c.name.toLowerCase());
    if (!colours.some((c) => families.has(c as never) || names.some((n) => n.includes(c)))) return false;
  }
  return true;
}

@Injectable()
export class OutreachService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('Outreach');
  private timer: NodeJS.Timeout | null = null;
  readonly mailer = new Mailer();

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly profiles: ProfileService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return; // tests call tick() themselves
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn(`Outreach tick failed: ${(e as Error).message}`)), TICK_MS);
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------------- settings ---------------- */

  async settings(): Promise<OutreachSettings> {
    const row = await this.db.storeSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = (row?.value ?? {}) as Partial<OutreachSettings>;
    return { ...DEFAULT_SETTINGS, ...v, auto: { ...DEFAULT_SETTINGS.auto, ...(v.auto ?? {}) } };
  }
  async saveSettings(patch: Partial<OutreachSettings>) {
    const current = await this.settings();
    const next = { ...current, ...patch, auto: { ...current.auto, ...(patch.auto ?? {}) } };
    const value = next as unknown as Prisma.InputJsonObject;
    await this.db.storeSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
    // Kinds just switched to automatic: their waiting drafts go too.
    const nowAuto = KINDS.filter((k) => next.auto[k] && !current.auto[k]);
    if (nowAuto.length) await this.db.outreach.updateMany({ where: { status: 'draft', kind: { in: nowAuto } }, data: { status: 'queued' } });
    return next;
  }

  /* ---------------- the worker ---------------- */

  /** One round of everything; returns what it did. Safe to call any time (Admin → Emails → Check now). */
  async tick() {
    const lock = await this.redis.set('outreach:lock', String(process.pid), 'EX', 300, 'NX').catch(() => null);
    if (lock !== 'OK') return null;
    try {
      const wants = await this.recordWants(await drain<WantNote>(this.redis, WANTS_INBOX));
      const changes = await drain<CatalogChange>(this.redis, CHANGES);
      const matched = await this.processChanges(changes);
      let carts = 0;
      let picks = 0;
      if ((await this.redis.set(`outreach:carts:${new Date().toISOString().slice(0, 13)}`, '1', 'EX', 7200, 'NX')) === 'OK') carts = await this.cartReminders();
      if ((await this.redis.set(`outreach:picks:${new Date().toISOString().slice(0, 10)}`, '1', 'EX', 172800, 'NX')) === 'OK') picks = await this.newArrivalPicks();
      const sent = await this.sendDue();
      return { wants, changes: changes.length, matched, carts, picks, ...sent };
    } finally {
      await this.redis.del('outreach:lock').catch(() => 0);
    }
  }

  /* ---------------- wants ---------------- */

  async recordWants(notes: WantNote[]) {
    let n = 0;
    for (const w of notes) {
      const user = await this.db.user.findUnique({ where: { id: w.userId }, select: { role: true, personalise: true, disabledAt: true } });
      if (!user || user.role !== 'CUSTOMER' || !user.personalise || user.disabledAt) continue;
      const since = new Date(Date.now() - REPEAT_DAYS * 864e5);
      const text = w.text.trim().slice(0, 160);
      const dupe = await this.db.shopperWant.findFirst({
        where: {
          userId: w.userId,
          closedAt: null,
          createdAt: { gte: since },
          ...(w.productId ? { productId: w.productId } : { source: w.source, text: { equals: text, mode: 'insensitive' } }),
        },
      });
      if (dupe) continue;
      await this.db.shopperWant.create({ data: { userId: w.userId, source: w.source, text, productId: w.productId ?? null } });
      n++;
    }
    return n;
  }

  /** The AI service's semantic search, with what it understood (price, colour); null when it's unreachable. */
  private async search(q: string) {
    try {
      const res = await fetch(`${env.aiServiceUrl}/search?q=${encodeURIComponent(q)}&limit=5`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      return (await res.json()) as { results: { id: number; score: number }[]; filters?: { maxPrice?: number; minPrice?: number } };
    } catch {
      return null;
    }
  }

  async processChanges(changes: CatalogChange[]) {
    if (!changes.length) return 0;
    const byProduct = new Map<number, { kinds: Set<string>; was?: number }>();
    for (const c of changes) {
      const e = byProduct.get(c.productId) ?? { kinds: new Set<string>() };
      c.kinds.forEach((k) => e.kinds.add(k));
      if (c.was != null) e.was = Math.max(e.was ?? 0, c.was);
      byProduct.set(c.productId, e);
    }
    const products = await this.db.product.findMany({ where: { id: { in: [...byProduct.keys()] }, active: true, stock: { gt: 0 } } });
    let matched = 0;
    const since = new Date(Date.now() - REPEAT_DAYS * 864e5);
    for (const p of products) {
      const e = byProduct.get(p.id)!;
      if (e.kinds.has('restock')) {
        const wants = await this.db.shopperWant.findMany({ where: { productId: p.id, closedAt: null, matchedAt: null } });
        const favs = await this.db.favourite.findMany({ where: { productId: p.id }, select: { userId: true } });
        const users = new Map<string, number[]>();
        for (const w of wants) users.set(w.userId, [...(users.get(w.userId) ?? []), w.id]);
        for (const f of favs) if (!users.has(f.userId)) users.set(f.userId, []);
        if (wants.length) await this.db.shopperWant.updateMany({ where: { id: { in: wants.map((w) => w.id) } }, data: { matchedProductId: p.id, matchedAt: new Date() } });
        for (const [userId, wantIds] of users) {
          if (await this.bought(userId, p.id)) continue;
          if (await this.propose(userId, 'back_in_stock', [{ productId: p.id, reason: wantIds.length ? 'They viewed it while it was sold out' : 'In their favourites' }], wantIds)) matched++;
        }
      }
      if (e.kinds.has('price_drop') && e.was && e.was > Number(p.price)) {
        const interested = await this.db.$queryRaw<{ userId: string; why: string }[]>`
          SELECT "userId", 'In their favourites' AS why FROM "Favourite" WHERE "productId" = ${p.id}
          UNION
          SELECT "userId", CASE WHEN bool_or(type = 'cart_add') THEN 'Added it to their bag' ELSE 'Looked at it ' || count(*) || ' times' END
          FROM "DemandEvent" WHERE "productId" = ${p.id} AND "userId" IS NOT NULL AND "createdAt" >= ${since}
          GROUP BY "userId" HAVING bool_or(type = 'cart_add') OR count(*) FILTER (WHERE type = 'view') >= 2`;
        const seen = new Set<string>();
        for (const u of interested) {
          if (seen.has(u.userId) || (await this.bought(u.userId, p.id))) continue;
          seen.add(u.userId);
          if (await this.propose(u.userId, 'price_drop', [{ productId: p.id, reason: `${u.why}; now $${Number(p.price)} (was $${e.was})`, was: e.was }])) matched++;
        }
      }
    }
    const fresh = products.filter((p) => ['new', 'updated', 'restock'].some((k) => byProduct.get(p.id)!.kinds.has(k)));
    if (fresh.length) matched += await this.matchWants(fresh);
    return matched;
  }

  /** Open search, chat and request wants that one of these products now answers. */
  async matchWants(candidates: { id: number; name: string; type: string; label: string; keywords: string[]; styleTags: string[]; colors: unknown; price: unknown }[]) {
    const ids = new Set(candidates.map((p) => p.id));
    const byId = new Map(candidates.map((p) => [p.id, p]));
    const wants = await this.db.shopperWant.findMany({
      where: { closedAt: null, matchedAt: null, source: { in: ['search', 'chat', 'request'] }, createdAt: { gte: new Date(Date.now() - WANT_DAYS * 864e5) } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    let matched = 0;
    const searches = new Map<string, Awaited<ReturnType<OutreachService['search']>>>();
    for (const w of wants) {
      const key = w.text.toLowerCase();
      if (!searches.has(key)) searches.set(key, await this.search(w.text));
      const found = searches.get(key);
      const fits = (p: (typeof candidates)[number]) => answers(w.text, { ...p, colors: p.colors as { name: string; hex: string }[] });
      // With the AI service down, the strict word-and-colour check alone decides.
      const hit = found
        ? found.results.slice(0, 3).find((r) => ids.has(r.id) && r.score >= FOUND_SCORE && fits(byId.get(r.id)!))
        : candidates.filter(fits).map((p) => ({ id: p.id, score: 0 }))[0];
      if (!hit) continue;
      const p = byId.get(hit.id)!;
      if (found?.filters?.maxPrice && Number(p.price) > found.filters.maxPrice) continue;
      await this.db.shopperWant.update({ where: { id: w.id }, data: { matchedProductId: p.id, matchedAt: new Date() } });
      const asked = w.source === 'chat' ? 'Asked Pip for' : w.source === 'request' ? 'Requested' : 'Searched for';
      if (await this.propose(w.userId, 'found_it', [{ productId: p.id, reason: `${asked} “${w.text}”`, score: hit.score || undefined }], [w.id])) matched++;
    }
    return matched;
  }

  private async bought(userId: string, productId: number) {
    return !!(await this.db.orderItem.findFirst({ where: { productId, order: { userId, status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] } } }, select: { id: true } }));
  }

  /** Bags with something in them, last added to 24–72 hours ago, with no order since. */
  async cartReminders() {
    const rows = await this.db.$queryRaw<{ userId: string; last: Date }[]>`
      SELECT "userId", max("createdAt") AS last FROM "DemandEvent"
      WHERE type = 'cart_add' AND "userId" IS NOT NULL AND "createdAt" >= now() - interval '72 hours'
      GROUP BY "userId" HAVING max("createdAt") <= now() - interval '24 hours'`;
    let n = 0;
    for (const r of rows) {
      const ordered = await this.db.order.count({ where: { userId: r.userId, createdAt: { gte: r.last } } });
      if (ordered) continue;
      const lines = Object.values(await this.redis.hgetall(`cart:${r.userId}`).catch(() => ({}) as Record<string, string>));
      const ids = [...new Set(lines.flatMap((l) => { try { return [Number((JSON.parse(l) as { productId: number }).productId)]; } catch { return []; } }))];
      if (!ids.length) continue;
      if (await this.propose(r.userId, 'cart', ids.slice(0, MAX_PRODUCTS).map((productId) => ({ productId, reason: 'Still in their bag after a day' })))) n++;
    }
    return n;
  }

  /** Once a day: products added in the last 14 days that score high for an opted-in shopper. */
  async newArrivalPicks() {
    const s = await this.settings();
    const all = await this.profiles.products();
    const fresh = all.filter((p) => p.createdAt.getTime() >= Date.now() - 14 * 864e5);
    if (!fresh.length) return 0;
    const medians = categoryMedians(all);
    const shoppers = await this.db.shopperPreferences.findMany({
      where: { marketingEmails: true, user: { disabledAt: null, role: 'CUSTOMER', personalise: true, profile: { evidence: { gte: 3 } } } },
      include: { user: { select: { profile: true } } },
      take: 2000,
    });
    let n = 0;
    for (const sp of shoppers) {
      const recent = await this.db.outreach.count({ where: { userId: sp.userId, createdAt: { gte: new Date(Date.now() - 7 * 864e5) } } });
      if (recent) continue;
      const seen = new Set(
        (await this.db.demandEvent.findMany({ where: { userId: sp.userId, productId: { in: fresh.map((p) => p.id) } }, select: { productId: true } })).map((e) => e.productId!),
      );
      const ranked = rankByLikeness(sp.user.profile as unknown as TasteLike, prefsOf(sp), fresh, { exclude: seen, medians, limit: 3 }).filter((r) => r.score >= s.minLikeness);
      if (!ranked.length) continue;
      if (await this.propose(sp.userId, 'picked_for_you', ranked.map((r) => ({ productId: r.id, reason: r.reasons.join('; ') || 'Matches what they like', score: r.score })))) n++;
    }
    return n;
  }

  /* ---------------- drafting ---------------- */

  /**
   * Adds products to the shopper's waiting email (or starts one). Nothing for shoppers who didn't opt in, products
   * that can't be bought, or products they were told about in the last 30 days. Returns the email, or null.
   */
  async propose(userId: string, kind: Kind, picks: Pick[], wantIds: number[] = []) {
    const prefs = await this.db.shopperPreferences.findUnique({ where: { userId }, include: { user: { select: { role: true, disabledAt: true } } } });
    if (!prefs?.marketingEmails || prefs.user.role !== 'CUSTOMER' || prefs.user.disabledAt) return null;
    const since = new Date(Date.now() - REPEAT_DAYS * 864e5);
    const told = new Set(
      (await this.db.outreach.findMany({ where: { userId, createdAt: { gte: since }, status: { in: ['sent', 'skipped'] } }, select: { productIds: true } })).flatMap((o) => o.productIds),
    );
    const buyable = new Set(
      (await this.db.product.findMany({ where: { id: { in: picks.map((p) => p.productId) }, active: true, stock: { gt: 0 } }, select: { id: true } })).map((p) => p.id),
    );
    const fresh = picks.filter((p) => buyable.has(p.productId) && !told.has(p.productId));
    if (!fresh.length) return null;

    const pending = await this.db.outreach.findFirst({ where: { userId, status: { in: ['draft', 'queued'] } }, orderBy: { createdAt: 'desc' } });
    const s = await this.settings();
    if (pending) {
      const have = new Set(pending.productIds);
      const add = fresh.filter((p) => !have.has(p.productId));
      const lead = PRIORITY[kind] > PRIORITY[pending.kind as Kind] ? kind : (pending.kind as Kind);
      const productIds = lead === kind ? [...add.map((p) => p.productId), ...pending.productIds] : [...pending.productIds, ...add.map((p) => p.productId)];
      const reasons = [...(pending.reasons as unknown as Pick[]), ...add.map((p) => ({ ...p, kind }))];
      return this.db.outreach.update({
        where: { id: pending.id },
        data: {
          kind: lead,
          productIds: productIds.slice(0, MAX_PRODUCTS),
          reasons: reasons as unknown as Prisma.InputJsonArray,
          wantIds: [...new Set([...pending.wantIds, ...wantIds])],
          subject: await this.subjectFor(lead, productIds.slice(0, MAX_PRODUCTS), prefs.emailLang),
          status: pending.status === 'queued' || s.auto[lead] ? 'queued' : 'draft',
        },
      });
    }
    const productIds = fresh.slice(0, MAX_PRODUCTS).map((p) => p.productId);
    return this.db.outreach.create({
      data: {
        userId,
        kind,
        status: s.auto[kind] ? 'queued' : 'draft',
        productIds,
        reasons: fresh.map((p) => ({ ...p, kind })) as unknown as Prisma.InputJsonArray,
        wantIds,
        subject: await this.subjectFor(kind, productIds, prefs.emailLang),
      },
    });
  }

  private async subjectFor(kind: Kind, productIds: number[], lang: string) {
    return (await this.render({ kind, productIds, reasons: [], token: 'x' }, { name: '', emailLang: lang, unsubscribeToken: 'x' }))?.subject ?? '';
  }

  private async rate() {
    const r = await this.db.storeSetting.findUnique({ where: { key: 'usdToBdt' } });
    return typeof r?.value === 'number' ? r.value : Number(r?.value) || null;
  }

  /** The email as it would go out now (products that are no longer buyable drop out). */
  async render(o: { kind: string; productIds: number[]; reasons: unknown; token: string }, who: { name: string; emailLang: string; unsubscribeToken: string }) {
    const products = await this.db.product.findMany({ where: { id: { in: o.productIds }, active: true, stock: { gt: 0 } } });
    const order = new Map(o.productIds.map((id, i) => [id, i]));
    products.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    if (!products.length) return null;
    const was = new Map(((o.reasons ?? []) as Pick[]).filter((r) => r.was).map((r) => [r.productId, r.was!]));
    const base = env.publicUrl;
    return renderEmail({
      kind: o.kind as Kind,
      lang: who.emailLang,
      name: who.name,
      rate: await this.rate(),
      products: products.map((p) => ({ id: p.id, name: p.name, image: p.image, price: Number(p.price), compareAt: p.compareAt == null ? null : Number(p.compareAt), was: was.get(p.id) ?? null })),
      link: (id) => `${base}/api/v1/o/c/${o.token}?p=${id}`,
      unsubscribeUrl: `${base}/api/v1/o/u/${who.unsubscribeToken}`,
    });
  }

  /* ---------------- sending ---------------- */

  /**
   * Sends queued emails whose shopper is past the frequency cap (and, with `ids`, queues those drafts first).
   * Returns how many went, how many wait for the cap, and how many failed or were dropped.
   */
  async sendDue(ids?: number[], decidedBy?: string) {
    if (ids?.length) await this.db.outreach.updateMany({ where: { id: { in: ids }, status: 'draft' }, data: { status: 'queued', decidedBy: decidedBy ?? null } });
    const s = await this.settings();
    const queued = await this.db.outreach.findMany({
      where: { status: 'queued', ...(ids?.length ? { id: { in: ids } } : {}) },
      include: { user: { select: { name: true, email: true, disabledAt: true, preferences: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const out = { sent: 0, waiting: 0, failed: 0, dropped: 0 };
    for (const o of queued) {
      const prefs = o.user.preferences;
      if (!prefs?.marketingEmails || o.user.disabledAt) {
        await this.db.outreach.update({ where: { id: o.id }, data: { status: 'skipped', error: 'They turned emails off.' } });
        out.dropped++;
        continue;
      }
      const last = await this.db.outreach.findFirst({ where: { userId: o.userId, status: 'sent' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
      if (last?.sentAt && last.sentAt.getTime() > Date.now() - s.capDays * 864e5) {
        out.waiting++;
        continue;
      }
      const mail = await this.render(o, { name: o.user.name, emailLang: prefs.emailLang, unsubscribeToken: prefs.unsubscribeToken });
      if (!mail) {
        await this.db.outreach.update({ where: { id: o.id }, data: { status: 'skipped', error: 'Its products are sold out or hidden now.' } });
        out.dropped++;
        continue;
      }
      try {
        await this.mailer.send({ to: o.user.email, ...mail, unsubscribeUrl: `${env.publicUrl}/api/v1/o/u/${prefs.unsubscribeToken}` });
        await this.db.outreach.update({ where: { id: o.id }, data: { status: 'sent', sentAt: new Date(), subject: mail.subject, error: null } });
        await this.db.shopperWant.updateMany({ where: { id: { in: o.wantIds } }, data: { closedAt: new Date(), closedReason: 'told' } });
        out.sent++;
      } catch (e) {
        await this.db.outreach.update({ where: { id: o.id }, data: { status: 'failed', error: (e as Error).message.slice(0, 300) } });
        out.failed++;
      }
    }
    return out;
  }

  async skip(ids: number[], decidedBy: string) {
    const r = await this.db.outreach.updateMany({ where: { id: { in: ids }, status: { in: ['draft', 'queued', 'failed'] } }, data: { status: 'skipped', decidedBy } });
    return { skipped: r.count };
  }

  /** A click in an email: counted, then on to the product with UTM tags (visitor journeys pick them up). */
  async click(token: string, productId: number) {
    const o = await this.db.outreach.findUnique({ where: { token } });
    if (o) await this.db.outreach.update({ where: { id: o.id }, data: { clicks: { increment: 1 }, clickedAt: o.clickedAt ?? new Date() } });
    const known = o?.productIds.includes(productId) ? productId : o?.productIds[0];
    const qs = `utm_source=email&utm_medium=outreach&utm_campaign=${o?.kind ?? 'email'}`;
    return known ? `${env.storefrontUrl}/product/${known}?${qs}` : `${env.storefrontUrl}/?${qs}`;
  }

  /** The link in every email: emails off, and anything waiting for them is dropped. */
  async unsubscribe(token: string) {
    const prefs = await this.db.shopperPreferences.findUnique({ where: { unsubscribeToken: token } });
    if (!prefs) return false;
    await this.db.shopperPreferences.update({ where: { userId: prefs.userId }, data: { marketingEmails: false } });
    await this.db.outreach.updateMany({ where: { userId: prefs.userId, status: { in: ['draft', 'queued'] } }, data: { status: 'skipped', error: 'They unsubscribed.' } });
    return true;
  }
}

export function prefsOf(p: { skinTone: number | null; undertone: string | null; sizes: unknown; fit: string | null } | null | undefined): Preferences | null {
  if (!p) return null;
  return { skinTone: p.skinTone, undertone: p.undertone, sizes: (p.sizes ?? {}) as Record<string, string>, fit: p.fit };
}
