import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService, RedisService } from './infra.module.js';
import type { Role } from '../generated/prisma/client.js';
import { type Area, can, isStaff, type Permission } from './permissions.js';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}
type AuthedRequest = Request & { user?: AuthUser };

const bearer = (req: Request) => {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  return scheme === 'Bearer' ? token : undefined;
};

async function verify(jwt: JwtService, token: string): Promise<AuthUser> {
  const payload = await jwt.verifyAsync<{
    sub: string;
    email: string;
    role: AuthUser['role'];
  }>(token);
  return { id: payload.sub, email: payload.email, role: payload.role };
}

/* ---------- account state: is this account still allowed in? ---------- */

type AccountState = { role: Role; disabled: boolean; temporary: boolean };
const STATE_KEY = (id: string) => `acct:${id}`;
/** How long a turned-off account's old token can still work, at most. */
const STATE_TTL = 60;

/**
 * The token says who; the database says whether they're still allowed in (turned off, or still on a
 * temporary password). Cached in Redis for a minute so it's not a database read on every request;
 * `forgetAccountState` clears it the moment an admin changes the account.
 */
async function accountState(db: PrismaService, redis: RedisService, id: string): Promise<AccountState | null> {
  const key = STATE_KEY(id);
  const cached = await redis.get(key).catch(() => null);
  if (cached) return JSON.parse(cached) as AccountState;
  const u = await db.user.findUnique({ where: { id }, select: { role: true, disabledAt: true, passwordTemporary: true } });
  if (!u) return null;
  const state: AccountState = { role: u.role, disabled: !!u.disabledAt, temporary: !!u.passwordTemporary };
  await redis.set(key, JSON.stringify(state), 'EX', STATE_TTL).catch(() => undefined);
  return state;
}
export const forgetAccountState = (redis: RedisService, id: string) => redis.del(STATE_KEY(id)).catch(() => 0);

/** Where someone on a temporary password may still go: to see who they are, and to choose a new one. */
const PASSWORD_ROUTES = (req: Request) =>
  (req.method === 'GET' && /\/auth\/me$/.test(req.path)) || (req.method === 'POST' && /\/auth\/change-password$/.test(req.path));

/** Requires a valid Bearer token for an account that is still allowed in. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    if (!token) throw new UnauthorizedException('Sign in to continue.');
    let user: AuthUser;
    try {
      user = await verify(this.jwt, token);
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
    const state = await accountState(this.db, this.redis, user.id);
    if (!state) throw new UnauthorizedException('Your account no longer exists. Please sign in again.');
    if (state.disabled) throw new UnauthorizedException('This account has been turned off. Ask an admin to turn it back on.');
    // Staff on a password an admin made must choose their own before doing anything else. (Shoppers get
    // the same temporary passwords from a reset, but the storefront has no forced-change screen yet.)
    if (state.temporary && isStaff(state.role) && !PASSWORD_ROUTES(req)) throw new ForbiddenException('Choose a new password before going on.');
    req.user = { ...user, role: state.role };
    return true;
  }
}

/** Attaches the user when a valid token is present, but never blocks. */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    if (token) req.user = await verify(this.jwt, token).catch(() => undefined);
    return true;
  }
}

export const Roles = (...roles: AuthUser['role'][]) => SetMetadata('roles', roles);

/**
 * Use after JwtAuthGuard: allows only the listed roles. The role is read from the
 * database rather than the token, so revoking admin access takes effect immediately.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: PrismaService,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<AuthUser['role'][]>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    const current =
      user &&
      (await this.db.user.findUnique({
        where: { id: user.id },
        select: { role: true, disabledAt: true },
      }));
    if (!current) throw new UnauthorizedException('Your account no longer exists. Please sign in again.');
    if (current.disabledAt) throw new UnauthorizedException('This account has been turned off. Ask an admin to turn it back on.');
    if (!roles.includes(current.role)) throw new ForbiddenException('You don’t have permission to do that.');
    user.role = current.role;
    return true;
  }
}

/**
 * Use after JwtAuthGuard: allows staff whose role grants the route's area (see permissions.ts).
 * GET and HEAD need `<area>.read`, everything else `<area>.write`; an explicit permission such as
 * 'refunds.write' is used as is. Role and disabled state come from the database on every request,
 * so a role change or a turned-off account takes effect at once.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: PrismaService,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const declared = this.reflector.getAllAndOverride<Area | Permission>('staff', [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = req.user;
    const current =
      user &&
      (await this.db.user.findUnique({
        where: { id: user.id },
        select: { role: true, disabledAt: true },
      }));
    if (!current) throw new UnauthorizedException('Your account no longer exists. Please sign in again.');
    if (current.disabledAt) throw new UnauthorizedException('This account has been turned off. Ask an admin to turn it back on.');
    const needed = (
      declared.includes('.') ? declared : `${declared}.${['GET', 'HEAD'].includes(req.method) ? 'read' : 'write'}`
    ) as Permission;
    if (!can(current.role, needed)) {
      throw new ForbiddenException(
        needed.endsWith('.read') ? 'Your role can’t see this.' : 'Your role can’t change this. Ask an admin if you need to.',
      );
    }
    user.role = current.role;
    return true;
  }
}

/** Signed-in staff whose role grants this area (or exact permission). Put it on the controller, and on a route to override. */
export const Staff = (area: Area | Permission) =>
  applyDecorators(ApiBearerAuth(), UseGuards(JwtAuthGuard, StaffGuard), SetMetadata('staff', area));
/** For a single route inside a @Staff controller: needs a different area or permission. */
export const Needs = (area: Area | Permission) => SetMetadata('staff', area);

/** Full admins only: the team, credentials and system settings. */
export const AdminOnly = () => Staff('team');

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

/** Signed-in delivery riders only (role checked against the database on every request). */
export const RiderOnly = () => applyDecorators(ApiBearerAuth(), UseGuards(JwtAuthGuard, RolesGuard), Roles('RIDER'));
