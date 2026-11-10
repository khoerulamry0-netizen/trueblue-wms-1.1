
begin;
insert into public.branches(id,name) values('TST_HQA','HQ Test A'),('TST_HQB','HQ Test B');
insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-4000-8000-0000000000a7','hq-test@example.invalid','{}'),('00000000-0000-4000-8000-0000000000b7','branch-admin-test@example.invalid','{}');
update public.profiles set role=case when id='00000000-0000-4000-8000-0000000000a7' then 'Administrator' else 'Admin' end,branch_id='TST_HQA',is_active=true where id in ('00000000-0000-4000-8000-0000000000a7','00000000-0000-4000-8000-0000000000b7');
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values
('TST_HQA','stock','A1','{"id":"A1","skuId":"SKU_A","skuName":"Safe A","location":"A","expiredDate":"No Expired","qty":4}'),
('TST_HQA','stock','A2','{"id":"A2","skuId":"SKU_A","skuName":"Safe A","location":"B","expiredDate":"No Expired","qty":7}'),
('TST_HQA','stock','B1',jsonb_build_object('id','B1','skuId','SKU_B','skuName','Expired B','location','A','expiredDate',to_char((now() at time zone 'Asia/Jakarta')::date-1,'DD/MM/YYYY'),'qty',2)),
('TST_HQA','stock','D1',jsonb_build_object('id','D1','skuId','SKU_D','skuName','Near D','location','A','expiredDate',to_char((now() at time zone 'Asia/Jakarta')::date+30,'DD/MM/YYYY'),'qty',3)),
('TST_HQA','stock','E1','{"id":"E1","skuId":"SKU_E","skuName":"Unknown E","location":"A","expiredDate":"not-a-date","qty":1}'),
('TST_HQA','catalog','SKU_C','{"id":"SKU_C","skuId":"SKU_C","skuName":"Empty C"}'),
('TST_HQB','stock','A1','{"id":"A1","skuId":"SKU_A","location":"A","expiredDate":"No Expired","qty":100}'),
('TST_HQA','orders','P1','{"id":"P1","skuId":"SKU_A","qty":1,"status":"Pending"}'),
('TST_HQA','stock','SYSTEM_EMPTY_FLAG','{"id":"SYSTEM_EMPTY_FLAG","qty":9999}');
insert into public.branch_transfers(id,source_branch,destination_branch,status,request_items,items,created_at)
values('50000000-0000-4000-8000-000000000001','TST_HQA','TST_HQB','IN_TRANSIT','[]','[{"qty":5,"stock_id":"A1","stock":{"skuId":"SKU_A"}}]',now()-interval '25 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a7',true);
do $$declare result jsonb;totals jsonb;begin
 result=public.hq_dashboard(10,90,'TST_HQA');totals=result->'totals';
 if (totals->>'qty')::numeric<>17 then raise exception 'FAIL stock sum/system marker: %',totals;end if;
 if (totals->>'active_skus')::integer<>4 then raise exception 'FAIL active SKU aggregation';end if;
 if (totals->>'low_sku_positions')::integer<>4 then raise exception 'FAIL low stock SKU aggregation';end if;
 if (totals->>'empty_sku_positions')::integer<>1 then raise exception 'FAIL catalog zero stock';end if;
 if (totals->>'near_qty')::numeric<>3 or (totals->>'expired_qty')::numeric<>2 or (totals->>'invalid_date_rows')::integer<>1 then raise exception 'FAIL expiry categories: %',totals;end if;
 if (totals->>'pending_transfers')::integer<>1 or (totals->>'overdue_transfers')::integer<>1 or (totals->>'pending_orders')::integer<>1 then raise exception 'FAIL pending counts';end if;
 if (result->'branches'->0->>'outgoing_transfers')::integer<>1 or (result->'branches'->0->>'incoming_transfers')::integer<>0 then raise exception 'FAIL outgoing/incoming';end if;
 if exists(select 1 from jsonb_array_elements(result->'low_stock') s where s->>'sku_id'='SKU_A') then raise exception 'FAIL split lots counted low';end if;
 result=public.hq_dashboard(10,7,'TST_HQA');
 if (result->'totals'->>'near_qty')::numeric<>0 then raise exception 'FAIL near-day filter';end if;
 result=public.hq_dashboard(10,90,'TST_HQB');
 if (result->'totals'->>'qty')::numeric<>100 or (result->'branches'->0->>'incoming_transfers')::integer<>1 then raise exception 'FAIL destination branch filter';end if;
 result=public.hq_dashboard(10,90,null);
 if (select count(*) from jsonb_array_elements(result->'pending_transfers') s where s->>'id'='50000000-0000-4000-8000-000000000001')<>1 then raise exception 'FAIL network transfer counted twice';end if;
 begin perform public.hq_dashboard(-1,90,null);raise exception 'FAIL invalid thresholds allowed';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b7',true);
do $$begin
 begin perform public.hq_dashboard(10,90,null);raise exception 'FAIL branch admin reads network';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end $$;
reset role;
rollback;
select 'PASS: HQ-only access, branch filters, SKU-lot aggregation, catalog stockouts, near/expired/invalid dates, system marker exclusion, pending orders, incoming/outgoing and unique network transfer counts. Fixtures rolled back.' as result;
