
begin;
insert into public.branches(id,name) values('TST_AUD','Audit Test'),('TST_OTHER','Other');
insert into auth.users(id,email,raw_user_meta_data) values
('00000000-0000-4000-8000-0000000000a5','audit-admin@example.invalid','{}'),
('00000000-0000-4000-8000-0000000000b5','audit-picker@example.invalid','{}'),
('00000000-0000-4000-8000-0000000000c5','audit-other@example.invalid','{}');
update public.profiles set role=case when id='00000000-0000-4000-8000-0000000000b5' then 'Picker' else 'Admin' end,is_active=true,branch_id=case when id='00000000-0000-4000-8000-0000000000c5' then 'TST_OTHER' else 'TST_AUD' end where id in ('00000000-0000-4000-8000-0000000000a5','00000000-0000-4000-8000-0000000000b5','00000000-0000-4000-8000-0000000000c5');
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values
('TST_AUD','stock','SKU_No_Expired_A','{"id":"SKU_No_Expired_A","skuId":"SKU","skuName":"Test","location":"A","expiredDate":"No Expired","qty":90}'),
('TST_AUD','orders','o1','{"id":"o1","skuId":"SKU","skuName":"Test","location":"A","expiredDate":"No Expired","qty":10,"status":"Completed","stockDeducted":true}'),
('TST_AUD','orders','o2','{"id":"o2","skuId":"SKU","location":"A","expiredDate":"No Expired","qty":5,"status":"Pending","stockDeducted":false}'),
('TST_AUD','orders','o3','{"id":"o3","skuId":"SKU","location":"A","expiredDate":"No Expired","qty":5,"status":"Completed","stockDeducted":true,"shipped":true}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a5',true);
do $$declare rev bigint;q numeric;n int;items jsonb;begin
 select revision into rev from public.wms_documents where document_id='o1' and branch_id='TST_AUD';
 items=jsonb_build_array(jsonb_build_object('id','o1','expected_revision',rev));
 begin perform public.cancel_wms_orders('TST_AUD',items,'no');raise exception 'FAIL short reason';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 perform public.cancel_wms_orders('TST_AUD',items,'Customer cancelled before dispatch');
 perform public.cancel_wms_orders('TST_AUD',items,'Customer cancelled before dispatch');
 select (payload->>'qty')::numeric into q from public.wms_documents where collection_name='stock' and branch_id='TST_AUD';
 if q<>100 then raise exception 'FAIL duplicate stock refund %',q;end if;
 if not exists(select 1 from public.wms_documents where branch_id='TST_AUD' and document_id='o1' and payload->>'status'='Cancelled' and payload->>'cancellationReason'='Customer cancelled before dispatch') then raise exception 'FAIL original order missing';end if;
 if not exists(select 1 from public.activity_events where branch_id='TST_AUD' and entity_type='orders' and entity_id='o1' and before_data->>'status'='Completed' and after_data->>'status'='Cancelled' and actor_id=auth.uid() and reason='Customer cancelled before dispatch') then raise exception 'FAIL audit actor/reason before after';end if;
 select revision into rev from public.wms_documents where document_id='o2' and branch_id='TST_AUD';
 perform public.cancel_wms_orders('TST_AUD',jsonb_build_array(jsonb_build_object('id','o2','expected_revision',rev)),'Draft no longer needed');
 select (payload->>'qty')::numeric into q from public.wms_documents where collection_name='stock' and branch_id='TST_AUD';
 if q<>100 then raise exception 'FAIL undeducted draft refunded';end if;
 begin
 perform public.cancel_wms_orders('TST_AUD',jsonb_build_array(jsonb_build_object('id','o3','expected_revision',(select revision from public.wms_documents where document_id='o3' and branch_id='TST_AUD'))),'Already dispatched');
 raise exception 'FAIL shipped cancelled';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 begin
 perform public.commit_wms_write('30000000-0000-4000-8000-000000000001','TST_AUD',jsonb_build_array(jsonb_build_object('collection_name','orders','document_id','o1','expected_revision',(select revision from public.wms_documents where document_id='o1' and branch_id='TST_AUD'),'merge',true,'payload',jsonb_build_object('status','Pending'))),'[]');
 raise exception 'FAIL cancelled order reopened';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 begin delete from public.activity_events;raise exception 'FAIL audit deleted';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b5',true);
do $$declare n int;begin
 select count(*) into n from public.activity_events;
 if n<>0 then raise exception 'FAIL picker reads admin audit';end if;
 begin perform public.cancel_wms_orders('TST_AUD','[{"id":"o3","expected_revision":1}]','Unauthorized attempt');raise exception 'FAIL picker cancel';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c5',true);
do $$begin
 if exists(select 1 from public.activity_events where branch_id='TST_AUD') then raise exception 'FAIL cross branch audit';end if;
 begin perform public.cancel_wms_orders('TST_AUD','[{"id":"o3","expected_revision":1}]','Unauthorized branch');raise exception 'FAIL foreign admin cancel';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end $$;
reset role;
rollback;
select 'PASS: original orders retained, exact-once stock refund, undeducted drafts no refund, shipped order denied, reason and actor audited, cancelled order immutable, audit immutable and branch/admin permissions. Fixtures rolled back.' as result;
