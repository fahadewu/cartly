import type { PrismaService } from '../common/infra.module.js';

export type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** Puts the items of a cancelled order back on the shelf. */
export async function restock(tx: Tx, items: { productId: number; qty: number }[]) {
  for (const i of items) await tx.product.update({ where: { id: i.productId }, data: { stock: { increment: i.qty } } });
}

/**
 * Takes the items off the shelf, or returns the name of the first one that's run out. All or nothing:
 * when one item is short, the ones already taken go back, so a caller that commits anyway (a payment
 * landing after the order was cancelled) can't leave stock missing.
 */
export async function reserve(tx: Tx, items: { productId: number; qty: number; name: string }[]): Promise<string | null> {
  const taken: typeof items = [];
  for (const i of items) {
    const { count } = await tx.product.updateMany({ where: { id: i.productId, stock: { gte: i.qty } }, data: { stock: { decrement: i.qty } } });
    if (!count) {
      await restock(tx, taken);
      return i.name;
    }
    taken.push(i);
  }
  return null;
}
