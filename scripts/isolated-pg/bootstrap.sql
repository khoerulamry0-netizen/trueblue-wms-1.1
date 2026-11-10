\set ON_ERROR_STOP on
do $$ begin
 if current_database() <> 'wms_isolated_test' or inet_server_addr() is not null then
  raise exception 'Unexpected database or non-local socket';
 end if;
end $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema extensions;
create extension pgcrypto with schema extensions;
create extension dblink;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
create publication supabase_realtime;
