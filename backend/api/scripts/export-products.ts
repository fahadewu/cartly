// Every product as a CSV in Cartly's columns, on stdout: edit it in a spreadsheet and import it back.
//   npm run -s catalog:export > products.csv
//   npm run -s catalog:export -- --template > template.csv     the columns and one example row
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../src/config.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { COLUMNS, EXAMPLE, productRow, toCsv } from '../src/admin/import-csv.js';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });
try {
  const products = process.argv.includes('--template') ? [EXAMPLE] : await db.product.findMany({ orderBy: { id: 'asc' } });
  process.stdout.write(toCsv([[...COLUMNS], ...products.map((p) => productRow(p as unknown as Record<string, unknown>))]));
} finally {
  await db.$disconnect();
}
