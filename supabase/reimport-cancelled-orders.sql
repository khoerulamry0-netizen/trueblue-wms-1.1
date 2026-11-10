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
