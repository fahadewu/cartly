import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Post,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { BumpCatalogCache } from '../common/cache.js';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { AiIndexService } from '../common/ai-index.js';
import { refreshFit } from '../catalog/fit.js';
import { deleteReviewPhotos } from '../catalog/catalog.module.js';
import { NOT_SOLD } from './sales.js';
import { type AuthUser, CurrentUser, forgetAccountState, Needs, Staff } from '../common/auth.js';
import { AREAS, can, isStaff, ROLES, STAFF_ROLES } from '../common/permissions.js';
import { STRONG, WEAK_MESSAGE } from '../auth/auth.module.js';
import { toOrder, toProduct } from '../common/serialize.js';
import type { Prisma, RequestStatus, Role } from '../generated/prisma/client.js';

const REQUEST_STATUSES = ['RECEIVED', 'SOURCING', 'FOUND', 'UNAVAILABLE'] as const;
const insensitive = (term: string) => ({
  contains: term,
  mode: 'insensitive' as const,
});

/* ------------------------------ DTOs ------------------------------ */

class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class AdminUserQuery extends PageQuery {
  /** Matches name or email. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  /** CUSTOMER, STAFF (any staff role) or one staff role. */
  @IsOptional() @IsIn(['CUSTOMER', 'STAFF', ...STAFF_ROLES]) role?: Role | 'STAFF';
  @IsOptional() @IsIn(['newest', 'oldest', 'name']) sort?: 'newest' | 'oldest' | 'name';
}
const ACCOUNT_ROLES = ['CUSTOMER', ...STAFF_ROLES] as const;
export class CreateUserDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEmail() @MaxLength(160) email: string;
  @IsIn(ACCOUNT_ROLES) role: Role;
  /** Left out: a temporary password is made and returned once. */
  @IsOptional()
  @IsString()
  @Matches(STRONG, { message: WEAK_MESSAGE })
  password?: string;
  /** Ask for a new password at their first sign-in to the admin panel (default on). */
  @IsOptional() @IsBoolean() mustChange?: boolean;
}
export class UpdateUserDto {
  @IsOptional() @IsIn(ACCOUNT_ROLES) role?: Role;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string;
}
export class ResetPasswordDto {
  @IsOptional()
  @IsString()
  @Matches(STRONG, { message: WEAK_MESSAGE })
  password?: string;
}

const ALPHABET = {
  lower: 'abcdefghjkmnpqrstuvwxyz',
  upper: 'ABCDEFGHJKMNPQRSTUVWXYZ',
  digit: '23456789',
};
/** A readable one-time password (no 0/O/1/l) that passes the strength rule: e.g. "Rk7m-Tq4w-Hz9p". */
export function temporaryPassword() {
  const pick = (set: string) => set[randomInt(set.length)];
  const group = () => pick(ALPHABET.upper) + pick(ALPHABET.lower) + pick(ALPHABET.digit) + pick(ALPHABET.lower);
  return [group(), group(), group()].join('-');
}
const label = (role: string) => (isStaff(role) ? ROLES[role].label : role === 'RIDER' ? 'Rider' : 'Customer');
export class AdminReviewQuery extends PageQuery {
  /** Matches author, title, text or product name. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @Type(() => Number) @IsInt() productId?: number;
  /** "customer" hides the reviews that came with the seeded catalog. */
  @IsOptional() @IsIn(['all', 'customer']) source?: 'all' | 'customer';
}
export class AdminRequestQuery extends PageQuery {
  @IsOptional() @IsIn(REQUEST_STATUSES) status?: RequestStatus;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}
export class UpdateRequestDto {
  @IsIn(REQUEST_STATUSES) status: RequestStatus;
}

const USER_ORDER: Record<string, Prisma.UserOrderByWithRelationInput> = {
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
  name: { name: 'asc' },
};

