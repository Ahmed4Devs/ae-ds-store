import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { Badge, Card, EmptyState } from "@/components/ui";
import { SyncOrdersButton } from "@/components/retry-sourcing";
import { prisma } from "@/lib/db";
import { formatDateAr } from "@/lib/ksa";
import { getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.admin.apiLog };
}

export default async function ApiLogPage(props: PageProps<"/admin/api-log">) {
  // حارس ذاتي — لا يُكتفى بحماية التخطيط (راجع requireAdmin). يسبق كل قراءة.
  await requireAdmin();
  const sp = await props.searchParams;
  const onlyFailed = sp.failed === "1";

  const [t, locale] = await Promise.all([getDictionary(), getLocale()]);

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
        <h1 className="text-2xl font-bold">{t.admin.apiCallLog}</h1>
        <SyncOrdersButton labels={{ sync: t.admin.syncNow, syncing: t.admin.syncing }} />
      </div>

      {perApi.size > 0 && (
        <Card className="mb-6 overflow-hidden">
          <p className="border-b border-(--color-border-app) px-5 py-3 font-semibold">
            {t.admin.perApiSummary}
          </p>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-(--color-background) text-xs text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colApi}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colSuccess}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colFail}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t.admin.colAvgTime}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-(--color-border-app)">
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
                    <td className="px-4 py-2.5 text-ink-500 nums">{s.avgMs} {t.admin.ms}</td>
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
              : "border-(--color-border-app) hover:border-brand-400")
          }
        >
          {t.common.all}
        </Link>
        <Link
          href="/admin/api-log?failed=1"
          className={
            "rounded-full border px-3.5 py-1.5 text-sm " +
            (onlyFailed
              ? "border-brand-600 bg-brand-600 text-white"
              : "border-(--color-border-app) hover:border-brand-400")
          }
        >
          {t.admin.onlyFailed}
        </Link>
      </div>

      {logs.length === 0 ? (
        <EmptyState title={t.admin.noLogs} />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-(--color-border-app) text-sm">
            {logs.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 p-3">
                <Badge tone={l.success ? "success" : "danger"}>
                  {l.success ? t.admin.succeeded : t.admin.failed}
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
                  <Badge tone="danger">{t.admin.notRetryableBadge}</Badge>
                )}
                {l.retryable === true && <Badge tone="warning">{t.admin.retryableBadge}</Badge>}
                <span className="ms-auto shrink-0 text-xs text-ink-500 nums">
                  {l.durationMs} {t.admin.ms} · {formatDateAr(l.createdAt, locale)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
