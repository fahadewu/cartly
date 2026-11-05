import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Ip,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OrderStatus } from '../generated/prisma/client.js';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { DemandService } from '../common/demand.js';
import { type AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth.js';
import { toOrder, toProduct } from '../common/serialize.js';
import { pricing } from '../config.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentsService } from '../payments/payments.service.js';
import { isOnline, METHOD_IDS, type MethodId, PaymentSettings } from '../payments/settings.js';
import { reserve, restock } from './stock.js';
import { TERMINAL, toCustomerShipment } from '../delivery/delivery.service.js';

/* ------------------------------ DTOs ------------------------------ */

export class AddToCartDto {
  @IsInt() productId: number;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) qty?: number;
}
export class UpdateQtyDto {
  @IsInt() @Min(0) @Max(20) qty: number;
}
export class PromoDto {
  @IsString() @Length(2, 32) code: string;
}
export class AddressDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsString() @MinLength(4) @MaxLength(120) street: string;
  @IsString() @MinLength(1) @MaxLength(80) city: string;
  @IsString() @MinLength(3) @MaxLength(12) postal: string;
  @IsString() @MinLength(2) @MaxLength(60) country: string;
  /** For the courier; required for cash on delivery. */
  @IsOptional() @Matches(/^\+?[0-9][0-9 ()-]{6,19}$/, { message: 'Enter a valid phone number.' }) phone?: string;
}
export class PaymentDto {
  /** bkash | nagad | rocket | card | cod | demo (the default, for the dev-only demo card). */
  @IsOptional() @IsIn(METHOD_IDS) method?: MethodId;
  // The demo card only (validated, never charged).
  @IsOptional() @IsString() @MinLength(2) nameOnCard?: string;
  @IsOptional() @Matches(/^[\d ]{16,19}$/, { message: 'Enter a valid 16-digit card number.' }) cardNumber?: string;
  @IsOptional() @Matches(/^(0[1-9]|1[0-2])\/\d{2}$/, { message: 'Expiry must be MM/YY.' }) expiry?: string;
  @IsOptional() @Matches(/^\d{3,4}$/, { message: 'CVC must be 3 or 4 digits.' }) cvc?: string;
}
export class CheckoutDto {
  @ValidateNested() @Type(() => AddressDto) address: AddressDto;
  @IsIn(['standard', 'express']) delivery: 'standard' | 'express';
  @ValidateNested() @Type(() => PaymentDto) payment: PaymentDto;
}
export class PayDto {
  @IsIn(METHOD_IDS.filter((m) => m !== 'demo')) method: MethodId;
}

/* ------------------------------ Cart ------------------------------ */

interface Line {
  productId: number;
  color: string;
  size: string;
  qty: number;
}
const CART_TTL = 60 * 60 * 24 * 30; // 30 days
const cartKey = (userId: string) => `cart:${userId}`;
const promoKey = (userId: string) => `cart:${userId}:promo`;

/**
 * A code this shopper may use now: active, theirs if it's personal (a stamp-card reward), and, if it's
 * single-use, not already on one of their orders that went ahead.
 */
