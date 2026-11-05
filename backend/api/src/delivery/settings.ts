import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { env } from '../config.js';
import { seal, secretsKeySet, unseal } from '../payments/secrets.js';
import { COURIERS } from './couriers/index.js';
import type { Account, CourierId, Store } from './couriers/types.js';

/** Courier accounts saved in the admin panel, with their credentials encrypted like the payment gateways'. */
@Injectable()
export class CourierSettings implements OnModuleInit {
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

  async onModuleInit() {
    await this.db.courier.createMany({ data: Object.keys(COURIERS).map((id) => ({ id })), skipDuplicates: true });
  }

  private creds(secrets?: string | null): Record<string, string> {
    if (!secrets || !secretsKeySet()) return {};
    try {
      return unseal(secrets);
    } catch {
      return {}; // PAYMENT_SECRETS_KEY changed: the credentials have to be entered again
    }
  }

  /** The saved account, decrypted; null if it isn't fully set up. */
  async account(id: CourierId): Promise<Account | null> {
    const row = await this.db.courier.findUnique({ where: { id } });
    const c = COURIERS[id];
    const creds = this.creds(row?.secrets);
    if (!row || !c || !c.fields.every((f) => f.optional || creds[f.key])) return null;
    const baseUrl = (env.courierUrls[id] ?? creds.baseUrl ?? c.baseUrl(row.live)).replace(/\/$/, '');
    return { live: row.live, creds, baseUrl, store: this.store };
  }

  /** Couriers an admin can book with now: switched on and fully set up. */
  async usable() {
    const rows = await this.db.courier.findMany({ where: { enabled: true } });
    const out = [];
    for (const r of rows) {
      const c = COURIERS[r.id as CourierId];
      if (c && (await this.account(c.id))) out.push({ id: c.id, name: c.name, sandbox: !r.live, noSandbox: !!c.noSandbox, levels: c.levels });
    }
    return out;
  }

  async adminView() {
    const rows = await this.db.courier.findMany();
    return {
      secretsKeySet: secretsKeySet(),
      couriers: Object.values(COURIERS).map((c) => {
        const row = rows.find((r) => r.id === c.id);
        const creds = this.creds(row?.secrets);
        return {
          id: c.id,
          name: c.name,
          enabled: row?.enabled ?? false,
          live: row?.live ?? false,
          configured: c.fields.every((f) => f.optional || creds[f.key]),
          updatedAt: row?.updatedAt ?? null,
          // Secret values never leave the server: only whether they're set.
          fields: c.fields.map((f) => ({ ...f, set: !!creds[f.key], value: f.secret ? null : (creds[f.key] ?? null) })),
          webhookUrl: c.webhook ? `${env.publicUrl}/api/v1/delivery/webhooks/${c.id}${c.webhookAuth === 'query-token' ? '?token=YOUR_WEBHOOK_TOKEN' : ''}` : null,
          noSandbox: !!c.noSandbox,
        };
      }),
    };
  }

  /** Saves a courier's mode, switch and credentials. A credential left out is kept; an empty string clears it. */
  async save(id: string, dto: { enabled?: boolean; live?: boolean; credentials?: Record<string, string> }) {
    const c = COURIERS[id as CourierId];
    if (!c) throw new NotFoundException('Unknown courier.');
    const row = await this.db.courier.findUniqueOrThrow({ where: { id } });
    let secrets = row.secrets;
    if (dto.credentials) {
      if (!secretsKeySet()) throw new BadRequestException('Set PAYMENT_SECRETS_KEY in backend/.env (any long random string) and restart the API before saving credentials.');
      const known = new Set(c.fields.map((f) => f.key));
      const creds = { ...this.creds(row.secrets) };
      for (const [k, v] of Object.entries(dto.credentials)) {
        if (!known.has(k)) throw new BadRequestException(`${c.name} has no setting called ${k}.`);
        if (typeof v !== 'string' || v.length > 5000) throw new BadRequestException('Each credential must be text (up to 5,000 characters).');
        if (v.trim()) creds[k] = v.trim();
        else delete creds[k];
      }
      secrets = Object.keys(creds).length ? seal(creds) : null;
    }
    const complete = c.fields.every((f) => f.optional || (secrets && this.creds(secrets)[f.key]));
    if (dto.enabled && !complete) throw new BadRequestException(`Fill in every ${c.name} credential before switching it on.`);
    await this.db.courier.update({ where: { id }, data: { live: dto.live ?? row.live, enabled: complete ? (dto.enabled ?? row.enabled) : false, secrets } });
  }
}
