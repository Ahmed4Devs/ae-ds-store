import { cookies } from "next/headers";
import { cache } from "react";

/**
 * تذكّر إغلاق شريط الإعلان.
 *
 * تُخزَّن الحالة في كوكي تُقرأ على الخادم — كنمط المظهر واللغة — فلا يظهر
 * الشريط ثم يختفي (وميض) لمن أغلقه. مغلّفة بـ cache() لتُقرأ مرة واحدة
 * في الطلب الواحد.
 */
export const BANNER_COOKIE = "ae_ds_banner";

export const getBannerDismissed = cache(async (): Promise<boolean> => {
  const store = await cookies();
  return store.get(BANNER_COOKIE)?.value === "1";
});
