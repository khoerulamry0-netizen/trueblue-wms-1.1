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
