import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { syncOrderIfStale } from "@/lib/order-sync";
import type { OrderTrackingDto, TrackingNodeDto } from "@/lib/query/keys";

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

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, userId: true, status: true },
  });

  if (!order) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // طلبية مرتبطة بحساب لا يقرأها إلا صاحبها
  if (order.userId) {
    const user = await getCurrentUser();
    if (user?.id !== order.userId) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
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
        nodes: ((p.nodes as unknown as TrackingNodeDto[]) ?? []).map((n) => ({
          title: n.title,
          description: n.description,
          at: typeof n.at === "string" ? n.at : new Date(n.at).toISOString(),
        })),
      })),
    ),
    updatedAt: new Date().toISOString(),
  };

  return NextResponse.json(dto, {
    headers: { "Cache-Control": "no-store" },
  });
}
