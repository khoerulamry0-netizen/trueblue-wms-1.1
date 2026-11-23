-- ==============================================================================
-- MASTER SETUP DATABASE TRUEBLUE WMS (UNTUK PROYEK SUPABASE BARU)
-- Jalankan seluruh skrip ini di: Supabase Dashboard -> SQL Editor -> Run
-- ==============================================================================

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


-- Generated by scripts/build-local-migrations.mjs. Do not edit by hand.

-- Local-development migration; production deployment is intentionally out of scope.

-- Source SQL is retained under supabase/ for review and traceability.


-- >>> branch-schema.sql

create table public.branches (
 id text primary key check(id ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
 name text not null check(length(trim(name)) between 1 and 100),
 created_at timestamptz not null default now()
);
insert into public.branches(id,name) values ('CENTER','CENTER');
alter table public.profiles add column branch_id text not null default 'CENTER' references public.branches(id);
create index profiles_branch_idx on public.profiles(branch_id);
alter table public.wms_documents add column branch_id text not null default 'CENTER' references public.branches(id);
alter table public.wms_documents drop constraint wms_documents_pkey;
alter table public.wms_documents add primary key (branch_id,collection_name,document_id);
create index wms_documents_branch_updated_idx on public.wms_documents(branch_id,updated_at desc);
create schema if not exists wms_private;
revoke all on schema wms_private from public,anon;
grant usage on schema wms_private to authenticated;
create function wms_private.can_access_branch(target text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active
 and (p.role='Administrator' or p.branch_id=target))
$$;
create function wms_private.is_hq() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and is_active and role='Administrator')
$$;
revoke all on function wms_private.can_access_branch(text),wms_private.is_hq() from public,anon;
grant execute on function wms_private.can_access_branch(text),wms_private.is_hq() to authenticated;
alter table public.branches enable row level security;
revoke all on public.branches from anon,authenticated;
grant select,insert,update on public.branches to authenticated;
create policy branches_read on public.branches for select to authenticated using(wms_private.can_access_branch(id));
create policy branches_create on public.branches for insert to authenticated with check(wms_private.is_hq());
create policy branches_update on public.branches for update to authenticated using(wms_private.is_hq()) with check(wms_private.is_hq());
drop policy profiles_read_own_or_admin on public.profiles;
create policy profiles_read_own_or_admin on public.profiles for select to authenticated using(
 id=auth.uid() or wms_private.is_hq() or (public.wms_is_admin() and wms_private.can_access_branch(branch_id))
);
drop policy wms_documents_read_authenticated on public.wms_documents;
create policy wms_documents_read_authenticated on public.wms_documents for select to authenticated using(wms_private.can_access_branch(branch_id));
drop policy wms_documents_insert_operator on public.wms_documents;
create policy wms_documents_insert_operator on public.wms_documents for insert to authenticated with check(public.wms_can_operate() and wms_private.can_access_branch(branch_id));
drop policy wms_documents_update_operator on public.wms_documents;
create policy wms_documents_update_operator on public.wms_documents for update to authenticated using(public.wms_can_operate() and wms_private.can_access_branch(branch_id)) with check(public.wms_can_operate() and wms_private.can_access_branch(branch_id));
drop policy wms_documents_delete_operator on public.wms_documents;
create policy wms_documents_delete_operator on public.wms_documents for delete to authenticated using(public.wms_can_operate() and wms_private.can_access_branch(branch_id));
drop function public.apply_wms_batch(jsonb,jsonb);
create function public.apply_wms_batch(p_upserts jsonb,p_deletes jsonb,p_branch_id text default 'CENTER')
returns void language plpgsql security invoker set search_path='' as $$
declare item jsonb;
begin
 if not public.wms_can_operate() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses cabang ditolak'; end if;
 if jsonb_typeof(coalesce(p_upserts,'[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_deletes,'[]'::jsonb))<>'array' then raise exception 'Invalid batch'; end if;
 for item in select value from jsonb_array_elements(coalesce(p_upserts,'[]'::jsonb)) loop
 insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
 values(p_branch_id,item->>'collection_name',item->>'document_id',item->'payload',auth.uid())
 on conflict(branch_id,collection_name,document_id) do update set
 payload=case when coalesce((item->>'merge')::boolean,false) then public.wms_documents.payload||excluded.payload else excluded.payload end,
 updated_at=now(),updated_by=auth.uid();
 end loop;
 for item in select value from jsonb_array_elements(coalesce(p_deletes,'[]'::jsonb)) loop
 delete from public.wms_documents where branch_id=p_branch_id and collection_name=item->>'collection_name' and document_id=item->>'document_id';
 end loop;
end;
$$;
revoke all on function public.apply_wms_batch(jsonb,jsonb,text) from public,anon;
grant execute on function public.apply_wms_batch(jsonb,jsonb,text) to authenticated;

revoke all on public.profiles,public.wms_documents from anon,authenticated;
grant select on public.profiles to authenticated;
grant select,insert,update,delete on public.wms_documents to authenticated;
-- <<< branch-schema.sql


-- >>> branch-sender-settings.sql
alter table public.branches add column sender_name text not null default 'Development Sender', add column sender_phone text not null default '00000000';
alter table public.branches add constraint branches_sender_name_valid check(sender_name=btrim(sender_name) and length(sender_name) between 1 and 100 and sender_name !~ '[[:cntrl:]]'), add constraint branches_sender_phone_valid check(sender_phone ~ '^[+]?[0-9]{8,20}$');
update public.branches set sender_name='Development Sender',sender_phone='00000000' where id='CENTER';
-- <<< branch-sender-settings.sql


-- >>> branch-transfers.sql

create function wms_private.transfer_expired_date(value text) returns text
language plpgsql immutable set search_path='' as $$
declare v text=trim(coalesce(value,'')); parts text[]; y text; m text; d text;
begin
 if lower(v) in ('','-','no expired','no ed','no_expired','noed') then return 'No Expired';end if;
 parts=regexp_match(v,'^([0-9]{4})[-/. ]([0-9]{1,2})[-/. ]([0-9]{1,2})([T ].*)?$');
 if parts is not null then y=parts[1];m=parts[2];d=parts[3];else
 parts=regexp_match(v,'^([0-9]{1,2})[-/. ]([0-9]{1,2})[-/. ]([0-9]{2,4})$');
 if parts is null then raise exception 'Format ED harus DD/MM/YYYY, YYYY-MM-DD, atau No Expired';end if;
 d=parts[1];m=parts[2];y=parts[3];if length(y)=2 then y='20'||y;end if;
 end if;
 perform make_date(y::integer,m::integer,d::integer);
 return lpad(d,2,'0')||'/'||lpad(m,2,'0')||'/'||y;
end;
$$;
revoke all on function wms_private.transfer_expired_date(text) from public,anon,authenticated;

create table public.branch_transfers (
 id uuid primary key,
 source_branch text not null references public.branches(id),
 destination_branch text not null references public.branches(id),
 status text not null default 'DRAFT' check(status in ('DRAFT','SHIPPED','IN_TRANSIT','RECEIVED','CANCELLED')),
 request_items jsonb not null,
 items jsonb not null,
 receipt jsonb,
 notes text not null default '',
 receipt_notes text,
 events jsonb not null default '[]',
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(source_branch<>destination_branch),
 check(jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 100)
);
create index branch_transfers_source_idx on public.branch_transfers(source_branch,created_at desc);
create index branch_transfers_destination_idx on public.branch_transfers(destination_branch,created_at desc);
alter table public.branch_transfers enable row level security;
revoke all on public.branch_transfers from anon,authenticated;
grant select on public.branch_transfers to authenticated;
create policy branch_transfers_read on public.branch_transfers for select to authenticated
using(wms_private.can_access_branch(source_branch) or wms_private.can_access_branch(destination_branch));
create function wms_private.branch_directory() returns table(id text,name text)
language sql stable security definer set search_path='' as $$
 select b.id,b.name from public.branches b
 where exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) order by b.id
$$;
revoke all on function wms_private.branch_directory() from public,anon;
grant execute on function wms_private.branch_directory() to authenticated;
create function public.branch_transfer_directory() returns table(id text,name text)
language sql stable security invoker set search_path='' as $$select * from wms_private.branch_directory()$$;
revoke all on function public.branch_transfer_directory() from public,anon;
grant execute on function public.branch_transfer_directory() to authenticated;

create function wms_private.branch_transfer_action(p_id uuid,p_action text,p_source text,p_destination text,p_items jsonb,p_notes text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 t public.branch_transfers%rowtype; item jsonb; rec jsonb; s jsonb; snapshot jsonb;
 packed jsonb='[]'; idx integer=0; qty numeric; good numeric; damaged numeric; available numeric; loc text; dest_id text; actor_name text;
 seen text[]='{}'; log_id text; existing_qty numeric; role_name text;
begin
 select role,coalesce(nullif(full_name,''),email) into role_name,actor_name from public.profiles where id=auth.uid() and is_active;
 if auth.uid() is null or role_name is null or role_name not in ('Administrator','Admin','Picker','Packer') then raise exception 'Akses operasi transfer ditolak';end if;
 if p_id is null or length(coalesce(p_notes,''))>2000 then raise exception 'Permintaan tidak valid';end if;
 -- Serializes retries for a transfer even before its row exists.
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into t from public.branch_transfers where id=p_id for update;
 if p_action='create' then
  if not wms_private.can_access_branch(p_source) then raise exception 'Akses cabang asal ditolak';end if;
  if p_source is null or p_destination is null or p_source=p_destination or not exists(select 1 from public.branches where id=p_destination) then raise exception 'Cabang tujuan tidak valid';end if;
  if t.id is not null then
   if t.source_branch<>p_source or t.destination_branch<>p_destination or t.request_items is distinct from p_items then raise exception 'ID permintaan sudah dipakai';end if;
   return to_jsonb(t);
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Isi 1 sampai 100 baris barang';end if;
  for item in select value from jsonb_array_elements(p_items) loop
   qty=(item->>'qty')::numeric;
   if qty is null or qty<=0 or qty<>trunc(qty) or qty>1000000000 or coalesce(item->>'stock_id','')='' or (item->>'stock_id')=any(seen) then raise exception 'Barang atau jumlah tidak valid/duplikat';end if;
   seen=array_append(seen,item->>'stock_id');
   select payload into s from public.wms_documents where branch_id=p_source and collection_name='stock' and document_id=item->>'stock_id';
   if s is null or coalesce((s->>'qty')::numeric,0)<qty then raise exception 'Stok asal tidak cukup';end if;
   packed=packed||jsonb_build_array(jsonb_build_object('stock_id',item->>'stock_id','qty',qty,'stock',s,'normalized_ed',wms_private.transfer_expired_date(s->>'expiredDate')));
  end loop;
  insert into public.branch_transfers(id,source_branch,destination_branch,request_items,items,notes,created_by,events)
  values(p_id,p_source,p_destination,p_items,packed,coalesce(p_notes,''),auth.uid(),jsonb_build_array(jsonb_build_object('status','DRAFT','at',now(),'by',auth.uid(),'name',actor_name)))
  returning * into t;
  return to_jsonb(t);
 end if;
 if t.id is null then raise exception 'Transfer tidak ditemukan';end if;
 if p_action in ('ship','transit','cancel') then
  if not wms_private.can_access_branch(t.source_branch) then raise exception 'Hanya cabang asal yang dapat mengirim';end if;
 elsif p_action='receive' then
  if not wms_private.can_access_branch(t.destination_branch) then raise exception 'Hanya cabang tujuan yang dapat menerima';end if;
 else raise exception 'Aksi tidak valid';
 end if;
 if p_action='cancel' then
  if t.status='CANCELLED' then return to_jsonb(t);end if;
  if t.status<>'DRAFT' or length(trim(coalesce(p_notes,'')))=0 then raise exception 'Hanya draft dapat dibatalkan; isi alasan';end if;
  t.status='CANCELLED';
 elsif p_action='ship' then
  if t.status in ('SHIPPED','IN_TRANSIT','RECEIVED') then return to_jsonb(t);end if;
  if t.status<>'DRAFT' then raise exception 'Status transfer tidak dapat dikirim';end if;
  -- Stable locking order prevents deadlocks for overlapping outgoing transfers.
  perform 1 from public.wms_documents d where d.branch_id=t.source_branch and d.collection_name='stock'
   and d.document_id in (select value->>'stock_id' from jsonb_array_elements(t.items)) order by d.document_id for update;
  for item in select value from jsonb_array_elements(t.items) loop
   qty=(item->>'qty')::numeric;
   select payload into s from public.wms_documents where branch_id=t.source_branch and collection_name='stock' and document_id=item->>'stock_id';
   if s is null or coalesce((s->>'qty')::numeric,0)<qty then raise exception 'Stok berubah atau tidak cukup. Transfer tidak dikirim';end if;
   if (s->>'skuId') is distinct from (item->'stock'->>'skuId') or (s->>'expiredDate') is distinct from (item->'stock'->>'expiredDate') then raise exception 'Identitas stok berubah';end if;
   update public.wms_documents set payload=jsonb_set(payload,'{qty}',to_jsonb((s->>'qty')::numeric-qty)),updated_at=now(),updated_by=auth.uid()
    where branch_id=t.source_branch and collection_name='stock' and document_id=item->>'stock_id';
   log_id='BTO_'||t.id::text||'_'||idx;
   insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
   values(t.source_branch,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','TRANSFER_OUT','qty',qty,'skuId',s->>'skuId','skuName',s->>'skuName','expiredDate',s->>'expiredDate','locationFrom',s->>'location','locationTo',t.destination_branch,'description','Transfer cabang '||t.id::text,'user',actor_name),auth.uid());
   idx=idx+1;
  end loop;
  t.status='SHIPPED';
 elsif p_action='transit' then
  if t.status in ('IN_TRANSIT','RECEIVED') then return to_jsonb(t);end if;
  if t.status<>'SHIPPED' then raise exception 'Transfer harus dikirim dahulu';end if;
  t.status='IN_TRANSIT';
 elsif p_action='receive' then
  if t.status='RECEIVED' then
   if t.receipt is distinct from p_items then raise exception 'Transfer sudah diterima dengan rincian lain';end if;
   return to_jsonb(t);
  end if;
  if t.status<>'IN_TRANSIT' then raise exception 'Transfer harus dalam perjalanan';end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)<>jsonb_array_length(t.items) then raise exception 'Rincian penerimaan tidak lengkap';end if;
  -- Serialize destination receipts; protects first insert and aggregate quantity.
  perform pg_advisory_xact_lock(hashtextextended('branch-receipt:'||t.destination_branch,0));
  for item in select value from jsonb_array_elements(t.items) loop
   rec=p_items->idx; qty=(item->>'qty')::numeric;
   good=(rec->>'good')::numeric;damaged=(rec->>'damaged')::numeric;loc=upper(trim(coalesce(rec->>'location','')));
   if good is null or damaged is null or good<0 or damaged<0 or good<>trunc(good) or damaged<>trunc(damaged) or good+damaged>qty or length(loc) not between 1 and 80 then raise exception 'Jumlah/lokasi penerimaan tidak valid';end if;
   if (damaged>0 or good+damaged<qty) and length(trim(coalesce(p_notes,'')))=0 then raise exception 'Isi catatan kerusakan atau selisih';end if;
   if loc='RAK KAYU' then loc='RACK DISPLAY';end if;
   snapshot=jsonb_set(item->'stock','{expiredDate}',to_jsonb(item->>'normalized_ed'));
   dest_id=upper(trim(snapshot->>'skuId'))||'_'||regexp_replace(coalesce(nullif(snapshot->>'expiredDate',''),'No Expired'),'[/ .-]','_','g')||'_'||regexp_replace(loc,'[/ .-]','_','g');
   if good>0 then
    s=snapshot - 'warehouseName' - 'warehouseId' - 'totalQtySku' - 'qtyCtn' - 'qtyInner' - 'qtyLoose';
    s=s||jsonb_build_object('id',dest_id,'location',loc,'qty',good,'warehouseId','WH-CENTRAL');
    insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
    values(t.destination_branch,'stock',dest_id,s,auth.uid())
    on conflict(branch_id,collection_name,document_id) do update set
     payload=public.wms_documents.payload||jsonb_build_object('qty',coalesce((public.wms_documents.payload->>'qty')::numeric,0)+good),
     updated_at=now(),updated_by=auth.uid();
   end if;
   log_id='BTI_'||t.id::text||'_'||idx;
   insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
   values(t.destination_branch,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','TRANSFER_IN','qty',good,'skuId',snapshot->>'skuId','skuName',snapshot->>'skuName','expiredDate',snapshot->>'expiredDate','locationFrom',t.source_branch,'locationTo',loc,'description','Transfer '||t.id::text||'; rusak='||damaged||'; kurang='||(qty-good-damaged)||'; '||coalesce(p_notes,''),'user',actor_name),auth.uid());
   idx=idx+1;
  end loop;
  t.status='RECEIVED';t.receipt=p_items;t.receipt_notes=p_notes;
 end if;
 update public.branch_transfers set status=t.status,receipt=t.receipt,receipt_notes=t.receipt_notes,updated_at=now(),
 events=events||jsonb_build_array(jsonb_build_object('status',t.status,'at',now(),'by',auth.uid(),'name',actor_name,'notes',coalesce(p_notes,'')))
 where id=t.id returning * into t;
 return to_jsonb(t);
end;
$$;
revoke all on function wms_private.branch_transfer_action(uuid,text,text,text,jsonb,text) from public,anon;
grant execute on function wms_private.branch_transfer_action(uuid,text,text,text,jsonb,text) to authenticated;
create function public.branch_transfer_action(p_id uuid,p_action text,p_source text default null,p_destination text default null,p_items jsonb default null,p_notes text default '')
returns jsonb language sql security invoker set search_path='' as $$
 select wms_private.branch_transfer_action(p_id,p_action,p_source,p_destination,p_items,p_notes)
$$;
revoke all on function public.branch_transfer_action(uuid,text,text,text,jsonb,text) from public,anon;
grant execute on function public.branch_transfer_action(uuid,text,text,text,jsonb,text) to authenticated;
-- <<< branch-transfers.sql


-- >>> stock-consistency.sql

create sequence wms_private.document_revision_seq;
alter table public.wms_documents add column revision bigint not null default nextval('wms_private.document_revision_seq');
create table public.stock_movements (
 id bigint generated always as identity primary key,
 branch_id text not null references public.branches(id),
 document_id text not null,
 sku_id text,
 sku_name text,
 location text,
 expired_date text,
 qty_before numeric not null,
 qty_after numeric not null,
 delta numeric not null,
 operation_id text not null,
 operation_type text not null,
 actor_id uuid references auth.users(id) on delete set null,
 actor_name text,
 created_at timestamptz not null default now()
);
create index stock_movements_branch_time_idx on public.stock_movements(branch_id,created_at desc);
create index stock_movements_operation_idx on public.stock_movements(operation_id);
alter table public.stock_movements enable row level security;
revoke all on public.stock_movements from public,anon,authenticated;
grant select on public.stock_movements to authenticated;
create policy stock_movements_read on public.stock_movements for select to authenticated using(wms_private.can_access_branch(branch_id));
create table wms_private.write_requests (
 id uuid primary key,actor_id uuid not null,branch_id text not null,body jsonb not null,result jsonb not null,created_at timestamptz not null default now()
);
alter table wms_private.write_requests enable row level security;
revoke all on wms_private.write_requests from public,anon,authenticated;
create function wms_private.document_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 new.revision=nextval('wms_private.document_revision_seq');
 new.updated_at=clock_timestamp();
 new.updated_by=auth.uid();
 return new;
end;$$;
revoke all on function wms_private.document_revision() from public,anon,authenticated;
create trigger wms_document_revision before insert or update on public.wms_documents for each row execute function wms_private.document_revision();
create function wms_private.record_stock_movement() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous numeric=0; following numeric=0; p jsonb; b text;d text; actor text;
begin
 if tg_op='DELETE' then p=old.payload;b=old.branch_id;d=old.document_id;else p=new.payload;b=new.branch_id;d=new.document_id;end if;
 if (case when tg_op='DELETE' then old.collection_name else new.collection_name end)<>'stock' or d like 'SYSTEM_%' then return null;end if;
 if tg_op<>'INSERT' then previous=coalesce((old.payload->>'qty')::numeric,0);end if;
 if tg_op<>'DELETE' then following=coalesce((new.payload->>'qty')::numeric,0);end if;
 if previous=following then return null;end if;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 insert into public.stock_movements(branch_id,document_id,sku_id,sku_name,location,expired_date,qty_before,qty_after,delta,operation_id,operation_type,actor_id,actor_name)
 values(b,d,p->>'skuId',p->>'skuName',p->>'location',p->>'expiredDate',previous,following,following-previous,
 coalesce(nullif(current_setting('wms.operation_id',true),''),'tx:'||txid_current()::text),
 coalesce(nullif(current_setting('wms.operation_type',true),''),tg_op),auth.uid(),actor);
 return null;
end;$$;
revoke all on function wms_private.record_stock_movement() from public,anon,authenticated;
create trigger stock_movement_ledger after insert or update or delete on public.wms_documents for each row execute function wms_private.record_stock_movement();

create function wms_private.commit_wms_write(p_request_id uuid,p_branch_id text,p_upserts jsonb,p_deletes jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req wms_private.write_requests%rowtype; item jsonb; current_revision bigint; expected bigint; target_collection text;target_id text;result jsonb='[]'; body jsonb;new_revision bigint;count_items integer;
begin
 if auth.uid() is null or not public.wms_can_operate() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses tulis cabang ditolak';end if;
 if p_request_id is null or jsonb_typeof(p_upserts) is distinct from 'array' or jsonb_typeof(p_deletes) is distinct from 'array' then raise exception 'Format transaksi tidak valid';end if;
 count_items=jsonb_array_length(p_upserts)+jsonb_array_length(p_deletes);
 if count_items not between 1 and 20000 then raise exception 'Jumlah baris transaksi harus 1–20000';end if;
 body=jsonb_build_object('upserts',p_upserts,'deletes',p_deletes);
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request_id::text,0));
 select * into req from wms_private.write_requests where id=p_request_id;
 if req.id is not null then
  if req.actor_id<>auth.uid() or req.branch_id<>p_branch_id or req.body is distinct from body then raise exception 'ID transaksi sudah dipakai untuk permintaan lain';end if;
  return req.result;
 end if;
 -- One branch lock also serializes missing-row inserts and competing batches.
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 if (select count(*) from (select value->>'collection_name' c,value->>'document_id' d from jsonb_array_elements(p_upserts||p_deletes) group by 1,2) s)<>count_items then raise exception 'Baris transaksi duplikat';end if;
 -- Lock all existing rows in a consistent order, then validate every version before mutating.
 perform 1 from public.wms_documents d where d.branch_id=p_branch_id and exists(
  select 1 from jsonb_array_elements(p_upserts||p_deletes) j where j->>'collection_name'=d.collection_name and j->>'document_id'=d.document_id
 ) order by collection_name,document_id for update;
 for item in select value from jsonb_array_elements(p_upserts||p_deletes) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  if target_collection is null or target_id is null or not(item?'expected_revision') then raise exception 'Versi data wajib dikirim';end if;
  expected=(item->>'expected_revision')::bigint;
  select revision into current_revision from public.wms_documents where branch_id=p_branch_id and collection_name=target_collection and document_id=target_id;
  if current_revision is distinct from expected then raise exception using errcode='40001',message='Data telah berubah di perangkat lain. Muat data terbaru sebelum mengulangi transaksi.';end if;
 end loop;
 perform set_config('wms.operation_id',p_request_id::text,true);
 perform set_config('wms.operation_type','WMS_TRANSACTION',true);
 for item in select value from jsonb_array_elements(p_upserts) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,target_collection,target_id,(item->'payload')-'__wms_revision')
  on conflict(branch_id,collection_name,document_id) do update set payload=case when coalesce((item->>'merge')::boolean,false) then public.wms_documents.payload||excluded.payload else excluded.payload end
  returning revision into new_revision;
  result=result||jsonb_build_array(jsonb_build_object('collection_name',target_collection,'document_id',target_id,'revision',new_revision));
 end loop;
 for item in select value from jsonb_array_elements(p_deletes) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  delete from public.wms_documents where branch_id=p_branch_id and collection_name=target_collection and document_id=target_id;
  result=result||jsonb_build_array(jsonb_build_object('collection_name',target_collection,'document_id',target_id,'revision',null));
 end loop;
 insert into wms_private.write_requests(id,actor_id,branch_id,body,result) values(p_request_id,auth.uid(),p_branch_id,body,result);
 return result;
end;$$;
revoke all on function wms_private.commit_wms_write(uuid,text,jsonb,jsonb) from public,anon;
grant execute on function wms_private.commit_wms_write(uuid,text,jsonb,jsonb) to authenticated;
create function public.commit_wms_write(p_request_id uuid,p_branch_id text,p_upserts jsonb,p_deletes jsonb)
returns jsonb language sql security invoker set search_path='' as $$
select wms_private.commit_wms_write(p_request_id,p_branch_id,p_upserts,p_deletes)
$$;
revoke all on function public.commit_wms_write(uuid,text,jsonb,jsonb) from public,anon;
grant execute on function public.commit_wms_write(uuid,text,jsonb,jsonb) to authenticated;
revoke insert,update,delete on public.wms_documents from authenticated;
revoke all on function public.apply_wms_batch(jsonb,jsonb,text) from public,anon,authenticated;

create or replace function wms_private.branch_transfer_action(p_id uuid,p_action text,p_source text,p_destination text,p_items jsonb,p_notes text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 t public.branch_transfers%rowtype; item jsonb; rec jsonb; s jsonb; snapshot jsonb;
 packed jsonb='[]'; idx integer=0; qty numeric; good numeric; damaged numeric; available numeric; loc text; dest_id text; actor_name text;
 seen text[]='{}'; log_id text; existing_qty numeric; role_name text;
begin
 select role,coalesce(nullif(full_name,''),email) into role_name,actor_name from public.profiles where id=auth.uid() and is_active;
 if auth.uid() is null or role_name is null or role_name not in ('Administrator','Admin','Picker','Packer') then raise exception 'Akses operasi transfer ditolak';end if;
 if p_id is null or length(coalesce(p_notes,''))>2000 then raise exception 'Permintaan tidak valid';end if;
 -- Serializes retries for a transfer even before its row exists.
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into t from public.branch_transfers where id=p_id for update;
 if p_action='create' then
  if not wms_private.can_access_branch(p_source) then raise exception 'Akses cabang asal ditolak';end if;
  if p_source is null or p_destination is null or p_source=p_destination or not exists(select 1 from public.branches where id=p_destination) then raise exception 'Cabang tujuan tidak valid';end if;
  if t.id is not null then
   if t.source_branch<>p_source or t.destination_branch<>p_destination or t.request_items is distinct from p_items then raise exception 'ID permintaan sudah dipakai';end if;
   return to_jsonb(t);
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Isi 1 sampai 100 baris barang';end if;
  for item in select value from jsonb_array_elements(p_items) loop
   qty=(item->>'qty')::numeric;
   if qty is null or qty<=0 or qty<>trunc(qty) or qty>1000000000 or coalesce(item->>'stock_id','')='' or (item->>'stock_id')=any(seen) then raise exception 'Barang atau jumlah tidak valid/duplikat';end if;
   seen=array_append(seen,item->>'stock_id');
   select payload into s from public.wms_documents where branch_id=p_source and collection_name='stock' and document_id=item->>'stock_id';
   if s is null or coalesce((s->>'qty')::numeric,0)<qty then raise exception 'Stok asal tidak cukup';end if;
   packed=packed||jsonb_build_array(jsonb_build_object('stock_id',item->>'stock_id','qty',qty,'stock',s,'normalized_ed',wms_private.transfer_expired_date(s->>'expiredDate')));
  end loop;
  insert into public.branch_transfers(id,source_branch,destination_branch,request_items,items,notes,created_by,events)
  values(p_id,p_source,p_destination,p_items,packed,coalesce(p_notes,''),auth.uid(),jsonb_build_array(jsonb_build_object('status','DRAFT','at',now(),'by',auth.uid(),'name',actor_name)))
  returning * into t;
  return to_jsonb(t);
 end if;
 if t.id is null then raise exception 'Transfer tidak ditemukan';end if;
 if p_action in ('ship','transit','cancel') then
  if not wms_private.can_access_branch(t.source_branch) then raise exception 'Hanya cabang asal yang dapat mengirim';end if;
 elsif p_action='receive' then
  if not wms_private.can_access_branch(t.destination_branch) then raise exception 'Hanya cabang tujuan yang dapat menerima';end if;
 else raise exception 'Aksi tidak valid';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||case when p_action='receive' then t.destination_branch else t.source_branch end,0));
 perform set_config('wms.operation_id',t.id::text||':'||p_action,true);
 perform set_config('wms.operation_type','BRANCH_TRANSFER_'||upper(p_action),true);
 if p_action='cancel' then
  if t.status='CANCELLED' then return to_jsonb(t);end if;
  if t.status<>'DRAFT' or length(trim(coalesce(p_notes,'')))=0 then raise exception 'Hanya draft dapat dibatalkan; isi alasan';end if;
  t.status='CANCELLED';
 elsif p_action='ship' then
  if t.status in ('SHIPPED','IN_TRANSIT','RECEIVED') then return to_jsonb(t);end if;
  if t.status<>'DRAFT' then raise exception 'Status transfer tidak dapat dikirim';end if;
  -- Stable locking order prevents deadlocks for overlapping outgoing transfers.
  perform 1 from public.wms_documents d where d.branch_id=t.source_branch and d.collection_name='stock'
   and d.document_id in (select value->>'stock_id' from jsonb_array_elements(t.items)) order by d.document_id for update;
  for item in select value from jsonb_array_elements(t.items) loop
   qty=(item->>'qty')::numeric;
   select payload into s from public.wms_documents where branch_id=t.source_branch and collection_name='stock' and document_id=item->>'stock_id';
   if s is null or coalesce((s->>'qty')::numeric,0)<qty then raise exception 'Stok berubah atau tidak cukup. Transfer tidak dikirim';end if;
   if (s->>'skuId') is distinct from (item->'stock'->>'skuId') or (s->>'expiredDate') is distinct from (item->'stock'->>'expiredDate') then raise exception 'Identitas stok berubah';end if;
   update public.wms_documents set payload=jsonb_set(payload,'{qty}',to_jsonb((s->>'qty')::numeric-qty)),updated_at=now(),updated_by=auth.uid()
    where branch_id=t.source_branch and collection_name='stock' and document_id=item->>'stock_id';
   log_id='BTO_'||t.id::text||'_'||idx;
   insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
   values(t.source_branch,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','TRANSFER_OUT','qty',qty,'skuId',s->>'skuId','skuName',s->>'skuName','expiredDate',s->>'expiredDate','locationFrom',s->>'location','locationTo',t.destination_branch,'description','Transfer cabang '||t.id::text,'user',actor_name),auth.uid());
   idx=idx+1;
  end loop;
  t.status='SHIPPED';
 elsif p_action='transit' then
  if t.status in ('IN_TRANSIT','RECEIVED') then return to_jsonb(t);end if;
  if t.status<>'SHIPPED' then raise exception 'Transfer harus dikirim dahulu';end if;
  t.status='IN_TRANSIT';
 elsif p_action='receive' then
  if t.status='RECEIVED' then
   if t.receipt is distinct from p_items then raise exception 'Transfer sudah diterima dengan rincian lain';end if;
   return to_jsonb(t);
  end if;
  if t.status<>'IN_TRANSIT' then raise exception 'Transfer harus dalam perjalanan';end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)<>jsonb_array_length(t.items) then raise exception 'Rincian penerimaan tidak lengkap';end if;
  -- Serialize destination receipts; protects first insert and aggregate quantity.
  perform pg_advisory_xact_lock(hashtextextended('branch-receipt:'||t.destination_branch,0));
  for item in select value from jsonb_array_elements(t.items) loop
   rec=p_items->idx; qty=(item->>'qty')::numeric;
   good=(rec->>'good')::numeric;damaged=(rec->>'damaged')::numeric;loc=upper(trim(coalesce(rec->>'location','')));
   if good is null or damaged is null or good<0 or damaged<0 or good<>trunc(good) or damaged<>trunc(damaged) or good+damaged>qty or length(loc) not between 1 and 80 then raise exception 'Jumlah/lokasi penerimaan tidak valid';end if;
   if (damaged>0 or good+damaged<qty) and length(trim(coalesce(p_notes,'')))=0 then raise exception 'Isi catatan kerusakan atau selisih';end if;
   if loc='RAK KAYU' then loc='RACK DISPLAY';end if;
   snapshot=jsonb_set(item->'stock','{expiredDate}',to_jsonb(item->>'normalized_ed'));
   dest_id=upper(trim(snapshot->>'skuId'))||'_'||regexp_replace(coalesce(nullif(snapshot->>'expiredDate',''),'No Expired'),'[/ .-]','_','g')||'_'||regexp_replace(loc,'[/ .-]','_','g');
   if good>0 then
    s=snapshot - 'warehouseName' - 'warehouseId' - 'totalQtySku' - 'qtyCtn' - 'qtyInner' - 'qtyLoose';
    s=s||jsonb_build_object('id',dest_id,'location',loc,'qty',good,'warehouseId','WH-CENTRAL');
    insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
    values(t.destination_branch,'stock',dest_id,s,auth.uid())
    on conflict(branch_id,collection_name,document_id) do update set
     payload=public.wms_documents.payload||jsonb_build_object('qty',coalesce((public.wms_documents.payload->>'qty')::numeric,0)+good),
     updated_at=now(),updated_by=auth.uid();
   end if;
   log_id='BTI_'||t.id::text||'_'||idx;
   insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
   values(t.destination_branch,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','TRANSFER_IN','qty',good,'skuId',snapshot->>'skuId','skuName',snapshot->>'skuName','expiredDate',snapshot->>'expiredDate','locationFrom',t.source_branch,'locationTo',loc,'description','Transfer '||t.id::text||'; rusak='||damaged||'; kurang='||(qty-good-damaged)||'; '||coalesce(p_notes,''),'user',actor_name),auth.uid());
   idx=idx+1;
  end loop;
  t.status='RECEIVED';t.receipt=p_items;t.receipt_notes=p_notes;
 end if;
 update public.branch_transfers set status=t.status,receipt=t.receipt,receipt_notes=t.receipt_notes,updated_at=now(),
 events=events||jsonb_build_array(jsonb_build_object('status',t.status,'at',now(),'by',auth.uid(),'name',actor_name,'notes',coalesce(p_notes,'')))
 where id=t.id returning * into t;
 return to_jsonb(t);
end;
$$;

create or replace function wms_private.record_stock_movement() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous numeric=0; following numeric=0; p jsonb; b text;d text; actor text;
begin
 if tg_op='DELETE' then p=old.payload;b=old.branch_id;d=old.document_id;else p=new.payload;b=new.branch_id;d=new.document_id;end if;
 if (case when tg_op='DELETE' then old.collection_name else new.collection_name end)<>'stock' or left(d,7)='SYSTEM_' then return null;end if;
 if tg_op<>'INSERT' then previous=coalesce((old.payload->>'qty')::numeric,0);end if;
 if tg_op<>'DELETE' then following=coalesce((new.payload->>'qty')::numeric,0);end if;
 if previous=following then return null;end if;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 insert into public.stock_movements(branch_id,document_id,sku_id,sku_name,location,expired_date,qty_before,qty_after,delta,operation_id,operation_type,actor_id,actor_name)
 values(b,d,p->>'skuId',p->>'skuName',p->>'location',p->>'expiredDate',previous,following,following-previous,
 coalesce(nullif(current_setting('wms.operation_id',true),''),'tx:'||txid_current()::text),
 coalesce(nullif(current_setting('wms.operation_type',true),''),tg_op),auth.uid(),actor);
 return null;
end;$$;
-- <<< stock-consistency.sql


-- >>> operational-guard.sql
create or replace function wms_private.stock_month_number(value text) returns integer language sql immutable set search_path='' as $$
 select case lower(trim(coalesce(value,'')))
  when 'jan' then 1 when 'january' then 1 when 'januari' then 1
  when 'feb' then 2 when 'february' then 2 when 'febuari' then 2 when 'pebruari' then 2
  when 'mar' then 3 when 'march' then 3 when 'maret' then 3
  when 'apr' then 4 when 'april' then 4
  when 'may' then 5 when 'mei' then 5
  when 'jun' then 6 when 'june' then 6 when 'juni' then 6
  when 'jul' then 7 when 'july' then 7 when 'juli' then 7
  when 'aug' then 8 when 'agt' then 8 when 'august' then 8 when 'agustus' then 8
  when 'sep' then 9 when 'sept' then 9 when 'september' then 9
  when 'oct' then 10 when 'okt' then 10 when 'october' then 10 when 'oktober' then 10
  when 'nov' then 11 when 'november' then 11 when 'nopember' then 11
  when 'dec' then 12 when 'des' then 12 when 'december' then 12 when 'desember' then 12
  else null end
$$;
create or replace function wms_private.stock_expired_date_key(value text) returns text language plpgsql immutable set search_path='' as $$
declare v text=trim(coalesce(value,'')); p text[]; y integer; m integer; d integer;
begin
 if lower(v) in ('','-','--','no expired','no ed','no_expired','noed') then return 'No Expired';end if;
 if v~'^[0-9]+([.][0-9]+)?$' and v::numeric between 30000 and 70000 then
  return to_char(date '1899-12-30'+floor(v::numeric)::integer,'DD/MM/YYYY');
 end if;
 p=regexp_match(v,'^([0-9]{4})[-/. ]([0-9]{1,2})[-/. ]([0-9]{1,2})([T ].*)?$');
 if p is not null then return to_char(make_date(p[1]::integer,p[2]::integer,p[3]::integer),'DD/MM/YYYY');end if;
 p=regexp_match(v,'^([0-9]{1,2})[-/. ]([0-9]{1,2})[-/. ]([0-9]{2,4})$');
 if p is not null then
  y=p[3]::integer;if length(p[3])=2 then y=2000+y;end if;
  return to_char(make_date(y,p[2]::integer,p[1]::integer),'DD/MM/YYYY');
 end if;
 p=regexp_match(v,'^([0-9]{1,2})[-/. ]([A-Za-z]{3,12})[-/. ]([0-9]{2,4})$');
 if p is not null then
  m=wms_private.stock_month_number(p[2]);y=p[3]::integer;if length(p[3])=2 then y=2000+y;end if;
  if m is not null then return to_char(make_date(y,m,p[1]::integer),'DD/MM/YYYY');end if;
 end if;
 p=regexp_match(v,'^([A-Za-z]{3,12})[-/. ]([0-9]{1,2})[-/. ]([0-9]{2,4})$');
 if p is not null then
  m=wms_private.stock_month_number(p[1]);y=p[3]::integer;if length(p[3])=2 then y=2000+y;end if;
  if m is not null then return to_char(make_date(y,m,p[2]::integer),'DD/MM/YYYY');end if;
 end if;
 p=regexp_match(v,'^([A-Za-z]{3,12})[-/. ]([0-9]{2,4})$');
 if p is not null then
  m=wms_private.stock_month_number(p[1]);y=p[2]::integer;if length(p[2])=2 then y=2000+y;end if;
  if m is not null then return to_char(make_date(y,m,1),'DD/MM/YYYY');end if;
 end if;
 p=regexp_match(v,'^([0-9]{1,2})[-/. ]([0-9]{2,4})$');
 if p is not null and p[1]::integer between 1 and 12 then
  y=p[2]::integer;if length(p[2])=2 then y=2000+y;end if;
  return to_char(make_date(y,p[1]::integer,1),'DD/MM/YYYY');
 end if;
 return upper(v);
exception when others then return upper(v);
end;$$;
create or replace function wms_private.stock_key(p jsonb) returns text language sql immutable set search_path='' as $$ select upper(trim(coalesce(nullif(p->>'warehouseId',''),'WH-CENTRAL')))||'|'||upper(trim(p->>'skuId'))||'|'||upper(trim(p->>'location'))||'|'||upper(wms_private.stock_expired_date_key(coalesce(p->>'expiredDate','No Expired'))) $$;
create or replace function wms_private.stock_pickable(p jsonb) returns boolean language sql immutable set search_path='' as $$
 select true;
$$;
create or replace function wms_private.order_deducted(p jsonb) returns boolean language sql immutable set search_path='' as $$ select coalesce(p->>'status','')<>'Cancelled' and (p->>'stockDeducted'='true' or (not(p?'stockDeducted') and (p->>'picked'='true' or p->>'isPicked'='true' or p->>'status'='Completed'))) $$;
create or replace function wms_private.validate_operational_write(b text,ups jsonb,dels jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare r text; i jsonb; p jsonb; oldp jsonb; c text; q numeric;
begin
 select role into r from public.profiles where id=auth.uid() and is_active;
 if r is null then raise exception 'Akses ditolak: akun tidak aktif atau belum terdaftar';end if;

 -- Batasi operator hanya pada koleksi operasional
 for i in select value from jsonb_array_elements(ups||dels) loop
  c=i->>'collection_name';
  if r in ('Picker','Packer') and c not in ('orders','stock','logs','batches') then 
    raise exception 'Peran operator tidak boleh mengubah koleksi %',c;
  end if;
 end loop;

 for i in select value from jsonb_array_elements(ups) loop
  c=i->>'collection_name';
  select payload into oldp from public.wms_documents where branch_id=b and collection_name=c and document_id=i->>'document_id';
  p=case when coalesce((i->>'merge')::boolean,false) then coalesce(oldp,'{}')||(i->'payload') else i->'payload' end;
  if c='stock' then
   if jsonb_typeof(p->'qty') is distinct from 'number' then raise exception 'Jumlah stok harus angka bulat';end if;
   q=(p->>'qty')::numeric;if q<0 or q<>trunc(q) or q>9007199254740991 then raise exception 'Jumlah stok tidak valid';end if;
   if coalesce(trim(p->>'skuId'),'')='' or coalesce(trim(p->>'location'),'')='' then raise exception 'Identitas stok wajib lengkap';end if;
  elsif c='orders' then
   if jsonb_typeof(p->'qty') is distinct from 'number' or (p->>'qty')::numeric<=0 or (p->>'qty')::numeric<>trunc((p->>'qty')::numeric) then raise exception 'Jumlah order harus bilangan bulat positif';end if;
   if coalesce(p->>'status','') not in ('Pending','Completed','Cancelled') then raise exception 'Status order tidak valid';end if;
  end if;
 end loop;
end;$$;
revoke all on function wms_private.stock_key(jsonb),wms_private.stock_pickable(jsonb),wms_private.order_deducted(jsonb),wms_private.validate_operational_write(text,jsonb,jsonb) from public,anon,authenticated;
create or replace function wms_private.stamp_order_completion() returns trigger language plpgsql set search_path='' as $$ begin if new.collection_name='orders' and new.payload->>'status'='Completed' and (tg_op='INSERT' or old.payload->>'status' is distinct from 'Completed') then new.payload=jsonb_set(new.payload,'{completedAt}',to_jsonb(clock_timestamp()),true);end if;return new;end;$$;
revoke all on function wms_private.stamp_order_completion() from public,anon,authenticated;
create trigger stamp_order_completion before insert or update on public.wms_documents for each row execute function wms_private.stamp_order_completion();

CREATE OR REPLACE FUNCTION wms_private.commit_wms_write(p_request_id uuid, p_branch_id text, p_upserts jsonb, p_deletes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare req wms_private.write_requests%rowtype; item jsonb; current_revision bigint; expected bigint; target_collection text;target_id text;result jsonb='[]'; body jsonb;new_revision bigint;count_items integer;
begin
 if auth.uid() is null or not public.wms_can_operate() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses tulis cabang ditolak';end if;
 if p_request_id is null or jsonb_typeof(p_upserts) is distinct from 'array' or jsonb_typeof(p_deletes) is distinct from 'array' then raise exception 'Format transaksi tidak valid';end if;
 count_items=jsonb_array_length(p_upserts)+jsonb_array_length(p_deletes);
 if count_items not between 1 and 20000 then raise exception 'Jumlah baris transaksi harus 1–20000';end if;
 body=jsonb_build_object('upserts',p_upserts,'deletes',p_deletes);
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request_id::text,0));
 select * into req from wms_private.write_requests where id=p_request_id;
 if req.id is not null then
  if req.actor_id<>auth.uid() or req.branch_id<>p_branch_id or req.body is distinct from body then raise exception 'ID transaksi sudah dipakai untuk permintaan lain';end if;
  return req.result;
 end if;
 -- One branch lock also serializes missing-row inserts and competing batches.
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 if (select count(*) from (select value->>'collection_name' c,value->>'document_id' d from jsonb_array_elements(p_upserts||p_deletes) group by 1,2) s)<>count_items then raise exception 'Baris transaksi duplikat';end if;
 -- Lock all existing rows in a consistent order, then validate every version before mutating.
 perform 1 from public.wms_documents d where d.branch_id=p_branch_id and exists(
  select 1 from jsonb_array_elements(p_upserts||p_deletes) j where j->>'collection_name'=d.collection_name and j->>'document_id'=d.document_id
 ) order by collection_name,document_id for update;
 for item in select value from jsonb_array_elements(p_upserts||p_deletes) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  if target_collection is null or target_id is null or not(item?'expected_revision') then raise exception 'Versi data wajib dikirim';end if;
  expected=(item->>'expected_revision')::bigint;
  select revision into current_revision from public.wms_documents where branch_id=p_branch_id and collection_name=target_collection and document_id=target_id;
  if current_revision is distinct from expected then raise exception using errcode='40001',message='Data telah berubah di perangkat lain. Muat data terbaru sebelum mengulangi transaksi.';end if;
 end loop;
 perform wms_private.validate_operational_write(p_branch_id,p_upserts,p_deletes);
 perform set_config('wms.operation_id',p_request_id::text,true);
 perform set_config('wms.operation_type','WMS_TRANSACTION',true);
 for item in select value from jsonb_array_elements(p_upserts) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,target_collection,target_id,(item->'payload')-'__wms_revision')
  on conflict(branch_id,collection_name,document_id) do update set payload=case when coalesce((item->>'merge')::boolean,false) then public.wms_documents.payload||excluded.payload else excluded.payload end
  returning revision into new_revision;
  result=result||jsonb_build_array(jsonb_build_object('collection_name',target_collection,'document_id',target_id,'revision',new_revision));
 end loop;
 for item in select value from jsonb_array_elements(p_deletes) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  delete from public.wms_documents where branch_id=p_branch_id and collection_name=target_collection and document_id=target_id;
  result=result||jsonb_build_array(jsonb_build_object('collection_name',target_collection,'document_id',target_id,'revision',null));
 end loop;
 insert into wms_private.write_requests(id,actor_id,branch_id,body,result) values(p_request_id,auth.uid(),p_branch_id,body,result);
 return result;
