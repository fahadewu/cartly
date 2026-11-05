/*
 * "Ask family": a shopper shares a look (one or more products, optionally the fitting-room photo) as a link,
 * and family and friends vote on it without an account. In Bangladesh what others think weighs on buying
 * online (Islam, Islam & Zannat 2023, SAGE Open), and shopping together online raises social presence (Zhu,
 * Benbasat & Jiang 2010, ISR), so the vote is built in instead of a screenshot in a chat.
 *
 * Everything lives in Redis and expires after LOOK_TTL_DAYS: the look, its photo and its votes. The photo is
 * only stored when the shopper ticks it, is re-encoded without metadata, and is never written to disk. The link
 * token is the only key to it; "Stop sharing" deletes it all at once.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { type AuthUser, CurrentUser, JwtAuthGuard, OptionalAuthGuard } from '../common/auth.js';
import { normaliseImage } from '../common/images.js';
import { PrismaService, RedisService } from '../common/infra.module.js';

export const LOOK_TTL_DAYS = 7;
const TTL = LOOK_TTL_DAYS * 86_400;
const MAX_VOTERS = 40;
export const REACTIONS = ['love', 'yes', 'unsure', 'no'] as const;
/** Quick reasons a voter can tick (the storefront shows them in English and Bangla). */
export const TAGS = ['colour', 'other-colour', 'too-bright', 'occasion', 'price', 'pricey'] as const;
type Reaction = (typeof REACTIONS)[number];

const key = {
  look: (t: string) => `look:${t}`,
  image: (t: string) => `look:${t}:img`,
  votes: (t: string) => `look:${t}:votes`,
  mine: (userId: string) => `looks:user:${userId}`,
  /** The latest look's votes in one line, for Pip (the AI service reads it with the shopper profile). */
  summary: (userId: string) => `looksum:${userId}`,
};

