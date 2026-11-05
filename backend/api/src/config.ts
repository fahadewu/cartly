import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

// One .env for both services lives in backend/.
// quiet: dotenv would otherwise print to stdout, into piped output like `npm run -s catalog:export > file.csv`.
loadEnv({ path: path.resolve(process.cwd(), '../.env'), quiet: true });
loadEnv({ quiet: true });

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

/** Express's `trust proxy`: a hop count ("1"), true/false, or subnets ("loopback, 10.0.0.0/8"). */
const trustProxy = (v?: string) => (!v ? undefined : /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v);

export const env = {
  port: Number(process.env.API_PORT ?? 4100),
  databaseUrl: required('DATABASE_URL'),
  /** Postgres connections per API instance. Keep (instances × this) under the database's max_connections. */
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
  /**
   * Set behind a CDN or load balancer (e.g. TRUST_PROXY=1 per proxy hop) so rate limits count each
   * shopper's own IP instead of the proxy's. Leave unset when the API faces the internet directly,
   * or anyone could pick their IP with an X-Forwarded-For header.
   */
  trustProxy: trustProxy(process.env.TRUST_PROXY),
  /** Requests per minute per IP across the API (sign-in, AI and upload routes have their own, lower limits). */
  throttleLimit: Number(process.env.THROTTLE_LIMIT ?? 120),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  aiServiceUrl: process.env.AI_SERVICE_URL ?? 'http://127.0.0.1:8001',
  internalApiKey: process.env.INTERNAL_API_KEY ?? '',
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  catalogPath: process.env.CATALOG_PATH ?? path.resolve(process.cwd(), '../catalog/catalog.json'),
  /** Where uploaded product photos are kept, and the public base URL they're served from. */
  uploadDir: process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../uploads'),
  publicUrl: (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.API_PORT ?? 4100}`).replace(/\/$/, ''),

  /** Encrypts the payment gateway credentials saved in the admin panel: any long random string. */
  paymentSecretsKey: process.env.PAYMENT_SECRETS_KEY ?? '',
  /** The storefront's public URL: shoppers come back here after paying. */
  storefrontUrl: (process.env.STOREFRONT_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  /** Orders not paid online within this many minutes are cancelled and their stock released. */
  paymentTimeoutMinutes: Number(process.env.PAYMENT_TIMEOUT_MINUTES ?? 30),
  /** The store's time zone: analytics count days in it. */
  storeTimezone: process.env.STORE_TIMEZONE ?? 'Asia/Dhaka',
  /**
   * Optional MaxMind GeoLite2-City/GeoIP2-City .mmdb file for visitor locations when no CDN location
   * headers arrive (Cloudflare's CF-IPCountry/CF-IPCity, Vercel's X-Vercel-IP-*, CloudFront's).
   */
  geoipDb: process.env.GEOIP_DB ?? '',
  /** Outreach emails (Admin → Emails): smtp://user:pass@host:587 or smtps://… In Docker, the bundled Mailpit. */
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'Cartly <hello@cartly.dev>',
  /** Visits and page views older than this many days are deleted. */
  trackRetentionDays: Number(process.env.TRACK_RETENTION_DAYS ?? 180),
  /** The dev-only demo card is refused in production. */
  production: process.env.NODE_ENV === 'production',
  /** Base URL overrides for the payment gateways (tests point these at a local mock). */
  gatewayUrls: {
    bkash: process.env.BKASH_BASE_URL,
    nagad: process.env.NAGAD_BASE_URL,
    sslcommerz: process.env.SSLCOMMERZ_BASE_URL,
  } as Record<string, string | undefined>,
  /** Base URL overrides for the couriers (tests point these at a local mock). */
  courierUrls: {
    pathao: process.env.PATHAO_BASE_URL,
    steadfast: process.env.STEADFAST_BASE_URL,
    redx: process.env.REDX_BASE_URL,
  } as Record<string, string | undefined>,
};

// Pricing rules come from the same catalog the storefront uses.
const catalog = JSON.parse(readFileSync(env.catalogPath, 'utf8'));
export const pricing = {
  freeShippingOver: catalog.freeShippingOver as number,
  shipping: catalog.shipping as Record<'standard' | 'express', { label: string; eta: string; price: number }>,
  typeDetails: catalog.typeDetails as Record<string, { details: string[]; care: string[] }>,
};