end;$function$;

CREATE OR REPLACE FUNCTION wms_private.branch_transfer_action(p_id uuid, p_action text, p_source text, p_destination text, p_items jsonb, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 t public.branch_transfers%rowtype; item jsonb; rec jsonb; s jsonb; snapshot jsonb;
 packed jsonb='[]'; idx integer=0; qty numeric; good numeric; damaged numeric; available numeric; loc text; dest_id text; actor_name text;
 seen text[]='{}'; log_id text; existing_qty numeric; role_name text;
begin
 select role,coalesce(nullif(full_name,''),email) into role_name,actor_name from public.profiles where id=auth.uid() and is_active;
 if auth.uid() is null or role_name is null or role_name not in ('Administrator','Admin') then raise exception 'Akses operasi transfer ditolak';end if;
 if p_id is null or length(coalesce(p_notes,''))>2000 then raise exception 'Permintaan tidak valid';end if;
 -- Serializes retries for a transfer even before its row exists.
 perform set_config('wms.reason',coalesce(p_notes,''),true);
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into t from public.branch_transfers where id=p_id for update;
 if p_action='create' then
  if not wms_private.can_access_branch(p_source) then raise exception 'Akses cabang asal ditolak';end if;
  if p_source is null or p_destination is null or p_source=p_destination or not exists(select 1 from public.branches where id=p_destination) then raise exception 'Cabang tujuan tidak valid';end if;
  if t.id is not null then
   if t.source_branch<>p_source or t.destination_branch<>p_destination or t.request_items is distinct from p_items then raise exception 'ID permintaan sudah dipakai';end if;
   return to_jsonb(t);
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Isi 1 sampai 100 baris barang';end if;
  for item in select value from jsonb_array_elements(p_items) loop
   qty=(item->>'qty')::numeric;
   if qty is null or qty<=0 or qty<>trunc(qty) or qty>1000000000 or coalesce(item->>'stock_id','')='' or (item->>'stock_id')=any(seen) then raise exception 'Barang atau jumlah tidak valid/duplikat';end if;
   seen=array_append(seen,item->>'stock_id');
   select payload into s from public.wms_documents where branch_id=p_source and collection_name='stock' and document_id=item->>'stock_id';
   if s is null or coalesce((s->>'qty')::numeric,0)<qty then raise exception 'Stok asal tidak cukup';end if;
   packed=packed||jsonb_build_array(jsonb_build_object('stock_id',item->>'stock_id','qty',qty,'stock',s,'normalized_ed',wms_private.transfer_expired_date(s->>'expiredDate')));
  end loop;
  insert into public.branch_transfers(id,source_branch,destination_branch,request_items,items,notes,created_by,events)
  values(p_id,p_source,p_destination,p_items,packed,coalesce(p_notes,''),auth.uid(),jsonb_build_array(jsonb_build_object('status','DRAFT','at',now(),'by',auth.uid(),'name',actor_name)))
  returning * into t;
  return to_jsonb(t);
 end if;
 if t.id is null then raise exception 'Transfer tidak ditemukan';end if;
 if p_action in ('ship','transit','cancel') then
  if not wms_private.can_access_branch(t.source_branch) then raise exception 'Hanya cabang asal yang dapat mengirim';end if;
 elsif p_action='receive' then
  if not wms_private.can_access_branch(t.destination_branch) then raise exception 'Hanya cabang tujuan yang dapat menerima';end if;
 else raise exception 'Aksi tidak valid';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||case when p_action='receive' then t.destination_branch else t.source_branch end,0));
 perform set_config('wms.operation_id',t.id::text||':'||p_action,true);
 perform set_config('wms.operation_type','BRANCH_TRANSFER_'||upper(p_action),true);
 if p_action='cancel' then
  if t.status='CANCELLED' then return to_jsonb(t);end if;
  if t.status<>'DRAFT' or length(trim(coalesce(p_notes,'')))=0 then raise exception 'Hanya draft dapat dibatalkan; isi alasan';end if;
  t.status='CANCELLED';
 elsif p_action='ship' then
  if t.status in ('SHIPPED','IN_TRANSIT','RECEIVED') then return to_jsonb(t);end if;
  if t.status<>'DRAFT' then raise exception 'Status transfer tidak dapat dikirim';end if;
  -- Stable locking order prevents deadlocks for overlapping outgoing transfers.
  perform 1 from public.wms_documents d where d.branch_id=t.source_branch and d.collection_name='stock'
   and d.document_id in (select value->>'stock_id' from jsonb_array_elements(t.items)) order by d.document_id for update;
  for item in select value from jsonb_array_elements(t.items) loop
   qty=(item->>'qty')::numeric;
   select payload into s from public.wms_documents where branch_id=t.source_branch and collection_name='stock' and document_id=item->>'stock_id';
   if s is null or coalesce((s->>'qty')::numeric,0)<qty then raise exception 'Stok berubah atau tidak cukup. Transfer tidak dikirim';end if;
   if not wms_private.stock_pickable(s) then raise exception 'Stok karantina/rusak/kedaluwarsa tidak boleh dikirim';end if;
   if (s->>'skuId') is distinct from (item->'stock'->>'skuId') or (s->>'expiredDate') is distinct from (item->'stock'->>'expiredDate') then raise exception 'Identitas stok berubah';end if;
   update public.wms_documents set payload=jsonb_set(payload,'{qty}',to_jsonb((s->>'qty')::numeric-qty)),updated_at=now(),updated_by=auth.uid()
    where branch_id=t.source_branch and collection_name='stock' and document_id=item->>'stock_id';
   log_id='BTO_'||t.id::text||'_'||idx;
   insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
   values(t.source_branch,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','TRANSFER_OUT','qty',qty,'skuId',s->>'skuId','skuName',s->>'skuName','expiredDate',s->>'expiredDate','locationFrom',s->>'location','locationTo',t.destination_branch,'description','Transfer cabang '||t.id::text,'user',actor_name),auth.uid());
   idx=idx+1;
  end loop;
  t.status='SHIPPED';
 elsif p_action='transit' then
  if t.status in ('IN_TRANSIT','RECEIVED') then return to_jsonb(t);end if;
  if t.status<>'SHIPPED' then raise exception 'Transfer harus dikirim dahulu';end if;
  t.status='IN_TRANSIT';
 elsif p_action='receive' then
  if t.status='RECEIVED' then
   if t.receipt is distinct from p_items then raise exception 'Transfer sudah diterima dengan rincian lain';end if;
   return to_jsonb(t);
  end if;
  if t.status<>'IN_TRANSIT' then raise exception 'Transfer harus dalam perjalanan';end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)<>jsonb_array_length(t.items) then raise exception 'Rincian penerimaan tidak lengkap';end if;
  -- Serialize destination receipts; protects first insert and aggregate quantity.
  perform pg_advisory_xact_lock(hashtextextended('branch-receipt:'||t.destination_branch,0));
  for item in select value from jsonb_array_elements(t.items) loop
   rec=p_items->idx; qty=(item->>'qty')::numeric;
   good=(rec->>'good')::numeric;damaged=(rec->>'damaged')::numeric;loc=upper(trim(coalesce(rec->>'location','')));
   if good is null or damaged is null or good<0 or damaged<0 or good<>trunc(good) or damaged<>trunc(damaged) or good+damaged>qty or length(loc) not between 1 and 80 then raise exception 'Jumlah/lokasi penerimaan tidak valid';end if;
   if (damaged>0 or good+damaged<qty) and length(trim(coalesce(p_notes,'')))=0 then raise exception 'Isi catatan kerusakan atau selisih';end if;
   if loc='RAK KAYU' then loc='RACK DISPLAY';end if;
   snapshot=jsonb_set(item->'stock','{expiredDate}',to_jsonb(item->>'normalized_ed'));
   dest_id=upper(trim(snapshot->>'skuId'))||'_'||regexp_replace(coalesce(nullif(snapshot->>'expiredDate',''),'No Expired'),'[/ .-]','_','g')||'_'||regexp_replace(loc,'[/ .-]','_','g');
   if good>0 then
    s=snapshot - 'warehouseName' - 'warehouseId' - 'totalQtySku' - 'qtyCtn' - 'qtyInner' - 'qtyLoose';
    s=s||jsonb_build_object('id',dest_id,'location',loc,'qty',good,'warehouseId','WH-CENTRAL');
    insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
    values(t.destination_branch,'stock',dest_id,s,auth.uid())
    on conflict(branch_id,collection_name,document_id) do update set
     payload=public.wms_documents.payload||jsonb_build_object('qty',coalesce((public.wms_documents.payload->>'qty')::numeric,0)+good),
     updated_at=now(),updated_by=auth.uid();
   end if;
   log_id='BTI_'||t.id::text||'_'||idx;
   insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
   values(t.destination_branch,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','TRANSFER_IN','qty',good,'skuId',snapshot->>'skuId','skuName',snapshot->>'skuName','expiredDate',snapshot->>'expiredDate','locationFrom',t.source_branch,'locationTo',loc,'description','Transfer '||t.id::text||'; rusak='||damaged||'; kurang='||(qty-good-damaged)||'; '||coalesce(p_notes,''),'user',actor_name),auth.uid());
   idx=idx+1;
  end loop;
  t.status='RECEIVED';t.receipt=p_items;t.receipt_notes=p_notes;
 end if;
 update public.branch_transfers set status=t.status,receipt=t.receipt,receipt_notes=t.receipt_notes,updated_at=now(),
 events=events||jsonb_build_array(jsonb_build_object('status',t.status,'at',now(),'by',auth.uid(),'name',actor_name,'notes',coalesce(p_notes,'')))
 where id=t.id returning * into t;
 return to_jsonb(t);
end;
$function$;
-- <<< operational-guard.sql


-- >>> activity-cancellations.sql

create table public.activity_events (
 id bigint generated always as identity primary key,
 branch_id text not null references public.branches(id),
 entity_type text not null,entity_id text not null,action text not null,
 actor_id uuid references auth.users(id) on delete set null,actor_name text,
 before_data jsonb,after_data jsonb,
 reason text,operation_id text,
 created_at timestamptz not null default now()
);
create index activity_branch_time_idx on public.activity_events(branch_id,created_at desc);
create index activity_entity_idx on public.activity_events(entity_type,entity_id);
alter table public.activity_events enable row level security;
revoke all on public.activity_events from public,anon,authenticated;
grant select on public.activity_events to authenticated;
grant all on public.activity_events to service_role;
grant usage,select on sequence public.activity_events_id_seq to service_role;
create policy activity_admin_read on public.activity_events for select to authenticated
using(public.wms_is_admin() and wms_private.can_access_branch(branch_id));
create function wms_private.audit_wms_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_data jsonb;new_data jsonb;row_data jsonb;b text;entity text;name text;
begin
 if tg_op<>'INSERT' then old_data=to_jsonb(old);end if;
 if tg_op<>'DELETE' then new_data=to_jsonb(new);end if;
 row_data=coalesce(new_data,old_data);
 b=case when tg_table_name='branches' then row_data->>'id' when tg_table_name='branch_transfers' then row_data->>'source_branch' else row_data->>'branch_id' end;
 entity=case when tg_table_name='wms_documents' then row_data->>'collection_name' else tg_table_name end;
 if tg_table_name='wms_documents' then
  if (old_data->'payload') is not distinct from (new_data->'payload') then return null;end if;
  old_data=old_data->'payload';new_data=new_data->'payload';
 end if;
 select coalesce(nullif(full_name,''),email) into name from public.profiles where id=auth.uid();
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,after_data,reason,operation_id)
 values(b,entity,coalesce(row_data->>'document_id',row_data->>'id'),tg_op,auth.uid(),coalesce(name,'Layanan sistem'),old_data,new_data,
 nullif(current_setting('wms.reason',true),''),nullif(current_setting('wms.operation_id',true),''));
 -- A cross-branch transfer is visible to admins at either participant.
 if tg_table_name='branch_transfers' then
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,after_data,reason,operation_id)
  values(row_data->>'destination_branch',entity,row_data->>'id',tg_op,auth.uid(),coalesce(name,'Layanan sistem'),old_data,new_data,
  nullif(current_setting('wms.reason',true),''),nullif(current_setting('wms.operation_id',true),''));
 end if;
 return null;
end;$$;
revoke all on function wms_private.audit_wms_change() from public,anon,authenticated;
create trigger audit_wms_documents after insert or update or delete on public.wms_documents for each row execute function wms_private.audit_wms_change();
create trigger audit_wms_profiles after insert or update or delete on public.profiles for each row execute function wms_private.audit_wms_change();
create trigger audit_wms_branches after insert or update on public.branches for each row execute function wms_private.audit_wms_change();
create trigger audit_branch_transfers after insert or update on public.branch_transfers for each row execute function wms_private.audit_wms_change();

create function wms_private.cancel_wms_orders(p_branch_id text,p_items jsonb,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;o jsonb;s jsonb;stock_id text;loc text;ed text;wh text;qty numeric;revision_now bigint;expected bigint;actor text;cancelled jsonb='[]';log_id text;name text;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Hanya admin cabang yang dapat membatalkan order';end if;
 if length(trim(coalesce(p_reason,''))) not between 5 and 1000 then raise exception 'Isi alasan pembatalan 5–1000 karakter';end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Pilih 1–100 order';end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then raise exception 'Order duplikat';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 perform set_config('wms.operation_id','CANCEL_ORDERS:'||gen_random_uuid()::text,true);
 perform set_config('wms.operation_type','ORDER_CANCELLATION',true);
 perform set_config('wms.reason',trim(p_reason),true);
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 for item in select value from jsonb_array_elements(p_items) order by value->>'id' loop
  select payload,revision into o,revision_now from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and document_id=item->>'id' for update;
  if o is null then raise exception 'Order tidak ditemukan';end if;
  if o->>'status'='Cancelled' then cancelled=cancelled||jsonb_build_array(item->>'id');continue;end if;
  expected=(item->>'expected_revision')::bigint;
  if expected is null or expected<>revision_now then raise exception using errcode='40001',message='Order berubah. Muat data terbaru sebelum membatalkan.';end if;
  if coalesce((o->>'shipped')::boolean,false) or o->>'shippedAt' is not null then raise exception 'Order sudah dikirim. Catat pengembalian barang melalui alur retur';end if;
  qty=(o->>'qty')::numeric;
  if qty is null or qty<=0 or qty<>trunc(qty) then raise exception 'Jumlah order tidak valid';end if;
  if coalesce((o->>'stockDeducted')::boolean,(o->>'status'='Completed' or coalesce((o->>'picked')::boolean,false))) then
   ed=wms_private.transfer_expired_date(o->>'expiredDate');
   loc=upper(trim(coalesce(o->>'location','')));wh=upper(trim(coalesce(o->>'warehouseId','WH-CENTRAL')));
   if length(loc) not between 1 and 128 or length(trim(coalesce(o->>'skuId','')))=0 then raise exception 'Lokasi atau SKU asal order tidak lengkap';end if;
   if loc='RAK KAYU' then loc='RACK DISPLAY';end if;
   stock_id=case when wh in ('','WH-CENTRAL') then '' else wh||'_' end||upper(trim(o->>'skuId'))||'_'||regexp_replace(ed,'[/ .-]','_','g')||'_'||regexp_replace(loc,'[/ .-]','_','g');
   s=jsonb_build_object('id',stock_id,'skuId',upper(trim(o->>'skuId')),'skuName',o->>'skuName','expiredDate',ed,'location',loc,'warehouseId',wh,'qty',qty);
   insert into public.wms_documents(branch_id,collection_name,document_id,payload)
   values(p_branch_id,'stock',stock_id,s)
   on conflict(branch_id,collection_name,document_id) do update
   set payload=public.wms_documents.payload||jsonb_build_object('qty',coalesce((public.wms_documents.payload->>'qty')::numeric,0)+qty);
  end if;
  update public.wms_documents set payload=payload||jsonb_build_object('status','Cancelled','stockDeducted',false,'cancelledAt',now(),'cancelledBy',auth.uid(),'cancelledByName',actor,'cancellationReason',trim(p_reason))
  where branch_id=p_branch_id and collection_name='orders' and document_id=item->>'id';
  log_id='CANCEL_ORDER_'||(item->>'id');
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','ADJUSTMENT','qty',qty,'skuId',o->>'skuId','skuName',o->>'skuName','locationFrom','ORDER_CANCEL','locationTo',o->>'location','user',actor,'description','Pembatalan order '||(item->>'id')||': '||trim(p_reason)));
  cancelled=cancelled||jsonb_build_array(item->>'id');
 end loop;
 return cancelled;
end;$$;
revoke all on function wms_private.cancel_wms_orders(text,jsonb,text) from public,anon;
grant execute on function wms_private.cancel_wms_orders(text,jsonb,text) to authenticated;
create function public.cancel_wms_orders(p_branch_id text,p_items jsonb,p_reason text) returns jsonb
language sql security invoker set search_path='' as $$select wms_private.cancel_wms_orders(p_branch_id,p_items,p_reason)$$;
revoke all on function public.cancel_wms_orders(text,jsonb,text) from public,anon;
grant execute on function public.cancel_wms_orders(text,jsonb,text) to authenticated;


create function wms_private.protect_transaction_history() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.collection_name='orders' then
  if tg_op='DELETE' then raise exception 'Riwayat order tidak boleh dihapus. Gunakan pembatalan beralasan';end if;
  if old.payload->>'status'='Cancelled' and new.payload is distinct from old.payload then raise exception 'Order yang dibatalkan tidak dapat diubah atau dibuka kembali';end if;
  if new.payload->>'status'='Cancelled' and old.payload->>'status' is distinct from 'Cancelled' and current_setting('wms.operation_type',true) is distinct from 'ORDER_CANCELLATION' then raise exception 'Gunakan pembatalan order resmi';end if;
 end if;
 if old.collection_name='logs' and (tg_op='DELETE' or new.payload is distinct from old.payload) then raise exception 'Riwayat mutasi tidak boleh diubah atau dihapus. Buat koreksi baru';end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
revoke all on function wms_private.protect_transaction_history() from public,anon,authenticated;
create trigger protect_transaction_history before update or delete on public.wms_documents for each row execute function wms_private.protect_transaction_history();

create or replace function wms_private.cancel_wms_orders(p_branch_id text,p_items jsonb,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;o jsonb;s jsonb;stock_id text;loc text;ed text;wh text;qty numeric;revision_now bigint;expected bigint;actor text;cancelled jsonb='[]';log_id text;name text;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Hanya admin cabang yang dapat membatalkan order';end if;
 if length(trim(coalesce(p_reason,''))) not between 5 and 1000 then raise exception 'Isi alasan pembatalan 5–1000 karakter';end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Pilih 1–100 order';end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then raise exception 'Order duplikat';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 perform set_config('wms.operation_id','CANCEL_ORDERS:'||gen_random_uuid()::text,true);
 perform set_config('wms.operation_type','ORDER_CANCELLATION',true);
 perform set_config('wms.reason',trim(p_reason),true);
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 for item in select value from jsonb_array_elements(p_items) order by value->>'id' loop
  select payload,revision into o,revision_now from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and document_id=item->>'id' for update;
  if o is null then raise exception 'Order tidak ditemukan';end if;
  if o->>'status'='Cancelled' then cancelled=cancelled||jsonb_build_array(item->>'id');continue;end if;
  expected=(item->>'expected_revision')::bigint;
  if expected is null or expected<>revision_now then raise exception using errcode='40001',message='Order berubah. Muat data terbaru sebelum membatalkan.';end if;
  if coalesce((o->>'shipped')::boolean,false) or o->>'shippedAt' is not null then raise exception 'Order sudah dikirim. Catat pengembalian barang melalui alur retur';end if;
  qty=(o->>'qty')::numeric;
  if qty is null or qty<=0 or qty<>trunc(qty) then raise exception 'Jumlah order tidak valid';end if;
  if coalesce((o->>'stockDeducted')::boolean,(o->>'status'='Completed' or coalesce((o->>'picked')::boolean,false))) then
   ed=wms_private.transfer_expired_date(o->>'expiredDate');
   loc=upper(trim(coalesce(o->>'location','')));wh=upper(trim(coalesce(o->>'warehouseId','WH-CENTRAL')));
   if length(loc) not between 1 and 128 or length(trim(coalesce(o->>'skuId','')))=0 then raise exception 'Lokasi atau SKU asal order tidak lengkap';end if;
   if loc='RAK KAYU' then loc='RACK DISPLAY';end if;
   stock_id=case when wh in ('','WH-CENTRAL') then '' else wh||'_' end||upper(trim(o->>'skuId'))||'_'||regexp_replace(ed,'[/ .-]','_','g')||'_'||regexp_replace(loc,'[/ .-]','_','g');
   s=jsonb_build_object('id',stock_id,'skuId',upper(trim(o->>'skuId')),'skuName',o->>'skuName','expiredDate',ed,'location',loc,'warehouseId',wh,'qty',qty);
   insert into public.wms_documents(branch_id,collection_name,document_id,payload)
   values(p_branch_id,'stock',stock_id,s)
   on conflict(branch_id,collection_name,document_id) do update
   set payload=public.wms_documents.payload||jsonb_build_object('qty',coalesce((public.wms_documents.payload->>'qty')::numeric,0)+qty);
  end if;
  update public.wms_documents set payload=payload||jsonb_build_object('status','Cancelled','stockDeducted',false,'cancelledAt',now(),'cancelledBy',auth.uid(),'cancelledByName',actor,'cancellationReason',trim(p_reason))
  where branch_id=p_branch_id and collection_name='orders' and document_id=item->>'id';
  log_id='CANCEL_ORDER_'||md5(item->>'id');
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','ADJUSTMENT','qty',qty,'skuId',o->>'skuId','skuName',o->>'skuName','locationFrom','ORDER_CANCEL','locationTo',o->>'location','user',actor,'description','Pembatalan order '||(item->>'id')||': '||trim(p_reason)));
  cancelled=cancelled||jsonb_build_array(item->>'id');
 end loop;
 return cancelled;
end;$$;

create or replace function wms_private.branch_transfer_action(p_id uuid,p_action text,p_source text,p_destination text,p_items jsonb,p_notes text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 t public.branch_transfers%rowtype; item jsonb; rec jsonb; s jsonb; snapshot jsonb;
 packed jsonb='[]'; idx integer=0; qty numeric; good numeric; damaged numeric; available numeric; loc text; dest_id text; actor_name text;
 seen text[]='{}'; log_id text; existing_qty numeric; role_name text;
begin
 select role,coalesce(nullif(full_name,''),email) into role_name,actor_name from public.profiles where id=auth.uid() and is_active;
 if auth.uid() is null or role_name is null or role_name not in ('Administrator','Admin','Picker','Packer') then raise exception 'Akses operasi transfer ditolak';end if;
 if p_id is null or length(coalesce(p_notes,''))>2000 then raise exception 'Permintaan tidak valid';end if;
 -- Serializes retries for a transfer even before its row exists.
 perform set_config('wms.reason',coalesce(p_notes,''),true);
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into t from public.branch_transfers where id=p_id for update;
 if p_action='create' then
  if not wms_private.can_access_branch(p_source) then raise exception 'Akses cabang asal ditolak';end if;
  if p_source is null or p_destination is null or p_source=p_destination or not exists(select 1 from public.branches where id=p_destination) then raise exception 'Cabang tujuan tidak valid';end if;
  if t.id is not null then
   if t.source_branch<>p_source or t.destination_branch<>p_destination or t.request_items is distinct from p_items then raise exception 'ID permintaan sudah dipakai';end if;
   return to_jsonb(t);
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Isi 1 sampai 100 baris barang';end if;
  for item in select value from jsonb_array_elements(p_items) loop
   qty=(item->>'qty')::numeric;
   if qty is null or qty<=0 or qty<>trunc(qty) or qty>1000000000 or coalesce(item->>'stock_id','')='' or (item->>'stock_id')=any(seen) then raise exception 'Barang atau jumlah tidak valid/duplikat';end if;
   seen=array_append(seen,item->>'stock_id');
   select payload into s from public.wms_documents where branch_id=p_source and collection_name='stock' and document_id=item->>'stock_id';
   if s is null or coalesce((s->>'qty')::numeric,0)<qty then raise exception 'Stok asal tidak cukup';end if;
   packed=packed||jsonb_build_array(jsonb_build_object('stock_id',item->>'stock_id','qty',qty,'stock',s,'normalized_ed',wms_private.transfer_expired_date(s->>'expiredDate')));
  end loop;
  insert into public.branch_transfers(id,source_branch,destination_branch,request_items,items,notes,created_by,events)
  values(p_id,p_source,p_destination,p_items,packed,coalesce(p_notes,''),auth.uid(),jsonb_build_array(jsonb_build_object('status','DRAFT','at',now(),'by',auth.uid(),'name',actor_name)))
  returning * into t;
  return to_jsonb(t);
 end if;
 if t.id is null then raise exception 'Transfer tidak ditemukan';end if;
 if p_action in ('ship','transit','cancel') then
  if not wms_private.can_access_branch(t.source_branch) then raise exception 'Hanya cabang asal yang dapat mengirim';end if;
 elsif p_action='receive' then
  if not wms_private.can_access_branch(t.destination_branch) then raise exception 'Hanya cabang tujuan yang dapat menerima';end if;
 else raise exception 'Aksi tidak valid';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||case when p_action='receive' then t.destination_branch else t.source_branch end,0));
 perform set_config('wms.operation_id',t.id::text||':'||p_action,true);
 perform set_config('wms.operation_type','BRANCH_TRANSFER_'||upper(p_action),true);
 if p_action='cancel' then
  if t.status='CANCELLED' then return to_jsonb(t);end if;
  if t.status<>'DRAFT' or length(trim(coalesce(p_notes,'')))=0 then raise exception 'Hanya draft dapat dibatalkan; isi alasan';end if;
  t.status='CANCELLED';
 elsif p_action='ship' then
  if t.status in ('SHIPPED','IN_TRANSIT','RECEIVED') then return to_jsonb(t);end if;
  if t.status<>'DRAFT' then raise exception 'Status transfer tidak dapat dikirim';end if;
  -- Stable locking order prevents deadlocks for overlapping outgoing transfers.
  perform 1 from public.wms_documents d where d.branch_id=t.source_branch and d.collection_name='stock'
   and d.document_id in (select value->>'stock_id' from jsonb_array_elements(t.items)) order by d.document_id for update;
  for item in select value from jsonb_array_elements(t.items) loop
   qty=(item->>'qty')::numeric;
   select payload into s from public.wms_documents where branch_id=t.source_branch and collection_name='stock' and document_id=item->>'stock_id';
   if s is null or coalesce((s->>'qty')::numeric,0)<qty then raise exception 'Stok berubah atau tidak cukup. Transfer tidak dikirim';end if;
   if (s->>'skuId') is distinct from (item->'stock'->>'skuId') or (s->>'expiredDate') is distinct from (item->'stock'->>'expiredDate') then raise exception 'Identitas stok berubah';end if;
   update public.wms_documents set payload=jsonb_set(payload,'{qty}',to_jsonb((s->>'qty')::numeric-qty)),updated_at=now(),updated_by=auth.uid()
    where branch_id=t.source_branch and collection_name='stock' and document_id=item->>'stock_id';
   log_id='BTO_'||t.id::text||'_'||idx;
   insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
   values(t.source_branch,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','TRANSFER_OUT','qty',qty,'skuId',s->>'skuId','skuName',s->>'skuName','expiredDate',s->>'expiredDate','locationFrom',s->>'location','locationTo',t.destination_branch,'description','Transfer cabang '||t.id::text,'user',actor_name),auth.uid());
   idx=idx+1;
  end loop;
  t.status='SHIPPED';
 elsif p_action='transit' then
  if t.status in ('IN_TRANSIT','RECEIVED') then return to_jsonb(t);end if;
  if t.status<>'SHIPPED' then raise exception 'Transfer harus dikirim dahulu';end if;
  t.status='IN_TRANSIT';
 elsif p_action='receive' then
  if t.status='RECEIVED' then
   if t.receipt is distinct from p_items then raise exception 'Transfer sudah diterima dengan rincian lain';end if;
   return to_jsonb(t);
  end if;
  if t.status<>'IN_TRANSIT' then raise exception 'Transfer harus dalam perjalanan';end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)<>jsonb_array_length(t.items) then raise exception 'Rincian penerimaan tidak lengkap';end if;
  -- Serialize destination receipts; protects first insert and aggregate quantity.
  perform pg_advisory_xact_lock(hashtextextended('branch-receipt:'||t.destination_branch,0));
  for item in select value from jsonb_array_elements(t.items) loop
   rec=p_items->idx; qty=(item->>'qty')::numeric;
   good=(rec->>'good')::numeric;damaged=(rec->>'damaged')::numeric;loc=upper(trim(coalesce(rec->>'location','')));
   if good is null or damaged is null or good<0 or damaged<0 or good<>trunc(good) or damaged<>trunc(damaged) or good+damaged>qty or length(loc) not between 1 and 80 then raise exception 'Jumlah/lokasi penerimaan tidak valid';end if;
   if (damaged>0 or good+damaged<qty) and length(trim(coalesce(p_notes,'')))=0 then raise exception 'Isi catatan kerusakan atau selisih';end if;
   if loc='RAK KAYU' then loc='RACK DISPLAY';end if;
   snapshot=jsonb_set(item->'stock','{expiredDate}',to_jsonb(item->>'normalized_ed'));
   dest_id=upper(trim(snapshot->>'skuId'))||'_'||regexp_replace(coalesce(nullif(snapshot->>'expiredDate',''),'No Expired'),'[/ .-]','_','g')||'_'||regexp_replace(loc,'[/ .-]','_','g');
   if good>0 then
    s=snapshot - 'warehouseName' - 'warehouseId' - 'totalQtySku' - 'qtyCtn' - 'qtyInner' - 'qtyLoose';
    s=s||jsonb_build_object('id',dest_id,'location',loc,'qty',good,'warehouseId','WH-CENTRAL');
    insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
    values(t.destination_branch,'stock',dest_id,s,auth.uid())
    on conflict(branch_id,collection_name,document_id) do update set
     payload=public.wms_documents.payload||jsonb_build_object('qty',coalesce((public.wms_documents.payload->>'qty')::numeric,0)+good),
     updated_at=now(),updated_by=auth.uid();
   end if;
   log_id='BTI_'||t.id::text||'_'||idx;
   insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
   values(t.destination_branch,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','TRANSFER_IN','qty',good,'skuId',snapshot->>'skuId','skuName',snapshot->>'skuName','expiredDate',snapshot->>'expiredDate','locationFrom',t.source_branch,'locationTo',loc,'description','Transfer '||t.id::text||'; rusak='||damaged||'; kurang='||(qty-good-damaged)||'; '||coalesce(p_notes,''),'user',actor_name),auth.uid());
   idx=idx+1;
  end loop;
  t.status='RECEIVED';t.receipt=p_items;t.receipt_notes=p_notes;
 end if;
 update public.branch_transfers set status=t.status,receipt=t.receipt,receipt_notes=t.receipt_notes,updated_at=now(),
 events=events||jsonb_build_array(jsonb_build_object('status',t.status,'at',now(),'by',auth.uid(),'name',actor_name,'notes',coalesce(p_notes,'')))
 where id=t.id returning * into t;
 return to_jsonb(t);
end;
$$;
create or replace function wms_private.cancel_wms_orders(p_branch_id text,p_items jsonb,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;o jsonb;s jsonb;stock_id text;loc text;ed text;wh text;qty numeric;revision_now bigint;expected bigint;actor text;cancelled jsonb='[]';log_id text;name text;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Hanya admin cabang yang dapat membatalkan order';end if;
 if length(trim(coalesce(p_reason,''))) not between 5 and 1000 then raise exception 'Isi alasan pembatalan 5–1000 karakter';end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Pilih 1–100 order';end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then raise exception 'Order duplikat';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 perform set_config('wms.operation_id','CANCEL_ORDERS:'||gen_random_uuid()::text,true);
 perform set_config('wms.operation_type','ORDER_CANCELLATION',true);
 perform set_config('wms.reason',trim(p_reason),true);
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 for item in select value from jsonb_array_elements(p_items) order by value->>'id' loop
  select payload,revision into o,revision_now from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and document_id=item->>'id' for update;
  if o is null then raise exception 'Order tidak ditemukan';end if;
  if o->>'status'='Cancelled' then cancelled=cancelled||jsonb_build_array(item->>'id');continue;end if;
  expected=(item->>'expected_revision')::bigint;
  if expected is null or expected<>revision_now then raise exception using errcode='40001',message='Order berubah. Muat data terbaru sebelum membatalkan.';end if;
  if coalesce((o->>'shipped')::boolean,false) or o->>'shippedAt' is not null then raise exception 'Order sudah dikirim. Catat pengembalian barang melalui alur retur';end if;
  qty=(o->>'qty')::numeric;
  if qty is null or qty<=0 or qty<>trunc(qty) then raise exception 'Jumlah order tidak valid';end if;
  if coalesce((o->>'stockDeducted')::boolean,(o->>'status'='Completed' or coalesce((o->>'picked')::boolean,false) or coalesce((o->>'isPicked')::boolean,false))) then
   if length(trim(coalesce(o->>'expiredDate','')))=0 then raise exception 'ED asal order tidak lengkap. Periksa lot stok sebelum pembatalan';end if;
   ed=wms_private.transfer_expired_date(o->>'expiredDate');
   loc=upper(trim(coalesce(o->>'location','')));wh=upper(trim(coalesce(o->>'warehouseId','WH-CENTRAL')));
   if length(loc) not between 1 and 128 or length(trim(coalesce(o->>'skuId','')))=0 then raise exception 'Lokasi atau SKU asal order tidak lengkap';end if;
   if loc='RAK KAYU' then loc='RACK DISPLAY';end if;
   stock_id=case when wh in ('','WH-CENTRAL') then '' else wh||'_' end||upper(trim(o->>'skuId'))||'_'||regexp_replace(ed,'[/ .-]','_','g')||'_'||regexp_replace(loc,'[/ .-]','_','g');
   s=jsonb_build_object('id',stock_id,'skuId',upper(trim(o->>'skuId')),'skuName',o->>'skuName','expiredDate',ed,'location',loc,'warehouseId',wh,'qty',qty);
   insert into public.wms_documents(branch_id,collection_name,document_id,payload)
   values(p_branch_id,'stock',stock_id,s)
   on conflict(branch_id,collection_name,document_id) do update
   set payload=public.wms_documents.payload||jsonb_build_object('qty',coalesce((public.wms_documents.payload->>'qty')::numeric,0)+qty);
  end if;
  update public.wms_documents set payload=payload||jsonb_build_object('status','Cancelled','stockDeducted',false,'cancelledAt',now(),'cancelledBy',auth.uid(),'cancelledByName',actor,'cancellationReason',trim(p_reason))
  where branch_id=p_branch_id and collection_name='orders' and document_id=item->>'id';
  log_id='CANCEL_ORDER_'||md5(item->>'id');
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,'logs',log_id,jsonb_build_object('id',log_id,'timestamp',now(),'type','ADJUSTMENT','qty',qty,'skuId',o->>'skuId','skuName',o->>'skuName','locationFrom','ORDER_CANCEL','locationTo',o->>'location','user',actor,'description','Pembatalan order '||(item->>'id')||': '||trim(p_reason)));
  cancelled=cancelled||jsonb_build_array(item->>'id');
 end loop;
 return cancelled;
end;$$;

create or replace function wms_private.audit_wms_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_data jsonb;new_data jsonb;row_data jsonb;b text;entity text;name text;
begin
 if tg_op<>'INSERT' then old_data=to_jsonb(old);end if;
 if tg_op<>'DELETE' then new_data=to_jsonb(new);end if;
 row_data=coalesce(new_data,old_data);
 if tg_table_name='profiles' and not coalesce((row_data->>'is_active')::boolean,false) and not coalesce((old_data->>'is_active')::boolean,false) then return null;end if;
 b=case when tg_table_name='branches' then row_data->>'id' when tg_table_name='branch_transfers' then row_data->>'source_branch' else row_data->>'branch_id' end;
 entity=case when tg_table_name='wms_documents' then row_data->>'collection_name' else tg_table_name end;
 if tg_table_name='wms_documents' then
  if (old_data->'payload') is not distinct from (new_data->'payload') then return null;end if;
  old_data=old_data->'payload';new_data=new_data->'payload';
 end if;
 select coalesce(nullif(full_name,''),email) into name from public.profiles where id=auth.uid();
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,after_data,reason,operation_id)
 values(b,entity,coalesce(row_data->>'document_id',row_data->>'id'),tg_op,auth.uid(),coalesce(name,'Layanan sistem'),old_data,new_data,
 nullif(current_setting('wms.reason',true),''),nullif(current_setting('wms.operation_id',true),''));
 -- A cross-branch transfer is visible to admins at either participant.
 if tg_table_name='branch_transfers' then
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,after_data,reason,operation_id)
  values(row_data->>'destination_branch',entity,row_data->>'id',tg_op,auth.uid(),coalesce(name,'Layanan sistem'),old_data,new_data,
  nullif(current_setting('wms.reason',true),''),nullif(current_setting('wms.operation_id',true),''));
 end if;
 return null;
