import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { env } from './config.js';
import { InfraModule, RedisService } from './common/infra.module.js';
import { CacheModule } from './common/cache.js';
import { DemandModule } from './common/demand.js';
import { RedisThrottlerStorage, ShopperThrottlerGuard } from './common/redis-throttler.storage.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CommerceModule } from './cart/commerce.module.js';
import { AccountModule } from './account/account.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
import { AdminModule } from './admin/admin.module.js';
import { TryOnModule } from './tryon/tryon.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';
import { ReturnsModule } from './returns/returns.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { JourneysModule } from './journeys/journeys.module.js';
import { OutreachModule } from './outreach/outreach.module.js';
import { LooksModule } from './looks/looks.module.js';
import { FestivalsModule } from './festivals/festivals.module.js';
import { SupportModule } from './support/support.module.js';
import { LoyaltyModule } from './loyalty/loyalty.module.js';

@Module({
  imports: [
    InfraModule,
    CacheModule,
    DemandModule,
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: env.throttleLimit }],
        errorMessage: 'That’s a lot of requests. Please wait a minute and try again.',
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    AuthModule,
    CatalogModule,
    CommerceModule,
    AccountModule,
    AssistantModule,
    TryOnModule,
    DeliveryModule,
    ReturnsModule,
    AnalyticsModule,
    JourneysModule,
    OutreachModule,
    LooksModule,
    FestivalsModule,
    SupportModule,
    LoyaltyModule,
    AdminModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ShopperThrottlerGuard }],
})
export class AppModule {}
