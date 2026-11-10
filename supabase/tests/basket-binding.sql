begin;
insert into public.branches(id,name) values('TST_BIND','Synthetic basket test');
do $$
declare actor uuid=gen_random_uuid();rid uuid=gen_random_uuid();ups jsonb;first_result jsonb;retry_result jsonb;before_revision bigint;bad jsonb;
begin
 insert into auth.users(id,email,raw_user_meta_data) values(actor,'basket-'||actor||'@example.invalid','{}');
 update public.profiles set role='Picker',is_active=true,branch_id='TST_BIND',full_name='Synthetic Picker' where id=actor;
 insert into public.wms_documents(branch_id,collection_name,document_id,payload) values('TST_BIND','stock','SYNTH_STOCK','{"id":"SYNTH_STOCK","skuId":"SYNTH","qty":10,"location":"A1","expiredDate":"--","warehouseId":"WH-CENTRAL"}');
 insert into public.wms_documents(branch_id,collection_name,document_id,payload)
 select 'TST_BIND','orders','SYNTH_ORDER_'||i,jsonb_build_object('id','SYNTH_ORDER_'||i,'referenceNumber','SYNTH_REF_'||i,'skuId','SYNTH','qty',1,'location','A1','expiredDate','--','warehouseId','WH-CENTRAL','status','Pending','picked',false,'stockDeducted',false,'basketNumber',case when i=4 then 'OTHER' else '' end) from generate_series(1,4)i;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 set local role authenticated;
 select jsonb_agg(jsonb_build_object('collection_name','orders','document_id',document_id,'expected_revision',revision,'payload',payload||jsonb_build_object('basketNumber','A123','pickingBy','Synthetic Picker','pickingStartedAt',now()))) into ups
 from public.wms_documents where branch_id='TST_BIND' and collection_name='orders' and document_id<>'SYNTH_ORDER_4';
 first_result=public.commit_wms_write(rid,'TST_BIND',ups,'[]');
 retry_result=public.commit_wms_write(rid,'TST_BIND',ups,'[]');
 if first_result<>retry_result then raise exception 'FAIL request retry changed result';end if;
 if (select count(*) from public.wms_documents where branch_id='TST_BIND' and collection_name='orders' and payload->>'basketNumber'='A123')<>3 then raise exception 'FAIL not all three orders bound';end if;
 if exists(select 1 from public.wms_documents where branch_id='TST_BIND' and collection_name='orders' and ((payload->>'qty')::int<>1 or payload->>'picked'<>'false' or payload->>'stockDeducted'<>'false' or payload->>'status'<>'Pending')) then raise exception 'FAIL binding changed allocation or picking';end if;
 if (select payload->>'qty' from public.wms_documents where branch_id='TST_BIND' and collection_name='stock')<>'10' then raise exception 'FAIL binding deducted stock';end if;
 if (select payload->>'basketNumber' from public.wms_documents where branch_id='TST_BIND' and document_id='SYNTH_ORDER_4')<>'OTHER' then raise exception 'FAIL unrelated order changed';end if;
 begin perform public.commit_wms_write(gen_random_uuid(),'TST_BIND',ups,'[]');raise exception 'FAIL stale request accepted';exception when sqlstate 'PT409' then null;end;
 select revision into before_revision from public.wms_documents where branch_id='TST_BIND' and document_id=ups->0->>'document_id';
 bad=jsonb_set(jsonb_set(ups,'{0,expected_revision}',to_jsonb(before_revision)),'{0,payload,basketNumber}','"MUST_NOT_SAVE"');
 begin perform public.commit_wms_write(gen_random_uuid(),'TST_BIND',bad,'[]');raise exception 'FAIL partially stale batch accepted';exception when sqlstate 'PT409' then null;end;
 if exists(select 1 from public.wms_documents where branch_id='TST_BIND' and payload->>'basketNumber'='MUST_NOT_SAVE') then raise exception 'FAIL partial write';end if;
 reset role;
end $$;
rollback;
select 'PASS: Picker binds three orders atomically; duplicate request is idempotent; stale and partly stale batches return PT409; stock and unrelated order unchanged. Fixtures rolled back.' result;
