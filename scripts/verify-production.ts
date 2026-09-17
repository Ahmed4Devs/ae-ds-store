import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import pg from "pg";
import { safeErrorKind } from "@/lib/safe-log";

let passed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) throw new Error(`${label}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function run(args: string[], childEnv: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CHILD_PROCESS_${String(result.status)}`);
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.unref();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("TEST_PORT_UNAVAILABLE"));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function stopServer(serverProcess: ChildProcess | null): Promise<void> {
  if (!serverProcess?.pid || serverProcess.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(serverProcess.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  process.kill(-serverProcess.pid, "SIGTERM");
  await Promise.race([
    new Promise<void>((done) => serverProcess.once("exit", () => done())),
    new Promise<void>((done) => setTimeout(done, 5_000)),
  ]);
  if (serverProcess.exitCode === null) process.kill(-serverProcess.pid, "SIGKILL");
}

async function waitForReady(origin: string, processHandle: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error("NEXT_START_EXITED");
    try {
      const response = await fetch(`${origin}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // next start ما زال يقلع.
    }
    await new Promise<void>((done) => setTimeout(done, 350));
  }
  throw new Error("NEXT_START_TIMEOUT");
}

async function main(): Promise<void> {
  const migrationBase = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const runtimeBase = process.env.DATABASE_URL;
  if (!migrationBase || !runtimeBase) throw new Error("DATABASE_URL_MISSING");

  const migrationUrl = new URL(migrationBase);
  const runtimeUrl = new URL(runtimeBase);
  const database = decodeURIComponent(migrationUrl.pathname.replace(/^\//u, ""));
  const runtimeDatabase = decodeURIComponent(runtimeUrl.pathname.replace(/^\//u, ""));
  const runtimeRole = decodeURIComponent(runtimeUrl.username);
  if (
    !["postgres:", "postgresql:"].includes(migrationUrl.protocol) ||
    migrationUrl.hostname !== runtimeUrl.hostname ||
    (migrationUrl.port || "5432") !== (runtimeUrl.port || "5432") ||
    database !== runtimeDatabase ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(runtimeRole)
  ) {
    throw new Error("PRODUCTION_TEST_DATABASE_MISMATCH");
  }

  const runId = randomUUID();
  const schema = `production_test_${runId.replaceAll("-", "")}`;
  if (!/^production_test_[a-f0-9]{32}$/u.test(schema)) {
    throw new Error("PRODUCTION_TEST_SCHEMA_INVALID");
  }
  migrationUrl.searchParams.set("schema", schema);
  runtimeUrl.searchParams.set("schema", schema);

  const runtimePort = await availablePort();
  const localOrigin = `http://127.0.0.1:${runtimePort}`;
  const publicOrigin = "https://store.example.test";
  const authSecret = randomBytes(64).toString("base64url");
  const cronSecret = randomBytes(48).toString("base64url");
  const resendKey = `re_${randomBytes(36).toString("base64url")}`;
  const adminPassword = randomBytes(32).toString("base64url");
  const customerPassword = randomBytes(32).toString("base64url");

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: runtimeUrl.toString(),
    MIGRATION_DATABASE_URL: migrationUrl.toString(),
    DB_POOL_MAX: "4",
    BETTER_AUTH_URL: publicOrigin,
    STORE_PUBLIC_URL: publicOrigin,
    BETTER_AUTH_SECRET: authSecret,
    AUTH_REQUIRE_EMAIL_VERIFICATION: "true",
    TRUSTED_PROXIES: "127.0.0.1",
    MAIL_PROVIDER: "resend",
    MAIL_FROM: "no-reply@store.example.test",
    MAIL_FROM_NAME: "Al-Wasl Store",
    RESEND_API_KEY: resendKey,
    SMTP_URL: "",
    AE_MODE: "mock",
    AE_APP_KEY: "",
    AE_APP_SECRET: "",
    AE_ACCESS_TOKEN: "",
    AE_REFRESH_TOKEN: "",
    AE_TOKEN_ENCRYPTION_KEY: "",
    PAYMENT_PROVIDER: "manual",
    MOYASAR_SECRET_KEY: "",
    MOYASAR_PUBLISHABLE_KEY: "",
    TAP_SECRET_KEY: "",
    PAYMENT_WEBHOOK_SECRET: "",
    CRON_SECRET: cronSecret,
    HERO_VIDEO_PATH: "",
    SEED_CONFIRM:
      `seed:${runtimeUrl.hostname}:${runtimeUrl.port || "5432"}:${database}:${schema}`,
    SEED_ADMIN_NAME: "Production Test Admin",
    SEED_ADMIN_EMAIL: `production-admin-${runId}@example.test`,
    SEED_ADMIN_PASSWORD: adminPassword,
    SEED_CUSTOMER_NAME: "Production Test Customer",
    SEED_CUSTOMER_EMAIL: `production-customer-${runId}@example.test`,
    SEED_CUSTOMER_PASSWORD: customerPassword,
  };

  const owner = new pg.Client({ connectionString: migrationBase });
  let created = false;
  let serverProcess: ChildProcess | null = null;
  let serverLog = "";
  try {
    await owner.connect();
    await owner.query(`CREATE SCHEMA "${schema}"`);
    created = true;

    run(
      [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
      childEnv,
    );

    // الدور مأخوذ من DATABASE_URL وفُحص كمعرّف PostgreSQL بسيط.
    await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtimeRole}"`,
    );
    await owner.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${runtimeRole}"`,
    );
    await owner.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schema}" TO "${runtimeRole}"`,
    );
    await owner.query(
      `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "${schema}"."AdminAuditLog" FROM "${runtimeRole}"`,
    );

    run(
      [resolve("node_modules/tsx/dist/cli.mjs"), "prisma/seed.ts"],
      { ...childEnv, NODE_ENV: "development" },
    );

    serverProcess = spawn(
      process.execPath,
      [
        resolve("node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(runtimePort),
      ],
      {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    const appendLog = (chunk: Buffer): void => {
      serverLog = `${serverLog}${chunk.toString("utf8")}`.slice(-32 * 1024);
    };
    serverProcess.stdout?.on("data", appendLog);
    serverProcess.stderr?.on("data", appendLog);
    await waitForReady(localOrigin, serverProcess);

    console.log("\n=== تحقق تشغيل Next.js الإنتاجي ===\n");
    const home = await fetch(`${localOrigin}/`);
    const html = await home.text();
    const csp = home.headers.get("content-security-policy") ?? "";
    check("الصفحة الرئيسية تعمل عبر next start", home.status === 200);
    check("X-Powered-By غير مكشوفة", !home.headers.has("x-powered-by"));
    check(
      "HSTS الإنتاجية مفعلة",
      (home.headers.get("strict-transport-security") ?? "").includes(
        "max-age=63072000",
      ),
    );
    check(
      "CSP الإنتاجية لا تسمح eval أو inline",
      !csp.includes("'unsafe-eval'") &&
        !csp.includes("'unsafe-inline'") &&
        csp.includes("style-src-attr 'none'") &&
        csp.includes("upgrade-insecure-requests"),
    );
    check(
      "لا تتسرب أسرار الاختبار إلى HTML",
      ![authSecret, cronSecret, resendKey].some((secret) => html.includes(secret)),
    );
    check(
      "HTML الإنتاجي ضمن 192KiB",
      Buffer.byteLength(html, "utf8") <= 192 * 1024,
      `${Buffer.byteLength(html, "utf8")} bytes`,
    );

    const resourcePaths = [
      ...new Set(
        [...html.matchAll(/(?:src|href)="([^"]+)"/giu)]
          .map((match) => match[1])
          .filter(
            (value) =>
              value.startsWith("/_next/") ||
              /^\/(?:favicon\.ico|icon\.svg)(?:\?|$)/u.test(value),
          ),
      ),
    ];
    check(
      "الأصول الأولية في الإنتاج لا تتجاوز 20 طلبًا",
      resourcePaths.length <= 20,
      String(resourcePaths.length),
    );
    const resourceResponses = await Promise.all(
      resourcePaths.map((path) => fetch(new URL(path, localOrigin))),
    );
    check(
      "كل الأصول المعلنة قابلة للتحميل",
      resourceResponses.every((response) => response.ok),
    );
    check(
      "أصول Next الثابتة تملك cache طويلًا",
      resourceResponses.every(
        (response, index) =>
          !resourcePaths[index].startsWith("/_next/static/") ||
          (response.headers.get("cache-control") ?? "").includes("immutable"),
      ),
    );

    const invalidApi = await fetch(
      `${localOrigin}/api/shipping?productId=x&quantity=1`,
    );
    check("API الإنتاجية ترفض المدخلات المشوهة", invalidApi.status === 400);
    check(
      "ردود API الإنتاجية غير قابلة للتخزين",
      (invalidApi.headers.get("cache-control") ?? "").includes("no-store"),
    );

    const resetToken = "B".repeat(24);
    const reset = await fetch(`${localOrigin}/reset-password?token=${resetToken}`, {
      redirect: "manual",
    });
    const location = reset.headers.get("location") ?? "";
    const cookie = reset.headers.getSetCookie().join(";");
    const lowerCookie = cookie.toLowerCase();
    check(
      "الاستعادة تعيد التوجيه إلى الأصل العام الموثوق",
      reset.status === 303 &&
        location === `${publicOrigin}/reset-password` &&
        !location.includes(resetToken),
    );
    check(
      "كوكي الاستعادة الإنتاجية Secure وHttpOnly",
      cookie.includes("__Secure-ae_ds_reset=") &&
        /;\s*secure(?:;|$)/iu.test(cookie) &&
        lowerCookie.includes("httponly") &&
        lowerCookie.includes("samesite=lax") &&
        lowerCookie.includes("path=/reset-password"),
    );

    console.log(`\nنجح تحقق الإنتاج: ${passed}/${passed}\n`);
  } catch (error) {
    if (serverLog) process.stderr.write(serverLog);
    throw error;
  } finally {
    await stopServer(serverProcess);
    if (created) {
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      console.log("isolated production schema removed");
    }
    await owner.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("production verification failed:", safeErrorKind(error));
  process.exitCode = 1;
});
