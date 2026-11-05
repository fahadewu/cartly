import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { callAi } from '../common/ai.js';
import { BumpCatalogCache } from '../common/cache.js';
import { PrismaService, RedisService } from '../common/infra.module.js';
import { noteChange, type ChangeKind } from '../outreach/inbox.js';
import { NOT_SOLD } from './sales.js';
import { Needs, Staff } from '../common/auth.js';
import { toAdminProduct } from '../common/serialize.js';
import { cleanList, detailGaps, FITS, listOf, MIN_DESCRIPTION, OCCASIONS, SEASONS } from '../common/product-details.js';
import { Prisma, type Product } from '../generated/prisma/client.js';
import { refreshCutout } from '../tryon/cutout.js';
import { slugify } from './import-csv.js';
import { AiIndexService } from '../common/ai-index.js';

export const LOW_STOCK = 5;
export const TRY_ON_SLOTS = ['top', 'outer', 'dress', 'bottom', 'feet', 'eyes', 'head', 'ears', 'wrist', 'hand'];
/** How a try-on photo was shot; on-model and ghost-mannequin photos give the most accurate try-on. */
export const TRY_ON_PHOTO_TYPES = ['on-model', 'ghost-mannequin', 'flat-lay', 'product-shot'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MESSAGE = 'Use lowercase letters, numbers and dashes only.';
// Storefront theme tokens (var(--mint), var(--peach)…) or a hex colour.
const THEME = /^(var\(--[a-z-]+\)|#[0-9a-fA-F]{6})$/;
// require_tld: false so photos uploaded to a local API (http://localhost:4100/…) validate in development.
const URL_OPTS = {
  require_protocol: true,
  protocols: ['http', 'https'],
  require_tld: false,
};

// Unsplash photos get a cropped gallery on the storefront; other images show as-is.
const unsplashId = (url: string) => url.match(/images\.unsplash\.com\/photo-([\w-]+)/)?.[1] ?? '';
const unique = <T>(xs: T[]) => [...new Set(xs)];
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** Keeps only the known try-on fields, so a product row never stores arbitrary JSON. */
function tryOnInfo(info: TryOnInfoDto): Prisma.InputJsonObject {
  const c = info.check as Record<string, unknown> | undefined;
  const ai = (c?.ai ?? {}) as Record<string, unknown>;
  const check = c && {
    ok: c.ok === true,
    score: typeof c.score === 'number' ? Math.max(0, Math.min(100, Math.round(c.score))) : null,
    grade: str(c.grade, 10) ?? null,
    width: typeof c.width === 'number' ? c.width : null,
    height: typeof c.height === 'number' ? c.height : null,
    background: str(c.background, 20) ?? null,
    issues: (Array.isArray(c.issues) ? c.issues : []).slice(0, 20).map((i: Record<string, unknown>) => ({
      level: str(i?.level, 10) ?? 'info',
      code: str(i?.code, 40) ?? '',
      message: str(i?.message, 300) ?? '',
    })),
    ai: {
      used: ai.used === true,
      ...(str(ai.seen, 120) ? { seen: str(ai.seen, 120) } : {}),
    },
    checkedAt: str(c.checkedAt, 40) ?? new Date().toISOString(),
    // Which photo and slot the check was for, so the editor can tell when it's out of date.
    url: str(c.url, 500) ?? null,
    slot: str(c.slot, 20) ?? null,
  };
  const crop = info.crop && info.crop[0] < info.crop[2] && info.crop[1] < info.crop[3] ? info.crop : undefined;
  return {
    ...(info.photoType ? { photoType: info.photoType } : {}),
    ...(info.styling?.trim() ? { styling: info.styling.trim() } : {}),
    ...(check ? { check } : {}),
    ...(crop ? { crop } : {}),
    ...(info.cutout ? { cutout: info.cutout } : {}),
  };
}
const pages = (total: number, limit: number) => Math.ceil(total / limit);

/* ------------------------------ DTOs ------------------------------ */

export class ColorDto {
  @IsString() @MinLength(1) @MaxLength(30) name: string;
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'Colour hex must look like #1c1c1c.',
  })
  hex: string;
}

