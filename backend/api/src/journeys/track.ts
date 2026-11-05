import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { env } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Geo } from './geo.js';

/*
 * Visitor journeys, built so tracking never slows the store down:
 * - The browser batches page changes and sends them when the shopper moves on or hides the tab.
 * - POST /track checks the batch, adds location and device, and appends it to a Redis list: one round trip,
 *   no database work on the request.
 * - Every FLUSH_MS this worker takes up to BATCH items off the list and writes them in a handful of set-based
 *   statements. Any number of API instances can run it: LPOP hands each item to exactly one of them.
 */
export const QUEUE = 'track:q';
/** Users whose shopper profile should be rebuilt (see ProfileService). */
export const DIRTY = 'profile:dirty';
const MAX_QUEUE = 200_000; // if the worker ever falls this far behind, the oldest items are dropped, not the API
const BATCH = 1000;
const FLUSH_MS = 2000;

export interface TrackPage {
  seq: number;
  path: string;
  route: string;
  at: number;
  ms: number;
  scroll?: number;
}
export interface TrackStart {
  landing: string;
  referrer: string | null;
  source: string;
  medium: string | null;
  campaign: string | null;
  device: string;
  browser: string;
  os: string;
  geo: Geo;
  timeZone: string | null;
  locale: string | null;
}
export interface TrackItem {
  visitId: string;
  visitorId: string;
  userId: string | null;
  start: TrackStart | null;
  pages: TrackPage[];
  at: number;
}

@Injectable()
export class TrackQueue {
  constructor(private readonly redis: RedisService) {}

  async push(item: TrackItem) {
    await this.redis.multi().rpush(QUEUE, JSON.stringify(item)).ltrim(QUEUE, -MAX_QUEUE, -1).exec();
  }
}

const ts = (ms: number) => new Date(ms).toISOString();

