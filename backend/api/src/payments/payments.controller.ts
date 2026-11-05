import { All, Body, Controller, Get, HttpCode, Logger, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { GATEWAYS } from './gateways/index.js';
import type { GatewayId } from './gateways/types.js';
import { PaymentsService } from './payments.service.js';
import { PaymentSettings } from './settings.js';

/**
 * The storefront's payment options, and where the gateways send shoppers (and their notifications)
 * back to. Every return is confirmed with the gateway before the order changes.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly log = new Logger('Payments');

  constructor(
    private readonly payments: PaymentsService,
    private readonly settings: PaymentSettings,
  ) {}

  /** What a shopper can pay with right now, and taka per dollar for showing the amount charged. */
  @Get('methods')
  methods() {
    return this.settings.checkoutOptions();
  }

  /**
   * The shopper's browser, back from bKash or Nagad (GET with a query string) or SSLCommerz (a form POST).
   * Confirms the payment, then sends them to their order page.
   */
  @All([':gateway/callback', ':gateway/callback/:paymentId', ':gateway/return/:paymentId'])
  @ApiExcludeEndpoint()
  async back(
    @Param('gateway') gateway: string,
    @Param('paymentId') paymentId: string | undefined,
    @Query() query: Record<string, string>,
    @Body() body: Record<string, string> | undefined,
    @Res() res: Response,
  ) {
    const g = GATEWAYS[gateway as GatewayId];
    const params = { ...query, ...(body ?? {}) };
    const invoice = !paymentId && g?.invoiceOf?.(params);
    let payment = paymentId ? await this.payments.payment(paymentId) : invoice ? await this.payments.byInvoice(invoice) : null;
    if (!g || !payment || payment.gateway !== gateway) throw new NotFoundException('Payment not found.');
    try {
      const outcome = await g.confirm(await this.payments.accountFor(payment), payment, params);
      payment = await this.payments.settle(payment.id, outcome, 'shopper returned');
    } catch (e) {
      // Leave it pending: the sweeper asks the gateway again in a few minutes.
      this.log.warn(`${g.name} return for ${payment.invoice} not confirmed: ${(e as Error).message}`);
    }
    res.redirect(303, this.payments.returnUrl(payment));
  }

  /** SSLCommerz's instant payment notification (server to server). */
  @Post(':gateway/ipn')
  @HttpCode(200)
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async ipn(@Param('gateway') gateway: string, @Body() body: Record<string, string>) {
    const g = GATEWAYS[gateway as GatewayId];
    if (!g?.notify) throw new NotFoundException();
    const acct = await this.settings.account(g.id);
    const note = acct && (await g.notify(acct, body ?? {}));
    if (!note) return { ok: false };
    const payment = await this.payments.byInvoice(note.invoice);
    if (payment?.gateway === g.id) await this.payments.settle(payment.id, note.outcome, 'gateway notified');
    return { ok: true };
  }
}
