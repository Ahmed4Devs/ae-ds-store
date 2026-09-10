-- Persist the provider-facing refund reason so retries are deterministic.
ALTER TABLE "RefundRequest"
  ADD COLUMN "providerReason" TEXT NOT NULL DEFAULT 'requested_by_customer';

ALTER TABLE "RefundRequest"
  ADD CONSTRAINT "RefundRequest_provider_reason_known" CHECK (
    "providerReason" IN ('duplicate', 'fraudulent', 'requested_by_customer')
  );
