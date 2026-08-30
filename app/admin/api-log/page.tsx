import Link from "next/link";
import { Badge, Card, EmptyState } from "@/components/ui";
import { SyncOrdersButton } from "@/components/retry-sourcing";
import { prisma } from "@/lib/db";
import { formatDateAr } from "@/lib/ksa";

export const metadata = { title: "سجل الواجهات · الإدارة" };

export default async function ApiLogPage(props: PageProps<"/admin/api-log">) {
  const sp = await props.searchParams;
  const onlyFailed = sp.failed === "1";

  const [logs, stats] = await Promise.all([
    prisma.aeApiLog.findMany({
      where: onlyFailed ? { success: false } : undefined,
      orderBy: { createdAt: "desc" },
      take: 150,
    }),
    prisma.aeApiLog.groupBy({
      by: ["apiName", "success"],
      _count: { _all: true },
      _avg: { durationMs: true },
    }),
  ]);

  // تجميع الإحصاءات لكل واجهة
  const perApi = new Map<
    string,
    { ok: number; fail: number; avgMs: number }
  >();
  for (const s of stats) {
    const cur = perApi.get(s.apiName) ?? { ok: 0, fail: 0, avgMs: 0 };
    if (s.success) cur.ok += s._count._all;
    else cur.fail += s._count._all;
    cur.avgMs = Math.round(s._avg.durationMs ?? 0);
    perApi.set(s.apiName, cur);
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">سجل استدعاءات الواجهات</h1>
        <SyncOrdersButton />
      </div>

      {perApi.size > 0 && (
        <Card className="mb-6 overflow-hidden">
          <p className="border-b border-[--color-border-app] px-5 py-3 font-semibold">
            ملخّص حسب الواجهة
          </p>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-[--color-background] text-xs text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 text-right font-medium">الواجهة</th>
                  <th className="px-4 py-2.5 text-right font-medium">نجاح</th>
                  <th className="px-4 py-2.5 text-right font-medium">فشل</th>
                  <th className="px-4 py-2.5 text-right font-medium">متوسط الزمن</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[--color-border-app]">
                {[...perApi.entries()].map(([api, s]) => (
                  <tr key={api}>
                    <td className="px-4 py-2.5">
                      <code className="font-mono text-xs" dir="ltr">{api}</code>
                    </td>
                    <td className="px-4 py-2.5 nums text-emerald-600 dark:text-emerald-400">
                      {s.ok}
                    </td>
                    <td
                      className={
                        "px-4 py-2.5 nums " +
                        (s.fail > 0 ? "text-red-600 dark:text-red-400" : "text-ink-500")
                      }
                    >
                      {s.fail}
                    </td>
                    <td className="px-4 py-2.5 text-ink-500 nums">{s.avgMs} م.ث</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="mb-4 flex gap-2">
        <Link
          href="/admin/api-log"
          className={
            "rounded-full border px-3.5 py-1.5 text-sm " +
            (!onlyFailed
              ? "border-brand-600 bg-brand-600 text-white"
              : "border-[--color-border-app] hover:border-brand-400")
          }
        >
          الكل
        </Link>
        <Link
          href="/admin/api-log?failed=1"
          className={
            "rounded-full border px-3.5 py-1.5 text-sm " +
            (onlyFailed
              ? "border-brand-600 bg-brand-600 text-white"
              : "border-[--color-border-app] hover:border-brand-400")
          }
        >
          الفاشلة فقط
        </Link>
      </div>

      {logs.length === 0 ? (
        <EmptyState title="لا توجد سجلات" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[--color-border-app] text-sm">
            {logs.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 p-3">
                <Badge tone={l.success ? "success" : "danger"}>
                  {l.success ? "نجح" : "فشل"}
                </Badge>
                <Badge tone={l.mode === "live" ? "info" : "neutral"}>{l.mode}</Badge>
                <code className="font-mono text-xs" dir="ltr">{l.apiName}</code>
                {l.errorCode && (
                  <code
                    className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200"
                    dir="ltr"
                  >
                    {l.errorCode}
                  </code>
                )}
                {l.retryable === false && !l.success && (
                  <Badge tone="danger">لا يُعاد آليًا</Badge>
                )}
                {l.retryable === true && <Badge tone="warning">قابل لإعادة المحاولة</Badge>}
                <span className="mr-auto shrink-0 text-xs text-ink-500 nums">
                  {l.durationMs} م.ث · {formatDateAr(l.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
