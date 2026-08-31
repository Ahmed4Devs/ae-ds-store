import "dotenv/config";
import { prisma } from "@/lib/db";

/** يتحقق أن Prisma يستعلم في المخطّط الصحيح لا في public. */
(async () => {
  // AeApiLog و ProductSku موجودان في nextstore فقط، وغائبان عن public.
  // نجاح الاستعلام عنهما دليل قاطع على إصابة المخطّط الصحيح.
  const aeLogs = await prisma.aeApiLog.count();
  const skus = await prisma.productSku.count();
  const users = await prisma.user.count();
  const orders = await prisma.order.count();

  console.log("جداول تخص مشروعنا وحده (دليل المخطّط الصحيح):");
  console.log("  AeApiLog    :", aeLogs);
  console.log("  ProductSku  :", skus);
  console.log("جداول مشتركة الاسم مع المشروع الآخر:");
  console.log("  user        :", users);
  console.log("  Order       :", orders);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.log("✗ فشل:", (e as Error).message.split("\n").find((l) => l.trim()) ?? "");
  await prisma.$disconnect();
  process.exit(1);
});
