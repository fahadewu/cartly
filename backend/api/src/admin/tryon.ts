import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestException, Body, Controller, Get, NotFoundException, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';
import { BumpCatalogCache } from '../common/cache.js';
import { aiCapabilities, callAi } from '../common/ai.js';
import { Staff, type AuthUser, CurrentUser } from '../common/auth.js';
import { dataUri, normaliseImage } from '../common/images.js';
import { PrismaService } from '../common/infra.module.js';
import { env } from '../config.js';
import { refreshCutout } from '../tryon/cutout.js';
import { TRY_ON_SLOTS } from './catalog.js';

// require_tld: false so photos uploaded to a local API (http://localhost:4100/…) validate in development.
const URL_OPTS = {
  require_protocol: true,
  protocols: ['http', 'https'],
  require_tld: false,
};
const list = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
};

class PhotoContextDto {
  @IsIn(TRY_ON_SLOTS) slot: string;
  /** Product name and colours help the AI review confirm it's the right item. */
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional()
  @Transform(list)
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  colors?: string[];
}

export class CheckPhotoDto extends PhotoContextDto {
  @IsUrl(URL_OPTS) @MaxLength(500) url: string;
}
export class UploadPhotoDto extends PhotoContextDto {}

class CutoutDto {
  @Type(() => Number) @IsInt() productId: number;
}

export class PreviewDto {
  /** A saved product, or an unsaved photo + slot straight from the editor. */
  @IsOptional() @Type(() => Number) @IsInt() productId?: number;
  @IsOptional() @IsUrl(URL_OPTS) @MaxLength(500) image?: string;
  @IsOptional() @IsIn(TRY_ON_SLOTS) slot?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(120) styling?: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(3) sample: number;
}

type Check = {
  ok: boolean;
  issues: { level: string; code: string; message: string }[];
} & Record<string, unknown>;

/** Checks that run without the AI service: format and resolution only. */
function basicCheck(width: number, height: number, type: string, slot: string): Check {
  const garment = ['top', 'outer', 'dress', 'bottom'].includes(slot);
  const [errMin, warnMin] = garment ? [512, 1024] : [400, 800];
  const short = Math.min(width, height);
  const issues = [
    ...(short < errMin
      ? [
          {
            level: 'error',
            code: 'too_small',
            message: `The photo is ${width}×${height}px. Use at least ${errMin}px on the short side.`,
          },
        ]
      : []),
    ...(short >= errMin && short < warnMin
      ? [
          {
            level: 'warn',
            code: 'low_resolution',
            message: `The photo is ${width}×${height}px. ${warnMin}px or more keeps details sharp.`,
          },
        ]
      : []),
    {
      level: 'info',
      code: 'limited',
      message: 'Only size was checked because the AI service isn’t reachable. Check framing and background by eye.',
    },
  ];
  const ok = !issues.some((i) => i.level === 'error');
  return {
    ok,
    score: ok ? 80 : 30,
    grade: ok ? 'good' : 'fail',
    width,
    height,
    format: type,
    background: 'unknown',
    issues,
    ai: { used: false },
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Try-on photo tools for the product editor: upload a dedicated try-on photo
 * (re-encoded, metadata stripped, then quality-checked), re-check an existing
 * photo, and preview the product on a sample model with the real AI try-on.
 */
@ApiTags('admin')
@Staff('catalog')
// Catalog edits (and stock/rating changes) reach the storefront's cached catalog at once.
@UseInterceptors(BumpCatalogCache)
@Controller('admin/try-on')
export class AdminTryOnController {
  constructor(private readonly db: PrismaService) {}

  /** Whether AI try-on and the AI photo review are switched on. */
  @Get('status')
  status() {
    return aiCapabilities();
  }

  @Post('photo')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadPhotoDto) {
    if (!file?.size) throw new BadRequestException('Choose a photo to upload.');
    const img = await normaliseImage(file.buffer, 2048);
    const name = `${randomUUID()}.${img.ext}`;
    const dir = path.join(env.uploadDir, 'tryon');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), img.data);
    const url = `${env.publicUrl}/api/v1/uploads/tryon/${name}`;
    const check = await callAi<Check>('/tryon/check', {
      method: 'POST',
      timeoutMs: 45_000,
      body: JSON.stringify({
        image: dataUri(img.data, img.type),
        slot: dto.slot,
        name: dto.name,
        colors: dto.colors,
      }),
    }).catch(() => basicCheck(img.width, img.height, img.type, dto.slot));
    return { url, width: img.width, height: img.height, check };
  }

  @Post('check')
  async check(@Body() dto: CheckPhotoDto) {
    return callAi<Check>('/tryon/check', {
      method: 'POST',
      timeoutMs: 45_000,
      body: JSON.stringify({
        image: dto.url,
        slot: dto.slot,
        name: dto.name,
        colors: dto.colors,
      }),
    });
  }

  /** Remakes a saved accessory's quick-preview cut-out now (it's also remade in the background on save). */
  @Post('cutout')
  async cutout(@Body() dto: CutoutDto) {
    const p = await this.db.product.findUnique({
      where: { id: dto.productId },
    });
    if (!p) throw new NotFoundException('Product not found.');
    return { url: (await refreshCutout(this.db, p)).tryOnCutout };
  }

  /** The product on a sample model, rendered by the real AI try-on (uses one render per item). */
  @Post('preview')
  async preview(@CurrentUser() user: AuthUser, @Body() dto: PreviewDto) {
    let item: Record<string, unknown>;
    if (dto.image && dto.slot) {
      item = {
        image: dto.image,
        slot: dto.slot,
        name: dto.name,
        styling: dto.styling ?? '',
      };
    } else if (dto.productId) {
      const p = await this.db.product.findUnique({
        where: { id: dto.productId },
      });
      if (!p?.tryOnSlot) throw new BadRequestException('Turn on virtual try-on for this product first.');
      item = {
        image: p.tryOnImage ?? p.image,
        slot: p.tryOnSlot,
        name: p.name,
        ...(dto.styling !== undefined ? { styling: dto.styling } : {}),
      };
    } else {
      throw new BadRequestException('Send a product, or a photo and a try-on slot.');
    }
    return callAi('/tryon/render', {
      method: 'POST',
      timeoutMs: 120_000,
      body: JSON.stringify({
        user_id: `admin:${user.id}`,
        sample: dto.sample,
        items: [item],
      }),
    });
  }
}
