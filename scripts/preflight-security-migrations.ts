import "dotenv/config";
import pg from "pg";
import { safeErrorKind } from "@/lib/safe-log";

interface PreflightCounts {
  duplicate_account_identities: number;
  invalid_users: number;
  invalid_sessions: number;
  invalid_accounts: number;
  invalid_verifications: number;
  invalid_products: number;
  invalid_product_skus: number;
  invalid_orders: number;
  invalid_order_items: number;
  invalid_ae_orders: number;
  invalid_payment_intents: number;
  invalid_api_logs: number;
  invalid_fx_rates: number;
  invalid_ae_tokens: number;
}

const labels: Record<keyof PreflightCounts, string> = {
  duplicate_account_identities: "هويات Better Auth المكررة",
  invalid_users: "صفوف user غير المتوافقة",
  invalid_sessions: "صفوف session غير المتوافقة",
  invalid_accounts: "صفوف account غير المتوافقة",
  invalid_verifications: "صفوف verification غير المتوافقة",
  invalid_products: "صفوف Product غير المتوافقة",
  invalid_product_skus: "صفوف ProductSku غير المتوافقة",
  invalid_orders: "صفوف Order غير المتوافقة",
  invalid_order_items: "صفوف OrderItem غير المتوافقة",
  invalid_ae_orders: "صفوف AeOrder غير المتوافقة",
  invalid_payment_intents: "صفوف PaymentIntent غير المتوافقة",
  invalid_api_logs: "صفوف AeApiLog غير المتوافقة",
  invalid_fx_rates: "صفوف FxRate غير المتوافقة",
  invalid_ae_tokens: "صفوف AeToken غير المتوافقة",
};

