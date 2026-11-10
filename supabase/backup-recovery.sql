
create table public.branch_backups (
 id uuid primary key default gen_random_uuid(),branch_id text not null references public.branches(id),
 kind text not null,document_count integer not null,stock_qty numeric not null,sha256 text not null,
 created_by uuid references auth.users(id) on delete set null,created_at timestamptz not null default now()
);
create index branch_backups_branch_time_idx on public.branch_backups(branch_id,created_at desc);
alter table public.branch_backups enable row level security;
revoke all on public.branch_backups from public,anon,authenticated;
grant select on public.branch_backups to authenticated;
create policy branch_backups_admin_read on public.branch_backups for select to authenticated using(public.wms_is_admin() and wms_private.can_access_branch(branch_id));
create table wms_private.backup_payloads(id uuid primary key references public.branch_backups(id),payload_text text not null);
alter table wms_private.backup_payloads enable row level security;
revoke all on wms_private.backup_payloads from public,anon,authenticated;
create function wms_private.capture_branch_backup(p_branch text,p_kind text) returns uuid
language plpgsql security definer set search_path='' as $$
declare data jsonb;raw text;backup_id uuid=gen_random_uuid();hash text;actor text;
begin
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch,0));
 select jsonb_build_object(
 'branch',(select to_jsonb(b) from public.branches b where id=p_branch),
 'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by collection_name,document_id),'[]') from public.wms_documents d where branch_id=p_branch),
 'transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.branch_transfers t where source_branch=p_branch or destination_branch=p_branch),
 'operators',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from public.profiles p where branch_id=p_branch),
 'stock_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from public.stock_movements m where branch_id=p_branch),
 'activity_events',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.activity_events e where branch_id=p_branch)
 ) into data;
 if data->'branch'='null'::jsonb then raise exception 'Cabang tidak ditemukan';end if;
 raw=data::text;hash=encode(extensions.digest(raw,'sha256'),'hex');
 insert into public.branch_backups(id,branch_id,kind,document_count,stock_qty,sha256,created_by)
 values(backup_id,p_branch,p_kind,jsonb_array_length(data->'documents'),coalesce((select sum((value->'payload'->>'qty')::numeric) from jsonb_array_elements(data->'documents') where value->>'collection_name'='stock' and left(value->>'document_id',7)<>'SYSTEM_'),0),hash,auth.uid());
 insert into wms_private.backup_payloads values(backup_id,raw);
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason)
 values(p_branch,'backups',backup_id::text,'BACKUP_CREATE',auth.uid(),coalesce(actor,'Backup otomatis'),jsonb_build_object('kind',p_kind,'sha256',hash),'Pembuatan backup cabang');
 return backup_id;
end;$$;
revoke all on function wms_private.capture_branch_backup(text,text) from public,anon,authenticated;
create function wms_private.operational_state_hash(p_branch text) returns text
language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_array(collection_name,document_id,revision) order by collection_name,document_id),'[]')::text,'sha256'),'hex')
 from public.wms_documents where branch_id=p_branch and collection_name in ('stock','catalog','warehouses','settings')