export async function usablePromo(db: Pick<PrismaService, 'promoCode' | 'order'>, code: string, userId: string) {
  const promo = await db.promoCode.findFirst({ where: { code, active: true } });
  if (!promo || (promo.userId && promo.userId !== userId)) return null;
  if (promo.singleUse && (await db.order.count({ where: { userId, promoCode: promo.code, status: { not: 'CANCELLED' } } }))) return null;
  return promo;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class CartService {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly demand: DemandService,
  ) {}

  private async lines(userId: string): Promise<(Line & { key: string })[]> {
    const raw = await this.redis.hgetall(cartKey(userId));
    return Object.entries(raw).map(([key, v]) => ({ key, ...(JSON.parse(v) as Line) }));
  }

  /** Full cart with products and totals (shipping shown for standard delivery). */
  async get(userId: string, delivery: 'standard' | 'express' = 'standard') {
    const lines = await this.lines(userId);
    const products = await this.db.product.findMany({ where: { id: { in: lines.map((l) => l.productId) }, active: true } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = lines
      .filter((l) => byId.has(l.productId))
      .map((l) => {
        const p = byId.get(l.productId)!;
        return { key: l.key, qty: l.qty, color: l.color, size: l.size, lineTotal: round2(Number(p.price) * l.qty), product: toProduct(p) };
      });
    const subtotal = round2(items.reduce((n, i) => n + i.lineTotal, 0));
    const code = await this.redis.get(promoKey(userId));
    const promo = code ? await usablePromo(this.db, code, userId) : null;
    const discount = promo ? round2(subtotal * promo.percent) : 0;
    const afterDiscount = subtotal - discount;
    const shipping = !items.length ? 0 : delivery === 'standard' && afterDiscount >= pricing.freeShippingOver ? 0 : pricing.shipping[delivery].price;
    return {
      items,
      count: items.reduce((n, i) => n + i.qty, 0),
      subtotal,
      promoCode: promo?.code ?? null,
      discount,
      delivery,
      shipping,
      total: round2(afterDiscount + shipping),
      freeShippingRemaining: round2(Math.max(0, pricing.freeShippingOver - afterDiscount)),
    };
  }

  async add(userId: string, dto: AddToCartDto) {
    const p = await this.db.product.findUnique({ where: { id: dto.productId } });
    if (!p?.active) throw new NotFoundException('Product not found.');
    // Wanted even when it can't be had: sold-out adds are the demand the analytics call lost.
    this.demand.note({ type: 'cart_add', userId, productId: p.id });
    if (p.stock <= 0) throw new ConflictException(`${p.name} is sold out.`);
    const colors = (p.colors as { name: string }[]).map((c) => c.name);
    const color = dto.color ?? colors[0];
    if (!colors.includes(color)) throw new BadRequestException(`${p.name} comes in ${colors.join(' or ')}.`);
    const size = dto.size ?? (p.sizes.length === 1 ? p.sizes[0] : undefined);
    if (!size) throw new BadRequestException(`Choose a size for ${p.name}: ${p.sizes.join(', ')}.`);
    if (!p.sizes.includes(size)) throw new BadRequestException(`${p.name} is available in sizes ${p.sizes.join(', ')}.`);

    const key = `${p.id}|${color}|${size}`;
    const existing = await this.redis.hget(cartKey(userId), key);
    const qty = Math.min(20, (existing ? (JSON.parse(existing) as Line).qty : 0) + (dto.qty ?? 1));
    if (qty > p.stock) throw new ConflictException(`Only ${p.stock} left in stock.`);
    await this.redis.multi().hset(cartKey(userId), key, JSON.stringify({ productId: p.id, color, size, qty })).expire(cartKey(userId), CART_TTL).exec();
    return this.get(userId);
  }

  async setQty(userId: string, key: string, qty: number) {
    const raw = await this.redis.hget(cartKey(userId), key);
    if (!raw) throw new NotFoundException('That item isn’t in your cart.');
    const line = JSON.parse(raw) as Line;
    if (qty === 0) await this.redis.hdel(cartKey(userId), key);
    else {
      const p = await this.db.product.findUnique({ where: { id: line.productId }, select: { stock: true } });
      if (p && qty > p.stock) throw new ConflictException(`Only ${p.stock} left in stock.`);
      await this.redis.hset(cartKey(userId), key, JSON.stringify({ ...line, qty }));
    }
    return this.get(userId);
  }

  async remove(userId: string, key: string) {
    await this.redis.hdel(cartKey(userId), key);
    return this.get(userId);
  }

  async clear(userId: string) {
    await this.redis.del(cartKey(userId), promoKey(userId));
  }

  async applyPromo(userId: string, code: string) {
    const promo = await usablePromo(this.db, code.trim().toUpperCase(), userId);
    if (!promo) throw new BadRequestException('That code isn’t valid, or it has already been used.');
    await this.redis.set(promoKey(userId), promo.code, 'EX', CART_TTL);
    return this.get(userId);
  }

  async removePromo(userId: string) {
    await this.redis.del(promoKey(userId));
    return this.get(userId);
  }
}

@ApiTags('cart')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser() u: AuthUser, @Query('delivery') delivery?: 'standard' | 'express') {
    return this.cart.get(u.id, delivery === 'express' ? 'express' : 'standard');
  }
  @Post('items')
  add(@CurrentUser() u: AuthUser, @Body() dto: AddToCartDto) {
    return this.cart.add(u.id, dto);
  }
  @Patch('items/:key')
  setQty(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: UpdateQtyDto) {
    return this.cart.setQty(u.id, key, dto.qty);
  }
  @Delete('items/:key')
  remove(@CurrentUser() u: AuthUser, @Param('key') key: string) {
    return this.cart.remove(u.id, key);
  }
  @Delete()
  @HttpCode(204)
  clear(@CurrentUser() u: AuthUser) {
    return this.cart.clear(u.id);
  }
  @Post('promo')
  @HttpCode(200)
  promo(@CurrentUser() u: AuthUser, @Body() dto: PromoDto) {
    return this.cart.applyPromo(u.id, dto.code);
  }
  @Delete('promo')
  removePromo(@CurrentUser() u: AuthUser) {
    return this.cart.removePromo(u.id);
  }
}

/* ------------------------------ Orders ------------------------------ */

