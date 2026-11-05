// Product import and export (Admin → Products → Import / Export, or `npm run catalog:import` / `catalog:export`).
// An import is always checked first (`apply` false): the answer lists, row by row, what would be created,
// updated or skipped and why. Applying it saves through the same rules as the product editor. Products that
// lack what Pip needs to recommend them (material, occasions, seasons, style tags, features) come in hidden,
// to finish in the editor, where "Suggest with AI" drafts those details from the photo.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { IsBooleanString, IsIn, IsOptional, IsString, validate, type ValidationError } from 'class-validator';
import type { Response } from 'express';
import { Staff } from '../common/auth.js';
import { CatalogCache } from '../common/cache.js';
import { PrismaService } from '../common/infra.module.js';
import { detailGaps, listOf } from '../common/product-details.js';
import type { Product } from '../generated/prisma/client.js';
import { AiIndexService } from '../common/ai-index.js';
import { AdminCatalogService, ProductDto, TRY_ON_SLOTS, UpdateProductDto } from './catalog.js';
import { COLUMNS, EXAMPLE, productRow, readProducts, toCsv, type Defaults, type Draft, type Format } from './import-csv.js';

export type ImportRow = {
  line: number;
  name: string;
  action: 'create' | 'update' | 'skip';
  id?: number;
  slug?: string;
  /** Imported, but hidden from the store until Pip's details are filled in. */
  hidden: boolean;
  warnings: string[];
  errors: string[];
};
export type ImportResult = {
  format: Format;
  applied: boolean;
  total: number;
  create: number;
  update: number;
  skip: number;
  hidden: number;
  rows: ImportRow[];
};

export class ImportOptionsDto {
  /** "true" saves; anything else only checks. */
  @IsOptional() @IsBooleanString() apply?: string;
  /** For rows whose kind of product can't be told from the file. */
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsIn(['men', 'women', 'unisex']) gender?: string;
}

/** What a new product can't be added without, in the words the admin panel uses. */
const REQUIRED: Record<string, string> = {
  name: 'the name',
  description: 'a description of at least 40 characters (Pip describes the product from it)',
  category: 'the category',
  type: 'the type',
  gender: 'who it’s for (men, women or unisex)',
  label: 'a label (the small text on the product card)',
  price: 'the price',
  stock: 'the stock count',
  image: 'a photo (image URL)',
  colors: 'at least one colour',
  sizes: 'at least one size',
};
/** One message per field: "Missing …" when it's absent, else the first rule it breaks. */
const messages = (errors: ValidationError[]): string[] =>
  errors.flatMap((e) => {
    if (e.value === undefined && REQUIRED[e.property]) return [`Missing ${REQUIRED[e.property]}.`];
    const own = Object.values(e.constraints ?? {});
    return [...own.slice(0, 1), ...messages(e.children ?? [])];
  });

@Injectable()
export class ProductImportService {
  constructor(
    private readonly db: PrismaService,
    private readonly catalog: AdminCatalogService,
    private readonly index: AiIndexService,
    private readonly cache: CatalogCache,
  ) {}

