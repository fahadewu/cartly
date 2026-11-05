import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import bcrypt from 'bcryptjs';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { type AuthUser, CurrentUser, forgetAccountState, JwtAuthGuard } from '../common/auth.js';
import { env } from '../config.js';
import { isStaff, permissionsOf, ROLES } from '../common/permissions.js';
import type { Role } from '../generated/prisma/client.js';

// Same rule as the storefront: 8+ chars with at least 3 of lower/upper/number/symbol.
export const STRONG = /^(?:(?=.*[a-z])(?=.*[A-Z])(?=.*\d)|(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9])|(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9])|(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])).{8,}$/;
export const WEAK_MESSAGE = 'Use at least 8 characters with a mix of upper and lower case, numbers or symbols.';

export class SignupDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEmail() email: string;
  @IsString() @Matches(STRONG, { message: WEAK_MESSAGE }) password: string;
}
export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) password: string;
}
export class UpdateProfileDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEmail() email: string;
}
export class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @Matches(STRONG, { message: WEAK_MESSAGE }) newPassword: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
  ) {}

  private publicUser(u: { id: string; email: string; name: string; role: Role; createdAt: Date; passwordTemporary?: boolean }) {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      memberSince: u.createdAt,
      // For the admin panel: what this account may see and change, and whether it must pick a new password.
      ...(isStaff(u.role)
        ? {
            roleLabel: ROLES[u.role].label,
            permissions: permissionsOf(u.role),
            passwordTemporary: !!u.passwordTemporary,
          }
        : {}),
    };
  }
  private async session(u: { id: string; email: string; name: string; role: Role; createdAt: Date; passwordTemporary?: boolean }) {
    const accessToken = await this.jwt.signAsync({
      sub: u.id,
      email: u.email,
      role: u.role,
    });
    return { accessToken, user: this.publicUser(u) };
  }

  async signup(dto: SignupDto) {
    const email = dto.email.trim().toLowerCase();
    if (await this.db.user.findUnique({ where: { email } })) throw new ConflictException('An account with this email already exists.');
    const user = await this.db.user.create({
      data: {
        email,
        name: dto.name.trim(),
        passwordHash: await bcrypt.hash(dto.password, 10),
      },
    });
    return this.session(user);
  }

  async login(dto: LoginDto) {
    const user = await this.db.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });
    // Same message either way, so accounts can't be enumerated.
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException('Email or password is incorrect.');
    if (user.disabledAt) throw new UnauthorizedException('This account has been turned off. Contact the store if you think that’s a mistake.');
    await this.db.user.update({
      where: { id: user.id },
      data: { lastSignInAt: new Date() },
    });
    return this.session(user);
  }

  async me(id: string) {
    const user = await this.db.user.findUnique({ where: { id } });
    // Signs out a turned-off account the next time the app checks in.
    if (!user || user.disabledAt) throw new UnauthorizedException('Your session has ended. Please sign in again.');
    return this.publicUser(user);
  }

  async updateProfile(id: string, dto: UpdateProfileDto) {
    const email = dto.email.trim().toLowerCase();
    const clash = await this.db.user.findFirst({
      where: { email, NOT: { id } },
    });
    if (clash) throw new ConflictException('That email is already in use.');
    const user = await this.db.user.update({
      where: { id },
      data: { name: dto.name.trim(), email },
    });
    return this.session(user); // new token, since the email is part of it
  }

  async changePassword(id: string, dto: ChangePasswordDto) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id } });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) throw new UnauthorizedException('Your current password is incorrect.');
    await this.db.user.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, 10),
        passwordTemporary: false,
      },
    });
    await forgetAccountState(this.redis, id);
    return { ok: true };
  }
}

/** 10 sign-ins a minute per IP. The e2e suites sign in far more often than any person, so their window is 2 s. */
const AUTH_THROTTLE = { default: { limit: 10, ttl: process.env.NODE_ENV === 'test' ? 2_000 : 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @Throttle(AUTH_THROTTLE)
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Patch('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user.id, dto);
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle(AUTH_THROTTLE)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto);
  }
}

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: env.jwtSecret,
      signOptions: { expiresIn: env.jwtExpiresIn as `${number}d` },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