$$;
revoke all on function wms_private.operational_state_hash(text) from public,anon,authenticated;
create function wms_private.branch_backup_action(p_action text,p_branch_id text,p_backup_id uuid,p_token text,p_reason text,p_file jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.branch_backups%rowtype;raw text;data jsonb;new_id uuid;token text;stats jsonb;blocked integer;row jsonb;actor text;before_id uuid;document_count integer;stock_qty numeric;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses backup cabang ditolak';end if;
 if p_action='create' then
  new_id=wms_private.capture_branch_backup(p_branch_id,'MANUAL');return jsonb_build_object('backup_id',new_id);
 elsif p_action='import' then
  raw=p_file->>'payload_text';
  if p_file->>'format' is distinct from 'BLUES_WMS_BACKUP' or p_file->>'version' is distinct from '1' or raw is null or octet_length(raw)>52428800 then raise exception 'Format/ukuran file backup tidak valid (maksimal 50 MB)';end if;
  if encode(extensions.digest(raw,'sha256'),'hex') is distinct from p_file->>'sha256' then raise exception 'Checksum backup tidak cocok. File rusak atau berubah';end if;
  data=raw::jsonb;
  if data->'branch'->>'id' is distinct from p_branch_id or p_file->>'branch_id' is distinct from p_branch_id then raise exception 'File berasal dari cabang lain';end if;
  if jsonb_typeof(data->'documents') is distinct from 'array' or jsonb_array_length(data->'documents')>50000 then raise exception 'Daftar dokumen backup tidak valid';end if;
  if exists(select 1 from jsonb_array_elements(data->'documents') j where j->>'branch_id' is distinct from p_branch_id or jsonb_typeof(j->'payload') is distinct from 'object' or length(coalesce(j->>'document_id','')) not between 1 and 160) then raise exception 'Dokumen backup tidak valid';end if;
  if (select count(*) from (select value->>'collection_name',value->>'document_id' from jsonb_array_elements(data->'documents') group by 1,2)s)<>jsonb_array_length(data->'documents') then raise exception 'Dokumen backup duplikat';end if;
  new_id=gen_random_uuid();
  select count(*),coalesce(sum(case when value->>'collection_name'='stock' and left(value->>'document_id',7)<>'SYSTEM_' then (value->'payload'->>'qty')::numeric else 0 end),0) into document_count,stock_qty from jsonb_array_elements(data->'documents');
  insert into public.branch_backups(id,branch_id,kind,document_count,stock_qty,sha256,created_by) values(new_id,p_branch_id,'IMPORTED',document_count,stock_qty,p_file->>'sha256',auth.uid());
  insert into wms_private.backup_payloads values(new_id,raw);
  select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,reason) values(p_branch_id,'backups',new_id::text,'BACKUP_IMPORT',auth.uid(),actor,'Impor file backup tervalidasi');
  return jsonb_build_object('backup_id',new_id);
 end if;
 select * into b from public.branch_backups backup_row where backup_row.id=p_backup_id and backup_row.branch_id=p_branch_id;
 if b.id is null then raise exception 'Backup tidak ditemukan';end if;
 select payload_text into raw from wms_private.backup_payloads where backup_payloads.id=b.id;
 if encode(extensions.digest(raw,'sha256'),'hex') is distinct from b.sha256 then raise exception 'Integritas backup tidak cocok';end if;
 data=raw::jsonb;
 if p_action='export' then return jsonb_build_object('format','BLUES_WMS_BACKUP','version',1,'backup_id',b.id,'branch_id',b.branch_id,'created_at',b.created_at,'sha256',b.sha256,'payload_text',raw);end if;
 if p_action not in ('preview','restore') then raise exception 'Aksi backup tidak valid';end if;
 if p_action='restore' and not wms_private.is_hq() then raise exception 'Pemulihan hanya untuk Administrator kantor pusat';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 token=wms_private.operational_state_hash(p_branch_id);
 select count(*) into blocked from public.branch_transfers where (source_branch=p_branch_id or destination_branch=p_branch_id) and status in ('SHIPPED','IN_TRANSIT');
 blocked=blocked+(select count(*) from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and coalesce(payload->>'status','Pending')='Pending');
 with saved as(select value->>'collection_name' c,value->>'document_id' d,value->'payload' p from jsonb_array_elements(data->'documents') where value->>'collection_name' in ('stock','catalog','warehouses','settings')),
 current_rows as(select collection_name c,document_id d,payload p from public.wms_documents where branch_id=p_branch_id and collection_name in ('stock','catalog','warehouses','settings'))
 select jsonb_build_object('add',count(*) filter(where current_rows.d is null),'remove',count(*) filter(where saved.d is null),'update',count(*) filter(where saved.d is not null and current_rows.d is not null and saved.p is distinct from current_rows.p))
 into stats from saved full join current_rows using(c,d);
 if p_action='preview' then return stats||jsonb_build_object('token',token,'backup_id',b.id,'backup_at',b.created_at,'stock_qty',b.stock_qty,'blocked_operations',blocked,'can_restore',wms_private.is_hq());end if;
 if p_token is distinct from token then raise exception using errcode='40001',message='Data berubah sejak pratinjau. Periksa ulang backup sebelum pemulihan';end if;
 if blocked>0 then raise exception 'Selesaikan order pending dan transfer dalam perjalanan sebelum pemulihan';end if;
 if length(trim(coalesce(p_reason,''))) not between 5 and 1000 then raise exception 'Isi alasan pemulihan minimal 5 karakter';end if;
 before_id=wms_private.capture_branch_backup(p_branch_id,'BEFORE_RESTORE');
 perform set_config('wms.operation_id','RESTORE:'||b.id::text||':'||before_id::text,true);
 perform set_config('wms.operation_type','BACKUP_RESTORE',true);
 perform set_config('wms.reason',p_reason,true);
 delete from public.wms_documents d where branch_id=p_branch_id and collection_name in ('stock','catalog','warehouses','settings')
 and not exists(select 1 from jsonb_array_elements(data->'documents') j where j->>'collection_name'=d.collection_name and j->>'document_id'=d.document_id);
 for row in select value from jsonb_array_elements(data->'documents') where value->>'collection_name' in ('stock','catalog','warehouses','settings') order by value->>'collection_name',value->>'document_id' loop
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,row->>'collection_name',row->>'document_id',(row->'payload')-'__wms_revision')
  on conflict(branch_id,collection_name,document_id) do update set payload=excluded.payload where public.wms_documents.payload is distinct from excluded.payload;
 end loop;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id)
 values(p_branch_id,'backups',b.id::text,'BACKUP_RESTORE',auth.uid(),actor,stats||jsonb_build_object('safety_backup_id',before_id),p_reason,current_setting('wms.operation_id',true));
 return stats||jsonb_build_object('safety_backup_id',before_id,'restored',true);
