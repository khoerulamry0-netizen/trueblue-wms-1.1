-- Event-trigger helpers are invoked by PostgreSQL, never through the Data API.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
