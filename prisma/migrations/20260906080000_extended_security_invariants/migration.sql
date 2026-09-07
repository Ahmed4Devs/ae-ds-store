-- Bound authentication/provider metadata and close integrity gaps that are not
-- represented by Prisma's broad TEXT/JSON types. These checks also protect
-- background jobs and manual SQL from bypassing HTTP validation.

-- PostgreSQL/Prisma can leave already successful statements behind when a
-- later statement in the same migration fails. These exact names belong only
-- to this migration and make a reviewed retry safe; on a fresh schema they are
-- no-ops.
ALTER TABLE "user"
  DROP CONSTRAINT IF EXISTS "user_identity_text_bounded",
  DROP CONSTRAINT IF EXISTS "user_image_https_bounded";
ALTER TABLE "session"
  DROP CONSTRAINT IF EXISTS "session_metadata_bounded";
ALTER TABLE "account"
  DROP CONSTRAINT IF EXISTS "account_identity_bounded",
  DROP CONSTRAINT IF EXISTS "account_secrets_bounded";
ALTER TABLE "verification"
  DROP CONSTRAINT IF EXISTS "verification_metadata_bounded";
DROP FUNCTION IF EXISTS "ae_store_safe_image_urls"(text[]);

ALTER TABLE "user"
  ADD CONSTRAINT "user_identity_text_bounded" CHECK (
    length("id") BETWEEN 1 AND 128
    AND length("name") BETWEEN 2 AND 100
    AND "name" !~ '[[:cntrl:]]'
    AND length("email") BETWEEN 3 AND 254
    AND "email" = lower(btrim("email"))
    AND "email" !~ '[[:cntrl:][:space:]]'
    AND "email" ~ '^[^@]+@[^@]+$'
  ),
  ADD CONSTRAINT "user_image_https_bounded" CHECK (
    "image" IS NULL
    OR (length("image") <= 2048 AND "image" LIKE 'https://%')
  );

ALTER TABLE "session"
  ADD CONSTRAINT "session_metadata_bounded" CHECK (
    length("id") BETWEEN 1 AND 128
    AND length("token") BETWEEN 20 AND 512
    AND ("ipAddress" IS NULL OR (
      length("ipAddress") <= 64 AND "ipAddress" !~ '[[:cntrl:]]'
    ))
    AND ("userAgent" IS NULL OR (
      length("userAgent") <= 512 AND "userAgent" !~ '[[:cntrl:]]'
    ))
    AND "expiresAt" > "createdAt"
  );

ALTER TABLE "account"
  ADD CONSTRAINT "account_identity_bounded" CHECK (
    length("id") BETWEEN 1 AND 128
    AND length("accountId") BETWEEN 1 AND 320
    AND "accountId" !~ '[[:cntrl:]]'
    AND length("providerId") BETWEEN 1 AND 64
    AND "providerId" ~ '^[A-Za-z0-9_.:-]+$'
    AND ("issuer" IS NULL OR (
      length("issuer") <= 2048 AND "issuer" !~ '[[:cntrl:]]'
    ))
  ),
  ADD CONSTRAINT "account_secrets_bounded" CHECK (
    ("password" IS NULL OR length("password") BETWEEN 20 AND 2048)
    AND ("accessToken" IS NULL OR octet_length("accessToken") <= 131072)
    AND ("refreshToken" IS NULL OR octet_length("refreshToken") <= 131072)
    AND ("idToken" IS NULL OR octet_length("idToken") <= 262144)
    AND ("scope" IS NULL OR length("scope") <= 4096)
  );

ALTER TABLE "verification"
  ADD CONSTRAINT "verification_metadata_bounded" CHECK (
    length("id") BETWEEN 1 AND 128
    AND length("identifier") BETWEEN 1 AND 512
    AND "identifier" !~ '[[:cntrl:]]'
    AND length("value") BETWEEN 1 AND 4096
    AND "expiresAt" > "createdAt"
  );

