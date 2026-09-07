-- Keep invariants enforced when background jobs, administrative SQL, or future
-- code paths bypass the current Zod/Better Auth validation boundary.

ALTER TABLE "user"
  ADD CONSTRAINT "user_phone_saudi_normalized" CHECK (
    "phone" IS NULL OR "phone" ~ '^5[0-9]{8}$'
  );

ALTER TABLE "Address"
  ADD CONSTRAINT "Address_saudi_contact" CHECK (
    "country" = 'SA' AND "phone" ~ '^5[0-9]{8}$'
  ),
  ADD CONSTRAINT "Address_text_lengths" CHECK (
    length("fullName") BETWEEN 3 AND 80
    AND length("province") BETWEEN 1 AND 100
    AND length("city") BETWEEN 2 AND 60
    AND length("addressLine1") BETWEEN 5 AND 200
    AND ("addressLine2" IS NULL OR length("addressLine2") <= 200)
  ),
  ADD CONSTRAINT "Address_codes_valid" CHECK (
    ("postalCode" IS NULL OR "postalCode" ~ '^[0-9]{5}$')
    AND ("nationalAddr" IS NULL OR "nationalAddr" ~ '^[A-Z]{4}[0-9]{4}$')
  ),
  ADD CONSTRAINT "Address_no_control_characters" CHECK (
    "fullName" !~ '[[:cntrl:]]'
    AND "province" !~ '[[:cntrl:]]'
    AND "city" !~ '[[:cntrl:]]'
    AND "addressLine1" !~ '[[:cntrl:]]'
    AND ("addressLine2" IS NULL OR "addressLine2" !~ '[[:cntrl:]]')
  );

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_identity_and_text" CHECK (
    "aeProductId" ~ '^[0-9]{5,32}$'
    AND length("title") BETWEEN 1 AND 1000
    AND "sourceCurrency" = 'USD'
    AND "ordersCount" <= 1000000000
  );

ALTER TABLE "ProductSku"
  ADD CONSTRAINT "ProductSku_identity_and_text" CHECK (
    length("aeSkuId") <= 128
    AND length("skuAttr") BETWEEN 1 AND 96
    AND "skuAttr" !~ '[[:cntrl:]]'
    AND "stock" <= 1000000000
  );

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_capability_hash_lengths" CHECK (
    ("checkoutKeyHash" IS NULL OR length("checkoutKeyHash") = 43)
    AND ("guestAccessHash" IS NULL OR length("guestAccessHash") = 43)
  ),
  ADD CONSTRAINT "Order_source_currency" CHECK ("costSourceCurrency" = 'USD'),
  ADD CONSTRAINT "Order_notes_safe" CHECK (
    "notes" IS NULL OR (length("notes") <= 300 AND "notes" !~ '[[:cntrl:]]')
  ),
  ADD CONSTRAINT "Order_shipping_snapshot_bounded_object" CHECK (
    jsonb_typeof("shippingSnapshot") = 'object'
    AND octet_length("shippingSnapshot"::text) <= 16384
  );

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_provider_identifiers" CHECK (
    "aeProductId" ~ '^[0-9]{5,32}$'
    AND length("skuAttr") BETWEEN 1 AND 96
    AND "skuAttr" !~ '[[:cntrl:]]'
    AND "logisticsServiceName" ~ '^[A-Za-z0-9_.:-]{1,64}$'
  ),
  ADD CONSTRAINT "OrderItem_snapshot_lengths" CHECK (
    length("titleSnapshot") BETWEEN 1 AND 1000
    AND ("variantLabel" IS NULL OR length("variantLabel") <= 1000)
    AND ("shippingCompany" IS NULL OR length("shippingCompany") <= 256)
  );

ALTER TABLE "AeOrder"
  ADD CONSTRAINT "AeOrder_provider_identifier" CHECK (
    "aeOrderId" ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  ADD CONSTRAINT "AeOrder_pay_timeout_nonnegative" CHECK (
    "payTimeoutSecond" IS NULL OR "payTimeoutSecond" >= 0
  ),
  ADD CONSTRAINT "AeOrder_amount_breakdown_bounded" CHECK (
    "amountBreakdown" IS NULL
    OR octet_length("amountBreakdown"::text) <= 262144
  );

ALTER TABLE "TrackingPackage"
  ADD CONSTRAINT "TrackingPackage_text_and_url" CHECK (
    length("mailNo") BETWEEN 1 AND 128
    AND "mailNo" !~ '[[:cntrl:]]'
    AND ("carrierName" IS NULL OR length("carrierName") <= 256)
    AND ("cpName" IS NULL OR length("cpName") <= 256)
    AND (
      "cpWebsiteUrl" IS NULL
      OR (length("cpWebsiteUrl") <= 4096 AND "cpWebsiteUrl" ~ '^https://')
    )
  ),
  ADD CONSTRAINT "TrackingPackage_nodes_bounded_array" CHECK (
    jsonb_typeof("nodes") = 'array'
    AND octet_length("nodes"::text) <= 262144
  );

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_metadata_lengths" CHECK (
    length("providerRef") BETWEEN 1 AND 256
    AND ("checkoutUrl" IS NULL OR length("checkoutUrl") <= 2048)
    AND ("failureCode" IS NULL OR length("failureCode") <= 128)
    AND ("failureMessage" IS NULL OR length("failureMessage") <= 1000)
  ),
  ADD CONSTRAINT "PaymentIntent_paid_timestamp" CHECK (
    "status" NOT IN ('PAID', 'REFUNDED') OR "paidAt" IS NOT NULL
  ),
  ADD CONSTRAINT "PaymentIntent_webhook_payload_bounded" CHECK (
    "lastWebhookPayload" IS NULL
    OR octet_length("lastWebhookPayload"::text) <= 262144
  );

ALTER TABLE "rateLimit"
  ADD CONSTRAINT "rateLimit_key_and_count_bounded" CHECK (
    length("key") BETWEEN 1 AND 512
    AND "count" <= 1000000000
  );

ALTER TABLE "AeToken"
  ADD CONSTRAINT "AeToken_singleton_id" CHECK ("id" = 'singleton');
