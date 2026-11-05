-- AlterTable
ALTER TABLE "PromoCode" ADD COLUMN     "singleUse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "PromoCode_userId_idx" ON "PromoCode"("userId");
