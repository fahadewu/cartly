-- CreateIndex
CREATE INDEX "DemandEvent_userId_createdAt_idx" ON "DemandEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "ProductRequest_userId_createdAt_idx" ON "ProductRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnItem_returnId_idx" ON "ReturnItem"("returnId");

-- CreateIndex
CREATE INDEX "Review_userId_idx" ON "Review"("userId");

-- CreateIndex
CREATE INDEX "Shipment_returnId_idx" ON "Shipment"("returnId");
