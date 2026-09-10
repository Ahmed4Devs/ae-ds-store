-- Durable post-payment work, full-refund ledger, and append-only admin audit.
-- Every new Order column is nullable so existing rows remain valid and can be
-- reviewed/backfilled without inventing historical facts.

ALTER TABLE "Order"
  ADD COLUMN "manualReviewCode" TEXT,
  ADD COLUMN "manualReviewNote" TEXT,
  ADD COLUMN "manualReviewOpenedAt" TIMESTAMP(3),
  ADD COLUMN "manualReviewResolvedAt" TIMESTAMP(3),
  ADD COLUMN "refundedAt" TIMESTAMP(3);

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_manual_review_code_bounded" CHECK (
    "manualReviewCode" IS NULL OR (
      length("manualReviewCode") BETWEEN 1 AND 100
      AND "manualReviewCode" ~ '^[A-Z0-9_:-]+$'
    )
  ),
  ADD CONSTRAINT "Order_manual_review_note_bounded" CHECK (
    "manualReviewNote" IS NULL OR (
      length("manualReviewNote") BETWEEN 1 AND 1000
      AND "manualReviewNote" !~ '[[:cntrl:]]'
    )
  );

CREATE TYPE "OrderJobKind" AS ENUM ('SOURCE_ORDER');
CREATE TYPE "OrderJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD');

CREATE TABLE "OrderJob" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "kind" "OrderJobKind" NOT NULL DEFAULT 'SOURCE_ORDER',
  "status" "OrderJobStatus" NOT NULL DEFAULT 'PENDING',
  "dedupeKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 6,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderJob_attempts_valid" CHECK (
    "attempts" BETWEEN 0 AND 100 AND "maxAttempts" BETWEEN 1 AND 20
  ),
  CONSTRAINT "OrderJob_dedupe_key_bounded" CHECK (
    length("dedupeKey") BETWEEN 1 AND 160 AND "dedupeKey" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "OrderJob_lease_token_bounded" CHECK (
    "leaseToken" IS NULL OR length("leaseToken") BETWEEN 16 AND 128
  ),
  CONSTRAINT "OrderJob_error_code_bounded" CHECK (
    "lastErrorCode" IS NULL OR (
      length("lastErrorCode") BETWEEN 1 AND 100
      AND "lastErrorCode" ~ '^[A-Z0-9_:-]+$'
    )
  )
);

CREATE UNIQUE INDEX "OrderJob_dedupeKey_key" ON "OrderJob"("dedupeKey");
CREATE UNIQUE INDEX "OrderJob_orderId_kind_key" ON "OrderJob"("orderId", "kind");
CREATE INDEX "OrderJob_status_nextAttemptAt_idx" ON "OrderJob"("status", "nextAttemptAt");
CREATE INDEX "OrderJob_orderId_status_idx" ON "OrderJob"("orderId", "status");
CREATE INDEX "OrderJob_leaseExpiresAt_idx" ON "OrderJob"("leaseExpiresAt");

ALTER TABLE "OrderJob"
  ADD CONSTRAINT "OrderJob_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "RefundStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REQUIRES_REVIEW'
);

CREATE TABLE "RefundRequest" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "paymentIntentId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerRefundRef" TEXT,
  "amountSar" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorNote" TEXT,
  "submittedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RefundRequest_amount_positive" CHECK ("amountSar" > 0),
  CONSTRAINT "RefundRequest_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "RefundRequest_provider_known" CHECK ("provider" IN ('manual', 'moyasar', 'tap')),
  CONSTRAINT "RefundRequest_reason_bounded" CHECK (
    length("reason") BETWEEN 3 AND 500 AND "reason" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "RefundRequest_actor_bounded" CHECK (
    length("requestedByUserId") BETWEEN 1 AND 128 AND "requestedByUserId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "RefundRequest_attempts_valid" CHECK (
    "attempts" BETWEEN 0 AND 100 AND "maxAttempts" BETWEEN 1 AND 20
  ),
  CONSTRAINT "RefundRequest_operational_text_bounded" CHECK (
    ("idempotencyKey" <> '' AND length("idempotencyKey") <= 160 AND "idempotencyKey" !~ '[[:cntrl:]]')
    AND ("providerRefundRef" IS NULL OR (length("providerRefundRef") BETWEEN 1 AND 160 AND "providerRefundRef" !~ '[[:cntrl:]]'))
    AND ("leaseToken" IS NULL OR length("leaseToken") BETWEEN 16 AND 128)
    AND ("lastErrorCode" IS NULL OR (length("lastErrorCode") BETWEEN 1 AND 100 AND "lastErrorCode" ~ '^[A-Z0-9_:-]+$'))
    AND ("lastErrorNote" IS NULL OR (length("lastErrorNote") BETWEEN 1 AND 500 AND "lastErrorNote" !~ '[[:cntrl:]]'))
  )
);

CREATE UNIQUE INDEX "RefundRequest_idempotencyKey_key" ON "RefundRequest"("idempotencyKey");
CREATE UNIQUE INDEX "RefundRequest_providerRefundRef_key" ON "RefundRequest"("providerRefundRef");
CREATE UNIQUE INDEX "RefundRequest_paymentIntentId_key" ON "RefundRequest"("paymentIntentId");
CREATE INDEX "RefundRequest_status_nextAttemptAt_idx" ON "RefundRequest"("status", "nextAttemptAt");
CREATE INDEX "RefundRequest_orderId_createdAt_idx" ON "RefundRequest"("orderId", "createdAt");
CREATE INDEX "RefundRequest_paymentIntentId_status_idx" ON "RefundRequest"("paymentIntentId", "status");
CREATE INDEX "RefundRequest_leaseExpiresAt_idx" ON "RefundRequest"("leaseExpiresAt");

ALTER TABLE "RefundRequest"
  ADD CONSTRAINT "RefundRequest_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "RefundRequest_paymentIntentId_fkey"
  FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AdminAuditLog" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminAuditLog_fields_bounded" CHECK (
    length("actorUserId") BETWEEN 1 AND 128
    AND length("action") BETWEEN 1 AND 100
    AND "action" ~ '^[A-Z0-9_:-]+$'
    AND length("targetType") BETWEEN 1 AND 64
    AND "targetType" ~ '^[A-Z][A-Za-z0-9_]*$'
    AND length("targetId") BETWEEN 1 AND 160
    AND "actorUserId" !~ '[[:cntrl:]]'
    AND "targetId" !~ '[[:cntrl:]]'
    AND ("reason" IS NULL OR (length("reason") BETWEEN 3 AND 500 AND "reason" !~ '[[:cntrl:]]'))
    AND ("metadata" IS NULL OR octet_length("metadata"::text) <= 8192)
  )
);

CREATE INDEX "AdminAuditLog_actorUserId_createdAt_idx" ON "AdminAuditLog"("actorUserId", "createdAt");
CREATE INDEX "AdminAuditLog_targetType_targetId_createdAt_idx" ON "AdminAuditLog"("targetType", "targetId", "createdAt");
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");
