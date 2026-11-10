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
end;$function$
