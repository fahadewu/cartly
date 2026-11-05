import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { env } from '../config.js';
import type { Order, OrderItem, Payment, PaymentStatus, Prisma } from '../generated/prisma/client.js';
import { reserve, restock } from '../cart/stock.js';
import { GATEWAYS } from './gateways/index.js';
import { GatewayError, type GatewayId, type Outcome } from './gateways/types.js';
import { METHODS, type MethodId, PaymentSettings } from './settings.js';

type OrderWithItems = Order & { items: OrderItem[] };
type Customer = { name: string; email: string };
const round2 = (n: number) => Math.round(n * 100) / 100;
const MINUTE = 60_000;

/** A line in a payment's log: what happened, and the gateway's reply. */
const entry = (step: string, detail: Record<string, unknown> = {}) => ({ at: new Date().toISOString(), step, ...detail });

/**
 * Online payments, whichever gateway takes them. A payment is settled exactly once: the shopper's
 * return and the gateway's own notification can both arrive (in any order), and every change is a
 * conditional update on the payment's PENDING state. The gateway is always asked directly (execute,
 * verify, validate) before anything is marked paid: a callback's own "success" is never trusted.
 */
@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Payments');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: PaymentSettings,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return; // tests call sweep() themselves
    this.timer = setInterval(() => this.sweep().catch((e: Error) => this.log.warn(`Payment sweep failed: ${e.message}`)), MINUTE);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Taka for a dollar total at today's rate. */
  async quote(totalUsd: number) {
    const rate = await this.settings.rate();
    if (!rate) throw new ConflictException('Payments in taka aren’t set up yet. Please try again later.');
    return { rate, amountBdt: round2(totalUsd * rate) };
  }

  /** Registers an attempt with the gateway and returns where to send the shopper. */
  async begin(order: OrderWithItems, method: MethodId, customer: Customer, ip?: string) {
    const gatewayId = METHODS[method].gateway as GatewayId;
    const gateway = GATEWAYS[gatewayId];
    const acct = await this.settings.account(gatewayId);
    if (!acct || order.amountBdt == null) throw new ConflictException(`${METHODS[method].label} isn’t available right now. Choose another payment method.`);
    if (order.status !== 'PENDING_PAYMENT' || order.paymentStatus === 'PAID') throw new ConflictException('This order has already been paid.');
    // Unique per attempt, letters and digits only (every gateway accepts that): CL52345 + 8 random.
    const invoice = order.id.replace(/[^A-Za-z0-9]/g, '') + randomBytes(6).toString('hex').slice(0, 8).toUpperCase();
    const payment = await this.db.payment.create({
      data: { orderId: order.id, method, gateway: gatewayId, sandbox: !acct.live, invoice, amount: order.amountBdt },
    });
    const address = order.address as Record<string, string>;
    let res;
    try {
      res = await gateway.start(acct, {
        invoice,
        amount: Number(order.amountBdt),
        orderId: order.id,
        method: method as 'bkash' | 'nagad' | 'rocket' | 'card',
        // Nagad calls back one registered URL (the invoice says which payment); the others get one per attempt.
        callbackUrl: `${env.publicUrl}/api/v1/payments/${gatewayId}/${gatewayId === 'sslcommerz' ? 'return' : 'callback'}${gateway.invoiceOf ? '' : `/${payment.id}`}`,
        customer: { name: address.name, email: customer.email, phone: address.phone, street: address.street, city: address.city, postal: address.postal, country: address.country },
        items: order.items.map((i) => ({ name: i.name, qty: i.qty })),
        ip,
      });
    } catch (e) {
      const message = e instanceof GatewayError ? e.message : `${gateway.name} didn’t respond`;
      this.log.warn(`${gateway.name} start failed for ${order.id}: ${(e as Error).message}`);
      await this.db.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', error: message, log: [entry('start failed', { error: (e as Error).message, reply: (e as GatewayError).raw })] },
      });
      throw new BadGatewayException(`${METHODS[method].label} isn’t responding right now. Try again, or choose another payment method.`);
    }
    const started = await this.db.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { reference: res.reference, log: [entry('started', { reply: res.raw })] } });
      // Conditional: another attempt (a second tab) may have paid the order while this one was starting.
      // Overwriting PAID with PENDING here is what would let both attempts count as paid later.
      const { count } = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING_PAYMENT', paymentStatus: { not: 'PAID' } },
        data: { paymentMethod: method, paymentStatus: 'PENDING' },
      });
      return count > 0;
    });
    // The attempt stays PENDING: the sweep asks the gateway about it, and if the shopper paid it anyway,
    // settle() flags it for a refund.
    if (!started) throw new ConflictException('This order was paid by another attempt just now. There’s nothing more to pay.');
    return { paymentId: payment.id, redirectUrl: res.redirectUrl };
  }

  async payment(id: string) {
    const p = await this.db.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Payment not found.');
    return p;
  }

  byInvoice(invoice: string) {
    return this.db.payment.findUnique({ where: { invoice } });
  }

  async accountFor(p: Payment) {
    const acct = await this.settings.account(p.gateway as GatewayId);
    if (!acct) throw new ConflictException(`The ${GATEWAYS[p.gateway as GatewayId]?.name ?? p.gateway} credentials were removed, so this payment can’t be checked.`);
    return acct;
  }

  /** Where the shopper's browser goes once the gateway sends them back. */
  returnUrl(p: Payment) {
    const result = p.status === 'PAID' ? 'success' : p.status === 'PENDING' ? 'pending' : p.status.toLowerCase();
    return `${env.storefrontUrl}/orders/${p.orderId}?payment=${result}`;
  }

  /** Records what the gateway said. Only the first final answer counts; later ones are logged. */
  async settle(paymentId: string, outcome: Outcome, step: string): Promise<Payment> {
    if (outcome.status === 'PAID' && outcome.amount != null) {
      const p = await this.payment(paymentId);
      if (Math.abs(outcome.amount - Number(p.amount)) > 0.01) {
        outcome = { ...outcome, status: 'FAILED', error: `The gateway reported ৳${outcome.amount} instead of ৳${Number(p.amount)}. Check it in the gateway's dashboard.` };
      }
    }
    return this.db.$transaction(async (tx) => {
      // Read inside the transaction, so two answers arriving together don't lose each other's log entry.
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { order: { include: { items: true } } } });
      const log = [...((p.log as unknown[]) ?? []), entry(step, { status: outcome.status, trxId: outcome.trxId, error: outcome.error, reply: outcome.raw })];
      if (outcome.status === 'PENDING' || p.status !== 'PENDING') {
        return tx.payment.update({ where: { id: p.id }, data: { log: log as Prisma.InputJsonValue } });
      }
      const data: Prisma.PaymentUpdateManyMutationInput = { log: log as Prisma.InputJsonValue, error: outcome.error ?? null };
      if (outcome.status !== 'PAID') {
        const { count } = await tx.payment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { ...data, status: outcome.status } });
        if (count) {
          // The order stays open, so the shopper can try again or pick another method.
          await tx.order.updateMany({ where: { id: p.orderId, status: 'PENDING_PAYMENT', paymentStatus: 'PENDING' }, data: { paymentStatus: outcome.status } });
        }
        return tx.payment.findUniqueOrThrow({ where: { id: p.id } });
      }
      const { count } = await tx.payment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { ...data, status: 'PAID', trxId: outcome.trxId ?? null, paidAt: new Date() } });
      if (!count) return tx.payment.findUniqueOrThrow({ where: { id: p.id } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
      let problem: string | null = null;
      if (order.paymentStatus === 'PAID') {
        problem = 'This order had already been paid by another attempt. Refund this payment.';
      } else if (order.status !== 'PENDING_PAYMENT' && order.status !== 'CANCELLED' && order.paymentMethod !== p.method) {
        // The shopper switched to cash on delivery (or another method) and then this attempt went through too.
        // A rider may already be carrying it with cash to collect, so leave the order alone and ask a person.
        problem = `Paid online after the order was switched to ${order.paymentMethod === 'cod' ? 'cash on delivery' : order.paymentMethod}. Refund this payment, or mark the order paid and tell the rider to collect nothing.`;
      } else if (order.status === 'CANCELLED') {
        // Paid after the order timed out: take the items again if they're still there.
        const missing = await reserve(tx, p.order.items);
        if (missing) problem = `Paid after the order was cancelled, and ${missing} has sold out since. Refund this payment.`;
        await tx.order.update({ where: { id: order.id }, data: { status: missing ? 'CANCELLED' : 'PROCESSING', paymentStatus: 'PAID', paymentMethod: p.method } });
      } else {
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: 'PAID', paymentMethod: p.method, ...(order.status === 'PENDING_PAYMENT' ? { status: 'PROCESSING' } : {}) },
        });
      }
      if (problem) this.log.warn(`${p.invoice}: ${problem}`);
      return tx.payment.update({ where: { id: p.id }, data: { error: problem ?? outcome.error ?? null } });
    });
  }

  /** Asks the gateway where an attempt stands, and records it. */
  async check(paymentId: string) {
    const p = await this.payment(paymentId);
    const outcome = await GATEWAYS[p.gateway as GatewayId].query(await this.accountFor(p), p);
    return this.settle(p.id, outcome, 'status checked');
  }

  /**
   * Every minute (one API instance at a time): asks the gateways about attempts the shopper never came
   * back from, and cancels orders still unpaid after PAYMENT_TIMEOUT_MINUTES, putting their stock back.
   */
  async sweep(now = Date.now()) {
    if (!(await this.redis.set('payments:sweep', '1', 'EX', 50, 'NX'))) return;
    const timeout = env.paymentTimeoutMinutes * MINUTE;
    const stale = await this.db.payment.findMany({ where: { status: 'PENDING', createdAt: { lt: new Date(now - 5 * MINUTE) } }, take: 50 });
    for (const p of stale) {
      const outcome: Outcome = await this.accountFor(p)
        .then((acct) => GATEWAYS[p.gateway as GatewayId].query(acct, p))
        .catch((e: Error) => ({ status: 'PENDING', error: e.message }));
      if (outcome.status === 'PENDING' && now - p.createdAt.getTime() > timeout) {
        await this.db.payment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'EXPIRED', error: 'Not completed in time.' } });
      } else {
        await this.settle(p.id, outcome, 'status checked (sweep)');
      }
    }
    const unpaid = await this.db.order.findMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: new Date(now - timeout) }, payments: { none: { status: 'PENDING' } } },
      include: { items: true },
      take: 100,
    });
    for (const o of unpaid) {
      await this.db.$transaction(async (tx) => {
        const { count } = await tx.order.updateMany({ where: { id: o.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED', paymentStatus: 'EXPIRED' } });
        if (count) await restock(tx, o.items);
      });
    }
    return { checked: stale.length, expired: unpaid.length };
  }

  /** Sends money back through the gateway (or records a refund made in the gateway's own dashboard). */
  async refund(paymentId: string, dto: { amount?: number; reason?: string; manual?: boolean }) {
    const p = await this.payment(paymentId);
    if (p.status !== 'PAID') throw new ConflictException('Only paid payments can be refunded.');
    const left = round2(Number(p.amount) - Number(p.refunded));
    const amount = round2(dto.amount ?? left);
    if (amount <= 0 || amount > left) throw new BadRequestException(`Refund between ৳0.01 and ৳${left}.`);
    const gateway = GATEWAYS[p.gateway as GatewayId];
    if (!dto.manual && !gateway.refund) throw new BadRequestException(`${gateway.name} refunds are made in its merchant portal. Refund it there, then record it here.`);
    // Take the amount first, conditionally on what was refunded when we looked. Two refunds started
    // together (a double click, or the returns and payments screens at once) would otherwise both pass
    // the "how much is left" check and both reach the gateway.
    const { count } = await this.db.payment.updateMany({
      where: { id: p.id, status: 'PAID', refunded: p.refunded },
      data: { refunded: round2(Number(p.refunded) + amount) },
    });
    if (!count) throw new ConflictException('This payment was just changed by someone else. Refresh and check what has been refunded before trying again.');
    const appendLog = (tx: Prisma.TransactionClient, line: Record<string, unknown>, data: Prisma.PaymentUpdateInput = {}) =>
      tx.payment.findUniqueOrThrow({ where: { id: p.id } }).then((fresh) => tx.payment.update({ where: { id: p.id }, data: { ...data, log: [...((fresh.log as unknown[]) ?? []), line] as Prisma.InputJsonValue } }));
    let detail: Record<string, unknown> = { amount, reason: dto.reason, manual: !!dto.manual };
    if (!dto.manual) {
      try {
        const res = await gateway.refund!(await this.accountFor(p), p, amount, dto.reason?.trim() || 'Refund');
        detail = { ...detail, refundId: res.refundId, reply: res.raw };
      } catch (e) {
        // Give the amount back, so it can be tried again.
        await this.db.$transaction((tx) => appendLog(tx, entry('refund failed', { ...detail, error: (e as Error).message, reply: (e as GatewayError).raw }), { refunded: { decrement: amount } }));
        throw new BadGatewayException(e instanceof GatewayError ? e.message : `${gateway.name} didn’t accept the refund. Try again, or refund it in the merchant portal.`);
      }
    }
    return this.db.$transaction(async (tx) => {
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
      const full = Number(fresh.refunded) >= Number(fresh.amount) - 0.001;
      const updated = await appendLog(tx, entry('refunded', detail), { status: full ? 'REFUNDED' : 'PAID' });
      if (full) await tx.order.updateMany({ where: { id: p.orderId, paymentStatus: 'PAID', paymentMethod: p.method }, data: { paymentStatus: 'REFUNDED' } });
      return updated;
    });
  }

  /* ---------- admin list ---------- */

  async list(q: { status?: PaymentStatus; method?: string; q?: string; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const term = q.q?.trim();
    const where: Prisma.PaymentWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.method ? { method: q.method } : {}),
      ...(term ? { OR: [{ invoice: { contains: term, mode: 'insensitive' } }, { trxId: { contains: term, mode: 'insensitive' } }, { orderId: { contains: term, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total, grouped] = await Promise.all([
      this.db.payment.findMany({
        where,
        include: { order: { select: { id: true, total: true, status: true, user: { select: { id: true, name: true, email: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.payment.count({ where }),
      this.db.payment.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
    ]);
    return {
      items: rows.map(({ order, ...p }) => ({ ...toPayment(p), order: { id: order.id, total: Number(order.total), status: order.status }, customer: order.user })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      summary: Object.fromEntries(grouped.map((g) => [g.status, { count: g._count._all, amount: Number(g._sum.amount ?? 0) }])),
    };
  }
}

export const toPayment = (p: Payment) => ({
  id: p.id,
  method: p.method,
  gateway: p.gateway,
  sandbox: p.sandbox,
  status: p.status,
  invoice: p.invoice,
  amount: Number(p.amount),
  currency: p.currency,
  reference: p.reference,
  trxId: p.trxId,
  refunded: Number(p.refunded),
  error: p.error,
  paidAt: p.paidAt,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});
