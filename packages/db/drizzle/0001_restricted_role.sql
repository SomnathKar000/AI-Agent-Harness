DO $$
DECLARE
  db_name text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'harness_app') THEN
    CREATE ROLE harness_app WITH LOGIN PASSWORD 'harness_app_password';
  END IF;
  SELECT current_database() INTO db_name;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO harness_app', db_name);
END
$$;

GRANT USAGE ON SCHEMA public TO harness_app;

-- Revoke all table and sequence permissions first
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM harness_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM harness_app;

-- Ensure harness_app has only the grants it needs:
-- SELECT, INSERT, UPDATE on operational tables
GRANT SELECT, INSERT, UPDATE ON TABLE tasks, task_steps, approvals, verifications, repos TO harness_app;

-- SELECT, INSERT only on audit_log (append-only)
GRANT SELECT, INSERT ON TABLE audit_log TO harness_app;

-- USAGE, SELECT on sequences for auto-incrementing IDs
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO harness_app;
