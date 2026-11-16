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
  if exists(
    select 1 from public.wms_documents
    where branch_id=p_branch_id and collection_name='returns'
      and coalesce(payload->>'caseId',document_id)=p_case_id
      and payload->>'evidenceStatus' is distinct from 'READY'
  ) then raise exception 'Video unboxing wajib siap sebelum QC';end if;

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

revoke all on function wms_private.process_return_qc(uuid,text,text,text,text) from public,anon,authenticated;

create or replace function public.process_return_qc(
  p_request_id uuid,p_branch_id text,p_case_id text,p_decision text,p_notes text default ''
) returns jsonb language sql security invoker set search_path='' as $$
  select wms_private.process_return_qc(p_request_id,p_branch_id,p_case_id,p_decision,p_notes)
$$;
revoke all on function public.process_return_qc(uuid,text,text,text,text) from public,anon;
grant execute on function public.process_return_qc(uuid,text,text,text,text) to authenticated;
