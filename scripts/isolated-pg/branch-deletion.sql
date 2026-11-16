\set ON_ERROR_STOP on
-- Synthetic multipart deletion/recovery test. Always rolled back.
begin;
insert into public.branches(id,name) values ('DELETE_TEST','Delete test');
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values
 ('DELETE_TEST','stock','STOCK-TEST','{"id":"STOCK-TEST","skuId":"SKU-TEST","location":"A","qty":7}'::jsonb),
 ('DELETE_TEST','catalog','SKU-TEST','{"id":"SKU-TEST","skuId":"SKU-TEST","name":"Synthetic SKU"}'::jsonb);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000001','session_id','multipart-test-session','amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now()))))::text,true);
select wms_private.capture_branch_backup('DELETE_TEST','MANUAL');
insert into wms_private.write_requests(id,actor_id,branch_id,body,result)
values('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000001','DELETE_TEST','{"request":true}','{"ok":true}');
insert into wms_private.period_archives(id,branch_id,actor_id,cutoff,backup_id,state_hash,status,summary)
select '00000000-0000-4000-8000-000000000202','DELETE_TEST','00000000-0000-4000-8000-000000000001',now()-interval '1 day',id,repeat('1',64),'CANCELLED','{"test":true}'
from public.branch_backups where branch_id='DELETE_TEST' order by created_at desc limit 1;
insert into wms_private.stock_purge_plans(id,branch_id,actor_id,session_id,state_hash,backup_id,rows_count,qty,reason,expires_at,status)
select '00000000-0000-4000-8000-000000000203','DELETE_TEST','00000000-0000-4000-8000-000000000001','multipart-test-session',repeat('2',64),id,1,7,'Synthetic cancelled purge',now()+interval '1 hour','CANCELLED'
from public.branch_backups where branch_id='DELETE_TEST' order by created_at desc limit 1;

create temporary table branch_deletion_test_results(plan jsonb,operational jsonb,audit_part jsonb,backups_part jsonb,requests_part jsonb,manifest jsonb);
grant select,insert,update on branch_deletion_test_results to authenticated;
set local role authenticated;
insert into branch_deletion_test_results(plan) select public.branch_deletion_action('prepare','DELETE_TEST','00000000-0000-4000-8000-000000000100');
do $$declare failed boolean:=false;begin
 begin perform public.branch_deletion_action('export:manifest','DELETE_TEST','00000000-0000-4000-8000-000000000100');exception when others then failed=true;end;
 if not failed then raise exception 'Manifest was created before all parts were exported';end if;
end$$;
update branch_deletion_test_results set operational=public.branch_deletion_action('export:operational','DELETE_TEST','00000000-0000-4000-8000-000000000100');
update branch_deletion_test_results set audit_part=public.branch_deletion_action('export:audit','DELETE_TEST','00000000-0000-4000-8000-000000000100');
update branch_deletion_test_results set backups_part=public.branch_deletion_action('export:backups','DELETE_TEST','00000000-0000-4000-8000-000000000100');
update branch_deletion_test_results set requests_part=public.branch_deletion_action('export:requests','DELETE_TEST','00000000-0000-4000-8000-000000000100');
update branch_deletion_test_results set manifest=public.branch_deletion_action('export:manifest','DELETE_TEST','00000000-0000-4000-8000-000000000100');
reset role;

do $$declare op jsonb;backups jsonb;requests jsonb;manifest_doc jsonb;begin
 select (r.operational->>'payload_text')::jsonb,(r.backups_part->>'payload_text')::jsonb,(r.requests_part->>'payload_text')::jsonb,r.manifest into op,backups,requests,manifest_doc from branch_deletion_test_results r;
 if jsonb_array_length(op->'documents')<>2 then raise exception 'Operational part omitted documents';end if;
 if jsonb_array_length(backups->'backups')<>1 or backups->'backups'->0->>'payload_text' is null then raise exception 'Backup part omitted historical payload';end if;
 if jsonb_array_length(requests->'write_requests')<>1 or jsonb_array_length(requests->'period_archives')<>1 or jsonb_array_length(requests->'stock_purge_plans')<>1 then raise exception 'Request part omitted private recovery rows';end if;
 if jsonb_array_length(manifest_doc->'parts')<>4 or manifest_doc->>'version'<>'2' then raise exception 'Manifest is incomplete';end if;
 if (select count(*) from wms_private.branch_deletion_parts where plan_id='00000000-0000-4000-8000-000000000100')<>4 then raise exception 'Server recovery parts are incomplete';end if;