-- PostgreSQL CHECK expressions cannot contain a subquery directly. This pure,
-- invoker-rights helper validates every element of a TEXT[] without reading
-- tables or depending on a mutable search_path.
CREATE FUNCTION "ae_store_safe_image_urls"(urls text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(bool_and(
    length(url) BETWEEN 1 AND 32768
    AND (
      url LIKE 'https://%'
      OR url LIKE 'data:image/svg+xml,%'
      OR url LIKE 'data:image/svg+xml;utf8,%'
    )
  ), true)
  FROM unnest(urls) AS item(url)
$$;

-- Releases before this migration used `;` both as image_urls delimiter and
-- inside `data:image/svg+xml;utf8,...`, splitting each mock image into two
-- invalid strings. Preserve the product rows but replace only broken media;
-- the next mirror refresh restores their generated previews.
UPDATE "Product"
SET
  "mainImageUrl" = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201%201%22%3E%3Cpath%20fill%3D%22%23e5e7eb%22%20d%3D%22M0%200h1v1H0z%22%2F%3E%3C%2Fsvg%3E',
  "imageUrls" = ARRAY['data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201%201%22%3E%3Cpath%20fill%3D%22%23e5e7eb%22%20d%3D%22M0%200h1v1H0z%22%2F%3E%3C%2Fsvg%3E']::text[]
WHERE
  length("mainImageUrl") NOT BETWEEN 1 AND 32768
  OR NOT (
    "mainImageUrl" LIKE 'https://%'
    OR "mainImageUrl" LIKE 'data:image/svg+xml,%'
    OR "mainImageUrl" LIKE 'data:image/svg+xml;utf8,%'
  )
  OR cardinality("imageUrls") > 20
  OR octet_length(array_to_json("imageUrls")::text) > 262144
  OR NOT "ae_store_safe_image_urls"("imageUrls");

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_content_bounded" CHECK (
    length("title") BETWEEN 1 AND 1000
    AND "title" !~ '[[:cntrl:]]'
    AND ("titleAr" IS NULL OR length("titleAr") <= 1000)
    AND ("description" IS NULL OR octet_length("description") <= 131072)
    AND ("categoryName" IS NULL OR length("categoryName") <= 512)
    AND ("properties" IS NULL OR octet_length("properties"::text) <= 524288)
  ),
  ADD CONSTRAINT "Product_media_bounded" CHECK (
    length("mainImageUrl") BETWEEN 1 AND 32768
    AND (
      "mainImageUrl" LIKE 'https://%'
      OR "mainImageUrl" LIKE 'data:image/svg+xml,%'
      OR "mainImageUrl" LIKE 'data:image/svg+xml;utf8,%'
    )
    AND cardinality("imageUrls") <= 20
    AND octet_length(array_to_json("imageUrls")::text) <= 262144
    AND "ae_store_safe_image_urls"("imageUrls")
    AND ("videoUrl" IS NULL OR (
      length("videoUrl") <= 4096 AND "videoUrl" LIKE 'https://%'
    ))
  ),
  ADD CONSTRAINT "Product_category_identifier" CHECK (
    "aeCategoryId" IS NULL OR "aeCategoryId" ~ '^[0-9]{1,32}$'
  );

ALTER TABLE "ProductSku"
  ADD CONSTRAINT "ProductSku_display_bounded" CHECK (
    ("variantLabel" IS NULL OR length("variantLabel") <= 1000)
    AND ("imageUrl" IS NULL OR (
      length("imageUrl") <= 32768
      AND (
        "imageUrl" LIKE 'https://%'
        OR "imageUrl" LIKE 'data:image/svg+xml,%'
        OR "imageUrl" LIKE 'data:image/svg+xml;utf8,%'
      )
    ))
  );

