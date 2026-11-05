-- AlterTable
ALTER TABLE "ShopperPreferences" ADD COLUMN     "styles" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stylesAt" TIMESTAMP(3);
