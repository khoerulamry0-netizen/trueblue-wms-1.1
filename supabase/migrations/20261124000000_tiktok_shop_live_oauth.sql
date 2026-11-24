-- TikTok Shop Live OAuth & Multi-Marketplace Support
-- Extends marketplace_stores and marketplace_orders to support TIKTOK alongside SHOPEE,
-- and adds server-only credential and OAuth state storage for TikTok Shop Open API v2.

alter table public.marketplace_stores
  drop constraint if exists marketplace_stores_marketplace_check;
alter table public.marketplace_stores
  add constraint marketplace_stores_marketplace_check
  check (marketplace in ('SHOPEE', 'TIKTOK'));

alter table public.marketplace_orders
  drop constraint if exists marketplace_orders_marketplace_check;
alter table public.marketplace_orders
  add constraint marketplace_orders_marketplace_check
  check (marketplace in ('SHOPEE', 'TIKTOK'));

alter table public.marketplace_stores
  add column if not exists external_shop_code text,
  add column if not exists external_shop_cipher text;

create unique index if not exists marketplace_stores_live_tiktok_uidx
  on public.marketplace_stores(company_id, marketplace, external_shop_code)
  where mode = 'LIVE' and marketplace = 'TIKTOK' and external_shop_code is not null;

create table if not exists public.marketplace_tiktok_credentials (
  store_id uuid primary key references public.marketplace_stores(id) on delete cascade,
  shop_id text not null,
  shop_cipher text not null default '',
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.marketplace_tiktok_credentials enable row level security;
revoke all on public.marketplace_tiktok_credentials from anon, authenticated, public;
grant all on public.marketplace_tiktok_credentials to service_role;

comment on table public.marketplace_tiktok_credentials is
  'Server-only TikTok Shop Live OAuth tokens; no anon/authenticated grants and accessed only by the tiktok-live Edge Function service role.';

create table if not exists public.marketplace_tiktok_oauth_states (
  state text primary key,
  company_id text not null,
  store_name text not null,
  created_by uuid references auth.users(id) on delete cascade,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.marketplace_tiktok_oauth_states enable row level security;
revoke all on public.marketplace_tiktok_oauth_states from anon, authenticated, public;
grant all on public.marketplace_tiktok_oauth_states to service_role;
