import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { env } from '../config.js';

/**
 * Keeps the AI service in step with catalog edits: a rebuild re-reads products
 * from Postgres into Pip's in-memory catalog and re-embeds them for search.
 */
@Injectable()
export class AiIndexService implements OnModuleDestroy {
  private readonly log = new Logger('AiIndex');
  private timer?: NodeJS.Timeout;

  /** Rebuilds shortly after the last change, so a burst of edits costs one rebuild. */
  reindexSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.rebuild().catch((e: Error) => this.log.warn(`Search index not refreshed: ${e.message}`));
    }, 1500);
    this.timer.unref();
  }

  /** Rebuilds now (a pending `reindexSoon` is dropped): after a bulk change such as a product import. */
  async rebuildNow() {
    clearTimeout(this.timer);
    return this.rebuild();
  }

  async rebuild(): Promise<{ indexed: number; embedder: string }> {
    const res = await fetch(`${env.aiServiceUrl}/index/rebuild`, {
      method: 'POST',
      headers: { 'x-internal-key': env.internalApiKey },
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (!res?.ok) throw new ServiceUnavailableException('The AI service isn’t reachable, so the search index wasn’t rebuilt.');
    return (await res.json()) as { indexed: number; embedder: string };
  }

  async health(): Promise<Record<string, unknown>> {
    const t = Date.now();
    try {
      const res = await fetch(`${env.aiServiceUrl}/health`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, ms: Date.now() - t, ...body };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }
}
