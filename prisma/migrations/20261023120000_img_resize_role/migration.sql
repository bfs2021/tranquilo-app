-- Table privileges for the image resize Lambda's database role,
-- `img_resize`: read items, write the image cache's own bookkeeping, and
-- nothing else.
--
-- The role itself is created outside this file (Neon console or API), since
-- its password must not live in the repo. Until it exists this file does
-- nothing, so it is safe on any database. Re-runnable.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'img_resize') THEN
    GRANT SELECT ON items TO img_resize;
    GRANT SELECT, INSERT, UPDATE ON img_cache_entries TO img_resize;
    GRANT SELECT, INSERT, UPDATE, DELETE ON img_fetch_claims TO img_resize;
    GRANT SELECT, UPDATE ON source_fetch_state TO img_resize;
    GRANT SELECT, INSERT, UPDATE ON host_fetch_state TO img_resize;
    GRANT SELECT, INSERT, UPDATE ON img_cache_stats TO img_resize;
    GRANT SELECT, INSERT, UPDATE ON img_shed_stats TO img_resize;
    GRANT SELECT, INSERT, UPDATE ON visitor_fetch_state TO img_resize;
  END IF;
END
$$;
