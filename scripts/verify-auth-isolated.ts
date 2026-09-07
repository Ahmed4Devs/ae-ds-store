import "dotenv/config";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";

/** يشغّل اختبار المصادقة المدمر داخل schema عابر لا قاعدة التطوير. */
async function main(): Promise<void> {
  const baseUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL غير مضبوط");

  const schema = `auth_test_${randomUUID().replaceAll("-", "")}`;
  if (!/^auth_test_[a-f0-9]{32}$/u.test(schema)) {
    throw new Error("اسم مخطط اختبار المصادقة غير آمن");
  }

  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.searchParams.set("schema", schema);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: isolatedUrl.toString(),
    MIGRATION_DATABASE_URL: isolatedUrl.toString(),
    NODE_ENV: "test",
    AUTH_VERIFY_TEST_DB: "true",
    AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
    MAIL_PROVIDER: "console",
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
      [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/verify-auth.ts"],
      childEnv,
    );
  } finally {
    if (created) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      console.log("isolated auth schema removed");
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
    throw new Error(`${args.slice(1).join(" ")} فشل برمز ${String(result.status)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "فشل اختبار المصادقة المعزول");
  process.exitCode = 1;
});
