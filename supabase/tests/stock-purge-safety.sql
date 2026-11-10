begin;
insert into public.branches(id,name) values('QA_PURGE','Temporary purge test'),('QA_STALE','Temporary stale test');
insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-4000-8000-000000000092','purge-test@example.invalid','{}');
update public.profiles set role='Administrator',branch_id='QA_PURGE',is_active=true where id='00000000-0000-4000-8000-000000000092';
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values('QA_PURGE','stock','QA1','{"skuId":"QA1","location":"A","expiredDate":"No Expired","qty":10}'),('QA_PURGE','stock','QA2','{"skuId":"QA2","location":"B","expiredDate":"No Expired","qty":5}'),('QA_STALE','stock','QA3','{"skuId":"QA3","location":"C","expiredDate":"No Expired","qty":8}');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000092',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000092','session_id','qa-session','amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())-3600)))::text,true);
do $$begin
 begin perform public.stock_purge_action('prepare','QA_PURGE','60000000-0000-4000-8000-000000000001','HAPUS QA_PURGE','Uji pengosongan terisolasi');raise exception 'FAIL stale auth';exception when raise_exception then if sqlerrm like 'FAIL%' or position('Verifikasi ulang' in sqlerrm)=0 then raise;end if;end;
end $$;
select set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000092','session_id','qa-session','amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now()))))::text,true);
do $$declare plan jsonb;again jsonb;begin
 begin perform public.stock_purge_action('prepare','QA_PURGE','60000000-0000-4000-8000-000000000001','HAPUS CENTER','Uji pengosongan terisolasi');raise exception 'FAIL confirmation';exception when raise_exception then if sqlerrm like 'FAIL%' or position('Konfirmasi kode' in sqlerrm)=0 then raise;end if;end;
 begin perform public.commit_wms_write(gen_random_uuid(),'QA_PURGE','[]',(select jsonb_agg(jsonb_build_object('collection_name','stock','document_id',document_id,'expected_revision',revision)) from public.wms_documents where branch_id='QA_PURGE' and collection_name='stock'));raise exception 'FAIL generic wipe';exception when raise_exception then if sqlerrm like 'FAIL%' or position('rencana pengosongan' in sqlerrm)=0 then raise;end if;end;
 plan=public.stock_purge_action('prepare','QA_PURGE','60000000-0000-4000-8000-000000000001','HAPUS QA_PURGE','Uji pengosongan terisolasi');
 again=public.stock_purge_action('prepare','QA_PURGE','60000000-0000-4000-8000-000000000001','HAPUS QA_PURGE','Uji pengosongan terisolasi');if plan<>again then raise exception 'FAIL prepare retry';end if;
 if (plan->>'rows')::int<>2 or (plan->>'qty')::int<>15 or not exists(select 1 from public.branch_backups where id=(plan->>'backup_id')::uuid) then raise exception 'FAIL backup';end if;
 if (select count(*) from public.wms_documents where branch_id='QA_PURGE' and collection_name='stock')<>2 then raise exception 'FAIL prepare deleted';end if;
 if not exists(select 1 from public.activity_events where entity_id='60000000-0000-4000-8000-000000000001' and action='STOCK_PURGE_REQUESTED') then raise exception 'FAIL requested audit';end if;
 perform public.stock_purge_action('execute','QA_PURGE','60000000-0000-4000-8000-000000000001','HAPUS QA_PURGE','Uji pengosongan terisolasi');
 perform public.stock_purge_action('execute','QA_PURGE','60000000-0000-4000-8000-000000000001','HAPUS QA_PURGE','Uji pengosongan terisolasi');
 if exists(select 1 from public.wms_documents where branch_id='QA_PURGE' and collection_name='stock') then raise exception 'FAIL purge';end if;
 if (select count(*) from public.activity_events where entity_id='60000000-0000-4000-8000-000000000001' and action='STOCK_PURGE_COMPLETED')<>1 then raise exception 'FAIL execute retry';end if;
 if (select max(id) from public.activity_events where entity_id='60000000-0000-4000-8000-000000000001' and action='STOCK_PURGE_REQUESTED') >= (select min(id) from public.activity_events where branch_id='QA_PURGE' and entity_type='stock' and action='DELETE') then raise exception 'FAIL audit ordering';end if;
 if (select count(*) from public.wms_documents where branch_id='QA_STALE' and collection_name='stock')<>1 then raise exception 'FAIL foreign branch';end if;
 perform public.stock_purge_action('prepare','QA_STALE','60000000-0000-4000-8000-000000000002','HAPUS QA_STALE','Uji rencana kedaluwarsa');
end $$;
reset role;update public.wms_documents set payload=jsonb_set(payload,'{qty}','7') where branch_id='QA_STALE' and collection_name='stock';set local role authenticated;
do $$begin
 begin perform public.stock_purge_action('execute','QA_STALE','60000000-0000-4000-8000-000000000002','HAPUS QA_STALE','Uji rencana kedaluwarsa');raise exception 'FAIL changed data';exception when raise_exception then if sqlerrm like 'FAIL%' or position('Data berubah' in sqlerrm)=0 then raise;end if;end;
 perform public.stock_purge_action('cancel','QA_STALE','60000000-0000-4000-8000-000000000002','HAPUS QA_STALE','Uji rencana kedaluwarsa');
 begin perform public.stock_purge_action('execute','QA_STALE','60000000-0000-4000-8000-000000000002','HAPUS QA_STALE','Uji rencana kedaluwarsa');raise exception 'FAIL cancelled';exception when raise_exception then if sqlerrm like 'FAIL%' or position('Rencana tidak berlaku' in sqlerrm)=0 then raise;end if;end;
end $$;
reset role;update public.profiles set role='Admin' where id='00000000-0000-4000-8000-000000000092';set local role authenticated;
do $$begin begin perform public.stock_purge_action('prepare','QA_STALE',gen_random_uuid(),'HAPUS QA_STALE','Uji peran tidak berwenang');raise exception 'FAIL non HQ';exception when raise_exception then if sqlerrm like 'FAIL%' or position('Hanya Administrator' in sqlerrm)=0 then raise;end if;end;end $$;
reset role;rollback;select 'PASS: fresh password required, typed branch, dedicated route, backup, durable requested audit before deletion, two-step purge, idempotency, stale snapshot, cancellation, role and branch scope. Fixtures rolled back.' result;
