import { Body, Controller, Delete, Get, HttpCode, Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { type AuthUser, CurrentUser, JwtAuthGuard, Staff } from '../common/auth.js';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { env } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { suitingShades } from '../journeys/likeness.js';
import { PERSONALITIES } from '../journeys/taste.js';
import { DIRTY } from '../journeys/track.js';
import { JourneysModule } from '../journeys/journeys.module.js';
import { KIND_LABEL, KINDS, type Kind } from './email.js';
import { InsightsService } from './insights.js';
import { OutreachService } from './outreach.service.js';

const TYPES = ['Clothing', 'Shoes', 'Accessories', 'Home', 'Gifts'];
const PAGE = 25;

export class PreferencesDto {
  /** Monk Skin Tone scale, 1 (lightest) to 10 (deepest); null removes it. */
  @IsOptional() @IsInt() @Min(1) @Max(10) skinTone?: number | null;
  @IsOptional() @IsIn(['warm', 'cool', 'neutral', null]) undertone?: string | null;
  /** picked, or photo (estimated on the shopper's device and confirmed by them). */
  @IsOptional() @IsIn(['picked', 'photo']) toneSource?: string;
  /** Usual size per product type: { "Clothing": "M", "Shoes": "41" }. */
  @IsOptional() @IsObject() sizes?: Record<string, string>;
  @IsOptional() @IsIn(['slim', 'regular', 'relaxed', 'oversized', null]) fit?: string | null;
  @IsOptional() @IsBoolean() marketingEmails?: boolean;
  @IsOptional() @IsIn(['en', 'bn']) emailLang?: string;
  /** Styles picked in the style quiz (personality keys); [] forgets them. */
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(Object.keys(PERSONALITIES), { each: true }) styles?: string[];
}

class AutoDto {
  @IsOptional() @IsBoolean() found_it?: boolean;
  @IsOptional() @IsBoolean() back_in_stock?: boolean;
  @IsOptional() @IsBoolean() price_drop?: boolean;
  @IsOptional() @IsBoolean() cart?: boolean;
  @IsOptional() @IsBoolean() picked_for_you?: boolean;
}
export class OutreachSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => AutoDto) auto?: AutoDto;
  @IsOptional() @IsInt() @Min(1) @Max(30) capDays?: number;
  @IsOptional() @IsNumber() @Min(0.2) @Max(0.95) minLikeness?: number;
}
export class IdsDto {
  @ArrayMinSize(1) @ArrayMaxSize(200) @IsInt({ each: true }) ids: number[];
}
export class OutboxQuery {
  @IsOptional() @IsIn(['draft', 'queued', 'sent', 'skipped', 'failed']) status?: string;
  @IsOptional() @IsIn([...KINDS]) kind?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
export class DaysQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(400) days?: number;
}

const prefsView = (
  p: {
    skinTone: number | null;
    undertone: string | null;
    toneSource: string | null;
    toneUpdatedAt: Date | null;
    sizes: unknown;
    fit: string | null;
    styles?: string[];
    marketingEmails: boolean;
    marketingSince: Date | null;
    emailLang: string;
  } | null,
) => ({
  skinTone: p?.skinTone ?? null,
  undertone: p?.undertone ?? null,
  toneSource: p?.toneSource ?? null,
  toneUpdatedAt: p?.toneUpdatedAt ?? null,
  suits: p && (p.skinTone || p.undertone) ? suitingShades(p.skinTone, p.undertone) : [],
  sizes: (p?.sizes as Record<string, string>) ?? {},
  fit: p?.fit ?? null,
  /** From the style quiz, with their labels. */
  styles: (p?.styles ?? []).filter((k) => PERSONALITIES[k]).map((key) => ({ key, label: PERSONALITIES[key].label })),
  marketingEmails: p?.marketingEmails ?? false,
  marketingSince: p?.marketingSince ?? null,
  emailLang: p?.emailLang ?? 'en',
});

