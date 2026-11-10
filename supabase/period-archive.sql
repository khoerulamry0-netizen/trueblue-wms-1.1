-- Archive finished history only; never change physical stock.
alter table public.branch_backups add column storage_status text not null default 'CLOUD';
-- Avoid retaining a new duplicate of each archived row in the audit table.
do $patch$ declare source text;begin
 source=pg_get_functiondef('wms_private.audit_wms_change()'::regprocedure);
 source=regexp_replace(source,'\mbegin\M',E'begin\n if tg_op=''DELETE'' and current_setting(''wms.operation_type'',true)=''PERIOD_ARCHIVE'' and current_user=''postgres'' then return old;end if;','i');
 execute source;
end;$patch$;
create table wms_private.period_archives (
 id uuid primary key default gen_random_uuid(),branch_id text not null references public.branches(id),
 actor_id uuid not null references auth.users(id),cutoff timestamptz not null,backup_id uuid not null references public.branch_backups(id),
 state_hash text not null,status text not null default 'PREPARED' check(status in ('PREPARED','COMPLETED','CANCELLED')),summary jsonb not null,created_at timestamptz not null default now()
);
alter table wms_private.period_archives enable row level security;
revoke all on wms_private.period_archives from public,anon,authenticated;
create function wms_private.archive_state(b text) returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(jsonb_build_array(
 (select coalesce(jsonb_agg(to_jsonb(d) order by collection_name,document_id),'[]') from public.wms_documents d where branch_id=b),
 (select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from public.stock_movements m where branch_id=b),
 (select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.activity_events e where branch_id=b),
 (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.branch_transfers t where source_branch=b or destination_branch=b)
 )::text,'sha256'),'hex')
$$;
revoke all on function wms_private.archive_state(text) from public,anon,authenticated;
create function wms_private.archive_document_keys(b text,c timestamptz) returns table(collection_name text,document_id text) language sql stable set search_path='' as $$
 select d.collection_name,d.document_id from public.wms_documents d where d.branch_id=b and d.updated_at<c and (d.collection_name='logs' or (d.collection_name='orders' and d.payload->>'status' in ('Completed','Cancelled') and not exists(select 1 from public.wms_documents x where x.branch_id=b and x.collection_name='orders' and coalesce(nullif(x.payload->>'referenceNumber',''),x.document_id)=coalesce(nullif(d.payload->>'referenceNumber',''),d.document_id) and (x.updated_at>=c or coalesce(x.payload->>'status','Pending') not in ('Completed','Cancelled')))))
$$;
revoke all on function wms_private.archive_document_keys(text,timestamptz) from public,anon,authenticated;
create or replace function wms_private.protect_transaction_history() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' and current_setting('wms.operation_type',true)='PERIOD_ARCHIVE' and current_user='postgres' then return old;end if;
 if old.collection_name='orders' then
  if tg_op='DELETE' then raise exception 'Riwayat order tidak boleh dihapus. Gunakan pembatalan beralasan';end if;
  if old.payload->>'status'='Cancelled' and new.payload is distinct from old.payload then raise exception 'Order yang dibatalkan tidak dapat diubah atau dibuka kembali';end if;
  if new.payload->>'status'='Cancelled' and old.payload->>'status' is distinct from 'Cancelled' and current_setting('wms.operation_type',true) is distinct from 'ORDER_CANCELLATION' then raise exception 'Gunakan pembatalan order resmi';end if;
 end if;
 if old.collection_name='logs' and (tg_op='DELETE' or new.payload is distinct from old.payload) then raise exception 'Riwayat mutasi tidak boleh diubah atau dihapus. Buat koreksi baru';end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
