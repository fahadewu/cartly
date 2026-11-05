import {
  BadRequestException,
  Body,
  Controller,
  Injectable,
  Module,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { callAi } from '../common/ai.js';
import { type AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth.js';
import { dataUri, normaliseImage } from '../common/images.js';
import { PrismaService } from '../common/infra.module.js';
import { DemandService } from '../common/demand.js';

// Multipart fields arrive as strings; JSON ones are parsed here and validated below.
const json = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const PHOTO_TYPES = /^image\/(jpeg|png|webp|heic|heif|avif)$/;

export class RenderDto {
  /** Products to wear, e.g. "[17, 24]". Up to 6. */
  @Transform(json) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @IsInt({ each: true }) productIds: number[];
  /** How the shopper wants an item worn, by product id: {"5": "tuck in the shirt"}. */
  @IsOptional() @Transform(json) @IsObject() notes?: Record<string, string>;
  /** Use a sample model (0–3) instead of a photo. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3) sample?: number;
  /** A different seed gives another take on the same look. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(4_294_967_295) seed?: number;
  /** The shopper agreed to their photo being processed by the try-on service. Required with a photo. */
  @IsOptional() @IsIn(['true', 'false', true, false]) consent?: string | boolean;
}

@Injectable()
export class TryOnService {
  constructor(
    private readonly db: PrismaService,
    private readonly demand: DemandService,
  ) {}

  async render(userId: string, dto: RenderDto, photo?: Express.Multer.File) {
    const ids = [...new Set(dto.productIds)];
    const products = await this.db.product.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true, tryOnSlot: true } });
    for (const id of ids) {
      const p = products.find((x) => x.id === id);
      if (!p) throw new BadRequestException(`Product ${id} isn’t available.`);
      if (!p.tryOnSlot) throw new BadRequestException(`${p.name} can’t be tried on.`);
    }
    for (const id of ids) this.demand.note({ type: 'tryon', userId, productId: id });
    let person: string | undefined;
    if (photo) {
      if (dto.consent !== true && dto.consent !== 'true') throw new BadRequestException('Please agree to the photo notice before using your own photo.');
      if (!PHOTO_TYPES.test(photo.mimetype)) throw new BadRequestException('Use a JPG, PNG or WebP photo.');
      // Strip EXIF (location, camera) before the photo leaves our servers.
      const img = await normaliseImage(photo.buffer, 1600);
      if (Math.min(img.width, img.height) < 320) throw new BadRequestException('That photo is too small. Use one at least 320 pixels wide.');
      person = dataUri(img.data, img.type);
    } else if (dto.sample === undefined) {
      throw new BadRequestException('Add your photo, or pick a sample model.');
    }
    const notes = dto.notes ?? {};
    const items = ids.map((id) => {
      const note = notes[String(id)];
      return { id, ...(typeof note === 'string' && note.trim() ? { notes: note.trim().slice(0, 120) } : {}) };
    });
    return callAi('/tryon/render', {
      method: 'POST',
      // Each item is a render of roughly 10–25 seconds; earlier steps are cached.
      timeoutMs: 180_000,
      body: JSON.stringify({ user_id: userId, photo: person, sample: person ? undefined : dto.sample, items, seed: dto.seed ?? 42 }),
    });
  }
}

@ApiTags('try-on')
@Controller('tryon')
export class TryOnController {
  constructor(private readonly tryon: TryOnService) {}

  /** The shopper's photo re-rendered by AI wearing the chosen products → { image (data URI), steps, rendered, cached }. */
  @Post('render')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: 12 * 1024 * 1024, files: 1 } }))
  render(@CurrentUser() user: AuthUser, @Body() dto: RenderDto, @UploadedFile() photo?: Express.Multer.File) {
    return this.tryon.render(user.id, dto, photo);
  }
}

@Module({ controllers: [TryOnController], providers: [TryOnService] })
export class TryOnModule {}