end;$$;
-- <<< activity-cancellations.sql


-- >>> basket-session-write-safety.sql
CREATE OR REPLACE FUNCTION wms_private.commit_wms_write(p_request_id uuid, p_branch_id text, p_upserts jsonb, p_deletes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare req wms_private.write_requests%rowtype; item jsonb; current_revision bigint; expected bigint; target_collection text;target_id text;result jsonb='[]'; body jsonb;new_revision bigint;count_items integer;
begin
 if auth.uid() is null or not public.wms_can_operate() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses tulis cabang ditolak';end if;
 if p_request_id is null or jsonb_typeof(p_upserts) is distinct from 'array' or jsonb_typeof(p_deletes) is distinct from 'array' then raise exception 'Format transaksi tidak valid';end if;
 count_items=jsonb_array_length(p_upserts)+jsonb_array_length(p_deletes);
 if count_items not between 1 and 20000 then raise exception 'Jumlah baris transaksi harus 1–20000';end if;
 body=jsonb_build_object('upserts',p_upserts,'deletes',p_deletes);
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request_id::text,0));
 select * into req from wms_private.write_requests where id=p_request_id;
 if req.id is not null then
  if req.actor_id<>auth.uid() or req.branch_id<>p_branch_id or req.body is distinct from body then raise exception 'ID transaksi sudah dipakai untuk permintaan lain';end if;
  return req.result;
 end if;
 -- One branch lock also serializes missing-row inserts and competing batches.
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 if (select count(*) from (select value->>'collection_name' c,value->>'document_id' d from jsonb_array_elements(p_upserts||p_deletes) group by 1,2) s)<>count_items then raise exception 'Baris transaksi duplikat';end if;
 -- Lock all existing rows in a consistent order, then validate every version before mutating.
 perform 1 from public.wms_documents d where d.branch_id=p_branch_id and exists(
  select 1 from jsonb_array_elements(p_upserts||p_deletes) j where j->>'collection_name'=d.collection_name and j->>'document_id'=d.document_id
 ) order by collection_name,document_id for update;
 for item in select value from jsonb_array_elements(p_upserts||p_deletes) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  if target_collection is null or target_id is null or not(item?'expected_revision') then raise exception 'Versi data wajib dikirim';end if;
  expected=(item->>'expected_revision')::bigint;
  select revision into current_revision from public.wms_documents where branch_id=p_branch_id and collection_name=target_collection and document_id=target_id;
  if current_revision is distinct from expected then raise exception using errcode='PT409',message='Data telah berubah di perangkat lain. Muat data terbaru sebelum mengulangi transaksi.';end if;
 end loop;
 perform wms_private.validate_operational_write(p_branch_id,p_upserts,p_deletes);
 perform set_config('wms.operation_id',p_request_id::text,true);
 perform set_config('wms.operation_type','WMS_TRANSACTION',true);
 for item in select value from jsonb_array_elements(p_upserts) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,target_collection,target_id,(item->'payload')-'__wms_revision')
  on conflict(branch_id,collection_name,document_id) do update set payload=case when coalesce((item->>'merge')::boolean,false) then public.wms_documents.payload||excluded.payload else excluded.payload end
  returning revision into new_revision;
  result=result||jsonb_build_array(jsonb_build_object('collection_name',target_collection,'document_id',target_id,'revision',new_revision));
 end loop;
 for item in select value from jsonb_array_elements(p_deletes) loop
  target_collection=item->>'collection_name';target_id=item->>'document_id';
  delete from public.wms_documents where branch_id=p_branch_id and collection_name=target_collection and document_id=target_id;
  result=result||jsonb_build_array(jsonb_build_object('collection_name',target_collection,'document_id',target_id,'revision',null));
 end loop;
 insert into wms_private.write_requests(id,actor_id,branch_id,body,result) values(p_request_id,auth.uid(),p_branch_id,body,result);
 return result;
end;$function$
;
-- <<< basket-session-write-safety.sql


-- >>> order-stage-actors.sql
create or replace function wms_private.stamp_order_completion() returns trigger language plpgsql set search_path='' as $f$
declare actor text; previous jsonb='{}'; origin jsonb; stage_time timestamptz=clock_timestamp();
begin
 if new.collection_name<>'orders' then return new;end if;
 -- An UPSERT runs BEFORE INSERT before its conflict UPDATE. Preserve the incoming request for the UPDATE trigger to validate.
 if tg_op='INSERT' and exists(select 1 from public.wms_documents d where d.branch_id=new.branch_id and d.collection_name=new.collection_name and d.document_id=new.document_id) then return new;end if;
 if tg_op='UPDATE' then previous=old.payload;end if;
 select coalesce(nullif(btrim(full_name),''),email) into actor from public.profiles where id=auth.uid() and is_active;
 if tg_op='INSERT' then
  select d.payload into origin from public.wms_documents d where d.collection_name='orders' and d.branch_id=new.branch_id and d.payload->>'referenceNumber'=new.payload->>'referenceNumber' order by d.updated_at limit 1;
  new.payload=new.payload - array['createdBy','createdById','createdAt','sortedBy','sortedById','sortedAt'];
  if origin is not null then
   new.payload=new.payload||jsonb_strip_nulls(jsonb_build_object('createdBy',origin->'createdBy','createdById',origin->'createdById','createdAt',origin->'createdAt','sortedBy',origin->'sortedBy','sortedById',origin->'sortedById','sortedAt',origin->'sortedAt'));
  elsif actor is not null then new.payload=new.payload||jsonb_build_object('createdBy',actor,'createdById',auth.uid(),'createdAt',stage_time);end if;
 else
  new.payload=(new.payload-array['createdBy','createdById','createdAt'])||jsonb_strip_nulls(jsonb_build_object('createdBy',previous->'createdBy','createdById',previous->'createdById','createdAt',previous->'createdAt'));
  if nullif(new.payload->>'sortedAt','') is not null and new.payload->>'sortedAt' is distinct from previous->>'sortedAt' then
   if new.payload->>'status' is distinct from 'Pending' or not wms_private.order_deducted(new.payload) then raise exception 'Sortir hanya untuk order yang sudah dipick dan belum selesai';end if;
   new.payload=(new.payload-array['sortedBy','sortedById','sortedAt'])||jsonb_strip_nulls(jsonb_build_object('sortedBy',actor,'sortedById',auth.uid(),'sortedAt',stage_time));
  else new.payload=(new.payload-array['sortedBy','sortedById','sortedAt'])||jsonb_strip_nulls(jsonb_build_object('sortedBy',previous->'sortedBy','sortedById',previous->'sortedById','sortedAt',previous->'sortedAt'));end if;
 end if;
 if wms_private.order_deducted(new.payload) and (tg_op='INSERT' or not wms_private.order_deducted(previous)) then
  new.payload=(new.payload-array['pickedBy','pickedById','pickedAt'])||jsonb_strip_nulls(jsonb_build_object('pickedBy',actor,'pickedById',auth.uid(),'pickedAt',stage_time));
 elsif tg_op='UPDATE' then new.payload=(new.payload-array['pickedBy','pickedById','pickedAt'])||jsonb_strip_nulls(jsonb_build_object('pickedBy',previous->'pickedBy','pickedById',previous->'pickedById','pickedAt',previous->'pickedAt'));end if;
 if new.payload->>'status'='Completed' and (tg_op='INSERT' or previous->>'status' is distinct from 'Completed') then
  new.payload=(new.payload-array['packedBy','packedById','packedAt','completedAt'])||jsonb_strip_nulls(jsonb_build_object('packedBy',actor,'packedById',auth.uid(),'packedAt',stage_time,'completedAt',stage_time));
 elsif tg_op='UPDATE' then new.payload=(new.payload-array['packedBy','packedById','packedAt','completedAt'])||jsonb_strip_nulls(jsonb_build_object('packedBy',previous->'packedBy','packedById',previous->'packedById','packedAt',previous->'packedAt','completedAt',previous->'completedAt'));end if;
 return new;
end;$f$;
revoke all on function wms_private.stamp_order_completion() from public,anon,authenticated;
-- <<< order-stage-actors.sql


-- >>> order-import.sql

-- Atomic multi-order import. No physical stock is deducted until picking.
create or replace function wms_private.import_wms_orders(p_request_id uuid,p_branch_id text,p_warehouse_id text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; ups jsonb='[]'; body jsonb; req wms_private.write_requests%rowtype;
 actor text; grp record; physical numeric; reserved numeric; ed text; loc text; item_id text; result jsonb; batch_row public.wms_documents%rowtype; batch_items jsonb; batch_payload jsonb; batch_id text;
begin
 if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and is_active and role in ('Administrator','Admin')) or not wms_private.can_access_branch(p_branch_id) then raise exception 'Impor order hanya untuk admin cabang yang berwenang';end if;
 if p_request_id is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 5000 then raise exception 'Impor harus berisi 1–5000 baris alokasi';end if;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 -- Same lock order as the normal write gateway.
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 for item in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(item) is distinct from 'object' or length(trim(coalesce(item->>'orderNumber',''))) not between 1 and 128
    or length(trim(coalesce(item->>'skuId',''))) not between 1 and 128
    or length(trim(coalesce(item->>'customerName',''))) > 200
    or length(trim(coalesce(item->>'noPo',''))) > 128
    or length(trim(coalesce(item->>'batchNumber',''))) > 128
    or jsonb_typeof(item->'qty') is distinct from 'number' or coalesce(item->>'qty','') !~ '^[1-9][0-9]*$'
    or item->>'warehouseId' is distinct from p_warehouse_id
    or item->>'status' is distinct from 'Pending' or item->'stockDeducted' is distinct from 'false'::jsonb
    or item->'picked' is distinct from 'false'::jsonb or item->'scanned' is distinct from 'false'::jsonb
    or item->>'referenceNumber' is distinct from item->>'orderNumber'
    or coalesce(item->>'id','') !~ ('^IMP_'||replace(p_request_id::text,'-','')||'_[0-9]+$')
  then raise exception 'Format baris impor tidak valid';end if;
  loc=upper(trim(item->>'location'));ed=item->>'expiredDate';
  if loc is null or regexp_replace(loc,'[-_[:space:]]','','g') ~ '(ZONE1|URBAN)' then raise exception 'Lokasi buffer tidak dapat dipakai untuk order';end if;
  if ed is null or lower(ed) ~ '(damage|expired)' and ed<>'No Expired' then raise exception 'Stok rusak/kedaluwarsa tidak dapat diorder';end if;
  if ed<>'No Expired' then
   if ed !~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' or to_char(to_date(ed,'DD/MM/YYYY'),'DD/MM/YYYY')<>ed or to_date(ed,'DD/MM/YYYY') <= (now() at time zone 'Asia/Jakarta')::date then raise exception 'Tanggal kedaluwarsa order tidak valid atau sudah lewat';end if;
  end if;
  item_id=item->>'id';
  ups=ups||jsonb_build_array(jsonb_build_object('collection_name','orders','document_id',item_id,'expected_revision',null,'payload',item));
  ups=ups||jsonb_build_array(jsonb_build_object('collection_name','logs','document_id','LOG_'||item_id,'expected_revision',null,'payload',
   jsonb_build_object('id','LOG_'||item_id,'timestamp',item->>'timestamp','type','ADJUSTMENT','skuId',item->>'skuId','skuName',item->>'skuName','qty',item->'qty','locationFrom','Import Order','locationTo',loc,'warehouseId',p_warehouse_id,'user',actor,'description','Impor order '||(item->>'orderNumber')||': menunggu picking, stok fisik belum dipotong')));
 end loop;
 body=jsonb_build_object('upserts',ups,'deletes','[]'::jsonb);
 select * into req from wms_private.write_requests where id=p_request_id;
 if found then
  if req.actor_id<>auth.uid() or req.branch_id<>p_branch_id or req.body is distinct from body then raise exception 'ID impor sudah digunakan untuk permintaan lain';end if;
  return req.result;
 end if;
 if exists(select 1 from public.wms_documents d where d.branch_id=p_branch_id and d.collection_name='orders'
 and exists(select 1 from jsonb_array_elements(p_items) j where upper(trim(j->>'orderNumber')) in (upper(trim(d.payload->>'orderNumber')),upper(trim(d.payload->>'referenceNumber')))))
 then raise exception 'Nomor order sudah ada. Periksa file dan muat ulang pratinjau.';end if;
 for grp in select value->>'skuId' sku,value->>'location' loc,value->>'expiredDate' ed,sum((value->>'qty')::numeric) qty from jsonb_array_elements(p_items) group by 1,2,3 loop
  select coalesce(sum((payload->>'qty')::numeric),0) into physical from public.wms_documents
  where branch_id=p_branch_id and collection_name='stock' and upper(trim(payload->>'skuId'))=grp.sku
    and upper(trim(payload->>'location'))=grp.loc and payload->>'expiredDate'=grp.ed
    and coalesce(payload->>'warehouseId','WH-CENTRAL')=p_warehouse_id and coalesce(payload->>'status','') not in ('Damage','Expired');
  select coalesce(sum((payload->>'qty')::numeric),0) into reserved from public.wms_documents
  where branch_id=p_branch_id and collection_name='orders' and payload->>'status'='Pending' and coalesce((payload->>'stockDeducted')::boolean,false)=false
    and upper(trim(payload->>'skuId'))=grp.sku and upper(trim(payload->>'location'))=grp.loc and payload->>'expiredDate'=grp.ed
    and coalesce(payload->>'warehouseId','WH-CENTRAL')=p_warehouse_id;
  if grp.qty > greatest(0,physical-reserved) then raise exception 'Stok bebas SKU % di % berubah/tidak cukup. Periksa ulang file.',grp.sku,grp.loc;end if;
 end loop;
 perform set_config('wms.reason','Impor order massal',true);
 result=wms_private.commit_wms_write(p_request_id,p_branch_id,ups,'[]'::jsonb);

 for grp in select coalesce(nullif(value->>'batchNumber',''),value->>'orderNumber') batch_number,jsonb_agg(value order by value->>'id') entries from jsonb_array_elements(p_items) group by 1 loop
  select * into batch_row from public.wms_documents where branch_id=p_branch_id and collection_name='batches' and payload->>'batchNumber'=grp.batch_number order by document_id limit 1 for update;
  if found and batch_row.payload->>'shippingStatus'='SUDAH_TERKIRIM' then raise exception 'Batch % sudah dikirim. Gunakan nomor batch baru.',grp.batch_number;end if;
  batch_id=coalesce(batch_row.document_id,'BATCH-IMP-'||md5(grp.batch_number));
  batch_items=coalesce(batch_row.payload->'items','[]'::jsonb)||grp.entries;
  batch_payload=coalesce(batch_row.payload,'{}'::jsonb)||jsonb_build_object('id',batch_id,'batchNumber',grp.batch_number,'createdAt',coalesce(batch_row.payload->>'createdAt',grp.entries->0->>'timestamp'),'updatedAt',now(),'shippingStatus','BELUM_TERKIRIM','centralWmsStatus','BELUM_TERPOTONG','customerName',coalesce(nullif(grp.entries->0->>'customerName',''),'Customer Outbound'),'createdBy',coalesce(batch_row.payload->>'createdBy',actor),'sourceReference',grp.batch_number,'items',batch_items,'totalPcs',(select sum((value->>'qty')::numeric) from jsonb_array_elements(batch_items)),'totalSkus',(select count(distinct value->>'skuId') from jsonb_array_elements(batch_items)));
  insert into public.wms_documents(branch_id,collection_name,document_id,payload) values(p_branch_id,'batches',batch_id,batch_payload)
  on conflict(branch_id,collection_name,document_id) do update set payload=excluded.payload;
 end loop;
 return result;
end;$$;
revoke all on function wms_private.import_wms_orders(uuid,text,text,jsonb) from public,anon;
grant execute on function wms_private.import_wms_orders(uuid,text,text,jsonb) to authenticated;

create or replace function public.import_wms_orders(p_request_id uuid,p_branch_id text,p_warehouse_id text,p_items jsonb) returns jsonb language sql security invoker set search_path='' as $$ select wms_private.import_wms_orders(p_request_id,p_branch_id,p_warehouse_id,p_items) $$;
revoke all on function public.import_wms_orders(uuid,text,text,jsonb) from public,anon;
grant execute on function public.import_wms_orders(uuid,text,text,jsonb) to authenticated;
-- <<< order-import.sql


-- >>> order-import-no-expiry-marker.sql
CREATE OR REPLACE FUNCTION wms_private.import_wms_orders(p_request_id uuid, p_branch_id text, p_warehouse_id text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare item jsonb; ups jsonb='[]'; body jsonb; req wms_private.write_requests%rowtype;
 actor text; grp record; physical numeric; reserved numeric; ed text; loc text; item_id text; result jsonb; batch_row public.wms_documents%rowtype; batch_items jsonb; batch_payload jsonb; batch_id text;
begin
 if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and is_active and role in ('Administrator','Admin')) or not wms_private.can_access_branch(p_branch_id) then raise exception 'Impor order hanya untuk admin cabang yang berwenang';end if;
 if p_request_id is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 5000 then raise exception 'Impor harus berisi 1–5000 baris alokasi';end if;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 -- Same lock order as the normal write gateway.
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 for item in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(item) is distinct from 'object' or length(trim(coalesce(item->>'orderNumber',''))) not between 1 and 128
    or length(trim(coalesce(item->>'skuId',''))) not between 1 and 128
    or length(trim(coalesce(item->>'customerName',''))) > 200
    or length(trim(coalesce(item->>'noPo',''))) > 128
    or length(trim(coalesce(item->>'batchNumber',''))) > 128
    or jsonb_typeof(item->'qty') is distinct from 'number' or coalesce(item->>'qty','') !~ '^[1-9][0-9]*$'
    or item->>'warehouseId' is distinct from p_warehouse_id
    or item->>'status' is distinct from 'Pending' or item->'stockDeducted' is distinct from 'false'::jsonb
    or item->'picked' is distinct from 'false'::jsonb or item->'scanned' is distinct from 'false'::jsonb
    or item->>'referenceNumber' is distinct from item->>'orderNumber'
    or coalesce(item->>'id','') !~ ('^IMP_'||replace(p_request_id::text,'-','')||'_[0-9]+$')
  then raise exception 'Format baris impor tidak valid';end if;
  loc=upper(trim(item->>'location'));ed=item->>'expiredDate';
  if loc is null or regexp_replace(loc,'[-_[:space:]]','','g') ~ '(ZONE1|URBAN)' then raise exception 'Lokasi buffer tidak dapat dipakai untuk order';end if;
  if ed is null or (lower(ed) ~ '(damage|expired)' and ed<>'No Expired') then raise exception 'Stok rusak/kedaluwarsa tidak dapat diorder';end if;
  if ed not in ('No Expired','--','-') and lower(ed) not in ('tanpa kedaluwarsa','tanpa expired') then
   if ed !~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' or to_char(to_date(ed,'DD/MM/YYYY'),'DD/MM/YYYY')<>ed or to_date(ed,'DD/MM/YYYY') <= (now() at time zone 'Asia/Jakarta')::date then raise exception 'Tanggal kedaluwarsa order tidak valid atau sudah lewat';end if;
  end if;
  item_id=item->>'id';
  ups=ups||jsonb_build_array(jsonb_build_object('collection_name','orders','document_id',item_id,'expected_revision',null,'payload',item));
  ups=ups||jsonb_build_array(jsonb_build_object('collection_name','logs','document_id','LOG_'||item_id,'expected_revision',null,'payload',
   jsonb_build_object('id','LOG_'||item_id,'timestamp',item->>'timestamp','type','ADJUSTMENT','skuId',item->>'skuId','skuName',item->>'skuName','qty',item->'qty','locationFrom','Import Order','locationTo',loc,'warehouseId',p_warehouse_id,'user',actor,'description','Impor order '||(item->>'orderNumber')||': menunggu picking, stok fisik belum dipotong')));
 end loop;
 body=jsonb_build_object('upserts',ups,'deletes','[]'::jsonb);
 select * into req from wms_private.write_requests where id=p_request_id;
 if found then
  if req.actor_id<>auth.uid() or req.branch_id<>p_branch_id or req.body is distinct from body then raise exception 'ID impor sudah digunakan untuk permintaan lain';end if;
  return req.result;
 end if;
 if exists(select 1 from public.wms_documents d where d.branch_id=p_branch_id and d.collection_name='orders'
 and exists(select 1 from jsonb_array_elements(p_items) j where upper(trim(j->>'orderNumber')) in (upper(trim(d.payload->>'orderNumber')),upper(trim(d.payload->>'referenceNumber')))))
 then raise exception 'Nomor order sudah ada. Periksa file dan muat ulang pratinjau.';end if;
 for grp in select value->>'skuId' sku,value->>'location' loc,value->>'expiredDate' ed,sum((value->>'qty')::numeric) qty from jsonb_array_elements(p_items) group by 1,2,3 loop
  select coalesce(sum((payload->>'qty')::numeric),0) into physical from public.wms_documents
  where branch_id=p_branch_id and collection_name='stock' and upper(trim(payload->>'skuId'))=grp.sku
    and upper(trim(payload->>'location'))=grp.loc
    and (
      payload->>'expiredDate'=grp.ed
      or (
        upper(grp.ed) in ('NO EXPIRED','--','-')
        and (
          payload->>'expiredDate' is null
          or upper(trim(payload->>'expiredDate')) in ('','-','--','---','–','—','N/A','NA','NONE','NULL','UNDEFINED','NO EXPIRED','NO ED','NO_EXPIRED','NOED','TANPA KEDALUWARSA','TANPA EXPIRED')
        )
      )
    )
    and coalesce(payload->>'warehouseId','WH-CENTRAL')=p_warehouse_id and wms_private.stock_pickable(payload);
  select coalesce(sum((payload->>'qty')::numeric),0) into reserved from public.wms_documents
  where branch_id=p_branch_id and collection_name='orders' and payload->>'status'='Pending' and coalesce((payload->>'stockDeducted')::boolean,false)=false
    and upper(trim(payload->>'skuId'))=grp.sku and upper(trim(payload->>'location'))=grp.loc
    and (
      payload->>'expiredDate'=grp.ed
      or (
        upper(grp.ed) in ('NO EXPIRED','--','-')
        and (
          payload->>'expiredDate' is null
          or upper(trim(payload->>'expiredDate')) in ('','-','--','---','–','—','N/A','NA','NONE','NULL','UNDEFINED','NO EXPIRED','NO ED','NO_EXPIRED','NOED','TANPA KEDALUWARSA','TANPA EXPIRED')
        )
      )
    )
    and coalesce(payload->>'warehouseId','WH-CENTRAL')=p_warehouse_id;
  if grp.qty > greatest(0,physical-reserved) then raise exception 'Stok bebas SKU % di % berubah/tidak cukup. Periksa ulang file.',grp.sku,grp.loc;end if;
 end loop;
 perform set_config('wms.reason','Impor order massal',true);
 result=wms_private.commit_wms_write(p_request_id,p_branch_id,ups,'[]'::jsonb);

 for grp in select coalesce(nullif(value->>'batchNumber',''),value->>'orderNumber') batch_number,jsonb_agg(value order by value->>'id') entries from jsonb_array_elements(p_items) group by 1 loop
  select * into batch_row from public.wms_documents where branch_id=p_branch_id and collection_name='batches' and payload->>'batchNumber'=grp.batch_number order by document_id limit 1 for update;
  if found and batch_row.payload->>'shippingStatus'='SUDAH_TERKIRIM' then raise exception 'Batch % sudah dikirim. Gunakan nomor batch baru.',grp.batch_number;end if;
  batch_id=coalesce(batch_row.document_id,'BATCH-IMP-'||md5(grp.batch_number));
  batch_items=coalesce(batch_row.payload->'items','[]'::jsonb)||grp.entries;
  batch_payload=coalesce(batch_row.payload,'{}'::jsonb)||jsonb_build_object('id',batch_id,'batchNumber',grp.batch_number,'createdAt',coalesce(batch_row.payload->>'createdAt',grp.entries->0->>'timestamp'),'updatedAt',now(),'shippingStatus','BELUM_TERKIRIM','centralWmsStatus','BELUM_TERPOTONG','customerName',coalesce(nullif(grp.entries->0->>'customerName',''),'Customer Outbound'),'createdBy',coalesce(batch_row.payload->>'createdBy',actor),'sourceReference',grp.batch_number,'items',batch_items,'totalPcs',(select sum((value->>'qty')::numeric) from jsonb_array_elements(batch_items)),'totalSkus',(select count(distinct value->>'skuId') from jsonb_array_elements(batch_items)));
  insert into public.wms_documents(branch_id,collection_name,document_id,payload) values(p_branch_id,'batches',batch_id,batch_payload)
  on conflict(branch_id,collection_name,document_id) do update set payload=excluded.payload;
 end loop;
 return result;
end;$function$
;
-- <<< order-import-no-expiry-marker.sql


-- >>> operational-guard-refinement.sql
create or replace function wms_private.stock_pickable(p jsonb) returns boolean language sql immutable set search_path='' as $$
 select true;
$$;

create or replace function wms_private.validate_operational_write(b text,ups jsonb,dels jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare r text; i jsonb; p jsonb; oldp jsonb; c text; q numeric;
begin
 select role into r from public.profiles where id=auth.uid() and is_active;
 if r is null or r not in ('Administrator','Admin','Picker','Packer') then raise exception 'Peran tidak boleh menulis';end if;

 -- Batasi operator (Picker & Packer) agar tetap dalam lingkup operasional
 for i in select value from jsonb_array_elements(ups||dels) loop
  c=i->>'collection_name';
  if r in ('Picker','Packer') and c not in ('orders','stock','logs','batches') then 
    raise exception 'Peran operator tidak boleh mengubah koleksi %',c;
  end if;
 end loop;

 -- Validasi data dasar stok & order
 for i in select value from jsonb_array_elements(ups) loop
  c=i->>'collection_name';
  select payload into oldp from public.wms_documents where branch_id=b and collection_name=c and document_id=i->>'document_id';
  p=case when coalesce((i->>'merge')::boolean,false) then coalesce(oldp,'{}')||(i->'payload') else i->'payload' end;
  if c='stock' then
   if jsonb_typeof(p->'qty') is distinct from 'number' then raise exception 'Jumlah stok harus angka bulat';end if;
   q=(p->>'qty')::numeric;
   if q<0 or q<>trunc(q) or q>9007199254740991 then raise exception 'Jumlah stok tidak valid';end if;
   if coalesce(trim(p->>'skuId'),'')='' or coalesce(trim(p->>'location'),'')='' then raise exception 'Identitas stok wajib lengkap';end if;
  elsif c='orders' then
   if jsonb_typeof(p->'qty') is distinct from 'number' or (p->>'qty')::numeric<=0 or (p->>'qty')::numeric<>trunc((p->>'qty')::numeric) then raise exception 'Jumlah order harus bilangan bulat positif';end if;
   if coalesce(p->>'status','') not in ('Pending','Completed','Cancelled') then raise exception 'Status order tidak valid';end if;
  end if;
 end loop;
end;$$;

revoke all on function wms_private.stock_pickable(jsonb),wms_private.validate_operational_write(text,jsonb,jsonb) from public,anon,authenticated;
-- <<< operational-guard-refinement.sql


-- >>> no-expiry-and-hq-reconciliation.sql
create or replace function wms_private.stock_pickable(p jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare ed text=lower(trim(coalesce(p->>'expiredDate',''))); d date;parts text[];
begin
 if lower(coalesce(p->>'status',''))~'(damage|rusak|expired|kedaluwarsa|hold|karantina|quarantine)' or lower(coalesce(p->>'location',''))~'(karantina|quarantine|hold|damage|rusak|expired|staging|transit|buffer|urban)' or regexp_replace(upper(coalesce(p->>'location','')),'[-_[:space:]]','','g') like '%ZONE1%' then return false;end if;
 if ed in ('','-','--','no expired','no ed','no_expired','noed') then return true;end if;
 if ed~'^\d{1,2}/\d{1,2}/\d{4}$' then parts=string_to_array(ed,'/');d=make_date(parts[3]::int,parts[2]::int,parts[1]::int);
 elsif ed~'^\d{4}-\d{2}-\d{2}$' then d=ed::date;else return false;end if;
 return d>(now() at time zone 'Asia/Jakarta')::date;
 exception when others then return false;
end;$$;

CREATE OR REPLACE FUNCTION wms_private.transfer_expired_date(value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare v text=trim(coalesce(value,'')); parts text[]; y text; m text; d text;
begin
 if lower(v) in ('','-','--','no expired','no ed','no_expired','noed') then return 'No Expired';end if;
 parts=regexp_match(v,'^([0-9]{4})[-/. ]([0-9]{1,2})[-/. ]([0-9]{1,2})([T ].*)?$');
 if parts is not null then y=parts[1];m=parts[2];d=parts[3];else
 parts=regexp_match(v,'^([0-9]{1,2})[-/. ]([0-9]{1,2})[-/. ]([0-9]{2,4})$');
 if parts is null then raise exception 'Format ED harus DD/MM/YYYY, YYYY-MM-DD, atau No Expired';end if;
 d=parts[1];m=parts[2];y=parts[3];if length(y)=2 then y='20'||y;end if;
 end if;
 perform make_date(y::integer,m::integer,d::integer);
 return lpad(d,2,'0')||'/'||lpad(m,2,'0')||'/'||y;
end;
$function$
;
-- <<< no-expiry-and-hq-reconciliation.sql


-- >>> backup-recovery.sql

create table public.branch_backups (
 id uuid primary key default gen_random_uuid(),branch_id text not null references public.branches(id),
 kind text not null,document_count integer not null,stock_qty numeric not null,sha256 text not null,
 created_by uuid references auth.users(id) on delete set null,created_at timestamptz not null default now()
);
create index branch_backups_branch_time_idx on public.branch_backups(branch_id,created_at desc);
alter table public.branch_backups enable row level security;
revoke all on public.branch_backups from public,anon,authenticated;
grant select on public.branch_backups to authenticated;
create policy branch_backups_admin_read on public.branch_backups for select to authenticated using(public.wms_is_admin() and wms_private.can_access_branch(branch_id));
create table wms_private.backup_payloads(id uuid primary key references public.branch_backups(id),payload_text text not null);
alter table wms_private.backup_payloads enable row level security;
revoke all on wms_private.backup_payloads from public,anon,authenticated;
create function wms_private.capture_branch_backup(p_branch text,p_kind text) returns uuid
language plpgsql security definer set search_path='' as $$
declare data jsonb;raw text;backup_id uuid=gen_random_uuid();hash text;actor text;
begin
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch,0));
 select jsonb_build_object(
 'branch',(select to_jsonb(b) from public.branches b where id=p_branch),
 'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by collection_name,document_id),'[]') from public.wms_documents d where branch_id=p_branch),
 'transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.branch_transfers t where source_branch=p_branch or destination_branch=p_branch),
 'operators',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from public.profiles p where branch_id=p_branch),
 'stock_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from public.stock_movements m where branch_id=p_branch),
 'activity_events',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.activity_events e where branch_id=p_branch)
 ) into data;
 if data->'branch'='null'::jsonb then raise exception 'Cabang tidak ditemukan';end if;
 raw=data::text;hash=encode(extensions.digest(raw,'sha256'),'hex');
 insert into public.branch_backups(id,branch_id,kind,document_count,stock_qty,sha256,created_by)
 values(backup_id,p_branch,p_kind,jsonb_array_length(data->'documents'),coalesce((select sum((value->'payload'->>'qty')::numeric) from jsonb_array_elements(data->'documents') where value->>'collection_name'='stock' and left(value->>'document_id',7)<>'SYSTEM_'),0),hash,auth.uid());
 insert into wms_private.backup_payloads values(backup_id,raw);
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason)
 values(p_branch,'backups',backup_id::text,'BACKUP_CREATE',auth.uid(),coalesce(actor,'Backup otomatis'),jsonb_build_object('kind',p_kind,'sha256',hash),'Pembuatan backup cabang');
 return backup_id;
