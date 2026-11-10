-- REVIEW CANDIDATE ONLY. Not an installable migration: deployment compatibility
-- this revised version requires execution against a disposable PostgreSQL instance.
-- Server scan events show submitted codes, not a physical scanner provenance.

create table wms_private.scan_sessions (
 id uuid primary key,
 branch_id text not null,
 reference_number text not null,
 phase text not null check (phase in ('sorting', 'packing')),
 basket text not null,
 actor_id uuid not null,
 snapshot jsonb not null,
 state text not null default 'open' check (state in ('open', 'finished', 'cancelled')),
 finish_request uuid,
 result jsonb,
 created_at timestamptz not null default clock_timestamp()
);

create unique index scan_sessions_one_open on wms_private.scan_sessions(branch_id,reference_number,phase)
 where state='open';

create table wms_private.scan_events (
 session_id uuid not null references wms_private.scan_sessions(id),
 request_id uuid not null,
 input_code text not null,
 document_id text not null,
 sku text not null,
 created_at timestamptz not null default now(),
 primary key (session_id, request_id)
);

create table wms_private.scan_write_authorizations (
 transaction_id bigint not null,
 actor_id uuid not null,
 branch_id text not null,
 reference_number text not null,
 phase text not null check (phase in ('sorting', 'packing', 'direct')),
 primary key (transaction_id, actor_id, branch_id, reference_number, phase)
);

create table wms_private.receipt_proofs (
 branch_id text not null,
 reference_number text not null,
 snapshot jsonb not null,
 source text not null check (source in ('packing','direct')),
 operation_id uuid not null,
 actor_id uuid not null,
 created_at timestamptz not null default now(),
 primary key (branch_id,reference_number)
);

create table wms_private.direct_outbound_requests (
 id uuid primary key,
 branch_id text not null,
 actor_id uuid not null,
 upserts jsonb not null,
 reason text not null,
 result jsonb not null
);

revoke all on wms_private.scan_sessions, wms_private.scan_events,
 wms_private.scan_write_authorizations, wms_private.receipt_proofs,
 wms_private.direct_outbound_requests from public, anon, authenticated, service_role;

create function wms_private.scan_authorize(p_branch text) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null or not wms_private.can_access_branch(p_branch) or not exists (
  select 1 from public.profiles p where p.id=auth.uid() and p.is_active
   and p.role in ('Administrator','Admin','Packer')
 ) then raise exception 'Akses scan ditolak'; end if;
end; $$;
revoke all on function wms_private.scan_authorize(text) from public, anon, authenticated, service_role;

create function wms_private.scan_snapshot(p_branch text, p_reference text) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',d.document_id,'revision',d.revision,'sku',d.payload->>'skuId',
  'qty',d.payload->'qty','status',d.payload->>'status',
  'picked',d.payload->'picked','deducted',d.payload->'stockDeducted'
 ) order by d.document_id),'[]'::jsonb)
 from public.wms_documents d where d.branch_id=p_branch
  and d.collection_name='orders' and d.payload->>'referenceNumber'=p_reference
$$;
revoke all on function wms_private.scan_snapshot(text,text) from public, anon, authenticated, service_role;

create function wms_private.guard_scan_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare previous jsonb; ref text; authorized_sort boolean; authorized_pack boolean; authorized_direct boolean;
begin
 if new.collection_name<>'orders' then return new; end if;
 if tg_op='UPDATE' then
  previous=old.payload;
 else
  select payload into previous from public.wms_documents
   where branch_id=new.branch_id and collection_name='orders' and document_id=new.document_id;
  if previous is not null then return new; end if;
 end if;
 ref=new.payload->>'referenceNumber';
 select exists(select 1 from wms_private.scan_write_authorizations a
  where a.transaction_id=txid_current() and a.actor_id=auth.uid()
   and a.branch_id=new.branch_id and a.reference_number=ref and a.phase='sorting'),
 exists(select 1 from wms_private.scan_write_authorizations a
  where a.transaction_id=txid_current() and a.actor_id=auth.uid()
   and a.branch_id=new.branch_id and a.reference_number=ref and a.phase='packing')
 ,exists(select 1 from wms_private.scan_write_authorizations a
  where a.transaction_id=txid_current() and a.actor_id=auth.uid()
   and a.branch_id=new.branch_id and a.reference_number=ref and a.phase='direct')
 into authorized_sort, authorized_pack, authorized_direct;
 if (new.payload->'sortedAt' is distinct from previous->'sortedAt'
    or new.payload->'sortedBy' is distinct from previous->'sortedBy'
    or new.payload->'sortedById' is distinct from previous->'sortedById')
    and not authorized_sort then raise exception 'Sortir memerlukan scan server'; end if;
 if new.payload->>'status'='Completed'
    and previous->>'status' is distinct from 'Completed'
    and not authorized_pack and not (previous is null and authorized_direct)
    then raise exception 'Packing memerlukan scan server'; end if;
 return new;