export class TryOnInfoDto {
  @IsOptional() @IsIn(TRY_ON_PHOTO_TYPES) photoType?: string;
  /** Default styling the AI applies, in English, e.g. "wear it open" or "tuck it in". */
  @IsOptional() @IsString() @MaxLength(120) styling?: string;
  /** The last quality check of the try-on photo, as returned by /admin/try-on/photo or /check. */
  @IsOptional() @IsObject() check?: Record<string, unknown>;
  /** Where the item sits in the product photo, [x0, y0, x1, y1] (0-1), for the quick preview's cut-out. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsNumber({}, { each: true })
  @Min(0, { each: true })
  @Max(1, { each: true })
  crop?: number[];
  /** How the quick preview cuts the item out: 'ai' (default, any background) or 'plain' (a studio shot on a plain backdrop). */
  @IsOptional() @IsIn(['ai', 'plain']) cutout?: 'ai' | 'plain';
}

export class ProductDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  /** Generated from the name when left out. */
  @IsOptional()
  @Matches(SLUG, { message: SLUG_MESSAGE })
  @MaxLength(90)
  slug?: string;
  @IsString()
  @MinLength(MIN_DESCRIPTION, {
    message: `Write a description of at least ${MIN_DESCRIPTION} characters, so Pip can describe it.`,
  })
  @MaxLength(1000)
  description: string;
  @IsString() category: string;
  @IsString() @MaxLength(40) type: string;
  @IsIn(['men', 'women', 'unisex']) gender: 'men' | 'women' | 'unisex';
  @IsString() @MinLength(1) @MaxLength(30) label: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.5) @Max(100_000) price: number;
  /** Original price when on sale; null clears it. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.5)
  @Max(100_000)
  compareAt?: number | null;
  @IsInt() @Min(0) @Max(100_000) stock: number;
  @IsOptional() @IsBoolean() isNew?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsUrl(URL_OPTS) @MaxLength(500) image: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ColorDto)
  colors: ColorDto[];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(12, { each: true })
  sizes: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) collections?: string[];
  /** Where the item sits for virtual try-on; null means it can't be tried on. */
  @IsOptional() @IsIn(TRY_ON_SLOTS) tryOnSlot?: string | null;
  /** A clean photo of just this product for the AI try-on (see the photo guide); null uses `image`. */
  @IsOptional() @IsUrl(URL_OPTS) @MaxLength(500) tryOnImage?: string | null;
  @IsOptional()
  @ValidateNested()
  @Type(() => TryOnInfoDto)
  tryOnInfo?: TryOnInfoDto | null;

  // What Pip and search know about it. Whether enough is filled in is checked on the whole product
  // (see detailGaps), so an update may send only what changed.
  /** "100% cotton", "full-grain leather". */
  @IsOptional() @IsString() @MaxLength(80) material?: string | null;
  /** Clothing: slim, regular, relaxed or oversized. */
  @IsOptional() @IsIn([...FITS, null]) fit?: string | null;
  /** How it fits in practice: "runs small, size up". */
  @IsOptional() @IsString() @MaxLength(120) fitNotes?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(OCCASIONS.length)
  @IsIn(OCCASIONS, { each: true })
  occasions?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SEASONS.length)
  @IsIn(SEASONS, { each: true })
  seasons?: string[];
  /** Free words like "minimal" or "streetwear". */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(24, { each: true })
  styleTags?: string[];
  /** Short selling points: "breathable", "hidden pocket". */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MinLength(3, { each: true })
  @MaxLength(80, { each: true })
  features?: string[];
  /** Other names shoppers use, in any language: "panjabi", "পাঞ্জাবি". */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(40, { each: true })
  keywords?: string[];
  @IsOptional() @IsString() @MaxLength(200) careNotes?: string | null;
  /** Product ids that go well with it (up to 6). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsInt({ each: true })
  pairsWith?: number[];
}
export class UpdateProductDto extends PartialType(ProductDto) {}

export class SuggestDetailsDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsString() @MaxLength(40) type: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsIn(['men', 'women', 'unisex']) gender?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  colors?: string[];
  /** The product photo (URL); the suggestion looks at it. */
  @IsOptional() @IsUrl(URL_OPTS) @MaxLength(500) image?: string;
}

export class AdminProductQuery {
  /** Matches id, name, slug, label or type. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsIn(['all', 'active', 'archived']) status?: 'all' | 'active' | 'archived';
  @IsOptional() @IsIn(['in', 'low', 'out']) stock?: 'in' | 'low' | 'out';
  /** Products missing details Pip needs. */
  @IsOptional() @IsIn(['incomplete']) details?: 'incomplete';
  @IsOptional()
  @IsIn(['newest', 'name', 'price-asc', 'price-desc', 'stock-asc', 'popular'])
  sort?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class CategoryDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) title?: string;
  @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @IsOptional() @IsUrl(URL_OPTS) @MaxLength(500) image?: string;
  @IsOptional()
  @Matches(THEME, {
    message: 'Colour must be a theme token like var(--mint) or a hex colour.',
  })
  color?: string;
}

