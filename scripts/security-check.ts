import "dotenv/config";
import { prisma } from "@/lib/db";

interface DatabasePosture {
  role_name: string;
  is_superuser: boolean;
  can_create_role: boolean;
  can_create_database: boolean;
  can_replicate: boolean;
  bypasses_rls: boolean;
  ssl_in_use: boolean;
  password_encryption: string;
  public_can_create_schema_objects: boolean;
  app_can_create_schema_objects: boolean;
  can_create_schemas: boolean;
  can_create_temporary_tables: boolean;
  owns_database: boolean;
  owns_public_schema: boolean;
  can_update_admin_audit: boolean;
  can_delete_admin_audit: boolean;
}

interface DataPosture {
  unsafe_auth_rows: number;
  unsafe_two_factor_rows: number;
  unsafe_catalog_rows: number;
  unsafe_order_rows: number;
  unsafe_provider_rows: number;
  unsafe_product_image_rows: number;
  unsafe_product_main_rows: number;
  oversized_product_image_array_rows: number;
  unsafe_product_image_element_rows: number;
  unsafe_product_video_rows: number;
  unsafe_sku_image_rows: number;
  unsafe_order_image_rows: number;
  unsafe_workflow_rows: number;
}

interface NameRow {
  name: string;
}

function check(label: string, passed: boolean): boolean {
  console.log(`  ${passed ? "✓" : "✗"} ${label}`);
  return passed;
}

