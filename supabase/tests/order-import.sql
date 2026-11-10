
begin;
insert into public.branches(id,name) values('TST_IMP','Import Test');
insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-4000-8000-0000000000b8','import-test@example.invalid','{}');
update public.profiles set role='Admin',branch_id='TST_IMP',is_active=true where id='00000000-0000-4000-8000-0000000000b8';
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values('TST_IMP','stock','TEST_No_Expired_E1', '{"id":"TEST_No_Expired_E1","skuId":"TEST","skuName":"Test","qty":10,"location":"E1","expiredDate":"No Expired","warehouseId":"WH-CENTRAL"}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b8',true);
do $$
declare items jsonb; first_result jsonb; retry_result jsonb; n integer; q numeric;
begin
items='[{"id":"IMP_30000000000040008000000000000001_0","timestamp":"2026-11-05T10:00:00Z","referenceNumber":"TEST-ORDER-1","orderNumber":"TEST-ORDER-1","skuId":"TEST","skuName":"Test","qty":4,"location":"E1","expiredDate":"No Expired","warehouseId":"WH-CENTRAL","status":"Pending","stockDeducted":false,"picked":false,"scanned":false}]';
first_result=public.import_wms_orders('30000000-0000-4000-8000-000000000001','TST_IMP','WH-CENTRAL',items);
retry_result=public.import_wms_orders('30000000-0000-4000-8000-000000000001','TST_IMP','WH-CENTRAL',items);
if first_result<>retry_result then raise exception 'FAIL retry';end if;
select count(*) into n from public.wms_documents where branch_id='TST_IMP' and collection_name='orders';
if n<>1 then raise exception 'FAIL duplicate retry';end if;
select (payload->>'qty')::numeric into q from public.wms_documents where branch_id='TST_IMP' and collection_name='stock';
if (select count(*) from public.wms_documents where branch_id='TST_IMP' and collection_name='batches')<>1 then raise exception 'FAIL batch sync';end if;
if q<>10 then raise exception 'FAIL physical stock deducted';end if;
-- A new request with the same order number must fail.
begin
perform public.import_wms_orders('30000000-0000-4000-8000-000000000002','TST_IMP','WH-CENTRAL',jsonb_set(items,'{0,id}','"IMP_30000000000040008000000000000002_0"'));
raise exception 'FAIL duplicate order';
exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
-- 7 requested + 4 reserved > 10 physical; transaction must remain empty.
items=jsonb_set(jsonb_set(jsonb_set(jsonb_set(items,'{0,id}','"IMP_30000000000040008000000000000003_0"'),'{0,orderNumber}','"TEST-ORDER-2"'),'{0,referenceNumber}','"TEST-ORDER-2"'),'{0,qty}','7');
begin
perform public.import_wms_orders('30000000-0000-4000-8000-000000000003','TST_IMP','WH-CENTRAL',items);
raise exception 'FAIL oversubscribed reserved stock';
exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
if exists(select 1 from public.wms_documents where branch_id='TST_IMP' and payload->>'orderNumber'='TEST-ORDER-2') then raise exception 'FAIL partial import';end if;
begin
perform public.import_wms_orders('30000000-0000-4000-8000-000000000003','CENTER','WH-CENTRAL',items);
raise exception 'FAIL foreign branch';
exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
-- Block damaged/expired, buffer, fractional and malformed lines.
for n in 1..4 loop
begin
perform public.import_wms_orders('30000000-0000-4000-8000-000000000003','TST_IMP','WH-CENTRAL',
case n when 1 then jsonb_set(items,'{0,expiredDate}','"DAMAGE"') when 2 then jsonb_set(items,'{0,location}','"ZONE1"') when 3 then jsonb_set(items,'{0,qty}','1.5') else jsonb_set(items,'{0,expiredDate}','"01/01/2020"') end);
raise exception 'FAIL invalid line %',n;
exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end loop;
end $$;

do $$
declare base jsonb; items jsonb; n integer;
begin
base='{"timestamp":"2026-11-05T10:00:00Z","skuId":"TEST","skuName":"Test","location":"E1","expiredDate":"No Expired","warehouseId":"WH-CENTRAL","status":"Pending","stockDeducted":false,"picked":false,"scanned":false,"batchNumber":"IMPORT-BATCH"}';
items=jsonb_build_array(base||'{"id":"IMP_30000000000040008000000000000005_0","referenceNumber":"MULTI-1","orderNumber":"MULTI-1","qty":3}',base||'{"id":"IMP_30000000000040008000000000000005_1","referenceNumber":"MULTI-2","orderNumber":"MULTI-2","qty":3}');
perform public.import_wms_orders('30000000-0000-4000-8000-000000000005','TST_IMP','WH-CENTRAL',items);
if (select count(*) from public.wms_documents where branch_id='TST_IMP' and collection_name='orders')<>3 then raise exception 'FAIL multi-order';end if;
if (select (payload->>'totalPcs')::numeric from public.wms_documents where branch_id='TST_IMP' and collection_name='batches' and payload->>'batchNumber'='IMPORT-BATCH')<>6 then raise exception 'FAIL batch qty';end if;
if (select count(*) from public.wms_documents where branch_id='TST_IMP' and collection_name='logs')<>3 then raise exception 'FAIL import logs';end if;
end $$;
reset role;
update public.profiles set role='Viewer' where id='00000000-0000-4000-8000-0000000000b8';
set local role authenticated;
do $$begin
begin
perform public.import_wms_orders('30000000-0000-4000-8000-000000000004','TST_IMP','WH-CENTRAL','[{}]');
raise exception 'FAIL Viewer import';
exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end$$;
rollback;
