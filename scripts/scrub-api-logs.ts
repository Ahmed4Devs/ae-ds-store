import "dotenv/config";
import { prisma } from "@/lib/db";
import { redact } from "@/lib/aliexpress/client";

/**
 * تنظيف لمرّة واحدة: يعيد حجب requestSummary في سجلّات AeApiLog القديمة
 * التي كُتبت قبل إصلاح الحجب العميق، فما زالت تحمل بيانات عملاء بنصّ صريح.
 *
 * يُشغَّل بـ: npx tsx scripts/scrub-api-logs.ts
 * يعمل على قاعدة DATABASE_URL الحالية. لتنظيف قاعدة أخرى (مثل nextstore
 * القديمة) شغّله مع DATABASE_URL مختلف.
 */

async function main(): Promise<void> {
  const rows = await prisma.aeApiLog.findMany({
    select: { id: true, requestSummary: true },
  });

  let scrubbed = 0;
  for (const row of rows) {
    if (!row.requestSummary || typeof row.requestSummary !== "object") continue;

    const before = JSON.stringify(row.requestSummary);
    const after = redact(row.requestSummary as Record<string, unknown>);
    const afterStr = JSON.stringify(after);

    if (afterStr !== before) {
      await prisma.aeApiLog.update({
        where: { id: row.id },
        data: { requestSummary: after as object },
      });
      scrubbed++;
    }
  }

  console.log(`فُحص ${rows.length} سجلًّا، وأُعيد حجب ${scrubbed} منها.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("فشل التنظيف:", e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
