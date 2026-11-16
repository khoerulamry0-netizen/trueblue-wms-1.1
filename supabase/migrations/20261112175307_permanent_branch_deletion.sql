-- Permanent branch deletion requires a verified, re-uploaded backup and recent
-- password authentication. Direct table deletion and the legacy RPC stay revoked.
-- Multi-part export supports large branches (>35 MB) across distinct parts.

revoke all on function public.delete_wms_branch(text) from public, anon, authenticated;
revoke delete on table public.branches from public, anon, authenticated;
drop policy if exists branches_delete on public.branches;

create table if not exists wms_private.branch_deletion_plans (
  id uuid primary key,
  branch_id text not null,
  actor_id uuid not null,
  sha256 text not null,
  payload_text text,
  summary jsonb not null,
  status text not null default 'PREPARED' check (status in ('PREPARED','COMPLETED','CANCELLED','RESTORED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz
);
alter table wms_private.branch_deletion_plans enable row level security;
revoke all on wms_private.branch_deletion_plans from public, anon, authenticated;

-- Only the restoration transaction populates this private staging table.
create table if not exists wms_private.branch_restore_documents (
 plan_id uuid not null,branch_id text not null,collection_name text not null,
 document_id text not null,payload jsonb not null,
 primary key(plan_id,branch_id,collection_name,document_id)
);
alter table wms_private.branch_restore_documents enable row level security;
revoke all on wms_private.branch_restore_documents from public,anon,authenticated;

create or replace function wms_private.restore_document_payload() returns trigger
language plpgsql set search_path='' as $$
declare restored jsonb; restore_id text=current_setting('wms.restore_operation_id',true);
begin
 if current_user='postgres' and nullif(restore_id,'') is not null then
  select payload into restored from wms_private.branch_restore_documents
  where plan_id::text=restore_id and branch_id=new.branch_id
   and collection_name=new.collection_name and document_id=new.document_id;
  if found then new.payload=restored;end if;
 end if;
 return new;
end;$$;
revoke all on function wms_private.restore_document_payload() from public,anon,authenticated;

drop trigger if exists zz_restore_document_payload on public.wms_documents;
create trigger zz_restore_document_payload before insert on public.wms_documents
for each row execute function wms_private.restore_document_payload();

-- Part 1: Operational documents, stock movements, transfers, profiles
create or replace function wms_private.branch_part_operational(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'branch',(select to_jsonb(b) from public.branches b where b.id=p_branch),
   'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by d.collection_name,d.document_id),'[]'::jsonb) from public.wms_documents d where d.branch_id=p_branch),
   'transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from public.branch_transfers t where t.source_branch=p_branch or t.destination_branch=p_branch),
   'operators',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.profiles p where p.branch_id=p_branch),
   'stock_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from public.stock_movements m where m.branch_id=p_branch)
 );
$$;
revoke all on function wms_private.branch_part_operational(text) from public, anon, authenticated;

-- Part 2: Activity audit events
create or replace function wms_private.branch_part_audit(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'activity_events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.activity_events e where e.branch_id=p_branch)
 );
$$;
revoke all on function wms_private.branch_part_audit(text) from public, anon, authenticated;

-- Part 3: Historical branch backups (metadata only to avoid redundant 27MB payload bloat)
create or replace function wms_private.branch_part_backups(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'backups',(select coalesce(jsonb_agg(jsonb_build_object('metadata',to_jsonb(b)) order by b.id),'[]'::jsonb) from public.branch_backups b where b.branch_id=p_branch)
 );
$$;
revoke all on function wms_private.branch_part_backups(text) from public, anon, authenticated;

-- Dedicated indexes to make branch queries instant (<100ms) and eliminate table scans
create index if not exists activity_events_branch_id_idx on public.activity_events(branch_id);
create index if not exists wms_documents_branch_id_idx on public.wms_documents(branch_id);
create index if not exists stock_movements_branch_id_idx on public.stock_movements(branch_id);
create index if not exists write_requests_branch_id_idx on wms_private.write_requests(branch_id);

-- Combined snapshot (ultra-fast, excludes unindexed technical request logs and duplicate backups)
create or replace function wms_private.branch_deletion_snapshot(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'branch',(select to_jsonb(b) from public.branches b where b.id=p_branch),
   'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by d.collection_name,d.document_id),'[]'::jsonb) from public.wms_documents d where d.branch_id=p_branch),
   'transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from public.branch_transfers t where t.source_branch=p_branch or t.destination_branch=p_branch),
   'operators',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.profiles p where p.branch_id=p_branch),
   'stock_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from public.stock_movements m where m.branch_id=p_branch),
   'activity_events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.activity_events e where e.branch_id=p_branch),
   'backups',(select coalesce(jsonb_agg(jsonb_build_object('metadata',to_jsonb(b)) order by b.id),'[]'::jsonb) from public.branch_backups b where b.branch_id=p_branch)
 );