end;$$;
revoke all on function wms_private.capture_branch_backup(text,text) from public,anon,authenticated;
create function wms_private.operational_state_hash(p_branch text) returns text
language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_array(collection_name,document_id,revision) order by collection_name,document_id),'[]')::text,'sha256'),'hex')
 from public.wms_documents where branch_id=p_branch and collection_name in ('stock','catalog','warehouses','settings')
$$;
revoke all on function wms_private.operational_state_hash(text) from public,anon,authenticated;
create function wms_private.branch_backup_action(p_action text,p_branch_id text,p_backup_id uuid,p_token text,p_reason text,p_file jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.branch_backups%rowtype;raw text;data jsonb;new_id uuid;token text;stats jsonb;blocked integer;row jsonb;actor text;before_id uuid;document_count integer;stock_qty numeric;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses backup cabang ditolak';end if;
 if p_action='create' then
  new_id=wms_private.capture_branch_backup(p_branch_id,'MANUAL');return jsonb_build_object('backup_id',new_id);
 elsif p_action='import' then
  raw=p_file->>'payload_text';
  if p_file->>'format' is distinct from 'BLUES_WMS_BACKUP' or p_file->>'version' is distinct from '1' or raw is null or octet_length(raw)>52428800 then raise exception 'Format/ukuran file backup tidak valid (maksimal 50 MB)';end if;
  if encode(extensions.digest(raw,'sha256'),'hex') is distinct from p_file->>'sha256' then raise exception 'Checksum backup tidak cocok. File rusak atau berubah';end if;
  data=raw::jsonb;
  if data->'branch'->>'id' is distinct from p_branch_id or p_file->>'branch_id' is distinct from p_branch_id then raise exception 'File berasal dari cabang lain';end if;
  if jsonb_typeof(data->'documents') is distinct from 'array' or jsonb_array_length(data->'documents')>50000 then raise exception 'Daftar dokumen backup tidak valid';end if;
  if exists(select 1 from jsonb_array_elements(data->'documents') j where j->>'branch_id' is distinct from p_branch_id or jsonb_typeof(j->'payload') is distinct from 'object' or length(coalesce(j->>'document_id','')) not between 1 and 160) then raise exception 'Dokumen backup tidak valid';end if;
  if (select count(*) from (select value->>'collection_name',value->>'document_id' from jsonb_array_elements(data->'documents') group by 1,2)s)<>jsonb_array_length(data->'documents') then raise exception 'Dokumen backup duplikat';end if;
  new_id=gen_random_uuid();
  select count(*),coalesce(sum(case when value->>'collection_name'='stock' and left(value->>'document_id',7)<>'SYSTEM_' then (value->'payload'->>'qty')::numeric else 0 end),0) into document_count,stock_qty from jsonb_array_elements(data->'documents');
  insert into public.branch_backups(id,branch_id,kind,document_count,stock_qty,sha256,created_by) values(new_id,p_branch_id,'IMPORTED',document_count,stock_qty,p_file->>'sha256',auth.uid());
  insert into wms_private.backup_payloads values(new_id,raw);
  select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,reason) values(p_branch_id,'backups',new_id::text,'BACKUP_IMPORT',auth.uid(),actor,'Impor file backup tervalidasi');
  return jsonb_build_object('backup_id',new_id);
 end if;
 select * into b from public.branch_backups backup_row where backup_row.id=p_backup_id and backup_row.branch_id=p_branch_id;
 if b.id is null then raise exception 'Backup tidak ditemukan';end if;
 select payload_text into raw from wms_private.backup_payloads where backup_payloads.id=b.id;
 if encode(extensions.digest(raw,'sha256'),'hex') is distinct from b.sha256 then raise exception 'Integritas backup tidak cocok';end if;
 data=raw::jsonb;
 if p_action='export' then return jsonb_build_object('format','BLUES_WMS_BACKUP','version',1,'backup_id',b.id,'branch_id',b.branch_id,'created_at',b.created_at,'sha256',b.sha256,'payload_text',raw);end if;
 if p_action not in ('preview','restore') then raise exception 'Aksi backup tidak valid';end if;
 if p_action='restore' and not wms_private.is_hq() then raise exception 'Pemulihan hanya untuk Administrator kantor pusat';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 token=wms_private.operational_state_hash(p_branch_id);
 select count(*) into blocked from public.branch_transfers where (source_branch=p_branch_id or destination_branch=p_branch_id) and status in ('SHIPPED','IN_TRANSIT');
 blocked=blocked+(select count(*) from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and coalesce(payload->>'status','Pending')='Pending');
 with saved as(select value->>'collection_name' c,value->>'document_id' d,value->'payload' p from jsonb_array_elements(data->'documents') where value->>'collection_name' in ('stock','catalog','warehouses','settings')),
 current_rows as(select collection_name c,document_id d,payload p from public.wms_documents where branch_id=p_branch_id and collection_name in ('stock','catalog','warehouses','settings'))
 select jsonb_build_object('add',count(*) filter(where current_rows.d is null),'remove',count(*) filter(where saved.d is null),'update',count(*) filter(where saved.d is not null and current_rows.d is not null and saved.p is distinct from current_rows.p))
 into stats from saved full join current_rows using(c,d);
 if p_action='preview' then return stats||jsonb_build_object('token',token,'backup_id',b.id,'backup_at',b.created_at,'stock_qty',b.stock_qty,'blocked_operations',blocked,'can_restore',wms_private.is_hq());end if;
 if p_token is distinct from token then raise exception using errcode='40001',message='Data berubah sejak pratinjau. Periksa ulang backup sebelum pemulihan';end if;
 if blocked>0 then raise exception 'Selesaikan order pending dan transfer dalam perjalanan sebelum pemulihan';end if;
 if length(trim(coalesce(p_reason,''))) not between 5 and 1000 then raise exception 'Isi alasan pemulihan minimal 5 karakter';end if;
 before_id=wms_private.capture_branch_backup(p_branch_id,'BEFORE_RESTORE');
 perform set_config('wms.operation_id','RESTORE:'||b.id::text||':'||before_id::text,true);
 perform set_config('wms.operation_type','BACKUP_RESTORE',true);
 perform set_config('wms.reason',p_reason,true);
 delete from public.wms_documents d where branch_id=p_branch_id and collection_name in ('stock','catalog','warehouses','settings')
 and not exists(select 1 from jsonb_array_elements(data->'documents') j where j->>'collection_name'=d.collection_name and j->>'document_id'=d.document_id);
 for row in select value from jsonb_array_elements(data->'documents') where value->>'collection_name' in ('stock','catalog','warehouses','settings') order by value->>'collection_name',value->>'document_id' loop
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,row->>'collection_name',row->>'document_id',(row->'payload')-'__wms_revision')
  on conflict(branch_id,collection_name,document_id) do update set payload=excluded.payload where public.wms_documents.payload is distinct from excluded.payload;
 end loop;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id)
 values(p_branch_id,'backups',b.id::text,'BACKUP_RESTORE',auth.uid(),actor,stats||jsonb_build_object('safety_backup_id',before_id),p_reason,current_setting('wms.operation_id',true));
 return stats||jsonb_build_object('safety_backup_id',before_id,'restored',true);
end;$$;
revoke all on function wms_private.branch_backup_action(text,text,uuid,text,text,jsonb) from public,anon;
grant execute on function wms_private.branch_backup_action(text,text,uuid,text,text,jsonb) to authenticated;
create function public.branch_backup_action(p_action text,p_branch_id text,p_backup_id uuid default null,p_token text default null,p_reason text default '',p_file jsonb default null)
returns jsonb language sql security invoker set search_path='' as $$select wms_private.branch_backup_action(p_action,p_branch_id,p_backup_id,p_token,p_reason,p_file)$$;
revoke all on function public.branch_backup_action(text,text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.branch_backup_action(text,text,uuid,text,text,jsonb) to authenticated;
create function wms_private.backup_all_branches() returns integer
language plpgsql security definer set search_path='' as $$
declare b record;n integer=0;
begin
 for b in select id from public.branches order by id loop
 perform wms_private.capture_branch_backup(b.id,'DAILY');n=n+1;
 end loop;
 return n;
end;$$;
revoke all on function wms_private.backup_all_branches() from public,anon,authenticated;

create extension if not exists pg_cron;
-- Backup harian setiap pukul 19:00 WIB (12:00 UTC)
select cron.schedule('blues-wms-daily-backup','0 12 * * *','select wms_private.backup_all_branches();');
alter table public.branch_backups add column captured_at timestamptz not null default now();
update public.branch_backups set captured_at=created_at;
create or replace function wms_private.branch_backup_action(p_action text,p_branch_id text,p_backup_id uuid,p_token text,p_reason text,p_file jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.branch_backups%rowtype;raw text;data jsonb;new_id uuid;token text;stats jsonb;blocked integer;row jsonb;actor text;before_id uuid;document_count integer;stock_qty numeric;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses backup cabang ditolak';end if;
 if p_action='create' then
  new_id=wms_private.capture_branch_backup(p_branch_id,'MANUAL');return jsonb_build_object('backup_id',new_id);
 elsif p_action='import' then
  raw=p_file->>'payload_text';
  if p_file->>'format' is distinct from 'BLUES_WMS_BACKUP' or p_file->>'version' is distinct from '1' or p_file->>'created_at' is null or raw is null or octet_length(raw)>52428800 then raise exception 'Format/ukuran file backup tidak valid (maksimal 50 MB)';end if;
  if encode(extensions.digest(raw,'sha256'),'hex') is distinct from p_file->>'sha256' then raise exception 'Checksum backup tidak cocok. File rusak atau berubah';end if;
  data=raw::jsonb;
  if data->'branch'->>'id' is distinct from p_branch_id or p_file->>'branch_id' is distinct from p_branch_id then raise exception 'File berasal dari cabang lain';end if;
  if jsonb_typeof(data->'documents') is distinct from 'array' or jsonb_array_length(data->'documents')>50000 then raise exception 'Daftar dokumen backup tidak valid';end if;
  if exists(select 1 from jsonb_array_elements(data->'documents') j where j->>'branch_id' is distinct from p_branch_id or jsonb_typeof(j->'payload') is distinct from 'object' or length(coalesce(j->>'document_id','')) not between 1 and 160) then raise exception 'Dokumen backup tidak valid';end if;
  if (select count(*) from (select value->>'collection_name',value->>'document_id' from jsonb_array_elements(data->'documents') group by 1,2)s)<>jsonb_array_length(data->'documents') then raise exception 'Dokumen backup duplikat';end if;
  new_id=gen_random_uuid();
  select count(*),coalesce(sum(case when value->>'collection_name'='stock' and left(value->>'document_id',7)<>'SYSTEM_' then (value->'payload'->>'qty')::numeric else 0 end),0) into document_count,stock_qty from jsonb_array_elements(data->'documents');
  insert into public.branch_backups(id,branch_id,kind,document_count,stock_qty,sha256,created_by,captured_at) values(new_id,p_branch_id,'IMPORTED',document_count,stock_qty,p_file->>'sha256',auth.uid(),(p_file->>'created_at')::timestamptz);
  insert into wms_private.backup_payloads values(new_id,raw);
  select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,reason) values(p_branch_id,'backups',new_id::text,'BACKUP_IMPORT',auth.uid(),actor,'Impor file backup tervalidasi');
  return jsonb_build_object('backup_id',new_id);
 end if;
 select * into b from public.branch_backups backup_row where backup_row.id=p_backup_id and backup_row.branch_id=p_branch_id;
 if b.id is null then raise exception 'Backup tidak ditemukan';end if;
 select payload_text into raw from wms_private.backup_payloads where backup_payloads.id=b.id;
 if encode(extensions.digest(raw,'sha256'),'hex') is distinct from b.sha256 then raise exception 'Integritas backup tidak cocok';end if;
 data=raw::jsonb;
 if p_action='export' then return jsonb_build_object('format','BLUES_WMS_BACKUP','version',1,'backup_id',b.id,'branch_id',b.branch_id,'created_at',b.captured_at,'sha256',b.sha256,'payload_text',raw);end if;
 if p_action not in ('preview','restore') then raise exception 'Aksi backup tidak valid';end if;
 if p_action='restore' and not wms_private.is_hq() then raise exception 'Pemulihan hanya untuk Administrator kantor pusat';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 token=wms_private.operational_state_hash(p_branch_id);
 select count(*) into blocked from public.branch_transfers where (source_branch=p_branch_id or destination_branch=p_branch_id) and status in ('SHIPPED','IN_TRANSIT');
 blocked=blocked+(select count(*) from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and coalesce(payload->>'status','Pending')='Pending');
 with saved as(select value->>'collection_name' c,value->>'document_id' d,value->'payload' p from jsonb_array_elements(data->'documents') where value->>'collection_name' in ('stock','catalog','warehouses','settings')),
 current_rows as(select collection_name c,document_id d,payload p from public.wms_documents where branch_id=p_branch_id and collection_name in ('stock','catalog','warehouses','settings'))
 select jsonb_build_object('add',count(*) filter(where current_rows.d is null),'remove',count(*) filter(where saved.d is null),'update',count(*) filter(where saved.d is not null and current_rows.d is not null and saved.p is distinct from current_rows.p))
 into stats from saved full join current_rows using(c,d);
 if p_action='preview' then return stats||jsonb_build_object('token',token,'backup_id',b.id,'backup_at',b.captured_at,'stock_qty',b.stock_qty,'blocked_operations',blocked,'can_restore',wms_private.is_hq());end if;
 if p_token is distinct from token then raise exception using errcode='40001',message='Data berubah sejak pratinjau. Periksa ulang backup sebelum pemulihan';end if;
 if blocked>0 then raise exception 'Selesaikan order pending dan transfer dalam perjalanan sebelum pemulihan';end if;
 if length(trim(coalesce(p_reason,''))) not between 5 and 1000 then raise exception 'Isi alasan pemulihan minimal 5 karakter';end if;
 before_id=wms_private.capture_branch_backup(p_branch_id,'BEFORE_RESTORE');
 perform set_config('wms.operation_id','RESTORE:'||b.id::text||':'||before_id::text,true);
 perform set_config('wms.operation_type','BACKUP_RESTORE',true);
 perform set_config('wms.reason',p_reason,true);
 delete from public.wms_documents d where branch_id=p_branch_id and collection_name in ('stock','catalog','warehouses','settings')
 and not exists(select 1 from jsonb_array_elements(data->'documents') j where j->>'collection_name'=d.collection_name and j->>'document_id'=d.document_id);
 for row in select value from jsonb_array_elements(data->'documents') where value->>'collection_name' in ('stock','catalog','warehouses','settings') order by value->>'collection_name',value->>'document_id' loop
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,row->>'collection_name',row->>'document_id',(row->'payload')-'__wms_revision')
  on conflict(branch_id,collection_name,document_id) do update set payload=excluded.payload where public.wms_documents.payload is distinct from excluded.payload;
 end loop;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id)
 values(p_branch_id,'backups',b.id::text,'BACKUP_RESTORE',auth.uid(),actor,stats||jsonb_build_object('safety_backup_id',before_id),p_reason,current_setting('wms.operation_id',true));
 return stats||jsonb_build_object('safety_backup_id',before_id,'restored',true);
end;$$;
-- <<< backup-recovery.sql


-- >>> stock-purge-safety.sql
create table wms_private.stock_purge_plans(id uuid primary key,branch_id text not null references public.branches(id),actor_id uuid not null references auth.users(id),session_id text not null,state_hash text not null,backup_id uuid not null references public.branch_backups(id),rows_count integer not null,qty numeric not null,reason text not null,expires_at timestamptz not null,status text not null default 'PREPARED' check(status in ('PREPARED','COMPLETED','CANCELLED')),created_at timestamptz not null default now());
alter table wms_private.stock_purge_plans enable row level security;
revoke all on wms_private.stock_purge_plans from public,anon,authenticated;
create function wms_private.recent_password_auth() returns boolean language sql stable set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from jsonb_array_elements(coalesce(auth.jwt()->'amr','[]')) a where a->>'method'='password' and (a->>'timestamp')::numeric between extract(epoch from now())-120 and extract(epoch from now())+5)
$$;
revoke all on function wms_private.recent_password_auth() from public,anon,authenticated;
create function wms_private.stock_purge_action(p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare plan wms_private.stock_purge_plans%rowtype;backup uuid;n integer;q numeric;actor text;session text=coalesce(auth.jwt()->>'session_id','');
begin
 if auth.uid() is null or not wms_private.is_hq() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Hanya Administrator yang dapat mengosongkan stok';end if;
 if p_plan_id is null or session='' then raise exception 'Sesi atau ID permintaan tidak valid';end if;
 perform pg_advisory_xact_lock(hashtextextended('purge:'||p_plan_id::text,0));
 select * into plan from wms_private.stock_purge_plans where id=p_plan_id for update;
 if plan.id is not null and (plan.actor_id<>auth.uid() or plan.branch_id<>p_branch_id or plan.session_id<>session) then raise exception 'Rencana milik akun/sesi/cabang lain';end if;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid() and is_active;
 if p_action='cancel' then
  if plan.id is not null and plan.status='PREPARED' then update wms_private.stock_purge_plans set status='CANCELLED' where id=p_plan_id;insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,reason,operation_id) values(p_branch_id,'stock_purge',p_plan_id::text,'STOCK_PURGE_CANCELLED',auth.uid(),actor,plan.reason,p_plan_id::text);end if;return jsonb_build_object('cancelled',true);
 end if;
 if not wms_private.recent_password_auth() then raise exception 'Verifikasi ulang password diperlukan (maksimal 2 menit)';end if;
 if p_confirmation is distinct from 'HAPUS '||p_branch_id then raise exception 'Konfirmasi kode cabang tidak cocok';end if;
 if length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Alasan pengosongan harus 10–1000 karakter';end if;
 if p_action='execute' and plan.id is not null and plan.status='COMPLETED' then return jsonb_build_object('completed',true,'rows',plan.rows_count,'backup_id',plan.backup_id);end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 if exists(select 1 from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and payload->>'status'='Pending') or exists(select 1 from public.branch_transfers where (source_branch=p_branch_id or destination_branch=p_branch_id) and status in ('DRAFT','SHIPPED','IN_TRANSIT')) then raise exception 'Selesaikan atau batalkan order dan transfer aktif sebelum mengosongkan stok';end if;
 if p_action='prepare' then
  if plan.id is null then
   select count(*),coalesce(sum((payload->>'qty')::numeric),0) into n,q from public.wms_documents where branch_id=p_branch_id and collection_name='stock';
   if n=0 then raise exception 'Stok cabang sudah kosong';end if;
   backup=wms_private.capture_branch_backup(p_branch_id,'PRE_STOCK_PURGE');
   insert into wms_private.stock_purge_plans(id,branch_id,actor_id,session_id,state_hash,backup_id,rows_count,qty,reason,expires_at) values(p_plan_id,p_branch_id,auth.uid(),session,wms_private.operational_state_hash(p_branch_id),backup,n,q,trim(p_reason),now()+interval '2 minutes') returning * into plan;
   insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,after_data,reason,operation_id) values(p_branch_id,'stock_purge',p_plan_id::text,'STOCK_PURGE_REQUESTED',auth.uid(),actor,jsonb_build_object('rows',n,'qty',q),jsonb_build_object('backup_id',backup),trim(p_reason),p_plan_id::text);
  end if;
  if plan.status<>'PREPARED' or plan.expires_at<now() or plan.reason<>trim(p_reason) then raise exception 'Rencana tidak berlaku; buat rencana baru';end if;
  return jsonb_build_object('plan_id',plan.id,'rows',plan.rows_count,'qty',plan.qty,'backup_id',plan.backup_id,'expires_at',plan.expires_at);
 elsif p_action='execute' then
  if plan.id is null or plan.status<>'PREPARED' or plan.expires_at<now() or plan.reason<>trim(p_reason) then raise exception 'Rencana tidak berlaku; buat rencana baru';end if;
  if plan.state_hash is distinct from wms_private.operational_state_hash(p_branch_id) then raise exception 'Data berubah setelah persiapan. Tidak ada stok dihapus';end if;
  perform set_config('wms.reason',plan.reason,true);perform set_config('wms.operation_id',p_plan_id::text,true);perform set_config('wms.operation_type','STOCK_PURGE',true);
  delete from public.wms_documents where branch_id=p_branch_id and collection_name='stock';
  update wms_private.stock_purge_plans set status='COMPLETED' where id=p_plan_id;
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id) values(p_branch_id,'stock_purge',p_plan_id::text,'STOCK_PURGE_COMPLETED',auth.uid(),actor,jsonb_build_object('rows',plan.rows_count,'qty',plan.qty,'backup_id',plan.backup_id),plan.reason,p_plan_id::text);
  return jsonb_build_object('completed',true,'rows',plan.rows_count,'backup_id',plan.backup_id);
 else raise exception 'Aksi tidak valid';end if;
end;$$;
revoke all on function wms_private.stock_purge_action(text,text,uuid,text,text) from public,anon;
grant execute on function wms_private.stock_purge_action(text,text,uuid,text,text) to authenticated;
create function public.stock_purge_action(p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text) returns jsonb language sql security invoker set search_path='' as $$ select wms_private.stock_purge_action(p_action,p_branch_id,p_plan_id,p_confirmation,p_reason) $$;
revoke all on function public.stock_purge_action(text,text,uuid,text,text) from public,anon;
grant execute on function public.stock_purge_action(text,text,uuid,text,text) to authenticated;

CREATE OR REPLACE FUNCTION wms_private.validate_operational_write(b text, ups jsonb, dels jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare r text; i jsonb; p jsonb; oldp jsonb; c text; k text;source jsonb; expected jsonb='{}';actual jsonb='{}';q numeric;before_qty numeric;has_allocation boolean=false;source_count integer;
begin
 select role into r from public.profiles where id=auth.uid() and is_active;
 if r is null or r not in ('Administrator','Admin','Picker','Packer') then raise exception 'Peran tidak boleh menulis';end if;
 if not exists(select 1 from jsonb_array_elements(ups) j where j->>'collection_name'='stock') and exists(select 1 from jsonb_array_elements(dels) j where j->>'collection_name'='stock') and (
 (select count(*) from jsonb_array_elements(dels) j where j->>'collection_name'='stock')>=25 or not exists(select 1 from public.wms_documents d where d.branch_id=b and d.collection_name='stock' and not exists(select 1 from jsonb_array_elements(dels) j where j->>'collection_name'='stock' and j->>'document_id'=d.document_id))
 ) then raise exception 'Pengosongan stok harus melalui autentikasi ulang dan rencana pengosongan';end if;
 for i in select value from jsonb_array_elements(ups||dels) loop
  c=i->>'collection_name';
  if r in ('Picker','Packer') and c not in ('orders','stock','logs','batches') then raise exception 'Peran tidak boleh mengubah koleksi %',c;end if;
 end loop;
 for i in select value from jsonb_array_elements(dels) loop
  if r in ('Picker','Packer') then raise exception 'Operator tidak boleh menghapus dokumen';end if;
  if i->>'collection_name'='stock' then select payload into oldp from public.wms_documents where branch_id=b and collection_name='stock' and document_id=i->>'document_id';k=wms_private.stock_key(oldp);actual=jsonb_set(actual,array[k],to_jsonb(coalesce((actual->>k)::numeric,0)-coalesce((oldp->>'qty')::numeric,0)),true);end if;
 end loop;
 for i in select value from jsonb_array_elements(ups) loop
  c=i->>'collection_name';
  select payload into oldp from public.wms_documents where branch_id=b and collection_name=c and document_id=i->>'document_id';
  p=case when coalesce((i->>'merge')::boolean,false) then coalesce(oldp,'{}')||(i->'payload') else i->'payload' end;
  if c='stock' then
   if jsonb_typeof(p->'qty') is distinct from 'number' then raise exception 'Jumlah stok harus angka bulat';end if;
   q=(p->>'qty')::numeric;if q<0 or q<>trunc(q) or q>9007199254740991 then raise exception 'Jumlah stok tidak valid';end if;
   if coalesce(trim(p->>'skuId'),'')='' or coalesce(trim(p->>'location'),'')='' then raise exception 'Identitas stok wajib lengkap';end if;
   if r in ('Picker','Packer') and (oldp is null or wms_private.stock_key(oldp)<>wms_private.stock_key(p) or wms_private.stock_pickable(oldp)<>wms_private.stock_pickable(p)) then raise exception 'Operator tidak boleh menambah atau mengganti identitas/kondisi stok';end if;
   if oldp is not null then k=wms_private.stock_key(oldp);actual=jsonb_set(actual,array[k],to_jsonb(coalesce((actual->>k)::numeric,0)-coalesce((oldp->>'qty')::numeric,0)),true);end if;
   k=wms_private.stock_key(p);actual=jsonb_set(actual,array[k],to_jsonb(coalesce((actual->>k)::numeric,0)+q),true);
  elsif c='orders' then
   if jsonb_typeof(p->'qty') is distinct from 'number' or (p->>'qty')::numeric<=0 or (p->>'qty')::numeric<>trunc((p->>'qty')::numeric) then raise exception 'Jumlah order harus bilangan bulat positif';end if;
   if coalesce(p->>'status','') not in ('Pending','Completed','Cancelled') then raise exception 'Status order tidak valid';end if;
   if r='Picker' and p->>'status'<>'Pending' then raise exception 'Picker tidak boleh menyelesaikan packing atau membatalkan order';end if;
   if r in ('Picker','Packer') and oldp is not null and (oldp->>'referenceNumber' is distinct from p->>'referenceNumber' or oldp->>'skuId' is distinct from p->>'skuId' or coalesce(oldp->>'warehouseId','WH-CENTRAL') is distinct from coalesce(p->>'warehouseId','WH-CENTRAL')) then raise exception 'Operator tidak boleh mengubah identitas order';end if;
   if r='Packer' and (not coalesce(wms_private.order_deducted(p),false) or wms_private.stock_key(p) is distinct from wms_private.stock_key(oldp) or p->>'qty' is distinct from oldp->>'qty') then raise exception 'Packer tidak boleh mengubah alokasi picking';end if;
   if r='Packer' and (oldp is null or not coalesce(wms_private.order_deducted(oldp),false)) then raise exception 'Packer hanya memproses order yang sudah dipick';end if;
   if coalesce(wms_private.order_deducted(oldp),false) then k=wms_private.stock_key(oldp);expected=jsonb_set(expected,array[k],to_jsonb(coalesce((expected->>k)::numeric,0)+(oldp->>'qty')::numeric),true);end if;
   if coalesce(wms_private.order_deducted(p),false) then
    k=wms_private.stock_key(p);
    select payload into source from public.wms_documents where branch_id=b and collection_name='stock' and wms_private.stock_key(payload)=k;
    select count(*) into source_count from public.wms_documents where branch_id=b and collection_name='stock' and wms_private.stock_key(payload)=k;
    if source_count<>1 or source is null or not wms_private.stock_pickable(source) then raise exception 'Stok karantina/rusak/kedaluwarsa atau lokasi buffer tidak dapat dipick';end if;
    expected=jsonb_set(expected,array[k],to_jsonb(coalesce((expected->>k)::numeric,0)-(p->>'qty')::numeric),true);has_allocation=true;
   end if;
  end if;
 end loop;
 if r='Picker' then
  for p in select value->'payload' from jsonb_array_elements(ups) where value->>'collection_name'='orders' loop
   if not exists(select 1 from public.wms_documents d where d.branch_id=b and d.collection_name='orders' and d.payload->>'status'='Pending' and d.payload->>'referenceNumber'=p->>'referenceNumber' and d.payload->>'skuId'=p->>'skuId' and coalesce(d.payload->>'warehouseId','WH-CENTRAL')=coalesce(p->>'warehouseId','WH-CENTRAL')) then raise exception 'Picker tidak boleh membuat order baru';end if;
  end loop;
  if exists(
   with touched as(select distinct value->'payload'->>'referenceNumber' ref from jsonb_array_elements(ups) where value->>'collection_name'='orders'),
   old_rows as(select d.document_id,d.payload from public.wms_documents d join touched t on t.ref=d.payload->>'referenceNumber' where d.branch_id=b and d.collection_name='orders' and d.payload->>'status'='Pending'),
   final_rows as(select o.payload from old_rows o where not exists(select 1 from jsonb_array_elements(ups) j where j->>'collection_name'='orders' and j->>'document_id'=o.document_id)
    union all select case when coalesce((j->>'merge')::boolean,false) then coalesce(o.payload,'{}')||(j->'payload') else j->'payload' end from jsonb_array_elements(ups) j left join old_rows o on o.document_id=j->>'document_id' where j->>'collection_name'='orders'),
   totals as(select payload->>'referenceNumber' ref,payload->>'skuId' sku,coalesce(payload->>'warehouseId','WH-CENTRAL') wh,(payload->>'qty')::numeric qty from old_rows union all select payload->>'referenceNumber',payload->>'skuId',coalesce(payload->>'warehouseId','WH-CENTRAL'),-(payload->>'qty')::numeric from final_rows)
   select 1 from totals group by ref,sku,wh having sum(qty)<>0
  ) then raise exception 'Jumlah order asli harus dipertahankan';end if;
 end if;
 if has_allocation or r in ('Picker','Packer') then
  for k in select jsonb_object_keys(expected||actual) loop
   if coalesce((expected->>k)::numeric,0)<>coalesce((actual->>k)::numeric,0) then raise exception 'Mutasi stok tidak sesuai alokasi order';end if;
  end loop;
 end if;
end;$function$
;

CREATE OR REPLACE FUNCTION wms_private.import_wms_orders(p_request_id uuid, p_branch_id text, p_warehouse_id text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare item jsonb; ups jsonb='[]'; body jsonb; req wms_private.write_requests%rowtype;
 actor text; grp record; physical numeric; reserved numeric; ed text; loc text; item_id text; result jsonb; batch_row public.wms_documents%rowtype; batch_items jsonb; batch_payload jsonb; batch_id text;
begin
 if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and is_active and role in ('Administrator','Admin')) or not wms_private.can_access_branch(p_branch_id) then raise exception 'Impor order hanya untuk admin cabang yang berwenang';end if;
 if p_request_id is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 5000 then raise exception 'Impor harus berisi 1–5000 baris alokasi';end if;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 -- Same lock order as the normal write gateway.
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 for item in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(item) is distinct from 'object' or length(trim(coalesce(item->>'orderNumber',''))) not between 1 and 128
    or length(trim(coalesce(item->>'skuId',''))) not between 1 and 128
    or length(trim(coalesce(item->>'customerName',''))) > 200
    or length(trim(coalesce(item->>'noPo',''))) > 128
    or length(trim(coalesce(item->>'batchNumber',''))) > 128
    or jsonb_typeof(item->'qty') is distinct from 'number' or coalesce(item->>'qty','') !~ '^[1-9][0-9]*$'
    or item->>'warehouseId' is distinct from p_warehouse_id
    or item->>'status' is distinct from 'Pending' or item->'stockDeducted' is distinct from 'false'::jsonb
    or item->'picked' is distinct from 'false'::jsonb or item->'scanned' is distinct from 'false'::jsonb
    or item->>'referenceNumber' is distinct from item->>'orderNumber'
    or coalesce(item->>'id','') !~ ('^IMP_'||replace(p_request_id::text,'-','')||'_[0-9]+$')
  then raise exception 'Format baris impor tidak valid';end if;
  loc=upper(trim(item->>'location'));ed=item->>'expiredDate';
  if loc is null or regexp_replace(loc,'[-_[:space:]]','','g') ~ '(ZONE1|URBAN)' then raise exception 'Lokasi buffer tidak dapat dipakai untuk order';end if;
  if ed is null or (lower(ed) ~ '(damage|expired)' and ed<>'No Expired') then raise exception 'Stok rusak/kedaluwarsa tidak dapat diorder';end if;
  if ed not in ('No Expired','--','-') and lower(ed) not in ('tanpa kedaluwarsa','tanpa expired') then
   if ed !~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' or to_char(to_date(ed,'DD/MM/YYYY'),'DD/MM/YYYY')<>ed or to_date(ed,'DD/MM/YYYY') <= (now() at time zone 'Asia/Jakarta')::date then raise exception 'Tanggal kedaluwarsa order tidak valid atau sudah lewat';end if;
  end if;
  item_id=item->>'id';
  ups=ups||jsonb_build_array(jsonb_build_object('collection_name','orders','document_id',item_id,'expected_revision',null,'payload',item));
  ups=ups||jsonb_build_array(jsonb_build_object('collection_name','logs','document_id','LOG_'||item_id,'expected_revision',null,'payload',
   jsonb_build_object('id','LOG_'||item_id,'timestamp',item->>'timestamp','type','ADJUSTMENT','skuId',item->>'skuId','skuName',item->>'skuName','qty',item->'qty','locationFrom','Import Order','locationTo',loc,'warehouseId',p_warehouse_id,'user',actor,'description','Impor order '||(item->>'orderNumber')||': menunggu picking, stok fisik belum dipotong')));
 end loop;
 body=jsonb_build_object('upserts',ups,'deletes','[]'::jsonb);
 select * into req from wms_private.write_requests where id=p_request_id;
 if found then
  if req.actor_id<>auth.uid() or req.branch_id<>p_branch_id or req.body is distinct from body then raise exception 'ID impor sudah digunakan untuk permintaan lain';end if;
  return req.result;
 end if;
 if exists(select 1 from public.wms_documents d where d.branch_id=p_branch_id and d.collection_name='orders'
 and exists(select 1 from jsonb_array_elements(p_items) j where upper(trim(j->>'orderNumber')) in (upper(trim(d.payload->>'orderNumber')),upper(trim(d.payload->>'referenceNumber')))))
 then raise exception 'Nomor order sudah ada. Periksa file dan muat ulang pratinjau.';end if;
 for grp in select value->>'skuId' sku,value->>'location' loc,value->>'expiredDate' ed,sum((value->>'qty')::numeric) qty from jsonb_array_elements(p_items) group by 1,2,3 loop
  select coalesce(sum((payload->>'qty')::numeric),0) into physical from public.wms_documents
  where branch_id=p_branch_id and collection_name='stock' and upper(trim(payload->>'skuId'))=grp.sku
    and upper(trim(payload->>'location'))=grp.loc
    and (
      payload->>'expiredDate'=grp.ed
      or (
        upper(grp.ed) in ('NO EXPIRED','--','-')
        and (
          payload->>'expiredDate' is null
          or upper(trim(payload->>'expiredDate')) in ('','-','--','---','–','—','N/A','NA','NONE','NULL','UNDEFINED','NO EXPIRED','NO ED','NO_EXPIRED','NOED','TANPA KEDALUWARSA','TANPA EXPIRED')
        )
      )
    )
    and coalesce(payload->>'warehouseId','WH-CENTRAL')=p_warehouse_id and wms_private.stock_pickable(payload);
  select coalesce(sum((payload->>'qty')::numeric),0) into reserved from public.wms_documents
  where branch_id=p_branch_id and collection_name='orders' and payload->>'status'='Pending' and coalesce((payload->>'stockDeducted')::boolean,false)=false
    and upper(trim(payload->>'skuId'))=grp.sku and upper(trim(payload->>'location'))=grp.loc
    and (
      payload->>'expiredDate'=grp.ed
      or (
        upper(grp.ed) in ('NO EXPIRED','--','-')
        and (
          payload->>'expiredDate' is null
          or upper(trim(payload->>'expiredDate')) in ('','-','--','---','–','—','N/A','NA','NONE','NULL','UNDEFINED','NO EXPIRED','NO ED','NO_EXPIRED','NOED','TANPA KEDALUWARSA','TANPA EXPIRED')
        )
      )
    )
    and coalesce(payload->>'warehouseId','WH-CENTRAL')=p_warehouse_id;
  if grp.qty > greatest(0,physical-reserved) then raise exception 'Stok bebas SKU % di % berubah/tidak cukup. Periksa ulang file.',grp.sku,grp.loc;end if;
 end loop;
 perform set_config('wms.reason','Impor order massal',true);
 result=wms_private.commit_wms_write(p_request_id,p_branch_id,ups,'[]'::jsonb);

 for grp in select coalesce(nullif(value->>'batchNumber',''),value->>'orderNumber') batch_number,jsonb_agg(value order by value->>'id') entries from jsonb_array_elements(p_items) group by 1 loop
  select * into batch_row from public.wms_documents where branch_id=p_branch_id and collection_name='batches' and payload->>'batchNumber'=grp.batch_number order by document_id limit 1 for update;
  if found and batch_row.payload->>'shippingStatus'='SUDAH_TERKIRIM' then raise exception 'Batch % sudah dikirim. Gunakan nomor batch baru.',grp.batch_number;end if;
  batch_id=coalesce(batch_row.document_id,'BATCH-IMP-'||md5(grp.batch_number));
  batch_items=coalesce(batch_row.payload->'items','[]'::jsonb)||grp.entries;
  batch_payload=coalesce(batch_row.payload,'{}'::jsonb)||jsonb_build_object('id',batch_id,'batchNumber',grp.batch_number,'createdAt',coalesce(batch_row.payload->>'createdAt',grp.entries->0->>'timestamp'),'updatedAt',now(),'shippingStatus','BELUM_TERKIRIM','centralWmsStatus','BELUM_TERPOTONG','customerName',coalesce(nullif(grp.entries->0->>'customerName',''),'Customer Outbound'),'createdBy',coalesce(batch_row.payload->>'createdBy',actor),'sourceReference',grp.batch_number,'items',batch_items,'totalPcs',(select sum((value->>'qty')::numeric) from jsonb_array_elements(batch_items)),'totalSkus',(select count(distinct value->>'skuId') from jsonb_array_elements(batch_items)));
  insert into public.wms_documents(branch_id,collection_name,document_id,payload) values(p_branch_id,'batches',batch_id,batch_payload)
  on conflict(branch_id,collection_name,document_id) do update set payload=excluded.payload;
 end loop;
 return result;
end;$function$
;
-- <<< stock-purge-safety.sql


-- >>> reimport-cancelled-orders.sql
CREATE OR REPLACE FUNCTION wms_private.import_wms_orders(p_request_id uuid, p_branch_id text, p_warehouse_id text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare item jsonb; ups jsonb='[]'; body jsonb; req wms_private.write_requests%rowtype;
 actor text; grp record; physical numeric; reserved numeric; ed text; loc text; item_id text; result jsonb; batch_row public.wms_documents%rowtype; batch_items jsonb; batch_payload jsonb; batch_id text;
begin
 if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and is_active and role in ('Administrator','Admin')) or not wms_private.can_access_branch(p_branch_id) then raise exception 'Impor order hanya untuk admin cabang yang berwenang';end if;
 if p_request_id is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 5000 then raise exception 'Impor harus berisi 1–5000 baris alokasi';end if;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 -- Same lock order as the normal write gateway.
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 for item in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(item) is distinct from 'object' or length(trim(coalesce(item->>'orderNumber',''))) not between 1 and 128
    or length(trim(coalesce(item->>'skuId',''))) not between 1 and 128
    or length(trim(coalesce(item->>'customerName',''))) > 200
    or length(trim(coalesce(item->>'noPo',''))) > 128
    or length(trim(coalesce(item->>'batchNumber',''))) > 128
    or jsonb_typeof(item->'qty') is distinct from 'number' or coalesce(item->>'qty','') !~ '^[1-9][0-9]*$'
    or item->>'warehouseId' is distinct from p_warehouse_id
    or item->>'status' is distinct from 'Pending' or item->'stockDeducted' is distinct from 'false'::jsonb
    or item->'picked' is distinct from 'false'::jsonb or item->'scanned' is distinct from 'false'::jsonb
    or (item->>'referenceNumber' is distinct from item->>'orderNumber' and coalesce(item->>'referenceNumber','') !~ ('^REIMP_'||replace(p_request_id::text,'-','')||'_[0-9]+$'))
    or coalesce(item->>'id','') !~ ('^IMP_'||replace(p_request_id::text,'-','')||'_[0-9]+$')
  then raise exception 'Format baris impor tidak valid';end if;
  loc=upper(trim(item->>'location'));ed=item->>'expiredDate';
  if loc is null or regexp_replace(loc,'[-_[:space:]]','','g') ~ '(ZONE1|URBAN)' then raise exception 'Lokasi buffer tidak dapat dipakai untuk order';end if;
  if ed is null or (lower(ed) ~ '(damage|expired)' and ed<>'No Expired') then raise exception 'Stok rusak/kedaluwarsa tidak dapat diorder';end if;
  if ed not in ('No Expired','--','-') and lower(ed) not in ('tanpa kedaluwarsa','tanpa expired') then
   if ed !~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' or to_char(to_date(ed,'DD/MM/YYYY'),'DD/MM/YYYY')<>ed or to_date(ed,'DD/MM/YYYY') <= (now() at time zone 'Asia/Jakarta')::date then raise exception 'Tanggal kedaluwarsa order tidak valid atau sudah lewat';end if;
  end if;
  item_id=item->>'id';
  ups=ups||jsonb_build_array(jsonb_build_object('collection_name','orders','document_id',item_id,'expected_revision',null,'payload',item));
  ups=ups||jsonb_build_array(jsonb_build_object('collection_name','logs','document_id','LOG_'||item_id,'expected_revision',null,'payload',
   jsonb_build_object('id','LOG_'||item_id,'timestamp',item->>'timestamp','type','ADJUSTMENT','skuId',item->>'skuId','skuName',item->>'skuName','qty',item->'qty','locationFrom','Import Order','locationTo',loc,'warehouseId',p_warehouse_id,'user',actor,'description','Impor order '||(item->>'orderNumber')||': menunggu picking, stok fisik belum dipotong')));
 end loop;
 body=jsonb_build_object('upserts',ups,'deletes','[]'::jsonb);
 select * into req from wms_private.write_requests where id=p_request_id;
 if found then
  if req.actor_id<>auth.uid() or req.branch_id<>p_branch_id or req.body is distinct from body then raise exception 'ID impor sudah digunakan untuk permintaan lain';end if;
  return req.result;
 end if;
 if exists(select 1 from public.wms_documents d where d.branch_id=p_branch_id and d.collection_name='orders'
 and d.payload->>'status' is distinct from 'Cancelled'
 and exists(select 1 from jsonb_array_elements(p_items) j where upper(trim(j->>'orderNumber')) in (upper(trim(d.payload->>'orderNumber')),upper(trim(d.payload->>'referenceNumber')))))
 then raise exception 'Nomor order sudah ada. Periksa file dan muat ulang pratinjau.';end if;
 if exists(select 1 from jsonb_array_elements(p_items) j group by upper(trim(j->>'orderNumber')) having count(distinct j->>'referenceNumber')<>1)
 or exists(select 1 from jsonb_array_elements(p_items) j group by j->>'referenceNumber' having count(distinct upper(trim(j->>'orderNumber')))<>1)
 then raise exception 'Identitas transaksi impor tidak konsisten';end if;
 for item in select value from jsonb_array_elements(p_items) loop
  if exists(select 1 from public.wms_documents d where d.branch_id=p_branch_id and d.collection_name='orders' and d.payload->>'status'='Cancelled' and upper(trim(item->>'orderNumber')) in (upper(trim(d.payload->>'orderNumber')),upper(trim(d.payload->>'referenceNumber')))) then
   if coalesce(item->>'referenceNumber','') !~ ('^REIMP_'||replace(p_request_id::text,'-','')||'_[0-9]+$') or item->>'batchNumber' is distinct from item->>'referenceNumber' then raise exception 'Impor ulang memerlukan identitas transaksi baru. Muat ulang WMS.';end if;
  elsif item->>'referenceNumber' is distinct from item->>'orderNumber' then raise exception 'Identitas impor baru tidak valid';end if;
 end loop;
 for grp in select value->>'skuId' sku,value->>'location' loc,value->>'expiredDate' ed,sum((value->>'qty')::numeric) qty from jsonb_array_elements(p_items) group by 1,2,3 loop
  select coalesce(sum((payload->>'qty')::numeric),0) into physical from public.wms_documents
  where branch_id=p_branch_id and collection_name='stock' and upper(trim(payload->>'skuId'))=grp.sku
    and upper(trim(payload->>'location'))=grp.loc
    and (
      payload->>'expiredDate'=grp.ed
      or (
        upper(grp.ed) in ('NO EXPIRED','--','-')
        and (
          payload->>'expiredDate' is null
          or upper(trim(payload->>'expiredDate')) in ('','-','--','---','–','—','N/A','NA','NONE','NULL','UNDEFINED','NO EXPIRED','NO ED','NO_EXPIRED','NOED','TANPA KEDALUWARSA','TANPA EXPIRED')
        )
      )
    )
    and coalesce(payload->>'warehouseId','WH-CENTRAL')=p_warehouse_id and wms_private.stock_pickable(payload);
  select coalesce(sum((payload->>'qty')::numeric),0) into reserved from public.wms_documents
  where branch_id=p_branch_id and collection_name='orders' and payload->>'status'='Pending' and coalesce((payload->>'stockDeducted')::boolean,false)=false
    and upper(trim(payload->>'skuId'))=grp.sku and upper(trim(payload->>'location'))=grp.loc
    and (
      payload->>'expiredDate'=grp.ed
      or (
        upper(grp.ed) in ('NO EXPIRED','--','-')
        and (
          payload->>'expiredDate' is null
          or upper(trim(payload->>'expiredDate')) in ('','-','--','---','–','—','N/A','NA','NONE','NULL','UNDEFINED','NO EXPIRED','NO ED','NO_EXPIRED','NOED','TANPA KEDALUWARSA','TANPA EXPIRED')
        )
      )
    )
    and coalesce(payload->>'warehouseId','WH-CENTRAL')=p_warehouse_id;
  if grp.qty > greatest(0,physical-reserved) then raise exception 'Stok bebas SKU % di % berubah/tidak cukup. Periksa ulang file.',grp.sku,grp.loc;end if;
 end loop;
 perform set_config('wms.reason','Impor order massal',true);
 result=wms_private.commit_wms_write(p_request_id,p_branch_id,ups,'[]'::jsonb);

 for grp in select coalesce(nullif(value->>'batchNumber',''),value->>'orderNumber') batch_number,jsonb_agg(value order by value->>'id') entries from jsonb_array_elements(p_items) group by 1 loop
  select * into batch_row from public.wms_documents where branch_id=p_branch_id and collection_name='batches' and payload->>'batchNumber'=grp.batch_number order by document_id limit 1 for update;
  if found and batch_row.payload->>'shippingStatus'='SUDAH_TERKIRIM' then raise exception 'Batch % sudah dikirim. Gunakan nomor batch baru.',grp.batch_number;end if;
  batch_id=coalesce(batch_row.document_id,'BATCH-IMP-'||md5(grp.batch_number));
  batch_items=coalesce(batch_row.payload->'items','[]'::jsonb)||grp.entries;
  batch_payload=coalesce(batch_row.payload,'{}'::jsonb)||jsonb_build_object('id',batch_id,'batchNumber',grp.batch_number,'createdAt',coalesce(batch_row.payload->>'createdAt',grp.entries->0->>'timestamp'),'updatedAt',now(),'shippingStatus','BELUM_TERKIRIM','centralWmsStatus','BELUM_TERPOTONG','customerName',coalesce(nullif(grp.entries->0->>'customerName',''),'Customer Outbound'),'createdBy',coalesce(batch_row.payload->>'createdBy',actor),'sourceReference',grp.batch_number,'items',batch_items,'totalPcs',(select sum((value->>'qty')::numeric) from jsonb_array_elements(batch_items)),'totalSkus',(select count(distinct value->>'skuId') from jsonb_array_elements(batch_items)));
  insert into public.wms_documents(branch_id,collection_name,document_id,payload) values(p_branch_id,'batches',batch_id,batch_payload)
  on conflict(branch_id,collection_name,document_id) do update set payload=excluded.payload;
 end loop;
 return result;
end;$function$
;
revoke all on function wms_private.import_wms_orders(uuid,text,text,jsonb) from public,anon;
grant execute on function wms_private.import_wms_orders(uuid,text,text,jsonb) to authenticated;
-- <<< reimport-cancelled-orders.sql


-- >>> period-archive.sql
-- Archive finished history only; never change physical stock.
alter table public.branch_backups add column storage_status text not null default 'CLOUD';
-- Avoid retaining a new duplicate of each archived row in the audit table.
do $patch$ declare source text;begin
 source=pg_get_functiondef('wms_private.audit_wms_change()'::regprocedure);
 source=regexp_replace(source,'\mbegin\M',E'begin\n if tg_op=''DELETE'' and current_setting(''wms.operation_type'',true)=''PERIOD_ARCHIVE'' and current_user=''postgres'' then return old;end if;','i');
 execute source;
end;$patch$;
create table wms_private.period_archives (
 id uuid primary key default gen_random_uuid(),branch_id text not null references public.branches(id),
 actor_id uuid not null references auth.users(id),cutoff timestamptz not null,backup_id uuid not null references public.branch_backups(id),
 state_hash text not null,status text not null default 'PREPARED' check(status in ('PREPARED','COMPLETED','CANCELLED')),summary jsonb not null,created_at timestamptz not null default now()
);
alter table wms_private.period_archives enable row level security;
revoke all on wms_private.period_archives from public,anon,authenticated;
create function wms_private.archive_state(b text) returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(jsonb_build_array(
 (select coalesce(jsonb_agg(to_jsonb(d) order by collection_name,document_id),'[]') from public.wms_documents d where branch_id=b),
 (select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from public.stock_movements m where branch_id=b),
 (select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.activity_events e where branch_id=b),
 (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.branch_transfers t where source_branch=b or destination_branch=b)
 )::text,'sha256'),'hex')
