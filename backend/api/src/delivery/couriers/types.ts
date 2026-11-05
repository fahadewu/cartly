import { timingSafeEqual } from 'node:crypto';
import type { Shipment, ShipmentStatus } from '../../generated/prisma/client.js';
import type { Field, Store } from '../../payments/gateways/types.js';

export type { Field, Store };
export type CourierId = 'pathao' | 'steadfast' | 'redx';

/** A courier account as saved in the admin panel. */
export interface Account {
  live: boolean;
  creds: Record<string, string>;
  /** The courier's API base URL for this mode (or the test override). */
  baseUrl: string;
  store: Store;
}

/** A place the courier needs picked from its own list (Pathao city → zone → area, RedX area). */
export interface Place {
  id: string;
  name: string;
}
export interface LocationLevel {
  key: string;
  label: string;
  /** The level this one is listed under (zones of a city); none for the first. */
  parent?: string;
  optional?: boolean;
}

export interface BookInput {
  /** Unique per shipment; the courier's merchant order / invoice id. */
  invoice: string;
  recipient: { name: string; phone: string; address: string; city: string };
  /** Chosen from `locations` (ids by level key), for couriers that have them, and their names. */
  location: Record<string, string>;
  locationNames: Record<string, string>;
  /** Taka to collect on delivery; 0 when paid already. */
  codAmount: number;
  /** What the goods are worth, in taka (some couriers insure up to this). */
  value: number;
  weightKg: number;
  itemCount: number;
  description: string;
  note?: string;
}

export interface Booked {
  consignmentId: string;
  trackingCode?: string;
  trackingUrl?: string;
  charge?: number;
  courierStatus?: string;
  status?: ShipmentStatus;
  raw?: unknown;
}

/** Where a parcel stands at the courier. `status` is null when its status text isn't one we know. */
export interface Tracking {
  status: ShipmentStatus | null;
  courierStatus: string;
  /** The courier's history, when it gives one (oldest first). */
  events?: { at: Date; message: string; status?: ShipmentStatus | null }[];
  charge?: number;
  codCollected?: number;
  raw?: unknown;
}

/** A webhook, authenticated and read: which parcel, and what happened. */
export interface Update {
  consignmentId?: string;
  invoice?: string;
  status: ShipmentStatus | null;
  courierStatus: string;
  message: string;
  at?: Date;
  charge?: number;
  codCollected?: number;
  raw?: unknown;
}

export interface WebhookReply {
  /** Parcel updates in the call (none for a handshake or test). */
  updates: Update[];
  /** Headers the courier expects on our response (Pathao's integration handshake). */
  headers?: Record<string, string>;
  status?: number;
}

export interface Courier {
  id: CourierId;
  name: string;
  fields: Field[];
  baseUrl(live: boolean): string;
  /** The courier has no test environment: every booking is a real parcel, so it books in live mode only. */
  noSandbox?: boolean;
  /** Where a customer can follow the parcel on the courier's site. */
  publicTrackingUrl(code: string): string;
  /** Location lists the courier needs a pick from, in order. */
  levels: LocationLevel[];
  locations?(acct: Account, level: string, parentId?: string): Promise<Place[]>;
  book(acct: Account, input: BookInput): Promise<Booked>;
  track(acct: Account, shipment: Shipment): Promise<Tracking>;
  /** Cancels a parcel not picked up yet. Couriers without an API for it: done in their merchant panel. */
  cancel?(acct: Account, shipment: Shipment): Promise<void>;
  /** Authenticates and reads a webhook call; null if it isn't from the courier. */
  webhook?(acct: Account, req: { headers: Record<string, string | undefined>; query: Record<string, string | undefined>; body: Record<string, unknown> }): Promise<WebhookReply | null>;
  /** How the webhook authenticates, for the admin panel (e.g. "?token=" on the URL). */
  webhookAuth?: 'query-token' | 'header';
  /** Throws a readable error unless the credentials work; resolves to a short confirmation. */
  test(acct: Account): Promise<string>;
}

/** A readable courier failure (safe to show an admin). */
export class CourierError extends Error {
  constructor(
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
  }
}

type Reply = Record<string, unknown>;

/** JSON over HTTP with a timeout; non-JSON replies come back as { message }. */
export async function http(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: Reply }> {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return { status: res.status, body: (Array.isArray(parsed) ? { data: parsed } : parsed) as Reply };
  } catch {
    return { status: res.status, body: { message: text.slice(0, 300) } };
  }
}

/** Compares secrets in constant time. */
export function sameSecret(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "order.at-the-sorting-hub", "At_the_Sorting_HUB" → "atthesortinghub": one key for a courier's two spellings. */
export const squash = (s: unknown) => String(s ?? '').toLowerCase().replace(/^order[._]/, '').replace(/[^a-z]/g, '');

/** "At_the_Sorting_HUB" → "At the sorting hub". */
export const humanize = (s: unknown) => {
  const t = String(s ?? '').replace(/^order\./, '').replace(/[._-]+/g, ' ').trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
};

/** Bangladeshi mobile number as couriers want it: 01XXXXXXXXX (11 digits). */
export function localPhone(phone: string) {
  const digits = phone.replace(/\D/g, '').replace(/^(?:00)?880/, '0');
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}