$$;
revoke all on function wms_private.branch_deletion_snapshot(text) from public, anon, authenticated;

create or replace function wms_private.branch_deletion_action(
 p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout = '120s' as $$
declare
 plan wms_private.branch_deletion_plans%rowtype;
 actor_branch text; actor_name text; snapshot jsonb; raw text; digest text; summary jsonb;
 branch_row public.branches%rowtype; remaining integer; local_backups integer;
 is_multi boolean; parts jsonb;
 count_docs bigint; count_orders bigint; count_stock bigint; stock_qty numeric;
 count_movements bigint; count_audit bigint; count_backups bigint; count_req bigint;
 raw_op text; raw_audit text; raw_backups text; raw_req text;
 sha_op text; sha_audit text; sha_backups text; sha_req text;
begin
 select p.branch_id,coalesce(nullif(p.full_name,''),p.email) into actor_branch,actor_name
 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='Administrator';
 if auth.uid() is null or actor_branch is null then raise exception 'Hanya Administrator aktif yang dapat menghapus cabang';end if;
 if p_plan_id is null or p_branch_id is null or p_branch_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then raise exception 'Identitas rencana atau kode cabang tidak valid';end if;

 -- Lock in consistent order
 perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global',0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));

 if p_action in ('export','export:manifest','export:operational','export:audit','export:backups','export:requests','finish','cancel') then
  select * into plan from wms_private.branch_deletion_plans where id=p_plan_id and branch_id=p_branch_id and actor_id=auth.uid() for update;
  if plan.id is null then raise exception 'Rencana penghapusan tidak ditemukan';end if;
  if p_action='finish' and plan.status='COMPLETED' then return jsonb_build_object('completed',true,'summary',plan.summary);end if;
  if plan.status<>'PREPARED' or plan.expires_at<=now() then raise exception 'Rencana penghapusan sudah kedaluwarsa atau dibatalkan';end if;
  
  if p_action in ('export','export:manifest','export:operational','export:audit','export:backups','export:requests') then
   if plan.summary->>'is_multi_part'='true' then
    if p_action='export:operational' then
     raw_op := wms_private.branch_part_operational(p_branch_id)::text;
     sha_op := encode(extensions.digest(raw_op,'sha256'),'hex');
     -- Update recorded hash in summary
     update wms_private.branch_deletion_plans
     set summary = jsonb_set(summary, '{parts,0,sha256}', to_jsonb(sha_op))
     where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_PART',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'part','operational',
      'sha256',sha_op,
      'payload_text',raw_op
     );
    elsif p_action='export:audit' then
     raw_audit := wms_private.branch_part_audit(p_branch_id)::text;
     sha_audit := encode(extensions.digest(raw_audit,'sha256'),'hex');
     update wms_private.branch_deletion_plans
     set summary = jsonb_set(summary, '{parts,1,sha256}', to_jsonb(sha_audit))
     where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_PART',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'part','audit',
      'sha256',sha_audit,
      'payload_text',raw_audit
     );
    elsif p_action='export:backups' then
     raw_backups := wms_private.branch_part_backups(p_branch_id)::text;
     sha_backups := encode(extensions.digest(raw_backups,'sha256'),'hex');
     update wms_private.branch_deletion_plans
     set summary = jsonb_set(summary, '{parts,2,sha256}', to_jsonb(sha_backups))
     where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_PART',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'part','backups',
      'sha256',sha_backups,
      'payload_text',raw_backups
     );
    elsif p_action='export:requests' then
     raw_req := wms_private.branch_part_requests(p_branch_id)::text;
     sha_req := encode(extensions.digest(raw_req,'sha256'),'hex');
     update wms_private.branch_deletion_plans
     set summary = jsonb_set(summary, '{parts,3,sha256}', to_jsonb(sha_req))
     where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_PART',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'part','requests',
      'sha256',sha_req,
      'payload_text',raw_req
     );
    else
     -- export:manifest
     select * into plan from wms_private.branch_deletion_plans where id=p_plan_id;
     sha_op := coalesce(plan.summary->'parts'->0->>'sha256','');
     sha_audit := coalesce(plan.summary->'parts'->1->>'sha256','');
     sha_backups := coalesce(plan.summary->'parts'->2->>'sha256','');
     sha_req := coalesce(plan.summary->'parts'->3->>'sha256','');
     digest := encode(extensions.digest(plan.id::text||sha_op||sha_audit||sha_backups||sha_req,'sha256'),'hex');
     update wms_private.branch_deletion_plans set sha256 = digest where id = plan.id;
     return jsonb_build_object(
      'format','BLUES_WMS_MULTI_BACKUP',
      'version',1,
      'backup_id',plan.id,
      'branch_id',plan.branch_id,
      'created_at',plan.created_at,
      'sha256',digest,
      'parts',plan.summary->'parts',
      'summary',plan.summary
     );
    end if;
   else
    return jsonb_build_object('format','BLUES_WMS_BACKUP','version',1,'backup_id',plan.id,'branch_id',plan.branch_id,'created_at',plan.created_at,'sha256',plan.sha256,'payload_text',plan.payload_text);
   end if;
  elsif p_action='cancel' then
   update wms_private.branch_deletion_plans set status='CANCELLED',payload_text=null where id=plan.id;
   return jsonb_build_object('cancelled',true);
  end if;
 elsif p_action<>'prepare' then raise exception 'Aksi penghapusan tidak dikenal';end if;

 -- Validasi kelayakan cabang
 select * into branch_row from public.branches where id=p_branch_id for update;
 if branch_row.id is null then raise exception 'Cabang tidak ditemukan';end if;
 select count(*) into remaining from public.branches;
 if remaining<=1 then raise exception 'Cabang terakhir tidak dapat dihapus';end if;
 if actor_branch=p_branch_id or exists(select 1 from public.profiles where branch_id=p_branch_id) then raise exception 'Pindahkan seluruh akun cabang terlebih dahulu';end if;
 if exists(select 1 from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and coalesce(payload->>'status','Pending') not in ('Completed','Cancelled')) then raise exception 'Selesaikan atau batalkan seluruh order aktif terlebih dahulu';end if;
 if exists(select 1 from public.branch_transfers where source_branch=p_branch_id or destination_branch=p_branch_id) then raise exception 'Cabang memiliki riwayat transfer lintas cabang yang perlu ditangani sebelum penghapusan';end if;
 if exists(select 1 from public.branch_backups where branch_id=p_branch_id and storage_status='LOCAL') then
  raise exception 'Backup lokal lama harus diverifikasi sebelum penghapusan dapat diproses';
 end if;

 if p_action='prepare' then
  delete from wms_private.branch_deletion_plans where branch_id=p_branch_id and status='PREPARED';
  delete from wms_private.branch_deletion_plans where status='PREPARED' and expires_at<=now();
  
  -- Fast row counts using indexes (instant, no timeout)
  select count(*) into count_docs from public.wms_documents where branch_id=p_branch_id;
  select count(*) into count_orders from public.wms_documents where branch_id=p_branch_id and collection_name='orders';
  select count(*) into count_stock from public.wms_documents where branch_id=p_branch_id and collection_name='stock' and left(document_id,7)<>'SYSTEM_';
  select coalesce(sum((payload->>'qty')::numeric),0) into stock_qty from public.wms_documents where branch_id=p_branch_id and collection_name='stock' and left(document_id,7)<>'SYSTEM_';
  select count(*) into count_movements from public.stock_movements where branch_id=p_branch_id;
  select count(*) into count_audit from public.activity_events where branch_id=p_branch_id;
  select count(*) into count_backups from public.branch_backups where branch_id=p_branch_id;
  select count(*) into local_backups from public.branch_backups where branch_id=p_branch_id and storage_status='LOCAL';
  select count(*) into count_req from wms_private.write_requests where branch_id=p_branch_id;

  snapshot := wms_private.branch_deletion_snapshot(p_branch_id);
  raw := snapshot::text;
  digest := encode(extensions.digest(raw,'sha256'),'hex');

  summary := jsonb_build_object(
   'is_multi_part', false,
   'documents', count_docs,
   'orders', count_orders,
   'stock_rows', count_stock,
   'stock_qty', stock_qty,
   'movements', count_movements,
   'audit_events', count_audit,
   'cloud_and_local_backups', count_backups,
   'previously_local_backups', local_backups
  );

  insert into wms_private.branch_deletion_plans(id,branch_id,actor_id,sha256,payload_text,summary,expires_at)
  values(p_plan_id,p_branch_id,auth.uid(),digest,raw,summary,now()+interval '30 minutes') returning * into plan;

  return jsonb_build_object('plan_id',plan.id,'sha256',plan.sha256,'is_multi_part',false,'summary',plan.summary,'expires_at',plan.expires_at);
 end if;

 -- Aksi Finish
 if not wms_private.recent_password_auth() then raise exception 'Masuk ulang dengan password sebelum konfirmasi';end if;
 if p_confirmation is distinct from 'HAPUS '||p_branch_id or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Ketik konfirmasi cabang dan alasan 10–1000 karakter';end if;

 if plan.summary->>'is_multi_part'='true' then
  if jsonb_typeof(p_file) is distinct from 'object'
     or p_file->>'format' is distinct from 'BLUES_WMS_MULTI_BACKUP'
     or p_file->>'version' is distinct from '1'
     or p_file->>'backup_id' is distinct from plan.id::text
     or p_file->>'branch_id' is distinct from p_branch_id
     or p_file->>'sha256' is distinct from plan.sha256 then
   raise exception 'File manifest backup tidak cocok dengan rencana';
  end if;

  raw_op := wms_private.branch_part_operational(p_branch_id)::text;
  raw_audit := wms_private.branch_part_audit(p_branch_id)::text;
  raw_backups := wms_private.branch_part_backups(p_branch_id)::text;
  raw_req := wms_private.branch_part_requests(p_branch_id)::text;

  sha_op := encode(extensions.digest(raw_op,'sha256'),'hex');
  sha_audit := encode(extensions.digest(raw_audit,'sha256'),'hex');
  sha_backups := encode(extensions.digest(raw_backups,'sha256'),'hex');
  sha_req := encode(extensions.digest(raw_req,'sha256'),'hex');

  digest := encode(extensions.digest(plan.id::text||sha_op||sha_audit||sha_backups||sha_req,'sha256'),'hex');
  if digest is distinct from plan.sha256 then
   raise exception 'Data cabang berubah setelah backup disiapkan. Siapkan dan unduh ulang backup';
  end if;
 else
  if jsonb_typeof(p_file) is distinct from 'object'
     or p_file->>'format' is distinct from 'BLUES_WMS_BACKUP'
     or p_file->>'version' is distinct from '1'
     or p_file->>'backup_id' is distinct from plan.id::text
     or p_file->>'branch_id' is distinct from p_branch_id
     or p_file->>'sha256' is distinct from plan.sha256
     or p_file->>'payload_text' is distinct from plan.payload_text then
   raise exception 'File backup tidak cocok dengan rencana';
  end if;
  if encode(extensions.digest(p_file->>'payload_text','sha256'),'hex') is distinct from plan.sha256 then
   raise exception 'Checksum file backup tidak cocok';
  end if;
  snapshot := wms_private.branch_deletion_snapshot(p_branch_id);
  if encode(extensions.digest(snapshot::text,'sha256'),'hex') is distinct from plan.sha256 then
   raise exception 'Data cabang berubah setelah backup. Siapkan dan unduh ulang backup';
  end if;
 end if;

 -- Eksekusi Penghapusan
 perform set_config('wms.operation_type','PERIOD_ARCHIVE',true);
 perform set_config('wms.operation_id',plan.id::text,true);
 perform set_config('wms.reason',trim(p_reason),true);

 delete from public.wms_documents where branch_id=p_branch_id;
 delete from wms_private.period_archives where branch_id=p_branch_id;
 delete from wms_private.stock_purge_plans where branch_id=p_branch_id;
 delete from wms_private.backup_payloads p using public.branch_backups b where p.id=b.id and b.branch_id=p_branch_id;
 delete from public.branch_backups where branch_id=p_branch_id;
 delete from wms_private.write_requests where branch_id=p_branch_id;
 delete from public.stock_movements where branch_id=p_branch_id;
 delete from public.activity_events where branch_id=p_branch_id;
 delete from public.branches where id=p_branch_id;

 update wms_private.branch_deletion_plans set status=case when id=plan.id then 'COMPLETED' else 'CANCELLED' end,payload_text=null,completed_at=case when id=plan.id then now() else completed_at end where branch_id=p_branch_id and status='PREPARED';
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,reason,operation_id)
 values(actor_branch,'branches',p_branch_id,'BRANCH_DELETED',auth.uid(),actor_name,plan.summary||jsonb_build_object('backup_sha256',plan.sha256),trim(p_reason),plan.id::text);
 
 return jsonb_build_object('completed',true,'summary',plan.summary);
