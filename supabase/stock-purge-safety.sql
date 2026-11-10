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
