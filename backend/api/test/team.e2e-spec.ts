// Staff roles, permissions and user management, against the real local Postgres + Redis.
// Tokens are signed directly so these tests never touch the rate-limited login endpoint (except where login is the point).
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/common/infra.module.js';
import { ROLES, STAFF_ROLES } from '../src/common/permissions.js';
import { temporaryPassword } from '../src/admin/people.js';
import { STRONG } from '../src/auth/auth.module.js';
import type { Role } from '../src/generated/prisma/client.js';

let app: INestApplication;
let db: PrismaService;
let jwt: JwtService;
const api = () => request(app.getHttpServer());
const DOMAIN = '@team-e2e.test';
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const tokens: Partial<Record<Role, string>> = {};
const ids: Partial<Record<Role, string>> = {};
let admin = '';
let adminId = '';

beforeAll(async () => {
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  jwt = app.get(JwtService);
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  const seeded = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  adminId = seeded.id;
  admin = await jwt.signAsync({ sub: seeded.id, email: seeded.email, role: 'ADMIN' });
  for (const role of [...STAFF_ROLES, 'CUSTOMER'] as Role[]) {
    const u = await db.user.create({ data: { email: `${role.toLowerCase()}${DOMAIN}`, name: `E2E ${role}`, role, passwordHash: 'x' } });
    ids[role] = u.id;
    tokens[role] = await jwt.signAsync({ sub: u.id, email: u.email, role });
  }
});

afterAll(async () => {
  await db.auditEntry.deleteMany({ where: { target: { contains: DOMAIN } } });
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await app.close();
});

const get = (path: string, role: Role) => api().get(`/api/v1${path}`).set(as(tokens[role]!));

describe('permissions', () => {
  it('lets every staff role into the dashboard, and no customer', async () => {
    for (const role of STAFF_ROLES) await get('/admin/stats?days=7', role).expect(200);
    await get('/admin/stats?days=7', 'CUSTOMER').expect(403);
  });

  it('analytics without the customers area shows numbers, not names', async () => {
    const seen = (await get('/admin/analytics/customers?days=365', 'MERCHANDISER').expect(200)).body;
    for (const c of seen.top) expect(c).toMatchObject({ name: 'A customer', email: null });
    const visitors = (await get('/admin/analytics/visitors?days=365', 'MERCHANDISER').expect(200)).body;
    for (const v of visitors.recent) expect(v.email).toBeNull();
    const full = (await get('/admin/analytics/customers?days=365', 'ADMIN').expect(200)).body;
    for (const c of full.top) expect(c.email).toMatch(/@/);
  });

  it('shows each role only the areas it has', async () => {
    const cases: [string, Role[], Role[]][] = [
      ['/admin/orders', ['ADMIN', 'MANAGER', 'SUPPORT', 'MERCHANDISER', 'ANALYST'], []],
      ['/admin/products', ['ADMIN', 'MANAGER', 'SUPPORT', 'MERCHANDISER', 'ANALYST'], []],
      ['/admin/analytics/sales', ['ADMIN', 'MANAGER', 'MERCHANDISER', 'ANALYST'], ['SUPPORT']],
      ['/admin/payments', ['ADMIN', 'MANAGER', 'SUPPORT', 'ANALYST'], ['MERCHANDISER']],
      ['/admin/payments/settings', ['ADMIN', 'MANAGER'], ['SUPPORT', 'MERCHANDISER', 'ANALYST']],
      ['/admin/system', ['ADMIN'], ['MANAGER', 'SUPPORT', 'MERCHANDISER', 'ANALYST']],
      ['/admin/team', ['ADMIN'], ['MANAGER', 'SUPPORT', 'MERCHANDISER', 'ANALYST']],
      ['/admin/users', ['ADMIN', 'MANAGER', 'SUPPORT', 'ANALYST'], ['MERCHANDISER']],
    ];
    for (const [path, allowed, denied] of cases) {
      for (const r of allowed) await get(path, r).expect((res) => expect([path, r, res.status]).toEqual([path, r, 200]));
      for (const r of denied) await get(path, r).expect((res) => expect([path, r, res.status]).toEqual([path, r, 403]));
    }
  });

  it('keeps read-only roles from changing anything', async () => {
    const res = await api().post('/api/v1/admin/promos').set(as(tokens.ANALYST!)).send({ code: 'E2ENOPE', type: 'PERCENT', value: 5 });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/can’t change/);
    // Support sees payments but can't refund.
    await api().post('/api/v1/admin/payments/nope/refund').set(as(tokens.SUPPORT!)).send({}).expect(403);
  });

  it('sends the signed-in staff member their permissions', async () => {
    const me = await get('/auth/me', 'SUPPORT').expect(200);
    expect(me.body.roleLabel).toBe('Support');
    expect(me.body.permissions).toEqual(ROLES.SUPPORT.permissions);
    expect(me.body.permissions).toContain('orders.write');
    expect(me.body.permissions).not.toContain('refunds.write');
    const shopper = await get('/auth/me', 'CUSTOMER').expect(200);
    expect(shopper.body.permissions).toBeUndefined();
  });

  it('describes every role', async () => {
    const r = await get('/admin/roles', 'ANALYST').expect(200);
    expect(r.body.roles.map((x: { id: string }) => x.id)).toEqual([...STAFF_ROLES]);
    expect(r.body.areas.team).toBeTruthy();
  });
});