$$;
revoke all on function wms_private.archive_state(text) from public,anon,authenticated;
create function wms_private.archive_document_keys(b text,c timestamptz) returns table(collection_name text,document_id text) language sql stable set search_path='' as $$
 select d.collection_name,d.document_id from public.wms_documents d where d.branch_id=b and d.updated_at<c and (d.collection_name='logs' or (d.collection_name='orders' and d.payload->>'status' in ('Completed','Cancelled') and not exists(select 1 from public.wms_documents x where x.branch_id=b and x.collection_name='orders' and coalesce(nullif(x.payload->>'referenceNumber',''),x.document_id)=coalesce(nullif(d.payload->>'referenceNumber',''),d.document_id) and (x.updated_at>=c or coalesce(x.payload->>'status','Pending') not in ('Completed','Cancelled')))))
$$;
revoke all on function wms_private.archive_document_keys(text,timestamptz) from public,anon,authenticated;
create or replace function wms_private.protect_transaction_history() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' and current_setting('wms.operation_type',true)='PERIOD_ARCHIVE' and current_user='postgres' then return old;end if;
 if old.collection_name='orders' then
  if tg_op='DELETE' then raise exception 'Riwayat order tidak boleh dihapus. Gunakan pembatalan beralasan';end if;
  if old.payload->>'status'='Cancelled' and new.payload is distinct from old.payload then raise exception 'Order yang dibatalkan tidak dapat diubah atau dibuka kembali';end if;
  if new.payload->>'status'='Cancelled' and old.payload->>'status' is distinct from 'Cancelled' and current_setting('wms.operation_type',true) is distinct from 'ORDER_CANCELLATION' then raise exception 'Gunakan pembatalan order resmi';end if;
 end if;
 if old.collection_name='logs' and (tg_op='DELETE' or new.payload is distinct from old.payload) then raise exception 'Riwayat mutasi tidak boleh diubah atau dihapus. Buat koreksi baru';end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
create function wms_private.period_archive_action(p_action text,p_branch text,p_cutoff timestamptz,p_id uuid,p_sha text,p_confirmation text,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a wms_private.period_archives%rowtype;bid uuid;stats jsonb;before_stock text;before_ledger jsonb;after_ledger jsonb;actor text;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.is_hq() or not wms_private.can_access_branch(p_branch) then raise exception 'Hanya Administrator kantor pusat dapat mengarsipkan cabang';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch,0));
 if p_action='release_backup' then
  if not wms_private.recent_password_auth() then raise exception 'Login ulang dengan password lalu konfirmasi dalam 2 menit';end if;
  if p_confirmation is distinct from 'ARSIP '||p_branch or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Konfirmasi cabang dan alasan 10–1000 karakter wajib diisi';end if;
  if not exists(select 1 from public.branch_backups where id=p_id and branch_id=p_branch and sha256=p_sha and storage_status='CLOUD') then raise exception 'File tidak cocok atau backup sudah dipindahkan';end if;
  if exists(select 1 from wms_private.period_archives where backup_id=p_id and status='PREPARED') then raise exception 'Selesaikan rencana arsip ini terlebih dahulu';end if;
  if p_id in (select id from public.branch_backups where branch_id=p_branch and storage_status='CLOUD' order by created_at desc,id limit 2) then raise exception 'Dua backup cloud terbaru tetap disimpan untuk pengaman';end if;
  delete from wms_private.backup_payloads where id=p_id;
  update public.branch_backups set storage_status='LOCAL' where id=p_id;
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,after_data,reason) values(p_branch,'backups',p_id::text,'BACKUP_MOVED_LOCAL',auth.uid(),jsonb_build_object('sha256',p_sha),p_reason);
  return jsonb_build_object('completed',true);
 end if;
 if p_action='prepare' then
  if p_cutoff is null or p_cutoff>now()-interval '90 days' or p_cutoff<'2000-01-01'::timestamptz then raise exception 'Arsip hanya untuk riwayat berumur minimal 90 hari';end if;
  if exists(select 1 from public.wms_documents where branch_id=p_branch and collection_name='orders' and coalesce(payload->>'status','Pending') not in ('Completed','Cancelled')) or exists(select 1 from public.branch_transfers where (source_branch=p_branch or destination_branch=p_branch) and status in ('DRAFT','SHIPPED','IN_TRANSIT')) then raise exception 'Selesaikan atau batalkan seluruh order dan transfer berjalan sebelum membuat arsip cabang';end if;
  stats=jsonb_build_object('orders',(select count(*) from wms_private.archive_document_keys(p_branch,p_cutoff) where collection_name='orders'),'logs',(select count(*) from wms_private.archive_document_keys(p_branch,p_cutoff) where collection_name='logs'),'movements',(select count(*) from public.stock_movements where branch_id=p_branch and created_at<p_cutoff),'events',(select count(*) from public.activity_events where branch_id=p_branch and created_at<p_cutoff),'stock_qty',(select coalesce(sum((payload->>'qty')::numeric),0) from public.wms_documents where branch_id=p_branch and collection_name='stock'));
  if (stats->>'orders')::bigint+(stats->>'logs')::bigint+(stats->>'events')::bigint+(stats->>'movements')::bigint=0 then raise exception 'Belum ada riwayat yang memenuhi batas umur arsip';end if;
  bid=wms_private.capture_branch_backup(p_branch,'PERIOD_ARCHIVE');
  if (select octet_length(jsonb_build_object('format','BLUES_WMS_BACKUP','version',1,'backup_id',bid,'branch_id',p_branch,'created_at',now(),'sha256',repeat('0',64),'payload_text',payload_text)::text) from wms_private.backup_payloads where id=bid)>50000000 then raise exception 'Arsip terlalu besar untuk unduhan ini. Hubungi pengelola untuk ekspor bertahap';end if;
  update wms_private.period_archives set status='CANCELLED' where branch_id=p_branch and actor_id=auth.uid() and status='PREPARED';
  insert into wms_private.period_archives(branch_id,actor_id,cutoff,backup_id,state_hash,summary) values(p_branch,auth.uid(),p_cutoff,bid,wms_private.archive_state(p_branch),stats) returning * into a;
  return jsonb_build_object('id',a.id,'backup_id',bid,'summary',stats,'cutoff',p_cutoff);
 end if;
 select * into a from wms_private.period_archives where id=p_id and branch_id=p_branch and actor_id=auth.uid() for update;
 if a.id is null then raise exception 'Rencana arsip tidak ditemukan';end if;
 if p_action='finish' and a.status='COMPLETED' then return jsonb_build_object('completed',true,'summary',a.summary);end if;
 if p_action<>'finish' or a.status<>'PREPARED' then raise exception 'Aksi arsip tidak valid';end if;
 if not wms_private.recent_password_auth() then raise exception 'Login ulang dengan password, lalu konfirmasi dalam 2 menit';end if;
 if p_confirmation is distinct from 'ARSIP '||p_branch or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Ketik konfirmasi cabang dan alasan minimal 10 karakter';end if;
 if p_sha is distinct from (select sha256 from public.branch_backups where id=a.backup_id) then raise exception 'File lokal belum cocok dengan arsip server';end if;
 if a.state_hash is distinct from wms_private.archive_state(p_branch) then raise exception 'Data cabang berubah. Buat dan unduh arsip baru saat operasional berhenti';end if;
 before_stock=wms_private.operational_state_hash(p_branch);
 select coalesce(jsonb_object_agg(document_id,qty),'{}') into before_ledger from (select document_id,sum(delta) qty from public.stock_movements where branch_id=p_branch group by document_id having sum(delta)<>0) s;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 perform set_config('wms.operation_type','PERIOD_ARCHIVE',true);perform set_config('wms.operation_id',a.id::text,true);perform set_config('wms.reason',p_reason,true);
 delete from public.wms_documents d using wms_private.archive_document_keys(p_branch,a.cutoff) k where d.branch_id=p_branch and d.collection_name=k.collection_name and d.document_id=k.document_id;
 -- Carry the sum of archived ledger deltas forward, without touching stock rows.
 insert into public.stock_movements(branch_id,document_id,sku_id,sku_name,location,expired_date,qty_before,qty_after,delta,operation_id,operation_type,actor_id,actor_name,created_at)
 select p_branch,document_id,max(sku_id),max(sku_name),max(location),max(expired_date),0,sum(delta),sum(delta),a.id::text,'ARCHIVE_OPENING',auth.uid(),actor,a.cutoff from public.stock_movements where branch_id=p_branch and created_at<a.cutoff group by document_id having sum(delta)<>0;
 delete from public.stock_movements where branch_id=p_branch and created_at<a.cutoff;
 delete from public.activity_events where branch_id=p_branch and created_at<a.cutoff;
 select coalesce(jsonb_object_agg(document_id,qty),'{}') into after_ledger from (select document_id,sum(delta) qty from public.stock_movements where branch_id=p_branch group by document_id having sum(delta)<>0) s;
 if before_ledger is distinct from after_ledger then raise exception 'Saldo buku mutasi berubah. Seluruh proses dibatalkan';end if;
 if before_stock is distinct from wms_private.operational_state_hash(p_branch) then raise exception 'Pemeriksaan saldo gagal. Seluruh proses dibatalkan';end if;
 delete from wms_private.backup_payloads where id=a.backup_id;
 update public.branch_backups set storage_status='LOCAL' where id=a.backup_id;
 update wms_private.period_archives set status='COMPLETED' where id=a.id;
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id) values(p_branch,'period_archive',a.id::text,'PERIOD_ARCHIVE_COMPLETED',auth.uid(),actor,a.summary||jsonb_build_object('cutoff',a.cutoff,'sha256',p_sha,'stock_hash',before_stock),p_reason,a.id::text);
 return jsonb_build_object('completed',true,'summary',a.summary);
end;$$;
revoke all on function wms_private.period_archive_action(text,text,timestamptz,uuid,text,text,text) from public,anon;
grant execute on function wms_private.period_archive_action(text,text,timestamptz,uuid,text,text,text) to authenticated;
create function public.period_archive_action(p_action text,p_branch text,p_cutoff timestamptz default null,p_id uuid default null,p_sha text default null,p_confirmation text default '',p_reason text default '') returns jsonb language sql security invoker set search_path='' as $$select wms_private.period_archive_action(p_action,p_branch,p_cutoff,p_id,p_sha,p_confirmation,p_reason)$$;
revoke all on function public.period_archive_action(text,text,timestamptz,uuid,text,text,text) from public,anon;
grant execute on function public.period_archive_action(text,text,timestamptz,uuid,text,text,text) to authenticated;
-- <<< period-archive.sql


