/*
 * How a shopper reaches a person: the store's WhatsApp and phone numbers and hours (Admin → Returns → Support
 * contact). Pip hands an upset shopper or a problem it can't fix to these, because human-like bots hurt
 * satisfaction mainly with angry customers (Crolic et al. 2022, Journal of Marketing). With nothing set, Pip
 * doesn't offer a hand-off at all, rather than promise one that leads nowhere.
 */
import { Body, Controller, Get, Header, Injectable, Module, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { Needs, Staff } from '../common/auth.js';
import { AiIndexService } from '../common/ai-index.js';
import { PrismaService } from '../common/infra.module.js';

const KEY = 'supportContact';

export interface SupportContact {
  /** International format without "+", e.g. 8801712345678 (wa.me links). */
  whatsapp: string | null;
  phone: string | null;
  /** "Sat–Thu, 10am–8pm" */
  hours: string | null;
}

export class SupportDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(/^\d{8,15}$/, { message: 'WhatsApp is the full number with country code and digits only, e.g. 8801712345678.' }) whatsapp?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(/^\+?[0-9][0-9 -]{4,18}$/, { message: 'Enter a phone number, e.g. +880 9612 345678.' }) phone?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60) hours?: string | null;
}

@Injectable()
export class SupportService {
  constructor(
    private readonly db: PrismaService,
    private readonly index: AiIndexService,
  ) {}

  async get(): Promise<SupportContact> {
    const row = await this.db.storeSetting.findUnique({ where: { key: KEY } });
    const v = (row?.value ?? {}) as Partial<SupportContact>;
    return { whatsapp: v.whatsapp || null, phone: v.phone || null, hours: v.hours || null };
  }

  async set(dto: SupportDto) {
    const current = await this.get();
    const tidy = (s: string | null | undefined, keep: string | null) => (s === undefined ? keep : s?.trim() || null);
    const next: SupportContact = { whatsapp: tidy(dto.whatsapp, current.whatsapp), phone: tidy(dto.phone, current.phone), hours: tidy(dto.hours, current.hours) };
    await this.db.storeSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: { ...next } }, update: { value: { ...next } } });
    // Pip's prompt says whether a person can take over; it's rebuilt with the catalog.
    this.index.reindexSoon();
    return next;
  }
}

@ApiTags('catalog')
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /** Public: the hand-off card in Pip's chat shows these. */
  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  get() {
    return this.support.get();
  }
}

@ApiTags('admin')
@Staff('returns')
@Controller('admin/support')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  get() {
    return this.support.get();
  }

  /** Like the return window: a store policy, so it needs the settings permission. */
  @Patch()
  @Needs('settings')
  set(@Body() dto: SupportDto) {
    return this.support.set(dto);
  }
}

@Module({ controllers: [SupportController, AdminSupportController], providers: [SupportService] })
export class SupportModule {}
