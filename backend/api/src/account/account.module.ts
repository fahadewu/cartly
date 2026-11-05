import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNumber, IsOptional, IsString, IsUrl, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { DemandService } from '../common/demand.js';
import { noteWant } from '../outreach/inbox.js';
import { type AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth.js';
import { toProduct } from '../common/serialize.js';

export class CreateRequestDto {
  @IsString() @MinLength(3) @MaxLength(120) product: string;
  @IsIn(['Clothing', 'Shoes', 'Accessories', 'Home', 'Gifts']) category: string;
  @IsOptional() @IsString() @MaxLength(20) size?: string;
  @IsOptional() @IsNumber() @Min(1) budget?: number;
  @IsOptional() @IsUrl({ require_protocol: true }) link?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsEmail() email: string;
}
export class InviteMemberDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEmail() email: string;
  @IsIn(['ADMIN', 'BUYER', 'VIEWER']) role: 'ADMIN' | 'BUYER' | 'VIEWER';
}
export class UpdateMemberDto {
  @IsIn(['ADMIN', 'BUYER', 'VIEWER']) role: 'ADMIN' | 'BUYER' | 'VIEWER';
}

@Injectable()
export class AccountService {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly demand: DemandService,
  ) {}

  async favourites(userId: string) {
    const favs = await this.db.favourite.findMany({
      where: { userId, product: { active: true } },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
    return favs.map((f) => toProduct(f.product));
  }
  async addFavourite(userId: string, productId: number) {
    if (!(await this.db.product.findUnique({ where: { id: productId } }))?.active) throw new NotFoundException('Product not found.');
    const had = await this.db.favourite.findUnique({ where: { userId_productId: { userId, productId } } });
    await this.db.favourite.upsert({ where: { userId_productId: { userId, productId } }, create: { userId, productId }, update: {} });
    if (!had) this.demand.note({ type: 'favourite', userId, productId });
    return this.favourites(userId);
  }
  async removeFavourite(userId: string, productId: number) {
    await this.db.favourite.deleteMany({ where: { userId, productId } });
    return this.favourites(userId);
  }

  async requests(userId: string) {
    const rows = await this.db.productRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({ ...r, budget: r.budget == null ? null : Number(r.budget) }));
  }
  async createRequest(userId: string, dto: CreateRequestDto) {
    const r = await this.db.productRequest.create({
      data: { userId, ...dto, product: dto.product.trim(), email: dto.email.toLowerCase(), notes: dto.notes?.trim() || null },
    });
    // Also a want: when a product like it arrives, the shopper can be told (outreach/).
    void noteWant(this.redis, { userId, source: 'request', text: dto.product.trim() });
    return { ...r, budget: r.budget == null ? null : Number(r.budget) };
  }

  async team(userId: string) {
    const [owner, members] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, email: true } }),
      this.db.teamMember.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { owner: { ...owner, role: 'OWNER', status: 'ACTIVE' }, members };
  }
  async invite(user: AuthUser, dto: InviteMemberDto) {
    const email = dto.email.toLowerCase();
    if (email === user.email) throw new BadRequestException('You’re already the owner of this team.');
    const exists = await this.db.teamMember.findUnique({ where: { ownerId_email: { ownerId: user.id, email } } });
    if (exists) throw new ConflictException('This person is already on your team.');
    return this.db.teamMember.create({ data: { ownerId: user.id, name: dto.name.trim(), email, role: dto.role } });
  }
  async updateMember(userId: string, id: string, dto: UpdateMemberDto) {
    const m = await this.db.teamMember.findFirst({ where: { id, ownerId: userId } });
    if (!m) throw new NotFoundException('Team member not found.');
    return this.db.teamMember.update({ where: { id }, data: { role: dto.role } });
  }
  async removeMember(userId: string, id: string) {
    const { count } = await this.db.teamMember.deleteMany({ where: { id, ownerId: userId } });
    if (!count) throw new NotFoundException('Team member not found.');
  }
}

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('me/favourites')
  favourites(@CurrentUser() u: AuthUser) {
    return this.account.favourites(u.id);
  }
  @Put('me/favourites/:productId')
  addFavourite(@CurrentUser() u: AuthUser, @Param('productId', ParseIntPipe) productId: number) {
    return this.account.addFavourite(u.id, productId);
  }
  @Delete('me/favourites/:productId')
  removeFavourite(@CurrentUser() u: AuthUser, @Param('productId', ParseIntPipe) productId: number) {
    return this.account.removeFavourite(u.id, productId);
  }

  @Get('me/requests')
  requests(@CurrentUser() u: AuthUser) {
    return this.account.requests(u.id);
  }
  @Post('me/requests')
  createRequest(@CurrentUser() u: AuthUser, @Body() dto: CreateRequestDto) {
    return this.account.createRequest(u.id, dto);
  }

  @Get('team')
  team(@CurrentUser() u: AuthUser) {
    return this.account.team(u.id);
  }
  @Post('team')
  invite(@CurrentUser() u: AuthUser, @Body() dto: InviteMemberDto) {
    return this.account.invite(u, dto);
  }
  @Patch('team/:id')
  updateMember(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateMemberDto) {
    return this.account.updateMember(u.id, id, dto);
  }
  @Delete('team/:id')
  @HttpCode(204)
  removeMember(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.account.removeMember(u.id, id);
  }
}

@Module({ controllers: [AccountController], providers: [AccountService] })
export class AccountModule {}