end; $$;
revoke all on function wms_private.guard_scan_order() from public, anon, authenticated, service_role;
create trigger a_guard_scan_order before insert or update on public.wms_documents
 for each row execute function wms_private.guard_scan_order();

create function public.start_order_scan(p_session uuid, p_branch text, p_reference text, p_phase text, p_basket text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_snapshot jsonb; prior wms_private.scan_sessions%rowtype;
begin
 perform wms_private.scan_authorize(p_branch);
 if p_session is null or p_phase is null or p_phase not in ('sorting','packing')
  or coalesce(length(trim(p_reference)),0) not between 1 and 160
  or coalesce(length(trim(p_basket)),0) not between 1 and 128 then
  raise exception 'Sesi scan tidak valid';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch,0));
 select * into prior from wms_private.scan_sessions where id=p_session;
 if found then
  if prior.actor_id<>auth.uid() or prior.branch_id<>p_branch
   or prior.reference_number<>p_reference or prior.phase<>p_phase or prior.basket<>trim(p_basket)
   then raise exception 'ID sesi sudah digunakan'; end if;
  return jsonb_build_object('session',prior.id,'state',prior.state);
 end if;
 if exists(select 1 from wms_private.scan_sessions s where s.branch_id=p_branch
  and s.reference_number=p_reference and s.phase=p_phase and s.state='open')
  then raise exception 'Sesi scan aktif sudah ada'; end if;
 v_snapshot=wms_private.scan_snapshot(p_branch,p_reference);
 if jsonb_array_length(v_snapshot)=0 or exists (
  select 1 from jsonb_array_elements(v_snapshot) v
  where v->>'status' is distinct from 'Pending' or v->'picked' is distinct from 'true'::jsonb
   or v->'deducted' is distinct from 'true'::jsonb
   or coalesce(trim(v->>'sku'),'')=''
   or jsonb_typeof(v->'qty') is distinct from 'number'
   or (v->>'qty')::numeric<=0 or (v->>'qty')::numeric<>trunc((v->>'qty')::numeric)
 ) then raise exception 'Order belum siap untuk scan'; end if;
 if p_phase='packing' and not exists (
  select 1 from wms_private.scan_sessions s where s.branch_id=p_branch
   and s.reference_number=p_reference and s.phase='sorting' and s.state='finished'
   and s.basket=trim(p_basket) and s.snapshot=v_snapshot
 ) then raise exception 'Sortir server belum lengkap atau order berubah'; end if;
 insert into wms_private.scan_sessions(id,branch_id,reference_number,phase,basket,actor_id,snapshot)
 values(p_session,p_branch,p_reference,p_phase,trim(p_basket),auth.uid(),v_snapshot);
 return jsonb_build_object('session',p_session,'state','open');
end; $$;
revoke all on function public.start_order_scan(uuid,text,text,text,text) from public, anon;
grant execute on function public.start_order_scan(uuid,text,text,text,text) to authenticated;

