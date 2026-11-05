import { Body, Controller, Get, Headers, HttpCode, Logger, Module, NotFoundException, Param, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { type AuthUser, CurrentUser, RiderOnly } from '../common/auth.js';
import type { ShipmentStatus } from '../generated/prisma/client.js';
import { AdminDeliveryController, RidersService } from './admin.controller.js';
import { DeliveryService } from './delivery.service.js';
import { CourierSettings } from './settings.js';

export class RiderUpdateDto {
  @IsIn(['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT', 'RETURNING', 'RETURNED']) status: ShipmentStatus;
  /** Why a delivery failed, or anything worth knowing. */
  @IsOptional() @IsString() @MaxLength(200) note?: string;
  /** The 4-digit code the customer reads out from their order page. */
  @IsOptional() @Matches(/^\d{4}$/, { message: 'The delivery code is 4 digits.' }) code?: string;
  /** Cash taken on delivery, in taka. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) collected?: number;
}

/** The rider app: a rider's parcels, and moving each one on. */
@ApiTags('rider')
@RiderOnly()
@Controller('rider')
export class RiderController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get()
  home(@CurrentUser() u: AuthUser) {
    return this.delivery.riderHome(u.id);
  }

  @Post('shipments/:id/status')
  @HttpCode(200)
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RiderUpdateDto) {
    return this.delivery.riderUpdate(u.id, id, dto);
  }
}

/** Couriers tell us about their parcels here; each courier's own authentication is checked. */
@ApiTags('delivery')
@Controller('delivery/webhooks')
export class CourierWebhookController {
  private readonly log = new Logger('Delivery');

  constructor(private readonly delivery: DeliveryService) {}

  @Post(':courier')
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async hook(
    @Param('courier') courier: string,
    @Headers() headers: Record<string, string>,
    @Query() query: Record<string, string>,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    let reply;
    try {
      reply = await this.delivery.webhook(courier, { headers, query, body: body ?? {} });
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      // Answer anyway so the courier doesn't keep retrying something we can't use; it's logged.
      this.log.warn(`${courier} webhook failed: ${(e as Error).message}`);
      return res.status(202).json({ ok: false });
    }
    if (!reply) throw new UnauthorizedException();
    for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
    return res.status(reply.status ?? 202).json({ ok: true });
  }
}

/** Getting orders to customers: the store's riders, and Pathao, Steadfast and RedX. */
@Module({
  controllers: [AdminDeliveryController, RiderController, CourierWebhookController],
  providers: [DeliveryService, CourierSettings, RidersService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
