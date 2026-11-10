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
