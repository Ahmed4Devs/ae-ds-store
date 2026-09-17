import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * يشغّل فحص HTTP الكامل (بما فيه دخول ADMIN مع TOTP) في schema عابر، ثم
 * يوقف Next ويحذف المخطط مهما كانت النتيجة. لا تخرج بيانات الاعتماد أو سر
 * TOTP من ذاكرة العمليات، ولا يُستخدم حساب حقيقي.
 */

const MAX_SERVER_LOG_CHARS = 64 * 1024;

function run(
  args: string[],
  childEnv: NodeJS.ProcessEnv,
  stdio: "inherit" | "pipe" = "inherit",
): string {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CHILD_PROCESS_${String(result.status)}`);
  }
  return stdio === "pipe" ? String(result.stdout ?? "") : "";
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
      listener.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForReady(
  baseUrl: string,
  serverProcess: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error("NEXT_TEST_SERVER_EXITED");
    }
    try {
      const response = await fetch(
        `${baseUrl}/api/shipping?productId=1005006891234501&quantity=1`,
        { signal: AbortSignal.timeout(2_000) },
      );
      if (response.ok) return;
    } catch {
      // قد يكون Next ما زال يترجم أول مسار؛ أعد المحاولة داخل المهلة.
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 500);
    });
  }
  throw new Error("NEXT_TEST_SERVER_TIMEOUT");
}

async function stopServer(serverProcess: ChildProcess | null): Promise<void> {
  if (!serverProcess || !serverProcess.pid) return;

  // Next ينشئ عملية start-server فرعية. على Windows لا يقتل SIGTERM شجرة
  // العمليات، لذا نستخدم taskkill على PID الذي أنشأناه نحن تحديدًا. في
  // Unix نجعل العملية مجموعة مستقلة ونرسل الإشارة إلى المجموعة كلها.
  if (process.platform === "win32") {
    if (serverProcess.exitCode === null) {
      spawnSync("taskkill.exe", ["/PID", String(serverProcess.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    return;
  }

  if (serverProcess.exitCode !== null) return;
  process.kill(-serverProcess.pid, "SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => {
      serverProcess.once("exit", () => resolveExit());
    }),
    new Promise<void>((resolveTimeout) => {
      setTimeout(resolveTimeout, 5_000);
    }),
  ]);
  if (serverProcess.exitCode === null) {
    process.kill(-serverProcess.pid, "SIGKILL");
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL_MISSING");
  const parsedBase = new URL(baseUrl);
  if (!["postgres:", "postgresql:"].includes(parsedBase.protocol)) {
    throw new Error("DATABASE_URL_PROTOCOL");
  }

  const database = decodeURIComponent(parsedBase.pathname.replace(/^\//u, ""));
  const port = parsedBase.port || "5432";
  const expectedConfirmation =
    `query-test:${parsedBase.hostname}:${port}:${database}`;
  if (process.env.VERIFY_QUERY_CONFIRM !== expectedConfirmation) {
    throw new Error("VERIFY_QUERY_CONFIRM_MISMATCH");
  }

  const schema = `query_test_${randomUUID().replaceAll("-", "")}`;
  if (!/^query_test_[a-f0-9]{32}$/u.test(schema)) {
    throw new Error("QUERY_TEST_SCHEMA_INVALID");
  }

  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.searchParams.set("schema", schema);
  const runtimePort = await availablePort();
  const publicOrigin = `http://127.0.0.1:${runtimePort}`;
  const adminPassword = randomBytes(32).toString("base64url");
  const customerPassword = randomBytes(32).toString("base64url");
  const cronSecret = randomBytes(32).toString("hex");
  const runId = randomUUID();
  const adminEmail = `query-admin-${runId}@ci.example`;
  const queryTraceFile = join(tmpdir(), `ae-query-trace-${runId}.jsonl`);
  const queryTraceHook = resolve("scripts/query-trace-hook.cjs");
  await writeFile(queryTraceFile, "", { flag: "wx" });
  const nodeOptions = [
    process.env.NODE_OPTIONS?.trim(),
    `--require=${queryTraceHook}`,
  ]
    .filter(Boolean)
    .join(" ");

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: isolatedUrl.toString(),
    MIGRATION_DATABASE_URL: isolatedUrl.toString(),
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    BETTER_AUTH_URL: publicOrigin,
    STORE_PUBLIC_URL: publicOrigin,
    AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
    MAIL_PROVIDER: "console",
    AE_MODE: "mock",
    PAYMENT_PROVIDER: "manual",
    VERIFY_QUERY_TRACE_FILE: queryTraceFile,
    NODE_OPTIONS: nodeOptions,
    CRON_SECRET: cronSecret,
    VERIFY_CRON_SECRET: cronSecret,
    SEED_CONFIRM:
      `seed:${isolatedUrl.hostname}:${isolatedUrl.port || "5432"}:` +
      `${decodeURIComponent(isolatedUrl.pathname.replace(/^\//u, ""))}:${schema}`,
    SEED_ADMIN_NAME: "HTTP Security Admin",
    SEED_ADMIN_EMAIL: adminEmail,
    SEED_ADMIN_PASSWORD: adminPassword,
    SEED_CUSTOMER_NAME: "HTTP Security Customer",
    SEED_CUSTOMER_EMAIL: `query-customer-${runId}@ci.example`,
    SEED_CUSTOMER_PASSWORD: customerPassword,
  };

  const prismaCli = resolve("node_modules/prisma/build/index.js");
  const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
  const nextCli = resolve("node_modules/next/dist/bin/next");
  const client = new pg.Client({ connectionString: baseUrl });
  let created = false;
  let serverProcess: ChildProcess | null = null;
  let serverLog = "";

  try {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;

    run([prismaCli, "migrate", "deploy"], childEnv);
    run([tsxCli, "prisma/seed.ts"], childEnv);

    serverProcess = spawn(
      process.execPath,
      [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(runtimePort)],
      {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    const appendLog = (chunk: Buffer): void => {
      serverLog = `${serverLog}${chunk.toString("utf8")}`.slice(
        -MAX_SERVER_LOG_CHARS,
      );
    };
    serverProcess.stdout?.on("data", appendLog);
    serverProcess.stderr?.on("data", appendLog);
    await waitForReady(publicOrigin, serverProcess);

    const fixtureEnv = {
      ...childEnv,
      VERIFY_ADMIN_MFA_SETUP: "true",
      VERIFY_ADMIN_EMAIL: adminEmail,
      VERIFY_ADMIN_PASSWORD: adminPassword,
    };
    const totpCode = run(
      [tsxCli, "scripts/prepare-query-admin-mfa.ts"],
      fixtureEnv,
      "pipe",
    ).trim();
    if (!/^\d{6}$/u.test(totpCode)) {
      throw new Error("ADMIN_TOTP_CODE_INVALID");
    }

    run(
      [tsxCli, "scripts/verify-query.ts"],
      {
        ...childEnv,
        VERIFY_BASE_URL: publicOrigin,
        VERIFY_ADMIN_EMAIL: adminEmail,
        VERIFY_ADMIN_PASSWORD: adminPassword,
        VERIFY_ADMIN_TOTP_CODE: totpCode,
      },
    );
  } catch (error: unknown) {
    if (serverLog) process.stderr.write(serverLog);
    throw error;
  } finally {
    await stopServer(serverProcess);
    if (created) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      console.log("isolated HTTP query schema removed");
    }
    await client.end().catch(() => undefined);
    await unlink(queryTraceFile).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("isolated HTTP query verification failed:", safeErrorKind(error));
  process.exitCode = 1;
});
