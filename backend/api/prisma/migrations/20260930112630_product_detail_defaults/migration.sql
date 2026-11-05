-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "features" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "keywords" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "occasions" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "pairsWith" SET DEFAULT ARRAY[]::INTEGER[],
ALTER COLUMN "seasons" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "styleTags" SET DEFAULT ARRAY[]::TEXT[];

-- Existing products: empty lists rather than NULL.
UPDATE "Product" SET "occasions" = DEFAULT WHERE "occasions" IS NULL;
UPDATE "Product" SET "seasons" = DEFAULT WHERE "seasons" IS NULL;
UPDATE "Product" SET "styleTags" = DEFAULT WHERE "styleTags" IS NULL;
UPDATE "Product" SET "features" = DEFAULT WHERE "features" IS NULL;
UPDATE "Product" SET "keywords" = DEFAULT WHERE "keywords" IS NULL;
UPDATE "Product" SET "pairsWith" = DEFAULT WHERE "pairsWith" IS NULL;
