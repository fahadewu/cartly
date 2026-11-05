-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'PENDING_PAYMENT';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "amountBdt" DECIMAL(12,2),
ADD COLUMN     "exchangeRate" DECIMAL(10,4),
ADD COLUMN     "paymentMethod" TEXT NOT NULL DEFAULT 'demo',
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PAID',
ALTER COLUMN "cardLast4" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "careNotes" TEXT,
ADD COLUMN     "features" TEXT[],
ADD COLUMN     "fit" TEXT,
ADD COLUMN     "fitNotes" TEXT,
ADD COLUMN     "keywords" TEXT[],
ADD COLUMN     "material" TEXT,
ADD COLUMN     "occasions" TEXT[],
ADD COLUMN     "pairsWith" INTEGER[],
ADD COLUMN     "seasons" TEXT[],
ADD COLUMN     "styleTags" TEXT[];

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "invoice" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "reference" TEXT,
    "trxId" TEXT,
    "refunded" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "error" TEXT,
    "log" JSONB NOT NULL DEFAULT '[]',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentGateway" (
    "id" TEXT NOT NULL,
    "live" BOOLEAN NOT NULL DEFAULT false,
    "secrets" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_invoice_key" ON "Payment"("invoice");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_paymentStatus_idx" ON "Order"("paymentStatus");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
