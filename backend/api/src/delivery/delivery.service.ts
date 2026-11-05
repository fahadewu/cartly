import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { withLock } from '../common/lock.js';
import type { Prisma, Shipment, ShipmentStatus } from '../generated/prisma/client.js';
import { COURIERS } from './couriers/index.js';
import { CourierError, type CourierId, localPhone, type Tracking, type Update } from './couriers/types.js';
import { CourierSettings } from './settings.js';

const MINUTE = 60_000;
/**
 * When a timeline entry goes: the courier's time, but never before the latest entry already there
 * (couriers' clocks and time zones vary, and a step can't come before the booking).
 */
const after = (at: Date, latest?: Date) => {
  const t = Number.isNaN(at.getTime()) ? new Date() : at;
  return latest && !(t > latest) ? new Date(latest.getTime() + 1) : t;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Nothing more happens to these (an admin can still correct one). */
export const TERMINAL: ShipmentStatus[] = ['DELIVERED', 'RETURNED', 'CANCELLED'];
export const ACTIVE: Prisma.ShipmentWhereInput = { status: { notIn: TERMINAL } };
/**
 * Deliveries someone has to look at: a courier sync problem or short cash collection on one still
 * current, or a parcel back at the store whose order hasn't been re-sent or cancelled.
 */
export const NEEDS_ATTENTION: Prisma.ShipmentWhereInput = {
  OR: [
    { error: { not: null }, status: { notIn: ['CANCELLED', 'RETURNED'] } },
    { status: 'RETURNED', order: { status: { in: ['PROCESSING', 'SHIPPED'] }, shipments: { none: { status: { notIn: ['RETURNED', 'CANCELLED'] } } } } },
  ],
};
/** The parcel has left the store. */
const MOVING: ShipmentStatus[] = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'RETURNING'];

/** What the store's own rider can do next, from each state. */
export const RIDER_NEXT: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  BOOKED: ['PICKED_UP'],
  PICKED_UP: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'FAILED_ATTEMPT'],
  FAILED_ATTEMPT: ['OUT_FOR_DELIVERY', 'RETURNING'],
  RETURNING: ['RETURNED'],
};

/** A rider collecting a return: pick it up from the customer, hand it in at the store. */
export const RETURN_NEXT: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  BOOKED: ['PICKED_UP', 'FAILED_ATTEMPT'],
  FAILED_ATTEMPT: ['PICKED_UP'],
  PICKED_UP: ['DELIVERED'],
};
export const riderNext = (s: { kind: string; status: ShipmentStatus }) => ((s.kind === 'return' ? RETURN_NEXT : RIDER_NEXT)[s.status] ?? []);

/** How each status reads in a tracking timeline when nobody wrote anything more specific. */
export const STATUS_TEXT: Record<ShipmentStatus, string> = {
  BOOKED: 'Parcel booked for delivery',
  PICKED_UP: 'Picked up from the store',
  IN_TRANSIT: 'On the way to the delivery hub',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  FAILED_ATTEMPT: 'Delivery attempt didn’t succeed',
  RETURNING: 'Returning to the store',
  RETURNED: 'Returned to the store',
  CANCELLED: 'Delivery cancelled',
};

export const CARRIER_NAME = (carrier: string) => (carrier === 'rider' ? 'Cartly rider' : (COURIERS[carrier as CourierId]?.name ?? carrier));

export interface Change {
  status: ShipmentStatus | null;
  message?: string;
  /** courier | rider | admin | system */
  source: string;
  courierStatus?: string;
  charge?: number;
  codCollected?: number;
  raw?: unknown;
  at?: Date;
}

export interface BookDto {
  carrier: string;
  riderId?: string;
  weightKg?: number;
  note?: string;
  /** Overrides for what's on the order (a courier needs a Bangladeshi mobile number). */
  phone?: string;
  address?: string;
  city?: string;
  /** Picks from the courier's own lists, by level key (Pathao city/zone/area, RedX area). */
  location?: Record<string, string>;
  locationNames?: Record<string, string>;
  /** Taka to collect; worked out from the order when left out. */
  codAmount?: number;
}

