-- Orders created before PaymentIntent existed may carry a paid/fulfilled
-- status without any durable financial proof. They must never be sourced
-- automatically merely because the Order.status string says PAID.
UPDATE "Order" AS o
SET "needsManualReview" = true
WHERE o."status" IN (
  'PAID',
  'SOURCING',
  'SOURCING_FAILED',
  'SOURCED',
  'SHIPPED',
  'DELIVERED'
)
AND NOT EXISTS (
  SELECT 1
  FROM "PaymentIntent" AS p
  WHERE p."orderId" = o."id"
    AND p."status" IN ('PAID', 'REFUNDED')
);

-- A paid intent attached to a cancelled or still-unpaid order represents a
-- reconciliation/refund incident, not an order safe for automatic handling.
UPDATE "Order" AS o
SET "needsManualReview" = true
WHERE o."status" IN ('PENDING_PAYMENT', 'CANCELLED')
AND EXISTS (
  SELECT 1
  FROM "PaymentIntent" AS p
  WHERE p."orderId" = o."id"
    AND p."status" = 'PAID'
);

-- Financial amounts reaching persistence must be strictly positive where a
-- zero would mean a free/invalid sale. Shipping and VAT may legitimately be 0.
ALTER TABLE "ProductSku"
  DROP CONSTRAINT "ProductSku_prices_nonnegative",
  ADD CONSTRAINT "ProductSku_prices_positive" CHECK (
    "sourcePrice" > 0 AND ("bulkPrice" IS NULL OR "bulkPrice" > 0)
  );

ALTER TABLE "OrderItem"
  DROP CONSTRAINT "OrderItem_prices_nonnegative",
  ADD CONSTRAINT "OrderItem_prices_positive" CHECK (
    "unitPriceSar" > 0 AND "unitCostSource" > 0
  );

ALTER TABLE "Order"
  DROP CONSTRAINT "Order_amounts_nonnegative",
  ADD CONSTRAINT "Order_amounts_valid" CHECK (
    "subtotalSar" > 0 AND "shippingSar" >= 0 AND "vatSar" >= 0
    AND "totalSar" > 0 AND "costSubtotal" > 0 AND "costShipping" >= 0
    AND "fxRateUsed" >= 1 AND "fxRateUsed" <= 15
  );

ALTER TABLE "Product"
  DROP CONSTRAINT "Product_margin_nonnegative",
  ADD CONSTRAINT "Product_margin_range" CHECK (
    "marginPercent" IS NULL OR ("marginPercent" >= 0 AND "marginPercent" <= 200)
  );

ALTER TABLE "FxRate"
  DROP CONSTRAINT "FxRate_rate_positive",
  ADD CONSTRAINT "FxRate_rate_range" CHECK ("rate" >= 1 AND "rate" <= 10);

-- Retention and cron predicates are attacker-influenced and must not degrade
-- into full-table scans as authentication/API history grows.
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");
CREATE INDEX "verification_expiresAt_idx" ON "verification"("expiresAt");
CREATE INDEX "rateLimit_lastRequest_idx" ON "rateLimit"("lastRequest");
CREATE INDEX "Order_guestAccessExpiresAt_idx" ON "Order"("guestAccessExpiresAt");
CREATE INDEX "AeOrder_lastPolledAt_idx" ON "AeOrder"("lastPolledAt");
CREATE INDEX "AeApiLog_createdAt_idx" ON "AeApiLog"("createdAt");
CREATE INDEX "PaymentIntent_status_expiresAt_idx"
  ON "PaymentIntent"("status", "expiresAt");
CREATE INDEX "PaymentIntent_status_paidAt_idx"
  ON "PaymentIntent"("status", "paidAt");
