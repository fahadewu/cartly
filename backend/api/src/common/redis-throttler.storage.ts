import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard, type ThrottlerStorage } from '@nestjs/throttler';
import { env } from '../config.js';
import { RedisService } from './infra.module.js';

// One atomic round trip per request: is the caller blocked, else count the hit (starting the window
// on the first one) and block once over the limit. Returns [hits, ms left in the window, ms blocked].
const HIT = `
local blocked = redis.call('PTTL', KEYS[2])
if blocked > 0 then return {-1, blocked, blocked} end
local hits = redis.call('INCR', KEYS[1])
local left = redis.call('PTTL', KEYS[1])
if left < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  left = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, left, tonumber(ARGV[3])}
end
return {hits, left, 0}`;

type WithHit = RedisService & { throttleHit(hits: string, block: string, ttl: number, limit: number, blockMs: number): Promise<[number, number, number]> };

// Rate-limit counters in Redis, so limits hold across multiple API instances.
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: WithHit;

  constructor(redis: RedisService) {
    redis.defineCommand('throttleHit', { numberOfKeys: 2, lua: HIT });
    this.redis = redis as WithHit;
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const hitsKey = `throttle:${throttlerName}:${key}`;
    const [hits, left, blockedMs] = await this.redis.throttleHit(hitsKey, `${hitsKey}:blocked`, ttl, limit, blockDuration || ttl);
    const seconds = (ms: number) => Math.ceil(ms / 1000);
    if (blockedMs > 0) {
      return { totalHits: hits < 0 ? limit + 1 : hits, timeToExpire: seconds(left), isBlocked: true, timeToBlockExpire: seconds(blockedMs) };
    }
    return { totalHits: hits, timeToExpire: seconds(left), isBlocked: false, timeToBlockExpire: 0 };
  }
}

const jwt = new JwtService({ secret: env.jwtSecret });

/**
 * Rate limits per signed-in shopper (by account), else per IP. Mobile carriers often put many
 * shoppers behind one shared IP, so per-IP limits alone would throttle strangers together.
 */
@Injectable()
export class ShopperThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const [scheme, token] = String(req.headers?.authorization ?? '').split(' ');
    if (scheme === 'Bearer' && token) {
      const sub = await jwt
        .verifyAsync<{ sub?: string }>(token)
        .then((p) => p.sub)
        .catch(() => undefined);
      if (sub) return `u:${sub}`;
    }
    return `ip:${req.ip}`;
  }
}
