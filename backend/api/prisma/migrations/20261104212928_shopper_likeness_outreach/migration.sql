-- AlterTable
ALTER TABLE "ShopperProfile" ADD COLUMN     "colors" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "ShopperPreferences" (
    "userId" TEXT NOT NULL,
    "skinTone" INTEGER,
    "undertone" TEXT,
    "toneSource" TEXT,
    "toneUpdatedAt" TIMESTAMP(3),
    "sizes" JSONB NOT NULL DEFAULT '{}',
    "fit" TEXT,
    "marketingEmails" BOOLEAN NOT NULL DEFAULT false,
    "marketingSince" TIMESTAMP(3),
    "emailLang" TEXT NOT NULL DEFAULT 'en',
    "unsubscribeToken" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopperPreferences_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ShopperWant" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "productId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchedProductId" INTEGER,
    "matchedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,

    CONSTRAINT "ShopperWant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outreach" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "subject" TEXT NOT NULL,
    "productIds" INTEGER[],
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "wantIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "decidedBy" TEXT,

    CONSTRAINT "Outreach_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopperPreferences_unsubscribeToken_key" ON "ShopperPreferences"("unsubscribeToken");

-- CreateIndex
CREATE INDEX "ShopperPreferences_marketingEmails_idx" ON "ShopperPreferences"("marketingEmails");

-- CreateIndex
CREATE INDEX "ShopperWant_userId_createdAt_idx" ON "ShopperWant"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopperWant_closedAt_matchedAt_idx" ON "ShopperWant"("closedAt", "matchedAt");

-- CreateIndex
CREATE INDEX "ShopperWant_productId_idx" ON "ShopperWant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Outreach_token_key" ON "Outreach"("token");

-- CreateIndex
CREATE INDEX "Outreach_status_createdAt_idx" ON "Outreach"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Outreach_userId_createdAt_idx" ON "Outreach"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Outreach_kind_status_idx" ON "Outreach"("kind", "status");

-- AddForeignKey
ALTER TABLE "ShopperPreferences" ADD CONSTRAINT "ShopperPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperWant" ADD CONSTRAINT "ShopperWant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outreach" ADD CONSTRAINT "Outreach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
