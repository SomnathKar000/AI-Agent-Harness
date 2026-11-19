# @harness/db

PostgreSQL database schemas, Drizzle ORM client, connections, and migrations.

Hard rule: PostgreSQL is the single source of truth for task state. The `audit_log` table is append-only (INSERT and SELECT only).
