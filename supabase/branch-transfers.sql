
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
