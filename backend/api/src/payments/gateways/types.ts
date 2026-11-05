import type { Payment } from '../../generated/prisma/client.js';

export type GatewayId = 'bkash' | 'nagad' | 'sslcommerz';

/** One credential in the admin panel's form for a gateway. `secret` ones are never shown again once saved. */
export interface Field {
  key: string;
  label: string;
  secret: boolean;
  multiline?: boolean;
  /** Not needed for the gateway to work (e.g. a base URL from onboarding that differs from the standard one). */
  optional?: boolean;
  hint?: string;
}

/** Shared across API instances (Redis): gateway access tokens and the lock around fetching one. */
export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  /** True for the one caller that gets the lock. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<unknown>;
}

/** A gateway account as saved in the admin panel. */
export interface Account {
  live: boolean;
  creds: Record<string, string>;
  /** The gateway's API base URL for this mode (or the test override). */
  baseUrl: string;
  store: Store;
}

export interface StartInput {
  /** Unique per attempt; what the gateway calls the merchant's invoice / order / transaction id. */
  invoice: string;
  /** In taka. */
  amount: number;
  orderId: string;
  method: 'bkash' | 'nagad' | 'rocket' | 'card';
  /** Our endpoint the gateway sends the shopper (or its server) back to for this attempt. */
  callbackUrl: string;
  customer: { name: string; email: string; phone?: string; street: string; city: string; postal: string; country: string };
  items: { name: string; qty: number }[];
  /** The shopper's IP, which some gateways want on every call. */
  ip?: string;
}

/** What the gateway says happened to a payment. PENDING: not finished yet (ask again later). */
export interface Outcome {
  status: 'PAID' | 'FAILED' | 'CANCELLED' | 'PENDING';
  trxId?: string;
  /** In taka, as reported by the gateway, to compare with what was asked for. */
  amount?: number;
  error?: string;
  raw?: unknown;
}

export interface Gateway {
  id: GatewayId;
  name: string;
  fields: Field[];
  baseUrl(live: boolean): string;
  /** Registers the payment with the gateway; the shopper is then sent to `redirectUrl`. */
  start(acct: Account, input: StartInput): Promise<{ redirectUrl: string; reference: string; raw?: unknown }>;
  /**
   * The shopper came back from the gateway with `params` (its query string or form post). Confirms the
   * payment with the gateway itself (execute, verify or validate): the params alone prove nothing.
   */
  confirm(acct: Account, payment: Payment, params: Record<string, string>): Promise<Outcome>;
  /**
   * For gateways that call back one fixed URL (Nagad's must match the one registered with it): which
   * invoice the return is about.
   */
  invoiceOf?(params: Record<string, string>): string | undefined;
  /**
   * A server-to-server notification from the gateway (SSLCommerz's IPN). Returns the invoice it's
   * about and the confirmed outcome, or null if it can't be authenticated.
   */
  notify?(acct: Account, body: Record<string, string>): Promise<{ invoice: string; outcome: Outcome } | null>;
  /** The payment's current state at the gateway (for the sweeper and the admin's "check status"). */
  query(acct: Account, payment: Payment): Promise<Outcome>;
  refund?(acct: Account, payment: Payment, amount: number, reason: string): Promise<{ refundId?: string; raw?: unknown }>;
  /** Throws a readable error unless the credentials work; resolves to a short confirmation. */
  test(acct: Account): Promise<string>;
}

/** A readable gateway failure (the message is safe to show a shopper or admin). */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
  }
}
