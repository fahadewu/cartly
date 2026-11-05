-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "fitVerdict" TEXT,
ADD COLUMN     "fitVotes" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "fit" TEXT,
ADD COLUMN     "heightCm" INTEGER,
ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "size" TEXT,
ADD COLUMN     "usualSize" TEXT,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false;
