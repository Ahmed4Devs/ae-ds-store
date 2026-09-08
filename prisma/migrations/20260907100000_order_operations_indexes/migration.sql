-- فهارس قوائم الطلبات التشغيلية. لا تغيّر بيانات أو حالات قائمة.
CREATE INDEX "Order_userId_createdAt_idx"
ON "Order"("userId", "createdAt");

CREATE INDEX "Order_status_createdAt_idx"
ON "Order"("status", "createdAt");

CREATE INDEX "Order_needsManualReview_createdAt_idx"
ON "Order"("needsManualReview", "createdAt");
