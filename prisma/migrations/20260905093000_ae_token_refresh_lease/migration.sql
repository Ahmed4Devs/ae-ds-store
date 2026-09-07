-- A database lease serializes OAuth refresh across horizontally scaled app
-- instances. An in-memory promise only protects one Node.js process.
ALTER TABLE "AeToken"
  ADD COLUMN "refreshLeaseId" TEXT,
  ADD COLUMN "refreshLeaseUntil" TIMESTAMP(3),
  ADD CONSTRAINT "AeToken_refresh_lease_pair" CHECK (
    ("refreshLeaseId" IS NULL AND "refreshLeaseUntil" IS NULL)
    OR ("refreshLeaseId" IS NOT NULL AND "refreshLeaseUntil" IS NOT NULL)
  );

CREATE INDEX "AeToken_refreshLeaseUntil_idx" ON "AeToken"("refreshLeaseUntil");
