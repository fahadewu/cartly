import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Needs, Staff, type AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth.js';
import { BumpCatalogCache, CatalogCache } from '../common/cache.js';
import { AiIndexService } from '../common/ai-index.js';
import { refreshFit } from '../catalog/fit.js';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { withLock } from '../common/lock.js';
import { restock } from '../cart/stock.js';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { DeliveryService, TERMINAL, toCustomerShipment, toShipment } from '../delivery/delivery.service.js';
import type { Prisma, ReturnReason, ReturnStatus } from '../generated/prisma/client.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentsService } from '../payments/payments.service.js';

const REASONS = ['TOO_SMALL', 'TOO_LARGE', 'DAMAGED', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'QUALITY', 'CHANGED_MIND', 'OTHER'] as const;
const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED', 'CANCELLED'] as const;
/** Returns that still hold items (so they can't be asked for twice). */
const LIVE: ReturnStatus[] = ['REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED'];
const WINDOW_KEY = 'returnWindowDays';
const DEFAULT_WINDOW = 7;
const DAY = 864e5;
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------ DTOs ------------------------------ */

export class ReturnLineDto {
  @IsUUID() orderItemId: string;
  @IsInt() @Min(1) @Max(20) qty: number;
}
export class CreateReturnDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items: ReturnLineDto[];
  @IsIn(REASONS) reason: ReturnReason;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class ReturnQuery {
  @IsOptional() @IsIn(STATUSES) status?: ReturnStatus;
  /** Matches the return id, order id, customer name or email. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class NoteDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class PickupDto {
  @IsUUID() riderId: string;
  @IsOptional() @IsString() @MaxLength(250) note?: string;
}
export class InspectLineDto {
  @IsUUID() id: string;
  /** Back into stock (false when damaged or unsellable). */
  @IsBoolean() restock: boolean;
}
export class ReceiveDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => InspectLineDto)
  items: InspectLineDto[];
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class RefundDto {
  /** In taka; the return's value when left out. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amountBdt?: number;
  /** gateway: back through bKash/SSLCommerz. manual: sent another way (bKash/Nagad transfer, cash) and recorded. */
  @IsIn(['gateway', 'manual']) via: 'gateway' | 'manual';
  @IsOptional() @IsString() @MaxLength(60) manualMethod?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}
export class ReturnSettingsDto {
  @IsInt() @Min(0) @Max(90) windowDays: number;
}

/* ------------------------------ Service ------------------------------ */

