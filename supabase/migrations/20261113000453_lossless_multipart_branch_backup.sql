-- Lossless multipart branch deletion backup.
-- Every row removed by the workflow is represented in one of four immutable
-- recovery parts. Parts remain private and are retained after deletion so a
-- verified manifest can restore the branch transactionally.

create table if not exists wms_private.branch_deletion_parts (
  plan_id uuid not null references wms_private.branch_deletion_plans(id) on delete cascade,
  part_name text not null check (part_name in ('operational','audit','backups','requests')),
  ordinal smallint not null check (ordinal between 1 and 4),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  payload_text text not null,
  exported_at timestamptz not null default now(),
  primary key (plan_id, part_name),
  unique (plan_id, ordinal)
);
alter table wms_private.branch_deletion_parts enable row level security;
revoke all on table wms_private.branch_deletion_parts from public, anon, authenticated;

alter table wms_private.branch_restore_documents
  add column if not exists row_data jsonb;

create or replace function wms_private.restore_document_payload() returns trigger
language plpgsql set search_path='' as $$
declare restored jsonb; restore_id text=current_setting('wms.restore_operation_id',true);
begin
 if current_user='postgres' and nullif(restore_id,'') is not null then
  select coalesce(row_data,jsonb_build_object('payload',payload)) into restored
  from wms_private.branch_restore_documents
  where plan_id::text=restore_id and branch_id=new.branch_id
   and collection_name=new.collection_name and document_id=new.document_id;
  if found then new=jsonb_populate_record(new,restored);end if;
 end if;
 return new;
end;$$;
revoke all on function wms_private.restore_document_payload() from public,anon,authenticated;

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

create or replace function wms_private.branch_part_audit(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'activity_events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.activity_events e where e.branch_id=p_branch)
 );
$$;

create or replace function wms_private.branch_part_backups(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'backups',(
     select coalesce(jsonb_agg(
       jsonb_build_object('metadata',to_jsonb(b),'payload_text',p.payload_text)
       order by b.id
     ),'[]'::jsonb)
     from public.branch_backups b
     left join wms_private.backup_payloads p on p.id=b.id
     where b.branch_id=p_branch
   )
 );
$$;

create or replace function wms_private.branch_part_requests(p_branch text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'write_requests',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from wms_private.write_requests r where r.branch_id=p_branch),
   'period_archives',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from wms_private.period_archives a where a.branch_id=p_branch),
   'stock_purge_plans',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) from wms_private.stock_purge_plans s where s.branch_id=p_branch)
 );
$$;

revoke all on function wms_private.branch_part_operational(text) from public,anon,authenticated;
revoke all on function wms_private.branch_part_audit(text) from public,anon,authenticated;
revoke all on function wms_private.branch_part_backups(text) from public,anon,authenticated;
revoke all on function wms_private.branch_part_requests(text) from public,anon,authenticated;

