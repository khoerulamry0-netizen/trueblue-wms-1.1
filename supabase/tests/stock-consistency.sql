
begin;
insert into public.branches(id,name) values('TST_REV','Test Revisions');
insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-4000-8000-0000000000a4','revision-test@example.invalid','{}');
update public.profiles set role='Admin',branch_id='TST_REV',is_active=true where id='00000000-0000-4000-8000-0000000000a4';
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values('TST_REV','stock','KEEP','{"skuId":"KEEP","location":"B","expiredDate":"No Expired","qty":0}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a4',true);
do $$declare first_result jsonb;second_result jsonb;rev bigint;q numeric;n integer;before_n integer;
begin
 first_result=public.commit_wms_write('20000000-0000-4000-8000-000000000001','TST_REV',
 '[{"collection_name":"stock","document_id":"SKU_No_Expired_A","expected_revision":null,"payload":{"id":"SKU_No_Expired_A","skuId":"SKU","skuName":"Test","location":"A","expiredDate":"No Expired","qty":100}}]','[]');
 second_result=public.commit_wms_write('20000000-0000-4000-8000-000000000001','TST_REV',
 '[{"collection_name":"stock","document_id":"SKU_No_Expired_A","expected_revision":null,"payload":{"id":"SKU_No_Expired_A","skuId":"SKU","skuName":"Test","location":"A","expiredDate":"No Expired","qty":100}}]','[]');
 if first_result<>second_result then raise exception 'FAIL retry response changed';end if;
 select count(*) into n from public.stock_movements where branch_id='TST_REV';
 if n<>1 then raise exception 'FAIL retry duplicated movement';end if;
 rev=(first_result->0->>'revision')::bigint;
 perform public.commit_wms_write('20000000-0000-4000-8000-000000000002','TST_REV',
 jsonb_build_array(jsonb_build_object('collection_name','stock','document_id','SKU_No_Expired_A','expected_revision',rev,'merge',true,'payload',jsonb_build_object('qty',90))),'[]');
 begin
 perform public.commit_wms_write('20000000-0000-4000-8000-000000000003','TST_REV',
 jsonb_build_array(jsonb_build_object('collection_name','settings','document_id','must-rollback','expected_revision',null,'payload','{}'::jsonb),jsonb_build_object('collection_name','stock','document_id','SKU_No_Expired_A','expected_revision',rev,'merge',true,'payload',jsonb_build_object('qty',80))),'[]');
 raise exception 'FAIL stale write allowed';
 exception when sqlstate 'PT409' then null;end;
 if exists(select 1 from public.wms_documents where branch_id='TST_REV' and document_id='must-rollback') then raise exception 'FAIL partial transaction';end if;
 select (payload->>'qty')::numeric,revision into q,rev from public.wms_documents where branch_id='TST_REV' and document_id='SKU_No_Expired_A';
 if q<>90 then raise exception 'FAIL lost update';end if;
 begin
 update public.wms_documents set payload='{}' where branch_id='TST_REV';
 raise exception 'FAIL bypass gateway';exception when insufficient_privilege then null;end;
 begin
 delete from public.stock_movements;
 raise exception 'FAIL ledger deletion';exception when insufficient_privilege then null;end;
 perform public.commit_wms_write('20000000-0000-4000-8000-000000000004','TST_REV','[]',jsonb_build_array(jsonb_build_object('collection_name','stock','document_id','SKU_No_Expired_A','expected_revision',rev)));
 select count(*) into n from public.stock_movements where branch_id='TST_REV';
 if n<>3 then raise exception 'FAIL ledger insert/update/delete coverage: %',n;end if;
 if (select sum(delta) from public.stock_movements where branch_id='TST_REV')<>0 then raise exception 'FAIL ledger does not balance';end if;
 begin
 perform public.commit_wms_write('20000000-0000-4000-8000-000000000005','TST_REV',jsonb_build_array(jsonb_build_object('collection_name','stock','document_id','SKU_No_Expired_A','expected_revision',rev,'payload',jsonb_build_object('skuId','SKU','location','A','qty',200))),'[]');
 raise exception 'FAIL deleted version recreated';
 exception when sqlstate 'PT409' then null;end;
 begin
 perform public.commit_wms_write('20000000-0000-4000-8000-000000000006','CENTER','[{"collection_name":"settings","document_id":"denied","expected_revision":null,"payload":{}}]','[]');
 raise exception 'FAIL foreign write';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end $$;
reset role;
rollback;
select 'PASS: exact-once request retry, stale writes rejected, all-or-nothing batch, direct write blocked, immutable balanced stock ledger, deleted-version protection and branch isolation. Fixtures rolled back.' as result;
