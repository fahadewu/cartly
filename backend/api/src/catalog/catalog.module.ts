import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../common/infra.module.js';
import { CatalogCache } from '../common/cache.js';
import { type AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth.js';
import { toProduct, toReview } from '../common/serialize.js';
import { Prisma } from '../generated/prisma/client.js';
import { env, pricing } from '../config.js';
import { AiIndexService } from '../common/ai-index.js';
import { normaliseImage } from '../common/images.js';
import { FITS, refreshFit } from './fit.js';
import { PERSONALITIES } from '../journeys/taste.js';

const list = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value);
const bool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class ProductQuery {
  /** Free-text search across name, label, type and description. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() collection?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsIn(['men', 'women', 'unisex']) gender?: 'men' | 'women' | 'unisex';
  @IsOptional() @Type(() => Number) @IsNumber() minPrice?: number;
  @IsOptional() @Type(() => Number) @IsNumber() maxPrice?: number;
  /** Comma-separated sizes, e.g. "M,L" or "42,43". */
  @IsOptional() @Transform(list) @IsString({ each: true }) sizes?: string[];
  /** Comma-separated colour names, e.g. "Black,Scarlet". */
  @IsOptional() @Transform(list) @IsString({ each: true }) colors?: string[];
  @IsOptional() @Transform(bool) @IsBoolean() sale?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() isNew?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() tryOn?: boolean;
  @IsOptional() @IsIn(['featured', 'popular', 'newest', 'rating', 'price-asc', 'price-desc']) sort?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) limit?: number;
}

export class CreateReviewDto {
  @IsInt() @Min(1) @Max(5) rating: number;
  @IsOptional() @IsString() @MaxLength(60) title?: string;
  @IsString() @MinLength(10) @MaxLength(600) text: string;
  /** The size they bought (one of the product's sizes). */
  @IsOptional() @IsString() @MaxLength(12) size?: string;
  /** How it fit them. */
  @IsOptional() @IsIn([...FITS]) fit?: (typeof FITS)[number];
  @IsOptional() @IsInt() @Min(100) @Max(230) heightCm?: number;
  /** The size they usually wear, so shoppers like them can compare. */
  @IsOptional() @IsString() @MaxLength(12) usualSize?: string;
  /** URLs from POST /reviews/photos. */
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsString({ each: true }) photos?: string[];
}

/** Review photos: up to 3 per review, 10 uploads a minute per shopper. */
const REVIEW_PHOTO_DIR = 'reviews';
const reviewPhotoUrl = (name: string) => `${env.publicUrl}/api/v1/uploads/${REVIEW_PHOTO_DIR}/${name}`;
const REVIEW_PHOTO_NAME = /^[0-9a-f-]{36}\.(jpg|png)$/;
const isReviewPhoto = (url: string) => url.startsWith(reviewPhotoUrl('')) && REVIEW_PHOTO_NAME.test(url.slice(reviewPhotoUrl('').length));
/** Deletes a removed review's photos from disk (only files this API stored itself). */
export async function deleteReviewPhotos(urls: string[]) {
  for (const url of urls.filter(isReviewPhoto)) await rm(path.join(env.uploadDir, REVIEW_PHOTO_DIR, url.slice(reviewPhotoUrl('').length)), { force: true }).catch(() => undefined);
}

// How long an instance may serve its copy (admin edits and reviews reload it at once; see CatalogCache).
const FRESH_MS = 30_000;
// Shared caches (a CDN in front of the API) may keep public catalog reads briefly; browsers revalidate
// every time (cheap: ETag, so an unchanged catalog is a 304 with no body).
const PUBLIC = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';

