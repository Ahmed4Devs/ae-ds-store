import "dotenv/config";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

/** تحقّق من سلامة حسابات المصادقة بعد البذر. */

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("\n=== تحقّق المصادقة ===\n");

  const users = await prisma.user.findMany({ include: { accounts: true } });
  check("يوجد مستخدمون", users.length >= 2, `${users.length}`);

  for (const u of users) {
    check(
      `${u.email} له سجل مصادقة`,
      u.accounts.length > 0,
      `accounts=${u.accounts.length}`,
    );
    check(
      `${u.email} له كلمة مرور مجزّأة`,
      u.accounts.some((a) => Boolean(a.password)),
    );
  }

  const admin = users.find((u) => u.role === "ADMIN");
  check("يوجد حساب مسؤول", Boolean(admin), admin?.email);

  // تسجيل دخول فعلي
  const res = await auth.api.signInEmail({
    body: { email: "admin@ae-ds-store.local", password: "Admin12345" },
    asResponse: true,
  });
  check("تسجيل دخول المسؤول ينجح", res.status === 200, `HTTP ${res.status}`);

  const bad = await auth.api
    .signInEmail({
      body: { email: "admin@ae-ds-store.local", password: "wrong-password" },
      asResponse: true,
    })
    .catch(() => ({ status: 401 }) as Response);
  check("كلمة مرور خاطئة تُرفض", bad.status !== 200, `HTTP ${bad.status}`);

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  نجح: ${passed}   |   فشل: ${failed}`);
  console.log(`${"═".repeat(50)}\n`);

  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error("فشل:", e);
  await prisma.$disconnect();
  process.exit(1);
});