/**
 * Getting orders to customers: with the store's own riders, or booked with a courier (Pathao, Steadfast,
 * RedX). Every change to a shipment goes through `record`, which locks the row, keeps a timeline, and
 * moves the order along (shipped once picked up, delivered on delivery, cash on delivery collected).
 * Courier parcels are kept current by their webhooks and a sweep that asks the courier every few minutes.
 */
@Injectable()
export class DeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Delivery');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: CourierSettings,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return; // tests call sweep() themselves
    this.timer = setInterval(() => this.sweep().catch((e: Error) => this.log.warn(`Delivery sweep failed: ${e.message}`)), 5 * MINUTE);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async shipment(id: string) {
    const s = await this.db.shipment.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Shipment not found.');
    return s;
  }

  private async accountFor(carrier: string) {
    const acct = await this.settings.account(carrier as CourierId);
    if (!acct) throw new ConflictException(`${CARRIER_NAME(carrier)} isn’t set up any more. Add its credentials under Delivery.`);
    return acct;
  }

  /* ---------- booking ---------- */

  /** Hands an order to a rider or books it with a courier. */
  book(orderId: string, dto: BookDto) {
    // One booking per order at a time: a courier booking is a real parcel and a real charge, and it's
    // made before the shipment row exists, so two staff pressing "Ship" together must not both get through.
    return withLock(this.redis, `book:${orderId}`, 90, 'Someone else is sending this order out right now. Refresh to see it.', () => this.bookNow(orderId, dto));
  }
  private async bookNow(orderId: string, dto: BookDto) {
    const order = await this.db.order.findUnique({ where: { id: orderId }, include: { items: true, shipments: { where: { kind: 'delivery' }, select: { status: true } } } });
    if (!order) throw new NotFoundException('Order not found.');
    if (order.status !== 'PROCESSING' && order.status !== 'SHIPPED') throw new ConflictException(`A ${order.status.toLowerCase().replace('_', ' ')} order can’t be sent out.`);
    if (order.shipments.some((s) => !TERMINAL.includes(s.status))) throw new ConflictException('This order already has a delivery on the way. Cancel that one first.');
    if (order.shipments.some((s) => s.status === 'DELIVERED')) throw new ConflictException('This order has already been delivered.');

    const address = order.address as Record<string, string>;
    const phone = (dto.phone ?? address.phone ?? '').trim();
    const recipient = {
      name: address.name,
      phone,
      address: (dto.address ?? [address.street, address.postal].filter(Boolean).join(', ')).trim(),
      city: (dto.city ?? address.city).trim(),
    };
    if (!recipient.phone) throw new BadRequestException('Add the customer’s phone number: the rider or courier has to be able to call them.');
    const unpaidCod = order.paymentMethod === 'cod' && order.paymentStatus === 'UNPAID';
    // Couriers and riders collect whole taka.
    const codAmount = dto.codAmount ?? (unpaidCod ? Math.round(Number(order.amountBdt ?? 0)) : 0);
    if (unpaidCod && codAmount <= 0) throw new BadRequestException('This is a cash-on-delivery order: set the amount to collect.');
    const invoice = order.shipments.length ? `${order.id}-${order.shipments.length + 1}` : order.id;
    const weightKg = dto.weightKg ?? 0.5;
    const base = { orderId, invoice, codAmount, weightKg, note: dto.note?.trim() || null };

    if (dto.carrier === 'rider') {
      if (!dto.riderId) throw new BadRequestException('Choose a rider.');
      const rider = await this.db.rider.findUnique({ where: { id: dto.riderId }, include: { user: { select: { name: true } } } });
      if (!rider?.active) throw new BadRequestException('That rider isn’t active.');
      const s = await this.db.shipment.create({
        data: {
          ...base,
          carrier: 'rider',
          riderId: rider.id,
          recipient,
          deliveryCode: String(randomInt(1000, 10000)),
          events: { create: { status: 'BOOKED', message: `Assigned to ${rider.user.name}`, source: 'admin' } },
        },
      });
      return s;
    }

    const courier = COURIERS[dto.carrier as CourierId];
    if (!courier) throw new BadRequestException('Unknown courier.');
    const row = await this.db.courier.findUnique({ where: { id: courier.id } });
    if (!row?.enabled) throw new ConflictException(`${courier.name} is switched off. Turn it on under Delivery.`);
    const acct = await this.accountFor(courier.id);
    if (courier.noSandbox && !acct.live) {
      throw new ConflictException(`${courier.name} has no test mode: every booking is a real parcel with a pickup. Switch it to live under Delivery → Couriers when you’re ready.`);
    }
    const mobile = localPhone(recipient.phone);
    if (!mobile) throw new BadRequestException(`${courier.name} needs a Bangladeshi mobile number (01XXXXXXXXX). Correct the phone number.`);
    const location = dto.location ?? {};
    for (const l of courier.levels) if (!l.optional && !location[l.key]) throw new BadRequestException(`Choose the ${l.label.toLowerCase()} for ${courier.name}.`);

    const value = Math.round(Number(order.amountBdt ?? 0));
    let booked;
    try {
      booked = await courier.book(acct, {
        invoice,
        recipient: { ...recipient, phone: mobile },
        location,
        locationNames: dto.locationNames ?? {},
        codAmount,
        value,
        weightKg,
        itemCount: order.items.reduce((n, i) => n + i.qty, 0),
        description: order.items.map((i) => `${i.qty}× ${i.name}`).join(', ').slice(0, 250),
        note: base.note ?? undefined,
      });
    } catch (e) {
      this.log.warn(`${courier.name} booking failed for ${order.id}: ${(e as Error).message}`);
      throw new BadGatewayException(e instanceof CourierError ? e.message : `${courier.name} didn’t respond. Try again in a moment.`);
    }
    return this.db.shipment.create({
      data: {
        ...base,
        carrier: courier.id,
        sandbox: !acct.live,
        recipient: { ...recipient, phone: mobile, location, locationNames: dto.locationNames ?? {} },
        consignmentId: booked.consignmentId,
        trackingCode: booked.trackingCode ?? booked.consignmentId,
        trackingUrl: booked.trackingUrl ?? courier.publicTrackingUrl(booked.trackingCode ?? booked.consignmentId),
        courierStatus: booked.courierStatus ?? null,
        charge: booked.charge ?? null,
        status: booked.status ?? 'BOOKED',
        events: { create: { status: booked.status ?? 'BOOKED', message: `Booked with ${courier.name}${acct.live ? '' : ' (sandbox)'}`, source: 'admin', raw: (booked.raw ?? undefined) as Prisma.InputJsonValue } },
      },
    });
  }

  /** Sends a rider to collect an approved return from the customer. */
  async bookReturnPickup(returnId: string, riderId: string, note?: string) {
    const rt = await this.db.returnRequest.findUnique({ where: { id: returnId }, include: { order: true, shipments: { select: { status: true } } } });
    if (!rt) throw new NotFoundException('Return not found.');
    if (rt.status !== 'APPROVED') throw new ConflictException('Only an approved return can be collected.');
    if (rt.shipments.some((x) => !TERMINAL.includes(x.status))) throw new ConflictException('A rider is already collecting this return.');
    const rider = await this.db.rider.findUnique({ where: { id: riderId }, include: { user: { select: { name: true } } } });
    if (!rider?.active) throw new BadRequestException('That rider isn’t active.');
    const a = rt.order.address as Record<string, string>;
    if (!a.phone) throw new BadRequestException('The order has no phone number for the rider to call.');
    return this.db.shipment.create({
      data: {
        orderId: rt.orderId,
        kind: 'return',
        returnId: rt.id,
        carrier: 'rider',
        riderId: rider.id,
        invoice: rt.shipments.length ? `${rt.id}-${rt.shipments.length + 1}` : rt.id,
        recipient: { name: a.name, phone: a.phone, address: [a.street, a.postal].filter(Boolean).join(', '), city: a.city },
        note: note?.trim() || null,
        events: { create: { status: 'BOOKED', message: `Return pickup assigned to ${rider.user.name}`, source: 'admin' } },
      },
    });
  }

  /* ---------- every change ---------- */

  /**
   * Records what happened to a shipment and moves the order along. Only the first word on a finished
   * (delivered, returned, cancelled) shipment counts unless `force` (an admin correcting it).
   */
  async record(id: string, change: Change, force = false): Promise<Shipment> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Shipment" WHERE id = ${id} FOR UPDATE`;
      const s = await tx.shipment.findUnique({ where: { id }, include: { order: true } });
      if (!s) throw new NotFoundException('Shipment not found.');
      // A courier cancelling a parcel it already picked up sends it back to the store.
      const wanted = change.status === 'CANCELLED' && s.pickedUpAt && change.source === 'courier' ? 'RETURNED' : change.status;
      const next = wanted && wanted !== s.status && (force || !TERMINAL.includes(s.status)) ? wanted : null;
      const message = change.message?.trim() || (wanted ? STATUS_TEXT[wanted] : change.courierStatus) || 'Update';

      const last = await tx.shipmentEvent.findFirst({ where: { shipmentId: id }, orderBy: { at: 'desc' } });
      const at = after(change.at ?? new Date(), last?.at);
      if (next || last?.message !== message) {
        await tx.shipmentEvent.create({
          data: { shipmentId: id, status: next ?? s.status, message, source: change.source, raw: (change.raw ?? undefined) as Prisma.InputJsonValue, at },
        });
      }
      const data: Prisma.ShipmentUpdateInput = { error: null };
      if (change.courierStatus) data.courierStatus = change.courierStatus;
      if (change.charge != null) data.charge = change.charge;
      if (next) data.status = next;
      if (next && MOVING.includes(next) && !s.pickedUpAt) data.pickedUpAt = at;
      if (next === 'DELIVERED') {
        data.deliveredAt = at;
        // A courier reports delivery once it has the cash; a rider says how much they took.
        data.codCollected = s.kind === 'return' ? 0 : (change.codCollected ?? Number(s.codAmount));
      } else if (change.codCollected != null) data.codCollected = change.codCollected;
      const updated = await tx.shipment.update({ where: { id }, data });

      // A return pickup handed in at the store: the return is back, ready to inspect.
      if (s.kind === 'return') {
        if (next === 'DELIVERED' && s.returnId) {
          await tx.returnRequest.updateMany({ where: { id: s.returnId, status: 'APPROVED' }, data: { status: 'RECEIVED', receivedAt: at } });
        }
        return updated;
      }

      // The order follows its parcel.
      const o = s.order;
      if (next && MOVING.includes(next) && o.status === 'PROCESSING') {
        await tx.order.updateMany({ where: { id: o.id, status: 'PROCESSING' }, data: { status: 'SHIPPED' } });
      }
      if (next === 'DELIVERED') {
        const collected = Number(updated.codCollected ?? 0);
        const cod = o.paymentMethod === 'cod' && o.paymentStatus === 'UNPAID';
        const short = cod && collected + 0.5 < Number(s.codAmount);
        await tx.order.updateMany({
          where: { id: o.id, status: { in: ['PROCESSING', 'SHIPPED'] } },
          data: { status: 'DELIVERED', ...(cod && !short ? { paymentStatus: 'PAID' as const } : {}) },
        });
        if (short) {
          const problem = `Collected ৳${collected} of ৳${Number(s.codAmount)}. Mark the order paid once the rest is in.`;
          this.log.warn(`${s.invoice}: ${problem}`);
          return tx.shipment.update({ where: { id }, data: { error: problem } });
        }
      }
      return updated;
    });
  }

  /** Applies what a courier reported (webhook or tracking), with its history. */
  private async apply(s: Shipment, t: Tracking | Update, source: string) {
    const events = 'events' in t ? (t.events ?? []) : [];
    // Earlier steps from the courier's history that we haven't seen, then the current state.
    if (events.length) {
      const had = await this.db.shipmentEvent.findMany({ where: { shipmentId: s.id }, select: { message: true, at: true }, orderBy: { at: 'asc' } });
      const known = new Set(had.map((e) => e.message));
      let last = had.at(-1)?.at;
      for (const e of events.slice(0, -1)) {
        if (known.has(e.message)) continue;
        last = after(e.at, last);
        await this.db.shipmentEvent.create({ data: { shipmentId: s.id, status: e.status ?? s.status, message: e.message, source, at: last } });
      }
    }
    const latest = events.at(-1);
    return this.record(s.id, {
      status: t.status,
      courierStatus: t.courierStatus,
      message: ('message' in t ? t.message : latest?.message) || undefined,
      at: ('at' in t ? t.at : latest?.at) ?? undefined,
      charge: t.charge,
      codCollected: t.codCollected,
      raw: t.raw,
      source,
    });
  }

  /** Asks the courier where a parcel is. */
  async sync(id: string) {
    const s = await this.shipment(id);
    if (s.carrier === 'rider') return s;
    const courier = COURIERS[s.carrier as CourierId];
    try {
      return await this.apply(s, await courier.track(await this.accountFor(s.carrier), s), 'courier');
    } catch (e) {
      const message = e instanceof CourierError || e instanceof ConflictException ? e.message : `${courier.name} didn’t respond: ${(e as Error).message}`;
      await this.db.shipment.update({ where: { id }, data: { error: message } });
      throw new BadGatewayException(message);
    }
  }

  /** A courier's webhook: authenticates it and applies each update. */
  async webhook(carrier: string, req: { headers: Record<string, string | undefined>; query: Record<string, string | undefined>; body: Record<string, unknown> }) {
    const courier = COURIERS[carrier as CourierId];
    const acct = courier?.webhook && (await this.settings.account(courier.id));
    if (!courier?.webhook || !acct) return null;
    const reply = await courier.webhook(acct, req);
    if (!reply) return null;
    for (const u of reply.updates) {
      const s = await this.db.shipment.findFirst({
        where: { carrier, OR: [...(u.consignmentId ? [{ consignmentId: u.consignmentId }] : []), ...(u.invoice ? [{ invoice: u.invoice }] : [])] },
      });
      if (s) await this.apply(s, u, 'courier');
      else this.log.warn(`${courier.name} webhook for an unknown parcel: ${u.consignmentId ?? u.invoice}`);
    }
    return reply;
  }

  /**
   * Every five minutes (one API instance at a time): asks the couriers about parcels on the way that
   * haven't been heard of for half an hour, in case a webhook was missed or never set up.
   */
  async sweep(now = Date.now()) {
    if (!(await this.redis.set('delivery:sweep', '1', 'EX', 240, 'NX'))) return { checked: 0 };
    const stale = await this.db.shipment.findMany({
      where: { ...ACTIVE, carrier: { not: 'rider' }, updatedAt: { lt: new Date(now - 30 * MINUTE) } },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    for (const s of stale) {
      await this.sync(s.id).catch((e: Error) => this.log.warn(`Tracking ${s.invoice} failed: ${e.message}`));
    }
    return { checked: stale.length };
  }

  /** Stops a delivery that hasn't left yet: cancelled with the courier too, where it has an API for it. */
  async cancel(id: string, reason?: string) {
    const s = await this.shipment(id);
    if (TERMINAL.includes(s.status)) throw new ConflictException('This delivery is already finished.');
    if (s.carrier !== 'rider') {
      if (s.status !== 'BOOKED') throw new ConflictException(`The courier already has the parcel. Ask ${CARRIER_NAME(s.carrier)} to return it; it’ll show here as returning.`);
      const courier = COURIERS[s.carrier as CourierId];
      if (!courier.cancel) throw new ConflictException(`${courier.name} parcels are cancelled in its merchant panel. Cancel ${s.consignmentId} there; this updates once ${courier.name} reports it.`);
      try {
        await courier.cancel(await this.accountFor(s.carrier), s);
      } catch (e) {
        throw new BadGatewayException(e instanceof CourierError ? e.message : `${courier.name} didn’t cancel it. Try again, or cancel it in its merchant panel.`);
      }
    } else if (s.status !== 'BOOKED' && s.status !== 'RETURNED') {
      throw new ConflictException('The rider already has the parcel. Have them bring it back and mark it returned.');
    }
    return this.record(id, { status: 'CANCELLED', message: reason?.trim() ? `Cancelled: ${reason.trim()}` : undefined, source: 'admin' });
  }

  /** Gives a rider's parcel to another rider (not once it's been delivered or returned). */
  async reassign(id: string, riderId: string) {
    const s = await this.shipment(id);
    if (s.carrier !== 'rider' || TERMINAL.includes(s.status)) throw new ConflictException('Only a rider delivery still on the way can be handed to another rider.');
    const rider = await this.db.rider.findUnique({ where: { id: riderId }, include: { user: { select: { name: true } } } });
    if (!rider?.active) throw new BadRequestException('That rider isn’t active.');
    await this.db.shipment.update({ where: { id }, data: { riderId } });
    return this.record(id, { status: null, message: `Handed to ${rider.user.name}`, source: 'admin' });
  }

  /* ---------- the store's riders ---------- */

  private async riderOf(userId: string) {
    const r = await this.db.rider.findUnique({ where: { userId }, include: { user: { select: { name: true, email: true } } } });
    if (!r?.active) throw new ConflictException('Your rider account is switched off. Talk to the store.');
    return r;
  }

  async riderHome(userId: string) {
    const r = await this.riderOf(userId);
    const [active, done, cash] = await Promise.all([
      this.db.shipment.findMany({ where: { riderId: r.id, ...ACTIVE }, include: JOB, orderBy: { createdAt: 'asc' } }),
      this.db.shipment.findMany({
        where: { riderId: r.id, status: { in: TERMINAL }, updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * MINUTE) } },
        include: JOB,
        orderBy: { updatedAt: 'desc' },
        take: 30,
      }),
      this.cashHeld(r.id),
    ]);
    return { rider: { id: r.id, name: r.user.name, phone: r.phone, zone: r.zone, vehicle: r.vehicle }, cashHeld: cash, active: active.map(toRiderJob), done: done.map(toRiderJob) };
  }

  /** A rider moving their parcel on. Delivery needs the customer's code, and the cash they took. */
  async riderUpdate(userId: string, id: string, dto: { status: ShipmentStatus; note?: string; code?: string; collected?: number }) {
    const r = await this.riderOf(userId);
    const s = await this.db.shipment.findFirst({ where: { id, riderId: r.id } });
    if (!s) throw new NotFoundException('That delivery isn’t assigned to you.');
    if (!riderNext(s).includes(dto.status)) throw new ConflictException(`This parcel is ${STATUS_TEXT[s.status].toLowerCase()}; it can’t be marked that way now.`);
    const note = dto.note?.trim();
    if (dto.status === 'FAILED_ATTEMPT' && !note) throw new BadRequestException('Say what happened, e.g. “customer didn’t answer”.');
    let collected: number | undefined;
    if (dto.status === 'DELIVERED') {
      if (s.deliveryCode && dto.code?.trim() !== s.deliveryCode) throw new BadRequestException('That delivery code isn’t right. Ask the customer for the 4-digit code on their order page.');
      collected = Number(s.codAmount) > 0 ? round2(dto.collected ?? Number(s.codAmount)) : 0;
    }
    const text = (
      (s.kind === 'return'
        ? { PICKED_UP: `Return collected by ${r.user.name}`, DELIVERED: `Return handed in at the store by ${r.user.name}`, FAILED_ATTEMPT: 'Couldn’t collect the return' }
        : { PICKED_UP: `Picked up by ${r.user.name}`, OUT_FOR_DELIVERY: `${r.user.name} is on the way`, DELIVERED: `Delivered by ${r.user.name}` }) as Record<string, string>
    )[dto.status];
    return toRiderJob(
      await this.record(s.id, { status: dto.status, message: [text ?? STATUS_TEXT[dto.status], note].filter(Boolean).join(': '), source: 'rider', codCollected: collected }).then((u) =>
        this.db.shipment.findUniqueOrThrow({ where: { id: u.id }, include: JOB }),
      ),
    );
  }

  /** Cash on delivery a rider has collected but not yet handed in. */
  async cashHeld(riderId: string) {
    const agg = await this.db.shipment.aggregate({
      where: { riderId, carrier: 'rider', kind: 'delivery', status: 'DELIVERED', codSettledAt: null, codCollected: { gt: 0 } },
      _sum: { codCollected: true },
      _count: { _all: true },
    });
    return { amount: Number(agg._sum.codCollected ?? 0), parcels: agg._count._all };
  }

  /** The rider handed in their cash: every collected amount so far counts as received. */
  async settleCash(riderId: string) {
    const held = await this.cashHeld(riderId);
    if (!held.parcels) throw new ConflictException('This rider isn’t holding any cash.');
    await this.db.shipment.updateMany({
      where: { riderId, carrier: 'rider', kind: 'delivery', status: 'DELIVERED', codSettledAt: null, codCollected: { gt: 0 } },
      data: { codSettledAt: new Date() },
    });
    return held;
  }
}

