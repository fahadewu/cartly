// DEVELOPMENT / STAGING ONLY: fills the store with everything needed to try it end to end.
//   npm run test-kit          (in backend/api; run it again any time, it's idempotent)
// - Test accounts: a shopper, an admin and a delivery rider (passwords reset to the ones below).
// - A taka rate, if none is set yet.
// - Every payment gateway in SANDBOX mode with its PUBLIC test credentials (bKash's demo merchant, Nagad's
//   sample merchant from its integration kit, SSLCommerz's documented "testbox" store), and every payment
//   method switched on. No real money can move with these.
// - Pathao in SANDBOX mode with the public test account from its developer docs (bookings are test parcels
//   nobody picks up). Steadfast has no sandbox and RedX has no public test token, so they're left alone.
// Refuses to run with NODE_ENV=production or while any gateway or courier is live. Before going live, follow the
// removal checklist in TESTING.md (workspace root).
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../src/config.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seal, secretsKeySet } from '../src/payments/secrets.js';

export const TEST_ACCOUNTS = {
  shopper: { email: 'demo@cartly.dev', password: 'Demo1234!', name: 'Maya Chen' },
  admin: { email: 'admin@cartly.dev', password: 'Admin1234!', name: 'Riley Admin' },
  rider: { email: 'rider@cartly.dev', password: 'Rider1234!', name: 'Karim Mia' },
};
const RIDER = { phone: '01811000000', zone: 'Dhanmondi, Mohammadpur', vehicle: 'bike' };
// From Pathao's developer docs (merchant.pathao.com/courier/developer-api): its public sandbox merchant.
const PATHAO_SANDBOX = { clientId: '7N1aMJQbWm', clientSecret: 'wRcaibZkUdSNz2EI9ZyuXLlNrnAv0TdPUPXMnD39', username: 'test@pathao.com', password: 'lovePathao' };