export class CollectionDto {
  @Matches(SLUG, { message: SLUG_MESSAGE }) @MaxLength(60) slug: string;
  @IsString() @MinLength(2) @MaxLength(60) title: string;
  @IsString() @MaxLength(120) subtitle: string;
  @IsUrl(URL_OPTS) @MaxLength(500) image: string;
  @Matches(THEME, {
    message: 'Colour must be a theme token like var(--mint) or a hex colour.',
  })
  color: string;
}
export class UpdateCollectionDto extends PartialType(OmitType(CollectionDto, ['slug'] as const)) {}

export class StoryDto {
  @IsString() @MinLength(3) @MaxLength(100) title: string;
  /** Generated from the title when left out. */
  @IsOptional()
  @Matches(SLUG, { message: SLUG_MESSAGE })
  @MaxLength(90)
  slug?: string;
  @IsString() @MinLength(10) @MaxLength(300) excerpt: string;
  @IsUrl(URL_OPTS) @MaxLength(500) image: string;
  @Matches(THEME, {
    message: 'Colour must be a theme token like var(--mint) or a hex colour.',
  })
  color: string;
  /** Paragraphs. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(2000, { each: true })
  body: string[];
  @IsArray() @ArrayMaxSize(12) @IsInt({ each: true }) productIds: number[];
}
export class UpdateStoryDto extends PartialType(OmitType(StoryDto, ['slug'] as const)) {}

const PRODUCT_ORDER: Record<string, Prisma.ProductOrderByWithRelationInput[]> = {
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  name: [{ name: 'asc' }],
  'price-asc': [{ price: 'asc' }],
  'price-desc': [{ price: 'desc' }],
  'stock-asc': [{ stock: 'asc' }, { id: 'asc' }],
  popular: [{ popularity: 'desc' }],
};

/* ------------------------------ Service ------------------------------ */

@Injectable()
export class AdminCatalogService {
  private readonly log = new Logger('AdminCatalog');
  constructor(
    private readonly db: PrismaService,
    private readonly index: AiIndexService,
    private readonly redis: RedisService,
  ) {}

  /** Tells the outreach worker what changed, so shoppers waiting for it can hear (outreach/inbox.ts). */
  private noteChange(before: Product | null, after: Product) {
    const kinds: ChangeKind[] = [];
    if (after.active && (!before || !before.active)) kinds.push('new');
    if (before && before.stock <= 0 && after.stock > 0) kinds.push('restock');
    if (before && Number(after.price) < Number(before.price)) kinds.push('price_drop');
    if (before && !kinds.length && after.active) kinds.push('updated');
    void noteChange(this.redis, { productId: after.id, kinds, ...(kinds.includes('price_drop') ? { was: Number(before!.price) } : {}) });
  }

  /** The quick preview's cut-out follows the try-on photo; made in the background (it takes a few seconds). */
  private cutoutSoon(p: Product) {
    refreshCutout(this.db, p).catch((e) => this.log.warn(`Cut-out for product ${p.id} failed: ${(e as Error).message}`));
  }

  /* ---------- products ---------- */