const luhn = (digits: string) =>
  digits
    .split('')
    .reverse()
    .reduce((sum, ch, i) => {
      let n = Number(ch);
      if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
      return sum + n;
    }, 0) %
    10 ===
  0;

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: PrismaService,
    private readonly cart: CartService,
    private readonly settings: PaymentSettings,
    private readonly payments: PaymentsService,
  ) {}

  async list(userId: string, status?: string) {
    const wanted = status?.toUpperCase();
    if (wanted && !(wanted in OrderStatus)) throw new BadRequestException(`Unknown order status: ${status}.`);
    const orders = await this.db.order.findMany({
      where: { userId, ...(wanted ? { status: wanted as OrderStatus } : {}) },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map(toOrder);
  }

  async get(userId: string, id: string) {
    const order = await this.db.order.findFirst({
      where: { id, userId },
      include: {
        items: true,
        shipments: { where: { kind: 'delivery' }, include: { rider: { include: { user: { select: { name: true } } } }, events: { orderBy: { at: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!order) throw new NotFoundException('Order not found.');
    const { shipments, ...o } = order;
    // Only the latest trip: an earlier one that came back is the store's business.
    return { ...toOrder(o), shipment: shipments[0] ? toCustomerShipment(shipments[0]) : null };
  }

  /**
   * Places an order from the cart. Cash on delivery and the demo card go straight to processing; an
   * online payment holds the stock and returns the gateway page to send the shopper to (`payment.redirectUrl`).
   */
  async checkout(userId: string, dto: CheckoutDto, ip?: string) {
    const method = dto.payment.method ?? 'demo';
    await this.settings.requireAvailable(method);
    let cardLast4: string | null = null;
    if (method === 'demo') {
      // Demo payment: validated, never charged, and only the last 4 digits are kept.
      const { nameOnCard, cardNumber, expiry, cvc } = dto.payment;
      if (!nameOnCard || !cardNumber || !expiry || !cvc) throw new BadRequestException('Fill in the card details.');
      const digits = cardNumber.replace(/\s/g, '');
      if (digits.length !== 16 || !luhn(digits)) throw new BadRequestException('Enter a valid 16-digit card number.');
      const [mm, yy] = expiry.split('/').map(Number);
      if (new Date(2000 + yy, mm) <= new Date()) throw new BadRequestException('That card has expired.');
      cardLast4 = digits.slice(-4);
    }
    if (method === 'cod' && !dto.address.phone) throw new BadRequestException('Add a phone number so the courier can reach you.');

    const cart = await this.cart.get(userId, dto.delivery);
    if (!cart.items.length) throw new BadRequestException('Your cart is empty.');
    // Prices stay in dollars; what's charged in taka is fixed on the order at today's rate.
    const quote = method === 'demo' ? null : await this.payments.quote(cart.total);
    const online = isOnline(method);

    const order = await this.db.$transaction(async (tx) => {
      if (cart.promoCode && !(await usablePromo(tx, cart.promoCode, userId))) throw new ConflictException('That promo code has just been used on another order. Remove it and try again.');
      const soldOut = await reserve(tx, cart.items.map((i) => ({ productId: i.product.id, qty: i.qty, name: i.product.name })));
      if (soldOut) throw new ConflictException(`${soldOut} just sold out. Please update your cart.`);
      let id = '';
      do id = `CL-${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;
      while (await tx.order.findUnique({ where: { id } }));
      return tx.order.create({
        data: {
          id,
          userId,
          status: online ? 'PENDING_PAYMENT' : 'PROCESSING',
          subtotal: cart.subtotal,
          discount: cart.discount,
          shipping: cart.shipping,
          total: cart.total,
          promoCode: cart.promoCode,
          delivery: dto.delivery,
          address: { ...dto.address, postal: dto.address.postal.toUpperCase() },
          cardLast4,
          paymentMethod: method,
          paymentStatus: online ? 'PENDING' : method === 'cod' ? 'UNPAID' : 'PAID',
          amountBdt: quote?.amountBdt ?? null,
          exchangeRate: quote?.rate ?? null,
          items: {
            create: cart.items.map((i) => ({
              productId: i.product.id,
              name: i.product.name,
              image: i.product.image,
              price: i.product.price,
              qty: i.qty,
              color: i.color,
              size: i.size,
            })),
          },
        },
        include: { items: true },
      });
    });

    let payment: { paymentId: string; redirectUrl: string } | null = null;
    if (online) {
      const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } });
      try {
        payment = await this.payments.begin(order, method, user, ip);
      } catch (e) {
        // The gateway couldn't even start: undo the order, so the cart and stock are as they were.
        // (Only while it is still an unpaid, open order: never delete one that something has paid.)
        await this.db.$transaction(async (tx) => {
          const { count } = await tx.order.updateMany({ where: { id: order.id, status: 'PENDING_PAYMENT', paymentStatus: { not: 'PAID' } }, data: { status: 'CANCELLED' } });
          if (!count) return;
          await restock(tx, order.items);
          await tx.order.delete({ where: { id: order.id } });
        });
        throw e;
      }
    }
    await this.cart.clear(userId);
    const placed = toOrder(await this.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } }));
    // `redirectUrl`: the gateway page to send the shopper to (online payments only).
    return { ...placed, payment: { ...placed.payment, redirectUrl: payment?.redirectUrl ?? null } };
  }

  /** Pays for an order still waiting for payment: another try, another method, or cash on delivery instead. */
  async pay(userId: string, id: string, method: MethodId, ip?: string) {
    const order = await this.db.order.findFirst({ where: { id, userId }, include: { items: true } });
    if (!order) throw new NotFoundException('Order not found.');
    if (order.status !== 'PENDING_PAYMENT') throw new ConflictException('This order doesn’t need paying.');
    await this.settings.requireAvailable(method);
    if (method === 'cod') {
      if (!(order.address as { phone?: string }).phone) throw new BadRequestException('Cash on delivery needs a phone number for the courier. Place the order again with one.');
      const { count } = await this.db.order.updateMany({
        where: { id, status: 'PENDING_PAYMENT', paymentStatus: { not: 'PAID' } },
        data: { status: 'PROCESSING', paymentMethod: 'cod', paymentStatus: 'UNPAID' },
      });
      if (!count) throw new ConflictException('This order was just paid. There’s nothing more to do.');
      // Attempts still open at a gateway stay PENDING: the sweep asks about them, and settle() flags one
      // that went through anyway, instead of quietly marking a cash order as paid online too.
      const o = await this.get(userId, id);
      return { ...o, payment: { ...o.payment, redirectUrl: null } };
    }
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } });
    const { redirectUrl } = await this.payments.begin(order, method, user, ip);
    const o = await this.get(userId, id);
    return { ...o, payment: { ...o.payment, redirectUrl } };
  }

  async reorder(userId: string, id: string) {
    const order = await this.get(userId, id);
    for (const i of order.items) {
      await this.cart.add(userId, { productId: i.productId, color: i.color, size: i.size, qty: i.qty }).catch(() => undefined);
    }
    return this.cart.get(userId);
  }

  async cancel(userId: string, id: string) {
    const order = await this.db.order.findFirst({ where: { id, userId }, include: { items: true } });
    if (!order) throw new NotFoundException('Order not found.');
    const notShipped = new ConflictException('Only orders that haven’t shipped yet can be cancelled.');
    if (order.status !== 'PROCESSING' && order.status !== 'PENDING_PAYMENT') throw notShipped;
    if (await this.db.shipment.count({ where: { orderId: id, kind: 'delivery', status: { notIn: TERMINAL } } })) {
      throw new ConflictException('Your order has already been handed over for delivery, so it can’t be cancelled here. Contact us and we’ll stop it.');
    }
    const updated = await this.db.$transaction(async (tx) => {
      // Conditional, so a concurrent "shipped" update from an admin (or a payment landing) wins cleanly.
      // A payment already taken stays PAID: the admin panel lists it as a refund to make.
      const unpaid = order.paymentStatus === 'PENDING' || order.paymentStatus === 'FAILED' || order.paymentStatus === 'UNPAID';
      const { count } = await tx.order.updateMany({
        where: { id, status: order.status },
        data: { status: 'CANCELLED', ...(unpaid ? { paymentStatus: 'CANCELLED' as const } : {}) },
      });
      if (!count) throw notShipped;
      await restock(tx, order.items);
      return tx.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
    });
    return toOrder(updated);
  }
}

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.orders.list(u.id, status);
  }
  /** Places an order from the current cart. */
  @Post()
  checkout(@CurrentUser() u: AuthUser, @Body() dto: CheckoutDto, @Ip() ip: string) {
    return this.orders.checkout(u.id, dto, ip);
  }
  /** Pay for an order still awaiting payment → { ...order, payment: { redirectUrl } }. */
  @Post(':id/pay')
  @HttpCode(200)
  pay(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PayDto, @Ip() ip: string) {
    return this.orders.pay(u.id, id, dto.method, ip);
  }
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.orders.get(u.id, id);
  }
  @Post(':id/reorder')
  @HttpCode(200)
  reorder(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.orders.reorder(u.id, id);
  }
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.orders.cancel(u.id, id);
  }
}

@Module({
  imports: [PaymentsModule],
  controllers: [CartController, OrdersController],
  providers: [CartService, OrdersService],
  exports: [CartService],
})
export class CommerceModule {}
