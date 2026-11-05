import { Controller, Get, HttpCode, Injectable, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional } from 'class-validator';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { NOT_SOLD, REFUND_DUE } from './sales.js';
import { NEEDS_ATTENTION } from '../delivery/delivery.service.js';
import { callAi } from '../common/ai.js';
import { Needs, Staff } from '../common/auth.js';
import { toAdminProduct } from '../common/serialize.js';
import type { Prisma } from '../generated/prisma/client.js';
import { env, pricing } from '../config.js';
import { AiIndexService } from '../common/ai-index.js';
import { rangeOf } from '../analytics/analytics.service.js';
import { LOW_STOCK } from './catalog.js';

export class StatsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @IsIn([7, 30, 90]) days?: 7 | 30 | 90;
}

const DAY = 864e5;
const round2 = (n: number) => Math.round(n * 100) / 100;
// Percentage change vs the previous period; null when there's nothing to compare with.
const change = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 1000) / 10 : null);
// Prisma stores timestamps as UTC in "timestamp without time zone" columns; casting an
// ISO string (which Postgres reads as wall-clock time) keeps raw queries in the same frame.
const ts = (d: Date) => d.toISOString();

@Injectable()
export class DashboardService {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly ai: AiIndexService,
  ) {}

  async stats(days = 30) {
    // Days in the store's time zone, the same as the analytics pages.
    const { from, prevFrom, offset } = rangeOf(days);
    const paid = { status: { notIn: NOT_SOLD } };

    const [
      current,
      previous,
      byStatus,
      customers,
      newCustomers,
      prevNewCustomers,
      active,
      archived,
      lowCount,
      outCount,
      lowStock,
      series,
      top,
      recent,
      openRequests,
      refundsDue,
      deliveryProblems,
      returnsToAction,
    ] = await Promise.all([
      this.db.order.aggregate({
        where: { ...paid, createdAt: { gte: from } },
        _sum: { total: true },
        _count: { _all: true },
      }),
      this.db.order.aggregate({
        where: { ...paid, createdAt: { gte: prevFrom, lt: from } },
        _sum: { total: true },
        _count: { _all: true },
      }),
      this.db.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.user.count({ where: { role: 'CUSTOMER' } }),
      this.db.user.count({
        where: { role: 'CUSTOMER', createdAt: { gte: from } },
      }),
      this.db.user.count({
        where: { role: 'CUSTOMER', createdAt: { gte: prevFrom, lt: from } },
      }),
      this.db.product.count({ where: { active: true } }),
      this.db.product.count({ where: { active: false } }),
      this.db.product.count({
        where: { active: true, stock: { gt: 0, lte: LOW_STOCK } },
      }),
      this.db.product.count({ where: { active: true, stock: { lte: 0 } } }),
      this.db.product.findMany({
        where: { active: true, stock: { lte: LOW_STOCK } },
        orderBy: [{ stock: 'asc' }, { id: 'asc' }],
        take: 8,
      }),
      this.db.$queryRaw<{ day: string; revenue: Prisma.Decimal; orders: bigint }[]>`
          SELECT to_char("createdAt" + make_interval(mins => ${offset}), 'YYYY-MM-DD') AS day, SUM(total) AS revenue, COUNT(*) AS orders
          FROM "Order" WHERE status NOT IN ('CANCELLED', 'PENDING_PAYMENT') AND "createdAt" >= ${ts(from)}::timestamp
          GROUP BY 1 ORDER BY 1`,
      this.db.$queryRaw<{ id: number; units: bigint; revenue: Prisma.Decimal }[]>`
          SELECT i."productId" AS id, SUM(i.qty) AS units, SUM(i.qty * i.price) AS revenue
          FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
          WHERE o.status NOT IN ('CANCELLED', 'PENDING_PAYMENT') AND o."createdAt" >= ${ts(from)}::timestamp
          GROUP BY 1 ORDER BY revenue DESC LIMIT 5`,
      this.db.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: {
          user: { select: { id: true, name: true, email: true } },
          items: true,
        },
      }),
      this.db.productRequest.count({
        where: { status: { in: ['RECEIVED', 'SOURCING'] } },
      }),
      // Cancelled after being paid online: the money still has to go back.
      this.db.order.count({ where: REFUND_DUE }),
      // Deliveries that need someone: a courier sync problem, a short cash collection, or a parcel back at the store.
      this.db.shipment.count({ where: NEEDS_ATTENTION }),
      // Returns waiting on the store: new ones to decide, and ones back at the store to refund.
      this.db.returnRequest.count({
        where: { status: { in: ['REQUESTED', 'RECEIVED'] } },
      }),
    ]);

    const revenue = Number(current._sum.total ?? 0);
    const prevRevenue = Number(previous._sum.total ?? 0);
    const orders = current._count._all;
    const prevOrders = previous._count._all;
    const byDay = new Map(series.map((r) => [r.day, r]));
    const topProducts = await this.db.product.findMany({
      where: { id: { in: top.map((t) => t.id) } },
      select: { id: true, name: true, image: true },
    });

    return {
      range: { days, from, to: new Date() },
      revenue: {
        total: round2(revenue),
        previous: round2(prevRevenue),
        change: change(revenue, prevRevenue),
      },
      orders: {
        total: orders,
        previous: prevOrders,
        change: change(orders, prevOrders),
        byStatus: Object.fromEntries(['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].map((s) => [s, byStatus.find((b) => b.status === s)?._count._all ?? 0])),
      },
      averageOrderValue: {
        total: orders ? round2(revenue / orders) : 0,
        change: change(orders ? revenue / orders : 0, prevOrders ? prevRevenue / prevOrders : 0),
      },
      customers: {
        total: customers,
        new: newCustomers,
        change: change(newCustomers, prevNewCustomers),
      },
      products: { active, archived, lowStock: lowCount, outOfStock: outCount },
      series: Array.from({ length: days }, (_, i) => {
        const day = new Date(from.getTime() + i * DAY + offset * 60000).toISOString().slice(0, 10);
        const r = byDay.get(day);
        return {
          date: day,
          revenue: r ? round2(Number(r.revenue)) : 0,
          orders: r ? Number(r.orders) : 0,
        };
      }),
      topProducts: top.map((t) => ({
        ...topProducts.find((p) => p.id === t.id),
        id: t.id,
        units: Number(t.units),
        revenue: round2(Number(t.revenue)),
      })),
      recentOrders: recent.map((o) => ({
        id: o.id,
        status: o.status,
        total: Number(o.total),
        createdAt: o.createdAt,
        customer: o.user,
        itemCount: o.items.reduce((n, i) => n + i.qty, 0),
      })),
      lowStock: lowStock.map(toAdminProduct),
      openRequests,
      refundsDue,
      deliveryProblems,
      returnsToAction,
    };
  }

  async system() {
    const check = async (fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await fn();
        return { ok: true, ms: Date.now() - t };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    };
    const [database, redis, ai, promos, aiUsage] = await Promise.all([
      check(() => this.db.$queryRaw`SELECT 1`),
      check(() => this.redis.ping()),
      this.ai.health(),
      this.db.promoCode.count({ where: { active: true } }),
      // Paid AI calls and their estimated cost, per day (null while the AI service is down).
      callAi('/usage?days=7', { timeoutMs: 2500 }).catch(() => null),
    ]);
    return {
      status: database.ok && redis.ok ? 'ok' : 'degraded',
      services: { database, redis, ai },
      aiUsage,
      settings: {
        freeShippingOver: pricing.freeShippingOver,
        shipping: pricing.shipping,
        activePromoCodes: promos,
        lowStockThreshold: LOW_STOCK,
        sessionLength: env.jwtExpiresIn,
        aiServiceUrl: env.aiServiceUrl,
      },
    };
  }
}

@ApiTags('admin · dashboard')
@Staff('dashboard')
@Controller('admin')
export class AdminDashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly ai: AiIndexService,
  ) {}

  /** KPIs, a daily revenue series and what needs attention, for the last 7, 30 or 90 days. */
  @Get('stats')
  stats(@Query() q: StatsQuery) {
    return this.dashboard.stats(q.days ?? 30);
  }

  @Needs('system')
  @Get('system')
  system() {
    return this.dashboard.system();
  }

  /** Re-embeds every product and reloads Pip's catalog in the AI service. */
  @Needs('system')
  @Post('system/reindex')
  @HttpCode(200)
  reindex() {
    return this.ai.rebuild();
  }
}
