-- Defense in depth for values that originate outside PostgreSQL. Application
-- validation remains the first boundary; these checks prevent a background
-- job, future code path, or manual SQL write from bypassing it.
--
-- Keep this migration atomic. PostgreSQL otherwise retains statements that
-- succeeded before a later Prisma migration statement failed.
BEGIN;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_plaintext_metadata" CHECK (
    ("titleAr" IS NULL OR (
      length("titleAr") <= 1000 AND "titleAr" !~ '[[:cntrl:]]'
    ))
    AND ("description" IS NULL OR (
      length("description") <= 32000
      AND octet_length("description") <= 131072
      AND "description" !~ '[[:cntrl:]<>]'
    ))
    AND ("categoryName" IS NULL OR (
      length("categoryName") <= 512 AND "categoryName" !~ '[[:cntrl:]]'
    ))
  );

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_shipping_snapshot_shape" CHECK (
    jsonb_typeof("shippingSnapshot") = 'object'
    AND "shippingSnapshot" ?& ARRAY[
      'fullName', 'phone', 'country', 'province', 'city', 'addressLine1'
    ]
    AND ("shippingSnapshot" - ARRAY[
      'fullName', 'phone', 'country', 'province', 'city', 'addressLine1',
      'addressLine2', 'postalCode', 'nationalAddress'
    ]::text[]) = '{}'::jsonb
    AND jsonb_typeof("shippingSnapshot"->'fullName') = 'string'
    AND length("shippingSnapshot"->>'fullName') BETWEEN 3 AND 80
    AND ("shippingSnapshot"->>'fullName') !~ '[[:cntrl:]]'
    AND jsonb_typeof("shippingSnapshot"->'phone') = 'string'
    AND ("shippingSnapshot"->>'phone') ~ '^5[0-9]{8}$'
    AND jsonb_typeof("shippingSnapshot"->'country') = 'string'
    AND ("shippingSnapshot"->>'country') = 'SA'
    AND jsonb_typeof("shippingSnapshot"->'province') = 'string'
    AND ("shippingSnapshot"->>'province') IN (
      'الرياض', 'مكة المكرمة', 'المدينة المنورة', 'القصيم',
      'المنطقة الشرقية', 'عسير', 'تبوك', 'حائل', 'الحدود الشمالية',
      'جازان', 'نجران', 'الباحة', 'الجوف'
    )
    AND jsonb_typeof("shippingSnapshot"->'city') = 'string'
    AND length("shippingSnapshot"->>'city') BETWEEN 2 AND 60
    AND ("shippingSnapshot"->>'city') !~ '[[:cntrl:]]'
    AND jsonb_typeof("shippingSnapshot"->'addressLine1') = 'string'
    AND length("shippingSnapshot"->>'addressLine1') BETWEEN 5 AND 200
    AND ("shippingSnapshot"->>'addressLine1') !~ '[[:cntrl:]]'
    AND (
      NOT ("shippingSnapshot" ? 'addressLine2')
      OR (
        jsonb_typeof("shippingSnapshot"->'addressLine2') = 'string'
        AND length("shippingSnapshot"->>'addressLine2') <= 200
        AND ("shippingSnapshot"->>'addressLine2') !~ '[[:cntrl:]]'
      )
    )
    AND (
      NOT ("shippingSnapshot" ? 'postalCode')
      OR (
        jsonb_typeof("shippingSnapshot"->'postalCode') = 'string'
        AND ("shippingSnapshot"->>'postalCode') ~ '^(|[0-9]{5})$'
      )
    )
    AND (
      NOT ("shippingSnapshot" ? 'nationalAddress')
      OR (
        jsonb_typeof("shippingSnapshot"->'nationalAddress') = 'string'
        AND ("shippingSnapshot"->>'nationalAddress') ~ '^(|[A-Z]{4}[0-9]{4})$'
      )
    )
  );

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_provider_fields_canonical" CHECK (
    length("providerRef") BETWEEN 1 AND 160
    AND "providerRef" !~ '[[:cntrl:]]'
    AND ("checkoutUrl" IS NULL OR (
      length("checkoutUrl") <= 2048
      AND "checkoutUrl" !~ '[[:cntrl:][:space:]]'
      AND "checkoutUrl" ~ '^https://[^/@[:space:]]+([/?#]|$)'
      AND "checkoutUrl" !~ '^https://[^/]*@'
    ))
    AND ("failureCode" IS NULL OR (
      length("failureCode") BETWEEN 1 AND 100
      AND "failureCode" ~ '^[A-Za-z0-9_.:-]+$'
    ))
    AND ("failureMessage" IS NULL OR (
      length("failureMessage") <= 500
      AND "failureMessage" !~ '[[:cntrl:]<>]'
    ))
  );

COMMIT;