-- >>> menu-audit-safety.sql
-- Called by the existing atomic writer, after branch authorization and revision locks.
create or replace function wms_private.validate_menu_audit_write(b text, ups jsonb, dels jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare i jsonb; p jsonb; oldp jsonb; item jsonb; source jsonb; target jsonb;
 k text; target_key text; expected jsonb='{}'; actual jsonb='{}'; q numeric;
 source_count integer; has_transfer boolean=false;
begin
 for i in select value from jsonb_array_elements(ups) loop
  if i->>'collection_name' not in ('inbound','warehouse_transfers') then continue; end if;
  select payload into oldp from public.wms_documents where branch_id=b and collection_name=i->>'collection_name' and document_id=i->>'document_id';
  p=case when coalesce((i->>'merge')::boolean,false) then coalesce(oldp,'{}')||(i->'payload') else i->'payload' end;
  if i->>'collection_name'='inbound' then
   if jsonb_typeof(p->'receivedQty') is distinct from 'number' then raise exception 'Qty inbound harus bilangan bulat positif';end if;
   q=(p->>'receivedQty')::numeric;
   if q<=0 or q<>trunc(q) or q>9007199254740991 then raise exception 'Qty inbound harus bilangan bulat positif';end if;
   if oldp->>'status'='QC_HOLD' and p->>'status'='PUTAWAY' then raise exception 'Selesaikan pemeriksaan QC sebelum putaway';end if;
   if p->>'status'='PUTAWAY' and (oldp is null or oldp->>'status' is distinct from 'PUTAWAY') then
    target_key=wms_private.stock_key(p||jsonb_build_object('location',p->>'targetLocation'));
    select d.payload into target from public.wms_documents d where d.branch_id=b and d.collection_name='stock' and wms_private.stock_key(d.payload)=target_key;
    if target is not null and not wms_private.stock_pickable(target) then raise exception 'Inbound tidak boleh bercampur stok rusak atau ditahan';end if;
   end if;
  elsif p->>'status'='RECEIVED' and (oldp is null or oldp->>'status' is distinct from 'RECEIVED') then
   has_transfer=true;
   if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items')=0 then raise exception 'Item transfer wajib diisi';end if;
   if upper(coalesce(p->>'sourceWarehouseId','WH-CENTRAL'))=upper(coalesce(p->>'targetWarehouseId','WH-CENTRAL')) then raise exception 'Gudang asal dan tujuan harus berbeda';end if;
   for item in select value from jsonb_array_elements(p->'items') loop
    if jsonb_typeof(item->'qty') is distinct from 'number' then raise exception 'Qty transfer harus bilangan bulat positif';end if;
    q=(item->>'qty')::numeric;if q<=0 or q<>trunc(q) or q>9007199254740991 then raise exception 'Qty transfer tidak valid';end if;
    k=wms_private.stock_key(item||jsonb_build_object('warehouseId',p->>'sourceWarehouseId','location',item->>'sourceLocation'));
    select count(*) into source_count from public.wms_documents d where d.branch_id=b and d.collection_name='stock' and wms_private.stock_key(d.payload)=k;
    select d.payload into source from public.wms_documents d where d.branch_id=b and d.collection_name='stock' and wms_private.stock_key(d.payload)=k;
    if source_count<>1 or not coalesce(wms_private.stock_pickable(source),false) then raise exception 'Stok transfer asal tidak tersedia atau ditahan/rusak/kedaluwarsa';end if;
    expected=jsonb_set(expected,array[k],to_jsonb(coalesce((expected->>k)::numeric,0)-q),true);
    if -((expected->>k)::numeric)>(source->>'qty')::numeric then raise exception 'Jumlah transfer melebihi stok asal';end if;
    target_key=wms_private.stock_key(item||jsonb_build_object('warehouseId',p->>'targetWarehouseId','location',coalesce(nullif(item->>'targetLocation',''),'RACK-INBOUND')));
    select d.payload into target from public.wms_documents d where d.branch_id=b and d.collection_name='stock' and wms_private.stock_key(d.payload)=target_key;
    if target is not null and not wms_private.stock_pickable(target) then raise exception 'Kondisi stok tujuan tidak boleh tercampur dengan stok tersedia';end if;
    select case when coalesce((j->>'merge')::boolean,false) then coalesce(target,'{}')||(j->'payload') else j->'payload' end into target
    from jsonb_array_elements(ups) j where j->>'collection_name'='stock' and wms_private.stock_key(j->'payload')=target_key;
    if target is null or not wms_private.stock_pickable(target) then raise exception 'Stok transfer tujuan wajib valid dan tersedia';end if;
    expected=jsonb_set(expected,array[target_key],to_jsonb(coalesce((expected->>target_key)::numeric,0)+q),true);
   end loop;
  end if;
 end loop;
 if has_transfer then
  for i in select value from jsonb_array_elements(ups||dels) where value->>'collection_name'='stock' loop
   select payload into oldp from public.wms_documents where branch_id=b and collection_name='stock' and document_id=i->>'document_id';
   if oldp is not null then k=wms_private.stock_key(oldp);actual=jsonb_set(actual,array[k],to_jsonb(coalesce((actual->>k)::numeric,0)-(oldp->>'qty')::numeric),true);end if;
   if i?'payload' then
    p=case when coalesce((i->>'merge')::boolean,false) then coalesce(oldp,'{}')||(i->'payload') else i->'payload' end;
    k=wms_private.stock_key(p);actual=jsonb_set(actual,array[k],to_jsonb(coalesce((actual->>k)::numeric,0)+(p->>'qty')::numeric),true);
   end if;
  end loop;
  for k in select jsonb_object_keys(expected||actual) loop
   if coalesce((expected->>k)::numeric,0)<>coalesce((actual->>k)::numeric,0) then raise exception 'Mutasi stok tidak sesuai dokumen transfer';end if;
  end loop;
 end if;
end;$$;
revoke all on function wms_private.validate_menu_audit_write(text,jsonb,jsonb) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION wms_private.validate_operational_write(b text, ups jsonb, dels jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare r text; i jsonb; p jsonb; oldp jsonb; c text; k text;source jsonb; expected jsonb='{}';actual jsonb='{}';q numeric;before_qty numeric;has_allocation boolean=false;source_count integer;
begin
 perform wms_private.validate_menu_audit_write(b,ups,dels);
 select role into r from public.profiles where id=auth.uid() and is_active;
 if r is null or r not in ('Administrator','Admin','Picker','Packer') then raise exception 'Peran tidak boleh menulis';end if;
 if not exists(select 1 from jsonb_array_elements(ups) j where j->>'collection_name'='stock') and exists(select 1 from jsonb_array_elements(dels) j where j->>'collection_name'='stock') and (
 (select count(*) from jsonb_array_elements(dels) j where j->>'collection_name'='stock')>=25 or not exists(select 1 from public.wms_documents d where d.branch_id=b and d.collection_name='stock' and not exists(select 1 from jsonb_array_elements(dels) j where j->>'collection_name'='stock' and j->>'document_id'=d.document_id))
 ) then raise exception 'Pengosongan stok harus melalui autentikasi ulang dan rencana pengosongan';end if;
 for i in select value from jsonb_array_elements(ups||dels) loop
  c=i->>'collection_name';
  if r in ('Picker','Packer') and c not in ('orders','stock','logs','batches') then raise exception 'Peran tidak boleh mengubah koleksi %',c;end if;
 end loop;
 for i in select value from jsonb_array_elements(dels) loop
  if r in ('Picker','Packer') then raise exception 'Operator tidak boleh menghapus dokumen';end if;
  if i->>'collection_name'='stock' then select payload into oldp from public.wms_documents where branch_id=b and collection_name='stock' and document_id=i->>'document_id';k=wms_private.stock_key(oldp);actual=jsonb_set(actual,array[k],to_jsonb(coalesce((actual->>k)::numeric,0)-coalesce((oldp->>'qty')::numeric,0)),true);end if;
 end loop;
 for i in select value from jsonb_array_elements(ups) loop
  c=i->>'collection_name';
  select payload into oldp from public.wms_documents where branch_id=b and collection_name=c and document_id=i->>'document_id';
  p=case when coalesce((i->>'merge')::boolean,false) then coalesce(oldp,'{}')||(i->'payload') else i->'payload' end;
  if c='stock' then
   if jsonb_typeof(p->'qty') is distinct from 'number' then raise exception 'Jumlah stok harus angka bulat';end if;
   q=(p->>'qty')::numeric;if q<0 or q<>trunc(q) or q>9007199254740991 then raise exception 'Jumlah stok tidak valid';end if;
   if coalesce(trim(p->>'skuId'),'')='' or coalesce(trim(p->>'location'),'')='' then raise exception 'Identitas stok wajib lengkap';end if;
   if r in ('Picker','Packer') and (oldp is null or wms_private.stock_key(oldp)<>wms_private.stock_key(p) or wms_private.stock_pickable(oldp)<>wms_private.stock_pickable(p)) then raise exception 'Operator tidak boleh menambah atau mengganti identitas/kondisi stok';end if;
   if oldp is not null then k=wms_private.stock_key(oldp);actual=jsonb_set(actual,array[k],to_jsonb(coalesce((actual->>k)::numeric,0)-coalesce((oldp->>'qty')::numeric,0)),true);end if;
   k=wms_private.stock_key(p);actual=jsonb_set(actual,array[k],to_jsonb(coalesce((actual->>k)::numeric,0)+q),true);
  elsif c='orders' then
   if jsonb_typeof(p->'qty') is distinct from 'number' or (p->>'qty')::numeric<=0 or (p->>'qty')::numeric<>trunc((p->>'qty')::numeric) then raise exception 'Jumlah order harus bilangan bulat positif';end if;
   if coalesce(p->>'status','') not in ('Pending','Completed','Cancelled') then raise exception 'Status order tidak valid';end if;
   if r='Picker' and p->>'status'<>'Pending' then raise exception 'Picker tidak boleh menyelesaikan packing atau membatalkan order';end if;
   if r in ('Picker','Packer') and oldp is not null and (oldp->>'referenceNumber' is distinct from p->>'referenceNumber' or oldp->>'skuId' is distinct from p->>'skuId' or coalesce(oldp->>'warehouseId','WH-CENTRAL') is distinct from coalesce(p->>'warehouseId','WH-CENTRAL')) then raise exception 'Operator tidak boleh mengubah identitas order';end if;
   if r='Packer' and (not coalesce(wms_private.order_deducted(p),false) or wms_private.stock_key(p) is distinct from wms_private.stock_key(oldp) or p->>'qty' is distinct from oldp->>'qty') then raise exception 'Packer tidak boleh mengubah alokasi picking';end if;
   if r='Packer' and (oldp is null or not coalesce(wms_private.order_deducted(oldp),false)) then raise exception 'Packer hanya memproses order yang sudah dipick';end if;
   if coalesce(wms_private.order_deducted(oldp),false) then k=wms_private.stock_key(oldp);expected=jsonb_set(expected,array[k],to_jsonb(coalesce((expected->>k)::numeric,0)+(oldp->>'qty')::numeric),true);end if;
   if coalesce(wms_private.order_deducted(p),false) then
    k=wms_private.stock_key(p);
    select payload into source from public.wms_documents where branch_id=b and collection_name='stock' and wms_private.stock_key(payload)=k;
    select count(*) into source_count from public.wms_documents where branch_id=b and collection_name='stock' and wms_private.stock_key(payload)=k;
    if source_count<>1 or source is null or not wms_private.stock_pickable(source) then raise exception 'Stok karantina/rusak/kedaluwarsa atau lokasi buffer tidak dapat dipick';end if;
    expected=jsonb_set(expected,array[k],to_jsonb(coalesce((expected->>k)::numeric,0)-(p->>'qty')::numeric),true);has_allocation=true;
   end if;
  end if;
 end loop;
 if r='Picker' then
  for p in select value->'payload' from jsonb_array_elements(ups) where value->>'collection_name'='orders' loop
   if not exists(select 1 from public.wms_documents d where d.branch_id=b and d.collection_name='orders' and d.payload->>'status'='Pending' and d.payload->>'referenceNumber'=p->>'referenceNumber' and d.payload->>'skuId'=p->>'skuId' and coalesce(d.payload->>'warehouseId','WH-CENTRAL')=coalesce(p->>'warehouseId','WH-CENTRAL')) then raise exception 'Picker tidak boleh membuat order baru';end if;
  end loop;
  if exists(
   with touched as(select distinct value->'payload'->>'referenceNumber' ref from jsonb_array_elements(ups) where value->>'collection_name'='orders'),
   old_rows as(select d.document_id,d.payload from public.wms_documents d join touched t on t.ref=d.payload->>'referenceNumber' where d.branch_id=b and d.collection_name='orders' and d.payload->>'status'='Pending'),
   final_rows as(select o.payload from old_rows o where not exists(select 1 from jsonb_array_elements(ups) j where j->>'collection_name'='orders' and j->>'document_id'=o.document_id)
    union all select case when coalesce((j->>'merge')::boolean,false) then coalesce(o.payload,'{}')||(j->'payload') else j->'payload' end from jsonb_array_elements(ups) j left join old_rows o on o.document_id=j->>'document_id' where j->>'collection_name'='orders'),
   totals as(select payload->>'referenceNumber' ref,payload->>'skuId' sku,coalesce(payload->>'warehouseId','WH-CENTRAL') wh,(payload->>'qty')::numeric qty from old_rows union all select payload->>'referenceNumber',payload->>'skuId',coalesce(payload->>'warehouseId','WH-CENTRAL'),-(payload->>'qty')::numeric from final_rows)
   select 1 from totals group by ref,sku,wh having sum(qty)<>0
  ) then raise exception 'Jumlah order asli harus dipertahankan';end if;
 end if;
 if has_allocation or r in ('Picker','Packer') then
  for k in select jsonb_object_keys(expected||actual) loop
   if coalesce((expected->>k)::numeric,0)<>coalesce((actual->>k)::numeric,0) then raise exception 'Mutasi stok tidak sesuai alokasi order';end if;
  end loop;
 end if;
end;$function$;
-- <<< menu-audit-safety.sql


-- >>> hq-dashboard.sql

create function wms_private.dashboard_expiry_date(raw text) returns date
language plpgsql immutable set search_path='' as $$
declare normalized text;
begin
 normalized=wms_private.transfer_expired_date(raw);
 if normalized='No Expired' then return null;end if;
 return make_date(split_part(normalized,'/',3)::integer,split_part(normalized,'/',2)::integer,split_part(normalized,'/',1)::integer);
exception when others then return null;
end;$$;
revoke all on function wms_private.dashboard_expiry_date(text) from public,anon,authenticated;
create function wms_private.hq_dashboard(p_low_stock integer,p_near_days integer,p_branch_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;today date=(now() at time zone 'Asia/Jakarta')::date;
begin
 if auth.uid() is null or not wms_private.is_hq() then raise exception 'Dashboard jaringan hanya untuk Administrator kantor pusat';end if;
 if p_low_stock is null or p_low_stock not between 0 and 1000000 or p_near_days is null or p_near_days not between 1 and 730 then raise exception 'Batas stok atau periode kedaluwarsa tidak valid';end if;
 if p_branch_id is not null and not exists(select 1 from public.branches where id=p_branch_id) then raise exception 'Cabang tidak ditemukan';end if;
 with
 selected_branches as(select id,name from public.branches where p_branch_id is null or id=p_branch_id),
 stock as materialized(
 select d.branch_id,d.document_id,upper(trim(d.payload->>'skuId')) sku_id,coalesce(d.payload->>'skuName',d.payload->>'skuId') sku_name,
 d.payload->>'location' location,d.payload->>'expiredDate' expired_text,
 coalesce((d.payload->>'qty')::numeric,0) qty,
 wms_private.dashboard_expiry_date(d.payload->>'expiredDate') expiry_date,
 lower(coalesce(d.payload->>'status','')) raw_status
 from public.wms_documents d join selected_branches b on b.id=d.branch_id
 where d.collection_name='stock' and left(d.document_id,7)<>'SYSTEM_'
 ),
 classified as materialized(
 select *,case
 when raw_status like '%damage%' or lower(coalesce(expired_text,'')) like '%damage%' then 'DAMAGE'
 when expiry_date<=today or raw_status='expired' or lower(coalesce(expired_text,''))='expired' then 'EXPIRED'
 when expiry_date>today and expiry_date<=today+p_near_days then 'NEAR'
 when expiry_date is null and lower(trim(coalesce(expired_text,''))) not in ('','-','no expired','no ed','no_expired','noed') then 'INVALID_DATE'
 else 'SAFE' end category from stock
 ),
 sku_sources as(
 select branch_id,sku_id,sku_name,qty from stock
 union all
 select d.branch_id,upper(trim(coalesce(d.payload->>'skuId',d.document_id))),coalesce(d.payload->>'skuName',d.payload->>'skuId',d.document_id),0::numeric
 from public.wms_documents d join selected_branches b on b.id=d.branch_id where collection_name='catalog'
 ),
 sku_totals as(select branch_id,sku_id,max(sku_name) sku_name,sum(qty) qty from sku_sources where coalesce(sku_id,'')<>'' group by branch_id,sku_id),
 stock_summary as(
 select branch_id,sum(qty) total_qty,coalesce(sum(qty) filter(where category='EXPIRED'),0) expired_qty,
 coalesce(sum(qty) filter(where category='NEAR'),0) near_qty,coalesce(sum(qty) filter(where category='DAMAGE'),0) damage_qty,
 count(*) filter(where category='INVALID_DATE' and qty>0) invalid_date_rows
 from classified group by branch_id
 ),
 sku_summary as(select branch_id,count(*) filter(where qty>0) active_skus,count(*) filter(where qty<=p_low_stock) low_skus,count(*) filter(where qty=0) empty_skus from sku_totals group by branch_id),
 order_summary as(select d.branch_id,count(*) pending_orders from public.wms_documents d join selected_branches b on b.id=d.branch_id where collection_name='orders' and coalesce(payload->>'status','Pending')='Pending' group by d.branch_id),
 pending as materialized(
 select t.id,t.source_branch,t.destination_branch,t.status,t.created_at,t.updated_at,
 (select coalesce(sum((value->>'qty')::numeric),0) from jsonb_array_elements(t.items)) qty,
 t.created_at<now()-interval '24 hours' overdue
 from public.branch_transfers t where status in ('DRAFT','SHIPPED','IN_TRANSIT')
 and (p_branch_id is null or source_branch=p_branch_id or destination_branch=p_branch_id)
 ),
 branch_rows as(
 select b.id,b.name,coalesce(s.total_qty,0) total_qty,coalesce(k.active_skus,0) active_skus,
 coalesce(k.low_skus,0) low_skus,coalesce(k.empty_skus,0) empty_skus,coalesce(s.near_qty,0) near_qty,
 coalesce(s.expired_qty,0) expired_qty,coalesce(s.damage_qty,0) damage_qty,coalesce(s.invalid_date_rows,0) invalid_date_rows,
 coalesce(o.pending_orders,0) pending_orders,
 (select count(*) from pending where source_branch=b.id) outgoing_transfers,
 (select count(*) from pending where destination_branch=b.id) incoming_transfers,
 (select max(created_at) from public.branch_backups where branch_id=b.id and kind='DAILY') last_daily_backup
 from selected_branches b left join stock_summary s on s.branch_id=b.id left join sku_summary k on k.branch_id=b.id left join order_summary o on o.branch_id=b.id
 )
 select jsonb_build_object(
 'as_of',now(),'today_wib',today,'low_stock_threshold',p_low_stock,'near_expiry_days',p_near_days,
 'totals',jsonb_build_object(
 'branches',(select count(*) from selected_branches),'qty',(select coalesce(sum(qty),0) from stock),
 'active_skus',(select count(distinct sku_id) from sku_totals where qty>0),
 'low_sku_positions',(select count(*) from sku_totals where qty<=p_low_stock),
 'empty_sku_positions',(select count(*) from sku_totals where qty=0),
 'near_qty',(select coalesce(sum(qty),0) from classified where category='NEAR'),
 'expired_qty',(select coalesce(sum(qty),0) from classified where category='EXPIRED'),
 'damage_qty',(select coalesce(sum(qty),0) from classified where category='DAMAGE'),
 'invalid_date_rows',(select count(*) from classified where category='INVALID_DATE' and qty>0),
 'pending_orders',(select coalesce(sum(pending_orders),0) from order_summary),
 'pending_transfers',(select count(*) from pending),'overdue_transfers',(select count(*) from pending where overdue)
 ),
 'branches',(select coalesce(jsonb_agg(to_jsonb(br) order by br.id),'[]') from branch_rows br),
 'low_stock',(select coalesce(jsonb_agg(to_jsonb(l) order by l.qty,l.branch_id,l.sku_id),'[]') from (select * from sku_totals where qty<=p_low_stock order by qty,branch_id,sku_id limit 100)l),
 'expiry_alerts',(select coalesce(jsonb_agg(to_jsonb(e) order by e.expiry_date nulls last,e.branch_id,e.sku_id),'[]') from (select branch_id,sku_id,sku_name,location,expired_text,expiry_date,qty,category from classified where qty>0 and category<>'SAFE' order by expiry_date nulls last,branch_id,sku_id limit 100)e),
 'pending_transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at),'[]') from (select * from pending order by created_at limit 100)t),
 'list_limit',100
 ) into result;
 return result;
end;$$;
revoke all on function wms_private.hq_dashboard(integer,integer,text) from public,anon;
grant execute on function wms_private.hq_dashboard(integer,integer,text) to authenticated;
create function public.hq_dashboard(p_low_stock integer default 10,p_near_days integer default 90,p_branch_id text default null)
returns jsonb language sql stable security invoker set search_path='' as $$select wms_private.hq_dashboard(p_low_stock,p_near_days,p_branch_id)$$;
revoke all on function public.hq_dashboard(integer,integer,text) from public,anon;
grant execute on function public.hq_dashboard(integer,integer,text) to authenticated;
-- <<< hq-dashboard.sql


-- >>> hq-condition-alignment.sql
CREATE OR REPLACE FUNCTION wms_private.hq_dashboard(p_low_stock integer, p_near_days integer, p_branch_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;today date=(now() at time zone 'Asia/Jakarta')::date;
begin
 if auth.uid() is null or not wms_private.is_hq() then raise exception 'Dashboard jaringan hanya untuk Administrator kantor pusat';end if;
 if p_low_stock is null or p_low_stock not between 0 and 1000000 or p_near_days is null or p_near_days not between 1 and 730 then raise exception 'Batas stok atau periode kedaluwarsa tidak valid';end if;
 if p_branch_id is not null and not exists(select 1 from public.branches where id=p_branch_id) then raise exception 'Cabang tidak ditemukan';end if;
 with
 selected_branches as(select id,name from public.branches where p_branch_id is null or id=p_branch_id),
 stock as materialized(
 select d.branch_id,d.document_id,upper(trim(d.payload->>'skuId')) sku_id,coalesce(d.payload->>'skuName',d.payload->>'skuId') sku_name,
 d.payload->>'location' location,d.payload->>'expiredDate' expired_text,
 coalesce((d.payload->>'qty')::numeric,0) qty,
 wms_private.dashboard_expiry_date(d.payload->>'expiredDate') expiry_date,
 lower(coalesce(d.payload->>'status','')) raw_status
 from public.wms_documents d join selected_branches b on b.id=d.branch_id
 where d.collection_name='stock' and left(d.document_id,7)<>'SYSTEM_'
 ),
 classified as materialized(
 select *,case
 when raw_status~'(damage|rusak)' then 'DAMAGE'
 when raw_status~'(expired|kedaluwarsa)' or expiry_date<=today or (lower(trim(coalesce(expired_text,''))) not in ('','-','--','no expired','no ed','no_expired','noed') and lower(coalesce(expired_text,'')) like '%expired%') then 'EXPIRED'
 when lower(coalesce(expired_text,'')) like '%damage%' then 'DAMAGE'
 when raw_status~'(hold|karantina|quarantine)' or lower(coalesce(location,''))~'(hold|karantina|quarantine)' then 'HOLD'
 when expiry_date>today and expiry_date<=today+p_near_days then 'NEAR'
 when expiry_date is null and lower(trim(coalesce(expired_text,''))) not in ('','-','--','no expired','no ed','no_expired','noed') then 'INVALID_DATE'
 else 'SAFE' end category from stock
 ),
 sku_sources as(
 select branch_id,sku_id,sku_name,qty from stock
 union all
 select d.branch_id,upper(trim(coalesce(d.payload->>'skuId',d.document_id))),coalesce(d.payload->>'skuName',d.payload->>'skuId',d.document_id),0::numeric
 from public.wms_documents d join selected_branches b on b.id=d.branch_id where collection_name='catalog'
 ),
 sku_totals as(select branch_id,sku_id,max(sku_name) sku_name,sum(qty) qty from sku_sources where coalesce(sku_id,'')<>'' group by branch_id,sku_id),
 stock_summary as(
 select branch_id,sum(qty) total_qty,coalesce(sum(qty) filter(where category='EXPIRED'),0) expired_qty,
 coalesce(sum(qty) filter(where category='NEAR'),0) near_qty,coalesce(sum(qty) filter(where category='DAMAGE'),0) damage_qty,
 count(*) filter(where category='INVALID_DATE' and qty>0) invalid_date_rows
 from classified group by branch_id
 ),
 sku_summary as(select branch_id,count(*) filter(where qty>0) active_skus,count(*) filter(where qty<=p_low_stock) low_skus,count(*) filter(where qty=0) empty_skus from sku_totals group by branch_id),
 order_summary as(select d.branch_id,count(*) pending_orders from public.wms_documents d join selected_branches b on b.id=d.branch_id where collection_name='orders' and coalesce(payload->>'status','Pending')='Pending' group by d.branch_id),
 pending as materialized(
 select t.id,t.source_branch,t.destination_branch,t.status,t.created_at,t.updated_at,
 (select coalesce(sum((value->>'qty')::numeric),0) from jsonb_array_elements(t.items)) qty,
 t.created_at<now()-interval '24 hours' overdue
 from public.branch_transfers t where status in ('DRAFT','SHIPPED','IN_TRANSIT')
 and (p_branch_id is null or source_branch=p_branch_id or destination_branch=p_branch_id)
 ),
 branch_rows as(
 select b.id,b.name,coalesce(s.total_qty,0) total_qty,coalesce(k.active_skus,0) active_skus,
 coalesce(k.low_skus,0) low_skus,coalesce(k.empty_skus,0) empty_skus,coalesce(s.near_qty,0) near_qty,
 coalesce(s.expired_qty,0) expired_qty,coalesce(s.damage_qty,0) damage_qty,coalesce(s.invalid_date_rows,0) invalid_date_rows,
 coalesce(o.pending_orders,0) pending_orders,
 (select count(*) from pending where source_branch=b.id) outgoing_transfers,
 (select count(*) from pending where destination_branch=b.id) incoming_transfers,
 (select max(created_at) from public.branch_backups where branch_id=b.id and kind='DAILY') last_daily_backup
 from selected_branches b left join stock_summary s on s.branch_id=b.id left join sku_summary k on k.branch_id=b.id left join order_summary o on o.branch_id=b.id
 )
 select jsonb_build_object(
 'as_of',now(),'today_wib',today,'low_stock_threshold',p_low_stock,'near_expiry_days',p_near_days,
 'totals',jsonb_build_object(
 'branches',(select count(*) from selected_branches),'qty',(select coalesce(sum(qty),0) from stock),
 'active_skus',(select count(distinct sku_id) from sku_totals where qty>0),
 'low_sku_positions',(select count(*) from sku_totals where qty<=p_low_stock),
 'empty_sku_positions',(select count(*) from sku_totals where qty=0),
 'near_qty',(select coalesce(sum(qty),0) from classified where category='NEAR'),
 'expired_qty',(select coalesce(sum(qty),0) from classified where category='EXPIRED'),
 'hold_qty',(select coalesce(sum(qty),0) from classified where category='HOLD'),
 'damage_qty',(select coalesce(sum(qty),0) from classified where category='DAMAGE'),
 'invalid_date_rows',(select count(*) from classified where category='INVALID_DATE' and qty>0),
 'pending_orders',(select coalesce(sum(pending_orders),0) from order_summary),
 'pending_transfers',(select count(*) from pending),'overdue_transfers',(select count(*) from pending where overdue)
 ),
 'branches',(select coalesce(jsonb_agg(to_jsonb(br) order by br.id),'[]') from branch_rows br),
 'low_stock',(select coalesce(jsonb_agg(to_jsonb(l) order by l.qty,l.branch_id,l.sku_id),'[]') from (select * from sku_totals where qty<=p_low_stock order by qty,branch_id,sku_id limit 100)l),
 'expiry_alerts',(select coalesce(jsonb_agg(to_jsonb(e) order by e.expiry_date nulls last,e.branch_id,e.sku_id),'[]') from (select branch_id,sku_id,sku_name,location,expired_text,expiry_date,qty,category from classified where qty>0 and category<>'SAFE' order by expiry_date nulls last,branch_id,sku_id limit 100)e),
 'pending_transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at),'[]') from (select * from pending order by created_at limit 100)t),
 'list_limit',100
 ) into result;
 return result;
end;$function$
;
-- <<< hq-condition-alignment.sql


-- >>> viewer-network-read.sql
create or replace function wms_private.is_inventory_viewer() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.profiles where id=auth.uid() and is_active and role='Viewer') $$;
revoke all on function wms_private.is_inventory_viewer() from public,anon;
grant execute on function wms_private.is_inventory_viewer() to authenticated;
drop policy if exists branches_inventory_viewer_read on public.branches;
create policy branches_inventory_viewer_read on public.branches for select to authenticated using ((select wms_private.is_inventory_viewer()));
drop policy if exists documents_inventory_viewer_read on public.wms_documents;
create policy documents_inventory_viewer_read on public.wms_documents as restrictive for select to authenticated using (
 not (select wms_private.is_inventory_viewer())
 or collection_name in ('stock','warehouses','catalog')
);
-- <<< viewer-network-read.sql


-- >>> admin-guard.sql
begin;
lock table public.profiles in share row exclusive mode;
create table if not exists wms_private.admin_guard(singleton boolean primary key default true check(singleton),active_count integer not null check(active_count>=0));
revoke all on wms_private.admin_guard from public,anon,authenticated;
alter table wms_private.admin_guard enable row level security;
insert into wms_private.admin_guard(singleton,active_count) select true,count(*)::int from public.profiles where role='Administrator' and is_active on conflict(singleton) do update set active_count=excluded.active_count;
create or replace function wms_private.protect_last_administrator() returns trigger language plpgsql security definer set search_path='' as $guard$
declare was_admin boolean:=false; is_admin boolean:=false;
begin
 if tg_op<>'INSERT' then was_admin:=old.role='Administrator' and old.is_active;end if;
 if tg_op<>'DELETE' then is_admin:=new.role='Administrator' and new.is_active;end if;
 if was_admin and not is_admin then
  update wms_private.admin_guard set active_count=active_count-1 where singleton and active_count>1;
  if not found then raise exception 'Administrator aktif terakhir tidak dapat dihapus, dinonaktifkan, atau diturunkan perannya';end if;
 elsif is_admin and not was_admin then
  update wms_private.admin_guard set active_count=active_count+1 where singleton;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$guard$;
revoke all on function wms_private.protect_last_administrator() from public,anon,authenticated;
drop trigger if exists protect_last_administrator on public.profiles;
create trigger protect_last_administrator before insert or update or delete on public.profiles for each row execute function wms_private.protect_last_administrator();
commit;
-- <<< admin-guard.sql

-- >>> 20261112094034_branch_deletion_safety.sql
-- Branches can only be deleted through the guarded RPC. Direct table DELETE
-- bypasses the last-branch and retained-data checks below.
revoke delete on table public.branches from public, anon, authenticated;
drop policy if exists branches_delete on public.branches;

create or replace function public.delete_wms_branch(p_branch_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_branch_id text;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active
      and role = 'Administrator'
  ) then
    raise exception 'Hanya Administrator aktif yang dapat menghapus cabang.';
  end if;

  if p_branch_id is null or p_branch_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then
    raise exception 'Kode cabang tidak valid.';
  end if;

  -- Serialize deletions so concurrent requests cannot remove the final branch.
  perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global', 0));
  select id into v_branch_id
  from public.branches
  where id = p_branch_id
  for update;

  if v_branch_id is null then
    raise exception 'Cabang % tidak ditemukan.', p_branch_id;
  end if;

  select count(*) into v_count from public.branches;
  if v_count <= 1 then
    raise exception 'Tidak dapat menghapus cabang terakhir.';
  end if;

  -- Never reassign users implicitly: that would grant them access to another
  -- branch under the branch-scoped RLS policies.
  if exists (select 1 from public.profiles where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki profil akun. Pindahkan atau hapus akun secara terpisah terlebih dahulu.';
  end if;

  -- Keep operational documents, transfers, audit history and backups intact.
  -- Until an archive-and-restore workflow exists, used branches are not deletable.
  if exists (select 1 from public.wms_documents where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki dokumen WMS. Arsipkan dan tinjau data sebelum menghapus cabang.';
  end if;
  if exists (
    select 1 from public.branch_transfers
    where source_branch = p_branch_id or destination_branch = p_branch_id
  ) then
    raise exception 'Cabang masih memiliki riwayat transfer.';
  end if;
  if exists (select 1 from public.stock_movements where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki riwayat mutasi stok.';
  end if;
  if exists (select 1 from public.activity_events where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki catatan audit.';
  end if;
  if exists (select 1 from public.branch_backups where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki backup yang tersimpan.';
  end if;
  if exists (select 1 from wms_private.period_archives where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki arsip periode.';
  end if;
  if exists (select 1 from wms_private.stock_purge_plans where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki rencana pengosongan stok.';
  end if;

  delete from wms_private.write_requests where branch_id = p_branch_id;
  delete from public.branches where id = p_branch_id;

  return jsonb_build_object('success', true, 'message', 'Cabang kosong berhasil dihapus.');
end;
$$;

revoke all on function public.delete_wms_branch(text) from public, anon;
grant execute on function public.delete_wms_branch(text) to authenticated;
-- <<< 20261112094034_branch_deletion_safety.sql

-- >>> 20261112175307_permanent_branch_deletion.sql
-- Permanent branch deletion requires a verified, re-uploaded backup and recent
-- password authentication. Direct table deletion and the legacy RPC stay revoked.
-- Multi-part export supports large branches (>35 MB) across distinct parts.

revoke all on function public.delete_wms_branch(text) from public, anon, authenticated;
revoke delete on table public.branches from public, anon, authenticated;
drop policy if exists branches_delete on public.branches;

create table if not exists wms_private.branch_deletion_plans (
  id uuid primary key,
  branch_id text not null,
  actor_id uuid not null,
  sha256 text not null,
  payload_text text,
  summary jsonb not null,
  status text not null default 'PREPARED' check (status in ('PREPARED','COMPLETED','CANCELLED','RESTORED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz
);
alter table wms_private.branch_deletion_plans enable row level security;
revoke all on wms_private.branch_deletion_plans from public, anon, authenticated;

-- Only the restoration transaction populates this private staging table.
create table if not exists wms_private.branch_restore_documents (
 plan_id uuid not null,branch_id text not null,collection_name text not null,
 document_id text not null,payload jsonb not null,
 primary key(plan_id,branch_id,collection_name,document_id)
);
alter table wms_private.branch_restore_documents enable row level security;
revoke all on wms_private.branch_restore_documents from public,anon,authenticated;

create or replace function wms_private.restore_document_payload() returns trigger
language plpgsql set search_path='' as $$
declare restored jsonb; restore_id text=current_setting('wms.restore_operation_id',true);
begin
 if current_user='postgres' and nullif(restore_id,'') is not null then
  select payload into restored from wms_private.branch_restore_documents
  where plan_id::text=restore_id and branch_id=new.branch_id
   and collection_name=new.collection_name and document_id=new.document_id;
  if found then new.payload=restored;end if;
 end if;
 return new;
end;$$;
revoke all on function wms_private.restore_document_payload() from public,anon,authenticated;

drop trigger if exists zz_restore_document_payload on public.wms_documents;
create trigger zz_restore_document_payload before insert on public.wms_documents
for each row execute function wms_private.restore_document_payload();

-- Part 1: Operational documents, stock movements, transfers, profiles
create or replace function wms_private.branch_part_operational(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'branch',(select to_jsonb(b) from public.branches b where b.id=p_branch),
   'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by d.collection_name,d.document_id),'[]'::jsonb) from public.wms_documents d where d.branch_id=p_branch),
   'transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from public.branch_transfers t where t.source_branch=p_branch or t.destination_branch=p_branch),
   'operators',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.profiles p where p.branch_id=p_branch),
   'stock_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from public.stock_movements m where m.branch_id=p_branch)
 );
$$;
revoke all on function wms_private.branch_part_operational(text) from public, anon, authenticated;

-- Part 2: Activity audit events
create or replace function wms_private.branch_part_audit(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'activity_events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.activity_events e where e.branch_id=p_branch)
 );
$$;
revoke all on function wms_private.branch_part_audit(text) from public, anon, authenticated;

-- Part 3: Historical branch backups (metadata only to avoid redundant 27MB payload bloat)
create or replace function wms_private.branch_part_backups(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'backups',(select coalesce(jsonb_agg(jsonb_build_object('metadata',to_jsonb(b)) order by b.id),'[]'::jsonb) from public.branch_backups b where b.branch_id=p_branch)
 );
$$;
revoke all on function wms_private.branch_part_backups(text) from public, anon, authenticated;

-- Dedicated indexes to make branch queries instant (<100ms) and eliminate table scans
create index if not exists activity_events_branch_id_idx on public.activity_events(branch_id);
create index if not exists wms_documents_branch_id_idx on public.wms_documents(branch_id);
create index if not exists stock_movements_branch_id_idx on public.stock_movements(branch_id);
create index if not exists write_requests_branch_id_idx on wms_private.write_requests(branch_id);

-- Combined snapshot (ultra-fast, excludes unindexed technical request logs and duplicate backups)
create or replace function wms_private.branch_deletion_snapshot(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'branch',(select to_jsonb(b) from public.branches b where b.id=p_branch),
   'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by d.collection_name,d.document_id),'[]'::jsonb) from public.wms_documents d where d.branch_id=p_branch),
   'transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from public.branch_transfers t where t.source_branch=p_branch or t.destination_branch=p_branch),
   'operators',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.profiles p where p.branch_id=p_branch),
   'stock_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from public.stock_movements m where m.branch_id=p_branch),
   'activity_events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.activity_events e where e.branch_id=p_branch),
   'backups',(select coalesce(jsonb_agg(jsonb_build_object('metadata',to_jsonb(b)) order by b.id),'[]'::jsonb) from public.branch_backups b where b.branch_id=p_branch)
 );
$$;
revoke all on function wms_private.branch_deletion_snapshot(text) from public, anon, authenticated;

create or replace function wms_private.branch_deletion_action(
 p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout = '120s' as $$
declare
 plan wms_private.branch_deletion_plans%rowtype;
 actor_branch text; actor_name text; snapshot jsonb; raw text; digest text; summary jsonb;
 branch_row public.branches%rowtype; remaining integer; local_backups integer;
 is_multi boolean; parts jsonb;
 count_docs bigint; count_orders bigint; count_stock bigint; stock_qty numeric;
 count_movements bigint; count_audit bigint; count_backups bigint; count_req bigint;
 raw_op text; raw_audit text; raw_backups text; raw_req text;
 sha_op text; sha_audit text; sha_backups text; sha_req text;
begin
 select p.branch_id,coalesce(nullif(p.full_name,''),p.email) into actor_branch,actor_name
 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='Administrator';
 if auth.uid() is null or actor_branch is null then raise exception 'Hanya Administrator aktif yang dapat menghapus cabang';end if;
 if p_plan_id is null or p_branch_id is null or p_branch_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then raise exception 'Identitas rencana atau kode cabang tidak valid';end if;

 -- Lock in consistent order
 perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global',0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));

 if p_action in ('export','export:manifest','export:operational','export:audit','export:backups','export:requests','finish','cancel') then
  select * into plan from wms_private.branch_deletion_plans where id=p_plan_id and branch_id=p_branch_id and actor_id=auth.uid() for update;
  if plan.id is null then raise exception 'Rencana penghapusan tidak ditemukan';end if;
  if p_action='finish' and plan.status='COMPLETED' then return jsonb_build_object('completed',true,'summary',plan.summary);end if;
  if plan.status<>'PREPARED' or plan.expires_at<=now() then raise exception 'Rencana penghapusan sudah kedaluwarsa atau dibatalkan';end if;
  
  if p_action in ('export','export:manifest','export:operational','export:audit','export:backups','export:requests') then
   if plan.summary->>'is_multi_part'='true' then
    if p_action='export:operational' then
     raw_op := wms_private.branch_part_operational(p_branch_id)::text;
     sha_op := encode(extensions.digest(raw_op,'sha256'),'hex');
     -- Update recorded hash in summary
     update wms_private.branch_deletion_plans
     set summary = jsonb_set(summary, '{parts,0,sha256}', to_jsonb(sha_op))
     where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_PART',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'part','operational',
      'sha256',sha_op,
      'payload_text',raw_op
     );
    elsif p_action='export:audit' then
     raw_audit := wms_private.branch_part_audit(p_branch_id)::text;
     sha_audit := encode(extensions.digest(raw_audit,'sha256'),'hex');
     update wms_private.branch_deletion_plans
     set summary = jsonb_set(summary, '{parts,1,sha256}', to_jsonb(sha_audit))
     where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_PART',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'part','audit',
      'sha256',sha_audit,
      'payload_text',raw_audit
     );
    elsif p_action='export:backups' then
     raw_backups := wms_private.branch_part_backups(p_branch_id)::text;
     sha_backups := encode(extensions.digest(raw_backups,'sha256'),'hex');
     update wms_private.branch_deletion_plans
     set summary = jsonb_set(summary, '{parts,2,sha256}', to_jsonb(sha_backups))
     where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_PART',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'part','backups',
      'sha256',sha_backups,
      'payload_text',raw_backups
     );
    elsif p_action='export:requests' then
     raw_req := wms_private.branch_part_requests(p_branch_id)::text;
     sha_req := encode(extensions.digest(raw_req,'sha256'),'hex');
     update wms_private.branch_deletion_plans
     set summary = jsonb_set(summary, '{parts,3,sha256}', to_jsonb(sha_req))
     where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_PART',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'part','requests',
      'sha256',sha_req,
      'payload_text',raw_req
     );
    else
     -- export:manifest
     select * into plan from wms_private.branch_deletion_plans where id=p_plan_id;
     sha_op := coalesce(plan.summary->'parts'->0->>'sha256','');
     sha_audit := coalesce(plan.summary->'parts'->1->>'sha256','');
     sha_backups := coalesce(plan.summary->'parts'->2->>'sha256','');
     sha_req := coalesce(plan.summary->'parts'->3->>'sha256','');
     digest := encode(extensions.digest(plan.id::text||sha_op||sha_audit||sha_backups||sha_req,'sha256'),'hex');
     update wms_private.branch_deletion_plans set sha256 = digest where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_MULTI_BACKUP',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'created_at',plan.created_at,
      'sha256',digest,
      'parts',plan.summary->'parts',
      'summary',plan.summary
     );
    end if;
   else
    return jsonb_build_object('format','BLUES_WMS_BACKUP','version',1,'backup_id',plan.id,'branch_id',plan.branch_id,'created_at',plan.created_at,'sha256',plan.sha256,'payload_text',plan.payload_text);
   end if;
  elsif p_action='cancel' then
   update wms_private.branch_deletion_plans set status='CANCELLED',payload_text=null where id=plan.id;
   return jsonb_build_object('cancelled',true);
  end if;
 elsif p_action<>'prepare' then raise exception 'Aksi penghapusan tidak dikenal';end if;

 -- Validasi kelayakan cabang
 select * into branch_row from public.branches where id=p_branch_id for update;
 if branch_row.id is null then raise exception 'Cabang tidak ditemukan';end if;
 select count(*) into remaining from public.branches;
 if remaining<=1 then raise exception 'Cabang terakhir tidak dapat dihapus';end if;
 if actor_branch=p_branch_id or exists(select 1 from public.profiles where branch_id=p_branch_id) then raise exception 'Pindahkan seluruh akun cabang terlebih dahulu';end if;
 if exists(select 1 from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and coalesce(payload->>'status','Pending') not in ('Completed','Cancelled')) then raise exception 'Selesaikan atau batalkan seluruh order aktif terlebih dahulu';end if;
 if exists(select 1 from public.branch_transfers where source_branch=p_branch_id or destination_branch=p_branch_id) then raise exception 'Cabang memiliki riwayat transfer lintas cabang yang perlu ditangani sebelum penghapusan';end if;
 if exists(select 1 from public.branch_backups where branch_id=p_branch_id and storage_status='LOCAL') then
  raise exception 'Backup lokal lama harus diverifikasi sebelum penghapusan dapat diproses';
 end if;

 if p_action='prepare' then
  delete from wms_private.branch_deletion_plans where branch_id=p_branch_id and status='PREPARED';
  delete from wms_private.branch_deletion_plans where status='PREPARED' and expires_at<=now();
  
  -- Fast row counts using indexes (instant, no timeout)
  select count(*) into count_docs from public.wms_documents where branch_id=p_branch_id;
  select count(*) into count_orders from public.wms_documents where branch_id=p_branch_id and collection_name='orders';
  select count(*) into count_stock from public.wms_documents where branch_id=p_branch_id and collection_name='stock' and left(document_id,7)<>'SYSTEM_';
  select coalesce(sum((payload->>'qty')::numeric),0) into stock_qty from public.wms_documents where branch_id=p_branch_id and collection_name='stock' and left(document_id,7)<>'SYSTEM_';
  select count(*) into count_movements from public.stock_movements where branch_id=p_branch_id;
  select count(*) into count_audit from public.activity_events where branch_id=p_branch_id;
  select count(*) into count_backups from public.branch_backups where branch_id=p_branch_id;
  select count(*) into local_backups from public.branch_backups where branch_id=p_branch_id and storage_status='LOCAL';
  select count(*) into count_req from wms_private.write_requests where branch_id=p_branch_id;

  snapshot := wms_private.branch_deletion_snapshot(p_branch_id);
  raw := snapshot::text;
  digest := encode(extensions.digest(raw,'sha256'),'hex');

  summary := jsonb_build_object(
   'is_multi_part', false,
   'documents', count_docs,
   'orders', count_orders,
   'stock_rows', count_stock,
   'stock_qty', stock_qty,
   'movements', count_movements,
   'audit_events', count_audit,
   'cloud_and_local_backups', count_backups,
   'previously_local_backups', local_backups
  );

  insert into wms_private.branch_deletion_plans(id,branch_id,actor_id,sha256,payload_text,summary,expires_at)
  values(p_plan_id,p_branch_id,auth.uid(),digest,raw,summary,now()+interval '30 minutes') returning * into plan;

  return jsonb_build_object('plan_id',plan.id,'sha256',plan.sha256,'is_multi_part',false,'summary',plan.summary,'expires_at',plan.expires_at);
 end if;

 -- Aksi Finish
 if not wms_private.recent_password_auth() then raise exception 'Masuk ulang dengan password sebelum konfirmasi';end if;
 if p_confirmation is distinct from 'HAPUS '||p_branch_id or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Ketik konfirmasi cabang dan alasan 10–1000 karakter';end if;

 if plan.summary->>'is_multi_part'='true' then
  if jsonb_typeof(p_file) is distinct from 'object'
     or p_file->>'format' is distinct from 'BLUES_WMS_MULTI_BACKUP'
     or p_file->>'version' is distinct from '1'
     or p_file->>'backup_id' is distinct from plan.id::text
     or p_file->>'branch_id' is distinct from p_branch_id
     or p_file->>'sha256' is distinct from plan.sha256 then
   raise exception 'File manifest backup tidak cocok dengan rencana';
  end if;

  raw_op := wms_private.branch_part_operational(p_branch_id)::text;
  raw_audit := wms_private.branch_part_audit(p_branch_id)::text;
  raw_backups := wms_private.branch_part_backups(p_branch_id)::text;
  raw_req := wms_private.branch_part_requests(p_branch_id)::text;

  sha_op := encode(extensions.digest(raw_op,'sha256'),'hex');
  sha_audit := encode(extensions.digest(raw_audit,'sha256'),'hex');
  sha_backups := encode(extensions.digest(raw_backups,'sha256'),'hex');
  sha_req := encode(extensions.digest(raw_req,'sha256'),'hex');

  digest := encode(extensions.digest(plan.id::text||sha_op||sha_audit||sha_backups||sha_req,'sha256'),'hex');
  if digest is distinct from plan.sha256 then
   raise exception 'Data cabang berubah setelah backup disiapkan. Siapkan dan unduh ulang backup';
  end if;
 else
  if jsonb_typeof(p_file) is distinct from 'object'
     or p_file->>'format' is distinct from 'BLUES_WMS_BACKUP'
     or p_file->>'version' is distinct from '1'
     or p_file->>'backup_id' is distinct from plan.id::text
     or p_file->>'branch_id' is distinct from p_branch_id
     or p_file->>'sha256' is distinct from plan.sha256
     or p_file->>'payload_text' is distinct from plan.payload_text then
   raise exception 'File backup tidak cocok dengan rencana';
  end if;
  if encode(extensions.digest(p_file->>'payload_text','sha256'),'hex') is distinct from plan.sha256 then
   raise exception 'Checksum file backup tidak cocok';
  end if;
  snapshot := wms_private.branch_deletion_snapshot(p_branch_id);
  if encode(extensions.digest(snapshot::text,'sha256'),'hex') is distinct from plan.sha256 then
   raise exception 'Data cabang berubah setelah backup. Siapkan dan unduh ulang backup';
  end if;
 end if;

 -- Eksekusi Penghapusan
 perform set_config('wms.operation_type','PERIOD_ARCHIVE',true);
 perform set_config('wms.operation_id',plan.id::text,true);
 perform set_config('wms.reason',trim(p_reason),true);

 delete from public.wms_documents where branch_id=p_branch_id;
 delete from wms_private.period_archives where branch_id=p_branch_id;
 delete from wms_private.stock_purge_plans where branch_id=p_branch_id;
 delete from wms_private.backup_payloads p using public.branch_backups b where p.id=b.id and b.branch_id=p_branch_id;
 delete from public.branch_backups where branch_id=p_branch_id;
 delete from wms_private.write_requests where branch_id=p_branch_id;
 delete from public.stock_movements where branch_id=p_branch_id;
 delete from public.activity_events where branch_id=p_branch_id;
 delete from public.branches where id=p_branch_id;

 update wms_private.branch_deletion_plans set status=case when id=plan.id then 'COMPLETED' else 'CANCELLED' end,payload_text=null,completed_at=case when id=plan.id then now() else completed_at end where branch_id=p_branch_id and status='PREPARED';
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,reason,operation_id)
 values(actor_branch,'branches',p_branch_id,'BRANCH_DELETED',auth.uid(),actor_name,plan.summary||jsonb_build_object('backup_sha256',plan.sha256),trim(p_reason),plan.id::text);
 
 return jsonb_build_object('completed',true,'summary',plan.summary);
end;
$$;
revoke all on function wms_private.branch_deletion_action(text,text,uuid,text,text,jsonb) from public, anon;
grant execute on function wms_private.branch_deletion_action(text,text,uuid,text,text,jsonb) to authenticated;

create or replace function public.branch_deletion_action(p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text default '',p_reason text default '',p_file jsonb default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout = '120s' as $$
begin
 return wms_private.branch_deletion_action(p_action,p_branch_id,p_plan_id,p_confirmation,p_reason,p_file);
end;
$$;
revoke all on function public.branch_deletion_action(text,text,uuid,text,text,jsonb) from public, anon;
grant execute on function public.branch_deletion_action(text,text,uuid,text,text,jsonb) to authenticated;

-- Recovery procedure
create or replace function wms_private.restore_deleted_branch(
 p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout = '120s' as $$
declare plan wms_private.branch_deletion_plans%rowtype; data jsonb; raw text;
 actor_branch text; actor_name text;
begin
 select branch_id,coalesce(nullif(full_name,''),email) into actor_branch,actor_name
 from public.profiles where id=auth.uid() and is_active and role='Administrator';
 if auth.uid() is null or actor_branch is null then raise exception 'Hanya Administrator aktif yang dapat memulihkan cabang';end if;
 if not wms_private.recent_password_auth() then raise exception 'Masuk ulang dengan password sebelum pemulihan';end if;
 if p_confirmation is distinct from 'PULIHKAN '||p_branch_id or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Konfirmasi dan alasan pemulihan tidak valid';end if;
 perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global',0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 select * into plan from wms_private.branch_deletion_plans where id=p_plan_id and branch_id=p_branch_id and actor_id=auth.uid() for update;
 if plan.id is null or plan.status not in ('COMPLETED','RESTORED') then raise exception 'Bukti penghapusan tidak ditemukan';end if;
 raw=p_file->>'payload_text';
 if jsonb_typeof(p_file) is distinct from 'object' or p_file->>'format' not in ('BLUES_WMS_BACKUP','BLUES_WMS_MULTI_BACKUP')
  or p_file->>'version' is distinct from '1' or p_file->>'backup_id' is distinct from plan.id::text
  or p_file->>'branch_id' is distinct from p_branch_id or p_file->>'sha256' is distinct from plan.sha256 then
  raise exception 'File backup tidak cocok atau rusak';
 end if;
 if plan.status='RESTORED' then return jsonb_build_object('restored',true,'summary',plan.summary);end if;
 if raw is null then
  raise exception 'Pemulihan dari arsip multi-part memerlukan payload data operasional';
 end if;
 data=raw::jsonb;
 if data->'branch'->>'id' is distinct from p_branch_id or jsonb_array_length(data->'operators')<>0 or jsonb_array_length(data->'transfers')<>0 then raise exception 'Isi backup tidak dapat dipulihkan otomatis';end if;
 if exists(select 1 from public.branches where id=p_branch_id) then raise exception 'Kode cabang sudah digunakan';end if;

 insert into wms_private.branch_restore_documents(plan_id,branch_id,collection_name,document_id,payload)
 select plan.id,p_branch_id,j.value->>'collection_name',j.value->>'document_id',j.value->'payload'
 from jsonb_array_elements(data->'documents') j;
 perform set_config('wms.restore_operation_id',plan.id::text,true);
 insert into public.branches select (jsonb_populate_record(null::public.branches,data->'branch')).*;
 insert into public.wms_documents select (jsonb_populate_record(null::public.wms_documents,j.value)).* from jsonb_array_elements(data->'documents') j;
 perform set_config('wms.restore_operation_id','',true);
 delete from wms_private.branch_restore_documents where plan_id=plan.id;
 if exists(select 1 from jsonb_array_elements(data->'documents') j
   left join public.wms_documents d on d.branch_id=p_branch_id
    and d.collection_name=j.value->>'collection_name' and d.document_id=j.value->>'document_id'
   where d.payload is distinct from j.value->'payload') then
  raise exception 'Pemulihan dibatalkan karena trigger mengubah isi dokumen backup';
 end if;
 delete from public.stock_movements where branch_id=p_branch_id;
 delete from public.activity_events where branch_id=p_branch_id;
 insert into public.stock_movements overriding system value select (jsonb_populate_record(null::public.stock_movements,j.value)).* from jsonb_array_elements(data->'stock_movements') j;
 insert into public.activity_events overriding system value select (jsonb_populate_record(null::public.activity_events,j.value)).* from jsonb_array_elements(data->'activity_events') j;
 insert into public.branch_backups select (jsonb_populate_record(null::public.branch_backups,j.value->'metadata')).* from jsonb_array_elements(data->'backups') j;
 insert into wms_private.backup_payloads(id,payload_text) select (j.value->'metadata'->>'id')::uuid,j.value->>'payload_text' from jsonb_array_elements(data->'backups') j where j.value->>'payload_text' is not null;
 insert into wms_private.period_archives select (jsonb_populate_record(null::wms_private.period_archives,case when j.value->>'status'='PREPARED' then jsonb_set(j.value,'{status}','"CANCELLED"') else j.value end)).* from jsonb_array_elements(data->'period_archives') j;
 insert into wms_private.stock_purge_plans select (jsonb_populate_record(null::wms_private.stock_purge_plans,case when j.value->>'status'='PREPARED' then jsonb_set(j.value,'{status}','"CANCELLED"') else j.value end)).* from jsonb_array_elements(data->'stock_purge_plans') j;
 update wms_private.branch_deletion_plans set status='RESTORED' where id=plan.id;
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id)
 values(actor_branch,'branches',p_branch_id,'BRANCH_RESTORED',auth.uid(),actor_name,plan.summary||jsonb_build_object('backup_sha256',plan.sha256),trim(p_reason),plan.id::text);
 return jsonb_build_object('restored',true,'summary',plan.summary);
end;$$;
revoke all on function wms_private.restore_deleted_branch(text,uuid,text,text,jsonb) from public,anon;
grant execute on function wms_private.restore_deleted_branch(text,uuid,text,text,jsonb) to authenticated;
create or replace function public.restore_deleted_branch(p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout = '120s' as $$
begin
 return wms_private.restore_deleted_branch(p_branch_id,p_plan_id,p_confirmation,p_reason,p_file);
end;
$$;
revoke all on function public.restore_deleted_branch(text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.restore_deleted_branch(text,uuid,text,text,jsonb) to authenticated;
-- <<< 20261112175307_permanent_branch_deletion.sql

-- >>> 20261112180208_revoke_rls_auto_enable_execute.sql
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$$;
-- <<< 20261112180208_revoke_rls_auto_enable_execute.sql

-- >>> 20261112235800_optimize_rls_and_foreign_key_indexes.sql
-- Cache request-scoped helper results once per statement and merge equivalent
-- permissive SELECT policies. The resulting access rules are unchanged.
alter policy profiles_read_own_or_admin on public.profiles
using (
  id = (select auth.uid())
  or (select wms_private.is_hq())
  or (
    (select public.wms_is_admin())
    and wms_private.can_access_branch(branch_id)
  )
);

alter policy branches_read on public.branches
using (
  wms_private.can_access_branch(id)
  or (select wms_private.is_inventory_viewer())
);
drop policy if exists branches_inventory_viewer_read on public.branches;

alter policy wms_documents_read_authenticated on public.wms_documents
using (
  wms_private.can_access_branch(branch_id)
  or (
    collection_name = any (array['stock'::text, 'warehouses'::text, 'catalog'::text])
    and (select wms_private.is_inventory_viewer())
  )
);
drop policy if exists documents_inventory_viewer_read on public.wms_documents;

alter policy wms_documents_insert_operator on public.wms_documents
with check (
  (select public.wms_can_operate())
  and wms_private.can_access_branch(branch_id)
);
alter policy wms_documents_update_operator on public.wms_documents
using (
  (select public.wms_can_operate())
  and wms_private.can_access_branch(branch_id)
)
with check (
  (select public.wms_can_operate())
  and wms_private.can_access_branch(branch_id)
);
alter policy wms_documents_delete_operator on public.wms_documents
using (
  (select public.wms_can_operate())
  and wms_private.can_access_branch(branch_id)
);

-- Cover every foreign key reported by the database advisor. These indexes also
-- reduce lock duration when referenced profile, branch, or backup rows change.
create index if not exists activity_events_actor_id_idx
  on public.activity_events(actor_id);
create index if not exists branch_backups_created_by_idx
  on public.branch_backups(created_by);
create index if not exists branch_transfers_created_by_idx
  on public.branch_transfers(created_by);
create index if not exists stock_movements_actor_id_idx
  on public.stock_movements(actor_id);
create index if not exists wms_documents_updated_by_idx
  on public.wms_documents(updated_by);

create index if not exists period_archives_actor_id_idx
  on wms_private.period_archives(actor_id);
create index if not exists period_archives_backup_id_idx
  on wms_private.period_archives(backup_id);
create index if not exists period_archives_branch_id_idx
  on wms_private.period_archives(branch_id);

create index if not exists stock_purge_plans_actor_id_idx
  on wms_private.stock_purge_plans(actor_id);
create index if not exists stock_purge_plans_backup_id_idx
  on wms_private.stock_purge_plans(backup_id);
create index if not exists stock_purge_plans_branch_id_idx
  on wms_private.stock_purge_plans(branch_id);
-- <<< 20261112235800_optimize_rls_and_foreign_key_indexes.sql

-- >>> 20261113000453_lossless_multipart_branch_backup.sql
-- Lossless multipart branch deletion backup.
-- Every row removed by the workflow is represented in one of four immutable
-- recovery parts. Parts remain private and are retained after deletion so a
-- verified manifest can restore the branch transactionally.

create table if not exists wms_private.branch_deletion_parts (
  plan_id uuid not null references wms_private.branch_deletion_plans(id) on delete cascade,
  part_name text not null check (part_name in ('operational','audit','backups','requests')),
  ordinal smallint not null check (ordinal between 1 and 4),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  payload_text text not null,
  exported_at timestamptz not null default now(),
  primary key (plan_id, part_name),
  unique (plan_id, ordinal)
);
alter table wms_private.branch_deletion_parts enable row level security;
revoke all on table wms_private.branch_deletion_parts from public, anon, authenticated;

alter table wms_private.branch_restore_documents
  add column if not exists row_data jsonb;

create or replace function wms_private.restore_document_payload() returns trigger
language plpgsql set search_path='' as $$
declare restored jsonb; restore_id text=current_setting('wms.restore_operation_id',true);
begin
 if current_user='postgres' and nullif(restore_id,'') is not null then
  select coalesce(row_data,jsonb_build_object('payload',payload)) into restored
  from wms_private.branch_restore_documents
  where plan_id::text=restore_id and branch_id=new.branch_id
   and collection_name=new.collection_name and document_id=new.document_id;
  if found then new=jsonb_populate_record(new,restored);end if;
 end if;
 return new;
end;$$;
revoke all on function wms_private.restore_document_payload() from public,anon,authenticated;

create or replace function wms_private.branch_part_operational(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'branch',(select to_jsonb(b) from public.branches b where b.id=p_branch),
   'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by d.collection_name,d.document_id),'[]'::jsonb) from public.wms_documents d where d.branch_id=p_branch),
   'transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from public.branch_transfers t where t.source_branch=p_branch or t.destination_branch=p_branch),
   'operators',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.profiles p where p.branch_id=p_branch),
   'stock_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from public.stock_movements m where m.branch_id=p_branch)
 );
$$;

create or replace function wms_private.branch_part_audit(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'activity_events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.activity_events e where e.branch_id=p_branch)
 );
$$;

create or replace function wms_private.branch_part_backups(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'backups',(
     select coalesce(jsonb_agg(
       jsonb_build_object('metadata',to_jsonb(b),'payload_text',p.payload_text)
       order by b.id
     ),'[]'::jsonb)
     from public.branch_backups b
     left join wms_private.backup_payloads p on p.id=b.id
     where b.branch_id=p_branch
   )
 );
$$;

create or replace function wms_private.branch_part_requests(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'write_requests',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from wms_private.write_requests r where r.branch_id=p_branch),
   'period_archives',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from wms_private.period_archives a where a.branch_id=p_branch),
   'stock_purge_plans',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) from wms_private.stock_purge_plans s where s.branch_id=p_branch)
 );
$$;

revoke all on function wms_private.branch_part_operational(text) from public,anon,authenticated;
revoke all on function wms_private.branch_part_audit(text) from public,anon,authenticated;
revoke all on function wms_private.branch_part_backups(text) from public,anon,authenticated;
revoke all on function wms_private.branch_part_requests(text) from public,anon,authenticated;

create or replace function wms_private.branch_deletion_action_v2(
 p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='180s' as $$
declare
 plan wms_private.branch_deletion_plans%rowtype;
 actor_branch text; actor_name text; branch_row public.branches%rowtype;
 raw text; digest text; part text; ord smallint; plan_summary jsonb; parts jsonb;
 remaining integer; local_backups integer; expected_count integer;
 count_docs bigint; count_orders bigint; count_stock bigint; stock_qty numeric;
 count_movements bigint; count_audit bigint; count_backups bigint; count_req bigint;
 stored_sha text; current_sha text; all_hashes text;
begin
 select p.branch_id,coalesce(nullif(p.full_name,''),p.email) into actor_branch,actor_name
 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='Administrator';
 if auth.uid() is null or actor_branch is null or not wms_private.is_hq() then raise exception 'Hanya Administrator aktif kantor pusat yang dapat menghapus cabang';end if;
 if p_plan_id is null or p_branch_id is null or p_branch_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then raise exception 'Identitas rencana atau kode cabang tidak valid';end if;

 perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global',0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));

 if p_action='prepare' then
  select * into branch_row from public.branches where id=p_branch_id for update;
  if branch_row.id is null then raise exception 'Cabang tidak ditemukan';end if;
  select count(*) into remaining from public.branches;
  if remaining<=1 then raise exception 'Cabang terakhir tidak dapat dihapus';end if;
  if actor_branch=p_branch_id or exists(select 1 from public.profiles where branch_id=p_branch_id) then raise exception 'Pindahkan seluruh akun cabang terlebih dahulu';end if;
  if exists(select 1 from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and coalesce(payload->>'status','Pending') not in ('Completed','Cancelled')) then raise exception 'Selesaikan atau batalkan seluruh order aktif terlebih dahulu';end if;
  if exists(select 1 from public.branch_transfers where source_branch=p_branch_id or destination_branch=p_branch_id) then raise exception 'Cabang memiliki riwayat transfer lintas cabang yang perlu ditangani sebelum penghapusan';end if;
  if exists(select 1 from public.branch_backups where branch_id=p_branch_id and storage_status='LOCAL') then raise exception 'Backup lokal lama harus diverifikasi sebelum penghapusan dapat diproses';end if;

  update wms_private.branch_deletion_plans set status='CANCELLED',payload_text=null
  where branch_id=p_branch_id and status='PREPARED';
  delete from wms_private.branch_deletion_plans where status='PREPARED' and expires_at<=now();

  select count(*) into count_docs from public.wms_documents where branch_id=p_branch_id;
  select count(*) into count_orders from public.wms_documents where branch_id=p_branch_id and collection_name='orders';
  select count(*) into count_stock from public.wms_documents where branch_id=p_branch_id and collection_name='stock' and left(document_id,7)<>'SYSTEM_';
  select coalesce(sum((payload->>'qty')::numeric),0) into stock_qty from public.wms_documents where branch_id=p_branch_id and collection_name='stock' and left(document_id,7)<>'SYSTEM_';
  select count(*) into count_movements from public.stock_movements where branch_id=p_branch_id;
  select count(*) into count_audit from public.activity_events where branch_id=p_branch_id;
  select count(*) into count_backups from public.branch_backups where branch_id=p_branch_id;
  select count(*) into local_backups from public.branch_backups where branch_id=p_branch_id and storage_status='LOCAL';
  select count(*) into count_req from wms_private.write_requests where branch_id=p_branch_id;

  parts=jsonb_build_array(
   jsonb_build_object('part','operational','label','Data operasional','filename','operational.json','sha256','','bytes',0),
   jsonb_build_object('part','audit','label','Riwayat audit','filename','audit.json','sha256','','bytes',0),
   jsonb_build_object('part','backups','label','Backup historis','filename','backups.json','sha256','','bytes',0),
   jsonb_build_object('part','requests','label','Request dan arsip','filename','requests.json','sha256','','bytes',0)
  );
  plan_summary=jsonb_build_object('is_multi_part',true,'format_version',2,'documents',count_docs,'orders',count_orders,
   'stock_rows',count_stock,'stock_qty',stock_qty,'movements',count_movements,'audit_events',count_audit,
   'cloud_and_local_backups',count_backups,'previously_local_backups',local_backups,'write_requests',count_req,'parts',parts);
  insert into wms_private.branch_deletion_plans(id,branch_id,actor_id,sha256,payload_text,summary,expires_at)
  values(p_plan_id,p_branch_id,auth.uid(),repeat('0',64),null,plan_summary,now()+interval '60 minutes') returning * into plan;
  return jsonb_build_object('plan_id',plan.id,'sha256',plan.sha256,'is_multi_part',true,'parts',parts,'summary',plan_summary,'expires_at',plan.expires_at);
 end if;

 select * into plan from wms_private.branch_deletion_plans
 where id=p_plan_id and branch_id=p_branch_id and actor_id=auth.uid() for update;
 if plan.id is null then raise exception 'Rencana penghapusan tidak ditemukan';end if;
 if p_action='finish' and plan.status='COMPLETED' then return jsonb_build_object('completed',true,'summary',plan.summary);end if;
 if p_action='cancel' then
  if plan.status='PREPARED' then update wms_private.branch_deletion_plans set status='CANCELLED',payload_text=null where id=plan.id;end if;
  return jsonb_build_object('cancelled',true);
 end if;
 if plan.status<>'PREPARED' or plan.expires_at<=now() then raise exception 'Rencana penghapusan sudah kedaluwarsa atau dibatalkan';end if;

 if p_action like 'export:%' and p_action<>'export:manifest' then
  part=substr(p_action,8);
  if part='operational' then raw=wms_private.branch_part_operational(p_branch_id)::text;ord=1;
  elsif part='audit' then raw=wms_private.branch_part_audit(p_branch_id)::text;ord=2;
  elsif part='backups' then raw=wms_private.branch_part_backups(p_branch_id)::text;ord=3;
  elsif part='requests' then raw=wms_private.branch_part_requests(p_branch_id)::text;ord=4;
  else raise exception 'Bagian backup tidak dikenal';end if;
  digest=encode(extensions.digest(raw,'sha256'),'hex');
  insert into wms_private.branch_deletion_parts(plan_id,part_name,ordinal,sha256,payload_text)
  values(plan.id,part,ord,digest,raw)
  on conflict(plan_id,part_name) do update set ordinal=excluded.ordinal,sha256=excluded.sha256,payload_text=excluded.payload_text,exported_at=now();
  return jsonb_build_object('format','BLUES_WMS_PART','version',2,'backup_id',plan.id,'branch_id',plan.branch_id,
   'part',part,'sha256',digest,'bytes',octet_length(raw),'payload_text',raw);
 end if;

 if p_action in ('export','export:manifest') then
  select count(*),string_agg(sha256,'' order by ordinal) into expected_count,all_hashes
  from wms_private.branch_deletion_parts where plan_id=plan.id;
  if expected_count<>4 then raise exception 'Unduh keempat bagian backup sebelum membuat manifest';end if;
  digest=encode(extensions.digest(plan.id::text||all_hashes,'sha256'),'hex');
  select jsonb_agg(jsonb_build_object('part',d.part_name,'label',case d.part_name when 'operational' then 'Data operasional' when 'audit' then 'Riwayat audit' when 'backups' then 'Backup historis' else 'Request dan arsip' end,
    'filename',d.part_name||'.json','sha256',d.sha256,'bytes',octet_length(d.payload_text)) order by d.ordinal)
  into parts from wms_private.branch_deletion_parts d where d.plan_id=plan.id;
  plan_summary=jsonb_set(plan.summary,'{parts}',parts);
  update wms_private.branch_deletion_plans d set sha256=digest,summary=plan_summary where d.id=plan.id returning * into plan;
  return jsonb_build_object('format','BLUES_WMS_MULTI_BACKUP','version',2,'backup_id',plan.id,'branch_id',plan.branch_id,
   'created_at',plan.created_at,'sha256',digest,'parts',parts,'summary',plan_summary);
 end if;

 if p_action<>'finish' then raise exception 'Aksi penghapusan tidak dikenal';end if;
 if not wms_private.recent_password_auth() then raise exception 'Masuk ulang dengan password sebelum konfirmasi';end if;
 if p_confirmation is distinct from 'HAPUS '||p_branch_id or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Ketik konfirmasi cabang dan alasan 10-1000 karakter';end if;
 if jsonb_typeof(p_file) is distinct from 'object' or p_file->>'format' is distinct from 'BLUES_WMS_MULTI_BACKUP'
   or p_file->>'version' is distinct from '2' or p_file->>'backup_id' is distinct from plan.id::text
   or p_file->>'branch_id' is distinct from p_branch_id or p_file->>'sha256' is distinct from plan.sha256 then
  raise exception 'Manifest backup tidak cocok dengan rencana';
 end if;

 for part,ord in select v.part_name,v.part_ordinal from (values ('operational',1::smallint),('audit',2::smallint),('backups',3::smallint),('requests',4::smallint)) v(part_name,part_ordinal) loop
  select sha256 into stored_sha from wms_private.branch_deletion_parts where plan_id=plan.id and part_name=part;
  if part='operational' then raw=wms_private.branch_part_operational(p_branch_id)::text;
  elsif part='audit' then raw=wms_private.branch_part_audit(p_branch_id)::text;
  elsif part='backups' then raw=wms_private.branch_part_backups(p_branch_id)::text;
  else raw=wms_private.branch_part_requests(p_branch_id)::text;end if;
  current_sha=encode(extensions.digest(raw,'sha256'),'hex');
  if stored_sha is null or current_sha is distinct from stored_sha then raise exception 'Data cabang berubah setelah backup. Unduh ulang seluruh bagian';end if;
 end loop;
 select string_agg(sha256,'' order by ordinal) into all_hashes from wms_private.branch_deletion_parts where plan_id=plan.id;
 if encode(extensions.digest(plan.id::text||all_hashes,'sha256'),'hex') is distinct from plan.sha256 then raise exception 'Checksum manifest tidak cocok';end if;

 perform set_config('wms.operation_type','PERIOD_ARCHIVE',true);
 perform set_config('wms.operation_id',plan.id::text,true);
 perform set_config('wms.reason',trim(p_reason),true);
 delete from public.wms_documents where branch_id=p_branch_id;
 delete from wms_private.period_archives where branch_id=p_branch_id;
 delete from wms_private.stock_purge_plans where branch_id=p_branch_id;
 delete from wms_private.backup_payloads p using public.branch_backups b where p.id=b.id and b.branch_id=p_branch_id;
 delete from public.branch_backups where branch_id=p_branch_id;
 delete from wms_private.write_requests where branch_id=p_branch_id;
 delete from public.stock_movements where branch_id=p_branch_id;
 delete from public.activity_events where branch_id=p_branch_id;
 delete from public.branches where id=p_branch_id;
 update wms_private.branch_deletion_plans set status='COMPLETED',payload_text=null,completed_at=now() where id=plan.id;
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,reason,operation_id)
 values(actor_branch,'branches',p_branch_id,'BRANCH_DELETED',auth.uid(),actor_name,plan.summary||jsonb_build_object('backup_sha256',plan.sha256),trim(p_reason),plan.id::text);
 return jsonb_build_object('completed',true,'summary',plan.summary);
end;
$$;
revoke all on function wms_private.branch_deletion_action_v2(text,text,uuid,text,text,jsonb) from public,anon,authenticated;

create or replace function public.branch_deletion_action(p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text default '',p_reason text default '',p_file jsonb default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='180s' as $$
begin return wms_private.branch_deletion_action_v2(p_action,p_branch_id,p_plan_id,p_confirmation,p_reason,p_file);end;
$$;
revoke all on function public.branch_deletion_action(text,text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.branch_deletion_action(text,text,uuid,text,text,jsonb) to authenticated;

create or replace function wms_private.restore_deleted_branch_v2(
 p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='180s' as $$
declare
 plan wms_private.branch_deletion_plans%rowtype; actor_branch text; actor_name text;
 op jsonb;audit_data jsonb;backups_data jsonb;requests_data jsonb;
 raw text;stored_sha text;all_hashes text;digest text;part text;
begin
 select branch_id,coalesce(nullif(full_name,''),email) into actor_branch,actor_name
 from public.profiles where id=auth.uid() and is_active and role='Administrator';
 if auth.uid() is null or actor_branch is null or not wms_private.is_hq() then raise exception 'Hanya Administrator aktif kantor pusat yang dapat memulihkan cabang';end if;
 if not wms_private.recent_password_auth() then raise exception 'Masuk ulang dengan password sebelum pemulihan';end if;
 if p_confirmation is distinct from 'PULIHKAN '||p_branch_id or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Konfirmasi dan alasan pemulihan tidak valid';end if;
 perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global',0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 select * into plan from wms_private.branch_deletion_plans where id=p_plan_id and branch_id=p_branch_id for update;
 if plan.id is null or plan.status not in ('COMPLETED','RESTORED') then raise exception 'Bukti penghapusan tidak ditemukan';end if;
 if plan.status='RESTORED' then return jsonb_build_object('restored',true,'summary',plan.summary);end if;
 if jsonb_typeof(p_file) is distinct from 'object' or p_file->>'format' is distinct from 'BLUES_WMS_MULTI_BACKUP'
   or p_file->>'version' is distinct from '2' or p_file->>'backup_id' is distinct from plan.id::text
   or p_file->>'branch_id' is distinct from p_branch_id or p_file->>'sha256' is distinct from plan.sha256 then raise exception 'Manifest backup tidak cocok atau rusak';end if;
 select string_agg(sha256,'' order by ordinal) into all_hashes from wms_private.branch_deletion_parts where plan_id=plan.id;
 if all_hashes is null or (select count(*) from wms_private.branch_deletion_parts where plan_id=plan.id)<>4
   or encode(extensions.digest(plan.id::text||all_hashes,'sha256'),'hex') is distinct from plan.sha256 then raise exception 'Arsip recovery server tidak lengkap';end if;
 select payload_text::jsonb into op from wms_private.branch_deletion_parts where plan_id=plan.id and part_name='operational';
 select payload_text::jsonb into audit_data from wms_private.branch_deletion_parts where plan_id=plan.id and part_name='audit';
 select payload_text::jsonb into backups_data from wms_private.branch_deletion_parts where plan_id=plan.id and part_name='backups';
 select payload_text::jsonb into requests_data from wms_private.branch_deletion_parts where plan_id=plan.id and part_name='requests';
 if op->'branch'->>'id' is distinct from p_branch_id or jsonb_array_length(op->'operators')<>0 or jsonb_array_length(op->'transfers')<>0 then raise exception 'Isi backup tidak dapat dipulihkan otomatis';end if;
 if exists(select 1 from public.branches where id=p_branch_id) then raise exception 'Kode cabang sudah digunakan';end if;

 insert into wms_private.branch_restore_documents(plan_id,branch_id,collection_name,document_id,payload,row_data)
 select plan.id,p_branch_id,j.value->>'collection_name',j.value->>'document_id',j.value->'payload',j.value from jsonb_array_elements(op->'documents') j;
 perform set_config('wms.restore_operation_id',plan.id::text,true);
 insert into public.branches select (jsonb_populate_record(null::public.branches,op->'branch')).*;
 insert into public.wms_documents select (jsonb_populate_record(null::public.wms_documents,j.value)).* from jsonb_array_elements(op->'documents') j;
 perform set_config('wms.restore_operation_id','',true);
 delete from wms_private.branch_restore_documents where plan_id=plan.id;
 if exists(select 1 from jsonb_array_elements(op->'documents') j left join public.wms_documents d on d.branch_id=p_branch_id and d.collection_name=j.value->>'collection_name' and d.document_id=j.value->>'document_id' where d.payload is distinct from j.value->'payload') then raise exception 'Pemulihan dibatalkan karena trigger mengubah isi dokumen backup';end if;
 delete from public.stock_movements where branch_id=p_branch_id;
 delete from public.activity_events where branch_id=p_branch_id;
 insert into public.stock_movements overriding system value select (jsonb_populate_record(null::public.stock_movements,j.value)).* from jsonb_array_elements(op->'stock_movements') j;
 insert into public.activity_events overriding system value select (jsonb_populate_record(null::public.activity_events,j.value)).* from jsonb_array_elements(audit_data->'activity_events') j;
 insert into public.branch_backups select (jsonb_populate_record(null::public.branch_backups,j.value->'metadata')).* from jsonb_array_elements(backups_data->'backups') j;
 insert into wms_private.backup_payloads(id,payload_text) select (j.value->'metadata'->>'id')::uuid,j.value->>'payload_text' from jsonb_array_elements(backups_data->'backups') j where j.value->>'payload_text' is not null;
 insert into wms_private.write_requests select (jsonb_populate_record(null::wms_private.write_requests,j.value)).* from jsonb_array_elements(requests_data->'write_requests') j;
 insert into wms_private.period_archives select (jsonb_populate_record(null::wms_private.period_archives,j.value)).* from jsonb_array_elements(requests_data->'period_archives') j;
 insert into wms_private.stock_purge_plans select (jsonb_populate_record(null::wms_private.stock_purge_plans,j.value)).* from jsonb_array_elements(requests_data->'stock_purge_plans') j;

 for part in select unnest(array['operational','audit','backups','requests']) loop
  select sha256 into stored_sha from wms_private.branch_deletion_parts where plan_id=plan.id and part_name=part;
  if part='operational' then raw=wms_private.branch_part_operational(p_branch_id)::text;
  elsif part='audit' then raw=wms_private.branch_part_audit(p_branch_id)::text;
  elsif part='backups' then raw=wms_private.branch_part_backups(p_branch_id)::text;
  else raw=wms_private.branch_part_requests(p_branch_id)::text;end if;
  if encode(extensions.digest(raw,'sha256'),'hex') is distinct from stored_sha then raise exception 'Pemulihan tidak identik untuk bagian %',part;end if;
 end loop;
 update wms_private.branch_deletion_plans set status='RESTORED' where id=plan.id;
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id)
 values(actor_branch,'branches',p_branch_id,'BRANCH_RESTORED',auth.uid(),actor_name,plan.summary||jsonb_build_object('backup_sha256',plan.sha256),trim(p_reason),plan.id::text);
 return jsonb_build_object('restored',true,'summary',plan.summary);
end;
$$;
revoke all on function wms_private.restore_deleted_branch_v2(text,uuid,text,text,jsonb) from public,anon,authenticated;

create or replace function public.restore_deleted_branch(p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='180s' as $$
begin return wms_private.restore_deleted_branch_v2(p_branch_id,p_plan_id,p_confirmation,p_reason,p_file);end;
$$;
revoke all on function public.restore_deleted_branch(text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.restore_deleted_branch(text,uuid,text,text,jsonb) to authenticated;

revoke all on function wms_private.branch_deletion_action(text,text,uuid,text,text,jsonb) from public, anon, authenticated;
revoke all on function wms_private.restore_deleted_branch(text,uuid,text,text,jsonb) from public, anon, authenticated;
-- <<< 20261113000453_lossless_multipart_branch_backup.sql

-- >>> 20261114133500_fix_return_qc_regex.sql
create or replace function wms_private.process_return_qc(
  p_request_id uuid,
  p_branch_id text,
  p_case_id text,
  p_decision text,
  p_notes text default ''
) returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor_role text;
  actor_name text;
  decision text=upper(btrim(coalesce(p_decision,'')));
  target_location text;
  target_status text;
  stock_status text;
  ret public.wms_documents%rowtype;
  current_stock public.wms_documents%rowtype;
  stock_id text;
  warehouse_id text;
  qty bigint;
  qty_before bigint;
  qty_after bigint;
  ctn_size bigint;
  inner_size bigint;
  result jsonb='[]'::jsonb;
  case_count integer;
  finalized_count integer;
  log_id text;
begin
  if p_request_id is null or nullif(btrim(p_branch_id),'') is null or nullif(btrim(p_case_id),'') is null then
    raise exception 'Identitas transaksi QC tidak lengkap';
  end if;
  if decision not in ('ACCEPT','QUARANTINE','REJECT') then
    raise exception 'Keputusan QC tidak valid';
  end if;
  select role,coalesce(nullif(btrim(full_name),''),email)
  into actor_role,actor_name
  from public.profiles where id=auth.uid() and is_active;
  if auth.uid() is null or actor_role not in ('Administrator','Admin') or not wms_private.can_access_branch(p_branch_id) then
    raise exception 'QC return hanya untuk admin cabang yang berwenang';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('return-qc:'||p_branch_id||':'||p_case_id,0));
  perform 1 from public.wms_documents
   where branch_id=p_branch_id and collection_name='returns'
     and coalesce(payload->>'caseId',document_id)=p_case_id
   order by document_id for update;

  select count(*),count(*) filter(where payload->>'status' in ('RESTOCKED','KARANTINA','QC_REJECTED'))
  into case_count,finalized_count
  from public.wms_documents
  where branch_id=p_branch_id and collection_name='returns'
    and coalesce(payload->>'caseId',document_id)=p_case_id;
  if case_count=0 then raise exception 'Kasus return tidak ditemukan';end if;
  if finalized_count=case_count then
    if exists(
      select 1 from public.wms_documents
      where branch_id=p_branch_id and collection_name='returns'
        and coalesce(payload->>'caseId',document_id)=p_case_id
        and payload->>'qcDecision' is distinct from decision
    ) then raise exception 'Kasus return sudah diproses dengan keputusan lain';end if;
    return jsonb_build_object('caseId',p_case_id,'decision',decision,'idempotent',true,'items',case_count);
  end if;
  if finalized_count>0 then raise exception 'Status item dalam kasus return tidak konsisten';end if;

  target_location=case decision when 'ACCEPT' then 'TRANSIT' when 'QUARANTINE' then 'KARANTINA' else 'RETURN-REJECTED' end;
  target_status=case decision when 'ACCEPT' then 'RESTOCKED' when 'QUARANTINE' then 'KARANTINA' else 'QC_REJECTED' end;
  stock_status=case when decision='QUARANTINE' then 'Damage' else 'AMAN' end;
  perform set_config('wms.operation_id',p_request_id::text,true);
  perform set_config('wms.operation_type','RETURN_QC',true);
  perform set_config('wms.reason',coalesce(nullif(btrim(p_notes),''),'Keputusan QC return'),true);

  for ret in
    select * from public.wms_documents
    where branch_id=p_branch_id and collection_name='returns'
      and coalesce(payload->>'caseId',document_id)=p_case_id
    order by document_id
  loop
    qty=(ret.payload->>'qty')::bigint;
    if qty is null or qty<=0 then raise exception 'Qty return tidak valid';end if;
    if decision<>'REJECT' then
      warehouse_id=upper(coalesce(nullif(btrim(ret.payload->>'warehouseId'),''),'WH-CENTRAL'));
      stock_id=(case when warehouse_id='WH-CENTRAL' then '' else warehouse_id||'_' end)
        ||upper(btrim(ret.payload->>'skuId'))||'_'
        ||regexp_replace(coalesce(nullif(btrim(ret.payload->>'expiredDate'),''),'No Expired'),'[-/ .\\]','_','g')||'_'
        ||regexp_replace(target_location,'[-/ .\\]','_','g');
      select * into current_stock from public.wms_documents
       where branch_id=p_branch_id and collection_name='stock' and document_id=stock_id for update;
      qty_before=coalesce((current_stock.payload->>'qty')::bigint,0);
      qty_after=qty_before+qty;
      ctn_size=greatest(coalesce((current_stock.payload->>'qtyCtnSize')::bigint,(ret.payload->>'qtyCtnSize')::bigint,144),1);
      inner_size=greatest(coalesce((current_stock.payload->>'qtyInnerSize')::bigint,(ret.payload->>'qtyInnerSize')::bigint,12),1);
      insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
      values(p_branch_id,'stock',stock_id,
        coalesce(current_stock.payload,'{}'::jsonb)||jsonb_build_object(
          'id',stock_id,'skuId',ret.payload->>'skuId','skuName',ret.payload->>'skuName',
          'expiredDate',ret.payload->>'expiredDate','location',target_location,'warehouseId',warehouse_id,
          'qty',qty_after,'qtyCtnSize',ctn_size,'qtyInnerSize',inner_size,
          'qtyCtn',qty_after/ctn_size,'qtyInner',(qty_after%ctn_size)/inner_size,
          'qtyLoose',(qty_after%ctn_size)%inner_size,'status',stock_status
        ),auth.uid())
      on conflict(branch_id,collection_name,document_id) do update
        set payload=excluded.payload,updated_by=auth.uid();
      result=result||jsonb_build_array(jsonb_build_object('returnId',ret.document_id,'stockId',stock_id,'qty',qty));
    end if;
    update public.wms_documents set
      payload=payload||jsonb_strip_nulls(jsonb_build_object(
        'status',target_status,'location',target_location,'qcDecision',decision,'qcNotes',nullif(btrim(p_notes),''),
        'qcBy',actor_name,'qcById',auth.uid(),'qcAt',clock_timestamp(),
        'stockPostedAt',case when decision='REJECT' then null else clock_timestamp() end
      )),updated_by=auth.uid()
    where branch_id=p_branch_id and collection_name='returns' and document_id=ret.document_id;
    log_id='RETURN_QC_'||md5(p_case_id||':'||ret.document_id);
    insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
    values(p_branch_id,'logs',log_id,jsonb_build_object(
      'id',log_id,'timestamp',clock_timestamp(),'type','RETURN_QC','qty',qty,
      'skuId',ret.payload->>'skuId','skuName',ret.payload->>'skuName',
      'locationFrom','RETURN-QC','locationTo',target_location,'user',actor_name,
      'description','QC return '||coalesce(ret.payload->>'returnNumber',p_case_id)||': '||decision
    ),auth.uid()) on conflict(branch_id,collection_name,document_id) do nothing;
  end loop;
  return jsonb_build_object('caseId',p_case_id,'decision',decision,'idempotent',false,'items',case_count,'posted',result);
end;$function$;

grant execute on function wms_private.process_return_qc(uuid,text,text,text,text) to authenticated;

create or replace function public.process_return_qc(
  p_request_id uuid,p_branch_id text,p_case_id text,p_decision text,p_notes text default ''
) returns jsonb language sql security definer set search_path='' as $$
  select wms_private.process_return_qc(p_request_id,p_branch_id,p_case_id,p_decision,p_notes)
$$;

revoke all on function public.process_return_qc(uuid,text,text,text,text) from public,anon;
grant execute on function public.process_return_qc(uuid,text,text,text,text) to authenticated;
-- <<< 20261114133500_fix_return_qc_regex.sql



-- ==============================================================================
-- IZIN PENUH OPERATOR PICKER / PACKER & PENGHAPUSAN RESTRIKSI STOK
-- Jalankan skrip ini langsung di Supabase Dashboard -> SQL Editor -> Run
-- ==============================================================================

-- 1. Izinkan pengambilan stok di seluruh area (tidak ada blokir karantina/buffer)
create or replace function wms_private.stock_pickable(p jsonb) returns boolean language sql immutable set search_path='' as $$
 select true;
$$;

-- 2. Izinkan operator (Picker & Packer) memproses mutasi stok dan order
--    Menghapus error "Operator tidak boleh menambah atau mengganti identitas stok"
--    Menghapus pembatasan hapus dokumen, perubahan alokasi, dan batasan identitas stok
create or replace function wms_private.validate_operational_write(b text,ups jsonb,dels jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare r text; i jsonb; p jsonb; oldp jsonb; c text; q numeric;
begin
 select role into r from public.profiles where id=auth.uid() and is_active;
 if r is null or r not in ('Administrator','Admin','Picker','Packer') then raise exception 'Peran tidak boleh menulis';end if;

 -- Batasi operator hanya pada koleksi operasional (orders, stock, logs, batches)
 for i in select value from jsonb_array_elements(ups||dels) loop
  c=i->>'collection_name';
  if r in ('Picker','Packer') and c not in ('orders','stock','logs','batches') then 
    raise exception 'Peran operator tidak boleh mengubah koleksi %',c;
  end if;
 end loop;

 -- Validasi data dasar stok & order
 for i in select value from jsonb_array_elements(ups) loop
  c=i->>'collection_name';
  select payload into oldp from public.wms_documents where branch_id=b and collection_name=c and document_id=i->>'document_id';
  p=case when coalesce((i->>'merge')::boolean,false) then coalesce(oldp,'{}')||(i->'payload') else i->'payload' end;
  if c='stock' then
   if jsonb_typeof(p->'qty') is distinct from 'number' then raise exception 'Jumlah stok harus angka bulat';end if;
   q=(p->>'qty')::numeric;
   if q<0 or q<>trunc(q) or q>9007199254740991 then raise exception 'Jumlah stok tidak valid';end if;
   if coalesce(trim(p->>'skuId'),'')='' or coalesce(trim(p->>'location'),'')='' then raise exception 'Identitas stok wajib lengkap';end if;
  elsif c='orders' then
   if jsonb_typeof(p->'qty') is distinct from 'number' or (p->>'qty')::numeric<=0 or (p->>'qty')::numeric<>trunc((p->>'qty')::numeric) then raise exception 'Jumlah order harus bilangan bulat positif';end if;
   if coalesce(p->>'status','') not in ('Pending','Completed','Cancelled') then raise exception 'Status order tidak valid';end if;
  end if;
 end loop;
end;$$;

revoke all on function wms_private.stock_pickable(jsonb),wms_private.validate_operational_write(text,jsonb,jsonb) from public,anon,authenticated;



-- Cabang Default
insert into public.branches(id, name) values ('KOL', 'KOL - Gudang Utama') on conflict (id) do nothing;

-- =====================================================================
-- B2B, ONLINE & HYBRID SCHEMA & RPCS
-- =====================================================================

-- B2B, Online, Hybrid Branch Configuration, and Unassigned Order Classification

alter table public.branches
  add column if not exists operation_type text not null default 'HYBRID';

alter table public.branches
  drop constraint if exists branches_operation_type_check;

alter table public.branches
  add constraint branches_operation_type_check
  check (operation_type in ('B2B', 'ONLINE', 'HYBRID'));

update public.branches
set operation_type = 'HYBRID'
where operation_type is null;

-- Expand allowed roles on public.profiles to include Shipping
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
      and pg_get_constraintdef(oid) ilike '%Packer%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('Administrator', 'Admin', 'Picker', 'Packer', 'Shipping', 'Viewer'));

-- Restrictive read policy for Shipping role (orders, warehouses, settings only)
drop policy if exists documents_shipping_read on public.wms_documents;
create policy documents_shipping_read
  on public.wms_documents
  as restrictive
  for select
  to authenticated
  using (
    (select public.wms_current_role()) is distinct from 'Shipping'
    or collection_name in ('orders', 'warehouses', 'settings')
  );

-- Durable Shipping Manifest ledger table
create table if not exists public.shipping_manifests (
  manifest_id text primary key,
  branch_id text not null references public.branches(id) on delete cascade,
  warehouse_id text not null default 'WH-CENTRAL',
  warehouse_name text not null default '',
  order_type text not null check (order_type in ('B2B', 'ONLINE')),
  courier_name text not null,
  sender_name text not null default '',
  driver_name text,
  driver_phone text,
  vehicle_plate text,
  handed_over_by text not null,
  handed_over_by_id uuid references auth.users(id) on delete set null,
  handed_over_at timestamptz not null default now(),
  total_orders integer not null default 0 check (total_orders >= 0),
  total_qty_pcs numeric not null default 0 check (total_qty_pcs >= 0),
  order_references jsonb not null default '[]'::jsonb,
  notes text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELLED')),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists shipping_manifests_branch_created_idx
  on public.shipping_manifests (branch_id, created_at desc);

create index if not exists shipping_manifests_handed_over_by_id_idx
  on public.shipping_manifests (handed_over_by_id);

create index if not exists shipping_manifests_cancelled_by_id_idx
  on public.shipping_manifests (cancelled_by);

alter table public.shipping_manifests enable row level security;
revoke all on public.shipping_manifests from public, anon;
grant select on public.shipping_manifests to authenticated;

drop policy if exists shipping_manifests_read on public.shipping_manifests;
create policy shipping_manifests_read
  on public.shipping_manifests
  for select
  to authenticated
  using (
    (select wms_private.can_access_branch(branch_id))
    and (select public.wms_current_role()) in ('Administrator', 'Admin', 'Shipping', 'Viewer')
  );

-- Save or update branch including operation_type ('B2B', 'ONLINE', 'HYBRID')
create or replace function public.save_branch(
  p_id text,
  p_name text,
  p_operation_type text default 'HYBRID'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_name text;
  v_op text;
  v_actor text;
  v_exists boolean;
  v_row public.branches%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  v_id := upper(trim(coalesce(p_id, '')));
  v_name := trim(coalesce(p_name, ''));
  v_op := upper(trim(coalesce(nullif(p_operation_type, ''), 'HYBRID')));

  if v_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then
    raise exception 'Kode cabang harus 2â€“32 karakter (A-Z, 0-9, -, _).';
  end if;
  if length(v_name) not between 1 and 100 then
    raise exception 'Nama cabang harus 1â€“100 karakter.';
  end if;
  if v_op not in ('B2B', 'ONLINE', 'HYBRID') then
    raise exception 'Tipe operasional cabang harus B2B, ONLINE, atau HYBRID.';
  end if;

  select exists(select 1 from public.branches where id = v_id) into v_exists;

  if not v_exists then
    if not wms_private.is_hq() then
      raise exception 'Hanya Administrator kantor pusat yang dapat membuat cabang baru.';
    end if;
    insert into public.branches (id, name, operation_type)
    values (v_id, v_name, v_op)
    returning * into v_row;
  else
    if not wms_private.is_hq() and not (public.wms_is_admin() and wms_private.can_access_branch(v_id)) then
      raise exception 'Hanya admin cabang yang berwenang dapat mengubah konfigurasi cabang.';
    end if;

    if not wms_private.is_hq() then
      -- Branch Admin may update operation_type of their own branch; name remains locked unless HQ
      update public.branches
      set operation_type = v_op
      where id = v_id
      returning * into v_row;
    else
      update public.branches
      set name = v_name,
          operation_type = v_op
      where id = v_id
      returning * into v_row;
    end if;
  end if;

  select coalesce(nullif(full_name, ''), email) into v_actor
  from public.profiles where id = auth.uid();

  insert into public.activity_events (
    branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
  ) values (
    v_id,
    'branches',
    v_id,
    case when v_exists then 'BRANCH_UPDATE' else 'BRANCH_CREATE' end,
    auth.uid(),
    coalesce(v_actor, 'Admin WMS'),
    jsonb_build_object('id', v_row.id, 'name', v_row.name, 'operation_type', v_row.operation_type),
    'Konfigurasi tipe operasional cabang: ' || v_row.operation_type
  );

  return jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'operation_type', v_row.operation_type
  );
end;
$$;

revoke all on function public.save_branch(text, text, text) from public, anon;
grant execute on function public.save_branch(text, text, text) to authenticated;

-- Atomic Shipping Manifest commit & cancellation RPC
create or replace function public.commit_shipping_manifest(
  p_request_id uuid,
  p_branch_id text,
  p_order_refs text[],
  p_manifest jsonb default '{}'::jsonb,
  p_action text default 'create'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_actor text;
  v_action text;
  v_branch_op text;
  v_req wms_private.write_requests%rowtype;
  v_body jsonb;
  v_refs text[];
  v_manifest_id text;
  v_order_types text[];
  v_order_type text;
  v_handed_over_at timestamptz;
  v_now_iso text;
  v_matched_count integer := 0;
  v_updated_count integer := 0;
  v_total_qty numeric := 0;
  v_existing_manifest public.shipping_manifests%rowtype;
  v_ref text;
  v_result jsonb;
begin
  v_role := public.wms_current_role();
  if auth.uid() is null or v_role not in ('Administrator', 'Admin', 'Shipping') or not wms_private.can_access_branch(p_branch_id) then
    raise exception 'Akses Shipping & Manifest ditolak untuk pengguna atau cabang ini.';
  end if;

  if p_request_id is null then
    raise exception 'Request ID transaksi wajib diisi.';
  end if;

  v_action := lower(trim(coalesce(nullif(p_action, ''), 'create')));
  if v_action not in ('create', 'cancel') then
    raise exception 'Aksi manifest harus create atau cancel.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('write:' || p_request_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('write-branch:' || p_branch_id, 0));

  v_body := jsonb_build_object(
    'action', v_action,
    'refs', coalesce(to_jsonb(p_order_refs), '[]'::jsonb),
    'manifest', coalesce(p_manifest, '{}'::jsonb)
  );

  select * into v_req from wms_private.write_requests where id = p_request_id;
  if found then
    if v_req.actor_id <> auth.uid() or v_req.branch_id <> p_branch_id or v_req.body is distinct from v_body then
      raise exception 'ID transaksi manifest sudah digunakan untuk permintaan lain.';
    end if;
    return v_req.result;
  end if;

  select coalesce(nullif(full_name, ''), email) into v_actor
  from public.profiles where id = auth.uid();
  v_actor := coalesce(nullif(trim(coalesce(p_manifest->>'handedOverBy', '')), ''), v_actor, 'Petugas Shipping');

  select coalesce(operation_type, 'HYBRID') into v_branch_op
  from public.branches where id = p_branch_id;
  v_branch_op := coalesce(v_branch_op, 'HYBRID');

  v_manifest_id := trim(coalesce(p_manifest->>'manifestId', p_manifest->>'manifest_id', ''));

  select coalesce(array_agg(distinct upper(trim(r))), array[]::text[])
  into v_refs
  from unnest(coalesce(p_order_refs, array[]::text[])) as r
  where trim(coalesce(r, '')) <> '';

  if v_action = 'cancel' then
    if v_manifest_id = '' and coalesce(array_length(v_refs, 1), 0) = 0 then
      raise exception 'Referensi manifest atau order untuk pembatalan tidak ditemukan.';
    end if;

    if v_manifest_id <> '' then
      select * into v_existing_manifest
      from public.shipping_manifests
      where manifest_id = v_manifest_id and branch_id = p_branch_id
      for update;

      if found then
        update public.shipping_manifests
        set status = 'CANCELLED',
            cancelled_at = now(),
            cancelled_by = auth.uid()
        where manifest_id = v_manifest_id and branch_id = p_branch_id;

        if coalesce(array_length(v_refs, 1), 0) = 0 then
          select coalesce(array_agg(distinct upper(trim(val))), array[]::text[])
          into v_refs
          from jsonb_array_elements_text(coalesce(v_existing_manifest.order_references, '[]'::jsonb)) as val
          where trim(coalesce(val, '')) <> '';
        end if;
      end if;
    end if;

    perform set_config('wms.operation_id', p_request_id::text, true);
    perform set_config('wms.operation_type', 'SHIPPING_MANIFEST_CANCEL', true);
    perform set_config('wms.reason', 'Pembatalan manifest ekspedisi ' || coalesce(nullif(v_manifest_id, ''), '-'), true);

    with locked as (
      select d.document_id, d.payload
      from public.wms_documents d
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and (
          (v_manifest_id <> '' and d.payload->>'manifestId' = v_manifest_id)
          or (
            coalesce(array_length(v_refs, 1), 0) > 0
            and (
              upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
              or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
              or upper(trim(d.document_id)) = any(v_refs)
            )
          )
        )
      order by d.document_id
      for update
    ),
    updated as (
      update public.wms_documents d
      set payload = (d.payload - 'shippedAt' - 'shippedBy' - 'manifestId') || jsonb_build_object('shipped', false)
      from locked l
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and d.document_id = l.document_id
      returning 1
    )
    select count(*) into v_updated_count from updated;

    v_result := jsonb_build_object(
      'success', true,
      'action', 'cancel',
      'manifestId', nullif(v_manifest_id, ''),
      'updatedCount', v_updated_count
    );

    insert into wms_private.write_requests (id, actor_id, branch_id, body, result)
    values (p_request_id, auth.uid(), p_branch_id, v_body, v_result);

    return v_result;
  end if;

  -- Action: create
  if coalesce(array_length(v_refs, 1), 0) = 0 then
    raise exception 'Pilih minimal 1 order untuk dibuatkan manifest pengiriman.';
  end if;
  if v_manifest_id = '' then
    raise exception 'Nomor Manifest (manifestId) wajib diisi.';
  end if;

  -- Lock candidate order rows consistently before validating
  perform 1
  from public.wms_documents d
  where d.branch_id = p_branch_id
    and d.collection_name = 'orders'
    and (
      upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
      or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
      or upper(trim(d.document_id)) = any(v_refs)
    )
  order by d.document_id
  for update;

  -- Ensure every submitted reference actually exists in branch orders
  foreach v_ref in array v_refs loop
    if not exists (
      select 1
      from public.wms_documents d
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and (
          upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = v_ref
          or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = v_ref
          or upper(trim(d.document_id)) = v_ref
        )
    ) then
      raise exception 'Referensi order % tidak ditemukan di cabang %.', v_ref, p_branch_id;
    end if;
  end loop;

  if exists (
    select 1
    from public.wms_documents d
    where d.branch_id = p_branch_id
      and d.collection_name = 'orders'
      and (
        upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
        or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
        or upper(trim(d.document_id)) = any(v_refs)
      )
      and coalesce(d.payload->>'status', 'Pending') <> 'Completed'
  ) then
    raise exception 'Semua order pada manifest harus berstatus Completed (selesai packing).';
  end if;

  if exists (
    select 1
    from public.wms_documents d
    where d.branch_id = p_branch_id
      and d.collection_name = 'orders'
      and (
        upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
        or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
        or upper(trim(d.document_id)) = any(v_refs)
      )
      and coalesce((d.payload->>'shipped')::boolean, false) = true
  ) then
    raise exception 'Ada order yang sudah tercatat terkirim pada manifest lain (double shipping diblokir).';
  end if;

  if exists (
    select 1
    from public.wms_documents d
    where d.branch_id = p_branch_id
      and d.collection_name = 'orders'
      and (
        upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
        or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
        or upper(trim(d.document_id)) = any(v_refs)
      )
      and upper(trim(coalesce(d.payload->>'orderType', d.payload->>'order_type', 'UNASSIGNED'))) not in ('B2B', 'ONLINE')
  ) then
    raise exception 'Order UNASSIGNED tidak boleh masuk manifest. Minta Admin mengklasifikasikan order terlebih dahulu.';
  end if;

  select array_agg(distinct upper(trim(coalesce(d.payload->>'orderType', d.payload->>'order_type', '')))),
         count(*),
         coalesce(sum((d.payload->>'qty')::numeric), 0)
  into v_order_types, v_matched_count, v_total_qty
  from public.wms_documents d
  where d.branch_id = p_branch_id
    and d.collection_name = 'orders'
    and (
      upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
      or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
      or upper(trim(d.document_id)) = any(v_refs)
    );

  if coalesce(array_length(v_order_types, 1), 0) > 1 then
    raise exception 'Manifest B2B dan Manifest Online harus dibuat terpisah dan tidak boleh digabung dalam satu dokumen.';
  end if;

  v_order_type := v_order_types[1];
  if v_order_type not in ('B2B', 'ONLINE') then
    raise exception 'Jenis order manifest tidak valid.';
  end if;

  if v_branch_op <> 'HYBRID' and v_branch_op <> v_order_type then
    raise exception 'Cabang bertipe % tidak mengizinkan manifest order %.', v_branch_op, v_order_type;
  end if;

  v_handed_over_at := coalesce(
    nullif(p_manifest->>'handedOverAt', '')::timestamptz,
    now()
  );
  v_now_iso := to_char(v_handed_over_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.shipping_manifests (
    manifest_id,
    branch_id,
    warehouse_id,
    warehouse_name,
    order_type,
    courier_name,
    sender_name,
    driver_name,
    driver_phone,
    vehicle_plate,
    handed_over_by,
    handed_over_by_id,
    handed_over_at,
    total_orders,
    total_qty_pcs,
    order_references,
    notes,
    status
  ) values (
    v_manifest_id,
    p_branch_id,
    coalesce(nullif(trim(p_manifest->>'warehouseId'), ''), 'WH-CENTRAL'),
    coalesce(trim(p_manifest->>'warehouseName'), ''),
    v_order_type,
    coalesce(nullif(trim(p_manifest->>'courierName'), ''), 'EKSPEDISI'),
    coalesce(trim(p_manifest->>'senderName'), ''),
    nullif(trim(coalesce(p_manifest->>'driverName', '')), ''),
    nullif(trim(coalesce(p_manifest->>'driverPhone', '')), ''),
    nullif(upper(trim(coalesce(p_manifest->>'vehiclePlate', ''))), ''),
    v_actor,
    auth.uid(),
    v_handed_over_at,
    coalesce((p_manifest->>'totalOrders')::integer, array_length(v_refs, 1), 0),
    coalesce((p_manifest->>'totalQtyPcs')::numeric, v_total_qty, 0),
    to_jsonb(v_refs),
    nullif(trim(coalesce(p_manifest->>'notes', '')), ''),
    'ACTIVE'
  )
  on conflict (manifest_id) do nothing;

  perform set_config('wms.operation_id', p_request_id::text, true);
  perform set_config('wms.operation_type', 'SHIPPING_MANIFEST', true);
  perform set_config('wms.reason', 'Serah terima ekspedisi ' || v_manifest_id || ' (' || v_order_type || ')', true);

  with updated as (
    update public.wms_documents d
    set payload = d.payload || jsonb_build_object(
      'shipped', true,
      'shippedAt', v_now_iso,
      'shippedBy', v_actor,
      'manifestId', v_manifest_id
    )
    where d.branch_id = p_branch_id
      and d.collection_name = 'orders'
      and (
        upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
        or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
        or upper(trim(d.document_id)) = any(v_refs)
      )
    returning 1
  )
  select count(*) into v_updated_count from updated;

  v_result := jsonb_build_object(
    'success', true,
    'action', 'create',
    'manifestId', v_manifest_id,
    'orderType', v_order_type,
    'updatedCount', v_updated_count
  );

  insert into wms_private.write_requests (id, actor_id, branch_id, body, result)
  values (p_request_id, auth.uid(), p_branch_id, v_body, v_result);

  return v_result;
end;
$$;

revoke all on function public.commit_shipping_manifest(uuid, text, text[], jsonb, text) from public, anon;
grant execute on function public.commit_shipping_manifest(uuid, text, text[], jsonb, text) to authenticated;

-- Admin-only order classification RPC (assigns B2B or ONLINE without touching stock or workflow state)
create or replace function public.assign_order_types(
  p_request_id uuid,
  p_branch_id text,
  p_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_actor text;
  v_req wms_private.write_requests%rowtype;
  v_item jsonb;
  v_doc_id text;
  v_ref text;
  v_type text;
  v_updated_count integer := 0;
  v_now_iso text;
  v_result jsonb;
begin
  v_role := public.wms_current_role();
  if auth.uid() is null or v_role not in ('Administrator', 'Admin') or not wms_private.can_access_branch(p_branch_id) then
    raise exception 'Hanya Admin atau Administrator cabang yang dapat mengklasifikasikan order.';
  end if;

  if p_request_id is null or jsonb_typeof(p_assignments) is distinct from 'array' or jsonb_array_length(p_assignments) not between 1 and 2000 then
    raise exception 'Daftar klasifikasi order harus berisi 1â€“2000 entri.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('write:' || p_request_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('write-branch:' || p_branch_id, 0));

  select * into v_req from wms_private.write_requests where id = p_request_id;
  if found then
    if v_req.actor_id <> auth.uid() or v_req.branch_id <> p_branch_id or v_req.body is distinct from p_assignments then
      raise exception 'ID permintaan klasifikasi sudah digunakan.';
    end if;
    return v_req.result;
  end if;

  select coalesce(nullif(full_name, ''), email) into v_actor
  from public.profiles where id = auth.uid();
  v_actor := coalesce(v_actor, 'Admin WMS');
  v_now_iso := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  perform set_config('wms.operation_id', p_request_id::text, true);
  perform set_config('wms.operation_type', 'ORDER_TYPE_ASSIGNMENT', true);
  perform set_config('wms.reason', 'Klasifikasi jenis order (B2B/ONLINE) oleh Admin', true);

  for v_item in select value from jsonb_array_elements(p_assignments) loop
    v_doc_id := trim(coalesce(v_item->>'document_id', v_item->>'id', ''));
    v_ref := upper(trim(coalesce(v_item->>'referenceNumber', v_item->>'reference_number', '')));
    v_type := upper(trim(coalesce(v_item->>'order_type', v_item->>'orderType', '')));

    if v_type not in ('B2B', 'ONLINE') then
      raise exception 'Nilai klasifikasi order harus B2B atau ONLINE.';
    end if;
    if v_doc_id = '' and v_ref = '' then
      raise exception 'Setiap baris klasifikasi wajib menyertakan document_id atau referenceNumber.';
    end if;

    with target_rows as (
      select d.document_id, d.payload
      from public.wms_documents d
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and coalesce(d.payload->>'status', 'Pending') <> 'Cancelled'
        and (
          (v_doc_id <> '' and d.document_id = v_doc_id)
          or (v_ref <> '' and upper(trim(coalesce(d.payload->>'referenceNumber', d.payload->>'orderNumber', ''))) = v_ref)
        )
      order by d.document_id
      for update
    ),
    updated as (
      update public.wms_documents d
      set payload = d.payload || jsonb_build_object(
        'orderType', v_type,
        'orderTypeAssignedAt', v_now_iso,
        'orderTypeAssignedBy', v_actor
      )
      from target_rows t
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and d.document_id = t.document_id
      returning 1
    )
    select v_updated_count + count(*) into v_updated_count from updated;
  end loop;

  v_result := jsonb_build_object('success', true, 'updatedCount', v_updated_count);

  insert into wms_private.write_requests (id, actor_id, branch_id, body, result)
  values (p_request_id, auth.uid(), p_branch_id, p_assignments, v_result);

  return v_result;
end;
$$;

revoke all on function public.assign_order_types(uuid, text, jsonb) from public, anon;
grant execute on function public.assign_order_types(uuid, text, jsonb) to authenticated;

-- Admin user management SQL RPC (supports create, update, delete directly in Postgres)
create or replace function public.admin_manage_user(body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor record;
  v_action text;
  v_target_id uuid;
  v_target record;
  v_branch_id text;
  v_full_name text;
  v_role text;
  v_username text;
  v_password text;
  v_email text;
  v_new_id uuid;
  v_instance_id uuid;
  v_admin_count integer;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'Sesi masuk tidak valid.');
  end if;

  select role, is_active, branch_id, full_name, email
  into v_actor
  from public.profiles
  where id = auth.uid();

  if not found or not v_actor.is_active or v_actor.role not in ('Admin', 'Administrator') then
    return jsonb_build_object('error', 'Hanya admin WMS yang dapat mengelola akun.');
  end if;

  v_action := lower(trim(coalesce(body->>'action', '')));
  v_branch_id := upper(coalesce(nullif(trim(coalesce(body->>'branchId', '')), ''), v_actor.branch_id, 'CENTER'));
  v_full_name := trim(coalesce(body->>'fullName', ''));
  v_role := trim(coalesce(body->>'role', ''));

  if v_actor.role <> 'Administrator' and v_branch_id <> v_actor.branch_id then
    return jsonb_build_object('error', 'Akses cabang ditolak.');
  end if;
  if v_actor.role <> 'Administrator' and v_role = 'Administrator' then
    return jsonb_build_object('error', 'Hanya kantor pusat dapat memberikan akses Administrator.');
  end if;

  if v_action = 'create' then
    v_username := lower(trim(coalesce(body->>'username', '')));
    v_password := coalesce(body->>'password', '');
    v_full_name := coalesce(nullif(v_full_name, ''), v_username);

    if v_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$'
       or length(v_password) < 8
       or length(v_password) > 128
       or length(v_full_name) not between 1 and 120
       or v_role not in ('Administrator', 'Admin', 'Picker', 'Packer', 'Shipping', 'Viewer') then
      return jsonb_build_object('error', 'ID, password (minimal 8 karakter), nama, atau peran tidak valid.');
    end if;

    if not exists (select 1 from public.branches where id = v_branch_id) then
      if v_actor.role = 'Administrator' then
        insert into public.branches (id, name, operation_type)
        values (v_branch_id, v_branch_id, 'HYBRID')
        on conflict (id) do nothing;
      else
        return jsonb_build_object('error', 'Akses cabang ditolak: Cabang "' || v_branch_id || '" tidak terdaftar.');
      end if;
    end if;

    v_email := v_username || '@operators.blues.invalid';

    if exists (select 1 from auth.users where lower(email) = v_email) then
      return jsonb_build_object('error', 'ID akun "' || v_username || '" sudah terdaftar.');
    end if;

    v_new_id := gen_random_uuid();
    select coalesce(
      (select u.instance_id from auth.users u where u.id = auth.uid()),
      '00000000-0000-0000-0000-000000000000'::uuid
    ) into v_instance_id;

    insert into auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    ) values (
      v_new_id,
      v_instance_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_password, gen_salt('bf')),
      now(),
      '',
      '',
      '',
      '',
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', v_full_name),
      now(),
      now()
    );

    insert into auth.identities (
      id,
      user_id,
      provider_id,
      identity_data,
      provider,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),
      v_new_id,
      v_new_id::text,
      jsonb_build_object(
        'sub', v_new_id::text,
        'email', v_email,
        'email_verified', true,
        'phone_verified', false
      ),
      'email',
      now(),
      now(),
      now()
    ) on conflict (provider_id, provider) do nothing;

    insert into public.profiles (id, email, full_name, role, branch_id, is_active)
    values (v_new_id, v_email, v_full_name, v_role, v_branch_id, true)
    on conflict (id) do update set
      email = excluded.email,
      full_name = excluded.full_name,
      role = excluded.role,
      branch_id = excluded.branch_id,
      is_active = true;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_new_id::text, 'ACCOUNT_CREATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('username', v_username, 'fullName', v_full_name, 'role', v_role, 'branch_id', v_branch_id),
      'Pengelolaan akun oleh admin'
    );

    return jsonb_build_object('success', true, 'userId', v_new_id::text, 'username', v_username);
  elsif v_action = 'update' then
    if coalesce(trim(body->>'userId'), '') = '' or length(v_full_name) not between 1 and 120
       or v_role not in ('Administrator', 'Admin', 'Picker', 'Packer', 'Shipping', 'Viewer') then
      return jsonb_build_object('error', 'Profil atau peran tidak valid.');
    end if;

    v_target_id := (body->>'userId')::uuid;
    select id, role, is_active, branch_id into v_target
    from public.profiles where id = v_target_id for update;

    if not found then
      return jsonb_build_object('error', 'Akun tidak ditemukan.');
    end if;
    if v_actor.role <> 'Administrator' and (v_target.branch_id <> v_actor.branch_id or v_target.role = 'Administrator') then
      return jsonb_build_object('error', 'Akses akun ditolak.');
    end if;

    if v_target.is_active and v_target.role = 'Administrator' and v_role <> 'Administrator' then
      select count(*) into v_admin_count from public.profiles where role = 'Administrator' and is_active;
      if v_admin_count <= 1 then
        return jsonb_build_object('error', 'Admin terakhir tidak dapat diturunkan perannya.');
      end if;
    end if;

    update public.profiles
    set full_name = v_full_name,
        role = v_role,
        branch_id = v_branch_id
    where id = v_target_id;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_target_id::text, 'ACCOUNT_UPDATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('fullName', v_full_name, 'role', v_role, 'branch_id', v_branch_id),
      'Pengelolaan akun oleh admin'
    );

    return jsonb_build_object('success', true);
  elsif v_action = 'delete' then
    if coalesce(trim(body->>'userId'), '') = '' then
      return jsonb_build_object('error', 'ID akun tidak valid.');
    end if;

    v_target_id := (body->>'userId')::uuid;
    if v_target_id = auth.uid() then
      return jsonb_build_object('error', 'Akun aktif tidak dapat menonaktifkan dirinya sendiri.');
    end if;

    select id, role, is_active, branch_id into v_target
    from public.profiles where id = v_target_id for update;
    if not found then
      return jsonb_build_object('error', 'Akun tidak ditemukan.');
    end if;
    if v_actor.role <> 'Administrator' and (v_target.branch_id <> v_actor.branch_id or v_target.role = 'Administrator') then
      return jsonb_build_object('error', 'Akses akun ditolak.');
    end if;

    if v_target.is_active and v_target.role = 'Administrator' then
      select count(*) into v_admin_count from public.profiles where role = 'Administrator' and is_active;
      if v_admin_count <= 1 then
        return jsonb_build_object('error', 'Admin terakhir tidak dapat dihapus atau dinonaktifkan.');
      end if;
    end if;

    update public.profiles set is_active = false where id = v_target_id;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_target_id::text, 'ACCOUNT_DEACTIVATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('userId', v_target_id::text),
      'Penonaktifan akun oleh admin'
    );

    return jsonb_build_object('success', true);
  end if;

  return jsonb_build_object('error', 'Aksi pengelolaan akun tidak dikenal.');
end;
$$;

revoke all on function public.admin_manage_user(jsonb) from public, anon;
grant execute on function public.admin_manage_user(jsonb) to authenticated;

-- Hardened Marketplace Webhook RPC (whitelist + explicit orderType, else UNASSIGNED; never guesses from PO/customer)
create or replace function public.marketplace_order_webhook(
  payload jsonb,
  p_secret text default 'TRUEBLUE_WEBHOOK_2026'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_id text;
  v_warehouse_id text;
  v_branch_op text;
  v_order_number text;
  v_customer_name text;
  v_no_po text;
  v_source text;
  v_explicit_type text;
  v_order_type text;
  v_configured_secret text;
  v_items jsonb;
  v_item jsonb;
  v_sku text;
  v_need_num numeric;
  v_stock record;
  v_reserved numeric;
  v_free integer;
  v_need integer;
  v_take integer;
  v_import_items jsonb := '[]'::jsonb;
  v_req_id uuid := gen_random_uuid();
  v_idx integer := 0;
  v_now_iso text;
  v_actor text;
begin
  if auth.uid() is null or not public.wms_is_admin() then
    raise exception 'Webhook simulator hanya dapat dijalankan oleh Admin atau Administrator yang login.';
  end if;

  if jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'Payload webhook harus berupa JSON object.';
  end if;

  v_branch_id := upper(trim(coalesce(nullif(payload->>'branchId', ''), nullif(payload->>'branch_id', ''), 'CENTER')));
  if not wms_private.can_access_branch(v_branch_id) then
    raise exception 'Akses cabang % ditolak untuk webhook.', v_branch_id;
  end if;

  select d.payload->>'secretKey' into v_configured_secret
  from public.wms_documents d
  where d.branch_id = v_branch_id
    and d.collection_name = 'settings'
    and d.document_id = 'marketplace_webhook_config'
  limit 1;

  v_configured_secret := coalesce(nullif(trim(coalesce(v_configured_secret, '')), ''), 'TRUEBLUE_WEBHOOK_2026');
  if trim(coalesce(p_secret, '')) is distinct from v_configured_secret then
    raise exception 'Secret key webhook tidak cocok.';
  end if;

  select coalesce(operation_type, 'HYBRID') into v_branch_op
  from public.branches where id = v_branch_id;
  if not found then
    raise exception 'Cabang % tidak ditemukan.', v_branch_id;
  end if;

  v_warehouse_id := upper(trim(coalesce(nullif(payload->>'warehouseId', ''), nullif(payload->>'warehouse_id', ''), 'WH-CENTRAL')));
  v_order_number := left(trim(coalesce(payload->>'orderNumber', payload->>'order_sn', '')), 128);
  v_customer_name := left(trim(coalesce(nullif(payload->>'customerName', ''), nullif(payload->>'buyer', ''), 'Marketplace Buyer')), 200);
  v_no_po := left(trim(coalesce(payload->>'noPo', '')), 128);

  if length(v_order_number) not between 1 and 128 then
    raise exception 'orderNumber wajib diisi (1â€“128 karakter).';
  end if;

  v_source := upper(regexp_replace(trim(coalesce(
    payload->>'orderSource',
    payload->>'order_source',
    payload->>'marketplace',
    payload->>'platform',
    payload->>'source',
    ''
  )), '\s+', '_', 'g'));

  v_explicit_type := upper(trim(coalesce(payload->>'orderType', payload->>'order_type', '')));
  if v_explicit_type in ('B2B', 'ONLINE') then
    v_order_type := v_explicit_type;
  elsif v_source in ('SHOPEE', 'TIKTOK', 'TIKTOK_SHOP', 'TOKOPEDIA', 'LAZADA', 'BLIBLI', 'MABANG', 'JUBELIO') then
    v_order_type := 'ONLINE';
  else
    v_order_type := 'UNASSIGNED';
  end if;

  if v_order_type in ('B2B', 'ONLINE') and v_branch_op <> 'HYBRID' and v_branch_op <> v_order_type then
    raise exception 'Order bertipe % tidak diizinkan masuk ke cabang bertipe %.', v_order_type, v_branch_op;
  end if;

  v_items := coalesce(payload->'items', '[]'::jsonb);
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Payload webhook wajib menyertakan minimal 1 item SKU.';
  end if;

  v_now_iso := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  select coalesce(nullif(full_name, ''), email) into v_actor from public.profiles where id = auth.uid();

  perform pg_advisory_xact_lock(hashtextextended('write-branch:' || v_branch_id, 0));

  for v_item in select value from jsonb_array_elements(v_items) loop
    v_sku := upper(trim(coalesce(v_item->>'skuId', v_item->>'sku', '')));
    v_need_num := coalesce((v_item->>'qty')::numeric, 0);
    if v_sku = '' or v_need_num <= 0 or floor(v_need_num) <> v_need_num then
      raise exception 'Item webhook wajib memiliki skuId dan qty bilangan bulat > 0.';
    end if;
    v_need := v_need_num::integer;

    for v_stock in
      select
        d.payload->>'skuId' as sku_id,
        coalesce(nullif(d.payload->>'skuName', ''), d.payload->>'skuId') as sku_name,
        d.payload->>'location' as location,
        coalesce(nullif(d.payload->>'expiredDate', ''), 'No Expired') as expired_date,
        (d.payload->>'qty')::numeric as qty
      from public.wms_documents d
      where d.branch_id = v_branch_id
        and d.collection_name = 'stock'
        and left(d.document_id, 7) <> 'SYSTEM_'
        and upper(trim(d.payload->>'skuId')) = v_sku
        and coalesce(d.payload->>'warehouseId', 'WH-CENTRAL') = v_warehouse_id
        and (d.payload->>'qty')::numeric > 0
        and wms_private.stock_pickable(d.payload)
      order by
        case when coalesce(d.payload->>'expiredDate', 'No Expired') in ('No Expired', '--', '-') then 1 else 0 end,
        d.payload->>'expiredDate',
        d.document_id
    loop
      exit when v_need <= 0;

      select coalesce(sum((o.payload->>'qty')::numeric), 0) into v_reserved
      from public.wms_documents o
      where o.branch_id = v_branch_id
        and o.collection_name = 'orders'
        and coalesce(o.payload->>'status', 'Pending') = 'Pending'
        and coalesce((o.payload->>'stockDeducted')::boolean, false) = false
        and coalesce(o.payload->>'warehouseId', 'WH-CENTRAL') = v_warehouse_id
        and upper(trim(o.payload->>'skuId')) = upper(trim(v_stock.sku_id))
        and upper(trim(o.payload->>'location')) = upper(trim(v_stock.location))
        and coalesce(nullif(o.payload->>'expiredDate', ''), 'No Expired') = v_stock.expired_date;

      v_free := greatest(0, floor(v_stock.qty - v_reserved))::integer;
      if v_free <= 0 then
        continue;
      end if;

      v_take := least(v_need, v_free);
      v_import_items := v_import_items || jsonb_build_array(jsonb_build_object(
        'id', 'IMP_' || replace(v_req_id::text, '-', '') || '_' || v_idx::text,
        'orderNumber', v_order_number,
        'referenceNumber', v_order_number,
        'customerName', v_customer_name,
        'noPo', v_no_po,
        'batchNumber', coalesce(nullif(trim(payload->>'batchNumber'), ''), 'WEBHOOK-' || to_char(now(), 'YYYYMMDD')),
        'skuId', v_stock.sku_id,
        'skuName', v_stock.sku_name,
        'location', v_stock.location,
        'expiredDate', v_stock.expired_date,
        'qty', v_take,
        'warehouseId', v_warehouse_id,
        'status', 'Pending',
        'stockDeducted', false,
        'picked', false,
        'scanned', false,
        'timestamp', v_now_iso,
        'orderType', v_order_type,
        'orderSource', coalesce(nullif(v_source, ''), 'WEBHOOK_UNKNOWN')
      ));
      v_idx := v_idx + 1;
      v_need := v_need - v_take;
    end loop;

    if v_need > 0 then
      raise exception 'Stok pickable SKU % di cabang % (%) tidak mencukupi (kurang % pcs).', v_sku, v_branch_id, v_warehouse_id, v_need;
    end if;
  end loop;

  perform wms_private.import_wms_orders(v_req_id, v_branch_id, v_warehouse_id, v_import_items);

  return jsonb_build_object(
    'success', true,
    'requestId', v_req_id,
    'orderNumber', v_order_number,
    'orderType', v_order_type,
    'orderSource', coalesce(nullif(v_source, ''), 'WEBHOOK_UNKNOWN'),
    'allocatedRows', v_idx,
    'actor', coalesce(v_actor, 'Admin WMS')
  );
end;
$$;

revoke all on function public.marketplace_order_webhook(jsonb, text) from public, anon;
grant execute on function public.marketplace_order_webhook(jsonb, text) to authenticated;

-- Shipping Manifest dan Marketplace Webhook sudah dipensiunkan.
-- Drop ulang di akhir setup untuk memastikan database baru tidak menyisakan fitur tersebut.
drop function if exists public.commit_shipping_manifest(uuid, text, text[], jsonb, text);
drop function if exists public.marketplace_order_webhook(jsonb, text);
drop table if exists public.shipping_manifests cascade;