/** What shoppers tell the store about themselves (Account): sizes, colouring, and whether they want emails. */
@ApiTags('account')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/preferences')
export class PreferencesController {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async get(@CurrentUser() u: AuthUser) {
    return prefsView(await this.db.shopperPreferences.findUnique({ where: { userId: u.id } }));
  }

  @Put()
  async set(@CurrentUser() u: AuthUser, @Body() dto: PreferencesDto) {
    const current = await this.db.shopperPreferences.findUnique({ where: { userId: u.id } });
    const data: Prisma.ShopperPreferencesUncheckedUpdateInput = {};
    if (dto.skinTone !== undefined || dto.undertone !== undefined) {
      if (dto.skinTone !== undefined) data.skinTone = dto.skinTone;
      if (dto.undertone !== undefined) data.undertone = dto.undertone;
      data.toneSource = dto.toneSource ?? 'picked';
      data.toneUpdatedAt = new Date();
    }
    if (dto.sizes !== undefined) {
      data.sizes = Object.fromEntries(
        Object.entries(dto.sizes)
          .filter(([k, v]) => TYPES.includes(k) && typeof v === 'string' && v.trim())
          .map(([k, v]) => [k, String(v).trim().slice(0, 12)]),
      );
    }
    if (dto.fit !== undefined) data.fit = dto.fit;
    if (dto.styles !== undefined) {
      data.styles = [...new Set(dto.styles)];
      data.stylesAt = new Date();
    }
    if (dto.emailLang !== undefined) data.emailLang = dto.emailLang;
    if (dto.marketingEmails !== undefined) {
      data.marketingEmails = dto.marketingEmails;
      if (dto.marketingEmails && !current?.marketingEmails) data.marketingSince = new Date();
    }
    const saved = await this.db.shopperPreferences.upsert({
      where: { userId: u.id },
      create: { ...(data as Prisma.ShopperPreferencesUncheckedCreateInput), userId: u.id },
      update: data,
    });
    // New quiz answers reshape "Picked for you" on the next profile rebuild (seconds away).
    if (dto.styles !== undefined) await this.redis.sadd(DIRTY, u.id).catch(() => 0);
    if (dto.marketingEmails === false) {
      await this.db.outreach.updateMany({ where: { userId: u.id, status: { in: ['draft', 'queued'] } }, data: { status: 'skipped', error: 'They turned emails off.' } });
    }
    return prefsView(saved);
  }

  /** Removes the colouring (tone and undertone) and nothing else. */
  @Delete('colouring')
  async forgetColouring(@CurrentUser() u: AuthUser) {
    const saved = await this.db.shopperPreferences.upsert({
      where: { userId: u.id },
      create: { userId: u.id },
      update: { skinTone: null, undertone: null, toneSource: null, toneUpdatedAt: null },
    });
    return prefsView(saved);
  }
}

/** The links inside emails: no sign-in needed (the token is the key). */
@ApiTags('emails')
@Controller('o')
export class OutreachLinksController {
  constructor(private readonly outreach: OutreachService) {}

  @Get('c/:token')
  async click(@Param('token') token: string, @Query('p') p: string, @Res() res: Response) {
    res.redirect(302, await this.outreach.click(token, Number(p)));
  }

  @Get('u/:token')
  async unsubscribe(@Param('token') token: string, @Res() res: Response) {
    const ok = await this.outreach.unsubscribe(token);
    res.redirect(302, `${env.storefrontUrl}/account?${ok ? 'unsubscribed=1' : 'unsubscribe=unknown'}`);
  }

  /** One-click unsubscribe from the mail app (List-Unsubscribe-Post). */
  @Post('u/:token')
  @HttpCode(200)
  async unsubscribeNow(@Param('token') token: string) {
    return { unsubscribed: await this.outreach.unsubscribe(token) };
  }
}

