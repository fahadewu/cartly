import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { BumpCatalogCache } from '../common/cache.js';
import { PrismaService } from '../common/infra.module.js';
import { Needs, Staff } from '../common/auth.js';
import { toOrder } from '../common/serialize.js';
import { restock } from '../cart/stock.js';
import type { OrderStatus, PaymentStatus, Prisma } from '../generated/prisma/client.js';
import { toPayment } from '../payments/payments.service.js';
import { TERMINAL, toShipment } from '../delivery/delivery.service.js';

/** Orders that don't count as sales: cancelled ones, and ones still waiting to be paid online. */
export const NOT_SOLD: OrderStatus[] = ['CANCELLED', 'PENDING_PAYMENT'];
/** Cancelled after real money was taken (the dev-only demo card never takes any). */
export const REFUND_DUE: Prisma.OrderWhereInput = {
  status: 'CANCELLED',
  paymentStatus: 'PAID',
  paymentMethod: { not: 'demo' },
};

const STATUSES = ['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
const PAYMENT_STATUSES = ['UNPAID', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'] as const;

/** Allowed moves for an order. Cancelling puts the items back in stock. */
export const NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
  // Paid online orders move on by themselves once the payment is confirmed.
  PENDING_PAYMENT: ['CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};
const label = (s: OrderStatus) => s.toLowerCase();
const customerSelect = { id: true, name: true, email: true } as const;

/* ------------------------------ DTOs ------------------------------ */

export class AdminOrderQuery {
  @IsOptional() @IsIn(STATUSES) status?: OrderStatus;
  @IsOptional() @IsIn(PAYMENT_STATUSES) payment?: PaymentStatus;
  /** Cancelled orders whose payment still has to be sent back. */
  @IsOptional() @IsIn(['true']) refundDue?: string;
  /** Matches order id, customer name or email. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class OrderStatusDto {
  @IsIn(STATUSES) status: OrderStatus;
}
export class OrderPaymentDto {
  /** Cash on delivery: the courier collected it. */
  @IsIn(['PAID']) status: 'PAID';
}

export class PromoDto {
  @Matches(/^[A-Za-z0-9]{2,32}$/, {
    message: 'Codes are 2–32 letters or numbers, no spaces.',
  })
  code: string;
  /** Whole-number percentage, e.g. 20 for 20% off. */
  @IsInt() @Min(1) @Max(90) percentOff: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdatePromoDto {
  @IsOptional() @IsInt() @Min(1) @Max(90) percentOff?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

/* ------------------------------ Orders ------------------------------ */

@Injectable()
export class AdminOrdersService {
  constructor(private readonly db: PrismaService) {}

  async list(q: AdminOrderQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const term = q.q?.trim();
    const search: Prisma.OrderWhereInput = term
      ? {
          OR: [
            { id: { contains: term, mode: 'insensitive' } },
            { user: { email: { contains: term, mode: 'insensitive' } } },
            { user: { name: { contains: term, mode: 'insensitive' } } },
          ],
        }
      : {};
    const where: Prisma.OrderWhereInput = {
      ...search,
      ...(q.status ? { status: q.status } : {}),
      ...(q.payment ? { paymentStatus: q.payment } : {}),
      ...(q.refundDue ? REFUND_DUE : {}),
    };
    const [rows, total, grouped, refundDue] = await Promise.all([
      this.db.order.findMany({
        where,
        include: { items: true, user: { select: customerSelect } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.order.count({ where }),
      this.db.order.groupBy({
        by: ['status'],
        where: search,
        _count: { _all: true },
      }),
      this.db.order.count({ where: { ...search, ...REFUND_DUE } }),
    ]);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0]));
    return {
      items: rows.map(({ user, ...o }) => ({
        ...toOrder(o),
        customer: user,
        itemCount: o.items.reduce((n, i) => n + i.qty, 0),
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      counts: {
        ALL: Object.values(counts).reduce((a, b) => a + b, 0),
        ...counts,
        REFUND_DUE: refundDue,
      },
    };
  }

  async get(id: string) {
    const o = await this.db.order.findUnique({
      where: { id },
      include: {
        items: true,
        user: { select: { ...customerSelect, createdAt: true } },
        payments: { orderBy: { createdAt: 'asc' } },
        shipments: {
          include: {
            rider: { include: { user: { select: { name: true } } } },
            events: { orderBy: { at: 'asc' } },
          },
          orderBy: { createdAt: 'asc' },
        },
        returns: { include: { items: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!o) throw new NotFoundException('Order not found.');
    const history = await this.db.order.aggregate({
      where: { userId: o.userId, status: { notIn: NOT_SOLD } },
      _count: { _all: true },
      _sum: { total: true },
    });
    const { user, payments, shipments: trips, returns, ...order } = o;
    const shipments = trips.filter((s) => s.kind === 'delivery');
    const shipping = shipments.some((s) => !TERMINAL.includes(s.status));
    return {
      ...toOrder(order),
      customer: {
        ...user,
        orders: history._count._all,
        spent: Number(history._sum.total ?? 0),
      },
      // While a parcel is on its way the shipment moves the order; cancelling waits for it to come back.
      next: shipping ? [] : NEXT_STATUS[o.status],
      payments: payments.map(toPayment),
      shipments: shipments.map(toShipment),
      returns: returns.map((r) => ({ id: r.id, status: r.status, reason: r.reason, refundUsd: Number(r.refundUsd), refundBdt: r.refundBdt == null ? null : Number(r.refundBdt), createdAt: r.createdAt, units: r.items.reduce((n, i) => n + i.qty, 0) })),
      /** Can be sent out (again): not yet delivered, nothing on the way. */
      canShip: (o.status === 'PROCESSING' || o.status === 'SHIPPED') && !shipping && !shipments.some((s) => s.status === 'DELIVERED'),
      refundDue: o.status === 'CANCELLED' && o.paymentStatus === 'PAID' && o.paymentMethod !== 'demo',
    };
  }

  /** Cash on delivery collected by the courier. */
  async markPaid(id: string) {
    const { count } = await this.db.order.updateMany({
      where: {
        id,
        paymentMethod: 'cod',
        paymentStatus: 'UNPAID',
        status: { not: 'CANCELLED' },
      },
      data: { paymentStatus: 'PAID' },
    });
    if (!count) throw new ConflictException('Only unpaid cash-on-delivery orders can be marked as paid.');
    return this.get(id);
  }

  async setStatus(id: string, status: OrderStatus) {
    const order = await this.db.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found.');
    if (
      order.status !== status &&
      (await this.db.shipment.count({
        where: { orderId: id, kind: 'delivery', status: { notIn: TERMINAL } },
      }))
    ) {
      throw new ConflictException('This order has a delivery on the way, which updates it. Cancel the delivery first, or correct its status.');
    }
    if (order.status !== status) {
      if (!NEXT_STATUS[order.status].includes(status)) {
        throw new ConflictException(`A ${label(order.status)} order can’t be marked as ${label(status)}.`);
      }
      await this.db.$transaction(async (tx) => {
        // Conditional, so two people updating the same order can't both win.
        const unpaid = status === 'CANCELLED' && ['PENDING', 'FAILED', 'UNPAID'].includes(order.paymentStatus);
        const { count } = await tx.order.updateMany({
          where: { id, status: order.status },
          data: {
            status,
            ...(unpaid ? { paymentStatus: 'CANCELLED' as const } : {}),
          },
        });
        if (!count) throw new ConflictException('This order was just updated by someone else. Refresh and try again.');
        if (status === 'CANCELLED') await restock(tx, order.items);
      });
    }
    return this.get(id);
  }
}

/* ------------------------------ Promo codes ------------------------------ */

@Injectable()
export class AdminPromosService {
  constructor(private readonly db: PrismaService) {}

  async list() {
    const [codes, usage] = await Promise.all([
      this.db.promoCode.findMany({ orderBy: { code: 'asc' } }),
      this.db.order.groupBy({
        by: ['promoCode'],
        where: { promoCode: { not: null }, status: { not: 'CANCELLED' } },
        _count: { _all: true },
        _sum: { discount: true, total: true },
      }),
    ]);
    return codes.map((c) => {
      const u = usage.find((x) => x.promoCode === c.code);
      return {
        code: c.code,
        percentOff: Math.round(c.percent * 100),
        active: c.active,
        /** A shopper's own code (a stamp-card reward), usable once. */
        personal: !!c.userId,
        uses: u?._count._all ?? 0,
        discountGiven: Number(u?._sum.discount ?? 0),
        revenue: Number(u?._sum.total ?? 0),
      };
    });
  }

  async create(dto: PromoDto) {
    const code = dto.code.toUpperCase();
    if (await this.db.promoCode.findUnique({ where: { code } })) throw new ConflictException('That code already exists.');
    await this.db.promoCode.create({
      data: { code, percent: dto.percentOff / 100, active: dto.active ?? true },
    });
    return this.one(code);
  }

  async update(code: string, dto: UpdatePromoDto) {
    const updated = await this.db.promoCode
      .update({
        where: { code: code.toUpperCase() },
        data: {
          ...(dto.percentOff !== undefined ? { percent: dto.percentOff / 100 } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      })
      .catch(() => null);
    if (!updated) throw new NotFoundException('Promo code not found.');
    return this.one(updated.code);
  }

  async remove(code: string) {
    // Past orders keep the code as plain text, so deleting never rewrites history.
    const { count } = await this.db.promoCode.deleteMany({
      where: { code: code.toUpperCase() },
    });
    if (!count) throw new NotFoundException('Promo code not found.');
  }

  private async one(code: string) {
    return (await this.list()).find((c) => c.code === code)!;
  }
}

/* ------------------------------ Controllers ------------------------------ */

@ApiTags('admin · orders')
@Staff('orders')
// Catalog edits (and stock/rating changes) reach the storefront's cached catalog at once.
@UseInterceptors(BumpCatalogCache)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  list(@Query() q: AdminOrderQuery) {
    return this.orders.list(q);
  }
  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }
  /** PROCESSING → SHIPPED → DELIVERED; PROCESSING or SHIPPED → CANCELLED (restocks). */
  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: OrderStatusDto) {
    return this.orders.setStatus(id, dto.status);
  }

  /** Records cash on delivery as collected. */
  @Needs('payments')
  @Patch(':id/payment')
  markPaid(@Param('id') id: string, @Body() _dto: OrderPaymentDto) {
    return this.orders.markPaid(id);
  }
}

@ApiTags('admin · promotions')
@Staff('promos')
@Controller('admin/promos')
export class AdminPromosController {
  constructor(private readonly promos: AdminPromosService) {}

  @Get()
  list() {
    return this.promos.list();
  }
  @Post()
  create(@Body() dto: PromoDto) {
    return this.promos.create(dto);
  }
  @Patch(':code')
  update(@Param('code') code: string, @Body() dto: UpdatePromoDto) {
    return this.promos.update(code, dto);
  }
  @Delete(':code')
  @HttpCode(204)
  remove(@Param('code') code: string) {
    return this.promos.remove(code);
  }
}