end$$;

set local role authenticated;
do $$declare f jsonb;failed boolean:=false;begin
 select manifest into f from branch_deletion_test_results;
 begin perform public.branch_deletion_action('finish','DELETE_TEST','00000000-0000-4000-8000-000000000100','HAPUS DELETE_TEST','Synthetic multipart deletion',jsonb_set(f,'{sha256}','"bad"'));exception when others then failed=true;end;
 if not failed then raise exception 'Modified manifest was accepted';end if;
end$$;
reset role;
insert into public.activity_events(branch_id,entity_type,entity_id,action,reason) values('DELETE_TEST','test','stale-check','TEST','Synthetic change after export');
set local role authenticated;
do $$declare f jsonb;failed boolean:=false;begin
 select manifest into f from branch_deletion_test_results;
 begin perform public.branch_deletion_action('finish','DELETE_TEST','00000000-0000-4000-8000-000000000100','HAPUS DELETE_TEST','Synthetic multipart deletion',f);exception when others then failed=true;end;
 if not failed then raise exception 'Stale multipart backup was accepted';end if;
end$$;
reset role;
delete from public.activity_events where branch_id='DELETE_TEST' and entity_type='test' and entity_id='stale-check';
set local role authenticated;
select public.branch_deletion_action('finish','DELETE_TEST','00000000-0000-4000-8000-000000000100','HAPUS DELETE_TEST','Synthetic multipart deletion',manifest) from branch_deletion_test_results;
reset role;
do $$begin
 if exists(select 1 from public.branches where id='DELETE_TEST') or exists(select 1 from public.wms_documents where branch_id='DELETE_TEST') or exists(select 1 from public.branch_backups where branch_id='DELETE_TEST') or exists(select 1 from wms_private.write_requests where branch_id='DELETE_TEST') or exists(select 1 from wms_private.period_archives where branch_id='DELETE_TEST') or exists(select 1 from wms_private.stock_purge_plans where branch_id='DELETE_TEST') then raise exception 'Synthetic branch was not fully removed';end if;
 if (select count(*) from wms_private.branch_deletion_parts where plan_id='00000000-0000-4000-8000-000000000100')<>4 then raise exception 'Recovery parts were deleted';end if;
end$$;

set local role authenticated;
do $$declare f jsonb;failed boolean:=false;begin
 select manifest into f from branch_deletion_test_results;
 begin perform public.restore_deleted_branch('DELETE_TEST','00000000-0000-4000-8000-000000000100','PULIHKAN DELETE_TEST','Synthetic multipart restore',jsonb_set(f,'{sha256}','"bad"'));exception when others then failed=true;end;
 if not failed then raise exception 'Modified restore manifest was accepted';end if;
end$$;
select public.restore_deleted_branch('DELETE_TEST','00000000-0000-4000-8000-000000000100','PULIHKAN DELETE_TEST','Synthetic multipart restore',manifest) from branch_deletion_test_results;
reset role;
do $$begin
 if not exists(select 1 from public.branches where id='DELETE_TEST') then raise exception 'Branch was not restored';end if;
 if (select count(*) from public.wms_documents where branch_id='DELETE_TEST')<>2 then raise exception 'Documents were not restored';end if;
 if (select count(*) from public.branch_backups where branch_id='DELETE_TEST')<>1 then raise exception 'Backup metadata was not restored';end if;
 if not exists(select 1 from public.branch_backups b join wms_private.backup_payloads p on p.id=b.id where b.branch_id='DELETE_TEST') then raise exception 'Backup payload was not restored';end if;
 if (select count(*) from wms_private.write_requests where branch_id='DELETE_TEST')<>1 or (select count(*) from wms_private.period_archives where branch_id='DELETE_TEST')<>1 or (select count(*) from wms_private.stock_purge_plans where branch_id='DELETE_TEST')<>1 then raise exception 'Private recovery rows were not restored';end if;
 if (select status from wms_private.branch_deletion_plans where id='00000000-0000-4000-8000-000000000100')<>'RESTORED' then raise exception 'Plan was not marked restored';end if;
end$$;
rollback;
