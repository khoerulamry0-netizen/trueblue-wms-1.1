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