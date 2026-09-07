-- Add phishing-resistant-at-rest TOTP enrollment data and bind successful
-- second-factor verification to the exact session used for admin access.
BEGIN;

ALTER TABLE "user"
  ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "session"
  ADD COLUMN "twoFactorVerifiedAt" TIMESTAMP(3);

CREATE TABLE "twoFactor" (
  "id" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "backupCodes" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT true,
  "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),

  CONSTRAINT "twoFactor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "twoFactor_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "twoFactor_security_bounded" CHECK (
    length("id") BETWEEN 1 AND 128
    AND length("userId") BETWEEN 1 AND 128
    AND length("secret") BETWEEN 20 AND 4096
    AND octet_length("backupCodes") BETWEEN 20 AND 32768
    AND "failedVerificationCount" BETWEEN 0 AND 100
  )
);

CREATE UNIQUE INDEX "twoFactor_userId_key"
  ON "twoFactor"("userId");
CREATE INDEX "twoFactor_secret_idx"
  ON "twoFactor"("secret");

ALTER TABLE "session"
  ADD CONSTRAINT "session_second_factor_assurance" CHECK (
    "twoFactorVerifiedAt" IS NULL
    OR "twoFactorVerifiedAt" BETWEEN
      "createdAt" - INTERVAL '1 minute'
      AND "createdAt" + INTERVAL '1 minute'
  );

COMMIT;
