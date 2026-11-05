-- Reviews written before "verified" existed: verified only when the reviewer had a delivered order with the product.
-- Reviews that came with the seeded catalog (no reviewer account) stay unverified.
UPDATE "Review" r
SET "verified" = true
WHERE r."userId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    WHERE oi."productId" = r."productId" AND o."userId" = r."userId" AND o."status" = 'DELIVERED'
  );