create function public.record_order_scan(p_session uuid, p_request uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s wms_private.scan_sessions%rowtype; prior wms_private.scan_events%rowtype;
 matched_sku text; matched_count integer; target jsonb;
begin
 if p_request is null or coalesce(length(trim(p_code)),0) not between 1 and 160 then
  raise exception 'Kode scan tidak valid';
 end if;
 select * into s from wms_private.scan_sessions where id=p_session;
 if not found then raise exception 'Sesi scan tidak ditemukan'; end if;
 perform wms_private.scan_authorize(s.branch_id);
 if s.actor_id<>auth.uid() then raise exception 'Sesi scan milik operator lain'; end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||s.branch_id,0));
 select * into s from wms_private.scan_sessions where id=p_session for update;
 select * into prior from wms_private.scan_events where session_id=p_session and request_id=p_request;
 if found then
  if prior.input_code<>trim(p_code) then raise exception 'ID scan sudah digunakan'; end if;
  return jsonb_build_object('document_id',prior.document_id,'sku',prior.sku);
 end if;
 if s.state<>'open' or wms_private.scan_snapshot(s.branch_id,s.reference_number)<>s.snapshot
  then raise exception 'Sesi selesai atau order berubah'; end if;
 select count(distinct upper(trim(v->>'sku'))),min(upper(trim(v->>'sku')))
 into matched_count,matched_sku
 from jsonb_array_elements(s.snapshot) v
 where upper(trim(v->>'sku'))=upper(trim(p_code)) or exists (
  select 1 from public.wms_documents c where c.branch_id=s.branch_id and c.collection_name='catalog'
   and upper(trim(c.payload->>'skuId'))=upper(trim(v->>'sku'))
   and upper(trim(c.payload->>'barcode'))=upper(trim(p_code))
 );
 if matched_count<>1 then raise exception 'SKU asing atau barcode ambigu'; end if;
 select v into target from jsonb_array_elements(s.snapshot) v
 where upper(trim(v->>'sku'))=matched_sku
  and (select count(*) from wms_private.scan_events e
       where e.session_id=p_session and e.document_id=v->>'id') < (v->>'qty')::numeric
 order by v->>'id' limit 1;
 if target is null then raise exception 'Jumlah scan berlebih'; end if;
 insert into wms_private.scan_events(session_id,request_id,input_code,document_id,sku)
 values(p_session,p_request,trim(p_code),target->>'id',matched_sku);
 return jsonb_build_object('document_id',target->>'id','sku',matched_sku);
end; $$;
revoke all on function public.record_order_scan(uuid,uuid,text) from public, anon;
grant execute on function public.record_order_scan(uuid,uuid,text) to authenticated;

create function public.get_order_scan_status(p_branch text,p_reference text,p_phase text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s wms_private.scan_sessions%rowtype; counts jsonb; events jsonb;
begin
 perform wms_private.scan_authorize(p_branch);
 if p_phase is null or p_phase not in ('sorting','packing')
  or coalesce(length(trim(p_reference)),0) not between 1 and 160
  then raise exception 'Sesi scan tidak valid'; end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch,0));
 select * into s from wms_private.scan_sessions x
  where x.branch_id=p_branch and x.reference_number=p_reference and x.phase=p_phase
   and x.actor_id=auth.uid()
  order by (x.state='open') desc,x.created_at desc,x.id desc limit 1;
 if not found then raise exception 'Sesi scan tidak ditemukan'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'document_id',v->>'id','sku',v->>'sku','required',v->'qty',
  'scanned',(select count(*) from wms_private.scan_events e
             where e.session_id=s.id and e.document_id=v->>'id'))
  order by v->>'id'),'[]'::jsonb) into counts
 from jsonb_array_elements(s.snapshot) v;
 select coalesce(jsonb_agg(jsonb_build_object('request_id',e.request_id,
  'input_code',e.input_code,'document_id',e.document_id,'sku',e.sku)
  order by e.created_at,e.request_id),'[]'::jsonb) into events
 from wms_private.scan_events e where e.session_id=s.id;
 return jsonb_build_object('session',s.id,'branch',s.branch_id,'reference',s.reference_number,
  'phase',s.phase,'basket',s.basket,'state',s.state,'counts',counts,'events',events,
  'current',s.snapshot=wms_private.scan_snapshot(s.branch_id,s.reference_number),
  'finish_request',s.finish_request,'result',s.result);
end; $$;
revoke all on function public.get_order_scan_status(text,text,text) from public, anon;
grant execute on function public.get_order_scan_status(text,text,text) to authenticated;

create function public.cancel_order_scan(p_session uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s wms_private.scan_sessions%rowtype;
begin
 select * into s from wms_private.scan_sessions where id=p_session;
 if not found then raise exception 'Sesi scan tidak ditemukan'; end if;
 perform wms_private.scan_authorize(s.branch_id);
 if s.actor_id<>auth.uid() then raise exception 'Sesi scan milik operator lain'; end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||s.branch_id,0));
 select * into s from wms_private.scan_sessions where id=p_session for update;
 if s.state='finished' then raise exception 'Sesi sudah selesai'; end if;
 update wms_private.scan_sessions set state='cancelled' where id=p_session;
 return jsonb_build_object('session',p_session,'state','cancelled');
end; $$;
revoke all on function public.cancel_order_scan(uuid) from public, anon;
grant execute on function public.cancel_order_scan(uuid) to authenticated;

