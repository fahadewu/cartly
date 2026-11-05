// Runs before every e2e file: clears the rate-limit counters left in the shared Redis by the previous
// file (or the previous run). The sign-in limit is 10 a minute per IP, and every suite signs in from
// 127.0.0.1, so without this a second run inside a minute fails with 429s.
import { Redis } from 'ioredis';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379/0', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'throttle:*', 'COUNT', 500);
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  } catch {
    // No Redis: the suites fail on their own with a clearer message.
  } finally {
    redis.disconnect();
  }
});