end;$$;
revoke all on function wms_private.branch_backup_action(text,text,uuid,text,text,jsonb) from public,anon;
grant execute on function wms_private.branch_backup_action(text,text,uuid,text,text,jsonb) to authenticated;
create function public.branch_backup_action(p_action text,p_branch_id text,p_backup_id uuid default null,p_token text default null,p_reason text default '',p_file jsonb default null)
returns jsonb language sql security invoker set search_path='' as $$select wms_private.branch_backup_action(p_action,p_branch_id,p_backup_id,p_token,p_reason,p_file)$$;
revoke all on function public.branch_backup_action(text,text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.branch_backup_action(text,text,uuid,text,text,jsonb) to authenticated;
create function wms_private.backup_all_branches() returns integer
language plpgsql security definer set search_path='' as $$
declare b record;n integer=0;
begin
 for b in select id from public.branches order by id loop
 perform wms_private.capture_branch_backup(b.id,'DAILY');n=n+1;
 end loop;
 return n;
end;$$;
revoke all on function wms_private.backup_all_branches() from public,anon,authenticated;

create extension if not exists pg_cron;
-- Backup harian setiap pukul 19:00 WIB (12:00 UTC)
select cron.schedule('blues-wms-daily-backup','0 12 * * *','select wms_private.backup_all_branches();');
alter table public.branch_backups add column captured_at timestamptz not null default now();
update public.branch_backups set captured_at=created_at;
create or replace function wms_private.branch_backup_action(p_action text,p_branch_id text,p_backup_id uuid,p_token text,p_reason text,p_file jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.branch_backups%rowtype;raw text;data jsonb;new_id uuid;token text;stats jsonb;blocked integer;row jsonb;actor text;before_id uuid;document_count integer;stock_qty numeric;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses backup cabang ditolak';end if;
 if p_action='create' then
  new_id=wms_private.capture_branch_backup(p_branch_id,'MANUAL');return jsonb_build_object('backup_id',new_id);
 elsif p_action='import' then
  raw=p_file->>'payload_text';
  if p_file->>'format' is distinct from 'BLUES_WMS_BACKUP' or p_file->>'version' is distinct from '1' or p_file->>'created_at' is null or raw is null or octet_length(raw)>52428800 then raise exception 'Format/ukuran file backup tidak valid (maksimal 50 MB)';end if;
  if encode(extensions.digest(raw,'sha256'),'hex') is distinct from p_file->>'sha256' then raise exception 'Checksum backup tidak cocok. File rusak atau berubah';end if;
  data=raw::jsonb;
  if data->'branch'->>'id' is distinct from p_branch_id or p_file->>'branch_id' is distinct from p_branch_id then raise exception 'File berasal dari cabang lain';end if;
  if jsonb_typeof(data->'documents') is distinct from 'array' or jsonb_array_length(data->'documents')>50000 then raise exception 'Daftar dokumen backup tidak valid';end if;
  if exists(select 1 from jsonb_array_elements(data->'documents') j where j->>'branch_id' is distinct from p_branch_id or jsonb_typeof(j->'payload') is distinct from 'object' or length(coalesce(j->>'document_id','')) not between 1 and 160) then raise exception 'Dokumen backup tidak valid';end if;
  if (select count(*) from (select value->>'collection_name',value->>'document_id' from jsonb_array_elements(data->'documents') group by 1,2)s)<>jsonb_array_length(data->'documents') then raise exception 'Dokumen backup duplikat';end if;
  new_id=gen_random_uuid();
  select count(*),coalesce(sum(case when value->>'collection_name'='stock' and left(value->>'document_id',7)<>'SYSTEM_' then (value->'payload'->>'qty')::numeric else 0 end),0) into document_count,stock_qty from jsonb_array_elements(data->'documents');
  insert into public.branch_backups(id,branch_id,kind,document_count,stock_qty,sha256,created_by,captured_at) values(new_id,p_branch_id,'IMPORTED',document_count,stock_qty,p_file->>'sha256',auth.uid(),(p_file->>'created_at')::timestamptz);
  insert into wms_private.backup_payloads values(new_id,raw);
  select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,reason) values(p_branch_id,'backups',new_id::text,'BACKUP_IMPORT',auth.uid(),actor,'Impor file backup tervalidasi');
  return jsonb_build_object('backup_id',new_id);
 end if;
 select * into b from public.branch_backups backup_row where backup_row.id=p_backup_id and backup_row.branch_id=p_branch_id;
 if b.id is null then raise exception 'Backup tidak ditemukan';end if;
 select payload_text into raw from wms_private.backup_payloads where backup_payloads.id=b.id;
 if encode(extensions.digest(raw,'sha256'),'hex') is distinct from b.sha256 then raise exception 'Integritas backup tidak cocok';end if;
 data=raw::jsonb;
 if p_action='export' then return jsonb_build_object('format','BLUES_WMS_BACKUP','version',1,'backup_id',b.id,'branch_id',b.branch_id,'created_at',b.captured_at,'sha256',b.sha256,'payload_text',raw);end if;
 if p_action not in ('preview','restore') then raise exception 'Aksi backup tidak valid';end if;
 if p_action='restore' and not wms_private.is_hq() then raise exception 'Pemulihan hanya untuk Administrator kantor pusat';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch_id,0));
 token=wms_private.operational_state_hash(p_branch_id);
 select count(*) into blocked from public.branch_transfers where (source_branch=p_branch_id or destination_branch=p_branch_id) and status in ('SHIPPED','IN_TRANSIT');
 blocked=blocked+(select count(*) from public.wms_documents where branch_id=p_branch_id and collection_name='orders' and coalesce(payload->>'status','Pending')='Pending');
 with saved as(select value->>'collection_name' c,value->>'document_id' d,value->'payload' p from jsonb_array_elements(data->'documents') where value->>'collection_name' in ('stock','catalog','warehouses','settings')),
 current_rows as(select collection_name c,document_id d,payload p from public.wms_documents where branch_id=p_branch_id and collection_name in ('stock','catalog','warehouses','settings'))
 select jsonb_build_object('add',count(*) filter(where current_rows.d is null),'remove',count(*) filter(where saved.d is null),'update',count(*) filter(where saved.d is not null and current_rows.d is not null and saved.p is distinct from current_rows.p))
 into stats from saved full join current_rows using(c,d);
 if p_action='preview' then return stats||jsonb_build_object('token',token,'backup_id',b.id,'backup_at',b.captured_at,'stock_qty',b.stock_qty,'blocked_operations',blocked,'can_restore',wms_private.is_hq());end if;
 if p_token is distinct from token then raise exception using errcode='40001',message='Data berubah sejak pratinjau. Periksa ulang backup sebelum pemulihan';end if;
 if blocked>0 then raise exception 'Selesaikan order pending dan transfer dalam perjalanan sebelum pemulihan';end if;
 if length(trim(coalesce(p_reason,''))) not between 5 and 1000 then raise exception 'Isi alasan pemulihan minimal 5 karakter';end if;
 before_id=wms_private.capture_branch_backup(p_branch_id,'BEFORE_RESTORE');
 perform set_config('wms.operation_id','RESTORE:'||b.id::text||':'||before_id::text,true);
 perform set_config('wms.operation_type','BACKUP_RESTORE',true);
 perform set_config('wms.reason',p_reason,true);
 delete from public.wms_documents d where branch_id=p_branch_id and collection_name in ('stock','catalog','warehouses','settings')
 and not exists(select 1 from jsonb_array_elements(data->'documents') j where j->>'collection_name'=d.collection_name and j->>'document_id'=d.document_id);
 for row in select value from jsonb_array_elements(data->'documents') where value->>'collection_name' in ('stock','catalog','warehouses','settings') order by value->>'collection_name',value->>'document_id' loop
  insert into public.wms_documents(branch_id,collection_name,document_id,payload)
  values(p_branch_id,row->>'collection_name',row->>'document_id',(row->'payload')-'__wms_revision')
  on conflict(branch_id,collection_name,document_id) do update set payload=excluded.payload where public.wms_documents.payload is distinct from excluded.payload;
 end loop;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id)
 values(p_branch_id,'backups',b.id::text,'BACKUP_RESTORE',auth.uid(),actor,stats||jsonb_build_object('safety_backup_id',before_id),p_reason,current_setting('wms.operation_id',true));
 return stats||jsonb_build_object('safety_backup_id',before_id,'restored',true);
end;$$;
