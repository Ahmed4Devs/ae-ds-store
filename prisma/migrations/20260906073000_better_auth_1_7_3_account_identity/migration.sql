-- Better Auth 1.7.3 restored the stable 1.6 account identity. Versions
-- 1.7.0–1.7.2 required issuer, but new rows no longer write it. Keep the old
-- data reversibly while enforcing the provider-scoped identity now queried by
-- the runtime. A duplicate preflight is required before this migration.

ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;

DROP INDEX "account_issuer_accountId_key";

CREATE UNIQUE INDEX "account_providerId_accountId_key"
  ON "account"("providerId", "accountId");