class LookItemDto {
  @IsInt() productId: number;
  @IsOptional() @IsString() @MaxLength(40) color?: string;
  @IsOptional() @IsString() @MaxLength(12) size?: string;
}
export class CreateLookDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => LookItemDto) items: LookItemDto[];
  /** "Which one for Eid?" */
  @IsOptional() @IsString() @MaxLength(140) note?: string;
  /** Shown to voters as "{name} wants your opinion"; defaults to a signed-in shopper's first name. */
  @IsOptional() @IsString() @MaxLength(30) name?: string;
}
export class VoteDto {
  /** A random id the voter's browser keeps, so changing your mind replaces your vote. */
  @IsUUID() voterId: string;
  @IsIn([...REACTIONS]) reaction: Reaction;
  @IsOptional() @IsString() @MaxLength(30) name?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn([...TAGS], { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(120) comment?: string;
}

interface Look {
  token: string;
  ownerKeyHash: string;
  userId: string | null;
  name: string | null;
  note: string | null;
  items: { productId: number; color: string | null; size: string | null }[];
  image: boolean;
  /** image/jpeg, or image/png for a quick-preview photo with transparency. */
  imageType?: string;
  createdAt: string;
  expiresAt: string;
}
interface Vote {
  name: string | null;
  reaction: Reaction;
  tags: string[];
  comment: string | null;
  at: string;
}

const clean = (s?: string | null) => (s ?? '').replace(/[\p{Cc}<>]/gu, '').replace(/\s+/g, ' ').trim() || null;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || null;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class LooksService {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private async load(token: string): Promise<Look> {
    if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) throw new NotFoundException('This look isn’t shared any more.');
    const raw = await this.redis.get(key.look(token));
    if (!raw) throw new NotFoundException('This look isn’t shared any more.');
    return JSON.parse(raw) as Look;
  }

  /** The shopper who shared it: signed in as its owner, or holding the owner key the browser got back. */
  private async assertOwner(look: Look, user: AuthUser | undefined, ownerKey: string | undefined) {
    if (user && look.userId === user.id) return;
    if (ownerKey) {
      const a = Buffer.from(sha(ownerKey));
      const b = Buffer.from(look.ownerKeyHash);
      if (a.length === b.length && timingSafeEqual(a, b)) return;
    }
    throw new ForbiddenException('Only the shopper who shared this look can do that.');
  }

  async create(user: AuthUser | undefined, dto: CreateLookDto) {
    const ids = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.db.product.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, colors: true, sizes: true } });
    if (products.length !== ids.length) throw new BadRequestException('One of those products isn’t on sale any more.');
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = ids.map((id) => {
      const p = byId.get(id)!;
      const asked = dto.items.find((i) => i.productId === id)!;
      const color = (p.colors as { name: string }[]).find((c) => c.name.toLowerCase() === asked.color?.toLowerCase())?.name ?? null;
      const size = p.sizes.find((s) => s.toLowerCase() === asked.size?.toLowerCase()) ?? null;
      return { productId: id, color, size };
    });
    const owner = user ? await this.db.user.findUnique({ where: { id: user.id }, select: { name: true } }) : null;
    const token = randomBytes(12).toString('base64url');
    const ownerKey = randomBytes(18).toString('base64url');
    const now = Date.now();
    const look: Look = {
      token,
      ownerKeyHash: sha(ownerKey),
      userId: user?.id ?? null,
      name: clean(dto.name) ?? (owner ? firstName(owner.name) : null),
      note: clean(dto.note),
      items,
      image: false,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL * 1000).toISOString(),
    };
    const tx = this.redis.multi().set(key.look(token), JSON.stringify(look), 'EX', TTL);
    if (user) tx.zadd(key.mine(user.id), now, token).zremrangebyscore(key.mine(user.id), 0, now - TTL * 1000).expire(key.mine(user.id), TTL);
    await tx.exec();
    if (user) await this.summarise(user.id);
    return { token, ownerKey, expiresAt: look.expiresAt };
  }

  /** The fitting-room photo for a look, re-encoded (no metadata, long side 1200 px) and kept only in Redis. */
  async setImage(token: string, user: AuthUser | undefined, ownerKey: string | undefined, file: Express.Multer.File | undefined) {
    const look = await this.load(token);
    await this.assertOwner(look, user, ownerKey);
    if (!file?.size) throw new BadRequestException('Choose a photo to share.');
    const img = await normaliseImage(file.buffer, 1200);
    const ttl = Math.max(60, Math.round((Date.parse(look.expiresAt) - Date.now()) / 1000));
    look.image = true;
    look.imageType = img.type;
    await this.redis.multi().set(key.image(token), img.data, 'EX', ttl).set(key.look(token), JSON.stringify(look), 'EX', ttl).exec();
    return { image: true };
  }

  async image(token: string) {
    const [look, data] = await Promise.all([this.load(token), this.redis.getBuffer(key.image(token))]);
    if (!data) throw new NotFoundException('No photo with this look.');
    return { data, type: look.imageType ?? 'image/jpeg' };
  }

  private async votes(token: string) {
    const raw = await this.redis.hgetall(key.votes(token));
    return Object.values(raw)
      .map((v) => JSON.parse(v) as Vote)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  private tally(votes: Vote[]) {
    const reactions = Object.fromEntries(REACTIONS.map((r) => [r, votes.filter((v) => v.reaction === r).length])) as Record<Reaction, number>;
    const tags = Object.fromEntries(TAGS.map((t) => [t, votes.filter((v) => v.tags.includes(t)).length]).filter(([, n]) => n));
    return { total: votes.length, reactions, tags };
  }

  /** What a voter sees: the look, who asked, and everyone's votes so far (names are what voters typed). */
  async view(token: string) {
    const look = await this.load(token);
    const votes = await this.votes(token);
    return {
      token,
      name: look.name,
      note: look.note,
      items: look.items,
      image: look.image,
      createdAt: look.createdAt,
      expiresAt: look.expiresAt,
      ...this.tally(votes),
      votes: votes.map(({ name, reaction, tags, comment, at }) => ({ name, reaction, tags, comment, at })),
    };
  }

  async vote(token: string, dto: VoteDto) {
    const look = await this.load(token);
    const field = dto.voterId.toLowerCase();
    if (!(await this.redis.hexists(key.votes(token), field)) && (await this.redis.hlen(key.votes(token))) >= MAX_VOTERS)
      throw new BadRequestException('This look already has as many votes as it can take.');
    const vote: Vote = { name: clean(dto.name), reaction: dto.reaction, tags: [...new Set(dto.tags ?? [])], comment: clean(dto.comment), at: new Date().toISOString() };
    const ttl = Math.max(60, Math.round((Date.parse(look.expiresAt) - Date.now()) / 1000));
    await this.redis.multi().hset(key.votes(token), field, JSON.stringify(vote)).expire(key.votes(token), ttl).exec();
    if (look.userId) await this.summarise(look.userId);
    return this.view(token);
  }

  /** The signed-in shopper's shared looks that are still live, newest first, with their votes. */
  async mine(user: AuthUser) {
    const tokens = await this.redis.zrevrange(key.mine(user.id), 0, 19);
    const looks = await Promise.all(tokens.map((t) => this.view(t).catch(() => null)));
    return looks.filter(Boolean);
  }

  async remove(token: string, user: AuthUser | undefined, ownerKey: string | undefined) {
    const look = await this.load(token);
    await this.assertOwner(look, user, ownerKey);
    const tx = this.redis.multi().del(key.look(token), key.image(token), key.votes(token));
    if (look.userId) tx.zrem(key.mine(look.userId), token);
    await tx.exec();
    if (look.userId) await this.summarise(look.userId);
  }

  /**
   * Keeps a one-line summary of the shopper's latest look with votes for Pip ("Family votes on #17 …: 3 love it;
   * Ammu: 'Perfect for Eid'"), so the AI service reads it with one key and no extra query.
   */
  private async summarise(userId: string) {
    const tokens = await this.redis.zrevrange(key.mine(userId), 0, 4);
    for (const t of tokens) {
      const raw = await this.redis.get(key.look(t));
      if (!raw) continue;
      const look = JSON.parse(raw) as Look;
      const votes = await this.votes(t);
      if (!votes.length) continue;
      const { reactions } = this.tally(votes);
      const summary = {
        items: look.items.map((i) => i.productId),
        reactions,
        comments: votes
          .filter((v) => v.comment)
          .slice(-3)
          .map((v) => ({ name: v.name, comment: v.comment })),
        at: votes[votes.length - 1].at,
      };
      await this.redis.set(key.summary(userId), JSON.stringify(summary), 'EX', TTL);
      return;
    }
    await this.redis.del(key.summary(userId));
  }
}