  async products(q: AdminProductQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const and: Prisma.ProductWhereInput[] = [];
    if (q.status === 'active') and.push({ active: true });
    if (q.status === 'archived') and.push({ active: false });
    if (q.category) and.push({ categorySlug: q.category });
    if (q.stock === 'out') and.push({ stock: { lte: 0 } });
    if (q.stock === 'low') and.push({ stock: { gt: 0, lte: LOW_STOCK } });
    if (q.stock === 'in') and.push({ stock: { gt: LOW_STOCK } });
    if (q.details === 'incomplete') {
      and.push({ OR: [{ material: null }, { material: '' }, { occasions: { isEmpty: true } }, { seasons: { isEmpty: true } }, { styleTags: { isEmpty: true } }, { features: { isEmpty: true } }, { type: { in: ['Clothing'] }, fit: null }] });
    }
    const term = q.q?.trim();
    if (term) {
      and.push({
        OR: [
          ...(/^\d+$/.test(term) ? [{ id: Number(term) }] : []),
          ...(['name', 'slug', 'label', 'type'] as const).map((f) => ({
            [f]: { contains: term, mode: 'insensitive' as const },
          })),
        ],
      });
    }
    const where = { AND: and };
    const [rows, total, active, archived, low, out] = await Promise.all([
      this.db.product.findMany({
        where,
        orderBy: PRODUCT_ORDER[q.sort ?? 'newest'],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.product.count({ where }),
      this.db.product.count({ where: { active: true } }),
      this.db.product.count({ where: { active: false } }),
      this.db.product.count({
        where: { active: true, stock: { gt: 0, lte: LOW_STOCK } },
      }),
      this.db.product.count({ where: { active: true, stock: { lte: 0 } } }),
    ]);
    const sold = await this.unitsSold(rows.map((p) => p.id));
    return {
      items: rows.map((p) => ({
        ...toAdminProduct(p),
        unitsSold: sold.get(p.id) ?? 0,
      })),
      total,
      page,
      limit,
      pages: pages(total, limit),
      counts: {
        all: active + archived,
        active,
        archived,
        lowStock: low,
        outOfStock: out,
      },
    };
  }

  private async unitsSold(ids: number[]) {
    if (!ids.length) return new Map<number, number>();
    const rows = await this.db.orderItem.groupBy({
      by: ['productId'],
      where: { productId: { in: ids }, order: { status: { notIn: NOT_SOLD } } },
      _sum: { qty: true },
    });
    return new Map(rows.map((r) => [r.productId, r._sum.qty ?? 0]));
  }

  async product(id: number) {
    const p = await this.db.product.findUnique({
      where: { id },
      include: { _count: { select: { favourites: true, reviews: true } } },
    });
    if (!p) throw new NotFoundException('Product not found.');
    const [sales] = await this.db.$queryRaw<{ units: bigint; revenue: Prisma.Decimal; orders: bigint }[]>`
      SELECT COALESCE(SUM(i.qty), 0) AS units, COALESCE(SUM(i.qty * i.price), 0) AS revenue, COUNT(DISTINCT i."orderId") AS orders
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
      WHERE i."productId" = ${id} AND o.status NOT IN ('CANCELLED', 'PENDING_PAYMENT')`;
    const { _count, ...product } = p;
    return {
      ...toAdminProduct(product),
      unitsSold: Number(sales.units),
      revenue: Number(sales.revenue),
      orders: Number(sales.orders),
      favourites: _count.favourites,
      storedReviews: _count.reviews,
    };
  }

  async createProduct(dto: ProductDto) {
    await this.checkProduct(dto);
    const slug = dto.slug ?? (await this.freeSlug(slugify(dto.name)));
    if (dto.slug && (await this.db.product.findUnique({ where: { slug } }))) throw new ConflictException('Another product already uses that slug.');
    // Product ids are small integers shared with the storefront, so take the next one.
    for (let attempt = 0; ; attempt++) {
      const { _max } = await this.db.product.aggregate({ _max: { id: true } });
      try {
        const p = await this.db.product.create({
          data: {
            ...this.productData(dto),
            id: (_max.id ?? 0) + 1,
            slug,
            rating: 0,
            reviewCount: 0,
            popularity: 0,
          } as Prisma.ProductUncheckedCreateInput,
        });
        this.index.reindexSoon();
        this.cutoutSoon(p);
        this.noteChange(null, p);
        return toAdminProduct(p);
      } catch (e) {
        if (attempt < 3 && (e as { code?: string }).code === 'P2002') continue;
        throw e;
      }
    }
  }

  async updateProduct(id: number, dto: UpdateProductDto) {
    const current = await this.db.product.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Product not found.');
    await this.checkProduct(dto, current);
    if (dto.slug && dto.slug !== current.slug && (await this.db.product.findUnique({ where: { slug: dto.slug } }))) {
      throw new ConflictException('Another product already uses that slug.');
    }
    const p = await this.db.product.update({
      where: { id },
      data: this.productData(dto),
    });
    this.index.reindexSoon();
    this.cutoutSoon(p);
    this.noteChange(current, p);
    return toAdminProduct(p);
  }

  async deleteProduct(id: number) {
    const p = await this.db.product.findUnique({
      where: { id },
      include: { _count: { select: { orderItems: true } } },
    });
    if (!p) throw new NotFoundException('Product not found.');
    if (p._count.orderItems) {
      throw new ConflictException('This product appears in past orders, so it can’t be deleted. Archive it instead to hide it from the store.');
    }
    await this.db.$transaction(async (tx) => {
      const stories = await tx.story.findMany({
        where: { productIds: { has: id } },
      });
      for (const s of stories)
        await tx.story.update({
          where: { slug: s.slug },
          data: { productIds: s.productIds.filter((x) => x !== id) },
        });
      await tx.product.delete({ where: { id } });
    });
    this.index.reindexSoon();
  }

  /** Cross-field rules the DTO can't express on its own. */
  private async checkProduct(dto: UpdateProductDto, current?: Product) {
    if (dto.category !== undefined || dto.type !== undefined) {
      const slug = dto.category ?? current!.categorySlug;
      const type = dto.type ?? current!.type;
      const c = await this.db.category.findUnique({ where: { slug } });
      if (!c) throw new BadRequestException('Choose a valid category.');
      if (!c.types.includes(type)) throw new BadRequestException(`${c.title} products must be one of: ${c.types.join(', ')}.`);
    }
    const price = dto.price ?? Number(current?.price);
    const compareAt = dto.compareAt === undefined ? (current?.compareAt == null ? null : Number(current.compareAt)) : dto.compareAt;
    if (compareAt != null && compareAt <= price) throw new BadRequestException('The “compare at” price must be higher than the selling price.');
    if (dto.colors) {
      const names = dto.colors.map((c) => c.name.trim().toLowerCase());
      if (new Set(names).size !== names.length) throw new BadRequestException('Each colour needs a different name.');
    }
    if (dto.collections?.length) {
      const known = new Set((await this.db.collection.findMany({ select: { slug: true } })).map((c) => c.slug));
      const missing = dto.collections.filter((c) => !known.has(c));
      if (missing.length) throw new BadRequestException(`Unknown collection: ${missing.join(', ')}.`);
    }
    if (dto.pairsWith?.length) {
      const found = await this.db.product.count({
        where: { id: { in: dto.pairsWith.filter((id) => id !== current?.id) } },
      });
      if (found !== new Set(dto.pairsWith.filter((id) => id !== current?.id)).size) throw new BadRequestException('“Goes well with” lists a product that doesn’t exist.');
    }
    // Pip recommends from these details, so a product can't go live without them. Quick changes from
    // the product list (stock, archiving) don't need the whole form.
    const quick = Object.keys(dto).every((k) => ['stock', 'active', 'isNew'].includes(k));
    const data = { ...(current ?? {}), ...this.productData(dto) } as Product;
    if (!quick && data.active !== false) {
      const { required } = detailGaps({
        ...data,
        type: dto.type ?? current?.type ?? '',
      });
      if (required.length) throw new BadRequestException(`Pip needs ${listOf(required)} before this product can be saved.`);
    }
  }

  private productData(dto: UpdateProductDto): Prisma.ProductUncheckedUpdateInput {
    const d: Prisma.ProductUncheckedUpdateInput = {};
    if (dto.name !== undefined) d.name = dto.name.trim();
    if (dto.slug !== undefined) d.slug = dto.slug;
    if (dto.description !== undefined) d.description = dto.description.trim();
    if (dto.category !== undefined) d.categorySlug = dto.category;
    if (dto.type !== undefined) d.type = dto.type;
    if (dto.gender !== undefined) d.gender = dto.gender;
    if (dto.label !== undefined) d.label = dto.label.trim();
    if (dto.price !== undefined) d.price = dto.price;
    if (dto.compareAt !== undefined) d.compareAt = dto.compareAt;
    if (dto.stock !== undefined) d.stock = dto.stock;
    if (dto.isNew !== undefined) d.isNew = dto.isNew;
    if (dto.active !== undefined) d.active = dto.active;
    if (dto.image !== undefined) {
      d.image = dto.image;
      d.photoId = unsplashId(dto.image);
    }
    if (dto.colors !== undefined)
      d.colors = dto.colors.map((c) => ({
        name: c.name.trim(),
        hex: c.hex.toLowerCase(),
      }));
    if (dto.sizes !== undefined) d.sizes = unique(dto.sizes.map((s) => s.trim()));
    if (dto.collections !== undefined) d.collections = unique(dto.collections);
    if (dto.tryOnSlot !== undefined) d.tryOnSlot = dto.tryOnSlot || null;
    if (dto.tryOnImage !== undefined) d.tryOnImage = dto.tryOnImage || null;
    if (dto.tryOnInfo !== undefined) d.tryOnInfo = dto.tryOnInfo ? tryOnInfo(dto.tryOnInfo) : Prisma.DbNull;
    if (dto.material !== undefined) d.material = dto.material?.trim() || null;
    if (dto.fit !== undefined) d.fit = dto.fit || null;
    if (dto.fitNotes !== undefined) d.fitNotes = dto.fitNotes?.trim() || null;
    if (dto.occasions !== undefined) d.occasions = unique(dto.occasions);
    if (dto.seasons !== undefined) d.seasons = unique(dto.seasons);
    if (dto.styleTags !== undefined) d.styleTags = cleanList(dto.styleTags, true);
    if (dto.features !== undefined) d.features = cleanList(dto.features);
    // Lower-case, so keyword search matches however the shopper types it (scripts without case are unchanged).
    if (dto.keywords !== undefined) d.keywords = cleanList(dto.keywords, true);
    if (dto.careNotes !== undefined) d.careNotes = dto.careNotes?.trim() || null;
    if (dto.pairsWith !== undefined) d.pairsWith = unique(dto.pairsWith);
    return d;
  }

  private async freeSlug(base: string, table: 'product' | 'story' = 'product') {
    const taken = async (slug: string) =>
      table === 'product' ? !!(await this.db.product.findUnique({ where: { slug } })) : !!(await this.db.story.findUnique({ where: { slug } }));
    let slug = base;
    for (let n = 2; await taken(slug); n++) slug = `${base}-${n}`;
    return slug;
  }

  /* ---------- categories & collections ---------- */

  async categories() {
    const rows = await this.db.category.findMany({
      orderBy: { slug: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    return rows.map(({ _count, ...c }) => ({
      ...c,
      products: _count.products,
    }));
  }

  async updateCategory(slug: string, dto: CategoryDto) {
    const c = await this.db.category.update({ where: { slug }, data: dto }).catch(() => null);
    if (!c) throw new NotFoundException('Category not found.');
    return c;
  }

  async collections() {
    const rows = await this.db.collection.findMany({
      orderBy: { slug: 'asc' },
    });
    const counts = await Promise.all(
      rows.map((c) =>
        this.db.product.count({
          where: c.slug === 'offers' ? { compareAt: { not: null } } : { collections: { has: c.slug } },
        }),
      ),
    );
    // "offers" is filled automatically with every product that has a compare-at price.
    return rows.map((c, i) => ({
      ...c,
      products: counts[i],
      automatic: c.slug === 'offers',
    }));
  }

  async createCollection(dto: CollectionDto) {
    if (await this.db.collection.findUnique({ where: { slug: dto.slug } })) throw new ConflictException('A collection with that slug already exists.');
    return this.db.collection.create({
      data: { ...dto, title: dto.title.trim(), subtitle: dto.subtitle.trim() },
    });
  }

  async updateCollection(slug: string, dto: UpdateCollectionDto) {
    const c = await this.db.collection.update({ where: { slug }, data: dto }).catch(() => null);
    if (!c) throw new NotFoundException('Collection not found.');
    return c;
  }

  async deleteCollection(slug: string) {
    if (slug === 'offers') throw new BadRequestException('The offers collection is built in and can’t be deleted.');
    if (!(await this.db.collection.findUnique({ where: { slug } }))) throw new NotFoundException('Collection not found.');
    await this.db.$transaction([
      this.db.$executeRaw`UPDATE "Product" SET collections = array_remove(collections, ${slug}) WHERE ${slug} = ANY(collections)`,
      this.db.collection.delete({ where: { slug } }),
    ]);
    this.index.reindexSoon();
  }

  /* ---------- stories ---------- */

  stories() {
    return this.db.story.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async story(slug: string) {
    const s = await this.db.story.findUnique({ where: { slug } });
    if (!s) throw new NotFoundException('Story not found.');
    return s;
  }

  async createStory(dto: StoryDto) {
    await this.checkStoryProducts(dto.productIds);
    const slug = dto.slug ?? (await this.freeSlug(slugify(dto.title), 'story'));
    if (dto.slug && (await this.db.story.findUnique({ where: { slug } }))) throw new ConflictException('A story with that slug already exists.');
    return this.db.story.create({
      data: { ...this.storyData(dto), slug } as Prisma.StoryCreateInput,
    });
  }

  async updateStory(slug: string, dto: UpdateStoryDto) {
    await this.story(slug);
    if (dto.productIds) await this.checkStoryProducts(dto.productIds);
    return this.db.story.update({ where: { slug }, data: this.storyData(dto) });
  }

  async deleteStory(slug: string) {
    const { count } = await this.db.story.deleteMany({ where: { slug } });
    if (!count) throw new NotFoundException('Story not found.');
  }

  private storyData(dto: UpdateStoryDto): Prisma.StoryUpdateInput {
    const d: Prisma.StoryUpdateInput = {};
    if (dto.title !== undefined) d.title = dto.title.trim();
    if (dto.excerpt !== undefined) d.excerpt = dto.excerpt.trim();
    if (dto.image !== undefined) d.image = dto.image;
    if (dto.color !== undefined) d.color = dto.color;
    if (dto.body !== undefined) d.body = dto.body.map((b) => b.trim()).filter(Boolean);
    if (dto.productIds !== undefined) d.productIds = unique(dto.productIds);
    return d;
  }

  private async checkStoryProducts(ids: number[]) {
    const found = await this.db.product.count({
      where: { id: { in: unique(ids) } },
    });
    if (found !== unique(ids).length) throw new BadRequestException('One or more of the chosen products no longer exist.');
  }
}

/* ------------------------------ Controller ------------------------------ */

@ApiTags('admin · catalog')
@Staff('catalog')
// Catalog edits (and stock/rating changes) reach the storefront's cached catalog at once.
@UseInterceptors(BumpCatalogCache)
@Controller('admin')
export class AdminCatalogController {
  constructor(private readonly catalog: AdminCatalogService) {}

  @Get('products')
  products(@Query() q: AdminProductQuery) {
    return this.catalog.products(q);
  }
  @Get('products/:id')
  product(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.product(id);
  }
  /** A draft of the details Pip needs, from the photo and the text so far (Claude; nothing is saved). */
  @Post('products/suggest-details')
  @HttpCode(200)
  suggestDetails(@Body() dto: SuggestDetailsDto) {
    return callAi('/catalog/suggest', {
      method: 'POST',
      body: JSON.stringify(dto),
      timeoutMs: 60_000,
    });
  }

  @Post('products')
  createProduct(@Body() dto: ProductDto) {
    return this.catalog.createProduct(dto);
  }
  @Patch('products/:id')
  updateProduct(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProductDto) {
    return this.catalog.updateProduct(id, dto);
  }
  /** Only for products that were never ordered; archive the rest. */
  @Delete('products/:id')
  @HttpCode(204)
  deleteProduct(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.deleteProduct(id);
  }

  @Get('categories')
  categories() {
    return this.catalog.categories();
  }
  @Needs('content')
  @Patch('categories/:slug')
  updateCategory(@Param('slug') slug: string, @Body() dto: CategoryDto) {
    return this.catalog.updateCategory(slug, dto);
  }

  @Get('collections')
  collections() {
    return this.catalog.collections();
  }
  @Needs('content')
  @Post('collections')
  createCollection(@Body() dto: CollectionDto) {
    return this.catalog.createCollection(dto);
  }
  @Needs('content')
  @Patch('collections/:slug')
  updateCollection(@Param('slug') slug: string, @Body() dto: UpdateCollectionDto) {
    return this.catalog.updateCollection(slug, dto);
  }
  @Needs('content')
  @Delete('collections/:slug')
  @HttpCode(204)
  deleteCollection(@Param('slug') slug: string) {
    return this.catalog.deleteCollection(slug);
  }

  @Needs('content')
  @Get('stories')
  stories() {
    return this.catalog.stories();
  }
  @Needs('content')
  @Get('stories/:slug')
  story(@Param('slug') slug: string) {
    return this.catalog.story(slug);
  }
  @Needs('content')
  @Post('stories')
  createStory(@Body() dto: StoryDto) {
    return this.catalog.createStory(dto);
  }
  @Needs('content')
  @Patch('stories/:slug')
  updateStory(@Param('slug') slug: string, @Body() dto: UpdateStoryDto) {
    return this.catalog.updateStory(slug, dto);
  }
  @Needs('content')
  @Delete('stories/:slug')
  @HttpCode(204)
  deleteStory(@Param('slug') slug: string) {
    return this.catalog.deleteStory(slug);
  }
}