async function main(): Promise<void> {
  const connectionString =
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL_MISSING");
  const protocol = new URL(connectionString).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("DATABASE_URL_PROTOCOL");
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // لا نعرض أي قيمة أو معرّف: العدد وحده يكفي لاتخاذ قرار إيقاف النشر.
    const result = await client.query<PreflightCounts>(`
      SELECT
        (SELECT count(*) FROM (
          SELECT 1 FROM "account"
          GROUP BY "providerId", "accountId"
          HAVING count(*) > 1
        ) duplicates)::int AS duplicate_account_identities,
        (SELECT count(*) FROM "user" WHERE
          length("id") NOT BETWEEN 1 AND 128
          OR length("name") NOT BETWEEN 2 AND 100
          OR "name" ~ '[[:cntrl:]]'
          OR length("email") NOT BETWEEN 3 AND 254
          OR "email" <> lower(btrim("email"))
          OR "email" ~ '[[:cntrl:][:space:]]'
          OR "email" !~ '^[^@]+@[^@]+$'
          OR ("image" IS NOT NULL AND (
            length("image") > 2048 OR "image" NOT LIKE 'https://%'
          )))::int AS invalid_users,
        (SELECT count(*) FROM "session" WHERE
          length("id") NOT BETWEEN 1 AND 128
          OR length("token") NOT BETWEEN 20 AND 512
          OR ("ipAddress" IS NOT NULL AND (
            length("ipAddress") > 64 OR "ipAddress" ~ '[[:cntrl:]]'
          ))
          OR ("userAgent" IS NOT NULL AND (
            length("userAgent") > 512 OR "userAgent" ~ '[[:cntrl:]]'
          ))
          OR "expiresAt" <= "createdAt")::int AS invalid_sessions,
        (SELECT count(*) FROM "account" WHERE
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
          OR ("scope" IS NOT NULL AND length("scope") > 4096))::int AS invalid_accounts,
        (SELECT count(*) FROM "verification" WHERE
          length("id") NOT BETWEEN 1 AND 128
          OR length("identifier") NOT BETWEEN 1 AND 512
          OR "identifier" ~ '[[:cntrl:]]'
          OR length("value") NOT BETWEEN 1 AND 4096
          OR "expiresAt" <= "createdAt")::int AS invalid_verifications,
        (SELECT count(*) FROM "Product" WHERE
          length("title") NOT BETWEEN 1 AND 1000
          OR "title" ~ '[[:cntrl:]]'
          OR ("titleAr" IS NOT NULL AND length("titleAr") > 1000)
          OR ("description" IS NOT NULL AND octet_length("description") > 131072)
          OR ("categoryName" IS NOT NULL AND length("categoryName") > 512)
          OR ("properties" IS NOT NULL AND octet_length("properties"::text) > 524288))::int
          AS invalid_products,
        (SELECT count(*) FROM "ProductSku" WHERE
          ("variantLabel" IS NOT NULL AND length("variantLabel") > 1000)
          OR ("imageUrl" IS NOT NULL AND (
            length("imageUrl") > 32768
            OR NOT (
              "imageUrl" LIKE 'https://%'
              OR "imageUrl" LIKE 'data:image/svg+xml,%'
              OR "imageUrl" LIKE 'data:image/svg+xml;utf8,%'
            )
          )))::int AS invalid_product_skus,
        (SELECT count(*) FROM "Order" WHERE
          ("cancelReason" IS NOT NULL AND (
            length("cancelReason") > 500 OR "cancelReason" ~ '[[:cntrl:]]'
          ))
          OR abs("totalSar" - "subtotalSar" - "shippingSar" - "vatSar") > 0.05)::int
          AS invalid_orders,
        (SELECT count(*) FROM "OrderItem" WHERE
          ("imageSnapshot" IS NOT NULL AND (
            length("imageSnapshot") > 32768
            OR NOT (
              "imageSnapshot" LIKE 'https://%'
              OR "imageSnapshot" LIKE 'data:image/svg+xml,%'
              OR "imageSnapshot" LIKE 'data:image/svg+xml;utf8,%'
            )
          ))
          OR ("minDeliveryDays" IS NOT NULL AND "minDeliveryDays" > 3650)
          OR ("maxDeliveryDays" IS NOT NULL AND "maxDeliveryDays" > 3650))::int
          AS invalid_order_items,
        (SELECT count(*) FROM "AeOrder" WHERE
          ("aeOrderStatus" IS NOT NULL AND (
            length("aeOrderStatus") > 128 OR "aeOrderStatus" ~ '[[:cntrl:]]'
          ))
          OR ("aeLogisticsStatus" IS NOT NULL AND (
            length("aeLogisticsStatus") > 128 OR "aeLogisticsStatus" ~ '[[:cntrl:]]'
          )))::int AS invalid_ae_orders,
        (SELECT count(*) FROM "PaymentIntent" WHERE
          length("providerRef") > 160
          OR ("checkoutUrl" IS NOT NULL AND "checkoutUrl" ~ '[[:cntrl:]]')
          OR ("failureCode" IS NOT NULL AND "failureCode" ~ '[[:cntrl:]]')
          OR ("failureMessage" IS NOT NULL AND "failureMessage" ~ '[[:cntrl:]]')
          OR ("provider" = 'manual' AND "checkoutUrl" IS NOT NULL))::int
          AS invalid_payment_intents,
        (SELECT count(*) FROM "AeApiLog" WHERE
          length("apiName") NOT BETWEEN 1 AND 128
          OR "mode" NOT IN ('mock', 'live')
          OR ("errorCode" IS NOT NULL AND length("errorCode") > 128)
          OR ("errorMessage" IS NOT NULL AND length("errorMessage") > 1000)
          OR ("requestSummary" IS NOT NULL AND octet_length("requestSummary"::text) > 262144))::int
          AS invalid_api_logs,
        (SELECT count(*) FROM "FxRate" WHERE
          length("source") NOT BETWEEN 1 AND 100 OR "source" ~ '[[:cntrl:]]')::int
          AS invalid_fx_rates,
        (SELECT count(*) FROM "AeToken" WHERE
          length("accessToken") NOT BETWEEN 1 AND 262144
          OR ("refreshToken" IS NOT NULL AND length("refreshToken") > 262144)
          OR ("lastError" IS NOT NULL AND (
            length("lastError") > 500 OR "lastError" ~ '[[:cntrl:]]'
          )))::int AS invalid_ae_tokens
    `);

    const counts = result.rows[0];
    if (!counts) throw new Error("PREFLIGHT_RESULT_MISSING");

    console.log("\n=== فحص ما قبل الترحيلات الأمنية (read-only) ===\n");
    let total = 0;
    for (const key of Object.keys(labels) as Array<keyof PreflightCounts>) {
      const count = counts[key];
      total += count;
      console.log(`  ${count === 0 ? "✓" : "✗"} ${labels[key]}: ${count}`);
    }

    if (total > 0) {
      throw new Error("SECURITY_MIGRATION_PREFLIGHT_FAILED");
    }
    console.log("\nنجح فحص ما قبل الترحيلات: لا تعارضات بيانات معروفة.\n");
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("فشل فحص ما قبل الترحيلات:", safeErrorKind(error));
  process.exitCode = 1;
});