/** One line for the activity log, e.g. "changed the role from Customer to Support". */
function describe(e: { action: string; detail: Prisma.JsonValue }) {
  const d = (e.detail ?? {}) as Record<string, string | string[]>;
  switch (e.action) {
    case 'user.create':
      return `added the account as ${label(String(d.role))}`;
    case 'user.role':
      return `changed the role from ${label(String(d.from))} to ${label(String(d.to))}`;
    case 'user.disable':
      return 'turned the account off';
    case 'user.enable':
      return 'turned the account back on';
    case 'user.password':
      return 'reset the password';
    case 'user.update':
      return `changed the ${[d.changed].flat().join(' and ')}`;
    default:
      return e.action;
  }
}

/* ------------------------------ Service ------------------------------ */

@Injectable()
export class AdminPeopleService {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly index: AiIndexService,
  ) {}

  /* ---------- customers ---------- */

  async users(q: AdminUserQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const term = q.q?.trim();
    // Riders are managed under Delivery.
    const search: Prisma.UserWhereInput = {
      role: { not: 'RIDER' },
      ...(term ? { OR: [{ name: insensitive(term) }, { email: insensitive(term) }] } : {}),
    };
    const where: Prisma.UserWhereInput = !q.role
      ? search
      : {
          ...search,
          role: q.role === 'STAFF' ? { in: [...STAFF_ROLES] } : q.role,
        };
    const [rows, total, grouped] = await Promise.all([
      this.db.user.findMany({
        where,
        orderBy: USER_ORDER[q.sort ?? 'newest'],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { orders: true, favourites: true, reviews: true } },
        },
      }),
      this.db.user.count({ where }),
      this.db.user.groupBy({
        by: ['role'],
        where: search,
        _count: { _all: true },
      }),
    ]);
    const byRole = (role: Role) => grouped.find((g) => g.role === role)?._count._all ?? 0;
    const spend = await this.db.order.groupBy({
      by: ['userId'],
      where: {
        userId: { in: rows.map((u) => u.id) },
        status: { notIn: NOT_SOLD },
      },
      _sum: { total: true },
      _max: { createdAt: true },
    });
    return {
      items: rows.map((u) => {
        const s = spend.find((x) => x.userId === u.id);
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          disabled: !!u.disabledAt,
          lastSignInAt: u.lastSignInAt,
          createdAt: u.createdAt,
          orders: u._count.orders,
          favourites: u._count.favourites,
          reviews: u._count.reviews,
          spent: Number(s?._sum.total ?? 0),
          lastOrderAt: s?._max.createdAt ?? null,
        };
      }),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      // Tab counts follow the search, like the orders and requests lists.
      counts: (() => {
        const staff = STAFF_ROLES.reduce((n, r) => n + byRole(r), 0);
        return {
          all: byRole('CUSTOMER') + staff,
          customers: byRole('CUSTOMER'),
          staff,
        };
      })(),
    };
  }

  async user(id: string) {
    const u = await this.db.user.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            orders: true,
            favourites: true,
            reviews: true,
            requests: true,
            team: true,
          },
        },
      },
    });
    if (!u) throw new NotFoundException('Customer not found.');
    const [orders, spend, favourites, reviews, requests, activity] = await Promise.all([
      this.db.order.findMany({
        where: { userId: id },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      this.db.order.aggregate({
        where: { userId: id, status: { notIn: NOT_SOLD } },
        _sum: { total: true },
        _count: { _all: true },
      }),
      this.db.favourite.findMany({
        where: { userId: id },
        include: { product: true },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      this.db.review.findMany({
        where: { userId: id },
        include: {
          product: { select: { id: true, name: true, image: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.db.productRequest.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.activity({ targetId: id }, 15),
    ]);
    const spent = Number(spend._sum.total ?? 0);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      disabled: !!u.disabledAt,
      disabledAt: u.disabledAt,
      passwordTemporary: u.passwordTemporary,
      lastSignInAt: u.lastSignInAt,
      createdAt: u.createdAt,
      activity,
      stats: {
        orders: u._count.orders,
        paidOrders: spend._count._all,
        spent,
        averageOrder: spend._count._all ? Math.round((spent / spend._count._all) * 100) / 100 : 0,
        favourites: u._count.favourites,
        reviews: u._count.reviews,
        requests: u._count.requests,
        teamMembers: u._count.team,
      },
      orders: orders.map(toOrder),
      favourites: favourites.map((f) => toProduct(f.product)),
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        text: r.text,
        createdAt: r.createdAt,
        product: r.product,
      })),
      requests: requests.map((r) => ({
        ...r,
        budget: r.budget == null ? null : Number(r.budget),
      })),
    };
  }

  /* ---------- adding and managing accounts ---------- */

  /** Staff accounts (and any role change to or from staff) need the team permission; customers need customers.write. */
  private guardRole(me: AuthUser, ...roles: (string | undefined)[]) {
    if (roles.some((r) => r && isStaff(r)) && !can(me.role, 'team.write')) {
      throw new ForbiddenException('Only admins can add staff or change staff roles.');
    }
  }
  private async target(me: AuthUser, id: string, { self = false } = {}) {
    const u = await this.db.user.findUnique({ where: { id } });
    if (!u) throw new NotFoundException('Account not found.');
    if (u.role === 'RIDER') throw new BadRequestException('This is a rider account. Manage it under Delivery → Riders.');
    if (!self && u.id === me.id) throw new BadRequestException('You can’t do that to your own account. Ask another admin.');
    this.guardRole(me, u.role);
    return u;
  }
  /** The store must always keep one admin who can sign in. */
  private async keepAnAdmin(u: { id: string; role: Role; disabledAt: Date | null }) {
    if (u.role !== 'ADMIN' || u.disabledAt) return;
    const others = await this.db.user.count({
      where: { role: 'ADMIN', disabledAt: null, NOT: { id: u.id } },
    });
    if (!others) throw new ConflictException('This is the only active admin. Make someone else an admin first.');
  }
  private log(me: AuthUser, action: string, u: { id: string; name: string; email: string }, detail?: Prisma.InputJsonValue) {
    return this.db.auditEntry.create({
      data: {
        actorId: me.id,
        action,
        targetId: u.id,
        target: `${u.name} <${u.email}>`,
        detail,
      },
    });
  }

  async createUser(me: AuthUser, dto: CreateUserDto) {
    this.guardRole(me, dto.role);
    const email = dto.email.trim().toLowerCase();
    if (await this.db.user.findUnique({ where: { email } }))
      throw new ConflictException('An account with this email already exists. Find it in Customers and change its role instead.');
    const password = dto.password ?? temporaryPassword();
    const u = await this.db.user.create({
      data: {
        email,
        name: dto.name.trim(),
        role: dto.role,
        passwordHash: await bcrypt.hash(password, 10),
        // A password made here is always temporary; one the admin typed is unless they say otherwise.
        passwordTemporary: !dto.password || dto.mustChange !== false,
      },
    });
    await this.log(me, 'user.create', u, { role: u.role });
    return {
      user: await this.user(u.id),
      ...(dto.password ? {} : { temporaryPassword: password }),
    };
  }

  async updateUser(me: AuthUser, id: string, dto: UpdateUserDto) {
    const roleChange = dto.role !== undefined;
    const u = await this.target(me, id, { self: !roleChange });
    if (roleChange && dto.role !== u.role) {
      this.guardRole(me, dto.role);
      if (dto.role !== 'ADMIN') await this.keepAnAdmin(u);
    }
    const email = dto.email?.trim().toLowerCase();
    // Changing someone's email and then resetting their password would hand the account to whoever did
    // it, so both are for admins only (every change is in the audit log).
    if (email && email !== u.email && !can(me.role, 'team.write')) throw new ForbiddenException('Only admins can change an account’s email.');
    if (email && email !== u.email && (await this.db.user.findUnique({ where: { email } }))) throw new ConflictException('That email is already in use.');
    const next = await this.db.user.update({
      where: { id },
      data: { role: dto.role, name: dto.name?.trim(), email },
    });
    await forgetAccountState(this.redis, id);
    if (roleChange && dto.role !== u.role) await this.log(me, 'user.role', next, { from: u.role, to: next.role });
    const changed = [dto.name && next.name !== u.name ? 'name' : '', email && email !== u.email ? 'email' : ''].filter(Boolean);
    if (changed.length) await this.log(me, 'user.update', next, { changed });
    return this.user(id);
  }

  async setDisabled(me: AuthUser, id: string, disabled: boolean) {
    const u = await this.target(me, id);
    if (disabled === !!u.disabledAt) return this.user(id);
    if (disabled) await this.keepAnAdmin(u);
    const next = await this.db.user.update({
      where: { id },
      data: { disabledAt: disabled ? new Date() : null },
    });
    await forgetAccountState(this.redis, id); // their current token stops working now, not in a minute
    await this.log(me, disabled ? 'user.disable' : 'user.enable', next);
    return this.user(id);
  }

  async resetPassword(me: AuthUser, id: string, dto: ResetPasswordDto) {
    if (!can(me.role, 'team.write')) throw new ForbiddenException('Only admins can reset passwords.');
    const u = await this.target(me, id);
    const password = dto.password ?? temporaryPassword();
    await this.db.user.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(password, 10),
        passwordTemporary: true,
      },
    });
    await forgetAccountState(this.redis, id);
    await this.log(me, 'user.password', u);
    return {
      user: await this.user(id),
      ...(dto.password ? {} : { temporaryPassword: password }),
    };
  }

  /** Staff accounts, newest first, with who added them. */
  async team() {
    const [rows, activity] = await Promise.all([
      this.db.user.findMany({
        where: { role: { in: [...STAFF_ROLES] } },
        orderBy: [{ disabledAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      }),
      this.activity({}, 30),
    ]);
    return {
      items: rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        disabled: !!u.disabledAt,
        passwordTemporary: u.passwordTemporary,
        lastSignInAt: u.lastSignInAt,
        createdAt: u.createdAt,
      })),
      activity,
    };
  }

  /** What each role can do: the same table the API enforces. */
  roles() {
    return {
      areas: AREAS,
      roles: STAFF_ROLES.map((id) => ({ id, ...ROLES[id] })),
    };
  }

  async activity(where: Prisma.AuditEntryWhereInput, take: number) {
    const rows = await this.db.auditEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: { actor: { select: { id: true, name: true } } },
    });
    return rows.map((e) => ({
      id: e.id,
      action: e.action,
      target: e.target,
      targetId: e.targetId,
      detail: e.detail,
      actor: e.actor,
      createdAt: e.createdAt,
      label: describe(e),
    }));
  }

  /* ---------- reviews ---------- */

  async reviews(q: AdminReviewQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const term = q.q?.trim();
    const where: Prisma.ReviewWhereInput = {
      ...(q.rating ? { rating: q.rating } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.source === 'customer' ? { userId: { not: null } } : {}),
      ...(term
        ? {
            OR: [{ author: insensitive(term) }, { title: insensitive(term) }, { text: insensitive(term) }, { product: { name: insensitive(term) } }],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.review.findMany({
        where,
        include: {
          product: { select: { id: true, name: true, image: true } },
          user: { select: { id: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.review.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        author: r.author,
        rating: r.rating,
        title: r.title,
        text: r.text,
        size: r.size,
        fit: r.fit,
        heightCm: r.heightCm,
        usualSize: r.usualSize,
        photos: r.photos,
        verified: r.verified,
        createdAt: r.createdAt,
        product: r.product,
        customer: r.user,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  /** Removes a review and takes it back out of the product's rating. */
  async deleteReview(id: string) {
    const r = await this.db.review.findUnique({
      where: { id },
      include: { product: true },
    });
    if (!r) throw new NotFoundException('Review not found.');
    const { rating, reviewCount } = r.product;
    const count = Math.max(0, reviewCount - 1);
    const newRating = count ? Math.round(((rating * reviewCount - r.rating) / count) * 10) / 10 : 0;
    await this.db.$transaction([
      this.db.review.delete({ where: { id } }),
      this.db.product.update({
        where: { id: r.productId },
        data: {
          reviewCount: count,
          rating: Math.min(5, Math.max(0, newRating)),
        },
      }),
    ]);
    await deleteReviewPhotos(r.photos);
    // A removed fit review no longer counts towards "runs small / large".
    if (r.fit && (await refreshFit(this.db, [r.productId])).verdictChanged.length) this.index.reindexSoon();
  }

  /* ---------- product requests ---------- */

  async requests(q: AdminRequestQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const term = q.q?.trim();
    const search: Prisma.ProductRequestWhereInput = term
      ? {
          OR: [{ product: insensitive(term) }, { email: insensitive(term) }, { notes: insensitive(term) }, { user: { name: insensitive(term) } }],
        }
      : {};
    const where = { ...search, ...(q.status ? { status: q.status } : {}) };
    const [rows, total, grouped] = await Promise.all([
      this.db.productRequest.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.productRequest.count({ where }),
      this.db.productRequest.groupBy({
        by: ['status'],
        where: search,
        _count: { _all: true },
      }),
    ]);
    const counts = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0]));
    return {
      items: rows.map(({ user, ...r }) => ({
        ...r,
        budget: r.budget == null ? null : Number(r.budget),
        customer: user,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      counts: {
        ALL: Object.values(counts).reduce((a, b) => a + b, 0),
        ...counts,
      },
    };
  }

  async updateRequest(id: string, dto: UpdateRequestDto) {
    const r = await this.db.productRequest
      .update({
        where: { id },
        data: { status: dto.status },
        include: { user: { select: { id: true, name: true, email: true } } },
      })
      .catch(() => null);
    if (!r) throw new NotFoundException('Request not found.');
    const { user, ...rest } = r;
    return {
      ...rest,
      budget: rest.budget == null ? null : Number(rest.budget),
      customer: user,
    };
  }
}

/* ------------------------------ Controller ------------------------------ */

@ApiTags('admin · people')
@Staff('customers')
// Catalog edits (and stock/rating changes) reach the storefront's cached catalog at once.
@UseInterceptors(BumpCatalogCache)
@Controller('admin')
export class AdminPeopleController {
  constructor(private readonly people: AdminPeopleService) {}

  @Get('users')
  users(@Query() q: AdminUserQuery) {
    return this.people.users(q);
  }
  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.people.user(id);
  }
  /** Adds a customer or (admins only) a staff account. Without a password, a temporary one is returned once. */
  @Post('users')
  createUser(@CurrentUser() me: AuthUser, @Body() dto: CreateUserDto) {
    return this.people.createUser(me, dto);
  }
  /** Name, email or role. Staff roles need an admin; you can't change your own role or demote the last admin. */
  @Patch('users/:id')
  updateUser(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.people.updateUser(me, id, dto);
  }
  /** Turns the account off: it can't sign in, and its admin access stops at once. */
  @Post('users/:id/disable')
  @HttpCode(200)
  disable(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.people.setDisabled(me, id, true);
  }
  @Post('users/:id/enable')
  @HttpCode(200)
  enable(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.people.setDisabled(me, id, false);
  }
  /** Sets a new temporary password (returned once unless you give one); they choose their own at next sign-in. */
  @Post('users/:id/reset-password')
  @HttpCode(200)
  resetPassword(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.people.resetPassword(me, id, dto);
  }

  @Needs('team')
  @Get('team')
  team() {
    return this.people.team();
  }
  /** Any staff member may see what the roles can do. */
  @Needs('dashboard')
  @Get('roles')
  roles() {
    return this.people.roles();
  }

  @Needs('reviews')
  @Get('reviews')
  reviews(@Query() q: AdminReviewQuery) {
    return this.people.reviews(q);
  }
  @Needs('reviews')
  @Delete('reviews/:id')
  @HttpCode(204)
  deleteReview(@Param('id') id: string) {
    return this.people.deleteReview(id);
  }

  @Needs('requests')
  @Get('requests')
  requests(@Query() q: AdminRequestQuery) {
    return this.people.requests(q);
  }
  @Needs('requests')
  @Patch('requests/:id')
  updateRequest(@Param('id') id: string, @Body() dto: UpdateRequestDto) {
    return this.people.updateRequest(id, dto);
  }
}
