import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { searchProducts } from "@/lib/aliexpress";
import { fetchAndMirrorProduct } from "@/lib/catalog";
import { safeErrorKind } from "@/lib/safe-log";

/**
 * بذر بيانات تطوير صريح وغير قابل لإعادة التشغيل فوق حسابات قائمة.
 *
 * لا توجد بيانات اعتماد افتراضية هنا. يجب أن يضبط المشغّل القيم الست
 * في بيئته، وأن يؤكد صراحةً أن الهدف قاعدة تطوير. ننشئ المستخدم وسجل
 * الاعتماد في معاملة واحدة ولا ننشئ جلسة ولا نرسل بريدًا.
 */

const SEED_PRODUCTS = 8;

const seedUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  // عشرون محرفًا تسمح بعبارة مرور طويلة من دون فرض قواعد تركيب هشة.
  password: z.string().min(20).max(128),
});

type SeedUser = z.infer<typeof seedUserSchema>;

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} مطلوب للبذر`);
  return value;
}

function assertDevelopmentDatabaseTarget(): void {
  const rawUrl = requiredEnvironmentValue("DATABASE_URL");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL غير صالح للبذر");
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("البذر يقبل رابط PostgreSQL فقط");
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const schema = url.searchParams.get("schema") || "public";
  if (!database || !schema) {
    throw new Error("DATABASE_URL يجب أن يحدد اسم قاعدة ومخططًا صريحين");
  }

  // التأكيد مرتبط بالهدف نفسه؛ تغيير DATABASE_URL لاحقًا لا يعيد استخدام
  // عبارة ثابتة كانت قد وافقت على قاعدة أخرى بالخطأ.
  const port = url.port || "5432";
  const expectedConfirmation = `seed:${url.hostname}:${port}:${database}:${schema}`;
  if (process.env.SEED_CONFIRM !== expectedConfirmation) {
    throw new Error(
      "رُفض البذر: يجب أن يساوي SEED_CONFIRM الصيغة seed:<host>:<port>:<database>:<schema> المطابقة تمامًا لـ DATABASE_URL.",
    );
  }
}

function loadSeedUsers(): { admin: SeedUser; customer: SeedUser } {
  if (process.env.NODE_ENV !== "development") {
    throw new Error(
      "البذر مخصّص للتطوير فقط: اضبط NODE_ENV=development على قاعدة تطوير معزولة.",
    );
  }

  assertDevelopmentDatabaseTarget();

  const admin = seedUserSchema.parse({
    name: requiredEnvironmentValue("SEED_ADMIN_NAME"),
    email: requiredEnvironmentValue("SEED_ADMIN_EMAIL"),
    password: requiredEnvironmentValue("SEED_ADMIN_PASSWORD"),
  });
  const customer = seedUserSchema.parse({
    name: requiredEnvironmentValue("SEED_CUSTOMER_NAME"),
    email: requiredEnvironmentValue("SEED_CUSTOMER_EMAIL"),
    password: requiredEnvironmentValue("SEED_CUSTOMER_PASSWORD"),
  });

  if (admin.email === customer.email) {
    throw new Error("يجب أن يختلف بريد المسؤول عن بريد العميل.");
  }
  if (admin.password === customer.password) {
    throw new Error("يجب ألا يشترك حسابا البذر في كلمة المرور نفسها.");
  }

  for (const user of [admin, customer]) {
    const localPart = user.email.split("@", 1)[0];
    if (
      localPart &&
      localPart.length >= 4 &&
      user.password.toLowerCase().includes(localPart)
    ) {
      throw new Error("كلمة مرور البذر يجب ألا تحتوي الجزء المحلي من البريد.");
    }
  }

  return { admin, customer };
}

async function seedUsersAndReferenceData(admin: SeedUser, customer: SeedUser) {
  // التجزئة مكلفة ولا تحتاج إبقاء معاملة قاعدة البيانات مفتوحة أثناءها.
  const [adminPassword, customerPassword] = await Promise.all([
    hashPassword(admin.password),
    hashPassword(customer.password),
  ]);

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.user.findFirst({
        where: {
          OR: [
            { email: { equals: admin.email, mode: "insensitive" } },
            { email: { equals: customer.email, mode: "insensitive" } },
          ],
        },
        select: { id: true },
      });

      if (existing) {
        throw new Error(
          "رُفض البذر: أحد حسابَي البذر موجود مسبقًا. لن تُعدَّل رتبته أو كلمة مروره.",
        );
      }

      const createCredentialUser = async (
        input: SeedUser,
        passwordHash: string,
        role: "ADMIN" | "CUSTOMER",
      ) => {
        const userId = randomUUID();
        await tx.user.create({
          data: {
            id: userId,
            name: input.name,
            email: input.email,
            // الحسابان أنشأهما مشغّل التطوير نفسه ولا يرسلان بريدًا.
            emailVerified: true,
            role,
          },
        });
        await tx.account.create({
          data: {
            id: randomUUID(),
            userId,
            providerId: "credential",
            accountId: userId,
            password: passwordHash,
          },
        });
        return userId;
      };

      await createCredentialUser(admin, adminPassword, "ADMIN");
      const customerId = await createCredentialUser(
        customer,
        customerPassword,
        "CUSTOMER",
      );

      await tx.address.create({
        data: {
          userId: customerId,
          fullName: customer.name,
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

      const seededRate = await tx.fxRate.findFirst({
        where: { source: "seed" },
        select: { id: true },
      });
      if (!seededRate) {
        await tx.fxRate.create({
          data: {
            baseCurrency: "USD",
            quoteCurrency: "SAR",
            rate: 3.75,
            source: "seed",
          },
        });
      }
    },
    { isolationLevel: "Serializable" },
  );
}

async function seedCatalog(): Promise<void> {
  const alreadyPublished = await prisma.product.count({
    where: { isPublished: true },
  });

  if (alreadyPublished > 0) {
    console.log(`  • المختارات مملوءة مسبقًا (${alreadyPublished} منتجًا)`);
    return;
  }

  const found = await searchProducts({ pageSize: SEED_PRODUCTS });
  let published = 0;

  for (const item of found.items.slice(0, SEED_PRODUCTS)) {
    try {
      await fetchAndMirrorProduct(item.aeProductId);
      await prisma.product.update({
        where: { aeProductId: item.aeProductId },
        data: { isPublished: true },
      });
      published++;
    } catch {
      // لا نطبع جسم خطأ المزوّد؛ قد يحمل معرّفات طلب أو بيانات ربط حساسة.
      console.warn(`  ! تعذّر بذر المنتج ${item.aeProductId}`);
    }
  }

  console.log(`  ✓ نُشر ${published} منتجًا في المختارات`);
}

async function main(): Promise<void> {
  const { admin, customer } = loadSeedUsers();

  console.log("\n=== بذر بيانات التطوير ===\n");
  await seedUsersAndReferenceData(admin, customer);
  console.log("  ✓ أُنشئ حساب مسؤول وحساب عميل ببيانات البيئة");
  console.log("  ✓ أُضيفت البيانات المرجعية داخل معاملة ذرّية");

  await seedCatalog();
  console.log("\nاكتمل البذر من دون طباعة بيانات اعتماد أو إنشاء جلسات.\n");
}

main()
  .catch((error: unknown) => {
    // لا نطبع Prisma/Zod Error كاملًا؛ قد يتضمن بريد البذر أو حقل اعتماد.
    console.error(`فشل البذر: ${safeErrorKind(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
