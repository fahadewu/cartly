import { Body, Controller, Get, HttpCode, Module, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { Staff, type AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth.js';
import { can } from '../common/permissions.js';
import { DemandService } from '../common/demand.js';
import { AnalyticsService } from './analytics.service.js';

export class RangeQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([7, 30, 90, 365])
  days?: number;
}
export class RegionQuery extends RangeQuery {
  /** region: countries, and Bangladesh by division. place: cities and districts. */
  @IsOptional() @IsIn(['region', 'place']) level?: 'region' | 'place';
}
export class EventDto {
  @IsIn(['view', 'search']) type: 'view' | 'search';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) productId?: number;
  @IsOptional() @IsString() @MaxLength(120) query?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) results?: number;
}
export class EventsDto {
  @IsArray()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => EventDto)
  events: EventDto[];
}

/** The storefront reports what shoppers view and search for (everything else is recorded where it happens). */
@ApiTags('events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly demand: DemandService) {}

  @Post()
  @HttpCode(202)
  async record(@CurrentUser() u: AuthUser, @Body() dto: EventsDto) {
    const events = dto.events.filter((e) => (e.type === 'view' ? e.productId : e.query?.trim()));
    return {
      recorded: await this.demand.record(events.map((e) => ({ ...e, userId: u.id }))),
    };
  }
}

@ApiTags('admin · analytics')
@Staff('analytics')
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Gross and net sales, orders, AOV, buyers, conversion, payment mix, promos, daily series and when people buy. */
  @Get('sales')
  sales(@Query() q: RangeQuery) {
    return this.analytics.sales(q.days ?? 30);
  }
  /** Best sellers, most wanted, viewed-not-bought, lost demand, running out, searches, requests, attributes. */
  @Get('demand')
  demand(@Query() q: RangeQuery) {
    return this.analytics.demand(q.days ?? 30);
  }
  /** Segments (RFM), monthly cohorts, lifetime value, top customers. */
  @Get('customers')
  customers(@Query() q: RangeQuery, @CurrentUser() me: AuthUser) {
    return this.analytics.customers(q.days ?? 30, can(me.role, 'customers.read'));
  }
  /** Sales and fashion tastes by region, rising trends, searches by region, seasonality. */
  @Get('regions')
  regions(@Query() q: RegionQuery) {
    return this.analytics.regions(q.days ?? 30, q.level ?? 'region');
  }
  @Get('returns')
  returns(@Query() q: RangeQuery) {
    return this.analytics.returns(q.days ?? 30);
  }
  @Get('delivery')
  delivery(@Query() q: RangeQuery) {
    return this.analytics.delivery(q.days ?? 30);
  }
  /** Estimated spend on Claude, FASHN and ElevenLabs, per day and feature, against sales. */
  @Get('ai-costs')
  aiCosts(@Query() q: RangeQuery) {
    return this.analytics.aiCosts(q.days ?? 30);
  }
}

@Module({
  controllers: [EventsController, AdminAnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