create function public.finish_order_scan(p_session uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s wms_private.scan_sessions%rowtype; changes jsonb; write_result jsonb;
begin
 if p_request is null then raise exception 'ID transaksi wajib'; end if;
 select * into s from wms_private.scan_sessions where id=p_session;
 if not found then raise exception 'Sesi scan tidak ditemukan'; end if;
 perform wms_private.scan_authorize(s.branch_id);
 if s.actor_id<>auth.uid() then raise exception 'Sesi scan milik operator lain'; end if;
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request::text,0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||s.branch_id,0));
 select * into s from wms_private.scan_sessions where id=p_session for update;
 if s.state='finished' and s.finish_request=p_request then
  return jsonb_build_object('session',p_session,'phase',s.phase,'state','finished');
 end if;
 if s.state<>'open' then raise exception 'Sesi sudah selesai'; end if;
 if wms_private.scan_snapshot(s.branch_id,s.reference_number)<>s.snapshot then
  raise exception 'Order berubah; ulangi scan';
 end if;
 if exists (select 1 from jsonb_array_elements(s.snapshot) v
  where (select count(*) from wms_private.scan_events e
         where e.session_id=p_session and e.document_id=v->>'id')<>(v->>'qty')::numeric
 ) then raise exception 'Scan belum lengkap'; end if;
 select jsonb_agg(jsonb_build_object('collection_name','orders','document_id',d.document_id,
  'expected_revision',d.revision,'payload',case when s.phase='sorting'
    then d.payload||jsonb_build_object('basketNumber',s.basket,'sortedAt',clock_timestamp(),'sortedBy','server')
    else d.payload||jsonb_build_object('status','Completed','scanned',true) end)
  order by d.document_id) into changes
 from public.wms_documents d where d.branch_id=s.branch_id and d.collection_name='orders'
  and d.payload->>'referenceNumber'=s.reference_number;
 insert into wms_private.scan_write_authorizations values(txid_current(),auth.uid(),s.branch_id,s.reference_number,s.phase);
 write_result=wms_private.commit_wms_write(p_request,s.branch_id,changes,'[]'::jsonb);
 delete from wms_private.scan_write_authorizations where transaction_id=txid_current()
  and actor_id=auth.uid() and branch_id=s.branch_id and reference_number=s.reference_number and phase=s.phase;
 if s.phase='packing' then
  insert into wms_private.receipt_proofs(branch_id,reference_number,snapshot,source,operation_id,actor_id)
  values(s.branch_id,s.reference_number,wms_private.scan_snapshot(s.branch_id,s.reference_number),
   'packing',p_request,auth.uid());
 end if;
 update wms_private.scan_sessions set state='finished',result=write_result,finish_request=p_request,
  snapshot=wms_private.scan_snapshot(s.branch_id,s.reference_number)
  where id=p_session;
 return jsonb_build_object('session',p_session,'phase',s.phase,'state','finished');
end; $$;
revoke all on function public.finish_order_scan(uuid,uuid) from public, anon;
grant execute on function public.finish_order_scan(uuid,uuid) to authenticated;

