/*
 * The stamp card: one stamp per delivered order, a personal single-use discount code when the card is full.
 * Each card starts with a head start already stamped: shoppers given artificial progress finish more often
 * (Nunes & Drèze 2006), and people speed up as a reward gets close (Kivetz, Urminsky & Zheng 2006). Loyalty
 * programmes lift repeat buying more than attitudes (Belli et al. 2022 meta-analysis).
 *
 * Off until the owner switches it on (Admin → Promotions → Stamp card): the reward costs money.
 */
import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Injectable, Module, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { type AuthUser, CurrentUser, JwtAuthGuard, Staff } from '../common/auth.js';
import { PrismaService } from '../common/infra.module.js';

const KEY = 'loyalty';
export const REWARD_PREFIX = 'STAMP-';

export interface LoyaltySettings {
  enabled: boolean;
  /** Delivered orders needed for a reward. */
  target: number;
  /** Stamps already on each new card. */
  headStart: number;
  /** Reward: percent off one order. */
  percentOff: number;
}
const DEFAULTS: LoyaltySettings = { enabled: false, target: 10, headStart: 2, percentOff: 10 };

export class LoyaltyDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(2) @Max(30) target?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5) headStart?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) percentOff?: number;
}

/** Where a shopper is on their card, from how many orders were delivered and rewards already earned. Pure. */
export function card(s: LoyaltySettings, delivered: number) {
  const earned = Math.floor(delivered / s.target);
  const progress = delivered - earned * s.target;
  return { earned, progress, slots: s.headStart + s.target, filled: s.headStart + progress, toGo: s.target - progress };
}

@Injectable()
export class LoyaltyService {
  constructor(private readonly db: PrismaService) {}

  async settings(): Promise<LoyaltySettings> {
    const row = await this.db.storeSetting.findUnique({ where: { key: KEY } });
    return { ...DEFAULTS, ...((row?.value ?? {}) as Partial<LoyaltySettings>) };
  }

  async save(dto: LoyaltyDto) {
    const next = { ...(await this.settings()), ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) };
    await this.db.storeSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: { ...next } }, update: { value: { ...next } } });
    return next;
  }

  /** The shopper's card, issuing any reward they've earned and not yet been given (so it's never lost). */
  async mine(userId: string) {
    const s = await this.settings();
    if (!s.enabled) return { enabled: false as const };
    const delivered = await this.db.order.count({ where: { userId, status: 'DELIVERED' } });
    const c = card(s, delivered);
    const issued = await this.db.promoCode.count({ where: { userId, code: { startsWith: REWARD_PREFIX } } });
    for (let i = issued; i < c.earned; i++) {
      await this.db.promoCode.create({
        data: { code: `${REWARD_PREFIX}${randomBytes(4).toString('hex').toUpperCase()}`, percent: s.percentOff / 100, userId, singleUse: true },
      });
    }
    const codes = await this.db.promoCode.findMany({ where: { userId, code: { startsWith: REWARD_PREFIX } }, orderBy: { code: 'asc' } });
    const used = new Set(
      (await this.db.order.findMany({ where: { userId, promoCode: { in: codes.map((x) => x.code) }, status: { not: 'CANCELLED' } }, select: { promoCode: true } })).map((o) => o.promoCode),
    );
    return {
      enabled: true as const,
      ...c,
      headStart: s.headStart,
      percentOff: s.percentOff,
      rewards: codes.map((x) => ({ code: x.code, percentOff: Math.round(x.percent * 100), used: used.has(x.code) })),
    };
  }
}

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/stamps')
export class StampsController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  mine(@CurrentUser() u: AuthUser) {
    return this.loyalty.mine(u.id);
  }
}

@ApiTags('admin')
@Staff('promos')
@Controller('admin/loyalty')
export class AdminLoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  get() {
    return this.loyalty.settings();
  }

  @Patch()
  save(@Body() dto: LoyaltyDto) {
    return this.loyalty.save(dto);
  }
}

@Module({ controllers: [StampsController, AdminLoyaltyController], providers: [LoyaltyService] })
export class LoyaltyModule {}
