-- Shared cloud database for the merged WMS applications.
-- Run this migration in the Supabase SQL Editor or with `supabase db push`.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null default '',
  role text not null default 'Viewer'
    check (role in ('Administrator', 'Admin', 'Picker', 'Packer', 'Viewer')),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.wms_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.wms_set_updated_at();

create or replace function public.wms_create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'Viewer'
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

revoke all on function public.wms_create_profile_for_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_wms on auth.users;
create trigger on_auth_user_created_wms
after insert on auth.users
for each row execute function public.wms_create_profile_for_auth_user();

insert into public.profiles (id, email, full_name, role, is_active)
select id, lower(email), coalesce(raw_user_meta_data ->> 'full_name', ''), 'Viewer', false
from auth.users
where email is not null
on conflict (id) do nothing;

create or replace function public.wms_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

revoke all on function public.wms_current_role() from public, anon;
grant execute on function public.wms_current_role() to authenticated;

create or replace function public.wms_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.wms_current_role() in ('Administrator', 'Admin'), false)
$$;

revoke all on function public.wms_is_admin() from public, anon;
grant execute on function public.wms_is_admin() to authenticated;

create or replace function public.wms_can_operate()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.wms_current_role() in ('Administrator', 'Admin', 'Picker', 'Packer'), false)
$$;

revoke all on function public.wms_can_operate() from public, anon;
grant execute on function public.wms_can_operate() to authenticated;

create table if not exists public.wms_documents (
  collection_name text not null
    check (collection_name in (
      'stock', 'logs', 'orders', 'audits', 'catalog', 'returns', 'batches',
      'warehouses', 'warehouse_transfers', 'inbound', 'settings'
    )),
  document_id text not null check (length(document_id) between 1 and 160),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  primary key (collection_name, document_id),
  check (not (payload ? 'id') or payload ->> 'id' = document_id),
  check (
    collection_name <> 'stock'
    or document_id like 'SYSTEM\_%' escape '\'
    or (
      jsonb_typeof(payload -> 'skuId') = 'string'
      and length(payload ->> 'skuId') between 1 and 128
      and jsonb_typeof(payload -> 'location') = 'string'
      and length(payload ->> 'location') between 1 and 128
      and jsonb_typeof(payload -> 'qty') = 'number'
      and (payload ->> 'qty')::numeric >= 0
    )
  ),
  check (
    collection_name <> 'orders'
    or (
      jsonb_typeof(payload -> 'qty') = 'number'
      and (payload ->> 'qty')::numeric > 0
      and coalesce(payload ->> 'status', 'Pending') in ('Pending', 'Completed', 'Cancelled')
    )
  ),
  check (
    collection_name <> 'logs'
    or (
      jsonb_typeof(payload -> 'type') = 'string'
      and length(payload ->> 'type') between 1 and 64
      and jsonb_typeof(payload -> 'qty') = 'number'
      and (payload ->> 'qty')::numeric >= 0
    )
  )
);

create index if not exists wms_documents_collection_updated_idx
  on public.wms_documents (collection_name, updated_at desc);

alter table public.profiles enable row level security;
alter table public.wms_documents enable row level security;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.wms_documents to authenticated;

drop policy if exists profiles_read_own_or_admin on public.profiles;
create policy profiles_read_own_or_admin
on public.profiles for select to authenticated
using (id = auth.uid() or public.wms_is_admin());

drop policy if exists wms_documents_read_authenticated on public.wms_documents;
create policy wms_documents_read_authenticated
on public.wms_documents for select to authenticated
using (public.wms_current_role() is not null);

drop policy if exists wms_documents_insert_operator on public.wms_documents;
create policy wms_documents_insert_operator
on public.wms_documents for insert to authenticated
with check (
  public.wms_can_operate()
  and (collection_name <> 'users' or public.wms_is_admin())
);

drop policy if exists wms_documents_update_operator on public.wms_documents;
create policy wms_documents_update_operator
on public.wms_documents for update to authenticated
using (
  public.wms_can_operate()
  and (collection_name <> 'users' or public.wms_is_admin())
)
with check (
  public.wms_can_operate()
  and (collection_name <> 'users' or public.wms_is_admin())
);

drop policy if exists wms_documents_delete_operator on public.wms_documents;
create policy wms_documents_delete_operator
on public.wms_documents for delete to authenticated
using (
  public.wms_can_operate()
  and (collection_name <> 'users' or public.wms_is_admin())
);

create or replace function public.apply_wms_batch(p_upserts jsonb, p_deletes jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
  target_collection text;
  target_id text;
begin
  if jsonb_typeof(coalesce(p_upserts, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_deletes, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid WMS batch format';
  end if;

  for item in select value from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) loop
    target_collection := item ->> 'collection_name';
    target_id := item ->> 'document_id';
    if target_collection is null or target_id is null or item -> 'payload' is null then
      raise exception 'Incomplete WMS upsert';
    end if;
    insert into public.wms_documents (collection_name, document_id, payload, updated_by)
    values (target_collection, target_id, item -> 'payload', auth.uid())
    on conflict (collection_name, document_id) do update
      set payload = case
            when coalesce((item ->> 'merge')::boolean, false)
              then public.wms_documents.payload || excluded.payload
            else excluded.payload
          end,
          updated_at = now(),
          updated_by = auth.uid();
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_deletes, '[]'::jsonb)) loop
    target_collection := item ->> 'collection_name';
    target_id := item ->> 'document_id';
    if target_collection is null or target_id is null then
      raise exception 'Incomplete WMS delete';
    end if;
    delete from public.wms_documents
    where collection_name = target_collection and document_id = target_id;
  end loop;
end;
$$;

revoke all on function public.apply_wms_batch(jsonb, jsonb) from public, anon;
grant execute on function public.apply_wms_batch(jsonb, jsonb) to authenticated;

-- Supabase Realtime only streams tables added to this publication.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wms_documents'
  ) then
    alter publication supabase_realtime add table public.wms_documents;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end;
$$;
