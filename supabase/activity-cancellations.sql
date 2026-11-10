
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