/* ---------- what each audience sees ---------- */

type WithRider = Shipment & { rider?: { phone: string; user: { name: string } } | null; events?: { status: ShipmentStatus; message: string; at: Date; source: string }[] };

export const toShipment = (s: WithRider) => ({
  id: s.id,
  orderId: s.orderId,
  carrier: s.carrier,
  carrierName: CARRIER_NAME(s.carrier),
  sandbox: s.sandbox,
  status: s.status,
  invoice: s.invoice,
  consignmentId: s.consignmentId,
  trackingCode: s.trackingCode,
  trackingUrl: s.trackingUrl,
  courierStatus: s.courierStatus,
  codAmount: Number(s.codAmount),
  codCollected: s.codCollected == null ? null : Number(s.codCollected),
  codSettledAt: s.codSettledAt,
  charge: s.charge == null ? null : Number(s.charge),
  weightKg: s.weightKg == null ? null : Number(s.weightKg),
  note: s.note,
  recipient: s.recipient,
  deliveryCode: s.deliveryCode,
  error: s.error,
  rider: s.rider ? { id: s.riderId, name: s.rider.user.name, phone: s.rider.phone } : null,
  kind: s.kind,
  returnId: s.returnId,
  riderNext: s.carrier === 'rider' ? riderNext(s) : [],
  pickedUpAt: s.pickedUpAt,
  deliveredAt: s.deliveredAt,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  events: (s.events ?? []).map((e) => ({ status: e.status, message: e.message, at: e.at, source: e.source })),
});

