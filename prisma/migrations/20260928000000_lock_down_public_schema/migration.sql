-- Made4Buyers accesses the database only server-side through Prisma (table owner, which
-- bypasses RLS). On Supabase, tables in `public` are also reachable through the REST/GraphQL
-- APIs with the publishable (anon) key, so every table gets RLS enabled with NO policies
-- (deny-all for API roles) and API-role privileges are revoked. Harmless on plain Postgres.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
  END IF;
END $$;
