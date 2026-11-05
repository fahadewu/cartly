import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { env } from '../config.js';
import { GATEWAYS } from './gateways/index.js';
import type { Account, GatewayId, Store } from './gateways/types.js';
import { seal, secretsKeySet, unseal } from './secrets.js';

/** What a shopper can pick at checkout, and which gateway takes the money. */
export const METHODS = {
  bkash: { label: 'bKash', gateway: 'bkash' },
  nagad: { label: 'Nagad', gateway: 'nagad' },
  rocket: { label: 'Rocket', gateway: 'sslcommerz' },
  card: { label: 'Card', gateway: 'sslcommerz' },
  cod: { label: 'Cash on delivery', gateway: null },
  demo: { label: 'Demo card', gateway: null },
} as const;
export type MethodId = keyof typeof METHODS;
export const METHOD_IDS = Object.keys(METHODS) as MethodId[];
/** Paid through a gateway before the order is processed. */
export const ONLINE: MethodId[] = ['bkash', 'nagad', 'rocket', 'card'];
export const isOnline = (m: string) => (ONLINE as string[]).includes(m);
const DEFAULT_ON: MethodId[] = ['cod', 'demo'];
const RATE_KEY = 'usdToBdt';

@Injectable()
export class PaymentSettings implements OnModuleInit {
  private readonly store: Store;

  constructor(
    private readonly db: PrismaService,
    redis: RedisService,
  ) {
    this.store = {
      get: (k) => redis.get(k),
      set: (k, v, ttl) => redis.set(k, v, 'EX', ttl),
      claim: async (k, ttl) => (await redis.set(k, '1', 'EX', ttl, 'NX')) === 'OK',
      del: (k) => redis.del(k),
    };
  }

  /** Every method and gateway has a row, so the admin panel always has something to edit. */
  async onModuleInit() {
    await this.db.paymentMethod.createMany({
      data: METHOD_IDS.map((id, position) => ({ id, position, enabled: DEFAULT_ON.includes(id) })),
      skipDuplicates: true,
    });
    await this.db.paymentGateway.createMany({ data: Object.keys(GATEWAYS).map((id) => ({ id })), skipDuplicates: true });
  }

  /** Taka per US dollar, or null until an admin sets it. */
  async rate(): Promise<number | null> {
    const row = await this.db.storeSetting.findUnique({ where: { key: RATE_KEY } });
    const n = Number(row?.value);
    return row && n > 0 ? n : null;
  }

  async setRate(rate: number) {
    await this.db.storeSetting.upsert({ where: { key: RATE_KEY }, create: { key: RATE_KEY, value: rate }, update: { value: rate } });
  }

  /** The saved credentials for a gateway, decrypted; null if it isn't fully set up. */
  async account(id: GatewayId): Promise<Account | null> {
    const row = await this.db.paymentGateway.findUnique({ where: { id } });
    const creds = this.creds(row?.secrets);
    const g = GATEWAYS[id];
    if (!row || !g.fields.every((f) => f.optional || creds[f.key])) return null;
    // A base URL from the gateway's onboarding replaces the standard one for both modes.
    const baseUrl = (env.gatewayUrls[id] ?? creds.baseUrl ?? g.baseUrl(row.live)).replace(/\/$/, '');
    return { live: row.live, creds, baseUrl, store: this.store };
  }

  private creds(secrets?: string | null): Record<string, string> {
    if (!secrets || !secretsKeySet()) return {};
    try {
      return unseal(secrets);
    } catch {
      return {}; // PAYMENT_SECRETS_KEY changed: the credentials have to be entered again
    }
  }

  /** Why a method can't be offered right now, or null if it can. */
  private async unavailable(id: MethodId, rate: number | null): Promise<string | null> {
    if (id === 'demo') return env.production ? 'The demo card is for development only.' : null;
    if (!rate) return 'Set the taka exchange rate first.';
    const gateway = METHODS[id].gateway;
    if (gateway && !(await this.account(gateway))) return `Add the ${GATEWAYS[gateway].name} credentials first.`;
    return null;
  }

  /** The methods a shopper can pay with right now, in the admin's order, with the rate for showing taka amounts. */
  async checkoutOptions() {
    const [rows, rate] = await Promise.all([this.db.paymentMethod.findMany({ where: { enabled: true }, orderBy: { position: 'asc' } }), this.rate()]);
    const methods = [];
    for (const m of rows) {
      const id = m.id as MethodId;
      if (!METHODS[id] || (await this.unavailable(id, rate))) continue;
      const gateway = METHODS[id].gateway;
      methods.push({ id, label: METHODS[id].label, online: isOnline(id), sandbox: gateway ? !(await this.account(gateway))!.live : false });
    }
    return { methods, usdToBdt: rate };
  }