/** The shopper's view: where it is and who's bringing it, nothing internal. */
export const toCustomerShipment = (s: WithRider) => ({
  carrier: s.carrier,
  carrierName: CARRIER_NAME(s.carrier),
  status: s.status,
  trackingCode: s.carrier === 'rider' ? null : s.trackingCode,
  trackingUrl: s.carrier === 'rider' || s.sandbox ? null : s.trackingUrl,
  codAmount: Number(s.codAmount),
  // The rider's name and number while they have the parcel, and the code to give them at the door.
  rider: s.rider && !TERMINAL.includes(s.status) ? { name: s.rider.user.name, phone: s.rider.phone } : null,
  deliveryCode: s.carrier === 'rider' && !TERMINAL.includes(s.status) ? s.deliveryCode : null,
  deliveredAt: s.deliveredAt,
  events: (s.events ?? []).map((e) => ({ status: e.status, message: e.message, at: e.at })),
});

const JOB = { order: { include: { items: true } }, return: { include: { items: { include: { orderItem: true } } } } } as const;
type Item = { name: string; qty: number; color: string; size: string; image: string };
type Job = Shipment & { order: { id: string; paymentMethod: string; items: Item[] }; return?: { items: { qty: number; orderItem: Item }[] } | null };

/** A rider's view of a parcel: who, where, what to collect. Never the delivery code: the customer gives it. */
const toRiderJob = (s: Job) => ({
  id: s.id,
  orderId: s.order.id,
  /** delivery, or return: collecting a return from the customer. */
  kind: s.kind,
  returnId: s.returnId,
  status: s.status,
  next: riderNext(s),
  recipient: s.recipient,
  codAmount: Number(s.codAmount),
  codCollected: s.codCollected == null ? null : Number(s.codCollected),
  needsCode: !!s.deliveryCode,
  note: s.note,
  // A return pickup lists only what's coming back.
  items: (s.return ? s.return.items.map((r) => ({ ...r.orderItem, qty: r.qty })) : s.order.items).map((i) => ({ name: i.name, qty: i.qty, color: i.color, size: i.size, image: i.image })),
  error: s.error,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  deliveredAt: s.deliveredAt,
});
