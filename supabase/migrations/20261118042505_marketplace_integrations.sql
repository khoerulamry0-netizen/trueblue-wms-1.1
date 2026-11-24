-- Marketplace integration foundation for the isolated demo environment.
-- No live marketplace credentials or fulfillment writes are enabled here.

create table if not exists public.marketplace_stores (
  id uuid primary key default gen_random_uuid(), company_id text not null default 'DEFAULT',
  marketplace text not null check (marketplace in ('SHOPEE')),
  store_key text not null check (length(trim(store_key)) between 1 and 120),
  store_name text not null check (length(trim(store_name)) between 1 and 160),
  mode text not null default 'DEMO' check (mode in ('DEMO', 'LIVE')),
  connection_status text not null default 'CONNECTED' check (connection_status in ('CONNECTED', 'DISCONNECTED', 'NOT_CONFIGURED')),
  last_synced_at timestamptz, created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (company_id, marketplace, store_key)
);

create table if not exists public.marketplace_sku_mappings (
  id uuid primary key default gen_random_uuid(), company_id text not null default 'DEFAULT',
  store_id uuid not null references public.marketplace_stores(id) on delete cascade,
  external_sku text not null check (length(trim(external_sku)) between 1 and 160), external_variant text not null default '',
  internal_sku text not null check (length(trim(internal_sku)) between 1 and 160),
  mapping_status text not null default 'CONFIRMED' check (mapping_status in ('CONFIRMED')),
  created_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (store_id, external_sku, external_variant)
);

create table if not exists public.marketplace_orders (
  id uuid primary key default gen_random_uuid(), company_id text not null default 'DEFAULT',
  store_id uuid not null references public.marketplace_stores(id) on delete cascade,
  marketplace text not null check (marketplace in ('SHOPEE')),
  external_order_id text not null check (length(trim(external_order_id)) between 1 and 160),
  order_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(order_payload) = 'object'),
  status text not null default 'PERLU_MAPPING' check (status in ('PERLU_MAPPING', 'SIAP_DITINJAU', 'GAGAL')),
  failure_reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (company_id, marketplace, store_id, external_order_id)
);

create table if not exists public.marketplace_sync_runs (
  id uuid primary key default gen_random_uuid(), company_id text not null default 'DEFAULT',
  store_id uuid not null references public.marketplace_stores(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  new_order_count integer not null default 0 check (new_order_count >= 0), existing_order_count integer not null default 0 check (existing_order_count >= 0),
  failure_reason text, created_by uuid references auth.users(id) on delete set null
);

create index if not exists marketplace_stores_company_idx on public.marketplace_stores(company_id, marketplace);
create index if not exists marketplace_mappings_store_idx on public.marketplace_sku_mappings(store_id);
create index if not exists marketplace_orders_queue_idx on public.marketplace_orders(company_id, status, created_at desc);
create index if not exists marketplace_sync_runs_store_idx on public.marketplace_sync_runs(store_id, started_at desc);

drop trigger if exists marketplace_stores_updated_at on public.marketplace_stores;
create trigger marketplace_stores_updated_at before update on public.marketplace_stores for each row execute function public.wms_set_updated_at();
drop trigger if exists marketplace_sku_mappings_updated_at on public.marketplace_sku_mappings;
create trigger marketplace_sku_mappings_updated_at before update on public.marketplace_sku_mappings for each row execute function public.wms_set_updated_at();
drop trigger if exists marketplace_orders_updated_at on public.marketplace_orders;
create trigger marketplace_orders_updated_at before update on public.marketplace_orders for each row execute function public.wms_set_updated_at();

alter table public.marketplace_stores enable row level security;
alter table public.marketplace_sku_mappings enable row level security;
alter table public.marketplace_orders enable row level security;
alter table public.marketplace_sync_runs enable row level security;

drop policy if exists marketplace_stores_admin on public.marketplace_stores;
create policy marketplace_stores_admin on public.marketplace_stores for all to authenticated using (public.wms_is_admin()) with check (public.wms_is_admin());
drop policy if exists marketplace_mappings_admin on public.marketplace_sku_mappings;
create policy marketplace_mappings_admin on public.marketplace_sku_mappings for all to authenticated using (public.wms_is_admin()) with check (public.wms_is_admin());
drop policy if exists marketplace_orders_admin on public.marketplace_orders;
create policy marketplace_orders_admin on public.marketplace_orders for all to authenticated using (public.wms_is_admin()) with check (public.wms_is_admin());
drop policy if exists marketplace_sync_runs_admin on public.marketplace_sync_runs;
create policy marketplace_sync_runs_admin on public.marketplace_sync_runs for all to authenticated using (public.wms_is_admin()) with check (public.wms_is_admin());

grant select, insert, update, delete on public.marketplace_stores to authenticated;
grant select, insert, update, delete on public.marketplace_sku_mappings to authenticated;
grant select, insert, update, delete on public.marketplace_orders to authenticated;
grant select, insert on public.marketplace_sync_runs to authenticated;