@Injectable()
export class JourneyWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('Journeys');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush().catch((e) => this.log.warn(`Flush failed: ${(e as Error).message}`)), FLUSH_MS);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => undefined);
  }

  /** Writes what's waiting. Returns how many batches it took off the queue. Safe to call any time. */
  flush(): Promise<number> {
    this.running ??= this.drain().finally(() => (this.running = null));
    return this.running;
  }

  private async drain() {
    let total = 0;
    for (let round = 0; round < 10; round++) {
      const raw = (await this.redis.lpop(QUEUE, BATCH)) ?? [];
      if (!raw.length) break;
      const items = raw.flatMap((r) => {
        try {
          return [JSON.parse(r) as TrackItem];
        } catch {
          return [];
        }
      });
      try {
        await this.write(items);
      } catch (e) {
        // One bad batch is dropped rather than retried forever; it's analytics, not orders.
        this.log.warn(`${items.length} tracking items not saved: ${(e as Error).message}`);
      }
      total += items.length;
      if (raw.length < BATCH) break;
    }
    if (Math.random() < 0.002) void this.purge().catch(() => undefined);
    return total;
  }

  private async write(items: TrackItem[]) {
    // A user deleted while their batch waited would break the whole insert.
    const userIds = [...new Set(items.map((i) => i.userId).filter((x): x is string => !!x))];
    const users = new Set(
      userIds.length ? (await this.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true } })).map((u) => u.id) : [],
    );

    const visits = new Map<string, { id: string; visitorId: string; userId: string | null; first: number; last: number; start: TrackStart | null; landing: string }>();
    const pages = new Map<string, TrackPage & { visitId: string }>();
    for (const i of items) {
      const userId = i.userId && users.has(i.userId) ? i.userId : null;
      const first = Math.min(i.at, ...i.pages.map((p) => p.at));
      const last = Math.max(i.at, ...i.pages.map((p) => p.at + p.ms));
      const firstPath = [...i.pages].sort((a, b) => a.seq - b.seq)[0]?.path ?? i.start?.landing ?? '/';
      const v = visits.get(i.visitId);
      if (!v) visits.set(i.visitId, { id: i.visitId, visitorId: i.visitorId, userId, first, last, start: i.start, landing: i.start?.landing ?? firstPath });
      else {
        v.userId ??= userId;
        v.first = Math.min(v.first, first);
        v.last = Math.max(v.last, last);
        v.start ??= i.start;
      }
      for (const p of i.pages) {
        const key = `${i.visitId}:${p.seq}`;
        const had = pages.get(key);
        // The same page is sent again when the shopper comes back to the tab: keep the longest time and scroll.
        const scroll = had?.scroll == null ? p.scroll : p.scroll == null ? had.scroll : Math.max(had.scroll, p.scroll);
        pages.set(key, had ? { ...had, ms: Math.max(had.ms, p.ms), scroll } : { ...p, visitId: i.visitId });
      }
    }

    const full = [...visits.values()].filter((v) => v.start);
    const partial = [...visits.values()].filter((v) => !v.start);
    const row = (v: (typeof full)[number]) => ({
      id: v.id,
      visitorId: v.visitorId,
      userId: v.userId,
      startedAt: ts(v.first),
      lastSeenAt: ts(v.last),
      landing: v.landing,
      referrer: v.start?.referrer ?? null,
      source: v.start?.source ?? 'direct',
      medium: v.start?.medium ?? null,
      campaign: v.start?.campaign ?? null,
      device: v.start?.device ?? null,
      browser: v.start?.browser ?? null,
      os: v.start?.os ?? null,
      country: v.start?.geo.country ?? null,
      region: v.start?.geo.region ?? null,
      city: v.start?.geo.city ?? null,
      geoSource: v.start?.geo.source ?? null,
      timeZone: v.start?.timeZone ?? null,
      locale: v.start?.locale ?? null,
    });
    const recordset = Prisma.sql`x(id text, "visitorId" text, "userId" text, "startedAt" timestamp, "lastSeenAt" timestamp, landing text,
      referrer text, source text, medium text, campaign text, device text, browser text, os text, country text, region text,
      city text, "geoSource" text, "timeZone" text, locale text)`;
    const columns = Prisma.sql`(id, "visitorId", "userId", "startedAt", "lastSeenAt", landing, referrer, source, medium, campaign,
      device, browser, os, country, region, city, "geoSource", "timeZone", locale)`;

    await this.db.$transaction(async (tx) => {
      if (full.length) {
        // The visit's first batch: everything about where it came from (it may arrive after its pages).
        await tx.$executeRaw`
          INSERT INTO "Visit" ${columns}
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(full.map(row))}::jsonb) AS ${recordset}
          ON CONFLICT (id) DO UPDATE SET
            "userId" = COALESCE("Visit"."userId", EXCLUDED."userId"),
            "startedAt" = LEAST("Visit"."startedAt", EXCLUDED."startedAt"),
            "lastSeenAt" = GREATEST("Visit"."lastSeenAt", EXCLUDED."lastSeenAt"),
            landing = EXCLUDED.landing, referrer = EXCLUDED.referrer, source = EXCLUDED.source, medium = EXCLUDED.medium,
            campaign = EXCLUDED.campaign, device = EXCLUDED.device, browser = EXCLUDED.browser, os = EXCLUDED.os,
            country = EXCLUDED.country, region = EXCLUDED.region, city = EXCLUDED.city, "geoSource" = EXCLUDED."geoSource",
            "timeZone" = EXCLUDED."timeZone", locale = EXCLUDED.locale`;
      }
      if (partial.length) {
        await tx.$executeRaw`
          INSERT INTO "Visit" ${columns}
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(partial.map(row))}::jsonb) AS ${recordset}
          ON CONFLICT (id) DO UPDATE SET
            "userId" = COALESCE("Visit"."userId", EXCLUDED."userId"),
            "startedAt" = LEAST("Visit"."startedAt", EXCLUDED."startedAt"),
            "lastSeenAt" = GREATEST("Visit"."lastSeenAt", EXCLUDED."lastSeenAt")`;
      }
      if (pages.size) {
        const rows = [...pages.values()].map((p) => ({ visitId: p.visitId, seq: p.seq, path: p.path, route: p.route, enteredAt: ts(p.at), activeMs: p.ms, scrollPct: p.scroll ?? null }));
        await tx.$executeRaw`
          INSERT INTO "PageView" ("visitId", seq, path, route, "enteredAt", "activeMs", "scrollPct")
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
            AS x("visitId" text, seq int, path text, route text, "enteredAt" timestamp, "activeMs" int, "scrollPct" int)
          ON CONFLICT ("visitId", seq) DO UPDATE SET
            "activeMs" = GREATEST("PageView"."activeMs", EXCLUDED."activeMs"),
            "scrollPct" = GREATEST("PageView"."scrollPct", EXCLUDED."scrollPct")`;
      }
      // Totals and the exit page, from the pages themselves, so they're right however batches arrive.
      await tx.$executeRaw`
        UPDATE "Visit" v SET "pageCount" = a.n, "activeMs" = a.ms, "exitPath" = a.exit,
          "lastSeenAt" = GREATEST(v."lastSeenAt", a.last)
        FROM (
          SELECT "visitId", count(*)::int AS n, LEAST(sum("activeMs"), 2147483647)::int AS ms,
            (array_agg(path ORDER BY seq DESC))[1] AS exit,
            max("enteredAt" + "activeMs" * interval '1 millisecond') AS last
          FROM "PageView" WHERE "visitId" = ANY(${[...visits.keys()]}::text[]) GROUP BY "visitId"
        ) a
        WHERE v.id = a."visitId"`;
    });

    const touched = [...new Set([...visits.values()].map((v) => v.userId).filter((x): x is string => !!x))];
    if (touched.length) await this.redis.sadd(DIRTY, ...touched);
  }

  /** Deletes visits (and their pages) past the retention period, a slice at a time. */
  async purge() {
    if ((await this.redis.set('track:purge', '1', 'EX', 6 * 3600, 'NX')) !== 'OK') return 0;
    let deleted = 0;
    for (let i = 0; i < 50; i++) {
      const n = await this.db.$executeRaw`
        DELETE FROM "Visit" WHERE id IN (
          SELECT id FROM "Visit" WHERE "startedAt" < now() - make_interval(days => ${env.trackRetentionDays}::int) LIMIT 5000)`;
      deleted += n;
      if (n < 5000) break;
    }
    if (deleted) this.log.log(`Deleted ${deleted} visits older than ${env.trackRetentionDays} days`);
    return deleted;
  }
}