  /** Throws a shopper-readable error unless `id` can be used at checkout now. */
  async requireAvailable(id: string) {
    const method = METHODS[id as MethodId];
    const row = method && (await this.db.paymentMethod.findUnique({ where: { id } }));
    if (!row?.enabled) throw new BadRequestException('That payment method isn’t available. Choose another one.');
    const why = await this.unavailable(id as MethodId, await this.rate());
    if (why) throw new ConflictException(`${method.label} isn’t available right now. Choose another payment method.`);
  }

  /* ---------- admin ---------- */

  async adminView() {
    const [methods, gateways, rate, rateRow] = await Promise.all([
      this.db.paymentMethod.findMany({ orderBy: { position: 'asc' } }),
      this.db.paymentGateway.findMany(),
      this.rate(),
      this.db.storeSetting.findUnique({ where: { key: RATE_KEY } }),
    ]);
    return {
      secretsKeySet: secretsKeySet(),
      production: env.production,
      usdToBdt: rate,
      rateUpdatedAt: rateRow?.updatedAt ?? null,
      methods: await Promise.all(
        methods
          .filter((m) => METHODS[m.id as MethodId])
          .map(async (m) => ({
            id: m.id,
            label: METHODS[m.id as MethodId].label,
            gateway: METHODS[m.id as MethodId].gateway,
            enabled: m.enabled,
            position: m.position,
            unavailable: await this.unavailable(m.id as MethodId, rate),
          })),
      ),
      gateways: Object.values(GATEWAYS).map((g) => {
        const row = gateways.find((r) => r.id === g.id);
        const creds = this.creds(row?.secrets);
        return {
          id: g.id,
          name: g.name,
          live: row?.live ?? false,
          configured: g.fields.every((f) => f.optional || creds[f.key]),
          updatedAt: row?.updatedAt ?? null,
          // Secret values never leave the server: only whether they're set.
          fields: g.fields.map((f) => ({ ...f, set: !!creds[f.key], value: f.secret ? null : (creds[f.key] ?? null) })),
          callbacks: callbackUrls(g.id),
        };
      }),
    };
  }

  async updateMethods(changes: { id: string; enabled?: boolean; position?: number }[]) {
    const rate = await this.rate();
    for (const c of changes) {
      if (!METHODS[c.id as MethodId]) throw new NotFoundException(`Unknown payment method ${c.id}.`);
      if (c.enabled) {
        const why = await this.unavailable(c.id as MethodId, rate);
        if (why) throw new BadRequestException(`${METHODS[c.id as MethodId].label} can’t be switched on yet. ${why}`);
      }
    }
    await this.db.$transaction(changes.map((c) => this.db.paymentMethod.update({ where: { id: c.id }, data: { enabled: c.enabled, position: c.position } })));
  }

  /** Saves a gateway's mode and credentials. A credential left out is kept; an empty string clears it. */
  async saveGateway(id: string, dto: { live?: boolean; credentials?: Record<string, string> }) {
    const g = GATEWAYS[id as GatewayId];
    if (!g) throw new NotFoundException('Unknown payment gateway.');
    const row = await this.db.paymentGateway.findUniqueOrThrow({ where: { id } });
    let secrets = row.secrets;
    if (dto.credentials) {
      if (!secretsKeySet()) throw new BadRequestException('Set PAYMENT_SECRETS_KEY in backend/.env (any long random string) and restart the API before saving credentials.');
      const known = new Set(g.fields.map((f) => f.key));
      const creds = { ...this.creds(row.secrets) };
      for (const [k, v] of Object.entries(dto.credentials)) {
        if (!known.has(k)) throw new BadRequestException(`${g.name} has no setting called ${k}.`);
        if (v.trim()) creds[k] = v.trim();
        else delete creds[k];
      }
      secrets = Object.keys(creds).length ? seal(creds) : null;
    }
    await this.db.paymentGateway.update({ where: { id }, data: { live: dto.live ?? row.live, secrets } });
    // Methods that depend on a gateway that's no longer complete are switched off.
    if (!(await this.account(id as GatewayId))) {
      const ids = METHOD_IDS.filter((m) => METHODS[m].gateway === id);
      await this.db.paymentMethod.updateMany({ where: { id: { in: ids } }, data: { enabled: false } });
    }
  }
}

/** The addresses to give a gateway where it asks for them (Nagad's callback domain, SSLCommerz's IPN). */
export function callbackUrls(id: GatewayId) {
  const base = `${env.publicUrl}/api/v1/payments/${id}`;
  if (id === 'sslcommerz') return { ipn: `${base}/ipn` };
  return { callback: `${base}/callback` };
}
