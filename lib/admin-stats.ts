import { prisma } from "@/lib/db";

function numeric(value: unknown): number {
  const parsed = Number(
    typeof value === "object" && value !== null && "toString" in value
      ? value.toString()
      : value,
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * ربحية تاريخية تستخدم fxRateUsed لكل طلبية، لا سعر الصرف الحالي. الطلبية
 * المستردة بعد التوريد لا تسجل إيرادًا، بينما تبقى تكلفتها خسارة فعلية.
 */
export async function recognizedOrderFinancials(): Promise<{
  revenueSar: number;
  costSar: number;
  grossMarginSar: number;
}> {
  const rows = await prisma.$queryRaw<
    Array<{ revenueSar: unknown; costSar: unknown }>
  >`
    SELECT
      COALESCE(SUM(
        CASE WHEN "refundedAt" IS NULL THEN "totalSar" ELSE 0 END
      ), 0)::text AS "revenueSar",
      COALESCE(SUM(
        ("costSubtotal" + "costShipping") * "fxRateUsed"
      ), 0)::text AS "costSar"
    FROM "Order"
    WHERE "status" IN (
      'SOURCED'::"OrderStatus",
      'SHIPPED'::"OrderStatus",
      'DELIVERED'::"OrderStatus"
    )
  `;
  const revenueSar = numeric(rows[0]?.revenueSar);
  const costSar = numeric(rows[0]?.costSar);
  return { revenueSar, costSar, grossMarginSar: revenueSar - costSar };
}
