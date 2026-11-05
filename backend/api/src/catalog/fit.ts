/*
 * How a product really fits, from what shoppers said and did: fit reviews ("runs small / true to size /
 * runs large") and returns sent back as too small or too large. Size returns in fashion come mostly from
 * fit uncertainty, and a per-product "runs small" flag is one of the few fixes shown to cut them in large
 * A/B tests (Zalando SizeFlags, KDD 2021), so the storefront and Pip both use it.
 *
 * The verdict is deliberately conservative: it needs MIN_SIGNALS signals and a clear majority, otherwise it
 * stays null and the page only reports the raw counts. Never guess a fit the shoppers didn't report.
 */
import type { PrismaClient } from '../generated/prisma/client.js';

export const FITS = ['small', 'true', 'large'] as const;
export type Fit = (typeof FITS)[number];

export interface FitVotes {
  /** Fit reviews. */
  small: number;
  true: number;
  large: number;
  /** Returns sent back as too small / too large (not cancelled or rejected). */
  returnsSmall: number;
  returnsLarge: number;
}

export const MIN_SIGNALS = 3;
const emptyVotes = (): FitVotes => ({ small: 0, true: 0, large: 0, returnsSmall: 0, returnsLarge: 0 });

/** "small" | "true" | "large" once enough shoppers agree, otherwise null. Pure. */
export function fitVerdict(v: Partial<FitVotes> | null | undefined): Fit | null {
  const n = { ...emptyVotes(), ...v };
  const small = n.small + n.returnsSmall;
  const large = n.large + n.returnsLarge;
  const total = small + large + n.true;
  if (total < MIN_SIGNALS) return null;
  if (small >= 2 && small > large && small / total >= 0.5) return 'small';
  if (large >= 2 && large > small && large / total >= 0.5) return 'large';
  if (n.true / total >= 0.6) return 'true';
  return null;
}

/** The fit counts for the storefront: how many said each, and the verdict (null while mixed or too few). */
export function fitSummary(votes: unknown, verdict: string | null) {
  const v = { ...emptyVotes(), ...((votes ?? {}) as Partial<FitVotes>) };
  const small = v.small + v.returnsSmall;
  const large = v.large + v.returnsLarge;
  const total = small + large + v.true;
  return total ? { verdict: (verdict as Fit | null) ?? null, small, true: v.true, large, total, returns: v.returnsSmall + v.returnsLarge } : null;
}

/**
 * Recounts fit votes for these products and stores the result on each product. Resolves to the ids whose
 * counts changed (the catalog cache needs a bump) and those whose verdict changed (Pip's catalog shows the
 * verdict, so those need a reindex too).
 */
export async function refreshFit(db: PrismaClient, productIds: number[]): Promise<{ changed: number[]; verdictChanged: number[] }> {
  const ids = [...new Set(productIds)].filter((id) => Number.isInteger(id));
  if (!ids.length) return { changed: [], verdictChanged: [] };
  const [reviews, returns, products] = await Promise.all([
    // One vote per reviewer per product (their latest), so posting twice doesn't count twice.
    db.$queryRaw<{ productId: number; fit: Fit; n: bigint }[]>`
      SELECT "productId", fit, COUNT(*) AS n FROM (
        SELECT DISTINCT ON ("productId", COALESCE("userId", "id")) "productId", "fit"
        FROM "Review"
        WHERE "productId" = ANY(${ids}) AND "fit" IN ('small', 'true', 'large')
        ORDER BY "productId", COALESCE("userId", "id"), "createdAt" DESC
      ) latest
      GROUP BY "productId", fit`,
    db.$queryRaw<{ productId: number; reason: string; n: bigint }[]>`
      SELECT oi."productId" AS "productId", r."reason"::text AS reason, COUNT(DISTINCT r."id") AS n
      FROM "ReturnRequest" r
      JOIN "ReturnItem" ri ON ri."returnId" = r."id"
      JOIN "OrderItem" oi ON oi."id" = ri."orderItemId"
      WHERE oi."productId" = ANY(${ids}) AND r."reason"::text IN ('TOO_SMALL', 'TOO_LARGE') AND r."status"::text NOT IN ('CANCELLED', 'REJECTED')
      GROUP BY oi."productId", r."reason"`,
    db.product.findMany({ where: { id: { in: ids } }, select: { id: true, fitVerdict: true, fitVotes: true } }),
  ]);
  const votes = new Map(ids.map((id) => [id, emptyVotes()]));
  for (const r of reviews) votes.get(r.productId)![r.fit] += Number(r.n);
  for (const r of returns) votes.get(r.productId)![r.reason === 'TOO_SMALL' ? 'returnsSmall' : 'returnsLarge'] += Number(r.n);

  const changed: number[] = [];
  const verdictChanged: number[] = [];
  for (const p of products) {
    const v = votes.get(p.id)!;
    const verdict = fitVerdict(v);
    if (JSON.stringify(v) === JSON.stringify({ ...emptyVotes(), ...(p.fitVotes as object) }) && verdict === p.fitVerdict) continue;
    // A plain update would also bump updatedAt, which is fine: the catalog did change.
    await db.product.update({ where: { id: p.id }, data: { fitVotes: { ...v }, fitVerdict: verdict } });
    changed.push(p.id);
    if (verdict !== p.fitVerdict) verdictChanged.push(p.id);
  }
  return { changed, verdictChanged };
}