type Full = Prisma.ReturnRequestGetPayload<{ include: typeof FULL }>;
const FULL = {
  items: { include: { orderItem: true } },
  order: {
    select: {
      id: true,
      status: true,
      total: true,
      subtotal: true,
      discount: true,
      paymentMethod: true,
      paymentStatus: true,
      exchangeRate: true,
      address: true,
    },
  },
  user: { select: { id: true, name: true, email: true } },
  shipments: {
    include: {
      rider: { include: { user: { select: { name: true } } } },
      events: { orderBy: { at: 'asc' } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.ReturnRequestInclude;

export const toReturn = (r: Full) => ({
  id: r.id,
  orderId: r.orderId,
  status: r.status,
  reason: r.reason,
  note: r.note,
  storeNote: r.storeNote,
  refundUsd: Number(r.refundUsd),
  refundBdt: r.refundBdt == null ? null : Number(r.refundBdt),
  refundMethod: r.refundMethod,
  refundRef: r.refundRef,
  items: r.items.map((i) => ({ id: i.id, orderItemId: i.orderItemId, productId: i.orderItem.productId, name: i.orderItem.name, image: i.orderItem.image, color: i.orderItem.color, size: i.orderItem.size, price: Number(i.orderItem.price), qty: i.qty, restocked: i.restocked })),
  customer: r.user,
  order: { id: r.order.id, status: r.order.status, total: Number(r.order.total), paymentMethod: r.order.paymentMethod, paymentStatus: r.order.paymentStatus, address: r.order.address },
  pickups: r.shipments.map(toShipment),
  approvedAt: r.approvedAt,
  receivedAt: r.receivedAt,
  refundedAt: r.refundedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** The shopper's own view of a return: no store-internal notes, no rider phone or error details. */
export const toCustomerReturn = (r: Full) => {
  const { storeNote: _storeNote, customer: _customer, pickups: _pickups, order, ...rest } = toReturn(r);
  return {
    ...rest,
    order: { id: order.id, status: order.status, total: order.total, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus },
    pickups: r.shipments.map(toCustomerShipment),
  };
};

@Injectable()
export class ReturnsService {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly payments: PaymentsService,
    private readonly delivery: DeliveryService,
    private readonly cache: CatalogCache,
    private readonly index: AiIndexService,
  ) {}

  async windowDays() {
    const row = await this.db.storeSetting.findUnique({
      where: { key: WINDOW_KEY },
    });
    const n = Number(row?.value);
    return row && Number.isFinite(n) && n >= 0 ? n : DEFAULT_WINDOW;
  }
  async setWindowDays(days: number) {
    await this.db.storeSetting.upsert({
      where: { key: WINDOW_KEY },
      create: { key: WINDOW_KEY, value: days },
      update: { value: days },
    });
  }

  async get(id: string) {
    const r = await this.db.returnRequest.findUnique({
      where: { id },
      include: FULL,
    });
    if (!r) throw new NotFoundException('Return not found.');
    return r;
  }

  /** What a shopper can still send back from an order, and until when. */
  async eligibility(userId: string, orderId: string) {
    const order = await this.db.order.findFirst({
      where: { id: orderId, userId },
      include: {
        items: {
          include: {
            returns: { include: { return: { select: { status: true } } } },
          },
        },
        shipments: {
          where: { kind: 'delivery', status: 'DELIVERED' },
          select: { deliveredAt: true },
        },
        returns: { include: FULL, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!order) throw new NotFoundException('Order not found.');
    const window = await this.windowDays();
    // Delivered when the parcel was, or when the order was marked delivered by hand.
    const deliveredAt = order.shipments[0]?.deliveredAt ?? (order.status === 'DELIVERED' ? order.updatedAt : null);
    const until = deliveredAt ? new Date(deliveredAt.getTime() + window * DAY) : null;
    const items = order.items.map((i) => {
      const taken = i.returns.filter((r) => LIVE.includes(r.return.status)).reduce((n, r) => n + r.qty, 0);
      return {
        orderItemId: i.id,
        productId: i.productId,
        name: i.name,
        image: i.image,
        color: i.color,
        size: i.size,
        price: Number(i.price),
        qty: i.qty,
        returnable: Math.max(0, i.qty - taken),
      };
    });
    const why =
      order.status !== 'DELIVERED'
        ? 'Returns open once the order is delivered.'
        : !window
          ? 'This store doesn’t take returns.'
          : until && until < new Date()
            ? `The ${window}-day return window closed on ${until.toISOString().slice(0, 10)}.`
            : !items.some((i) => i.returnable)
              ? 'Everything in this order is already being returned.'
              : null;
    return {
      windowDays: window,
      until,
      open: !why,
      why,
      items,
      returns: order.returns.map(toCustomerReturn),
    };
  }

  /** The shopper asks to send items back. The refund is the items' price less the order's promo discount. */
  create(userId: string, orderId: string, dto: CreateReturnDto) {
    // One at a time per order: two requests sent together could both pass the "how many are returnable" check.
    return withLock(this.redis, `return:${orderId}`, 30, 'A return for this order is being created right now. Try again in a moment.', () => this.createNow(userId, orderId, dto));
  }
  private async createNow(userId: string, orderId: string, dto: CreateReturnDto) {
    const e = await this.eligibility(userId, orderId);
    if (!e.open) throw new ConflictException(e.why);
    const lines = new Map<string, number>();
    for (const l of dto.items) lines.set(l.orderItemId, (lines.get(l.orderItemId) ?? 0) + l.qty);
    let value = 0;
    for (const [id, qty] of lines) {
      const item = e.items.find((i) => i.orderItemId === id);
      if (!item) throw new BadRequestException('That item isn’t in this order.');
      if (qty > item.returnable) throw new BadRequestException(`Only ${item.returnable} of ${item.name} can be returned.`);
      value += item.price * qty;
    }
    if (dto.reason === 'OTHER' && !dto.note?.trim()) throw new BadRequestException('Tell us a little about why you’re returning it.');
    const order = await this.db.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    // Promo discounts were spread over the whole order, so each item gives back its share of it.
    const share = Number(order.subtotal) > 0 ? 1 - Number(order.discount) / Number(order.subtotal) : 1;
    const refundUsd = round2(value * share);
    const rate = order.exchangeRate == null ? null : Number(order.exchangeRate);
    let id = '';
    do id = `RT-${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;
    while (await this.db.returnRequest.findUnique({ where: { id } }));
    await this.db.returnRequest.create({
      data: {
        id,
        orderId,
        userId,
        reason: dto.reason,
        note: dto.note?.trim() || null,
        refundUsd,
        refundBdt: rate ? round2(refundUsd * rate) : null,
        items: {
          create: [...lines].map(([orderItemId, qty]) => ({
            orderItemId,
            qty,
          })),
        },
      },
    });
    await this.recountFit(id);
    return toCustomerReturn(await this.get(id));
  }

  /**
   * A return sent back as too small or too large is a fit signal for the product ("runs small"), and stops
   * being one when it's withdrawn or turned down. Never fails the return itself.
   */
  private async recountFit(id: string) {
    try {
      const r = await this.db.returnRequest.findUnique({ where: { id }, select: { reason: true, items: { select: { orderItem: { select: { productId: true } } } } } });
      if (!r || (r.reason !== 'TOO_SMALL' && r.reason !== 'TOO_LARGE')) return;
      const { changed, verdictChanged } = await refreshFit(this.db, r.items.map((i) => i.orderItem.productId));
      if (changed.length) await this.cache.bump();
      if (verdictChanged.length) this.index.reindexSoon();
    } catch {
      // The fit count catches up on the next fit review or return for the product.
    }
  }

  async cancelByShopper(userId: string, id: string) {
    const current = await this.db.returnRequest.findFirst({ where: { id, userId }, include: { shipments: { select: { status: true } } } });
    if (!current) throw new NotFoundException('Return not found.');
    // Once a rider has collected the items they're on their way to the store: withdrawing now would leave
    // them there with no way to inspect or restock.
    if (current.shipments.some((s) => s.status === 'PICKED_UP' || s.status === 'IN_TRANSIT')) throw new ConflictException('The items have already been collected, so this return can’t be withdrawn any more.');
    const { count } = await this.db.returnRequest.updateMany({
      where: { id, userId, status: { in: ['REQUESTED', 'APPROVED'] } },
      data: { status: 'CANCELLED' },
    });
    if (!count) throw new ConflictException('This return can’t be withdrawn any more.');
    await this.recountFit(id);
    const r = await this.get(id);
    for (const s of r.shipments.filter((x) => !TERMINAL.includes(x.status) && x.status === 'BOOKED')) await this.delivery.cancel(s.id, 'The customer withdrew the return');
    return toCustomerReturn(await this.get(id));
  }

  /* ---------- admin ---------- */

  private async move(id: string, from: ReturnStatus[], data: Prisma.ReturnRequestUpdateManyMutationInput, error: string) {
    const { count } = await this.db.returnRequest.updateMany({
      where: { id, status: { in: from } },
      data,
    });
    if (!count) {
      await this.get(id); // 404 if it doesn't exist
      throw new ConflictException(error);
    }
    return toReturn(await this.get(id));
  }
  approve(id: string, note?: string) {
    return this.move(
      id,
      ['REQUESTED'],
      {
        status: 'APPROVED',
        approvedAt: new Date(),
        ...(note?.trim() ? { storeNote: note.trim() } : {}),
      },
      'Only a new return can be approved.',
    );
  }
  reject(id: string, note?: string) {
    if (!note?.trim()) throw new BadRequestException('Say why, so the customer knows.');
    return this.move(id, ['REQUESTED', 'APPROVED'], { status: 'REJECTED', storeNote: note.trim() }, 'Only a return that hasn’t come back yet can be turned down.').then(async (r) => {
      await this.recountFit(id);
      return r;
    });
  }
  async pickup(id: string, dto: PickupDto) {
    await this.delivery.bookReturnPickup(id, dto.riderId, dto.note);
    return toReturn(await this.get(id));
  }

  /** The items are back (handed in by a rider or dropped off) and inspected: sellable ones go back into stock. */
  async receive(id: string, dto: ReceiveDto) {
    const r = await this.get(id);
    if (r.status !== 'APPROVED' && r.status !== 'RECEIVED') throw new ConflictException('Only an approved return can be received.');
    if (r.status === 'APPROVED' && r.shipments.some((s) => !TERMINAL.includes(s.status) && s.status !== 'BOOKED')) {
      throw new ConflictException('A rider is bringing it in: it’s received when they hand it over.');
    }
    const choice = new Map(dto.items.map((i) => [i.id, i.restock]));
    const pending = r.items.filter((i) => i.restocked == null);
    if (pending.some((i) => !choice.has(i.id))) throw new BadRequestException('Say for each item whether it goes back into stock.');
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.returnRequest.updateMany({
        where: { id, status: r.status },
        data: {
          status: 'RECEIVED',
          receivedAt: r.receivedAt ?? new Date(),
          ...(dto.note?.trim() ? { storeNote: dto.note.trim() } : {}),
        },
      });
      if (!count) throw new ConflictException('This return was just updated. Refresh and try again.');
      for (const i of pending)
        await tx.returnItem.update({
          where: { id: i.id },
          data: { restocked: choice.get(i.id)! },
        });
      await restock(
        tx,
        pending.filter((i) => choice.get(i.id)).map((i) => ({ productId: i.orderItem.productId, qty: i.qty })),
      );
      // A booked pickup nobody made is no longer needed.
      for (const s of r.shipments.filter((x) => x.status === 'BOOKED'))
        await tx.shipment.update({
          where: { id: s.id },
          data: { status: 'CANCELLED' },
        });
    });
    return toReturn(await this.get(id));
  }

  /** Sends the money back: through the gateway the order was paid with, or recorded as sent another way. */
  refund(id: string, dto: RefundDto) {
    // The gateway is called before the state moves to REFUNDED, so a second click must not get in meanwhile.
    return withLock(this.redis, `return-refund:${id}`, 60, 'This refund is already being sent. Refresh in a moment to see it.', () => this.refundNow(id, dto));
  }
  private async refundNow(id: string, dto: RefundDto) {
    const r = await this.get(id);
    if (r.status !== 'RECEIVED') throw new ConflictException(r.status === 'REFUNDED' ? 'This return has already been refunded.' : 'Receive and inspect the items before refunding.');
    if (r.items.some((i) => i.restocked == null)) throw new ConflictException('Inspect every item first.');
    const amount = round2(dto.amountBdt ?? Number(r.refundBdt ?? 0));
    // Sent by hand is marked "manual: …", so the analytics count it once (gateway refunds are in the payment's log).
    let method = `manual: ${dto.manualMethod?.trim() || 'other'}`;
    let ref = dto.reference?.trim() || null;
    if (dto.via === 'gateway') {
      const paid = await this.db.payment.findFirst({
        where: { orderId: r.orderId, status: 'PAID' },
        orderBy: { createdAt: 'desc' },
      });
      if (!paid) throw new ConflictException('This order wasn’t paid online (or its payment is already fully refunded). Send the money another way and record it.');
      if (!(amount > 0)) throw new BadRequestException('Enter the amount to refund in taka.');
      try {
        const p = await this.payments.refund(paid.id, {
          amount,
          reason: `Return ${r.id}`,
        });
        method = p.gateway;
        ref = p.invoice;
      } catch (e) {
        if (e instanceof BadGatewayException || e instanceof BadRequestException || e instanceof ConflictException) throw e;
        throw new BadGatewayException('The gateway didn’t take the refund. Try again, or refund it by hand and record it.');
      }
    } else if (r.order.paymentMethod !== 'demo' && !ref) {
      throw new BadRequestException('Add the transfer’s reference (e.g. the bKash transaction id), or “cash” with who handed it over.');
    }
    return this.move(
      id,
      ['RECEIVED'],
      {
        status: 'REFUNDED',
        refundedAt: new Date(),
        refundBdt: amount || null,
        refundMethod: method,
        refundRef: ref,
      },
      'This return was just updated. Refresh and try again.',
    );
  }

  async list(q: ReturnQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const term = q.q?.trim();
    const search: Prisma.ReturnRequestWhereInput = term
      ? { OR: [{ id: { contains: term, mode: 'insensitive' } }, { orderId: { contains: term, mode: 'insensitive' } }, { user: { name: { contains: term, mode: 'insensitive' } } }, { user: { email: { contains: term, mode: 'insensitive' } } }] }
      : {};
    const where = { ...search, ...(q.status ? { status: q.status } : {}) };
    const [rows, total, grouped] = await Promise.all([
      this.db.returnRequest.findMany({
        where,
        include: FULL,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.returnRequest.count({ where }),
      this.db.returnRequest.groupBy({
        by: ['status'],
        where: search,
        _count: { _all: true },
      }),
    ]);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0]));
    return {
      items: rows.map(toReturn),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      counts: {
        ALL: Object.values(counts).reduce((a, b) => a + b, 0),
        ...counts,
      },
      windowDays: await this.windowDays(),
    };
  }

  /** Returns waiting on the store: new ones to decide, and ones back at the store to refund. */
  needsAction() {
    return this.db.returnRequest.count({
      where: { status: { in: ['REQUESTED', 'RECEIVED'] } },
    });
  }
}

/* ------------------------------ Controllers ------------------------------ */

@ApiTags('returns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  /** What can still be sent back from an order, until when, and the returns made so far. */
  @Get('orders/:id/returns')
  eligibility(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.returns.eligibility(u.id, id);
  }
  @Post('orders/:id/returns')
  create(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CreateReturnDto) {
    return this.returns.create(u.id, id, dto);
  }
  @Post('returns/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.returns.cancelByShopper(u.id, id);
  }
}

@ApiTags('admin · returns')
@Staff('returns')
// Restocking changes what the storefront shows as in stock.
@UseInterceptors(BumpCatalogCache)
@Controller('admin/returns')
export class AdminReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  list(@Query() q: ReturnQuery) {
    return this.returns.list(q);
  }
  @Get('settings')
  async settings() {
    return { windowDays: await this.returns.windowDays() };
  }
  @Needs('settings')
  @Patch('settings')
  async saveSettings(@Body() dto: ReturnSettingsDto) {
    await this.returns.setWindowDays(dto.windowDays);
    return { windowDays: dto.windowDays };
  }
  @Get(':id')
  async get(@Param('id') id: string) {
    return toReturn(await this.returns.get(id));
  }
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() dto: NoteDto) {
    return this.returns.approve(id, dto.note);
  }
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() dto: NoteDto) {
    return this.returns.reject(id, dto.note);
  }
  /** Sends one of the store's riders to collect it. */
  @Post(':id/pickup')
  @HttpCode(200)
  pickup(@Param('id') id: string, @Body() dto: PickupDto) {
    return this.returns.pickup(id, dto);
  }
  /** Back at the store and inspected: which items go back into stock. */
  @Post(':id/receive')
  @HttpCode(200)
  receive(@Param('id') id: string, @Body() dto: ReceiveDto) {
    return this.returns.receive(id, dto);
  }
  @Needs('refunds.write')
  @Post(':id/refund')
  @HttpCode(200)
  refund(@Param('id') id: string, @Body() dto: RefundDto) {
    return this.returns.refund(id, dto);
  }
}

@Module({
  imports: [PaymentsModule, DeliveryModule],
  controllers: [ReturnsController, AdminReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
