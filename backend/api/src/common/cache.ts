import { CallHandler, ExecutionContext, Global, Injectable, Module, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs';
import { RedisService } from './infra.module.js';

const VERSION_KEY = 'catalog:version';
const MAX_ENTRIES = 500;

/**
 * Short-lived, in-process copies of public catalog reads (the storefront bootstrap, product pages,
 * listings), so a traffic spike reads Postgres once per entry per instance instead of once per visitor.
 *
 * Every API instance compares a shared version in Redis on each read; `bump()` after a catalog change
 * makes all of them reload at once. The TTL only bounds what changes without a bump (stock after orders).
 */
@Injectable()
export class CatalogCache {
  private version = '0';
  private readonly entries = new Map<string, { version: string; expires: number; value: Promise<unknown> }>();

  constructor(private readonly redis: RedisService) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    // If Redis is unreachable, keep serving by the last version seen (the TTL still applies).
    this.version = (await this.redis.get(VERSION_KEY).catch(() => this.version)) ?? '0';
    const hit = this.entries.get(key);
    if (hit && hit.version === this.version && hit.expires > Date.now()) return hit.value as Promise<T>;

    // The promise is cached, so concurrent misses share one load.
    const value = load();
    const entry = { version: this.version, expires: Date.now() + ttlMs, value };
    this.entries.delete(key);
    this.entries.set(key, entry);
    value.catch(() => this.entries.get(key) === entry && this.entries.delete(key));
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  /** After a catalog change: every instance drops its copies on its next read. */
  async bump() {
    this.entries.clear();
    this.version = String(await this.redis.incr(VERSION_KEY));
  }
}

/** Bumps the catalog cache after every successful write through the decorated controller. */
@Injectable()
export class BumpCatalogCache implements NestInterceptor {
  constructor(private readonly cache: CatalogCache) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.switchToHttp().getRequest<{ method: string }>().method === 'GET') return next.handle();
    return next.handle().pipe(tap({ next: () => void this.cache.bump().catch(() => undefined) }));
  }
}

@Global()
@Module({ providers: [CatalogCache, BumpCatalogCache], exports: [CatalogCache, BumpCatalogCache] })
export class CacheModule {}
