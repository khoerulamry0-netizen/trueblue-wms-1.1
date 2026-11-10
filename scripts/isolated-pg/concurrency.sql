\set ON_ERROR_STOP on
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
select public.start_order_scan('60000000-0000-4000-8000-000000000001','TEST_LOCAL','REF-RACE','sorting','A2');
select public.start_order_scan('60000000-0000-4000-8000-000000000002','TEST_LOCAL','REF-REPLAY','sorting','A3');
reset role;

select dblink_connect('race1','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_connect('race2','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_exec('race1',$q$set role authenticated$q$);
select dblink_exec('race2',$q$set role authenticated$q$);
select dblink_exec('race1',$q$set "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000002'$q$);
select dblink_exec('race2',$q$set "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000002'$q$);
select dblink_send_query('race1',$q$select public.record_order_scan('60000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','SKU-A')$q$);
select dblink_send_query('race2',$q$select public.record_order_scan('60000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','SKU-A')$q$);
create temporary table race_results(result jsonb);
insert into race_results select * from dblink_get_result('race1',false) as t(result jsonb);
insert into race_results select * from dblink_get_result('race2',false) as t(result jsonb);
do $$ begin
 if (select count(*) from race_results)<>1 or
    (select count(*) from wms_private.scan_events where session_id='60000000-0000-4000-8000-000000000001')<>1
 then raise exception 'FAIL: concurrent scan exceeded quantity or both failed'; end if;
 if not ((dblink_error_message('race1')='OK' and dblink_error_message('race2') like '%Jumlah scan berlebih%') or
         (dblink_error_message('race2')='OK' and dblink_error_message('race1') like '%Jumlah scan berlebih%')) then
  raise exception 'FAIL: concurrent scan failed for an unexpected reason';
 end if;
end $$;
select dblink_disconnect('race1');
select dblink_disconnect('race2');
select dblink_connect('race1','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_connect('race2','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_exec('race1',$q$set role authenticated$q$);
select dblink_exec('race2',$q$set role authenticated$q$);
select dblink_exec('race1',$q$set "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000002'$q$);
select dblink_exec('race2',$q$set "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000002'$q$);
select dblink_send_query('race1',$q$select public.record_order_scan('60000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000003','SKU-A')$q$);
select dblink_send_query('race2',$q$select public.record_order_scan('60000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000003','SKU-A')$q$);
truncate race_results;
insert into race_results select * from dblink_get_result('race1',false) as t(result jsonb);
insert into race_results select * from dblink_get_result('race2',false) as t(result jsonb);
do $$ begin
 if (select count(*) from race_results)<>2 or
    (select count(*) from wms_private.scan_events where session_id='60000000-0000-4000-8000-000000000002')<>1
 then raise exception 'FAIL: concurrent retry was not idempotent'; end if;
end $$;
select dblink_disconnect('race1');
select dblink_disconnect('race2');
select dblink_connect('race1','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_connect('race2','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_exec('race1',$q$set role authenticated$q$);
select dblink_exec('race2',$q$set role authenticated$q$);
select dblink_exec('race1',$q$set "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000002'$q$);
select dblink_exec('race2',$q$set "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000002'$q$);
select dblink_send_query('race1',$q$select public.finish_order_scan('60000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001')$q$);
select dblink_send_query('race2',$q$select public.finish_order_scan('60000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001')$q$);
truncate race_results;
insert into race_results select * from dblink_get_result('race1') as t(result jsonb);
insert into race_results select * from dblink_get_result('race2') as t(result jsonb);
do $$ begin
 if (select count(*) from race_results)<>2 or (select count(distinct result) from race_results)<>1 or
    (select count(*) from wms_private.write_requests where id='90000000-0000-4000-8000-000000000001')<>1
 then raise exception 'FAIL: concurrent finish replay'; end if;
end $$;
select dblink_disconnect('race1');
select dblink_disconnect('race2');
select dblink_connect('reconnect','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_exec('reconnect',$q$set role authenticated$q$);
select dblink_exec('reconnect',$q$set "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000002'$q$);
truncate race_results;
insert into race_results select * from dblink('reconnect',
 $q$select public.get_order_scan_status('TEST_LOCAL','REF-REPLAY','sorting')$q$) as t(result jsonb);
do $$ begin
 if not exists(select 1 from race_results where result->>'state'='finished'
  and result->>'finish_request'='90000000-0000-4000-8000-000000000001'
  and (result->'counts'->0->>'scanned')::int=1 and jsonb_array_length(result->'events')=1)
 then raise exception 'FAIL: reconnect did not recover committed result'; end if;
end $$;
select dblink_disconnect('reconnect');
\echo Concurrency tests passed.