describe('adding people', () => {
  it('makes readable temporary passwords that pass the strength rule', () => {
    for (let i = 0; i < 200; i++) expect(temporaryPassword()).toMatch(STRONG);
  });

  it('adds a staff member with a temporary password they must change', async () => {
    const res = await api()
      .post('/api/v1/admin/users')
      .set(as(admin))
      .send({ name: 'New Support', email: `New.Support${DOMAIN}`.toUpperCase(), role: 'SUPPORT' })
      .expect(201);
    expect(res.body.user).toMatchObject({ role: 'SUPPORT', email: `new.support${DOMAIN}`, passwordTemporary: true, disabled: false });
    expect(res.body.temporaryPassword).toMatch(STRONG);
    expect(res.body.user.activity[0]).toMatchObject({ action: 'user.create', label: 'added the account as Support' });

    const login = await api().post('/api/v1/auth/login').send({ email: `new.support${DOMAIN}`, password: res.body.temporaryPassword }).expect(200);
    expect(login.body.user.passwordTemporary).toBe(true);
    await api()
      .post('/api/v1/auth/change-password')
      .set(as(login.body.accessToken))
      .send({ currentPassword: res.body.temporaryPassword, newPassword: 'Brand-new-pass9' })
      .expect(200);
    const me = await api().get('/api/v1/auth/me').set(as(login.body.accessToken)).expect(200);
    expect(me.body.passwordTemporary).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { email: `new.support${DOMAIN}` } })).lastSignInAt).toBeTruthy();
  });

  it('rejects a duplicate email and a weak password', async () => {
    await api().post('/api/v1/admin/users').set(as(admin)).send({ name: 'Dup', email: `support${DOMAIN}`, role: 'CUSTOMER' }).expect(409);
    await api().post('/api/v1/admin/users').set(as(admin)).send({ name: 'Weak', email: `weak${DOMAIN}`, role: 'CUSTOMER', password: 'short' }).expect(400);
  });

  it('lets managers and support add customers, but only admins add staff', async () => {
    const c = await api()
      .post('/api/v1/admin/users')
      .set(as(tokens.SUPPORT!))
      .send({ name: 'Phone Shopper', email: `phone${DOMAIN}`, role: 'CUSTOMER', password: 'Shopper-pass9', mustChange: false })
      .expect(201);
    expect(c.body.temporaryPassword).toBeUndefined();
    expect(c.body.user.passwordTemporary).toBe(false);
    const denied = await api().post('/api/v1/admin/users').set(as(tokens.MANAGER!)).send({ name: 'Sneaky', email: `sneaky${DOMAIN}`, role: 'ADMIN' }).expect(403);
    expect(denied.body.message).toMatch(/Only admins/);
    await api().post('/api/v1/admin/users').set(as(tokens.MERCHANDISER!)).send({ name: 'Nope', email: `nope${DOMAIN}`, role: 'CUSTOMER' }).expect(403);
  });
});

