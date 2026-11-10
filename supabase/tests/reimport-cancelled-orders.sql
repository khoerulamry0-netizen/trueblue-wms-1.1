begin;

insert into public.branches(id,name) values('TST_REUSE','Synthetic cancelled reimport');
insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-4000-8000-0000000000c9','reuse-test@example.invalid','{}');
update public.profiles set role='Admin',branch_id='TST_REUSE',is_active=true,full_name='Synthetic Admin' where id='00000000-0000-4000-8000-0000000000c9';
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values
('TST_REUSE','stock','TEST_No_Expired_E1','{"id":"TEST_No_Expired_E1","skuId":"TEST","skuName":"Test","qty":10,"location":"E1","expiredDate":"--","warehouseId":"WH-CENTRAL"}'),
('TST_REUSE','orders','OLD_CANCEL','{"id":"OLD_CANCEL","referenceNumber":"REUSE-1","orderNumber":"REUSE-1","qty":2,"skuId":"TEST","location":"E1","expiredDate":"--","warehouseId":"WH-CENTRAL","status":"Cancelled","stockDeducted":false,"picked":false}'),
('TST_REUSE','batches','OLD_BATCH','{"id":"OLD_BATCH","batchNumber":"REUSE-1","shippingStatus":"SUDAH_TERKIRIM","totalPcs":7,"items":[{"id":"OLD_CANCEL","qty":7}]}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c9',true);
do $t$ declare items jsonb;base jsonb;one jsonb;two jsonb;rv bigint;begin
base='{"timestamp":"2026-11-06T02:00:00Z","orderNumber":"REUSE-1","skuId":"TEST","skuName":"Test","qty":2,"location":"E1","expiredDate":"--","warehouseId":"WH-CENTRAL","status":"Pending","stockDeducted":false,"picked":false,"scanned":false}';
items=jsonb_build_array(base||'{"id":"IMP_40000000000040008000000000000001_0","referenceNumber":"REIMP_40000000000040008000000000000001_0","batchNumber":"REIMP_40000000000040008000000000000001_0"}');
one=public.import_wms_orders('40000000-0000-4000-8000-000000000001','TST_REUSE','WH-CENTRAL',items);
two=public.import_wms_orders('40000000-0000-4000-8000-000000000001','TST_REUSE','WH-CENTRAL',items);
if one<>two then raise exception 'FAIL retry differs';end if;
if (select count(*) from public.wms_documents where branch_id='TST_REUSE' and collection_name='orders')<>2 then raise exception 'FAIL duplicate import';end if;
if not exists(select 1 from public.wms_documents where branch_id='TST_REUSE' and document_id='OLD_CANCEL' and payload->>'status'='Cancelled') then raise exception 'FAIL old cancellation changed';end if;
if not exists(select 1 from public.wms_documents where branch_id='TST_REUSE' and document_id='OLD_BATCH' and payload->>'totalPcs'='7' and payload->>'shippingStatus'='SUDAH_TERKIRIM') then raise exception 'FAIL old batch changed';end if;
if not exists(select 1 from public.wms_documents where branch_id='TST_REUSE' and collection_name='batches' and payload->>'batchNumber'='REIMP_40000000000040008000000000000001_0' and payload->>'totalPcs'='2') then raise exception 'FAIL new batch not isolated';end if;
begin perform public.import_wms_orders('40000000-0000-4000-8000-000000000002','TST_REUSE','WH-CENTRAL',jsonb_build_array(base||'{"id":"IMP_40000000000040008000000000000002_0","referenceNumber":"REIMP_40000000000040008000000000000002_0","batchNumber":"REIMP_40000000000040008000000000000002_0"}'));raise exception 'FAIL active duplicate accepted';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
select revision into rv from public.wms_documents where branch_id='TST_REUSE' and document_id='IMP_40000000000040008000000000000001_0';
perform public.cancel_wms_orders('TST_REUSE',jsonb_build_array(jsonb_build_object('id','IMP_40000000000040008000000000000001_0','expected_revision',rv)),'Synthetic repeat import');
items=jsonb_build_array(base||'{"id":"IMP_40000000000040008000000000000003_0","referenceNumber":"REIMP_40000000000040008000000000000003_0","batchNumber":"REIMP_40000000000040008000000000000003_0"}');
perform public.import_wms_orders('40000000-0000-4000-8000-000000000003','TST_REUSE','WH-CENTRAL',items);
if (select (payload->>'qty')::int from public.wms_documents where branch_id='TST_REUSE' and collection_name='stock')<>10 then raise exception 'FAIL import/cancel changed physical stock';end if;
end;$t$;
reset role;update public.profiles set role='Picker' where id='00000000-0000-4000-8000-0000000000c9';set local role authenticated;
do $t$ declare o jsonb;s jsonb;orv bigint;srv bigint;ups jsonb;rid uuid=gen_random_uuid();begin
select payload,revision into o,orv from public.wms_documents where branch_id='TST_REUSE' and document_id='IMP_40000000000040008000000000000003_0';
select payload,revision into s,srv from public.wms_documents where branch_id='TST_REUSE' and collection_name='stock';
ups=jsonb_build_array(jsonb_build_object('collection_name','orders','document_id',o->>'id','expected_revision',orv,'payload',o||'{"picked":true,"isPicked":true,"stockDeducted":true}'),jsonb_build_object('collection_name','stock','document_id',s->>'id','expected_revision',srv,'payload',s||'{"qty":8}'));
perform public.commit_wms_write(rid,'TST_REUSE',ups,'[]');perform public.commit_wms_write(rid,'TST_REUSE',ups,'[]');
if (select (payload->>'qty')::int from public.wms_documents where branch_id='TST_REUSE' and collection_name='stock')<>8 then raise exception 'FAIL repeated deduction';end if;
end;$t$;
reset role;update public.profiles set role='Packer' where id='00000000-0000-4000-8000-0000000000c9';set local role authenticated;
do $t$ declare o jsonb;rv bigint;begin
select payload,revision into o,rv from public.wms_documents where branch_id='TST_REUSE' and document_id='IMP_40000000000040008000000000000003_0';
perform public.commit_wms_write(gen_random_uuid(),'TST_REUSE',jsonb_build_array(jsonb_build_object('collection_name','orders','document_id',o->>'id','expected_revision',rv,'payload',o||'{"status":"Completed","scanned":true}')),'[]');
end;$t$;
reset role;update public.profiles set role='Admin' where id='00000000-0000-4000-8000-0000000000c9';set local role authenticated;
do $t$ declare item jsonb;begin
select payload into item from public.wms_documents where branch_id='TST_REUSE' and document_id='IMP_40000000000040008000000000000003_0';
item=item||'{"id":"IMP_40000000000040008000000000000004_0","referenceNumber":"REIMP_40000000000040008000000000000004_0","batchNumber":"REIMP_40000000000040008000000000000004_0","status":"Pending","stockDeducted":false,"picked":false,"scanned":false}';
begin perform public.import_wms_orders('40000000-0000-4000-8000-000000000004','TST_REUSE','WH-CENTRAL',jsonb_build_array(item));raise exception 'FAIL completed duplicate accepted';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
if (select count(*) from public.wms_documents where branch_id='TST_REUSE' and collection_name='orders')<>3 then raise exception 'FAIL old rows or partial write';end if;
if (select (payload->>'qty')::int from public.wms_documents where branch_id='TST_REUSE' and collection_name='stock')<>8 then raise exception 'FAIL packing changed stock';end if;
end;$t$;
reset role;

rollback;