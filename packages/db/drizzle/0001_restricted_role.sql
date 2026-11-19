DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'harness_app') THEN
    CREATE ROLE harness_app WITH LOGIN PASSWORD 'harness_app_password';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE harness TO harness_app;
GRANT USAGE ON SCHEMA public TO harness_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO harness_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO harness_app;

-- audit_log is append-only: harness_app has INSERT and SELECT only
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM harness_app;