create or replace function wms_private.branch_deletion_action_v2(
 p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='180s' as $$
declare
 plan wms_private.branch_deletion_plans%rowtype;
 actor_branch text; actor_name text; branch_row public.branches%rowtype;
 raw text; digest text; part text; ord smallint; plan_summary jsonb; parts jsonb;
 remaining integer; local_backups integer; expected_count integer;
 count_docs bigint; count_orders bigint; count_stock bigint; stock_qty numeric;
 count_movements bigint; count_audit bigint; count_backups bigint; count_req bigint;
 stored_sha text; current_sha text; all_hashes text;
begin
 select p.branch_id,coalesce(nullif(p.full_name,''),p.email) into actor_branch,actor_name
 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='Administrator';
 if auth.uid() is null or actor_branch is null or not wms_private.is_hq() then raise exception 'Hanya Administrator aktif kantor pusat yang dapat menghapus cabang';end if;
 if p_plan_id is null or p_branch_id is null or p_branch_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then raise exception 'Identitas rencana atau kode cabang tidak valid';end if;

 perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global',0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));

 if p_action='prepare' then
  select * into branch_row from public.branches where id=p_branch_id for update;
  if branch_row.id is null then raise exception 'Cabang tidak ditemukan';end if;
  select count(*) into remaining from public.branches;
  if remaining<=1 then raise exception 'Cabang terakhir tidak dapat dihapus';end if;
  if actor_branch=p_branch_id or exists(select 1 from public.profiles where branch_id=p_branch_id) then raise exception 'Pindahkan seluruh akun cabang terlebih dahulu';end if;
  if exists(select 1 from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and coalesce(payload->>'status','Pending') not in ('Completed','Cancelled')) then raise exception 'Selesaikan atau batalkan seluruh order aktif terlebih dahulu';end if;
  if exists(select 1 from public.branch_transfers where source_branch=p_branch_id or destination_branch=p_branch_id) then raise exception 'Cabang memiliki riwayat transfer lintas cabang yang perlu ditangani sebelum penghapusan';end if;
  if exists(select 1 from public.branch_backups where branch_id=p_branch_id and storage_status='LOCAL') then raise exception 'Backup lokal lama harus diverifikasi sebelum penghapusan dapat diproses';end if;

  update wms_private.branch_deletion_plans set status='CANCELLED',payload_text=null
  where branch_id=p_branch_id and status='PREPARED';
  delete from wms_private.branch_deletion_plans where status='PREPARED' and expires_at<=now();

  select count(*) into count_docs from public.wms_documents where branch_id=p_branch_id;
  select count(*) into count_orders from public.wms_documents where branch_id=p_branch_id and collection_name='orders';
  select count(*) into count_stock from public.wms_documents where branch_id=p_branch_id and collection_name='stock' and left(document_id,7)<>'SYSTEM_';
  select coalesce(sum((payload->>'qty')::numeric),0) into stock_qty from public.wms_documents where branch_id=p_branch_id and collection_name='stock' and left(document_id,7)<>'SYSTEM_';
  select count(*) into count_movements from public.stock_movements where branch_id=p_branch_id;
  select count(*) into count_audit from public.activity_events where branch_id=p_branch_id;
  select count(*) into count_backups from public.branch_backups where branch_id=p_branch_id;
  select count(*) into local_backups from public.branch_backups where branch_id=p_branch_id and storage_status='LOCAL';
  select count(*) into count_req from wms_private.write_requests where branch_id=p_branch_id;

  parts=jsonb_build_array(
   jsonb_build_object('part','operational','label','Data operasional','filename','operational.json','sha256','','bytes',0),
   jsonb_build_object('part','audit','label','Riwayat audit','filename','audit.json','sha256','','bytes',0),
   jsonb_build_object('part','backups','label','Backup historis','filename','backups.json','sha256','','bytes',0),
   jsonb_build_object('part','requests','label','Request dan arsip','filename','requests.json','sha256','','bytes',0)
  );
  plan_summary=jsonb_build_object('is_multi_part',true,'format_version',2,'documents',count_docs,'orders',count_orders,
   'stock_rows',count_stock,'stock_qty',stock_qty,'movements',count_movements,'audit_events',count_audit,
   'cloud_and_local_backups',count_backups,'previously_local_backups',local_backups,'write_requests',count_req,'parts',parts);
  insert into wms_private.branch_deletion_plans(id,branch_id,actor_id,sha256,payload_text,summary,expires_at)
  values(p_plan_id,p_branch_id,auth.uid(),repeat('0',64),null,plan_summary,now()+interval '60 minutes') returning * into plan;
  return jsonb_build_object('plan_id',plan.id,'sha256',plan.sha256,'is_multi_part',true,'parts',parts,'summary',plan_summary,'expires_at',plan.expires_at);
 end if;

 select * into plan from wms_private.branch_deletion_plans
 where id=p_plan_id and branch_id=p_branch_id and actor_id=auth.uid() for update;
 if plan.id is null then raise exception 'Rencana penghapusan tidak ditemukan';end if;
 if p_action='finish' and plan.status='COMPLETED' then return jsonb_build_object('completed',true,'summary',plan.summary);end if;
 if p_action='cancel' then
  if plan.status='PREPARED' then update wms_private.branch_deletion_plans set status='CANCELLED',payload_text=null where id=plan.id;end if;
  return jsonb_build_object('cancelled',true);
 end if;
 if plan.status<>'PREPARED' or plan.expires_at<=now() then raise exception 'Rencana penghapusan sudah kedaluwarsa atau dibatalkan';end if;

 if p_action like 'export:%' and p_action<>'export:manifest' then
  part=substr(p_action,8);
  if part='operational' then raw=wms_private.branch_part_operational(p_branch_id)::text;ord=1;
  elsif part='audit' then raw=wms_private.branch_part_audit(p_branch_id)::text;ord=2;
  elsif part='backups' then raw=wms_private.branch_part_backups(p_branch_id)::text;ord=3;
  elsif part='requests' then raw=wms_private.branch_part_requests(p_branch_id)::text;ord=4;
  else raise exception 'Bagian backup tidak dikenal';end if;
  digest=encode(extensions.digest(raw,'sha256'),'hex');
  insert into wms_private.branch_deletion_parts(plan_id,part_name,ordinal,sha256,payload_text)
  values(plan.id,part,ord,digest,raw)
  on conflict(plan_id,part_name) do update set ordinal=excluded.ordinal,sha256=excluded.sha256,payload_text=excluded.payload_text,exported_at=now();
  return jsonb_build_object('format','BLUES_WMS_PART','version',2,'backup_id',plan.id,'branch_id',plan.branch_id,
   'part',part,'sha256',digest,'bytes',octet_length(raw),'payload_text',raw);
 end if;

 if p_action in ('export','export:manifest') then
  select count(*),string_agg(sha256,'' order by ordinal) into expected_count,all_hashes
  from wms_private.branch_deletion_parts where plan_id=plan.id;
  if expected_count<>4 then raise exception 'Unduh keempat bagian backup sebelum membuat manifest';end if;
  digest=encode(extensions.digest(plan.id::text||all_hashes,'sha256'),'hex');
  select jsonb_agg(jsonb_build_object('part',d.part_name,'label',case d.part_name when 'operational' then 'Data operasional' when 'audit' then 'Riwayat audit' when 'backups' then 'Backup historis' else 'Request dan arsip' end,
    'filename',d.part_name||'.json','sha256',d.sha256,'bytes',octet_length(d.payload_text)) order by d.ordinal)
  into parts from wms_private.branch_deletion_parts d where d.plan_id=plan.id;
  plan_summary=jsonb_set(plan.summary,'{parts}',parts);
  update wms_private.branch_deletion_plans d set sha256=digest,summary=plan_summary where d.id=plan.id returning * into plan;
  return jsonb_build_object('format','BLUES_WMS_MULTI_BACKUP','version',2,'backup_id',plan.id,'branch_id',plan.branch_id,
   'created_at',plan.created_at,'sha256',digest,'parts',parts,'summary',plan_summary);
 end if;

 if p_action<>'finish' then raise exception 'Aksi penghapusan tidak dikenal';end if;
 if not wms_private.recent_password_auth() then raise exception 'Masuk ulang dengan password sebelum konfirmasi';end if;
 if p_confirmation is distinct from 'HAPUS '||p_branch_id or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Ketik konfirmasi cabang dan alasan 10-1000 karakter';end if;
 if jsonb_typeof(p_file) is distinct from 'object' or p_file->>'format' is distinct from 'BLUES_WMS_MULTI_BACKUP'
   or p_file->>'version' is distinct from '2' or p_file->>'backup_id' is distinct from plan.id::text
   or p_file->>'branch_id' is distinct from p_branch_id or p_file->>'sha256' is distinct from plan.sha256 then
  raise exception 'Manifest backup tidak cocok dengan rencana';
 end if;

 for part,ord in select v.part_name,v.part_ordinal from (values ('operational',1::smallint),('audit',2::smallint),('backups',3::smallint),('requests',4::smallint)) v(part_name,part_ordinal) loop
  select sha256 into stored_sha from wms_private.branch_deletion_parts where plan_id=plan.id and part_name=part;
  if part='operational' then raw=wms_private.branch_part_operational(p_branch_id)::text;
  elsif part='audit' then raw=wms_private.branch_part_audit(p_branch_id)::text;
  elsif part='backups' then raw=wms_private.branch_part_backups(p_branch_id)::text;
  else raw=wms_private.branch_part_requests(p_branch_id)::text;end if;
  current_sha=encode(extensions.digest(raw,'sha256'),'hex');
  if stored_sha is null or current_sha is distinct from stored_sha then raise exception 'Data cabang berubah setelah backup. Unduh ulang seluruh bagian';end if;
 end loop;
 select string_agg(sha256,'' order by ordinal) into all_hashes from wms_private.branch_deletion_parts where plan_id=plan.id;
 if encode(extensions.digest(plan.id::text||all_hashes,'sha256'),'hex') is distinct from plan.sha256 then raise exception 'Checksum manifest tidak cocok';end if;

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
 update wms_private.branch_deletion_plans set status='COMPLETED',payload_text=null,completed_at=now() where id=plan.id;
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,before_data,reason,operation_id)
 values(actor_branch,'branches',p_branch_id,'BRANCH_DELETED',auth.uid(),actor_name,plan.summary||jsonb_build_object('backup_sha256',plan.sha256),trim(p_reason),plan.id::text);
 return jsonb_build_object('completed',true,'summary',plan.summary);
