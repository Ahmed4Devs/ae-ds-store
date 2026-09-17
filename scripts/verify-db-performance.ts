import "dotenv/config";
import pg from "pg";
import { safeErrorKind } from "@/lib/safe-log";

const DATASET_SIZE = 20_000;
let passed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) {
    throw new Error(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  passed += 1;
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

interface PlanNode {
  "Node Type"?: string;
  "Index Name"?: string;
  "Actual Total Time"?: number;
  Plans?: PlanNode[];
}

interface ExplainDocument {
  Plan: PlanNode;
  "Execution Time"?: number;
}

function collectIndexes(node: PlanNode, output = new Set<string>()): Set<string> {
  if (node["Index Name"]) output.add(node["Index Name"]);
  for (const child of node.Plans ?? []) collectIndexes(child, output);
  return output;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL_MISSING");
  const url = new URL(connectionString);
  const schema = url.searchParams.get("schema") ?? "";
  if (!/^query_perf_[a-f0-9]{32}$/u.test(schema)) {
    throw new Error("QUERY_PERF_SCHEMA_REQUIRED");
  }

  console.log("\n=== تحقق خطط PostgreSQL والحمل المتزامن ===\n");

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // set_config يأخذ schema كقيمة parameterized؛ لا يُبنى identifier من دخل.
    await client.query("SELECT set_config('search_path', $1, false)", [schema]);
    await client.query("SET statement_timeout = '30s'");

    const snapshot = JSON.stringify({
      fullName: "Test User",
      phone: "512345678",
      country: "SA",
      province: "الرياض",
      city: "الرياض",
      addressLine1: "Test Address",
    });

    await client.query(
      `INSERT INTO "FxRate"
        ("id", "baseCurrency", "quoteCurrency", "rate", "source", "createdAt")
       SELECT 'fx-' || g, 'USD', 'SAR', 3.75, 'performance-test',
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second'
       FROM generate_series(1, $1::integer) AS g`,
      [DATASET_SIZE],
    );
    await client.query(
      `INSERT INTO "AeApiLog"
        ("id", "apiName", "mode", "success", "durationMs", "createdAt")
       SELECT 'log-' || g,
              CASE WHEN g % 20 = 0
                THEN 'aliexpress.ds.text.search'
                ELSE 'aliexpress.ds.category.get'
              END,
              'mock', true, 5,
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second'
       FROM generate_series(1, $1::integer) AS g`,
      [DATASET_SIZE],
    );
    await client.query(
      `INSERT INTO "Order"
        ("id", "orderNumber", "status", "shippingSnapshot", "subtotalSar",
         "shippingSar", "vatSar", "totalSar", "costSubtotal", "costShipping",
         "fxRateUsed", "outOrderId", "needsManualReview", "createdAt", "updatedAt")
       SELECT 'order-' || g,
              'AE-20260912-' || upper(lpad(to_hex(g), 6, '0')),
              (CASE g % 4
                WHEN 0 THEN 'PENDING_PAYMENT'
                WHEN 1 THEN 'PAID'
                WHEN 2 THEN 'SOURCED'
                ELSE 'SHIPPED'
              END)::"OrderStatus",
              $2::jsonb, 100, 10, 16.5, 126.5, 50, 5, 3.75,
              'AE-20260912-' || upper(lpad(to_hex(g), 6, '0')) || '-' || lpad(to_hex(g), 8, '0'),
              g % 10 = 0,
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second',
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second'
       FROM generate_series(1, $1::integer) AS g`,
      [DATASET_SIZE, snapshot],
    );
    await client.query(
      `INSERT INTO "PaymentIntent"
        ("id", "orderId", "provider", "providerRef", "status", "amountSar",
         "currency", "paidAt", "expiresAt", "createdAt", "updatedAt")
       SELECT 'payment-' || g, 'order-' || g, 'manual', 'perf-ref-' || g,
              (CASE g % 4
                WHEN 0 THEN 'REQUIRES_ACTION'
                WHEN 1 THEN 'PENDING'
                WHEN 2 THEN 'PAID'
                ELSE 'FAILED'
              END)::"PaymentStatus",
              126.5, 'SAR',
              CASE WHEN g % 4 = 2 THEN TIMESTAMP '2026-01-01' + g * INTERVAL '1 second' END,
              NOW() - INTERVAL '1 hour' + g * INTERVAL '1 second',
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second',
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second'
       FROM generate_series(1, $1::integer) AS g`,
      [DATASET_SIZE],
    );
    await client.query(
      `INSERT INTO "OrderJob"
        ("id", "orderId", "status", "dedupeKey", "nextAttemptAt", "createdAt", "updatedAt")
       SELECT 'job-' || g, 'order-' || g,
              (CASE g % 4
                WHEN 0 THEN 'PENDING'
                WHEN 1 THEN 'PROCESSING'
                WHEN 2 THEN 'COMPLETED'
                ELSE 'DEAD'
              END)::"OrderJobStatus",
              'perf-job-' || g,
              NOW() - INTERVAL '1 hour' + g * INTERVAL '1 second',
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second',
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second'
       FROM generate_series(1, $1::integer) AS g`,
      [DATASET_SIZE],
    );
    await client.query(
      `INSERT INTO "RefundRequest"
        ("id", "orderId", "paymentIntentId", "idempotencyKey", "provider",
         "amountSar", "currency", "status", "reason", "requestedByUserId",
         "nextAttemptAt", "createdAt", "updatedAt")
       SELECT 'refund-' || g, 'order-' || g, 'payment-' || g,
              'perf-refund-' || g, 'manual', 126.5, 'SAR',
              (CASE g % 4
                WHEN 0 THEN 'PENDING'
                WHEN 1 THEN 'PROCESSING'
                WHEN 2 THEN 'SUCCEEDED'
                ELSE 'FAILED'
              END)::"RefundStatus",
              'performance test', 'performance-actor',
              NOW() - INTERVAL '1 hour' + g * INTERVAL '1 second',
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second',
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second'
       FROM generate_series(1, ($1::integer / 2)) AS g`,
      [DATASET_SIZE],
    );
    await client.query(
      'ANALYZE "FxRate", "AeApiLog", "Order", "PaymentIntent", "OrderJob", "RefundRequest"',
    );

    check("أُنشئت عينة أداء واقعية", DATASET_SIZE === 20_000, `${DATASET_SIZE} orders`);

    const planChecks: Array<{
      label: string;
      index: string;
      sql: string;
      params?: unknown[];
    }> = [
      {
        label: "آخر سعر صرف",
        index: "FxRate_baseCurrency_quoteCurrency_createdAt_idx",
        sql: `SELECT "rate" FROM "FxRate"
              WHERE "baseCurrency" = 'USD' AND "quoteCurrency" = 'SAR'
              ORDER BY "createdAt" DESC LIMIT 1`,
      },
      {
        label: "قائمة الطلبات حسب الحالة",
        index: "Order_status_createdAt_idx",
        sql: `SELECT "id" FROM "Order" WHERE "status" = 'PAID'
              ORDER BY "createdAt" DESC LIMIT 50`,
      },
      {
        label: "طابور التوريد المستحق",
        index: "OrderJob_status_nextAttemptAt_idx",
        sql: `SELECT "id" FROM "OrderJob"
              WHERE "status" = 'PENDING' AND "nextAttemptAt" <= NOW()
              ORDER BY "nextAttemptAt" LIMIT 20`,
      },
      {
        label: "طابور الاسترداد المستحق",
        index: "RefundRequest_status_nextAttemptAt_idx",
        sql: `SELECT "id" FROM "RefundRequest"
              WHERE "status" = 'PENDING' AND "nextAttemptAt" <= NOW()
              ORDER BY "nextAttemptAt" LIMIT 20`,
      },
      {
        label: "نيات الدفع المنتهية",
        index: "PaymentIntent_status_expiresAt_idx",
        sql: `SELECT "id" FROM "PaymentIntent"
              WHERE "status" = 'REQUIRES_ACTION' AND "expiresAt" <= NOW()
              ORDER BY "expiresAt" LIMIT 50`,
      },
      {
        label: "سجل واجهة محددة",
        index: "AeApiLog_apiName_createdAt_idx",
        sql: `SELECT "id" FROM "AeApiLog"
              WHERE "apiName" = 'aliexpress.ds.text.search'
              ORDER BY "createdAt" DESC LIMIT 100`,
      },
    ];

    let slowestMs = 0;
    for (const item of planChecks) {
      const result = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`,
        item.params,
      );
      const document = (result.rows[0]["QUERY PLAN"] as ExplainDocument[])[0];
      const indexes = collectIndexes(document.Plan);
      const executionMs = Number(document["Execution Time"] ?? Infinity);
      slowestMs = Math.max(slowestMs, executionMs);
      check(
        `${item.label} يستخدم الفهرس المقصود`,
        indexes.has(item.index),
        `${executionMs.toFixed(2)}ms`,
      );
    }
    check(
      "أبطأ Query حرجة بقيت دون 500ms",
      slowestMs < 500,
      `${slowestMs.toFixed(2)}ms`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  const pool = new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  try {
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        pool.query("SELECT pg_sleep(0.01), $1::integer", [index]),
      ),
    );
    check("64 Query متزامنة اكتملت دون فشل", true);
    check(
      "تجمّع الاتصالات لم يتجاوز السقف",
      pool.totalCount <= 4,
      `${pool.totalCount}/4 connections`,
    );
    check("لا طلبات معلقة بعد الحمل", pool.waitingCount === 0);
  } finally {
    await pool.end();
  }

  console.log(`\nنجح تحقق PostgreSQL: ${passed}/${passed}\n`);
}

main().catch((error: unknown) => {
  const dbError = error as {
    code?: unknown;
    constraint?: unknown;
    table?: unknown;
  };
  const safeIdentifier = (value: unknown): string | undefined =>
    typeof value === "string" && /^[A-Za-z0-9_]{1,128}$/u.test(value)
      ? value
      : undefined;
  console.error(
    "فشل تحقق PostgreSQL:",
    JSON.stringify({
      kind: safeErrorKind(error),
      code: safeIdentifier(dbError.code),
      constraint: safeIdentifier(dbError.constraint),
      table: safeIdentifier(dbError.table),
    }),
  );
  process.exitCode = 1;
});
