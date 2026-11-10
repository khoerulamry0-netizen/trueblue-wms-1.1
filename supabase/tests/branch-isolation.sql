
begin;
insert into public.branches(id,name) values('TEST_A','Temporary A'),('TEST_B','Temporary B');
insert into auth.users(id,email,raw_user_meta_data) values
 ('00000000-0000-4000-8000-0000000000a1','branch-test-a@example.invalid','{}'),
 ('00000000-0000-4000-8000-0000000000b1','branch-test-b@example.invalid','{}'),
 ('00000000-0000-4000-8000-0000000000c1','branch-test-viewer@example.invalid','{}');
update public.profiles set branch_id='TEST_A',role='Admin',is_active=true where id='00000000-0000-4000-8000-0000000000a1';
update public.profiles set branch_id='TEST_B',role='Picker',is_active=true where id='00000000-0000-4000-8000-0000000000b1';
update public.profiles set branch_id='TEST_A',role='Viewer',is_active=true where id='00000000-0000-4000-8000-0000000000c1';
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values('TEST_A','settings','scope-test','{"value":"A"}'),('TEST_B','settings','scope-test','{"value":"B"}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a1',true);
do $$
declare n integer;
begin
 select count(*) into n from public.branches;
 if n<>1 then raise exception 'FAIL: branch listing leaks'; end if;
 select count(*) into n from public.wms_documents;
 if n<>1 then raise exception 'FAIL: document isolation';end if;
 select count(*) into n from public.profiles;
 if n<>2 then raise exception 'FAIL: profile isolation';end if;
 perform public.commit_wms_write('20000000-0000-4000-8000-0000000000a1','TEST_A',jsonb_build_array(jsonb_build_object('collection_name','settings','document_id','scope-test','expected_revision',(select revision from public.wms_documents where document_id='scope-test'),'payload',jsonb_build_object('value','updated'))),'[]');
 begin
 insert into public.wms_documents(branch_id,collection_name,document_id,payload) values('TEST_B','settings','denied','{}');
 raise exception 'FAIL: foreign insert allowed';
 exception when insufficient_privilege then null;end;
 begin
 update public.wms_documents set branch_id='TEST_B' where document_id='scope-test';
 raise exception 'FAIL: moving document allowed';
 exception when insufficient_privilege then null;end;
 begin delete from public.wms_documents where branch_id='TEST_B'; raise exception 'FAIL: direct delete';exception when insufficient_privilege then null;end;
 begin
 perform public.commit_wms_write('20000000-0000-4000-8000-0000000000b1','TEST_B','[{"collection_name":"settings","document_id":"denied","expected_revision":null,"payload":{}}]','[]');
 raise exception 'FAIL: batch bypass';exception when raise_exception then
 if sqlerrm <> 'Akses tulis cabang ditolak' then raise;end if;end;
 begin
 insert into public.branches(id,name) values('TEST_DENIED','denied');
 raise exception 'FAIL: branch creation allowed';
 exception when insufficient_privilege then null;end;
 perform public.commit_wms_write('20000000-0000-4000-8000-0000000000c1','TEST_A','[{"collection_name":"settings","document_id":"allowed","expected_revision":null,"payload":{"ok":true}}]','[]');
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c1',true);
do $$begin
 begin
 insert into public.wms_documents(branch_id,collection_name,document_id,payload) values('TEST_A','settings','viewer-denied','{}');
 raise exception 'FAIL: viewer writes';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','ce9a985f-65b4-433b-a933-a0a079d30a53',true);
do $$declare n integer;begin
 select count(*) into n from public.wms_documents where document_id='scope-test';
 if n<>2 then raise exception 'FAIL: HQ cannot read network';end if;
end $$;
reset role;
rollback;
select 'PASS: branch/profile read isolation, own writes, foreign insert/update/delete denial, batch scope, branch creation restriction, viewer read-only, HQ network access. All fixtures rolled back.' as result;
