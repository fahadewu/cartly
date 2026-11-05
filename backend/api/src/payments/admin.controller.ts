import { BadGatewayException, BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Needs, Staff } from '../common/auth.js';
import type { PaymentStatus } from '../generated/prisma/client.js';
import { GATEWAYS } from './gateways/index.js';
import { GatewayError, type GatewayId } from './gateways/types.js';
import { PaymentsService, toPayment } from './payments.service.js';
import { METHOD_IDS, PaymentSettings } from './settings.js';

const STATUSES = ['UNPAID', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'] as const;

export class MethodChangeDto {
  @IsIn(METHOD_IDS) id: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) position?: number;
}
export class PaymentSettingsDto {
  /** Taka per US dollar, used to work out what's charged. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(1)
  @Max(10_000)
  usdToBdt?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MethodChangeDto)
  methods?: MethodChangeDto[];
}
export class GatewayDto {
  /** true: real payments; false: the gateway's sandbox. */
  @IsOptional() @IsBoolean() live?: boolean;
  /** Only the values being changed; an empty string removes one. */
  @IsOptional() @IsObject() credentials?: Record<string, string>;
}
export class PaymentQuery {
  @IsOptional() @IsIn(STATUSES) status?: PaymentStatus;
  @IsOptional() @IsIn(METHOD_IDS) method?: string;
  /** Matches the invoice, transaction id or order id. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class RefundDto {
  /** In taka; the whole remaining amount when left out. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount?: number;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
  /** Already refunded in the gateway's own portal: just record it. */
  @IsOptional() @IsBoolean() manual?: boolean;
}

@ApiTags('admin · payments')
@Staff('payments')
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly settings: PaymentSettings,
  ) {}

  /** The taka rate, the checkout methods and every gateway (secret credentials only as set / not set). */
  @Needs('settings')
  @Get('settings')
  view() {
    return this.settings.adminView();
  }

  @Needs('settings')
  @Patch('settings')
  async update(@Body() dto: PaymentSettingsDto) {
    if (dto.usdToBdt !== undefined) await this.settings.setRate(dto.usdToBdt);
    if (dto.methods?.length) await this.settings.updateMethods(dto.methods);
    return this.settings.adminView();
  }

  @Needs('settings')
  @Put('gateways/:id')
  async saveGateway(@Param('id') id: string, @Body() dto: GatewayDto) {
    if (dto.credentials && Object.values(dto.credentials).some((v) => typeof v !== 'string' || v.length > 5000)) {
      throw new BadRequestException('Each credential must be text (up to 5,000 characters).');
    }
    await this.settings.saveGateway(id, dto);
    return this.settings.adminView();
  }

  /** Tries the saved credentials against the gateway (no money moves). */
  @Needs('settings')
  @Post('gateways/:id/test')
  @HttpCode(200)
  async test(@Param('id') id: string) {
    const g = GATEWAYS[id as GatewayId];
    if (!g) throw new NotFoundException('Unknown payment gateway.');
    const acct = await this.settings.account(g.id);
    if (!acct) throw new BadRequestException(`Fill in every ${g.name} credential first.`);
    try {
      return { ok: true, message: await g.test(acct), live: acct.live };
    } catch (e) {
      throw new BadGatewayException(e instanceof GatewayError ? e.message : `${g.name} didn’t respond: ${(e as Error).message}`);
    }
  }

  @Get()
  list(@Query() q: PaymentQuery) {
    return this.payments.list(q);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const p = await this.payments.payment(id);
    return { ...toPayment(p), log: p.log };
  }

  /** Asks the gateway where this payment stands, and updates the order if it's changed. */
  @Post(':id/check')
  @HttpCode(200)
  async check(@Param('id') id: string) {
    return toPayment(await this.payments.check(id));
  }

  @Needs('refunds.write')
  @Post(':id/refund')
  @HttpCode(200)
  async refund(@Param('id') id: string, @Body() dto: RefundDto) {
    return toPayment(await this.payments.refund(id, dto));
  }
}
