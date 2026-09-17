import "dotenv/config";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * ينشئ schema مؤقتًا لاختبارات خطط التنفيذ والحمل، ثم يحذفه دائمًا.
 * لا يضيف أي صف إلى قاعدة التطوير ولا يحتاج إعادة ضبط مدمّرة.
 */
async function main(): Promise<void> {
  const baseUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL_MISSING");

  const parsed = new URL(baseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL_PROTOCOL");
  }

  const schema = `query_perf_${randomUUID().replaceAll("-", "")}`;
  if (!/^query_perf_[a-f0-9]{32}$/u.test(schema)) {
    throw new Error("QUERY_PERF_SCHEMA_INVALID");
  }

  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.searchParams.set("schema", schema);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: isolatedUrl.toString(),
    MIGRATION_DATABASE_URL: isolatedUrl.toString(),
    NODE_ENV: "test",
    DB_POOL_MAX: "4",
  };

  const client = new pg.Client({ connectionString: baseUrl });
  let created = false;
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;

    run(
      [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
      childEnv,
    );
    run(
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        "scripts/verify-db-performance.ts",
      ],
      childEnv,
    );
  } finally {
    if (created) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      console.log("isolated database performance schema removed");
    }
    await client.end().catch(() => undefined);
  }
}

function run(args: string[], childEnv: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CHILD_PROCESS_${String(result.status)}`);
  }
}

main().catch((error: unknown) => {
  console.error("isolated database performance verification failed:", safeErrorKind(error));
  process.exitCode = 1;
});