const ORDER: Record<string, Prisma.ProductOrderByWithRelationInput[]> = {
  featured: [{ id: 'asc' }],
  popular: [{ popularity: 'desc' }],
  newest: [{ isNew: 'desc' }, { id: 'desc' }],
  rating: [{ rating: 'desc' }],
  'price-asc': [{ price: 'asc' }],
  'price-desc': [{ price: 'desc' }],
};

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: PrismaService,
    private readonly cache: CatalogCache,
    private readonly index: AiIndexService,
  ) {}

  where(q: ProductQuery): Prisma.ProductWhereInput {
    const and: Prisma.ProductWhereInput[] = [{ active: true }];
    if (q.q) {
      const term = q.q.trim();
      and.push({
        OR: [
          ...['name', 'label', 'type', 'description', 'material'].map((f) => ({ [f]: { contains: term, mode: 'insensitive' } })),
          { keywords: { has: term.toLowerCase() } },
          { styleTags: { has: term.toLowerCase() } },
        ],
      });
    }
    if (q.category) and.push({ categorySlug: q.category });
    if (q.collection) and.push(q.collection === 'offers' ? { compareAt: { not: null } } : { collections: { has: q.collection } });
    if (q.type) and.push({ type: q.type });
    // "men" also includes unisex pieces, like the storefront.
    if (q.gender) and.push({ gender: q.gender === 'unisex' ? 'unisex' : { in: [q.gender, 'unisex'] } });
    if (q.minPrice != null || q.maxPrice != null) and.push({ price: { gte: q.minPrice, lte: q.maxPrice } });
    if (q.sizes?.length) and.push({ sizes: { hasSome: q.sizes } });
    if (q.colors?.length) and.push({ OR: q.colors.map((name) => ({ colors: { array_contains: [{ name }] } })) });
    if (q.sale) and.push({ compareAt: { not: null } });
    if (q.isNew) and.push({ isNew: true });
    if (q.tryOn) and.push({ tryOnSlot: { not: null } });
    return { AND: and };
  }

  list(q: ProductQuery) {
    return this.cache.get(`list:${JSON.stringify(q)}`, FRESH_MS, () => this.query(q));
  }

  private async query(q: ProductQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 24;
    const where = this.where(q);
    const [items, total] = await Promise.all([
      this.db.product.findMany({ where, orderBy: ORDER[q.sort ?? 'featured'], skip: (page - 1) * limit, take: limit }),
      this.db.product.count({ where }),
    ]);
    return { items: items.map(toProduct), total, page, limit, pages: Math.ceil(total / limit) };
  }

  product(idOrSlug: string) {
    return this.cache.get(`product:${idOrSlug}`, FRESH_MS, () => this.loadProduct(idOrSlug));
  }

  /** The return window the store enforces (Admin → Returns → Settings), so pages promise what the store keeps. */
  private async returnsDays() {
    const row = await this.db.storeSetting.findUnique({ where: { key: 'returnWindowDays' } });
    const n = Number(row?.value);
    return row && Number.isFinite(n) && n >= 0 ? n : 7;
  }

  private async loadProduct(idOrSlug: string) {
    const where = /^\d+$/.test(idOrSlug) ? { id: Number(idOrSlug) } : { slug: idOrSlug };
    const p = await this.db.product.findUnique({ where, include: { category: true } });
    if (!p?.active) throw new NotFoundException('Product not found.');
    const [reviews, related, returnsDays, stars] = await Promise.all([
      this.db.review.findMany({ where: { productId: p.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.related(p.id),
      this.returnsDays(),
      this.db.review.groupBy({ by: ['rating'], where: { productId: p.id }, _count: { _all: true } }),
    ]);
    return {
      ...toProduct(p),
      categoryTitle: p.category.title,
      details: pricing.typeDetails[p.type]?.details ?? [],
      care: pricing.typeDetails[p.type]?.care ?? [],
      delivery: { freeShippingOver: pricing.freeShippingOver, options: pricing.shipping, returnsDays },
      reviews: reviews.map(toReview),
      /** How many written reviews gave each star rating (real counts, 5 → 1). */
      ratingCounts: [5, 4, 3, 2, 1].map((n) => stars.find((x) => x.rating === n)?._count._all ?? 0),
      related,
    };
  }

  async related(id: number, take = 4) {
    const p = await this.db.product.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Product not found.');
    const items = await this.db.product.findMany({
      where: { id: { not: id }, active: true, OR: [{ type: p.type }, { categorySlug: p.categorySlug }] },
      orderBy: [{ popularity: 'desc' }],
      take: 20,
    });
    return items
      .sort((a, b) => Number(b.type === p.type) - Number(a.type === p.type))
      .slice(0, take)
      .map(toProduct);
  }

  /** Semantic search through the AI service; falls back to keyword search if it's unavailable. */
  async semantic(q: string, limit = 12) {
    try {
      const res = await fetch(`${env.aiServiceUrl}/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) throw new Error(`AI service ${res.status}`);
      const body = (await res.json()) as { results: { id: number; score: number }[] };
      const ids = body.results.map((r) => r.id);
      const products = await this.db.product.findMany({ where: { id: { in: ids }, active: true } });
      const byId = new Map(products.map((p) => [p.id, p]));
      return {
        engine: 'semantic' as const,
        items: body.results.filter((r) => byId.has(r.id)).map((r) => ({ ...toProduct(byId.get(r.id)!), score: r.score })),
      };
    } catch {
      const { items } = await this.list({ q, limit, sort: 'popular' });
      return { engine: 'keyword' as const, items };
    }
  }

  reviews(productId: number, page = 1) {
    return this.cache.get(`reviews:${productId}:${page}`, FRESH_MS, () => this.loadReviews(productId, page));
  }

  private async loadReviews(productId: number, page: number) {
    const take = 10;
    const [items, total] = await Promise.all([
      this.db.review.findMany({ where: { productId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take }),
      this.db.review.count({ where: { productId } }),
    ]);
    return { items: items.map(toReview), total, page };
  }

  async addReview(user: AuthUser, productId: number, dto: CreateReviewDto) {
    const [product, author] = await Promise.all([
      this.db.product.findUnique({ where: { id: productId } }),
      this.db.user.findUniqueOrThrow({ where: { id: user.id } }),
    ]);
    if (!product?.active) throw new NotFoundException('Product not found.');
    const size = dto.size ? product.sizes.find((s) => s.toLowerCase() === dto.size!.trim().toLowerCase()) : undefined;
    if (dto.size && !size) throw new BadRequestException(`Pick the size you bought: ${product.sizes.join(', ')}.`);
    const photos = [...new Set(dto.photos ?? [])];
    if (!photos.every(isReviewPhoto)) throw new BadRequestException('Add photos with the photo button, then post your review.');
    // "Verified" means they had this product delivered to them, not just that they're signed in.
    const verified = !!(await this.db.orderItem.findFirst({
      where: { productId, order: { userId: user.id, status: 'DELIVERED' } },
      select: { id: true },
    }));
    const newCount = product.reviewCount + 1;
    const [review] = await this.db.$transaction([
      this.db.review.create({
        data: {
          productId,
          userId: user.id,
          author: author.name,
          rating: dto.rating,
          title: dto.title?.trim() || 'My review',
          text: dto.text.trim(),
          size: size ?? null,
          fit: dto.fit ?? null,
          heightCm: dto.heightCm ?? null,
          usualSize: dto.usualSize?.trim() || null,
          photos,
          verified,
        },
      }),
      this.db.product.update({
        where: { id: productId },
        data: { reviewCount: newCount, rating: Math.round(((product.rating * product.reviewCount + dto.rating) / newCount) * 10) / 10 },
      }),
    ]);
    // A fit review can tip the product's "runs small" verdict, which Pip's catalog shows too.
    if (dto.fit && (await refreshFit(this.db, [productId])).verdictChanged.length) this.index.reindexSoon();
    // The shopper's product page reloads right after this; every instance must show the new review.
    await this.cache.bump();
    return toReview(review);
  }

  /** Stores one review photo (EXIF and location stripped, long side capped) and returns its URL. */
  async addReviewPhoto(file: Express.Multer.File | undefined) {
    if (!file?.size) throw new BadRequestException('Choose a photo to upload.');
    const img = await normaliseImage(file.buffer, 1600);
    const name = `${randomUUID()}.${img.ext}`;
    const dir = path.join(env.uploadDir, REVIEW_PHOTO_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), img.data);
    return { url: reviewPhotoUrl(name), width: img.width, height: img.height };
  }

  /**
   * Everything the storefront needs to render in one request: every product on
   * sale plus categories, collections, stories and the delivery rules.
   */
  bootstrap() {
    return this.cache.get('bootstrap', FRESH_MS, () => this.loadBootstrap());
  }

  private async loadBootstrap() {
    const [products, categories, collections, stories, returnsDays] = await Promise.all([
      this.db.product.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
      this.db.category.findMany({ orderBy: { slug: 'asc' } }),
      this.db.collection.findMany({ orderBy: { slug: 'asc' } }),
      this.db.story.findMany({ orderBy: { createdAt: 'asc' } }),
      this.returnsDays(),
    ]);
    const live = new Set(products.map((p) => p.id));
    return {
      products: products.map(toProduct),
      categories,
      collections,
      stories: stories.map((s) => ({ ...s, productIds: s.productIds.filter((id) => live.has(id)) })),
      delivery: { freeShippingOver: pricing.freeShippingOver, options: pricing.shipping, returnsDays },
      typeDetails: pricing.typeDetails,
      /** The shopping styles the taste model knows, for the storefront's style quiz. */
      styles: Object.entries(PERSONALITIES).map(([key, s]) => ({ key, label: s.label, tags: s.tags })),
    };
  }

  categories() {
    return this.cache.get('categories', FRESH_MS, () =>
      this.db.category.findMany({ include: { _count: { select: { products: { where: { active: true } } } } } }),
    );
  }
  async category(slug: string, q: ProductQuery) {
    const c = await this.cache.get(`category:${slug}`, FRESH_MS, () => this.db.category.findUnique({ where: { slug } }));
    if (!c) throw new NotFoundException('Category not found.');
    return { ...c, products: await this.list({ ...q, category: slug }) };
  }
  collections() {
    return this.cache.get('collections', FRESH_MS, () => this.db.collection.findMany());
  }
  async collection(slug: string, q: ProductQuery) {
    const c = await this.cache.get(`collection:${slug}`, FRESH_MS, () => this.db.collection.findUnique({ where: { slug } }));
    if (!c) throw new NotFoundException('Collection not found.');
    return { ...c, products: await this.list({ ...q, collection: slug }) };
  }
  stories() {
    return this.cache.get('stories', FRESH_MS, () => this.db.story.findMany({ orderBy: { createdAt: 'asc' } }));
  }
  story(slug: string) {
    return this.cache.get(`story:${slug}`, FRESH_MS, () => this.loadStory(slug));
  }
  private async loadStory(slug: string) {
    const s = await this.db.story.findUnique({ where: { slug } });
    if (!s) throw new NotFoundException('Story not found.');
    const products = await this.db.product.findMany({ where: { id: { in: s.productIds }, active: true } });
    const order = new Map(s.productIds.map((id, i) => [id, i]));
    return { ...s, products: products.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map(toProduct) };
  }
}

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** Storefront bootstrap: the full live catalog and delivery rules. */
  @Get('catalog')
  @Header('Cache-Control', PUBLIC)
  bootstrap() {
    return this.catalog.bootstrap();
  }

  @Get('products')
  @Header('Cache-Control', PUBLIC)
  list(@Query() q: ProductQuery) {
    return this.catalog.list(q);
  }

  /** Natural-language search, e.g. "red summer dress under $50". */
  @Get('products/search')
  @Header('Cache-Control', PUBLIC)
  search(@Query('q') q = '', @Query('limit') limit?: string) {
    return this.catalog.semantic(q, Math.min(Number(limit) || 12, 40));
  }

  @Get('products/:idOrSlug')
  product(@Param('idOrSlug') idOrSlug: string) {
    return this.catalog.product(idOrSlug);
  }

  @Get('products/:id/related')
  related(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.related(id);
  }

  @Get('products/:id/reviews')
  reviews(@Param('id', ParseIntPipe) id: number, @Query('page') page?: string) {
    return this.catalog.reviews(id, Math.max(1, Number(page) || 1));
  }

  @Post('products/:id/reviews')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  addReview(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CreateReviewDto) {
    return this.catalog.addReview(user, id, dto);
  }

  @Post('reviews/photos')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024, files: 1 } }))
  addReviewPhoto(@UploadedFile() file: Express.Multer.File | undefined) {
    return this.catalog.addReviewPhoto(file);
  }

  @Get('categories')
  @Header('Cache-Control', PUBLIC)
  categories() {
    return this.catalog.categories();
  }
  @Get('categories/:slug')
  @Header('Cache-Control', PUBLIC)
  category(@Param('slug') slug: string, @Query() q: ProductQuery) {
    return this.catalog.category(slug, q);
  }
  @Get('collections')
  @Header('Cache-Control', PUBLIC)
  collections() {
    return this.catalog.collections();
  }
  @Get('collections/:slug')
  @Header('Cache-Control', PUBLIC)
  collection(@Param('slug') slug: string, @Query() q: ProductQuery) {
    return this.catalog.collection(slug, q);
  }
  @Get('stories')
  @Header('Cache-Control', PUBLIC)
  stories() {
    return this.catalog.stories();
  }
  @Get('stories/:slug')
  @Header('Cache-Control', PUBLIC)
  story(@Param('slug') slug: string) {
    return this.catalog.story(slug);
  }
}

@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
