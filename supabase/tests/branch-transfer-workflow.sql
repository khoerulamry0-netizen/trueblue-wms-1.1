
begin;
insert into public.branches(id,name) values('TST_SRC','Test Source'),('TST_DST','Test Destination'),('TST_OUT','Test Outsider');
insert into auth.users(id,email,raw_user_meta_data) values
('00000000-0000-4000-8000-0000000000a2','transfer-src@example.invalid','{}'),
('00000000-0000-4000-8000-0000000000b2','transfer-dst@example.invalid','{}'),
('00000000-0000-4000-8000-0000000000c2','transfer-out@example.invalid','{}');
update public.profiles set role='Admin',is_active=true,branch_id=case id when '00000000-0000-4000-8000-0000000000a2' then 'TST_SRC' when '00000000-0000-4000-8000-0000000000b2' then 'TST_DST' else 'TST_OUT' end where id in ('00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000c2');
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values
('TST_SRC','stock','SKU_No_Expired_A','{"id":"SKU_No_Expired_A","skuId":"SKU","skuName":"Test","expiredDate":"No Expired","location":"A","qty":100}'),
('TST_DST','stock','SKU_No_Expired_B','{"id":"SKU_No_Expired_B","skuId":"SKU","skuName":"Test","expiredDate":"No Expired","location":"B","qty":5}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a2',true);
do $$declare t jsonb; q numeric;begin
 t=public.branch_transfer_action('10000000-0000-4000-8000-000000000001','create','TST_SRC','TST_DST','[{"stock_id":"SKU_No_Expired_A","qty":10}]','test');
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','create','TST_SRC','TST_DST','[{"stock_id":"SKU_No_Expired_A","qty":10}]','test');
 select (payload->>'qty')::numeric into q from public.wms_documents where branch_id='TST_SRC' and collection_name='stock';
 if q<>100 then raise exception 'FAIL draft deducted';end if;
 begin
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','transit');
 raise exception 'FAIL skipped ship';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','ship');
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','ship');
 select (payload->>'qty')::numeric into q from public.wms_documents where branch_id='TST_SRC' and collection_name='stock';
 if q<>90 then raise exception 'FAIL duplicate deduction';end if;
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','transit');
 begin
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','receive',null,null,'[{"good":7,"damaged":1,"location":"B"}]','test');
 raise exception 'FAIL source received';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 begin
 delete from public.branch_transfers;
 raise exception 'FAIL direct delete';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$declare q numeric; t jsonb;begin
 select (payload->>'qty')::numeric into q from public.wms_documents where branch_id='TST_DST' and collection_name='stock';
 if q<>5 then raise exception 'FAIL destination credited early';end if;
 begin
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','receive',null,null,'[{"good":11,"damaged":0,"location":"B"}]','over');
 raise exception 'FAIL excess receipt';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 begin
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','receive',null,null,'[{"good":7,"damaged":1,"location":"B"}]','');
 raise exception 'FAIL discrepancy without notes';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 t=public.branch_transfer_action('10000000-0000-4000-8000-000000000001','receive',null,null,'[{"good":7,"damaged":1,"location":"B"}]','1 damaged; 2 missing');
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','receive',null,null,'[{"good":7,"damaged":1,"location":"B"}]','1 damaged; 2 missing');
 if t->>'status'<>'RECEIVED' then raise exception 'FAIL final status';end if;
 select (payload->>'qty')::numeric into q from public.wms_documents where branch_id='TST_DST' and collection_name='stock';
 if q<>12 then raise exception 'FAIL receipt not exact once: %',q;end if;
 select count(*) into q from public.wms_documents where collection_name='logs';
 if q<>1 then raise exception 'FAIL duplicate receipt log';end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c2',true);
do $$declare n int;begin
 select count(*) into n from public.branch_transfers;
 if n<>0 then raise exception 'FAIL outsider read';end if;
 begin
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000001','ship');
 raise exception 'FAIL outsider action';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a2',true);
do $$declare q numeric;t jsonb;begin
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000002','create','TST_SRC','TST_DST','[{"stock_id":"SKU_No_Expired_A","qty":80}]','cancel');
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000002','cancel',null,null,null,'Not needed');
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000002','cancel',null,null,null,'Not needed');
 select (payload->>'qty')::numeric into q from public.wms_documents where branch_id='TST_SRC' and collection_name='stock';
 if q<>90 then raise exception 'FAIL cancel changed stock';end if;
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000003','create','TST_SRC','TST_DST','[{"stock_id":"SKU_No_Expired_A","qty":80}]','short');
 perform public.commit_wms_write('20000000-0000-4000-8000-000000000099','TST_SRC',
 jsonb_build_array(jsonb_build_object('collection_name','stock','document_id','SKU_No_Expired_A','expected_revision',(select revision from public.wms_documents where branch_id='TST_SRC' and collection_name='stock' and document_id='SKU_No_Expired_A'),'merge',true,'payload',jsonb_build_object('qty',70))),'[]');
 begin
 perform public.branch_transfer_action('10000000-0000-4000-8000-000000000003','ship');
 raise exception 'FAIL insufficient stock shipped';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 if (select status from public.branch_transfers where id='10000000-0000-4000-8000-000000000003')<>'DRAFT' then raise exception 'FAIL failed shipment changed status';end if;
end $$;

reset role;
rollback;
select 'PASS: complete cross-branch workflow, source/destination permissions, delayed stock credit, retry safety, discrepancy validation, atomic logs and outsider isolation. Fixtures rolled back.' as result;
