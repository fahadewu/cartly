-- AlterTable
ALTER TABLE "User" ADD COLUMN     "personalise" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "userId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "landing" TEXT NOT NULL,
    "exitPath" TEXT,
    "referrer" TEXT,
    "source" TEXT NOT NULL,
    "medium" TEXT,
    "campaign" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "geoSource" TEXT,
    "timeZone" TEXT,
    "locale" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "activeMs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageView" (
    "visitId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL,
    "activeMs" INTEGER NOT NULL DEFAULT 0,
    "scrollPct" INTEGER,

    CONSTRAINT "PageView_pkey" PRIMARY KEY ("visitId","seq")
);

-- CreateTable
CREATE TABLE "ShopperProfile" (
    "userId" TEXT NOT NULL,
    "personality" TEXT,
    "styles" JSONB NOT NULL,
    "tags" JSONB NOT NULL,
    "categories" JSONB NOT NULL,
    "genders" JSONB NOT NULL DEFAULT '{}',
    "priceRatio" DOUBLE PRECISION,
    "priceBand" TEXT,
    "traits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ageGroup" TEXT,
    "ageConfidence" DOUBLE PRECISION,
    "evidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopperProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "Visit_startedAt_idx" ON "Visit"("startedAt");

-- CreateIndex
CREATE INDEX "Visit_userId_startedAt_idx" ON "Visit"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "Visit_visitorId_idx" ON "Visit"("visitorId");

-- CreateIndex
CREATE INDEX "PageView_enteredAt_idx" ON "PageView"("enteredAt");

-- CreateIndex
CREATE INDEX "PageView_route_enteredAt_idx" ON "PageView"("route", "enteredAt");

-- CreateIndex
CREATE INDEX "ShopperProfile_personality_idx" ON "ShopperProfile"("personality");

-- CreateIndex
CREATE INDEX "ShopperProfile_ageGroup_idx" ON "ShopperProfile"("ageGroup");

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageView" ADD CONSTRAINT "PageView_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperProfile" ADD CONSTRAINT "ShopperProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