const OWNER_KEY = 'x-look-key';

@ApiTags('looks')
@Controller('looks')
export class LooksController {
  constructor(private readonly looks: LooksService) {}

  @Post()
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  create(@CurrentUser() user: AuthUser | undefined, @Body() dto: CreateLookDto) {
    return this.looks.create(user, dto);
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser() user: AuthUser) {
    return this.looks.mine(user);
  }

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  view(@Param('token') token: string) {
    return this.looks.view(token);
  }

  @Get(':token/image')
  async image(@Param('token') token: string, @Res() res: Response) {
    const { data, type } = await this.looks.image(token);
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'X-Robots-Tag': 'noindex' }).send(data);
  }

  @Post(':token/image')
  @UseGuards(OptionalAuthGuard)
  @ApiConsumes('multipart/form-data')
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024, files: 1 } }))
  setImage(@Param('token') token: string, @CurrentUser() user: AuthUser | undefined, @Headers(OWNER_KEY) ownerKey: string | undefined, @UploadedFile() file?: Express.Multer.File) {
    return this.looks.setImage(token, user, ownerKey, file);
  }

  @Post(':token/votes')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  vote(@Param('token') token: string, @Body() dto: VoteDto) {
    return this.looks.vote(token, dto);
  }

  @Delete(':token')
  @UseGuards(OptionalAuthGuard)
  @HttpCode(204)
  remove(@Param('token') token: string, @CurrentUser() user: AuthUser | undefined, @Headers(OWNER_KEY) ownerKey: string | undefined) {
    return this.looks.remove(token, user, ownerKey);
  }
}

@Module({
  controllers: [LooksController],
  providers: [LooksService],
})
export class LooksModule {}