describe('managing people', () => {
  it('changes roles, applies them at once and logs who did it', async () => {
    const id = ids.CUSTOMER!;
    await get('/admin/orders', 'CUSTOMER').expect(403);
    const r = await api().patch(`/api/v1/admin/users/${id}`).set(as(admin)).send({ role: 'MERCHANDISER' }).expect(200);
    expect(r.body.activity[0]).toMatchObject({ action: 'user.role', label: 'changed the role from Customer to Merchandiser', actor: { id: adminId } });
    await get('/admin/products', 'CUSTOMER').expect(200); // the old customer token now carries the new role
    await api().patch(`/api/v1/admin/users/${id}`).set(as(admin)).send({ role: 'CUSTOMER' }).expect(200);
    await get('/admin/products', 'CUSTOMER').expect(403);
  });

  it('keeps managers away from staff accounts', async () => {
    await api().patch(`/api/v1/admin/users/${ids.ANALYST}`).set(as(tokens.MANAGER!)).send({ role: 'MANAGER' }).expect(403);
    await api().post(`/api/v1/admin/users/${ids.ANALYST}/disable`).set(as(tokens.MANAGER!)).expect(403);
    await api().patch(`/api/v1/admin/users/${ids.CUSTOMER}`).set(as(tokens.MANAGER!)).send({ role: 'SUPPORT' }).expect(403);
  });

  it('turns an account off and back on', async () => {
    const id = ids.ANALYST!;
    const off = await api().post(`/api/v1/admin/users/${id}/disable`).set(as(admin)).expect(200);
    expect(off.body.disabled).toBe(true);
    const blocked = await get('/admin/stats?days=7', 'ANALYST').expect(401);
    expect(blocked.body.message).toMatch(/turned off/);
    await get('/auth/me', 'ANALYST').expect(401);
    await api().post(`/api/v1/admin/users/${id}/enable`).set(as(admin)).expect(200);
    await get('/admin/stats?days=7', 'ANALYST').expect(200);
  });

  it('a turned-off shopper’s existing token stops working at once, everywhere', async () => {
    const id = ids.CUSTOMER!;
    await get('/cart', 'CUSTOMER').expect(200);
    await api().post(`/api/v1/admin/users/${id}/disable`).set(as(admin)).expect(200);
    const blocked = await get('/cart', 'CUSTOMER').expect(401);
    expect(blocked.body.message).toMatch(/turned off/);
    await get('/orders', 'CUSTOMER').expect(401);
    await api().post(`/api/v1/admin/users/${id}/enable`).set(as(admin)).expect(200);
    await get('/cart', 'CUSTOMER').expect(200);
  });

  it('staff on a temporary password can only choose a new one', async () => {
    const res = await api().post('/api/v1/admin/users').set(as(admin)).send({ name: 'Temp', email: `temp${DOMAIN}`, role: 'SUPPORT' }).expect(201);
    const login = await api().post('/api/v1/auth/login').send({ email: `temp${DOMAIN}`, password: res.body.temporaryPassword }).expect(200);
    const token = login.body.accessToken as string;
    const stopped = await api().get('/api/v1/admin/orders').set(as(token)).expect(403);
    expect(stopped.body.message).toMatch(/new password/);
    await api().get('/api/v1/auth/me').set(as(token)).expect(200);
    // The wrong current password is a 401 (the admin panel keeps the session on this route).
    await api().post('/api/v1/auth/change-password').set(as(token)).send({ currentPassword: 'nope', newPassword: 'Brand-new-pass9' }).expect(401);
    await api().post('/api/v1/auth/change-password').set(as(token)).send({ currentPassword: res.body.temporaryPassword, newPassword: 'Brand-new-pass9' }).expect(200);
    await api().get('/api/v1/admin/orders').set(as(token)).expect(200);
  });

  it('only admins can change an email or reset a password (no quiet account takeovers)', async () => {
    const id = ids.CUSTOMER!;
    await api().patch(`/api/v1/admin/users/${id}`).set(as(tokens.SUPPORT!)).send({ email: `stolen${DOMAIN}` }).expect(403);
    await api().post(`/api/v1/admin/users/${id}/reset-password`).set(as(tokens.SUPPORT!)).send({}).expect(403);
    await api().post(`/api/v1/admin/users/${id}/reset-password`).set(as(tokens.MANAGER!)).send({}).expect(403);
    await api().patch(`/api/v1/admin/users/${id}`).set(as(tokens.SUPPORT!)).send({ name: 'Renamed by support' }).expect(200);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).email).toBe(`customer${DOMAIN}`);
  });

  it('refuses a turned-off account at sign-in', async () => {
    const res = await api().post('/api/v1/admin/users').set(as(admin)).send({ name: 'Leaver', email: `leaver${DOMAIN}`, role: 'SUPPORT' }).expect(201);
    await api().post(`/api/v1/admin/users/${res.body.user.id}/disable`).set(as(admin)).expect(200);
    const login = await api().post('/api/v1/auth/login').send({ email: `leaver${DOMAIN}`, password: res.body.temporaryPassword }).expect(401);
    expect(login.body.message).toMatch(/turned off/);
  });

  it('resets a password to a new temporary one', async () => {
    const res = await api().post(`/api/v1/admin/users/${ids.SUPPORT}/reset-password`).set(as(admin)).send({}).expect(200);
    expect(res.body.temporaryPassword).toMatch(STRONG);
    expect(res.body.user.passwordTemporary).toBe(true);
    expect(res.body.user.activity[0].action).toBe('user.password');
  });

  it('protects your own account, so an active admin always remains', async () => {
    // Only an active admin can change staff, and nobody can change themselves.
    await api().patch(`/api/v1/admin/users/${adminId}`).set(as(admin)).send({ role: 'CUSTOMER' }).expect(400);
    await api().post(`/api/v1/admin/users/${adminId}/disable`).set(as(admin)).expect(400);
    await api().post(`/api/v1/admin/users/${adminId}/reset-password`).set(as(admin)).send({}).expect(400);
    // Your own name is fine to change.
    await api().patch(`/api/v1/admin/users/${ids.ADMIN}`).set(as(tokens.ADMIN!)).send({ name: 'E2E Admin Renamed' }).expect(200);
  });

  it('leaves rider accounts to Delivery', async () => {
    const rider = await db.user.create({ data: { email: `rider${DOMAIN}`, name: 'E2E Rider', role: 'RIDER', passwordHash: 'x' } });
    const r = await api().patch(`/api/v1/admin/users/${rider.id}`).set(as(admin)).send({ role: 'SUPPORT' }).expect(400);
    expect(r.body.message).toMatch(/Delivery/);
  });

  it('lists the team with recent activity', async () => {
    const t = await api().get('/api/v1/admin/team').set(as(admin)).expect(200);
    const mine = t.body.items.filter((u: { email: string }) => u.email.endsWith(DOMAIN));
    expect(mine.map((u: { role: string }) => u.role)).toEqual(expect.arrayContaining(['ADMIN', 'MANAGER', 'SUPPORT', 'MERCHANDISER', 'ANALYST']));
    expect(t.body.items.some((u: { role: string }) => u.role === 'CUSTOMER')).toBe(false);
    expect(t.body.activity.length).toBeGreaterThan(0);
    const staff = await api().get('/api/v1/admin/users?role=STAFF&q=team-e2e').set(as(admin)).expect(200);
    expect(staff.body.items.every((u: { role: string }) => u.role !== 'CUSTOMER')).toBe(true);
    expect(staff.body.counts.staff).toBeGreaterThanOrEqual(5);
  });
});
