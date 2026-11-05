import { Module } from '@nestjs/common';
import { AdminPaymentsController } from './admin.controller.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PaymentSettings } from './settings.js';

/** bKash, Nagad, Rocket and cards (SSLCommerz), cash on delivery and the dev-only demo card. */
@Module({
  controllers: [PaymentsController, AdminPaymentsController],
  providers: [PaymentsService, PaymentSettings],
  exports: [PaymentsService, PaymentSettings],
})
export class PaymentsModule {}