end;
$$;
revoke all on function wms_private.branch_deletion_action_v2(text,text,uuid,text,text,jsonb) from public,anon,authenticated;

create or replace function public.branch_deletion_action(p_action text,p_branch_id text,p_plan_id uuid,p_confirmation text default '',p_reason text default '',p_file jsonb default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='180s' as $$
begin return wms_private.branch_deletion_action_v2(p_action,p_branch_id,p_plan_id,p_confirmation,p_reason,p_file);end;
$$;
revoke all on function public.branch_deletion_action(text,text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.branch_deletion_action(text,text,uuid,text,text,jsonb) to authenticated;

create or replace function wms_private.restore_deleted_branch_v2(
 p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='180s' as $$
declare
 plan wms_private.branch_deletion_plans%rowtype; actor_branch text; actor_name text;
 op jsonb;audit_data jsonb;backups_data jsonb;requests_data jsonb;
 raw text;stored_sha text;all_hashes text;digest text;part text;
begin
 select branch_id,coalesce(nullif(full_name,''),email) into actor_branch,actor_name
 from public.profiles where id=auth.uid() and is_active and role='Administrator';
 if auth.uid() is null or actor_branch is null or not wms_private.is_hq() then raise exception 'Hanya Administrator aktif kantor pusat yang dapat memulihkan cabang';end if;
 if not wms_private.recent_password_auth() then raise exception 'Masuk ulang dengan password sebelum pemulihan';end if;
 if p_confirmation is distinct from 'PULIHKAN '||p_branch_id or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Konfirmasi dan alasan pemulihan tidak valid';end if;
 perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global',0));
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 select * into plan from wms_private.branch_deletion_plans where id=p_plan_id and branch_id=p_branch_id for update;
 if plan.id is null or plan.status not in ('COMPLETED','RESTORED') then raise exception 'Bukti penghapusan tidak ditemukan';end if;
 if plan.status='RESTORED' then return jsonb_build_object('restored',true,'summary',plan.summary);end if;
 if jsonb_typeof(p_file) is distinct from 'object' or p_file->>'format' is distinct from 'BLUES_WMS_MULTI_BACKUP'
   or p_file->>'version' is distinct from '2' or p_file->>'backup_id' is distinct from plan.id::text
   or p_file->>'branch_id' is distinct from p_branch_id or p_file->>'sha256' is distinct from plan.sha256 then raise exception 'Manifest backup tidak cocok atau rusak';end if;
 select string_agg(sha256,'' order by ordinal) into all_hashes from wms_private.branch_deletion_parts where plan_id=plan.id;
 if all_hashes is null or (select count(*) from wms_private.branch_deletion_parts where plan_id=plan.id)<>4
   or encode(extensions.digest(plan.id::text||all_hashes,'sha256'),'hex') is distinct from plan.sha256 then raise exception 'Arsip recovery server tidak lengkap';end if;
 select payload_text::jsonb into op from wms_private.branch_deletion_parts where plan_id=plan.id and part_name='operational';
 select payload_text::jsonb into audit_data from wms_private.branch_deletion_parts where plan_id=plan.id and part_name='audit';
 select payload_text::jsonb into backups_data from wms_private.branch_deletion_parts where plan_id=plan.id and part_name='backups';
 select payload_text::jsonb into requests_data from wms_private.branch_deletion_parts where plan_id=plan.id and part_name='requests';
 if op->'branch'->>'id' is distinct from p_branch_id or jsonb_array_length(op->'operators')<>0 or jsonb_array_length(op->'transfers')<>0 then raise exception 'Isi backup tidak dapat dipulihkan otomatis';end if;
 if exists(select 1 from public.branches where id=p_branch_id) then raise exception 'Kode cabang sudah digunakan';end if;

 insert into wms_private.branch_restore_documents(plan_id,branch_id,collection_name,document_id,payload,row_data)
 select plan.id,p_branch_id,j.value->>'collection_name',j.value->>'document_id',j.value->'payload',j.value from jsonb_array_elements(op->'documents') j;
 perform set_config('wms.restore_operation_id',plan.id::text,true);
 insert into public.branches select (jsonb_populate_record(null::public.branches,op->'branch')).*;
 insert into public.wms_documents select (jsonb_populate_record(null::public.wms_documents,j.value)).* from jsonb_array_elements(op->'documents') j;
 perform set_config('wms.restore_operation_id','',true);
 delete from wms_private.branch_restore_documents where plan_id=plan.id;
 if exists(select 1 from jsonb_array_elements(op->'documents') j left join public.wms_documents d on d.branch_id=p_branch_id and d.collection_name=j.value->>'collection_name' and d.document_id=j.value->>'document_id' where d.payload is distinct from j.value->'payload') then raise exception 'Pemulihan dibatalkan karena trigger mengubah isi dokumen backup';end if;
 delete from public.stock_movements where branch_id=p_branch_id;
 delete from public.activity_events where branch_id=p_branch_id;
 insert into public.stock_movements overriding system value select (jsonb_populate_record(null::public.stock_movements,j.value)).* from jsonb_array_elements(op->'stock_movements') j;
 insert into public.activity_events overriding system value select (jsonb_populate_record(null::public.activity_events,j.value)).* from jsonb_array_elements(audit_data->'activity_events') j;
 insert into public.branch_backups select (jsonb_populate_record(null::public.branch_backups,j.value->'metadata')).* from jsonb_array_elements(backups_data->'backups') j;
 insert into wms_private.backup_payloads(id,payload_text) select (j.value->'metadata'->>'id')::uuid,j.value->>'payload_text' from jsonb_array_elements(backups_data->'backups') j where j.value->>'payload_text' is not null;
 insert into wms_private.write_requests select (jsonb_populate_record(null::wms_private.write_requests,j.value)).* from jsonb_array_elements(requests_data->'write_requests') j;
 insert into wms_private.period_archives select (jsonb_populate_record(null::wms_private.period_archives,j.value)).* from jsonb_array_elements(requests_data->'period_archives') j;
 insert into wms_private.stock_purge_plans select (jsonb_populate_record(null::wms_private.stock_purge_plans,j.value)).* from jsonb_array_elements(requests_data->'stock_purge_plans') j;

 for part in select unnest(array['operational','audit','backups','requests']) loop
  select sha256 into stored_sha from wms_private.branch_deletion_parts where plan_id=plan.id and part_name=part;
  if part='operational' then raw=wms_private.branch_part_operational(p_branch_id)::text;
  elsif part='audit' then raw=wms_private.branch_part_audit(p_branch_id)::text;
  elsif part='backups' then raw=wms_private.branch_part_backups(p_branch_id)::text;
  else raw=wms_private.branch_part_requests(p_branch_id)::text;end if;
  if encode(extensions.digest(raw,'sha256'),'hex') is distinct from stored_sha then raise exception 'Pemulihan tidak identik untuk bagian %',part;end if;
 end loop;
 update wms_private.branch_deletion_plans set status='RESTORED' where id=plan.id;
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id)
 values(actor_branch,'branches',p_branch_id,'BRANCH_RESTORED',auth.uid(),actor_name,plan.summary||jsonb_build_object('backup_sha256',plan.sha256),trim(p_reason),plan.id::text);
 return jsonb_build_object('restored',true,'summary',plan.summary);
end;
$$;
revoke all on function wms_private.restore_deleted_branch_v2(text,uuid,text,text,jsonb) from public,anon,authenticated;

create or replace function public.restore_deleted_branch(p_branch_id text,p_plan_id uuid,p_confirmation text,p_reason text,p_file jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='180s' as $$
begin return wms_private.restore_deleted_branch_v2(p_branch_id,p_plan_id,p_confirmation,p_reason,p_file);end;
$$;
revoke all on function public.restore_deleted_branch(text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.restore_deleted_branch(text,uuid,text,text,jsonb) to authenticated;
