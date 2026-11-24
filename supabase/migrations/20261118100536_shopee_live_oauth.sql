-- Secure server-side storage and live OAuth foundation for Shopee.
-- This migration does not connect to Shopee and does not change operational orders or stock.

alter table public.marketplace_stores
  drop constraint if exists marketplace_stores_connection_status_check;
alter table public.marketplace_stores
  add constraint marketplace_stores_connection_status_check
  check (connection_status in ('CONNECTED', 'DISCONNECTED', 'NOT_CONFIGURED', 'PENDING'));

alter table public.marketplace_stores
  add column if not exists external_shop_id bigint,
  add column if not exists live_authorized_at timestamptz,
  add column if not exists last_error text;

create unique index if not exists marketplace_stores_live_shop_uidx
  on public.marketplace_stores(company_id, marketplace, external_shop_id)
  where mode = 'LIVE' and external_shop_id is not null;

create table if not exists public.marketplace_shopee_credentials (
  store_id uuid primary key references public.marketplace_stores(id) on delete cascade,
  shop_id bigint not null,
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.marketplace_shopee_credentials enable row level security;
revoke all on public.marketplace_shopee_credentials from anon, authenticated, public;
grant all on public.marketplace_shopee_credentials to service_role;

comment on table public.marketplace_shopee_credentials is 'Server-only Shopee Live OAuth tokens; no anon/authenticated grants and accessed only by the shopee-live Edge Function service role.';

create table if not exists public.marketplace_shopee_oauth_states (
  state text primary key,
  company_id text not null,
  store_name text not null,
  created_by uuid references auth.users(id) on delete cascade,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.marketplace_shopee_oauth_states enable row level security;
revoke all on public.marketplace_shopee_oauth_states from anon, authenticated, public;
grant all on public.marketplace_shopee_oauth_states to service_role;