@ApiTags('admin · emails')
@Staff('marketing')
@Controller('admin/outreach')
export class AdminOutreachController {
  constructor(
    private readonly outreach: OutreachService,
    private readonly db: PrismaService,
  ) {}

  /** The Outbox: emails by status, with the shopper, the products and why they were picked. */
  @Get()
  async list(@Query() q: OutboxQuery) {
    const status = q.status ?? 'draft';
    const page = q.page ?? 1;
    const where = { status, ...(q.kind ? { kind: q.kind } : {}) };
    const [items, total, counts] = await Promise.all([
      this.db.outreach.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: status === 'sent' ? { sentAt: 'desc' } : { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
      }),
      this.db.outreach.count({ where }),
      this.db.outreach.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const products = await this.db.product.findMany({
      where: { id: { in: [...new Set(items.flatMap((o) => o.productIds))] } },
      select: { id: true, name: true, image: true, price: true, stock: true, active: true },
    });
    const byId = new Map(products.map((p) => [p.id, { ...p, price: Number(p.price) }]));
    return {
      items: items.map((o) => ({
        ...o,
        kindLabel: KIND_LABEL[o.kind as Kind] ?? o.kind,
        products: o.productIds.map((id) => byId.get(id)).filter(Boolean),
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      page,
      pages: Math.max(1, Math.ceil(total / PAGE)),
      total,
    };
  }

  @Get('settings')
  async settings() {
    return { ...(await this.outreach.settings()), kinds: KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k] })), mail: { configured: this.outreach.mailer.configured, server: this.outreach.mailer.server, from: env.mailFrom } };
  }

  @Patch('settings')
  async saveSettings(@Body() dto: OutreachSettingsDto) {
    await this.outreach.saveSettings(dto as Parameters<OutreachService['saveSettings']>[0]);
    return this.settings();
  }

  /** Finds new matches and sends what's due now, instead of waiting for the next minute. */
  @Post('run')
  @HttpCode(200)
  async run() {
    return (await this.outreach.tick()) ?? { busy: true };
  }

  @Post('send')
  @HttpCode(200)
  send(@Body() dto: IdsDto, @CurrentUser() u: AuthUser) {
    return this.outreach.sendDue(dto.ids, u.id);
  }

  @Post('skip')
  @HttpCode(200)
  skip(@Body() dto: IdsDto, @CurrentUser() u: AuthUser) {
    return this.outreach.skip(dto.ids, u.id);
  }

  /** One email with its preview, as the shopper would get it now. */
  @Get(':id')
  async one(@Param('id', ParseIntPipe) id: number) {
    const o = await this.db.outreach.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, email: true, preferences: true } } } });
    if (!o) throw new NotFoundException('Email not found.');
    const prefs = o.user.preferences;
    const preview = await this.outreach.render(o, { name: o.user.name, emailLang: prefs?.emailLang ?? 'en', unsubscribeToken: prefs?.unsubscribeToken ?? 'preview' });
    const { preferences: _, ...user } = o.user;
    return { ...o, user, kindLabel: KIND_LABEL[o.kind as Kind] ?? o.kind, preview };
  }
}

@ApiTags('admin · analytics')
@Controller('admin/analytics')
export class AdminInsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** What one shopper likes: taste over time, colouring and sizes they shared, best matches, wants and emails. */
  @Staff('customers')
  @Get('shoppers/:userId/likeness')
  likeness(@Param('userId') userId: string) {
    return this.insights.shopper(userId);
  }

  /** Store-wide: what shoppers want and didn't find, colours they lean to, and how outreach emails do. */
  @Staff('analytics')
  @Get('interests')
  interests(@Query() q: DaysQuery) {
    return this.insights.interests(q.days ?? 30);
  }
}

@Module({
  imports: [JourneysModule],
  controllers: [PreferencesController, OutreachLinksController, AdminOutreachController, AdminInsightsController],
  providers: [OutreachService, InsightsService],
  exports: [OutreachService],
})
export class OutreachModule {}
