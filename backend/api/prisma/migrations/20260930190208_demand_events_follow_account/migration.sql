-- DropForeignKey
ALTER TABLE "DemandEvent" DROP CONSTRAINT "DemandEvent_userId_fkey";

-- AddForeignKey
ALTER TABLE "DemandEvent" ADD CONSTRAINT "DemandEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