async function main(): Promise<void> {
  const rows = await prisma.$queryRaw<DatabasePosture[]>`
    SELECT
      current_user::text AS role_name,
      r.rolsuper AS is_superuser,
      r.rolcreaterole AS can_create_role,
      r.rolcreatedb AS can_create_database,
      r.rolreplication AS can_replicate,
      r.rolbypassrls AS bypasses_rls,
      COALESCE(s.ssl, false) AS ssl_in_use,
      current_setting('password_encryption') AS password_encryption,
      has_schema_privilege('public', 'public', 'CREATE')
        AS public_can_create_schema_objects,
      has_schema_privilege(current_user, 'public', 'CREATE')
        AS app_can_create_schema_objects,
      has_database_privilege(current_user, current_database(), 'CREATE')
        AS can_create_schemas,
      has_database_privilege(current_user, current_database(), 'TEMP')
        AS can_create_temporary_tables,
      EXISTS (
        SELECT 1 FROM pg_database d
        WHERE d.datname = current_database() AND d.datdba = r.oid
      ) AS owns_database,
      EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname = 'public' AND n.nspowner = r.oid
      ) AS owns_public_schema
      ,COALESCE((
        SELECT has_table_privilege(current_user, c.oid, 'UPDATE')
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = 'AdminAuditLog'
      ), true) AS can_update_admin_audit
      ,COALESCE((
        SELECT has_table_privilege(current_user, c.oid, 'DELETE')
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = 'AdminAuditLog'
      ), true) AS can_delete_admin_audit
    FROM pg_roles r
    LEFT JOIN pg_stat_ssl s ON s.pid = pg_backend_pid()
    WHERE r.rolname = current_user
  `;

  const posture = rows[0];
  if (!posture) throw new Error("تعذّر قراءة وضع دور PostgreSQL الحالي");

  const integrityRows = await prisma.$queryRaw<DataPosture[]>`
    SELECT
      (
        (SELECT count(*) FROM "user" WHERE
          length("id") NOT BETWEEN 1 AND 128
          OR length("name") NOT BETWEEN 2 AND 100
          OR "name" ~ '[[:cntrl:]]'
          OR length("email") NOT BETWEEN 3 AND 254
          OR "email" <> lower(btrim("email"))
          OR "email" ~ '[[:cntrl:][:space:]]'
          OR "email" !~ '^[^@]+@[^@]+$'
          OR ("image" IS NOT NULL AND (
            length("image") > 2048 OR "image" !~ '^https://'
          )))
        + (SELECT count(*) FROM "session" WHERE
          length("id") NOT BETWEEN 1 AND 128
          OR length("token") NOT BETWEEN 20 AND 512
          OR ("ipAddress" IS NOT NULL AND (
            length("ipAddress") > 64 OR "ipAddress" ~ '[[:cntrl:]]'
          ))
          OR ("userAgent" IS NOT NULL AND (
            length("userAgent") > 512 OR "userAgent" ~ '[[:cntrl:]]'
          )))
        + (SELECT count(*) FROM "account" WHERE
          length("id") NOT BETWEEN 1 AND 128
          OR length("accountId") NOT BETWEEN 1 AND 320
          OR "accountId" ~ '[[:cntrl:]]'
          OR length("providerId") NOT BETWEEN 1 AND 64
          OR "providerId" !~ '^[A-Za-z0-9_.:-]+$'
          OR ("issuer" IS NOT NULL AND (
            length("issuer") > 2048 OR "issuer" ~ '[[:cntrl:]]'
          ))
          OR ("password" IS NOT NULL AND length("password") NOT BETWEEN 20 AND 2048)
          OR ("accessToken" IS NOT NULL AND octet_length("accessToken") > 131072)
          OR ("refreshToken" IS NOT NULL AND octet_length("refreshToken") > 131072)
          OR ("idToken" IS NOT NULL AND octet_length("idToken") > 262144)
          OR ("scope" IS NOT NULL AND length("scope") > 4096))
        + (SELECT count(*) FROM "verification" WHERE
          length("id") NOT BETWEEN 1 AND 128
          OR length("identifier") NOT BETWEEN 1 AND 512
          OR "identifier" ~ '[[:cntrl:]]'
          OR length("value") NOT BETWEEN 1 AND 4096)
      )::int AS unsafe_auth_rows,
      (
        (SELECT count(*) FROM "twoFactor" WHERE
          length("id") NOT BETWEEN 1 AND 128
          OR length("userId") NOT BETWEEN 1 AND 128
          OR length("secret") NOT BETWEEN 20 AND 4096
          OR octet_length("backupCodes") NOT BETWEEN 20 AND 32768
          OR "failedVerificationCount" NOT BETWEEN 0 AND 100)
        + (SELECT count(*) FROM "user" u WHERE
          u."twoFactorEnabled"
          AND NOT EXISTS (
            SELECT 1 FROM "twoFactor" tf
            WHERE tf."userId" = u."id" AND tf."verified"
          ))
      )::int AS unsafe_two_factor_rows,
      (
        (SELECT count(*) FROM "Product" WHERE
          length("title") NOT BETWEEN 1 AND 1000
          OR "title" ~ '[[:cntrl:]]'
          OR ("titleAr" IS NOT NULL AND (
            length("titleAr") > 1000 OR "titleAr" ~ '[[:cntrl:]]'
          ))
          OR ("description" IS NOT NULL AND (
            length("description") > 32000
            OR octet_length("description") > 131072
            OR "description" ~ '[[:cntrl:]<>]'
          ))
          OR length("mainImageUrl") NOT BETWEEN 1 AND 32768
          OR NOT (
            "mainImageUrl" LIKE 'https://%'
            OR "mainImageUrl" LIKE 'data:image/svg+xml,%'
            OR "mainImageUrl" LIKE 'data:image/svg+xml;utf8,%'
          )
          OR cardinality("imageUrls") > 20
          OR octet_length(array_to_json("imageUrls")::text) > 262144
          OR EXISTS (
            SELECT 1 FROM unnest("imageUrls") AS image_url
            WHERE length(image_url) NOT BETWEEN 1 AND 32768
              OR NOT (
                image_url LIKE 'https://%'
                OR image_url LIKE 'data:image/svg+xml,%'
                OR image_url LIKE 'data:image/svg+xml;utf8,%'
              )
          )
          OR ("videoUrl" IS NOT NULL AND (
            length("videoUrl") > 4096 OR "videoUrl" NOT LIKE 'https://%'
          ))
          OR ("aeCategoryId" IS NOT NULL AND "aeCategoryId" !~ '^[0-9]{1,32}$')
          OR ("categoryName" IS NOT NULL AND (
            length("categoryName") > 512 OR "categoryName" ~ '[[:cntrl:]]'
          ))
          OR ("properties" IS NOT NULL AND octet_length("properties"::text) > 524288))
        + (SELECT count(*) FROM "ProductSku" WHERE
          length("variantLabel") > 1000
          OR ("imageUrl" IS NOT NULL AND (
            length("imageUrl") > 32768
            OR NOT (
              "imageUrl" LIKE 'https://%'
              OR "imageUrl" LIKE 'data:image/svg+xml,%'
              OR "imageUrl" LIKE 'data:image/svg+xml;utf8,%'
            )
          ))
          OR "stock" > 1000000000)
      )::int AS unsafe_catalog_rows,
      (
        (SELECT count(*) FROM "Order" WHERE
          (("orderNumber" !~ '^AE-[0-9]{8}-[0-9A-F]{6}$'
            OR "outOrderId" !~ '^AE-[0-9]{8}-[0-9A-F]{6}-[0-9a-f]{8}$'
            OR "outOrderId" NOT LIKE "orderNumber" || '-%')
            AND NOT "needsManualReview")
          OR ("cancelReason" IS NOT NULL AND (
            length("cancelReason") > 500 OR "cancelReason" ~ '[[:cntrl:]]'
          ))
          OR jsonb_typeof("shippingSnapshot") <> 'object'
          OR NOT ("shippingSnapshot" ?& ARRAY[
            'fullName', 'phone', 'country', 'province', 'city', 'addressLine1'
          ])
          OR ("shippingSnapshot" - ARRAY[
            'fullName', 'phone', 'country', 'province', 'city', 'addressLine1',
            'addressLine2', 'postalCode', 'nationalAddress'
          ]::text[]) <> '{}'::jsonb
          OR jsonb_typeof("shippingSnapshot"->'fullName') <> 'string'
          OR length("shippingSnapshot"->>'fullName') NOT BETWEEN 3 AND 80
          OR ("shippingSnapshot"->>'fullName') ~ '[[:cntrl:]]'
          OR jsonb_typeof("shippingSnapshot"->'phone') <> 'string'
          OR ("shippingSnapshot"->>'phone') !~ '^5[0-9]{8}$'
          OR jsonb_typeof("shippingSnapshot"->'country') <> 'string'
          OR ("shippingSnapshot"->>'country') <> 'SA'
          OR jsonb_typeof("shippingSnapshot"->'province') <> 'string'
          OR ("shippingSnapshot"->>'province') NOT IN (
            'الرياض', 'مكة المكرمة', 'المدينة المنورة', 'القصيم',
            'المنطقة الشرقية', 'عسير', 'تبوك', 'حائل', 'الحدود الشمالية',
            'جازان', 'نجران', 'الباحة', 'الجوف'
          )
          OR jsonb_typeof("shippingSnapshot"->'city') <> 'string'
          OR length("shippingSnapshot"->>'city') NOT BETWEEN 2 AND 60
          OR ("shippingSnapshot"->>'city') ~ '[[:cntrl:]]'
          OR jsonb_typeof("shippingSnapshot"->'addressLine1') <> 'string'
          OR length("shippingSnapshot"->>'addressLine1') NOT BETWEEN 5 AND 200
          OR ("shippingSnapshot"->>'addressLine1') ~ '[[:cntrl:]]'
          OR ("shippingSnapshot" ? 'addressLine2' AND (
            jsonb_typeof("shippingSnapshot"->'addressLine2') <> 'string'
            OR length("shippingSnapshot"->>'addressLine2') > 200
            OR ("shippingSnapshot"->>'addressLine2') ~ '[[:cntrl:]]'
          ))
          OR ("shippingSnapshot" ? 'postalCode' AND (
            jsonb_typeof("shippingSnapshot"->'postalCode') <> 'string'
            OR ("shippingSnapshot"->>'postalCode') !~ '^(|[0-9]{5})$'
          ))
          OR ("shippingSnapshot" ? 'nationalAddress' AND (
            jsonb_typeof("shippingSnapshot"->'nationalAddress') <> 'string'
            OR ("shippingSnapshot"->>'nationalAddress') !~ '^(|[A-Z]{4}[0-9]{4})$'
          ))
          OR abs("totalSar" - "subtotalSar" - "shippingSar" - "vatSar") > 0.05)
        + (SELECT count(*) FROM "OrderItem" WHERE
          ("imageSnapshot" IS NOT NULL AND (
            length("imageSnapshot") > 32768
            OR NOT (
              "imageSnapshot" LIKE 'https://%'
              OR "imageSnapshot" LIKE 'data:image/svg+xml,%'
              OR "imageSnapshot" LIKE 'data:image/svg+xml;utf8,%'
            )
          ))
          OR "minDeliveryDays" > 3650 OR "maxDeliveryDays" > 3650)
      )::int AS unsafe_order_rows,
      (
        (SELECT count(*) FROM "AeOrder" WHERE
          ("aeOrderStatus" IS NOT NULL AND (
            length("aeOrderStatus") > 128 OR "aeOrderStatus" ~ '[[:cntrl:]]'
          ))
          OR ("aeLogisticsStatus" IS NOT NULL AND (
            length("aeLogisticsStatus") > 128 OR "aeLogisticsStatus" ~ '[[:cntrl:]]'
          )))
        + (SELECT count(*) FROM "PaymentIntent" WHERE
          length("providerRef") NOT BETWEEN 1 AND 160
          OR "providerRef" ~ '[[:cntrl:]]'
          OR ("checkoutUrl" IS NOT NULL AND (
            length("checkoutUrl") > 2048
            OR "checkoutUrl" ~ '[[:cntrl:]]'
            OR "checkoutUrl" !~ '^https://'
            OR "checkoutUrl" ~ '^https://[^/]*@'
          ))
          OR ("failureCode" IS NOT NULL AND (
            length("failureCode") NOT BETWEEN 1 AND 100
            OR "failureCode" !~ '^[A-Za-z0-9_.:-]+$'
          ))
          OR ("failureMessage" IS NOT NULL AND (
            length("failureMessage") > 500
            OR "failureMessage" ~ '[[:cntrl:]<>]'
          ))
          OR ("provider" = 'manual' AND "checkoutUrl" IS NOT NULL))
        + (SELECT count(*) FROM "AeApiLog" WHERE
          length("apiName") NOT BETWEEN 1 AND 128
          OR "mode" NOT IN ('mock', 'live')
          OR ("errorCode" IS NOT NULL AND length("errorCode") > 128)
          OR ("errorMessage" IS NOT NULL AND length("errorMessage") > 1000)
          OR ("requestSummary" IS NOT NULL AND octet_length("requestSummary"::text) > 262144))
        + (SELECT count(*) FROM "FxRate" WHERE
          length("source") NOT BETWEEN 1 AND 100 OR "source" ~ '[[:cntrl:]]')
        + (SELECT count(*) FROM "AeToken" WHERE
          length("accessToken") NOT BETWEEN 1 AND 262144
          OR ("refreshToken" IS NOT NULL AND length("refreshToken") > 262144)
          OR ("lastError" IS NOT NULL AND (
            length("lastError") > 500 OR "lastError" ~ '[[:cntrl:]]'
          ))
          OR ("refreshLeaseId" IS NULL) <> ("refreshLeaseUntil" IS NULL))
      )::int AS unsafe_provider_rows,
      (SELECT count(*)::int FROM "Product" WHERE
        length("mainImageUrl") NOT BETWEEN 1 AND 32768
        OR NOT (
          "mainImageUrl" LIKE 'https://%'
          OR "mainImageUrl" LIKE 'data:image/svg+xml,%'
          OR "mainImageUrl" LIKE 'data:image/svg+xml;utf8,%'
        )
        OR cardinality("imageUrls") > 20
        OR octet_length(array_to_json("imageUrls")::text) > 262144
        OR EXISTS (
          SELECT 1 FROM unnest("imageUrls") AS image_url
          WHERE length(image_url) NOT BETWEEN 1 AND 32768
            OR NOT (
              image_url LIKE 'https://%'
              OR image_url LIKE 'data:image/svg+xml,%'
              OR image_url LIKE 'data:image/svg+xml;utf8,%'
            )
        )
      ) AS unsafe_product_image_rows,
      (SELECT count(*)::int FROM "Product" WHERE
        length("mainImageUrl") NOT BETWEEN 1 AND 32768
        OR NOT (
          "mainImageUrl" LIKE 'https://%'
            OR "mainImageUrl" LIKE 'data:image/svg+xml,%'
            OR "mainImageUrl" LIKE 'data:image/svg+xml;utf8,%'
        )
      ) AS unsafe_product_main_rows,
      (SELECT count(*)::int FROM "Product" WHERE
        cardinality("imageUrls") > 20
        OR octet_length(array_to_json("imageUrls")::text) > 262144
      ) AS oversized_product_image_array_rows,
      (SELECT count(*)::int FROM "Product" WHERE EXISTS (
        SELECT 1 FROM unnest("imageUrls") AS image_url
        WHERE length(image_url) NOT BETWEEN 1 AND 32768
          OR NOT (
            image_url LIKE 'https://%'
              OR image_url LIKE 'data:image/svg+xml,%'
              OR image_url LIKE 'data:image/svg+xml;utf8,%'
          )
      )) AS unsafe_product_image_element_rows,
      (SELECT count(*)::int FROM "Product" WHERE "videoUrl" IS NOT NULL AND (
        length("videoUrl") > 4096 OR "videoUrl" NOT LIKE 'https://%'
      )) AS unsafe_product_video_rows,
      (SELECT count(*)::int FROM "ProductSku" WHERE "imageUrl" IS NOT NULL AND (
        length("imageUrl") > 32768
        OR NOT (
          "imageUrl" LIKE 'https://%'
          OR "imageUrl" LIKE 'data:image/svg+xml,%'
          OR "imageUrl" LIKE 'data:image/svg+xml;utf8,%'
        )
      )) AS unsafe_sku_image_rows,
      (SELECT count(*)::int FROM "OrderItem" WHERE "imageSnapshot" IS NOT NULL AND (
        length("imageSnapshot") > 32768
        OR NOT (
          "imageSnapshot" LIKE 'https://%'
          OR "imageSnapshot" LIKE 'data:image/svg+xml,%'
          OR "imageSnapshot" LIKE 'data:image/svg+xml;utf8,%'
        )
      )) AS unsafe_order_image_rows,
      (
        (SELECT count(*) FROM "OrderJob" WHERE
          "attempts" NOT BETWEEN 0 AND 100
          OR "maxAttempts" NOT BETWEEN 1 AND 20
          OR length("dedupeKey") NOT BETWEEN 1 AND 160
          OR "dedupeKey" ~ '[[:cntrl:]]'
          OR ("leaseToken" IS NOT NULL AND length("leaseToken") NOT BETWEEN 16 AND 128)
          OR ("lastErrorCode" IS NOT NULL AND "lastErrorCode" !~ '^[A-Z0-9_:-]{1,100}$'))
        + (SELECT count(*) FROM "RefundRequest" WHERE
          "amountSar" <= 0
          OR "currency" !~ '^[A-Z]{3}$'
          OR "provider" NOT IN ('manual', 'moyasar', 'tap')
          OR "providerReason" NOT IN ('duplicate', 'fraudulent', 'requested_by_customer')
          OR length("reason") NOT BETWEEN 3 AND 500
          OR "reason" ~ '[[:cntrl:]]'
          OR "attempts" NOT BETWEEN 0 AND 100
          OR "maxAttempts" NOT BETWEEN 1 AND 20)
        + (SELECT count(*) FROM "AdminAuditLog" WHERE
          length("actorUserId") NOT BETWEEN 1 AND 128
          OR "action" !~ '^[A-Z0-9_:-]{1,100}$'
          OR "targetType" !~ '^[A-Z][A-Za-z0-9_]{0,63}$'
          OR length("targetId") NOT BETWEEN 1 AND 160
          OR ("reason" IS NOT NULL AND length("reason") NOT BETWEEN 3 AND 500))
      )::int AS unsafe_workflow_rows
  `;
  const integrity = integrityRows[0];
  if (!integrity) throw new Error("تعذّر قراءة سلامة صفوف PostgreSQL");

  const constraintRows = await prisma.$queryRaw<NameRow[]>`
    SELECT c.conname::text AS name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema() AND c.contype = 'c'
  `;
  const indexRows = await prisma.$queryRaw<NameRow[]>`
    SELECT indexname::text AS name
    FROM pg_indexes
    WHERE schemaname = current_schema()
  `;
  const functionRows = await prisma.$queryRaw<NameRow[]>`
    SELECT p.proname::text AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.proname = 'ae_store_safe_image_urls'
  `;
  const constraints = new Set(constraintRows.map((row) => row.name));
  const indexes = new Set(indexRows.map((row) => row.name));
  const requiredConstraints = [
    "Order_guest_access_pair",
    "Order_registered_user_no_guest_capability",
    "Order_amounts_valid",
    "Order_shipping_snapshot_shape",
    "Order_identifiers_canonical_or_quarantined",
    "Product_media_bounded",
    "Product_plaintext_metadata",
    "ProductSku_prices_positive",
    "OrderItem_quantity_range",
    "OrderItem_prices_positive",
    "PaymentIntent_amount_positive",
    "PaymentIntent_currency_iso",
    "PaymentIntent_provider_known",
    "PaymentIntent_paid_timestamp",
    "PaymentIntent_provider_fields_canonical",
    "user_identity_text_bounded",
    "session_metadata_bounded",
    "session_second_factor_assurance",
    "account_identity_bounded",
    "account_secrets_bounded",
    "verification_metadata_bounded",
    "twoFactor_security_bounded",
    "AeToken_singleton_id",
    "AeToken_metadata_bounded",
    "Order_manual_review_code_bounded",
    "Order_manual_review_note_bounded",
    "OrderJob_attempts_valid",
    "OrderJob_dedupe_key_bounded",
    "RefundRequest_amount_positive",
    "RefundRequest_operational_text_bounded",
    "RefundRequest_provider_reason_known",
    "AdminAuditLog_fields_bounded",
  ];
  const requiredIndexes = [
    "one_default_address_per_user",
    "one_open_intent_per_order",
    "account_providerId_accountId_key",
    "session_token_key",
    "twoFactor_userId_key",
    "twoFactor_secret_idx",
    "OrderJob_orderId_kind_key",
    "RefundRequest_paymentIntentId_key",
    "AdminAuditLog_targetType_targetId_createdAt_idx",
  ];
  const constraintsPresent = requiredConstraints.every((name) =>
    constraints.has(name),
  );
  const indexesPresent = requiredIndexes.every((name) => indexes.has(name));

  const dbUrl = new URL(process.env.DATABASE_URL ?? "");
  const remote = !["localhost", "127.0.0.1", "::1"].includes(
    dbUrl.hostname.toLowerCase(),
  );

  console.log("\n=== فحص جاهزية الأمان التشغيلي ===\n");
  const results = [
    check("دور التطبيق ليس superuser", !posture.is_superuser),
    check("دور التطبيق لا ينشئ أدوارًا", !posture.can_create_role),
    check("دور التطبيق لا ينشئ قواعد بيانات", !posture.can_create_database),
    check("دور التطبيق لا يملك replication", !posture.can_replicate),
    check("دور التطبيق لا يتجاوز RLS", !posture.bypasses_rls),
    check("دور التطبيق لا يملك قاعدة البيانات", !posture.owns_database),
    check("دور التطبيق لا يملك schema public", !posture.owns_public_schema),
    check(
      "سجل الإدارة append-only (لا UPDATE)",
      !posture.can_update_admin_audit,
    ),
    check(
      "سجل الإدارة append-only (لا DELETE)",
      !posture.can_delete_admin_audit,
    ),
    check("دور التطبيق لا ينشئ schemas", !posture.can_create_schemas),
    check(
      "دور التطبيق لا ينشئ كائنات داخل schema public",
      !posture.app_can_create_schema_objects,
    ),
    check(
      "دور التطبيق لا ينشئ جداول مؤقتة",
      !posture.can_create_temporary_tables,
    ),
    check(
      "الخادم يجزّئ كلمات المرور بـ SCRAM-SHA-256",
      posture.password_encryption.toLowerCase() === "scram-sha-256",
    ),
    check(
      "الدور PUBLIC لا يستطيع إنشاء كائنات في schema public",
      !posture.public_can_create_schema_objects,
    ),
    check(
      remote ? "اتصال قاعدة البيانات البعيدة مشفّر" : "قاعدة التطوير محلية",
      remote ? posture.ssl_in_use : true,
    ),
    check("صفوف المصادقة ضمن الحدود", integrity.unsafe_auth_rows === 0),
    check(
      "سجلات العامل الثاني متسقة ومحدودة",
      integrity.unsafe_two_factor_rows === 0,
    ),
    check("صفوف الكتالوج ضمن الحدود", integrity.unsafe_catalog_rows === 0),
    check("صور المنتجات المخزنة آمنة", integrity.unsafe_product_image_rows === 0),
    check("الصورة الرئيسية آمنة", integrity.unsafe_product_main_rows === 0),
    check(
      "مصفوفات صور المنتجات ضمن الحجم",
      integrity.oversized_product_image_array_rows === 0,
    ),
    check(
      "كل عنصر في مصفوفة الصور آمن",
      integrity.unsafe_product_image_element_rows === 0,
    ),
    check("فيديوهات المنتجات HTTPS", integrity.unsafe_product_video_rows === 0),
    check("صور SKU المخزنة آمنة", integrity.unsafe_sku_image_rows === 0),
    check("لقطات صور الطلبات آمنة", integrity.unsafe_order_image_rows === 0),
    check("صفوف الطلبيات ضمن الحدود/الحجر", integrity.unsafe_order_rows === 0),
    check("صفوف المزوّدين والسجل ضمن الحدود", integrity.unsafe_provider_rows === 0),
    check("صفوف المهام والاسترداد والتدقيق ضمن الحدود", integrity.unsafe_workflow_rows === 0),
    check("قيود CHECK الأمنية الحرجة مثبّتة", constraintsPresent),
    check("فهارس التفرد/التزامن الحرجة مثبّتة", indexesPresent),
    check("دالة فحص مصفوفة الصور مثبّتة", functionRows.length === 1),
  ];

  console.log(`\nالدور المفحوص: ${posture.role_name}`);
  console.log(
    "استخدم MIGRATION_DATABASE_URL لدور الترحيل، وDATABASE_URL لدور التطبيق المحدود.",
  );

  if (results.some((passed) => !passed)) {
    throw new Error("قاعدة البيانات لا تحقق الحد الأدنى الآمن أعلاه");
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      `\nفشل فحص الجاهزية: ${error instanceof Error ? error.message : "خطأ غير معروف"}`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