const SANDBOX = {
  bkash: { username: '01770618567', password: 'D7DaC<*E*eG', appKey: '0vWQuCRGiUX7EPVjQDr0EUAYtc', appSecret: 'jcUNPBgbcqEDedNKdvE4G1cAK7D3hCjmJccNPZZBq96QIxxwAMEx' },
  nagad: {
    merchantId: '683002007104225',
    merchantNumber: '01711428036',
    merchantPrivateKey: 'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCJakyLqojWTDAVUdNJLvuXhROV+LXymqnukBrmiWwTYnJYm9r5cKHj1hYQRhU5eiy6NmFVJqJtwpxyyDSCWSoSmIQMoO2KjYyB5cDajRF45v1GmSeyiIn0hl55qM8ohJGjXQVPfXiqEB5c5REJ8Toy83gzGE3ApmLipoegnwMkewsTNDbe5xZdxN1qfKiRiCL720FtQfIwPDp9ZqbG2OQbdyZUB8I08irKJ0x/psM4SjXasglHBK5G1DX7BmwcB/PRbC0cHYy3pXDmLI8pZl1NehLzbav0Y4fP4MdnpQnfzZJdpaGVE0oI15lq+KZ0tbllNcS+/4MSwW+afvOw9bazAgMBAAECggEAIkenUsw3GKam9BqWh9I1p0Xmbeo+kYftznqai1pK4McVWW9//+wOJsU4edTR5KXK1KVOQKzDpnf/CU9SchYGPd9YScI3n/HR1HHZW2wHqM6O7na0hYA0UhDXLqhjDWuM3WEOOxdE67/bozbtujo4V4+PM8fjVaTsVDhQ60vfv9CnJJ7dLnhqcoovidOwZTHwG+pQtAwbX0ICgKSrc0elv8ZtfwlEvgIrtSiLAO1/CAf+uReUXyBCZhS4Xl7LroKZGiZ80/JE5mc67V/yImVKHBe0aZwgDHgtHh63/50/cAyuUfKyreAH0VLEwy54UCGramPQqYlIReMEbi6U4GC5AQKBgQDfDnHCH1rBvBWfkxPivl/yNKmENBkVikGWBwHNA3wVQ+xZ1Oqmjw3zuHY0xOH0GtK8l3Jy5dRL4DYlwB1qgd/Cxh0mmOv7/C3SviRk7W6FKqdpJLyaE/bqI9AmRCZBpX2PMje6Mm8QHp6+1QpPnN/SenOvoQg/WWYM1DNXUJsfMwKBgQCdtddE7A5IBvgZX2o9vTLZY/3KVuHgJm9dQNbfvtXw+IQfwssPqjrvoU6hPBWHbCZl6FCl2tRh/QfYR/N7H2PvRFfbbeWHw9+xwFP1pdgMug4cTAt4rkRJRLjEnZCNvSMVHrri+fAgpv296nOhwmY/qw5Smi9rMkRY6BoNCiEKgQKBgAaRnFQFLF0MNu7OHAXPaW/ukRdtmVeDDM9oQWtSMPNHXsx+crKY/+YvhnujWKwhphcbtqkfj5L0dWPDNpqOXJKV1wHt+vUexhKwus2mGF0flnKIPG2lLN5UU6rs0tuYDgyLhAyds5ub6zzfdUBG9Gh0ZrfDXETRUyoJjcGChC71AoGAfmSciL0SWQFU1qjUcXRvCzCK1h25WrYS7E6pppm/xia1ZOrtaLmKEEBbzvZjXqv7PhLoh3OQYJO0NM69QMCQi9JfAxnZKWx+m2tDHozyUIjQBDehve8UBRBRcCnDDwU015lQN9YNb23Fz+3VDB/LaF1D1kmBlUys3//r2OV0Q4ECgYBnpo6ZFmrHvV9IMIGjP7XIlVa1uiMCt41FVyINB9SJnamGGauW/pyENvEVh+ueuthSg37e/l0Xu0nm/XGqyKCqkAfBbL2Uj/j5FyDFrpF27PkANDo99CdqL5A4NQzZ69QRlCQ4wnNCq6GsYy2WEJyU2D+K8EBSQcwLsrI7QL7fvQ==',
    nagadPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjBH1pFNSSRKPuMcNxmU5jZ1x8K9LPFM4XSu11m7uCfLUSE4SEjL30w3ockFvwAcuJffCUwtSpbjr34cSTD7EFG1Jqk9Gg0fQCKvPaU54jjMJoP2toR9fGmQV7y9fz31UVxSk97AqWZZLJBT2lmv76AgpVV0k0xtb/0VIv8pd/j6TIz9SFfsTQOugHkhyRzzhvZisiKzOAAWNX8RMpG+iqQi4p9W9VrmmiCfFDmLFnMrwhncnMsvlXB8QSJCq2irrx3HG0SJJCbS5+atz+E1iqO8QaPJ05snxv82Mf4NlZ4gZK0Pq/VvJ20lSkR+0nk+s/v3BgIyle78wjZP1vWLU4wIDAQAB',
  },
  sslcommerz: { storeId: 'testbox', storePassword: 'qwerty' },
};

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });
try {
  if (env.production) throw new Error('Not in production: the test kit is for development and staging only.');
  if (await db.paymentGateway.count({ where: { live: true } })) throw new Error('A gateway is in live mode. Switch it back to sandbox in the admin panel first.');
  if (await db.courier.count({ where: { live: true } })) throw new Error('A courier is in live mode. Switch it back to sandbox in the admin panel first.');
  if (!secretsKeySet()) throw new Error('Set PAYMENT_SECRETS_KEY in backend/.env first (any long random string).');

  const ROLES = { shopper: 'CUSTOMER', admin: 'ADMIN', rider: 'RIDER' } as const;
  for (const [role, a] of Object.entries(TEST_ACCOUNTS)) {
    const data = { name: a.name, passwordHash: await bcrypt.hash(a.password, 10), role: ROLES[role as keyof typeof ROLES] };
    const user = await db.user.upsert({ where: { email: a.email }, create: { email: a.email, ...data }, update: data });
    if (role === 'rider') await db.rider.upsert({ where: { userId: user.id }, create: { userId: user.id, ...RIDER }, update: { ...RIDER, active: true } });
  }
  await db.courier.upsert({
    where: { id: 'pathao' },
    create: { id: 'pathao', live: false, enabled: true, secrets: seal(PATHAO_SANDBOX) },
    update: { live: false, enabled: true, secrets: seal(PATHAO_SANDBOX) },
  });
  if (!(await db.storeSetting.findUnique({ where: { key: 'usdToBdt' } }))) await db.storeSetting.create({ data: { key: 'usdToBdt', value: 122 } });
  for (const [id, creds] of Object.entries(SANDBOX)) {
    await db.paymentGateway.upsert({ where: { id }, create: { id, live: false, secrets: seal(creds) }, update: { live: false, secrets: seal(creds) } });
  }
  // Nagad stays off: its public sample merchant is refused by the current sandbox ("Failed to verify
  // signature"). Enter the sandbox keys from your own Nagad onboarding, then switch it on in the admin panel.
  const methods = ['bkash', 'nagad', 'rocket', 'card', 'cod', 'demo'];
  for (const [position, id] of methods.entries()) {
    const enabled = id !== 'nagad';
    await db.paymentMethod.upsert({ where: { id }, create: { id, enabled, position }, update: { enabled, position } });
  }
  const rate = await db.storeSetting.findUnique({ where: { key: 'usdToBdt' } });
  console.log(`Test kit ready (sandbox only). Taka rate: ${rate?.value} per dollar.`);
  console.log(`  Storefront: ${TEST_ACCOUNTS.shopper.email} / ${TEST_ACCOUNTS.shopper.password}`);
  console.log(`  Admin panel: ${TEST_ACCOUNTS.admin.email} / ${TEST_ACCOUNTS.admin.password}`);
  console.log(`  Rider app (admin panel URL /rider): ${TEST_ACCOUNTS.rider.email} / ${TEST_ACCOUNTS.rider.password}`);
  console.log('  Pathao: sandbox, with its public test merchant.');
  console.log('  Payment test wallets and cards: see TESTING.md (checkout also shows them while a gateway is in sandbox).');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
