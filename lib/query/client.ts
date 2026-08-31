import { QueryClient, defaultShouldDehydrateQuery, isServer } from "@tanstack/react-query";
import { cache } from "react";

/**
 * إعداد TanStack Query.
 *
 * النمط المعتمد هو الجلب المسبق على الخادم ثم الترطيب على العميل:
 * مكوّن الخادم يملأ الذاكرة المؤقتة ويمرّرها في HTML، فيبدأ العميل
 * ببيانات جاهزة بلا وميض تحميل، ثم تتولّى المكتبة إعادة الجلب
 * والاستقصاء وإبطال الذاكرة.
 */

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /**
         * مدة اعتبار البيانات طازجة.
         * القيمة الافتراضية صفر تعني إعادة جلب فورية على العميل لكل ما
         * جُلب على الخادم — وهو ما يُبطل فائدة الترطيب. ستون ثانية كافية
         * لتفادي ذلك دون تقادم محسوس.
         */
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // أخطاء العميل (4xx) لا تُعاد — إعادتها تُغرق الخادم بلا فائدة
          const status = (error as { status?: number })?.status;
          if (status && status >= 400 && status < 500) return false;
          return failureCount < 2;
        },
        refetchOnWindowFocus: false,
      },
      dehydrate: {
        /**
         * تضمين الاستعلامات المعلّقة في الترطيب.
         * يتيح بدء الجلب على الخادم دون انتظاره، فيصل الـ HTML أسرع
         * ويستأنف العميل الاستعلام نفسه.
         */
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * عميل الاستعلامات.
 *
 * على الخادم: نسخة جديدة لكل طلب — مغلّفة بـ cache() فتُشارَك بين
 * مكوّنات الطلب الواحد ولا تتسرّب بيانات مستخدم إلى آخر.
 * على المتصفّح: نسخة واحدة تدوم مع الصفحة.
 */
export const getQueryClient = cache((): QueryClient => {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
});
