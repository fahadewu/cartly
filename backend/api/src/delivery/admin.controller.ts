import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import bcrypt from 'bcryptjs';
import { STRONG, WEAK_MESSAGE } from '../auth/auth.module.js';
import { Needs, Staff } from '../common/auth.js';
import { PrismaService, RedisService } from '../common/infra.module.js';
import type { Prisma, ShipmentStatus } from '../generated/prisma/client.js';
import { COURIERS } from './couriers/index.js';
import { CourierError, type CourierId } from './couriers/types.js';
import { ACTIVE, DeliveryService, NEEDS_ATTENTION, toShipment } from './delivery.service.js';
import { CourierSettings } from './settings.js';

const STATUSES = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT', 'RETURNING', 'RETURNED', 'CANCELLED'] as const;
const CARRIERS = ['rider', 'pathao', 'steadfast', 'redx'] as const;
const VEHICLES = ['bike', 'bicycle', 'van', 'walk'] as const;
const PHONE = /^\+?[0-9][0-9 ()-]{6,19}$/;
const withRider = {
  rider: { include: { user: { select: { name: true } } } },
} as const;

/* ------------------------------ DTOs ------------------------------ */

export class CourierDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** true: real parcels; false: the courier's sandbox. */
  @IsOptional() @IsBoolean() live?: boolean;
  /** Only the values being changed; an empty string removes one. */
  @IsOptional() @IsObject() credentials?: Record<string, string>;
}
export class BookDto {
  @IsIn(CARRIERS) carrier: string;
  @IsOptional() @IsUUID() riderId?: string;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(50)
  weightKg?: number;
  @IsOptional() @IsString() @MaxLength(250) note?: string;
  @IsOptional()
  @Matches(PHONE, { message: 'Enter a valid phone number.' })
  phone?: string;
  @IsOptional() @IsString() @MinLength(4) @MaxLength(250) address?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) city?: string;
  @IsOptional() @IsObject() location?: Record<string, string>;
  @IsOptional() @IsObject() locationNames?: Record<string, string>;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  @Max(1_000_000)
  codAmount?: number;
}
export class ShipmentQuery {
  @IsOptional() @IsIn([...STATUSES, 'ACTIVE', 'ATTENTION']) status?: ShipmentStatus | 'ACTIVE' | 'ATTENTION';
  @IsOptional() @IsIn(CARRIERS) carrier?: string;
  @IsOptional() @IsUUID() rider?: string;
  /** Matches the order id, invoice, consignment or tracking code. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class CancelDto {
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
export class ReassignDto {
  @IsUUID() riderId: string;
}
/** An admin correcting a shipment by hand (a courier that doesn't report, a rider without the app). */
export class OverrideDto {
  @IsIn(STATUSES) status: ShipmentStatus;
  @IsOptional() @IsString() @MaxLength(200) message?: string;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  codCollected?: number;
}
export class RiderDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEmail() email: string;
  @Matches(PHONE, { message: 'Enter a valid phone number.' }) phone: string;
  @Matches(STRONG, { message: WEAK_MESSAGE }) password: string;
  @IsOptional() @IsString() @MaxLength(120) zone?: string;
  @IsOptional() @IsIn(VEHICLES) vehicle?: string;
}
export class UpdateRiderDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional()
  @Matches(PHONE, { message: 'Enter a valid phone number.' })
  phone?: string;
  @IsOptional() @IsString() @MaxLength(120) zone?: string;
  @IsOptional() @IsIn(VEHICLES) vehicle?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  /** A new password for the rider app. */
  @IsOptional() @Matches(STRONG, { message: WEAK_MESSAGE }) password?: string;
}

/* ------------------------------ Riders ------------------------------ */

@Injectable()
export class RidersService {
  constructor(
    private readonly db: PrismaService,
    private readonly delivery: DeliveryService,
  ) {}

  async list() {
    const riders = await this.db.rider.findMany({
      include: { user: { select: { name: true, email: true } } },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    });
    const [active, delivered] = await Promise.all([
      this.db.shipment.groupBy({
        by: ['riderId'],
        where: { carrier: 'rider', ...ACTIVE },
        _count: { _all: true },
      }),
      this.db.shipment.groupBy({
        by: ['riderId'],
        where: { carrier: 'rider', status: 'DELIVERED' },
        _count: { _all: true },
      }),
    ]);
    return Promise.all(
      riders.map(async (r) => ({
        id: r.id,
        userId: r.userId,
        name: r.user.name,
        email: r.user.email,
        phone: r.phone,
        zone: r.zone,
        vehicle: r.vehicle,
        active: r.active,
        createdAt: r.createdAt,
        onTheWay: active.find((g) => g.riderId === r.id)?._count._all ?? 0,
        delivered: delivered.find((g) => g.riderId === r.id)?._count._all ?? 0,
        cashHeld: await this.delivery.cashHeld(r.id),
      })),
    );
  }

