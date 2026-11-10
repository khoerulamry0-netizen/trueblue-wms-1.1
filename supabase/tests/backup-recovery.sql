
begin;
insert into public.branches(id,name) values('TST_BK','Backup Test');
insert into auth.users(id,email,raw_user_meta_data) values
('00000000-0000-4000-8000-0000000000a6','backup-hq@example.invalid','{}'),
('00000000-0000-4000-8000-0000000000b6','backup-admin@example.invalid','{}');
update public.profiles set role=case when id='00000000-0000-4000-8000-0000000000a6' then 'Administrator' else 'Admin' end,branch_id='TST_BK',is_active=true where id in ('00000000-0000-4000-8000-0000000000a6','00000000-0000-4000-8000-0000000000b6');
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values('TST_BK','stock','SKU_No_Expired_A','{"id":"SKU_No_Expired_A","skuId":"SKU","location":"A","expiredDate":"No Expired","qty":10}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a6',true);
do $$declare id uuid;file jsonb;preview jsonb;r jsonb;rev bigint;safety uuid;qty numeric;n integer;
begin
 id=(public.branch_backup_action('create','TST_BK')->>'backup_id')::uuid;
 file=public.branch_backup_action('export','TST_BK',id);
 if file->>'payload_text' like '%encrypted_password%' then raise exception 'FAIL auth secret archived';end if;
 if (file->>'payload_text')::jsonb->'branch'->>'id'<>'TST_BK' then raise exception 'FAIL wrong branch archived';end if;
 begin perform public.branch_backup_action('import','TST_BK',null,null,'',file||jsonb_build_object('sha256','bad'));raise exception 'FAIL corrupt backup accepted';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 begin perform public.branch_backup_action('import','CENTER',null,null,'',file);raise exception 'FAIL foreign file accepted';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 r=public.branch_backup_action('import','TST_BK',null,null,'',file);
 if public.branch_backup_action('export','TST_BK',(r->>'backup_id')::uuid)->>'sha256' is distinct from file->>'sha256' then raise exception 'FAIL import changed archive';end if;
 select revision into rev from public.wms_documents where branch_id='TST_BK' and collection_name='stock';
 perform public.commit_wms_write('40000000-0000-4000-8000-000000000001','TST_BK',jsonb_build_array(jsonb_build_object('collection_name','stock','document_id','SKU_No_Expired_A','expected_revision',rev,'merge',true,'payload',jsonb_build_object('qty',3)),jsonb_build_object('collection_name','catalog','document_id','EXTRA','expected_revision',null,'payload',jsonb_build_object('id','EXTRA','skuId','EXTRA'))),'[]');
 preview=public.branch_backup_action('preview','TST_BK',id);
 if (preview->>'update')::integer<>1 or (preview->>'remove')::integer<>1 then raise exception 'FAIL preview inaccurate: %',preview;end if;
 select revision into rev from public.wms_documents where branch_id='TST_BK' and collection_name='stock';
 perform public.commit_wms_write('40000000-0000-4000-8000-000000000002','TST_BK',jsonb_build_array(jsonb_build_object('collection_name','stock','document_id','SKU_No_Expired_A','expected_revision',rev,'merge',true,'payload',jsonb_build_object('qty',4))),'[]');
 begin perform public.branch_backup_action('restore','TST_BK',id,preview->>'token','Restore test snapshot');raise exception 'FAIL stale preview restored';exception when serialization_failure then null;end;

 perform public.commit_wms_write('40000000-0000-4000-8000-000000000003','TST_BK','[{"collection_name":"orders","document_id":"PENDING_TEST","expected_revision":null,"payload":{"id":"PENDING_TEST","skuId":"SKU","location":"A","qty":1,"status":"Pending","stockDeducted":false}}]','[]');
 preview=public.branch_backup_action('preview','TST_BK',id);
 if (preview->>'blocked_operations')::integer<1 then raise exception 'FAIL pending operation not detected';end if;
 begin perform public.branch_backup_action('restore','TST_BK',id,preview->>'token','Blocked recovery test');raise exception 'FAIL pending order allowed restore';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 perform public.cancel_wms_orders('TST_BK',jsonb_build_array(jsonb_build_object('id','PENDING_TEST','expected_revision',(select revision from public.wms_documents where branch_id='TST_BK' and document_id='PENDING_TEST'))),'Finish temporary pending test');

 preview=public.branch_backup_action('preview','TST_BK',id);
 select count(*) into n from public.activity_events where branch_id='TST_BK';
 r=public.branch_backup_action('restore','TST_BK',id,preview->>'token','Restore test snapshot');
 safety=(r->>'safety_backup_id')::uuid;
 select (payload->>'qty')::numeric into qty from public.wms_documents where branch_id='TST_BK' and collection_name='stock';
 if qty<>10 then raise exception 'FAIL stock restore %',qty;end if;
 if exists(select 1 from public.wms_documents where branch_id='TST_BK' and collection_name='catalog') then raise exception 'FAIL extra master row retained';end if;
 file=public.branch_backup_action('export','TST_BK',safety);
 if not exists(select 1 from jsonb_array_elements((file->>'payload_text')::jsonb->'documents') j where j->>'collection_name'='stock' and j->'payload'->>'qty'='4') then raise exception 'FAIL safety backup did not retain prior state';end if;
 if not exists(select 1 from public.wms_documents where branch_id='TST_BK' and document_id='PENDING_TEST' and payload->>'status'='Cancelled') then raise exception 'FAIL historical order rewound';end if;
 if (select count(*) from public.activity_events where branch_id='TST_BK')<=n then raise exception 'FAIL history removed';end if;
 if not exists(select 1 from public.stock_movements where branch_id='TST_BK' and operation_type='BACKUP_RESTORE' and delta=6) then raise exception 'FAIL recovery stock movement missing';end if;
 perform set_config('test.backup_id',id::text,true);
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b6',true);
do $$declare id uuid;preview jsonb;begin
 id=current_setting('test.backup_id')::uuid;
 preview=public.branch_backup_action('preview','TST_BK',id);
 if (preview->>'can_restore')::boolean then raise exception 'FAIL branch admin can restore';end if;
 begin perform public.branch_backup_action('restore','TST_BK',id,preview->>'token','Unauthorized restore');raise exception 'FAIL branch admin restored';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
 begin perform public.branch_backup_action('create','CENTER');raise exception 'FAIL foreign branch backup';exception when raise_exception then if sqlerrm like 'FAIL%' then raise;end if;end;
end $$;
reset role;
rollback;
select 'PASS: backup export/import checksum, branch scope, accurate preview, stale-preview rejection, stock/master recovery, automatic safety snapshot, preserved audit, recovery ledger and HQ-only restore. Fixtures rolled back.' as result;
