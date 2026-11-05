import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config.js';
import { AiIndexService } from './ai-index.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: env.databaseUrl, max: env.dbPoolMax }) });
  }
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor() {
    super(env.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  }
  async onModuleDestroy() {
    await this.quit();
  }
}

@Global()
@Module({
  providers: [PrismaService, RedisService, AiIndexService],
  exports: [PrismaService, RedisService, AiIndexService],
})
export class InfraModule {}
