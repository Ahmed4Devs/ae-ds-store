# Security policy

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, personal
data, or payment references. Use the repository's private **Security → Report a
vulnerability** advisory. Include the affected route, expected impact, a minimal
reproduction, and whether real customer or payment data may be involved.

## Supported version

Only the latest revision of the `main` branch is supported. Security and
dependency checks run on every pull request and weekly against that revision.

## Production minimums

- Use HTTPS for both public and Better Auth URLs.
- Use a dedicated non-superuser PostgreSQL role and encrypted database transport.
- Store all secrets in the deployment secret manager, never in Git or build logs.
- Require verified email, a real mail provider, and MFA for every administrator.
- Use a distributed edge/WAF rate limit when deploying more than one app instance.
- Run `prisma migrate deploy`, the full CI suite, backups, and a restore drill
  before promoting a release.
- Rotate authentication, payment, cron, AliExpress, database, and token-encryption
  secrets immediately after suspected exposure; invalidate affected sessions and
  reconcile payment/provider records before restoring order automation.

## Administrator MFA recovery

Admin authorization requires all of the following: the `ADMIN` role, a verified
email, a verified TOTP record, and a second-factor timestamp on the current
session. Never set `twoFactorEnabled` to `true` manually.

The public auth route never exposes the enrolled TOTP URI and does not allow
browser sessions to disable MFA. Regenerating recovery codes requires both the
account password and an administrator session that already passed TOTP. TOTP
secrets are encrypted at rest, but TOTP is not phishing-resistant; operators
must still validate the origin before entering a code and protect recovery
codes as credentials.

If an administrator loses both the authenticator and every recovery code, an
authorized database operator must first verify the person's identity out of
band. In one audited transaction, disable the user's two-factor flag, delete
their `twoFactor` row, and revoke **all** their sessions. The administrator must
then sign in with the existing password, enroll again from `/account`, and save
the new recovery codes. Rotate the password too whenever compromise is
possible.

`BETTER_AUTH_SECRET` also encrypts the stored TOTP secret and recovery codes.
Rotate it before initial administrator enrollment whenever possible. An
emergency rotation afterward intentionally makes existing MFA material
unreadable, so revoke every session and perform the audited recovery/re-enrollment
flow for each administrator.

## Migration safety

Take a tested backup and apply all pending migrations to a restored staging copy
before production. Several security migrations add table-scanning constraints
and indexes; on a large database, schedule a maintenance window and inspect lock
duration. Do not use the runtime role for migrations, and do not expose
`MIGRATION_DATABASE_URL` to the application container.

Before `prisma migrate deploy`, run `npm run security:preflight` with
`MIGRATION_DATABASE_URL` pointed at the target. It is read-only and reports only
counts; it blocks duplicate Better Auth provider identities and legacy rows that
would violate the upcoming constraints. A passing preflight does not replace the
backup, restored-copy rehearsal, or maintenance window.
