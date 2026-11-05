// What feeds the outreach worker (outreach.service.ts), as two Redis lists so the requests that notice them
// stay fast:
//   wants:inbox        something a shopper looked for and didn't get: a search with no results (DemandService),
//                      a sold-out product they viewed or favourited (DemandService), a product request
//                      (AccountService), a Pip chat where nothing fitted (the AI service, backend/ai/app/agent.py)
//   outreach:changes   catalogue changes that might answer them: new or re-listed products, restocks, price drops
//                      (AdminCatalogService, so product imports count too)
import type { RedisService } from '../common/infra.module.js';

export const WANTS_INBOX = 'wants:inbox';
export const CHANGES = 'outreach:changes';
const MAX_QUEUE = 50_000;

export type WantSource = 'search' | 'chat' | 'soldout' | 'request';
export interface WantNote {
  userId: string;
  source: WantSource;
  text: string;
  productId?: number | null;
  at?: number;
}
export type ChangeKind = 'new' | 'restock' | 'price_drop' | 'updated';
export interface CatalogChange {
  productId: number;
  kinds: ChangeKind[];
  /** The price before a drop. */
  was?: number;
  at?: number;
}

const push = (redis: RedisService, key: string, value: object) =>
  redis
    .multi()
    .rpush(key, JSON.stringify({ at: Date.now(), ...value }))
    .ltrim(key, -MAX_QUEUE, -1)
    .exec()
    .catch(() => null);

/** Never throws: noting a want must not break the search, view or chat that revealed it. */
export const noteWant = (redis: RedisService, w: WantNote) => (w.text.trim() ? push(redis, WANTS_INBOX, { ...w, text: w.text.trim().slice(0, 160) }) : null);
export const noteChange = (redis: RedisService, c: CatalogChange) => (c.kinds.length ? push(redis, CHANGES, c) : null);

/** Takes up to `n` items off the front of a list. */
export async function drain<T>(redis: RedisService, key: string, n = 500): Promise<T[]> {
  const raw = await redis.multi().lrange(key, 0, n - 1).ltrim(key, n, -1).exec();
  const items = (raw?.[0]?.[1] as string[] | undefined) ?? [];
  return items.flatMap((s) => {
    try {
      return [JSON.parse(s) as T];
    } catch {
      return [];
    }
  });
}
