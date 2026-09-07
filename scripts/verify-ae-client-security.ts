import "dotenv/config";

/**
 * اختبار أمني موجّه لناقل AliExpress الحي من دون أي اتصال خارجي.
 * يستبدل fetch باستجابات محلية ثم يحذف سجلات الاختبار التي أنشأها.
 */
async function main() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    AE_MODE: "live",
    AE_API_BASE_URL: "https://example.invalid/rest",
    AE_APP_KEY: "security-check-key-7391",
    AE_APP_SECRET: "security-check-secret-937146",
    AE_TOKEN_ENCRYPTION_KEY:
      "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    PAYMENT_PROVIDER: "manual",
  });

  // الاستيراد بعد ضبط البيئة مهم لأن env() يحتفظ بالنتيجة أول مرة.
  const { callAe } = await import("@/lib/aliexpress/client");
  const { AeApiError } = await import("@/lib/aliexpress/errors");
  const { prisma } = await import("@/lib/db");
  const testGlobal = globalThis as typeof globalThis & {
    pgPool?: { end(): Promise<void> };
  };

  const runId = `security-response-${Date.now()}`;
  let scenario = "declared";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const postedBody = args[1]?.body;
    if (!(postedBody instanceof URLSearchParams)) {
      throw new Error("جسم طلب AliExpress ليس URLSearchParams");
    }
    if (
      postedBody.get("app_key") !== "security-check-key-7391" ||
      postedBody.get("sign_method") !== "sha256" ||
      postedBody.get("timestamp") === "0" ||
      !/^[0-9A-F]{64}$/.test(postedBody.get("sign") ?? "")
    ) {
      throw new Error("تمكنت معاملات الأعمال من تجاوز معاملات المصادقة العامة");
    }

    if (scenario === "declared") {
      return new Response("TOP_SECRET_DECLARED", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(2 * 1024 * 1024 + 1),
        },
      });
    }
    if (scenario === "streamed") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (scenario === "invalid-json") {
      return new Response("<html>TOP_SECRET_BODY</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (scenario === "wrong-type") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("{}", {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const scenarios = [
    "declared",
    "streamed",
    "invalid-json",
    "wrong-type",
    "http-error",
  ];
  let checked = 0;

  try {
    for (const current of scenarios) {
      scenario = current;
      try {
        await callAe(
          `${runId}-${current}`,
          {
            app_key: "PRIVATE_OVERRIDE_KEY",
            timestamp: 0,
            sign_method: "md5",
            sign: "PRIVATE_OVERRIDE_SIGNATURE",
            keyWord: "PRIVATE_SEARCH_TERM",
            clientSecret: "PRIVATE_CLIENT_SECRET",
            nested: JSON.stringify({
              full_name: "PRIVATE_CUSTOMER_NAME",
              mobile_no: "PRIVATE_PHONE",
              order_memo: "PRIVATE_MEMO",
              logistics_service_name: "SAFE_LOGISTICS_CODE",
            }),
          },
          { requiresAuth: false },
        );
        throw new Error(`نجح سيناريو كان يجب رفضه: ${current}`);
      } catch (error) {
        if (!(error instanceof AeApiError) || error.code !== "InternalError") {
          throw error;
        }
        if (/TOP_SECRET/.test(error.message)) {
          throw new Error(`تسرّب جسم الاستجابة في الخطأ: ${current}`);
        }
        checked++;
      }
    }

    const logs = await prisma.aeApiLog.findMany({
      where: { apiName: { startsWith: runId } },
      select: { requestSummary: true, errorMessage: true },
    });
    if (logs.length !== scenarios.length) {
      throw new Error(`عدد سجلات الفشل ${logs.length} بدل ${scenarios.length}`);
    }

    const serializedLogs = JSON.stringify(logs);
    if (/PRIVATE_|TOP_SECRET|security-check-(?:key|secret)/.test(serializedLogs)) {
      throw new Error("تسرّبت بيانات حساسة إلى سجل استدعاءات AliExpress");
    }
    if (!serializedLogs.includes("SAFE_LOGISTICS_CODE")) {
      throw new Error("حجب السجل بيانات تشغيلية غير حساسة أيضًا");
    }

    console.log(`focused AliExpress response checks passed: ${checked}/5`);
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.aeApiLog.deleteMany({
      where: { apiName: { startsWith: runId } },
    });
    await prisma.$disconnect();
    await testGlobal.pgPool?.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
