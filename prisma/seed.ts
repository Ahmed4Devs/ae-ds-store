import "dotenv/config";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

/**
 * بذر بيانات التطوير.
 * يُشغَّل بـ: npm run db:seed
 *
 * ينشئ حساب مسؤول وحساب عميل. لا يبذر منتجات لأن الكتالوج يُجلب حيًّا
 * من AliExpress (أو من طبقة المحاكاة في وضع mock).
 */

const ADMIN = {
  name: "مدير المتجر",
  email: "admin@ae-ds-store.local",
  password: "Admin12345",
};

const CUSTOMER = {
  name: "عميل تجريبي",
  email: "customer@ae-ds-store.local",
  password: "Customer12345",
};

async function ensureUser(
  input: { name: string; email: string; password: string },
  role: "ADMIN" | "CUSTOMER",
) {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, accounts: { select: { id: true, password: true } } },
  });

  if (existing) {
    // صف مستخدم بلا سجل مصادقة يعني حسابًا لا يمكن الدخول إليه —
    // ينشأ عن إنشاء متعثّر. نحذفه ونعيد الإنشاء بدل تركه معطوبًا.
    const hasCredentials = existing.accounts.some((a) => Boolean(a.password));
    if (hasCredentials) {
      await prisma.user.update({ where: { id: existing.id }, data: { role } });
      console.log(`  • موجود مسبقًا: ${input.email} (${role})`);
      return existing.id;
    }

    await prisma.user.delete({ where: { id: existing.id } });
    console.log(`  ↻ حُذف حساب معطوب بلا كلمة مرور: ${input.email}`);
  }

  // إنشاء الحساب عبر better-auth ليُجزَّأ كلمة المرور بالطريقة الصحيحة
  await auth.api.signUpEmail({
    body: { name: input.name, email: input.email, password: input.password },
  });

  const created = await prisma.user.update({
    where: { email: input.email },
    data: { role, emailVerified: true },
    select: { id: true },
  });

  console.log(`  ✓ أُنشئ: ${input.email} (${role})`);
  return created.id;
}

async function main() {
  console.log("\n=== بذر بيانات التطوير ===\n");

  const adminId = await ensureUser(ADMIN, "ADMIN");
  const customerId = await ensureUser(CUSTOMER, "CUSTOMER");

  // عنوان افتراضي للعميل
  const hasAddress = await prisma.address.findFirst({
    where: { userId: customerId },
    select: { id: true },
  });

  if (!hasAddress) {
    await prisma.address.create({
      data: {
        userId: customerId,
        fullName: "عميل تجريبي",
        phone: "512345678",
        country: "SA",
        province: "الرياض",
        city: "الرياض",
        addressLine1: "طريق الملك فهد، حي العليا، مبنى 7",
        postalCode: "12211",
        nationalAddr: "RRDA2929",
        isDefault: true,
      },
    });
    console.log("  ✓ أُضيف عنوان افتراضي للعميل");
  }

  // سعر صرف مرجعي
  await prisma.fxRate.create({
    data: {
      baseCurrency: "USD",
      quoteCurrency: "SAR",
      rate: 3.75,
      source: "seed",
    },
  });

  console.log(`\n  المسؤول : ${ADMIN.email} / ${ADMIN.password}`);
  console.log(`  العميل  : ${CUSTOMER.email} / ${CUSTOMER.password}`);
  console.log(`\n  معرّفات: admin=${adminId} customer=${customerId}\n`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("فشل البذر:", e);
  await prisma.$disconnect();
  process.exit(1);
});
