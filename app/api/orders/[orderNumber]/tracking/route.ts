import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { ownsGuestOrder } from "@/lib/guest-orders";
import { syncOrderIfStale } from "@/lib/order-sync";
import type { OrderTrackingDto } from "@/lib/query/keys";
import { isOrderNumber } from "@/lib/order-number";
import { serializeTrackingNodes } from "@/lib/tracking";

/**
 * حالة الطلبية وبيانات تتبّعها.
 *
 * يُستدعى دوريًا من صفحة الطلب لأن واجهات AliExpress لا توفّر إشعارات
 * فورية (webhooks)، فالاستقصاء هو السبيل الوحيد لرصد تغيّر الحالة.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/orders/[orderNumber]/tracking">,
): Promise<NextResponse> {
  const { orderNumber } = await ctx.params;

  if (!isOrderNumber(orderNumber)) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, userId: true, status: true },
  });

  if (!order) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // التحقق من الملكية: طلبية الحساب لصاحبها، وطلبية الضيف للمتصفّح الذي
  // أنشأها. نعيد 404 (لا 403) في الحالتين حتى لا تصير الاستجابة أوراكلًا
  // يكشف وجود الطلبية للمتطفّلين.
  const authorized = order.userId
    ? (await getCurrentUser())?.id === order.userId
    : await ownsGuestOrder(orderNumber);

  if (!authorized) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // يستقصي من AliExpress فقط إن مضى الفاصل الأدنى — الحارس داخل الدالة
  await syncOrderIfStale(order.id);

  const fresh = await prisma.order.findUnique({
    where: { id: order.id },
    select: {
      status: true,
      aeOrders: {
        select: {
          packages: {
            select: {
              mailNo: true,
              carrierName: true,
              cpName: true,
              cpWebsiteUrl: true,
              etaAt: true,
              nodes: true,
            },
          },
        },
      },
    },
  });

  const dto: OrderTrackingDto = {
    status: fresh?.status ?? order.status,
    packages: (fresh?.aeOrders ?? []).flatMap((ae) =>
      ae.packages.map((p) => ({
        mailNo: p.mailNo,
        carrierName: p.carrierName,
        cpName: p.cpName,
        cpWebsiteUrl: p.cpWebsiteUrl,
        etaAt: p.etaAt?.toISOString() ?? null,
        nodes: serializeTrackingNodes(p.nodes),
      })),
    ),
    updatedAt: new Date().toISOString(),
  };

  return NextResponse.json(dto, {
    headers: { "Cache-Control": "no-store" },
  });
}