  async one(id: string) {
    const r = (await this.list()).find((x) => x.id === id);
    if (!r) throw new NotFoundException('Rider not found.');
    return r;
  }

  /** A rider signs in to the rider app with this email and password. */
  async create(dto: RiderDto) {
    const email = dto.email.trim().toLowerCase();
    if (await this.db.user.findUnique({ where: { email } })) throw new ConflictException('That email already has an account. Use another one for the rider.');
    const r = await this.db.rider.create({
      data: {
        phone: dto.phone.trim(),
        zone: dto.zone?.trim() || null,
        vehicle: dto.vehicle ?? null,
        user: {
          create: {
            email,
            name: dto.name.trim(),
            role: 'RIDER',
            passwordHash: await bcrypt.hash(dto.password, 10),
          },
        },
      },
    });
    return this.one(r.id);
  }

  async update(id: string, dto: UpdateRiderDto) {
    const r = await this.db.rider.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Rider not found.');
    if (dto.active === false && (await this.db.shipment.count({ where: { riderId: id, ...ACTIVE } }))) {
      throw new ConflictException('This rider still has parcels on the way. Hand them to someone else first.');
    }
    await this.db.rider.update({
      where: { id },
      data: {
        phone: dto.phone?.trim(),
        zone: dto.zone === undefined ? undefined : dto.zone.trim() || null,
        vehicle: dto.vehicle,
        active: dto.active,
        user: {
          update: {
            ...(dto.name ? { name: dto.name.trim() } : {}),
            ...(dto.password ? { passwordHash: await bcrypt.hash(dto.password, 10) } : {}),
          },
        },
      },
    });
    return this.one(id);
  }
}

/* ------------------------------ Controllers ------------------------------ */

