-- Shared Better Auth rate-limit state. This must be durable so every process
-- observes the same counters (memory-only counters are bypassed by hopping
-- between serverless instances).
CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL,
  CONSTRAINT "rateLimit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rateLimit_count_nonnegative" CHECK ("count" >= 0),
  CONSTRAINT "rateLimit_last_request_nonnegative" CHECK ("lastRequest" >= 0)
);

CREATE UNIQUE INDEX "rateLimit_key_key" ON "rateLimit"("key");

-- Checkout replay protection and revocable per-order guest capabilities.
ALTER TABLE "Order"
  ADD COLUMN "checkoutKeyHash" TEXT,
  ADD COLUMN "guestAccessHash" TEXT,
  ADD COLUMN "guestAccessExpiresAt" TIMESTAMP(3),
  ADD CONSTRAINT "Order_guest_access_pair" CHECK (
    ("guestAccessHash" IS NULL AND "guestAccessExpiresAt" IS NULL)
    OR ("guestAccessHash" IS NOT NULL AND "guestAccessExpiresAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "Order_registered_user_no_guest_capability" CHECK (
    "userId" IS NULL OR "guestAccessHash" IS NULL
  ),
  ADD CONSTRAINT "Order_amounts_nonnegative" CHECK (
    "subtotalSar" >= 0 AND "shippingSar" >= 0 AND "vatSar" >= 0
    AND "totalSar" >= 0 AND "costSubtotal" >= 0 AND "costShipping" >= 0
    AND "fxRateUsed" > 0
  );

CREATE UNIQUE INDEX "Order_checkoutKeyHash_key" ON "Order"("checkoutKeyHash");
CREATE UNIQUE INDEX "Order_guestAccessHash_key" ON "Order"("guestAccessHash");

-- Exactly one default address per account, even under concurrent requests.
CREATE UNIQUE INDEX "one_default_address_per_user"
  ON "Address"("userId")
  WHERE "isDefault" = true;

-- Database-level invariants: validation at the HTTP boundary is useful, but
-- background jobs, admin scripts, and future code paths must not bypass the
-- same financial/inventory limits.
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_rating_range" CHECK (
    "rating" IS NULL OR ("rating" >= 0 AND "rating" <= 5)
  ),
  ADD CONSTRAINT "Product_orders_count_nonnegative" CHECK ("ordersCount" >= 0),
  ADD CONSTRAINT "Product_margin_nonnegative" CHECK (
    "marginPercent" IS NULL OR "marginPercent" >= 0
  );

ALTER TABLE "ProductSku"
  ADD CONSTRAINT "ProductSku_prices_nonnegative" CHECK (
    "sourcePrice" >= 0 AND ("bulkPrice" IS NULL OR "bulkPrice" >= 0)
  ),
  ADD CONSTRAINT "ProductSku_stock_nonnegative" CHECK ("stock" >= 0),
  ADD CONSTRAINT "ProductSku_bulk_quantity_positive" CHECK (
    "bulkMinQty" IS NULL OR "bulkMinQty" > 0
  );

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_quantity_range" CHECK (
    "quantity" >= 1 AND "quantity" <= 50
  ),
  ADD CONSTRAINT "OrderItem_prices_nonnegative" CHECK (
    "unitPriceSar" >= 0 AND "unitCostSource" >= 0
  ),
  ADD CONSTRAINT "OrderItem_delivery_range" CHECK (
    ("minDeliveryDays" IS NULL OR "minDeliveryDays" >= 0)
    AND ("maxDeliveryDays" IS NULL OR "maxDeliveryDays" >= 0)
    AND (
      "minDeliveryDays" IS NULL OR "maxDeliveryDays" IS NULL
      OR "minDeliveryDays" <= "maxDeliveryDays"
    )
  );

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_amount_positive" CHECK ("amountSar" > 0),
  ADD CONSTRAINT "PaymentIntent_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PaymentIntent_provider_known" CHECK (
    "provider" IN ('manual', 'moyasar', 'tap')
  );

ALTER TABLE "FxRate"
  ADD CONSTRAINT "FxRate_rate_positive" CHECK ("rate" > 0),
  ADD CONSTRAINT "FxRate_currency_iso" CHECK (
    "baseCurrency" ~ '^[A-Z]{3}$' AND "quoteCurrency" ~ '^[A-Z]{3}$'
  );

ALTER TABLE "AeApiLog"
  ADD CONSTRAINT "AeApiLog_duration_nonnegative" CHECK (
    "durationMs" IS NULL OR "durationMs" >= 0
  );
