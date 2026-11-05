import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { RedisService } from './infra.module.js';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/**
 * Runs `fn` while holding a short Redis lock on `key`, so two API instances (or two clicks) can't run
 * the same multi-step action on one record at once. The second caller gets a 409 with `busy` straight
 * away instead of waiting. The lock expires on its own after `ttlSeconds`, in case the process dies.
 */
export async function withLock<T>(redis: RedisService, key: string, ttlSeconds: number, busy: string, fn: () => Promise<T>): Promise<T> {
  const name = `lock:${key}`;
  const token = randomUUID();
  if (!(await redis.set(name, token, 'EX', ttlSeconds, 'NX'))) throw new ConflictException(busy);
  try {
    return await fn();
  } finally {
    // Release only our own lock: the TTL may have handed it to someone else meanwhile.
    await redis.eval(RELEASE, 1, name, token).catch(() => undefined);
  }
}
