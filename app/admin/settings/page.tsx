import { Badge, Card } from "@/components/ui";
import { requireAdmin } from "@/lib/session";
import { AdminFxForm } from "@/components/admin-fx-form";
import { AdminTokenPanel, type AdminTokenState } from "@/components/admin-token-panel";
import { env } from "@/lib/env";
import { currentFxRate, effectiveFxRateAsync, fxHistory } from "@/lib/fx";
import { getTokenState } from "@/lib/aliexpress/token";
import { formatDateAr } from "@/lib/ksa";
import { fill, getDictionary, getLocale } from "@/lib/i18n";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.admin.settings };
}

/** حالة افتراضية حين يتعذّر قراءة التفويض — بطاقة معطّلة أفضل من صفحة ساقطة. */
const UNKNOWN_TOKEN: AdminTokenState = {
  present: false,
  expiresAt: null,
  refreshExpiresAt: null,
  lastRefreshedAt: null,
  lastError: null,
  hasRefreshToken: false,
};

export default async function AdminSettingsPage() {
  // حارس ذاتي — لا يُكتفى بحماية التخطيط (راجع requireAdmin). يسبق كل قراءة.
  await requireAdmin();
  const cfg = env();
  const [t, locale, rate, effective, history, token] = await Promise.all([
    getDictionary(),
    getLocale(),
    currentFxRate(),
    effectiveFxRateAsync(),
    fxHistory(10),
    getTokenState().catch((e: unknown) => {
      console.error("[admin] تعذّرت قراءة حالة تفويض AliExpress:", e);
      return null;
    }),
  ]);

  // وجود صف واحد على الأقل يعني أن السعر المطبَّق مصدره الجدول لا البيئة
  const fromDb = history.length > 0;

  const tokenState: AdminTokenState = token
    ? {
        present: token.present,
        expiresAt: token.expiresAt?.toISOString() ?? null,
        refreshExpiresAt: token.refreshExpiresAt?.toISOString() ?? null,
        lastRefreshedAt: token.lastRefreshedAt?.toISOString() ?? null,
        lastError: token.lastError,
        hasRefreshToken: token.hasRefreshToken,
      }
    : UNKNOWN_TOKEN;

  const cronPath = "/api/cron/sync-orders";
  // السرّ لا يُطبع أبدًا — يبقى متغيّر صدفة يقرأه المشغّل من بيئته
  const cronExample = `curl -fsS -H "Authorization: Bearer $CRON_SECRET" ${cfg.STORE_PUBLIC_URL}${cronPath}`;

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold">{t.admin.settingsTitle}</h1>

      <div className="space-y-6">
        {/* ------------------------------------------------ سعر الصرف */}
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t.admin.fxTitle}</h2>
            <Badge tone={fromDb ? "success" : "warning"}>
              {fromDb ? t.admin.fxFromDb : t.admin.fxFromEnv}
            </Badge>
          </div>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-ink-500">
            {t.admin.fxBody}
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-[--color-border-app] p-4">
              <p className="text-xs text-ink-500">{t.admin.fxCurrent}</p>
              <p className="nums mt-1 text-2xl font-bold">
                {rate.toFixed(4)}{" "}
                <span className="text-sm font-normal text-ink-500">
                  {t.admin.fxRateUnit}
                </span>
              </p>
            </div>
            <div className="rounded-lg border border-[--color-border-app] p-4">
              <p className="text-xs text-ink-500">{t.admin.fxEffective}</p>
              <p className="nums mt-1 text-2xl font-bold">
                {effective.toFixed(4)}{" "}
                <span className="text-sm font-normal text-ink-500">
                  {t.admin.fxRateUnit}
                </span>
              </p>
              <p className="nums mt-0.5 text-xs text-ink-500">
                {fill(t.admin.fxRateBase, {
                  base: rate.toFixed(4),
                  buffer: cfg.FX_BUFFER_PERCENT,
                })}
              </p>
            </div>
          </div>

          <AdminFxForm
            labels={t.admin}
            commonLabels={t.common}
            currentRate={rate}
          />

          <div className="mt-6">
            <p className="mb-2 text-sm font-semibold">{t.admin.fxHistory}</p>
            {history.length === 0 ? (
              <p className="text-sm text-ink-500">{t.admin.fxNoHistory}</p>
            ) : (
              <ul className="divide-y divide-[--color-border-app] rounded-lg border border-[--color-border-app]">
                {history.map((h, i) => (
                  <li
                    key={`${h.createdAt.toISOString()}-${i}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                  >
                    <span className="nums font-medium">{h.rate.toFixed(4)}</span>
                    <span className="text-xs text-ink-500">{h.source}</span>
                    <span className="text-xs text-ink-500">
                      {formatDateAr(h.createdAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* ------------------------------------------ تفويض AliExpress */}
        <Card className="p-5">
          <h2 className="text-lg font-semibold">{t.admin.tokenTitle}</h2>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-ink-500">
            {t.admin.tokenBody}
          </p>

          <AdminTokenPanel
            state={tokenState}
            locale={locale}
            labels={t.admin}
            isMock={cfg.AE_MODE === "mock"}
          />
        </Card>

        {/* -------------------------------------------- المهمة المجدولة */}
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t.admin.cronTitle}</h2>
            <Badge tone={cfg.CRON_SECRET ? "success" : "warning"}>
              {cfg.CRON_SECRET ? t.common.enabled : t.common.disabled}
            </Badge>
          </div>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-ink-500">
            {t.admin.cronBody}
          </p>

          <p className="nums mt-4 rounded-lg bg-[--color-background] px-3 py-2 text-sm" dir="ltr">
            {cronPath}
          </p>

          <p className="mt-3 text-sm">
            {cfg.CRON_SECRET ? t.admin.cronEnabled : t.admin.cronDisabled}
          </p>

          <pre
            dir="ltr"
            className="mt-3 overflow-x-auto scroll-thin rounded-lg bg-ink-900 p-4 text-xs leading-relaxed text-ink-100"
          >
            <code>{cronExample}</code>
          </pre>
        </Card>
      </div>
    </>
  );
}
