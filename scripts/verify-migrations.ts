import "dotenv/config";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";

/**
 * يطبّق سلسلة الترحيلات كاملةً على schema مؤقت ثم يقارنها بمخطط Prisma.
 * لا يطبع رابط الاتصال، ويحذف المخطط حتى عند فشل الترحيل أو المقارنة.
 */
async function main(): Promise<void> {
  const baseUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL غير مضبوط");

  const schema = `security_verify_${randomUUID().replaceAll("-", "")}`;
  if (!/^security_verify_[a-f0-9]{32}$/u.test(schema)) {
    throw new Error("اسم مخطط الاختبار غير آمن");
  }

  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.searchParams.set("schema", schema);
  const command = process.execPath;
  const prismaCli = resolve("node_modules/prisma/build/index.js");
  const client = new pg.Client({ connectionString: baseUrl });
  let created = false;

  try {
    await client.connect();
    // schema مشتق من UUID وفُحص أعلاه؛ الاقتباس يمنع تفسيره كأكثر من معرّف.
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;

    const childEnv = {
      ...process.env,
      DATABASE_URL: isolatedUrl.toString(),
      MIGRATION_DATABASE_URL: isolatedUrl.toString(),
    };

    run(command, [prismaCli, "migrate", "deploy"], childEnv);
    run(
      command,
      [
        prismaCli,
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      childEnv,
    );

    console.log("isolated migration verification passed");
  } finally {
    if (created) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      console.log("isolated schema removed");
    }
    await client.end().catch(() => undefined);
  }
}

function run(command: string, args: string[], childEnv: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} فشل برمز ${String(result.status)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "فشل تحقق الترحيلات");
  process.exitCode = 1;
});
