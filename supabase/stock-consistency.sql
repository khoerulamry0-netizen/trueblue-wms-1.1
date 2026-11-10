
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