create function public.direct_outbound_scanned_admin(
 p_request uuid, p_branch text, p_upserts jsonb, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare item jsonb; reference text; result jsonb; refs text[]='{}';
 prior wms_private.direct_outbound_requests%rowtype;
begin
 if auth.uid() is null or not wms_private.can_access_branch(p_branch) or not exists (
  select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='Administrator'
 ) then raise exception 'Outbound langsung hanya untuk Administrator'; end if;
 if p_request is null or jsonb_typeof(p_upserts) is distinct from 'array'
   or jsonb_array_length(p_upserts)=0 or coalesce(length(trim(p_reason)),0) not between 10 and 500
 then raise exception 'Alasan atau data outbound tidak valid'; end if;
 perform pg_advisory_xact_lock(hashtextextended('write:'||p_request::text,0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch,0));
 select * into prior from wms_private.direct_outbound_requests where id=p_request;
 if found then
  if prior.branch_id<>p_branch or prior.actor_id<>auth.uid()
   or prior.upserts<>p_upserts or prior.reason<>trim(p_reason)
   then raise exception 'ID transaksi sudah digunakan'; end if;
  return prior.result;
 end if;
 if exists(select 1 from wms_private.write_requests where id=p_request)
  then raise exception 'ID transaksi sudah digunakan'; end if;
 for item in select value from jsonb_array_elements(p_upserts) loop
  if item->>'collection_name' not in ('orders','stock','logs','batches')
   or coalesce((item->>'merge')::boolean,false)
  then raise exception 'Item outbound langsung tidak valid'; end if;
  if item->>'collection_name'='orders' then
   reference=item->'payload'->>'referenceNumber';
   if coalesce(length(trim(reference)),0) not between 1 and 160
     or item->'expected_revision' is distinct from 'null'::jsonb
     or item->'payload'->>'status' is distinct from 'Completed'
     or exists(select 1 from public.wms_documents d where d.branch_id=p_branch
        and d.collection_name='orders' and
        (d.document_id=item->>'document_id' or d.payload->>'referenceNumber'=reference))
   then raise exception 'Outbound langsung hanya untuk order baru'; end if;
   if not reference=any(refs) then refs=array_append(refs,reference); end if;
  end if;
 end loop;
 if cardinality(refs)=0 then raise exception 'Order baru wajib disertakan'; end if;
 foreach reference in array refs loop
  insert into wms_private.scan_write_authorizations values(txid_current(),auth.uid(),p_branch,reference,'direct');
 end loop;
 result=wms_private.commit_wms_write(p_request,p_branch,p_upserts,'[]'::jsonb);
 foreach reference in array refs loop
  insert into wms_private.receipt_proofs(branch_id,reference_number,snapshot,source,operation_id,actor_id)
  values(p_branch,reference,wms_private.scan_snapshot(p_branch,reference),'direct',p_request,auth.uid());
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,reason,operation_id)
  values(p_branch,'orders',reference,'DIRECT_OUTBOUND',auth.uid(),trim(p_reason),p_request::text);
 end loop;
 delete from wms_private.scan_write_authorizations where transaction_id=txid_current()
  and actor_id=auth.uid() and branch_id=p_branch and phase='direct' and reference_number=any(refs);
 insert into wms_private.direct_outbound_requests values(p_request,p_branch,auth.uid(),p_upserts,trim(p_reason),result);
 return result;
end; $$;
revoke all on function public.direct_outbound_scanned_admin(uuid,text,jsonb,text) from public, anon;
grant execute on function public.direct_outbound_scanned_admin(uuid,text,jsonb,text) to authenticated;

create function public.get_direct_outbound_status(p_request uuid,p_branch text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior wms_private.direct_outbound_requests%rowtype;
begin
 if auth.uid() is null or not wms_private.can_access_branch(p_branch) or not exists (
  select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='Administrator'
 ) then raise exception 'Outbound langsung hanya untuk Administrator'; end if;
 select * into prior from wms_private.direct_outbound_requests r
  where r.id=p_request and r.branch_id=p_branch and r.actor_id=auth.uid();
 if not found then raise exception 'Transaksi outbound tidak ditemukan'; end if;
 return jsonb_build_object('request',prior.id,'branch',prior.branch_id,'state','finished','result',prior.result);
end; $$;
revoke all on function public.get_direct_outbound_status(uuid,text) from public, anon;
grant execute on function public.get_direct_outbound_status(uuid,text) to authenticated;

create function public.get_verified_order_receipt(p_branch text,p_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare proof wms_private.receipt_proofs%rowtype; current_snapshot jsonb; documents jsonb;
begin
 perform wms_private.scan_authorize(p_branch);
 select * into proof from wms_private.receipt_proofs r
  where r.branch_id=p_branch and r.reference_number=p_reference;
 if not found then raise exception 'Bukti resi tidak tersedia'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',d.document_id,'revision',d.revision,'sku',d.payload->>'skuId',
  'qty',d.payload->'qty','status',d.payload->>'status',
  'picked',d.payload->'picked','deducted',d.payload->'stockDeducted')
  order by d.document_id),'[]'::jsonb),
  coalesce(jsonb_agg(d.payload order by d.document_id),'[]'::jsonb)
 into current_snapshot,documents
 from public.wms_documents d where d.branch_id=p_branch
  and d.collection_name='orders' and d.payload->>'referenceNumber'=p_reference;
 if jsonb_array_length(current_snapshot)=0 or current_snapshot<>proof.snapshot or exists(
  select 1 from jsonb_array_elements(current_snapshot) v where v->>'status' is distinct from 'Completed'
 ) then raise exception 'Bukti resi tidak sesuai order terkini'; end if;
 return jsonb_build_object('branch',p_branch,'reference',p_reference,'source',proof.source,
  'operation_id',proof.operation_id,'documents',documents);
end; $$;
revoke all on function public.get_verified_order_receipt(text,text) from public, anon;
grant execute on function public.get_verified_order_receipt(text,text) to authenticated;