@ApiTags('admin · delivery')
@Staff('delivery')
@Controller('admin/delivery')
export class AdminDeliveryController {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly delivery: DeliveryService,
    private readonly settings: CourierSettings,
    private readonly riders: RidersService,
  ) {}

  /* ---------- couriers ---------- */

  @Get('couriers')
  couriers() {
    return this.settings.adminView();
  }

  @Needs('settings')
  @Put('couriers/:id')
  async saveCourier(@Param('id') id: string, @Body() dto: CourierDto) {
    await this.settings.save(id, dto);
    return this.settings.adminView();
  }

  /** Tries the saved credentials against the courier (books nothing). */
  @Needs('settings')
  @Post('couriers/:id/test')
  @HttpCode(200)
  async test(@Param('id') id: string) {
    const c = COURIERS[id as CourierId];
    if (!c) throw new NotFoundException('Unknown courier.');
    const acct = await this.settings.account(c.id);
    if (!acct) throw new BadRequestException(`Fill in every ${c.name} credential first.`);
    try {
      return { ok: true, message: await c.test(acct), live: acct.live };
    } catch (e) {
      throw new BadGatewayException(e instanceof CourierError ? e.message : `${c.name} didn’t respond: ${(e as Error).message}`);
    }
  }

  /** A courier's own list to pick from (Pathao cities → zones → areas, RedX areas), cached for a day. */
  @Get('couriers/:id/locations')
  async locations(@Param('id') id: string, @Query('level') level: string, @Query('parent') parent?: string) {
    const c = COURIERS[id as CourierId];
    if (!c?.locations || !c.levels.some((l) => l.key === level)) throw new NotFoundException('That courier has no such list.');
    const acct = await this.settings.account(c.id);
    if (!acct) throw new BadRequestException(`Fill in every ${c.name} credential first.`);
    const key = `delivery:places:${c.id}:${acct.live ? 'live' : 'sandbox'}:${level}:${parent ?? ''}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);
    try {
      const places = await c.locations(acct, level, parent);
      if (places.length) await this.redis.set(key, JSON.stringify(places), 'EX', 24 * 3600);
      return places;
    } catch (e) {
      throw new BadGatewayException(e instanceof CourierError ? e.message : `${c.name} didn’t send its list: ${(e as Error).message}`);
    }
  }

  /** What can take a parcel right now: active riders and couriers that are switched on and set up. */
  @Get('options')
  async options() {
    const [couriers, riders] = await Promise.all([
      this.settings.usable(),
      this.db.rider.findMany({
        where: { active: true },
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const load = await this.db.shipment.groupBy({
      by: ['riderId'],
      where: { carrier: 'rider', ...ACTIVE },
      _count: { _all: true },
    });
    return {
      couriers,
      riders: riders.map((r) => ({ id: r.id, name: r.user.name, phone: r.phone, zone: r.zone, vehicle: r.vehicle, onTheWay: load.find((g) => g.riderId === r.id)?._count._all ?? 0 })),
    };
  }

  /* ---------- riders ---------- */

  @Get('riders')
  listRiders() {
    return this.riders.list();
  }
  @Post('riders')
  createRider(@Body() dto: RiderDto) {
    return this.riders.create(dto);
  }
  @Patch('riders/:id')
  updateRider(@Param('id') id: string, @Body() dto: UpdateRiderDto) {
    return this.riders.update(id, dto);
  }
  /** The rider handed in the cash on delivery they collected. */
  @Needs('payments.write')
  @Post('riders/:id/settle')
  @HttpCode(200)
  async settle(@Param('id') id: string) {
    const settled = await this.delivery.settleCash(id);
    return { settled, rider: await this.riders.one(id) };
  }

  /* ---------- shipments ---------- */

  @Get('shipments')
  async shipments(@Query() q: ShipmentQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const term = q.q?.trim();
    const where: Prisma.ShipmentWhereInput = {
      ...(q.status === 'ACTIVE' ? ACTIVE : q.status === 'ATTENTION' ? NEEDS_ATTENTION : q.status ? { status: q.status } : {}),
      ...(q.carrier ? { carrier: q.carrier } : {}),
      ...(q.rider ? { riderId: q.rider } : {}),
      ...(term
        ? {
            OR: ['orderId', 'invoice', 'consignmentId', 'trackingCode'].map((f) => ({ [f]: { contains: term, mode: 'insensitive' } })),
          }
        : {}),
    };
    const [rows, total, grouped, problems] = await Promise.all([
      this.db.shipment.findMany({
        where,
        include: withRider,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.shipment.count({ where }),
      this.db.shipment.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.shipment.count({ where: NEEDS_ATTENTION }),
    ]);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0]));
    return {
      items: rows.map(toShipment),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      counts: {
        ...counts,
        ACTIVE: STATUSES.filter((s) => !['DELIVERED', 'RETURNED', 'CANCELLED'].includes(s)).reduce((n, s) => n + counts[s], 0),
      },
      problems,
    };
  }

  private async full(id: string) {
    return toShipment(
      await this.db.shipment.findUniqueOrThrow({
        where: { id },
        include: { ...withRider, events: { orderBy: { at: 'asc' } } },
      }),
    );
  }

  @Get('shipments/:id')
  async get(@Param('id') id: string) {
    await this.delivery.shipment(id);
    return this.full(id);
  }

  /** Sends an order out: to a rider, or booked with a courier. */
  @Post('orders/:orderId/ship')
  async book(@Param('orderId') orderId: string, @Body() dto: BookDto) {
    return this.full((await this.delivery.book(orderId, dto)).id);
  }

  /** Asks the courier where the parcel is now. */
  @Post('shipments/:id/sync')
  @HttpCode(200)
  async sync(@Param('id') id: string) {
    return this.full((await this.delivery.sync(id)).id);
  }

  @Post('shipments/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() dto: CancelDto) {
    return this.full((await this.delivery.cancel(id, dto.reason)).id);
  }

  @Post('shipments/:id/reassign')
  @HttpCode(200)
  async reassign(@Param('id') id: string, @Body() dto: ReassignDto) {
    return this.full((await this.delivery.reassign(id, dto.riderId)).id);
  }

  /** Sets the status by hand, with a note for the timeline. */
  @Post('shipments/:id/status')
  @HttpCode(200)
  async override(@Param('id') id: string, @Body() dto: OverrideDto) {
    const s = await this.delivery.shipment(id);
    if (s.status === dto.status) throw new ConflictException('It already has that status.');
    const message = ['Updated by the store', dto.message?.trim()].filter(Boolean).join(': ');
    return this.full(
      (
        await this.delivery.record(
          id,
          {
            status: dto.status,
            message,
            source: 'admin',
            codCollected: dto.codCollected,
          },
          true,
        )
      ).id,
    );
  }
}
