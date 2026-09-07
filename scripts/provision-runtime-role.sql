-- يشغّل هذا الملف دورُ الترحيل/المالك على قاعدة المتجر نفسها، عبر psql:
--   psql "$MIGRATION_DATABASE_URL" --file=scripts/provision-runtime-role.sql
-- سيطلب psql السر تفاعليًا فلا يظهر في arguments أو shell history. للأتمتة
-- يمكن حقن app_password بوسيلة مدير الأسرار الخاصة بالمنصة، لا بسطر أوامر.

\if :{?app_password}
\else
  \prompt 'New ae_store_app password (32+ random characters): ' app_password
\endif

SELECT (
  length(:'app_password') >= 32
  AND :'app_password' !~* '(change.?me|replace.?me|placeholder|example|password|secret)'
) AS app_password_ok
\gset
\if :app_password_ok
\else
  \echo 'A non-placeholder random password of at least 32 characters is required; aborting.'
  \quit 1
\endif

SELECT 'CREATE ROLE ae_store_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_store_app')
\gexec

ALTER ROLE ae_store_app
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_password';

ALTER ROLE ae_store_app SET statement_timeout = '15s';
ALTER ROLE ae_store_app SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE ae_store_app SET lock_timeout = '10s';
ALTER ROLE ae_store_app IN DATABASE :"DBNAME"
  SET search_path = public, pg_catalog;

-- PostgreSQL القديمة كانت تمنح PUBLIC حق CREATE على public تلقائيًا.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON DATABASE :"DBNAME" FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE :"DBNAME" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE :"DBNAME" FROM ae_store_app;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM ae_store_app;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ae_store_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ae_store_app;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ae_store_app;

GRANT CONNECT ON DATABASE :"DBNAME" TO ae_store_app;
GRANT USAGE ON SCHEMA public TO ae_store_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ae_store_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ae_store_app;
REVOKE EXECUTE ON FUNCTION public.ae_store_safe_image_urls(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ae_store_safe_image_urls(text[]) TO ae_store_app;

-- يملكها الدور الذي يشغّل migrations؛ تضمن وصول دور التطبيق إلى الجداول
-- والتسلسلات التي تنشئها ترحيلات مستقبلية من دون منحه DDL.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ae_store_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ae_store_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
