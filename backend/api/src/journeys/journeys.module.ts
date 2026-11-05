import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  OnModuleInit,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Request } from 'express';
import { Needs, Staff, type AuthUser, CurrentUser, JwtAuthGuard, OptionalAuthGuard } from '../common/auth.js';
import { can } from '../common/permissions.js';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { RangeQuery } from '../analytics/analytics.module.js';
import { env } from '../config.js';
import { geoOf, openGeoIp } from './geo.js';
import { JourneyAnalytics } from './journeys.service.js';
import { ProfileService, RECO_LIMIT } from './profile.js';
import { DIRTY, JourneyWorker, TrackQueue } from './track.js';
import { parseUa, sourceOf } from './ua.js';

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const DAY = 864e5;

export class TrackPageDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(10_000) seq: number;
  @IsString() @MaxLength(200) @Matches(/^\//) path: string;
  @IsString() @MaxLength(40) route: string;
  /** When the page was opened, by the browser's clock (corrected with `at` below). */
  @Type(() => Number) @IsNumber() at: number;
  /** Milliseconds the page was on screen so far. */
  @Type(() => Number) @IsInt() @Min(0) @Max(DAY) ms: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) scroll?: number;
}
export class TrackStartDto {
  @IsString() @MaxLength(200) @Matches(/^\//) landing: string;
  @IsOptional() @IsString() @MaxLength(500) referrer?: string;
  @IsOptional() @IsString() @MaxLength(100) utmSource?: string;
  @IsOptional() @IsString() @MaxLength(100) utmMedium?: string;
  @IsOptional() @IsString() @MaxLength(100) utmCampaign?: string;
  @IsOptional() @IsString() @MaxLength(60) timeZone?: string;
  @IsOptional() @IsString() @MaxLength(35) locale?: string;
}
export class TrackDto {
  @Matches(ID) visitorId: string;
  @Matches(ID) visitId: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => TrackStartDto)
  start?: TrackStartDto;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TrackPageDto)
  pages: TrackPageDto[];
  /** The browser's clock when it sent this, to correct a device clock that's off. */
  @Type(() => Number) @IsNumber() at: number;
}
export class PersonaliseDto {
  @IsBoolean() personalise: boolean;
}
export class RecoQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RECO_LIMIT)
  limit?: number;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const OWN_HOSTS = [
  ...new Set(
    [env.storefrontUrl, ...env.corsOrigins].map(hostOf).filter(Boolean),
  ),
];
const clean = (path: string) => path.split(/[?#]/)[0].slice(0, 200) || '/';

/** Where visitors go: the storefront sends page changes here, signed in or not. */
@ApiTags('events')
@Controller('track')
export class TrackController {
  constructor(private readonly queue: TrackQueue) {}

  @Post()
  @HttpCode(202)
  @UseGuards(OptionalAuthGuard)
  // A browser sends a batch every few page changes; this leaves lots of room for fast clickers.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async track(
    @Req() req: Request,
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: TrackDto,
  ) {
    const now = Date.now();
    const skew = now - dto.at;
    const fix = (at: number) => Math.min(now, Math.max(now - DAY, at + skew));
    let start = null;
    if (dto.start) {
      const { host, source } = sourceOf(
        dto.start.referrer ?? null,
        OWN_HOSTS,
        dto.start.utmSource,
      );
      start = {
        landing: clean(dto.start.landing),
        referrer: host,
        source,
        medium: dto.start.utmMedium?.slice(0, 60) ?? null,
        campaign: dto.start.utmCampaign?.slice(0, 100) ?? null,
        ...parseUa(req.headers['user-agent']),
        geo: geoOf(req, dto.start),
        timeZone: dto.start.timeZone ?? null,
        locale: dto.start.locale ?? null,
      };
    }
    await this.queue.push({
      visitId: dto.visitId,
      visitorId: dto.visitorId,
      userId: user?.id ?? null,
      start,
      pages: dto.pages.map((p) => ({
        seq: p.seq,
        path: clean(p.path),
        route: p.route.slice(0, 40),
        at: fix(p.at),
        ms: p.ms,
        scroll: p.scroll,
      })),
      at: fix(dto.at),
    });
  }
}

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class PersonalisationController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** "Picked for you": product ids ranked for this shopper, with a reason line to show above them. */
  @Get('recommendations')
  recommendations(@CurrentUser() u: AuthUser, @Query() q: RecoQuery) {
    return this.profiles.recommendations(u.id, q.limit ?? RECO_LIMIT);
  }

  @Get('personalisation')
  async get(@CurrentUser() u: AuthUser) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { personalise: true },
    });
    return { personalise: user.personalise };
  }

  /** Off: the store stops learning the shopper's taste and forgets what it had learned. */
  @Put('personalisation')
  async set(@CurrentUser() u: AuthUser, @Body() dto: PersonaliseDto) {
    await this.db.user.update({
      where: { id: u.id },
      data: { personalise: dto.personalise },
    });
    if (dto.personalise) await this.redis.sadd(DIRTY, u.id);
    else await this.profiles.forget(u.id);
    return { personalise: dto.personalise };
  }
}

@ApiTags('admin · analytics')
@Staff('analytics')
@Controller('admin/analytics')
export class AdminJourneysController {
  constructor(private readonly journeys: JourneyAnalytics) {}

  /** Visits, sources, landing and exit pages, time on page, paths through the store, devices, locations, personalities, age groups. */
  @Get('visitors')
  visitors(@Query() q: RangeQuery, @CurrentUser() me: AuthUser) {
    return this.journeys.visitors(q.days ?? 30, can(me.role, 'customers.read'));
  }

  /** One visit step by step: pages and time on each, what was done there, where they left. */
  @Get('visits/:id')
  visit(@Param('id') id: string) {
    return this.journeys.visit(id);
  }

  /** The assumed profile (personality, price band, age group) and recent visits of one customer. */
  @Needs('customers')
  @Get('shoppers/:userId')
  shopper(@Param('userId') userId: string) {
    return this.journeys.shopper(userId);
  }
}

@Module({
  controllers: [
    TrackController,
    PersonalisationController,
    AdminJourneysController,
  ],
  providers: [TrackQueue, JourneyWorker, ProfileService, JourneyAnalytics],
  exports: [ProfileService, JourneyWorker],
})
export class JourneysModule implements OnModuleInit {
  async onModuleInit() {
    await openGeoIp();
  }
}