  async run(text: string, opts: Defaults & { apply?: boolean }): Promise<ImportResult> {
    const categories = await this.db.category.findMany({ select: { slug: true, title: true, types: true } });
    const defaults = this.defaults(opts, categories);
    let read: ReturnType<typeof readProducts>;
    try {
      read = readProducts(text, categories, defaults);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const ids = read.drafts.map((d) => d.id).filter((x): x is number => x !== undefined);
    const slugs = read.drafts.map((d) => d.slug).filter((x): x is string => !!x);
    const existing = await this.db.product.findMany({ where: { OR: [{ id: { in: ids } }, { slug: { in: slugs } }] } });
    const byId = new Map(existing.map((p) => [p.id, p]));
    const bySlug = new Map(existing.map((p) => [p.slug, p]));
    const collections = new Set((await this.db.collection.findMany({ select: { slug: true } })).map((c) => c.slug));
    const productIds = new Set((await this.db.product.findMany({ select: { id: true } })).map((p) => p.id));

    const rows: ImportRow[] = [];
    const work: { row: ImportRow; dto: ProductDto | UpdateProductDto }[] = [];
    for (const d of read.drafts) {
      const current = (d.id !== undefined ? byId.get(d.id) : undefined) ?? (d.slug ? bySlug.get(d.slug) : undefined);
      if (d.id !== undefined && !byId.has(d.id) && !d.errors.length) d.warnings.push(`ID ${d.id} isn’t in this store: ${current ? 'matched by its slug' : 'added as a new product'}.`);
      const row: ImportRow = {
        line: d.line,
        name: d.name || current?.name || '',
        action: current ? 'update' : 'create',
        id: current?.id,
        slug: current?.slug ?? d.slug,
        hidden: false,
        warnings: d.warnings,
        errors: d.errors,
      };
      rows.push(row);
      if (!current && !d.data.name) row.errors.push(d.id !== undefined || d.slug ? 'No product with this ID or slug, and no name to add it as a new one.' : 'No name.');
      if (!row.errors.length) {
        const dto = await this.check(d, row, current, { categories, collections, productIds, bySlug });
        if (dto) work.push({ row, dto });
      }
      if (row.errors.length) row.action = 'skip';
    }

    if (opts.apply) {
      for (const { row, dto } of work) {
        try {
          const saved = row.action === 'create' ? await this.catalog.createProduct(dto as ProductDto) : await this.catalog.updateProduct(row.id!, dto);
          row.id = saved.id as number;
          row.slug = saved.slug as string;
        } catch (e) {
          row.errors.push((e as Error).message);
          row.action = 'skip';
          row.hidden = false;
        }
      }
      if (work.length) {
        await this.cache.bump().catch(() => undefined);
        // Search and Pip see the new products straight away (and only one rebuild for the whole file).
        await this.index.rebuildNow().catch(() => undefined);
      }
    }
    const n = (a: ImportRow['action']) => rows.filter((r) => r.action === a).length;
    return {
      format: read.format,
      applied: !!opts.apply,
      total: rows.length,
      create: n('create'),
      update: n('update'),
      skip: n('skip'),
      hidden: rows.filter((r) => r.action !== 'skip' && r.hidden).length,
      rows,
    };
  }

  /** The product editor's rules, row by row, so a check reports every problem and saving rarely fails. */
  private async check(
    d: Draft,
    row: ImportRow,
    current: Product | undefined,
    ctx: {
      categories: { slug: string; title: string; types: string[] }[];
      collections: Set<string>;
      productIds: Set<number>;
      bySlug: Map<string, Product>;
    },
  ) {
    const data = { ...d.data };
    if (data.tryOnSlot && !TRY_ON_SLOTS.includes(data.tryOnSlot as string)) {
      row.warnings.push(`Try-on slot “${data.tryOnSlot}” isn’t one of ${TRY_ON_SLOTS.join(', ')}: left out.`);
      delete data.tryOnSlot;
    }
    if (Array.isArray(data.collections)) {
      const unknown = (data.collections as string[]).filter((c) => !ctx.collections.has(c));
      if (unknown.length) row.warnings.push(`Unknown collection ${unknown.join(', ')}: left out.`);
      data.collections = (data.collections as string[]).filter((c) => ctx.collections.has(c));
    }
    if (Array.isArray(data.pairsWith)) {
      const kept = (data.pairsWith as number[]).filter((id) => ctx.productIds.has(id) && id !== current?.id);
      if (kept.length < (data.pairsWith as number[]).length) row.warnings.push('“Goes well with” lists products this store doesn’t have: left out.');
      data.pairsWith = kept.slice(0, 6);
    }
    if (current && data.slug === current.slug) delete data.slug;
    if (data.slug && ctx.bySlug.has(data.slug as string) && ctx.bySlug.get(data.slug as string)!.id !== current?.id) {
      row.errors.push(`Another product already uses the slug “${data.slug}”.`);
    }

    // The whole product as it would be saved, to see what Pip would still be missing.
    const merged = {
      ...(current ?? {}),
      ...data,
      categorySlug: (data.category as string) ?? current?.categorySlug,
    } as unknown as Product;
    const category = ctx.categories.find((c) => c.slug === merged.categorySlug);
    if (!category) row.errors.push(current ? 'Unknown category.' : 'No category: add a category column, or choose one for such rows.');
    else if (merged.type && !category.types.includes(merged.type)) row.errors.push(`${category.title} products must be one of: ${category.types.join(', ')} (not “${merged.type}”).`);
    const price = Number(merged.price);
    if (merged.compareAt != null && Number(merged.compareAt) <= price) {
      row.warnings.push('“Compare at” isn’t above the price: no sale price.');
      data.compareAt = null;
    }
    const { required } = detailGaps(merged);
    if (required.length && merged.active !== false) {
      data.active = false;
      row.hidden = true;
      row.warnings.push(`Hidden until it has ${listOf(required)}. Finish it in the product editor (“Suggest with AI” drafts the details).`);
    }

    const dto = plainToInstance(current ? UpdateProductDto : ProductDto, data);
    const invalid = messages(await validate(dto, { whitelist: true, forbidNonWhitelisted: true }));
    row.errors.push(...invalid);
    if (row.errors.length) row.hidden = false;
    return row.errors.length ? null : dto;
  }

  private defaults(opts: Defaults, categories: { slug: string; types: string[] }[]): Defaults {
    if (opts.category && !categories.some((c) => c.slug === opts.category)) throw new BadRequestException(`Unknown category “${opts.category}”.`);
    if (opts.type) {
      const types = categories.filter((c) => !opts.category || c.slug === opts.category).flatMap((c) => c.types);
      const t = types.find((x) => x.toLowerCase() === opts.type!.toLowerCase());
      if (!t) throw new BadRequestException(`Type must be one of: ${types.join(', ')}.`);
      opts = { ...opts, type: t };
    }
    return opts;
  }

  /** Every product (archived ones too) in Cartly's columns; `template` gives the header and one example. */
  async exportCsv(template = false) {
    const products = template ? [EXAMPLE] : await this.db.product.findMany({ orderBy: { id: 'asc' } });
    return toCsv([[...COLUMNS], ...products.map((p) => productRow(p as unknown as Record<string, unknown>))]);
  }
}

@ApiTags('admin')
@Staff('catalog')
@Controller('admin/catalog')
export class AdminImportController {
  constructor(private readonly imports: ProductImportService) {}

  /** CSV of every product (?template=true: the columns and an example row). */
  @Get('export')
  async export(@Query('template') template: string | undefined, @Res({ passthrough: true }) res: Response) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${template === 'true' ? 'cartly-products-template' : `cartly-products-${day}`}.csv"`);
    return this.imports.exportCsv(template === 'true');
  }

  /** Multipart `file` (CSV). Checks only, unless `apply=true`. */
  @Post('import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  import(@UploadedFile() file: Express.Multer.File | undefined, @Body() dto: ImportOptionsDto) {
    if (!file) throw new BadRequestException('Attach the CSV file as `file`.');
    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) throw new BadRequestException('That isn’t a CSV file. In Excel or Numbers, use File → Save As / Export → CSV.');
    return this.imports.run(text, { apply: dto.apply === 'true', category: dto.category, type: dto.type, gender: dto.gender });
  }
}
