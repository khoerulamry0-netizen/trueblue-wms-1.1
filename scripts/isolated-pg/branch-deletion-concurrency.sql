\set ON_ERROR_STOP on
-- This script runs only in the isolated disposable database.
insert into public.branches(id,name) values ('DELETE_RACE','Concurrent test');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims',jsonb_build_object('amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now()))))::text,false);
set role authenticated;
select public.branch_deletion_action('prepare','DELETE_RACE','00000000-0000-4000-8000-000000000201');
select public.branch_deletion_action('prepare','DELETE_RACE','00000000-0000-4000-8000-000000000202');
reset role;
select dblink_connect('delete_a','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_connect('delete_b','host=/var/run/postgresql dbname=wms_isolated_test user=postgres');
select dblink_exec(c, 'set role authenticated') from (values ('delete_a'),('delete_b')) x(c);
select dblink_exec(c, $q$set "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000001'$q$) from (values ('delete_a'),('delete_b')) x(c);
select dblink_exec(c,format('set "request.jwt.claims"=%L',current_setting('request.jwt.claims'))) from (values ('delete_a'),('delete_b')) x(c);
select dblink_send_query('delete_a',$q$select public.branch_deletion_action('finish','DELETE_RACE','00000000-0000-4000-8000-000000000201','HAPUS DELETE_RACE','Concurrent synthetic test',public.branch_deletion_action('export','DELETE_RACE','00000000-0000-4000-8000-000000000201'))$q$);
select dblink_send_query('delete_b',$q$select public.branch_deletion_action('finish','DELETE_RACE','00000000-0000-4000-8000-000000000202','HAPUS DELETE_RACE','Concurrent synthetic test',public.branch_deletion_action('export','DELETE_RACE','00000000-0000-4000-8000-000000000202'))$q$);
create temporary table delete_race_results(result jsonb);
insert into delete_race_results select * from dblink_get_result('delete_a',false) as t(result jsonb);
insert into delete_race_results select * from dblink_get_result('delete_b',false) as t(result jsonb);
do $$
begin
 if (select count(*) from delete_race_results)<>1 or exists(select 1 from public.branches where id='DELETE_RACE') then
  raise exception 'Concurrent deletion did not produce exactly one success';
 end if;
 if not ((dblink_error_message('delete_a')='OK' and dblink_error_message('delete_b') like '%dibatalkan%') or
         (dblink_error_message('delete_b')='OK' and dblink_error_message('delete_a') like '%dibatalkan%')) then
  raise exception 'Concurrent request failed for an unexpected reason: %, %',dblink_error_message('delete_a'),dblink_error_message('delete_b');
 end if;
end $$;
select dblink_disconnect('delete_a');
select dblink_disconnect('delete_b');
\echo Two-plan concurrent deletion test passed.