-- Do not rename identifiers already shared with customers/providers. Quarantine
-- legacy malformed rows instead; payment and sourcing both fail closed on this
-- flag. New malformed rows can exist only if explicitly quarantined too.
UPDATE "Order"
SET "needsManualReview" = true
WHERE (
  "orderNumber" !~ '^AE-[0-9]{8}-[0-9A-F]{6}$'
  OR "outOrderId" !~ '^AE-[0-9]{8}-[0-9A-F]{6}-[0-9a-f]{8}$'
  OR "outOrderId" NOT LIKE "orderNumber" || '-%'
) AND NOT "needsManualReview";

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_identifiers_canonical_or_quarantined" CHECK (
    "needsManualReview"
    OR (
      "orderNumber" ~ '^AE-[0-9]{8}-[0-9A-F]{6}$'
      AND "outOrderId" ~ '^AE-[0-9]{8}-[0-9A-F]{6}-[0-9a-f]{8}$'
      AND "outOrderId" LIKE "orderNumber" || '-%'
    )
  ),
  ADD CONSTRAINT "Order_cancel_metadata_bounded" CHECK (
    "cancelReason" IS NULL
    OR (length("cancelReason") <= 500 AND "cancelReason" !~ '[[:cntrl:]]')
  ),
  ADD CONSTRAINT "Order_totals_consistent" CHECK (
    abs("totalSar" - "subtotalSar" - "shippingSar" - "vatSar") <= 0.05
  );

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_media_and_delivery_bounded" CHECK (
    ("imageSnapshot" IS NULL OR (
      length("imageSnapshot") <= 32768
      AND (
        "imageSnapshot" LIKE 'https://%'
        OR "imageSnapshot" LIKE 'data:image/svg+xml,%'
        OR "imageSnapshot" LIKE 'data:image/svg+xml;utf8,%'
      )
    ))
    AND ("minDeliveryDays" IS NULL OR "minDeliveryDays" <= 3650)
    AND ("maxDeliveryDays" IS NULL OR "maxDeliveryDays" <= 3650)
  );

ALTER TABLE "AeOrder"
  ADD CONSTRAINT "AeOrder_status_text_bounded" CHECK (
    ("aeOrderStatus" IS NULL OR (
      length("aeOrderStatus") <= 128 AND "aeOrderStatus" !~ '[[:cntrl:]]'
    ))
    AND ("aeLogisticsStatus" IS NULL OR (
      length("aeLogisticsStatus") <= 128 AND "aeLogisticsStatus" !~ '[[:cntrl:]]'
    ))
  );

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_provider_text_safe" CHECK (
    length("providerRef") <= 160
    AND ("checkoutUrl" IS NULL OR "checkoutUrl" !~ '[[:cntrl:]]')
    AND ("failureCode" IS NULL OR "failureCode" !~ '[[:cntrl:]]')
    AND ("failureMessage" IS NULL OR "failureMessage" !~ '[[:cntrl:]]')
    AND ("provider" <> 'manual' OR "checkoutUrl" IS NULL)
  );

ALTER TABLE "AeApiLog"
  ADD CONSTRAINT "AeApiLog_metadata_bounded" CHECK (
    length("apiName") BETWEEN 1 AND 128
    AND "mode" IN ('mock', 'live')
    AND ("errorCode" IS NULL OR length("errorCode") <= 128)
    AND ("errorMessage" IS NULL OR length("errorMessage") <= 1000)
    AND ("requestSummary" IS NULL OR octet_length("requestSummary"::text) <= 262144)
  );

ALTER TABLE "FxRate"
  ADD CONSTRAINT "FxRate_source_bounded" CHECK (
    length("source") BETWEEN 1 AND 100 AND "source" !~ '[[:cntrl:]]'
  );

ALTER TABLE "AeToken"
  ADD CONSTRAINT "AeToken_metadata_bounded" CHECK (
    length("accessToken") BETWEEN 1 AND 262144
    AND ("refreshToken" IS NULL OR length("refreshToken") <= 262144)
    AND ("lastError" IS NULL OR (
      length("lastError") <= 500 AND "lastError" !~ '[[:cntrl:]]'
    ))
    AND (("refreshLeaseId" IS NULL) = ("refreshLeaseUntil" IS NULL))
  );