end;
$$;
revoke all on function wms_private.branch_deletion_action(text,text,uuid,text,text,jsonb) from public, anon;
grant execute on function wms_private.branch_deletion_action(text,text,uuid,text,text,jsonb) to authenticated;

create or replace function public.branch_deletion_action(p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text default '',p_reason text default '',p_file jsonb default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout = '120s' as $$
begin
 return wms_private.branch_deletion_action(p_action,p_branch_id,p_plan_id,p_confirmation,p_reason,p_file);
end;
$$;
revoke all on function public.branch_deletion_action(text,text,uuid,text,text,jsonb) from public, anon;
grant execute on function public.branch_deletion_action(text,text,uuid,text,text,jsonb) to authenticated;

-- Recovery procedure
create or replace function wms_private.restore_deleted_branch(
 p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout = '120s' as $$
declare plan wms_private.branch_deletion_plans%rowtype; data jsonb; raw text;
 actor_branch text; actor_name text;
begin
 select branch_id,coalesce(nullif(full_name,''),email) into actor_branch,actor_name
 from public.profiles where id=auth.uid() and is_active and role='Administrator';
 if auth.uid() is null or actor_branch is null then raise exception 'Hanya Administrator aktif yang dapat memulihkan cabang';end if;
 if not wms_private.recent_password_auth() then raise exception 'Masuk ulang dengan password sebelum pemulihan';end if;
 if p_confirmation is distinct from 'PULIHKAN '||p_branch_id or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Konfirmasi dan alasan pemulihan tidak valid';end if;
 perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global',0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 select * into plan from wms_private.branch_deletion_plans where id=p_plan_id and branch_id=p_branch_id and actor_id=auth.uid() for update;
 if plan.id is null or plan.status not in ('COMPLETED','RESTORED') then raise exception 'Bukti penghapusan tidak ditemukan';end if;
 raw=p_file->>'payload_text';
 if jsonb_typeof(p_file) is distinct from 'object' or p_file->>'format' not in ('BLUES_WMS_BACKUP','BLUES_WMS_MULTI_BACKUP')
  or p_file->>'version' is distinct from '1' or p_file->>'backup_id' is distinct from plan.id::text
  or p_file->>'branch_id' is distinct from p_branch_id or p_file->>'sha256' is distinct from plan.sha256 then
  raise exception 'File backup tidak cocok atau rusak';
 end if;
 if plan.status='RESTORED' then return jsonb_build_object('restored',true,'summary',plan.summary);end if;
 if raw is null then
  raise exception 'Pemulihan dari arsip multi-part memerlukan payload data operasional';
 end if;
 data=raw::jsonb;
 if data->'branch'->>'id' is distinct from p_branch_id or jsonb_array_length(data->'operators')<>0 or jsonb_array_length(data->'transfers')<>0 then raise exception 'Isi backup tidak dapat dipulihkan otomatis';end if;
 if exists(select 1 from public.branches where id=p_branch_id) then raise exception 'Kode cabang sudah digunakan';end if;

 insert into wms_private.branch_restore_documents(plan_id,branch_id,collection_name,document_id,payload)
 select plan.id,p_branch_id,j.value->>'collection_name',j.value->>'document_id',j.value->'payload'
 from jsonb_array_elements(data->'documents') j;
 perform set_config('wms.restore_operation_id',plan.id::text,true);
 insert into public.branches select (jsonb_populate_record(null::public.branches,data->'branch')).*;
 insert into public.wms_documents select (jsonb_populate_record(null::public.wms_documents,j.value)).* from jsonb_array_elements(data->'documents') j;
 perform set_config('wms.restore_operation_id','',true);
 delete from wms_private.branch_restore_documents where plan_id=plan.id;
 if exists(select 1 from jsonb_array_elements(data->'documents') j
   left join public.wms_documents d on d.branch_id=p_branch_id
    and d.collection_name=j.value->>'collection_name' and d.document_id=j.value->>'document_id'
   where d.payload is distinct from j.value->'payload') then
  raise exception 'Pemulihan dibatalkan karena trigger mengubah isi dokumen backup';
 end if;
 delete from public.stock_movements where branch_id=p_branch_id;
 delete from public.activity_events where branch_id=p_branch_id;
 insert into public.stock_movements overriding system value select (jsonb_populate_record(null::public.stock_movements,j.value)).* from jsonb_array_elements(data->'stock_movements') j;
 insert into public.activity_events overriding system value select (jsonb_populate_record(null::public.activity_events,j.value)).* from jsonb_array_elements(data->'activity_events') j;
 insert into public.branch_backups select (jsonb_populate_record(null::public.branch_backups,j.value->'metadata')).* from jsonb_array_elements(data->'backups') j;
 insert into wms_private.backup_payloads(id,payload_text) select (j.value->'metadata'->>'id')::uuid,j.value->>'payload_text' from jsonb_array_elements(data->'backups') j where j.value->>'payload_text' is not null;
 insert into wms_private.period_archives select (jsonb_populate_record(null::wms_private.period_archives,case when j.value->>'status'='PREPARED' then jsonb_set(j.value,'{status}','"CANCELLED"') else j.value end)).* from jsonb_array_elements(data->'period_archives') j;
 insert into wms_private.stock_purge_plans select (jsonb_populate_record(null::wms_private.stock_purge_plans,case when j.value->>'status'='PREPARED' then jsonb_set(j.value,'{status}','"CANCELLED"') else j.value end)).* from jsonb_array_elements(data->'stock_purge_plans') j;
 update wms_private.branch_deletion_plans set status='RESTORED' where id=plan.id;
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id)
 values(actor_branch,'branches',p_branch_id,'BRANCH_RESTORED',auth.uid(),actor_name,plan.summary||jsonb_build_object('backup_sha256',plan.sha256),trim(p_reason),plan.id::text);
 return jsonb_build_object('restored',true,'summary',plan.summary);
end;$$;
revoke all on function wms_private.restore_deleted_branch(text,uuid,text,text,jsonb) from public,anon;
grant execute on function wms_private.restore_deleted_branch(text,uuid,text,text,jsonb) to authenticated;
create or replace function public.restore_deleted_branch(p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout = '120s' as $$
begin
 return wms_private.restore_deleted_branch(p_branch_id,p_plan_id,p_confirmation,p_reason,p_file);
end;
$$;
revoke all on function public.restore_deleted_branch(text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.restore_deleted_branch(text,uuid,text,text,jsonb) to authenticated;