create function wms_private.period_archive_action(p_action text,p_branch text,p_cutoff timestamptz,p_id uuid,p_sha text,p_confirmation text,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a wms_private.period_archives%rowtype;bid uuid;stats jsonb;before_stock text;before_ledger jsonb;after_ledger jsonb;actor text;
begin
 if auth.uid() is null or not public.wms_is_admin() or not wms_private.is_hq() or not wms_private.can_access_branch(p_branch) then raise exception 'Hanya Administrator kantor pusat dapat mengarsipkan cabang';end if;
 perform pg_advisory_xact_lock(hashtextextended('write-branch:'||p_branch,0));
 if p_action='release_backup' then
  if not wms_private.recent_password_auth() then raise exception 'Login ulang dengan password lalu konfirmasi dalam 2 menit';end if;
  if p_confirmation is distinct from 'ARSIP '||p_branch or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Konfirmasi cabang dan alasan 10–1000 karakter wajib diisi';end if;
  if not exists(select 1 from public.branch_backups where id=p_id and branch_id=p_branch and sha256=p_sha and storage_status='CLOUD') then raise exception 'File tidak cocok atau backup sudah dipindahkan';end if;
  if exists(select 1 from wms_private.period_archives where backup_id=p_id and status='PREPARED') then raise exception 'Selesaikan rencana arsip ini terlebih dahulu';end if;
  if p_id in (select id from public.branch_backups where branch_id=p_branch and storage_status='CLOUD' order by created_at desc,id limit 2) then raise exception 'Dua backup cloud terbaru tetap disimpan untuk pengaman';end if;
  delete from wms_private.backup_payloads where id=p_id;
  update public.branch_backups set storage_status='LOCAL' where id=p_id;
  insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,after_data,reason) values(p_branch,'backups',p_id::text,'BACKUP_MOVED_LOCAL',auth.uid(),jsonb_build_object('sha256',p_sha),p_reason);
  return jsonb_build_object('completed',true);
 end if;
 if p_action='prepare' then
  if p_cutoff is null or p_cutoff>now()-interval '90 days' or p_cutoff<'2000-01-01'::timestamptz then raise exception 'Arsip hanya untuk riwayat berumur minimal 90 hari';end if;
  if exists(select 1 from public.wms_documents where branch_id=p_branch and collection_name='orders' and coalesce(payload->>'status','Pending') not in ('Completed','Cancelled')) or exists(select 1 from public.branch_transfers where (source_branch=p_branch or destination_branch=p_branch) and status in ('DRAFT','SHIPPED','IN_TRANSIT')) then raise exception 'Selesaikan atau batalkan seluruh order dan transfer berjalan sebelum membuat arsip cabang';end if;
  stats=jsonb_build_object('orders',(select count(*) from wms_private.archive_document_keys(p_branch,p_cutoff) where collection_name='orders'),'logs',(select count(*) from wms_private.archive_document_keys(p_branch,p_cutoff) where collection_name='logs'),'movements',(select count(*) from public.stock_movements where branch_id=p_branch and created_at<p_cutoff),'events',(select count(*) from public.activity_events where branch_id=p_branch and created_at<p_cutoff),'stock_qty',(select coalesce(sum((payload->>'qty')::numeric),0) from public.wms_documents where branch_id=p_branch and collection_name='stock'));
  if (stats->>'orders')::bigint+(stats->>'logs')::bigint+(stats->>'events')::bigint+(stats->>'movements')::bigint=0 then raise exception 'Belum ada riwayat yang memenuhi batas umur arsip';end if;
  bid=wms_private.capture_branch_backup(p_branch,'PERIOD_ARCHIVE');
  if (select octet_length(jsonb_build_object('format','BLUES_WMS_BACKUP','version',1,'backup_id',bid,'branch_id',p_branch,'created_at',now(),'sha256',repeat('0',64),'payload_text',payload_text)::text) from wms_private.backup_payloads where id=bid)>50000000 then raise exception 'Arsip terlalu besar untuk unduhan ini. Hubungi pengelola untuk ekspor bertahap';end if;
  update wms_private.period_archives set status='CANCELLED' where branch_id=p_branch and actor_id=auth.uid() and status='PREPARED';
  insert into wms_private.period_archives(branch_id,actor_id,cutoff,backup_id,state_hash,summary) values(p_branch,auth.uid(),p_cutoff,bid,wms_private.archive_state(p_branch),stats) returning * into a;
  return jsonb_build_object('id',a.id,'backup_id',bid,'summary',stats,'cutoff',p_cutoff);
 end if;
 select * into a from wms_private.period_archives where id=p_id and branch_id=p_branch and actor_id=auth.uid() for update;
 if a.id is null then raise exception 'Rencana arsip tidak ditemukan';end if;
 if p_action='finish' and a.status='COMPLETED' then return jsonb_build_object('completed',true,'summary',a.summary);end if;
 if p_action<>'finish' or a.status<>'PREPARED' then raise exception 'Aksi arsip tidak valid';end if;
 if not wms_private.recent_password_auth() then raise exception 'Login ulang dengan password, lalu konfirmasi dalam 2 menit';end if;
 if p_confirmation is distinct from 'ARSIP '||p_branch or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Ketik konfirmasi cabang dan alasan minimal 10 karakter';end if;
 if p_sha is distinct from (select sha256 from public.branch_backups where id=a.backup_id) then raise exception 'File lokal belum cocok dengan arsip server';end if;
 if a.state_hash is distinct from wms_private.archive_state(p_branch) then raise exception 'Data cabang berubah. Buat dan unduh arsip baru saat operasional berhenti';end if;
 before_stock=wms_private.operational_state_hash(p_branch);
 select coalesce(jsonb_object_agg(document_id,qty),'{}') into before_ledger from (select document_id,sum(delta) qty from public.stock_movements where branch_id=p_branch group by document_id having sum(delta)<>0) s;
 select coalesce(nullif(full_name,''),email) into actor from public.profiles where id=auth.uid();
 perform set_config('wms.operation_type','PERIOD_ARCHIVE',true);perform set_config('wms.operation_id',a.id::text,true);perform set_config('wms.reason',p_reason,true);
 delete from public.wms_documents d using wms_private.archive_document_keys(p_branch,a.cutoff) k where d.branch_id=p_branch and d.collection_name=k.collection_name and d.document_id=k.document_id;
 -- Carry the sum of archived ledger deltas forward, without touching stock rows.
 insert into public.stock_movements(branch_id,document_id,sku_id,sku_name,location,expired_date,qty_before,qty_after,delta,operation_id,operation_type,actor_id,actor_name,created_at)
 select p_branch,document_id,max(sku_id),max(sku_name),max(location),max(expired_date),0,sum(delta),sum(delta),a.id::text,'ARCHIVE_OPENING',auth.uid(),actor,a.cutoff from public.stock_movements where branch_id=p_branch and created_at<a.cutoff group by document_id having sum(delta)<>0;
 delete from public.stock_movements where branch_id=p_branch and created_at<a.cutoff;
 delete from public.activity_events where branch_id=p_branch and created_at<a.cutoff;
 select coalesce(jsonb_object_agg(document_id,qty),'{}') into after_ledger from (select document_id,sum(delta) qty from public.stock_movements where branch_id=p_branch group by document_id having sum(delta)<>0) s;
 if before_ledger is distinct from after_ledger then raise exception 'Saldo buku mutasi berubah. Seluruh proses dibatalkan';end if;
 if before_stock is distinct from wms_private.operational_state_hash(p_branch) then raise exception 'Pemeriksaan saldo gagal. Seluruh proses dibatalkan';end if;
 delete from wms_private.backup_payloads where id=a.backup_id;
 update public.branch_backups set storage_status='LOCAL' where id=a.backup_id;
 update wms_private.period_archives set status='COMPLETED' where id=a.id;
 insert into public.activity_events(branch_id,entity_type,entity_id,action,actor_id,actor_name,after_data,reason,operation_id) values(p_branch,'period_archive',a.id::text,'PERIOD_ARCHIVE_COMPLETED',auth.uid(),actor,a.summary||jsonb_build_object('cutoff',a.cutoff,'sha256',p_sha,'stock_hash',before_stock),p_reason,a.id::text);
 return jsonb_build_object('completed',true,'summary',a.summary);
end;$$;
revoke all on function wms_private.period_archive_action(text,text,timestamptz,uuid,text,text,text) from public,anon;
grant execute on function wms_private.period_archive_action(text,text,timestamptz,uuid,text,text,text) to authenticated;
create function public.period_archive_action(p_action text,p_branch text,p_cutoff timestamptz default null,p_id uuid default null,p_sha text default null,p_confirmation text default '',p_reason text default '') returns jsonb language sql security invoker set search_path='' as $$select wms_private.period_archive_action(p_action,p_branch,p_cutoff,p_id,p_sha,p_confirmation,p_reason)$$;
revoke all on function public.period_archive_action(text,text,timestamptz,uuid,text,text,text) from public,anon;
grant execute on function public.period_archive_action(text,text,timestamptz,uuid,text,text,text) to authenticated;
