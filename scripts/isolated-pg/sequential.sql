\set ON_ERROR_STOP on
-- A finished but stale sorting session must not authorize packing.
insert into wms_private.scan_sessions
 (id,branch_id,reference_number,phase,basket,actor_id,snapshot,state,created_at)
values
 ('10000000-0000-4000-8000-000000000003','TEST_LOCAL','REF-A','sorting','A1',
  '00000000-0000-4000-8000-000000000002','[]'::jsonb,'finished',now()-interval '1 day');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
do $$
declare session_id uuid='10000000-0000-4000-8000-000000000001';
 pack_id uuid='10000000-0000-4000-8000-000000000002';
 r uuid='20000000-0000-4000-8000-000000000001'; failed boolean; body jsonb; rev bigint; status jsonb; receipt jsonb;
begin
 select revision,payload into rev,body from public.wms_documents where branch_id='TEST_LOCAL' and document_id='ORDER-A';
 failed=false;
 begin
  perform public.commit_wms_write(gen_random_uuid(),'TEST_LOCAL',jsonb_build_array(
    jsonb_build_object('collection_name','orders','document_id','ORDER-A','expected_revision',rev,
      'payload',body||'{"status":"Completed","scanned":true}')),'[]');
 exception when raise_exception then
  if sqlerrm<>'Packing memerlukan scan server' then raise; end if;
  failed=true;
 end;
 if not failed then raise exception 'FAIL: browser completion bypass'; end if;
 failed=false;
 begin
  perform public.commit_wms_write(gen_random_uuid(),'TEST_LOCAL',jsonb_build_array(
    jsonb_build_object('collection_name','orders','document_id','ORDER-A','expected_revision',rev,
      'payload',body||'{"basketNumber":"A1","sortedAt":"2026-01-01","sortedBy":"fake"}')),'[]');
 exception when raise_exception then
  if sqlerrm<>'Sortir memerlukan scan server' then raise; end if;
  failed=true;
 end;
 if not failed then raise exception 'FAIL: forged sorting metadata'; end if;
 if has_table_privilege('authenticated','wms_private.scan_events','INSERT') then
  raise exception 'FAIL: scan events directly writable';
 end if;
 failed=false;
 begin
  perform public.start_order_scan(pack_id,'TEST_LOCAL','REF-A','packing','A0');
 exception when raise_exception then
  if sqlerrm<>'Sortir server belum lengkap atau order berubah' then raise; end if;
  failed=true;
 end;
 if not failed then raise exception 'FAIL: packing before sorting'; end if;
 failed=false;
 begin
  perform public.start_order_scan(pack_id,'TEST_LOCAL','REF-A','packing','A1');
 exception when raise_exception then
  if sqlerrm<>'Sortir server belum lengkap atau order berubah' then raise; end if;
  failed=true;
 end;
 if not failed then raise exception 'FAIL: stale sorting snapshot authorized packing'; end if;
 begin
  perform public.get_verified_order_receipt('TEST_LOCAL','REF-A');
  raise exception 'FAIL: pending order receipt authorized';
 exception when raise_exception then if sqlerrm<>'Bukti resi tidak tersedia' then raise; end if; end;
 perform public.start_order_scan(session_id,'TEST_LOCAL','REF-A','sorting','A1');
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',false);
 failed=false;
 begin perform public.record_order_scan(session_id,gen_random_uuid(),'SKU-A');
 exception when raise_exception then
  if sqlerrm<>'Akses scan ditolak' then raise; end if;
  failed=true;
 end;
 if not failed then raise exception 'FAIL: unauthorized operator used session'; end if;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000005',false);
 failed=false;
 begin perform public.record_order_scan(session_id,gen_random_uuid(),'SKU-A');
 exception when raise_exception then
  if sqlerrm<>'Sesi scan milik operator lain' then raise; end if;
  failed=true;
 end;
 if not failed then raise exception 'FAIL: another packer used session'; end if;
 begin
  perform public.get_order_scan_status('TEST_LOCAL','REF-A','sorting');
  raise exception 'FAIL: another packer recovered session';
 exception when raise_exception then if sqlerrm<>'Sesi scan tidak ditemukan' then raise; end if; end;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
 failed=false;
 begin perform public.record_order_scan(session_id,r,'WRONG');
 exception when raise_exception then if sqlerrm<>'SKU asing atau barcode ambigu' then raise; end if; failed=true; end;
 if not failed then raise exception 'FAIL: foreign SKU'; end if;
 perform public.record_order_scan(session_id,r,'TEST-CODE-A');
 perform public.record_order_scan(session_id,r,'TEST-CODE-A');
 status=public.get_order_scan_status('TEST_LOCAL','REF-A','sorting');
 if status->>'session'<>session_id::text or status->>'state'<>'open'
  or (status->'counts'->0->>'scanned')::int<>1 or status->>'current'<>'true'
  or status->'events'->0->>'request_id'<>r::text
 then raise exception 'FAIL: sorting recovery or duplicate scan'; end if;
 begin
  perform public.start_order_scan(gen_random_uuid(),'TEST_LOCAL','REF-A','sorting','A1');
  raise exception 'FAIL: competing open session';
 exception when raise_exception then if sqlerrm<>'Sesi scan aktif sudah ada' then raise; end if; end;
 failed=false;
 begin perform public.record_order_scan(session_id,r,'SKU-A');
 exception when raise_exception then if sqlerrm<>'ID scan sudah digunakan' then raise; end if; failed=true; end;
 if not failed then raise exception 'FAIL: conflicting replay'; end if;
 failed=false;
 begin perform public.finish_order_scan(session_id,gen_random_uuid());
 exception when raise_exception then if sqlerrm<>'Scan belum lengkap' then raise; end if; failed=true; end;
 if not failed then raise exception 'FAIL: incomplete scan or idempotency'; end if;
 if exists(select 1 from public.wms_documents where branch_id='TEST_LOCAL'
  and document_id='ORDER-A' and payload ? 'sortedAt') then
  raise exception 'FAIL: incomplete sorting changed order';
 end if;
 perform public.record_order_scan(session_id,'20000000-0000-4000-8000-000000000002','SKU-A');
 perform public.record_order_scan(session_id,'20000000-0000-4000-8000-000000000003','SKU-A');
 failed=false;
 begin perform public.record_order_scan(session_id,gen_random_uuid(),'SKU-A');
 exception when raise_exception then if sqlerrm<>'Jumlah scan berlebih' then raise; end if; failed=true; end;
 if not failed then raise exception 'FAIL: excess scan'; end if;
 perform public.finish_order_scan(session_id,'30000000-0000-4000-8000-000000000001');
 perform public.finish_order_scan(session_id,'30000000-0000-4000-8000-000000000001');
 status=public.get_order_scan_status('TEST_LOCAL','REF-A','sorting');
 if status->>'state'<>'finished' or status->>'finish_request'<>'30000000-0000-4000-8000-000000000001'
  or (status->'counts'->0->>'scanned')::int<>3 or status->'result' is null
 then raise exception 'FAIL: sorting finish recovery'; end if;
 failed=false;
 begin perform public.finish_order_scan(session_id,gen_random_uuid());
 exception when raise_exception then if sqlerrm<>'Sesi sudah selesai' then raise; end if; failed=true; end;
 if not failed then raise exception 'FAIL: repeated completion accepted'; end if;
 perform public.start_order_scan(pack_id,'TEST_LOCAL','REF-A','packing','A1');
 perform public.record_order_scan(pack_id,'40000000-0000-4000-8000-000000000001','SKU-A');
 status=public.get_order_scan_status('TEST_LOCAL','REF-A','packing');
 if (status->'counts'->0->>'scanned')::int<>1 or status->>'state'<>'open'
 then raise exception 'FAIL: packing recovery'; end if;
 perform public.record_order_scan(pack_id,'40000000-0000-4000-8000-000000000002','SKU-A');
 perform public.record_order_scan(pack_id,'40000000-0000-4000-8000-000000000003','SKU-A');
 perform public.finish_order_scan(pack_id,'50000000-0000-4000-8000-000000000001');
 perform public.finish_order_scan(pack_id,'50000000-0000-4000-8000-000000000001');
 status=public.get_order_scan_status('TEST_LOCAL','REF-A','packing');
 if status->>'state'<>'finished' or status->>'finish_request'<>'50000000-0000-4000-8000-000000000001'
  or (status->'counts'->0->>'scanned')::int<>3 then raise exception 'FAIL: packing finish recovery'; end if;
 receipt=public.get_verified_order_receipt('TEST_LOCAL','REF-A');
 if receipt->>'source'<>'packing' or receipt->>'branch'<>'TEST_LOCAL'
  or receipt->'documents'->0->>'status'<>'Completed' then raise exception 'FAIL: packing receipt proof'; end if;
 if not exists(select 1 from public.wms_documents where branch_id='TEST_LOCAL' and document_id='ORDER-A' and payload->>'status'='Completed')
 then raise exception 'FAIL: packing not committed'; end if;
end $$;
-- New SQL statement/transaction represents a client reconnect after commit.
do $$
declare status jsonb; receipt jsonb;
begin
 status=public.get_order_scan_status('TEST_LOCAL','REF-A','packing');
 if status->>'state'<>'finished' or status->>'finish_request'<>'50000000-0000-4000-8000-000000000001'
  or (status->'counts'->0->>'scanned')::int<>3 or jsonb_array_length(status->'events')<>3
 then raise exception 'FAIL: reconnect after lost response'; end if;
 receipt=public.get_verified_order_receipt('TEST_LOCAL','REF-A');
 if receipt->>'operation_id'<>'50000000-0000-4000-8000-000000000001'
 then raise exception 'FAIL: receipt after reconnect'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
do $$
declare stock jsonb; rev bigint; result jsonb; ups jsonb; retry_result jsonb;
begin
 begin
  perform public.direct_outbound_scanned_admin(gen_random_uuid(),'TEST_LOCAL','[]','');
  raise exception 'FAIL: missing reason accepted';
 exception when raise_exception then if sqlerrm<>'Alasan atau data outbound tidak valid' then raise; end if; end;
 select payload,revision into stock,rev from public.wms_documents
  where branch_id='TEST_LOCAL' and document_id='WH-CENTRAL_SKU-A_No_Expired_RACK_A';
 ups=jsonb_build_array(
   jsonb_build_object('collection_name','stock','document_id',stock->>'id','expected_revision',rev,
    'payload',stock||jsonb_build_object('qty',(stock->>'qty')::numeric-1)),
   jsonb_build_object('collection_name','orders','document_id','ORDER-DIRECT','expected_revision',null,
    'payload','{"id":"ORDER-DIRECT","referenceNumber":"REF-DIRECT","skuId":"SKU-A","skuName":"A","location":"RACK-A","expiredDate":"No Expired","warehouseId":"WH-CENTRAL","qty":1,"status":"Completed","picked":true,"stockDeducted":true}'::jsonb)
  );
 result=public.direct_outbound_scanned_admin('80000000-0000-4000-8000-000000000001','TEST_LOCAL',ups,'Synthetic test reason');
 retry_result=public.direct_outbound_scanned_admin('80000000-0000-4000-8000-000000000001','TEST_LOCAL',ups,'Synthetic test reason');
 if result is distinct from retry_result or
   public.get_direct_outbound_status('80000000-0000-4000-8000-000000000001','TEST_LOCAL')->'result' is distinct from result
 then raise exception 'FAIL: direct outbound recovery'; end if;
 begin
  perform public.direct_outbound_scanned_admin('80000000-0000-4000-8000-000000000001','TEST_LOCAL',ups,'Different test reason');
  raise exception 'FAIL: conflicting direct retry';
 exception when raise_exception then if sqlerrm<>'ID transaksi sudah digunakan' then raise; end if; end;
 if not exists(select 1 from public.wms_documents where branch_id='TEST_LOCAL' and document_id='ORDER-DIRECT' and payload->>'status'='Completed')
 then raise exception 'FAIL: direct outbound not committed'; end if;
 if public.get_verified_order_receipt('TEST_LOCAL','REF-DIRECT')->>'source'<>'direct'
 then raise exception 'FAIL: direct receipt proof'; end if;
 begin
  perform public.direct_outbound_scanned_admin(gen_random_uuid(),'TEST_LOCAL',
    jsonb_build_array(jsonb_build_object('collection_name','orders','document_id','OTHER',
      'expected_revision',null,'payload','{"referenceNumber":"REF-A","status":"Completed"}'::jsonb)),
    'Synthetic test reason');
  raise exception 'FAIL: existing order converted';
 exception when raise_exception then if sqlerrm<>'Outbound langsung hanya untuk order baru' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
do $$ begin
 begin
  perform public.start_order_scan(gen_random_uuid(),'TEST_LOCAL','REF-RACE','sorting','A2');
  raise exception 'FAIL: picker started sorting';
 exception when raise_exception then if sqlerrm<>'Akses scan ditolak' then raise; end if; end;
 begin
  perform public.direct_outbound_scanned_admin(gen_random_uuid(),'TEST_LOCAL','[]','synthetic reason');
  raise exception 'FAIL: picker direct outbound';
 exception when raise_exception then if sqlerrm<>'Outbound langsung hanya untuk Administrator' then raise; end if; end;
 begin
  perform public.get_direct_outbound_status('80000000-0000-4000-8000-000000000001','TEST_LOCAL');
  raise exception 'FAIL: picker direct status';
 exception when raise_exception then if sqlerrm<>'Outbound langsung hanya untuk Administrator' then raise; end if; end;
 begin
  perform public.get_verified_order_receipt('TEST_LOCAL','REF-A');
  raise exception 'FAIL: picker receipt';
 exception when raise_exception then if sqlerrm<>'Akses scan ditolak' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',false);
do $$ begin
 begin
  perform public.start_order_scan(gen_random_uuid(),'TEST_LOCAL','REF-RACE','sorting','A2');
  raise exception 'FAIL: foreign branch accepted';
 exception when raise_exception then if sqlerrm<>'Akses scan ditolak' then raise; end if; end;
 if exists(select 1 from public.wms_documents where branch_id='TEST_LOCAL' and document_id='ORDER-RACE')
 then raise exception 'FAIL: RLS exposed other branch'; end if;
 begin
  perform public.get_verified_order_receipt('TEST_LOCAL','REF-A');
  raise exception 'FAIL: foreign branch receipt';
 exception when raise_exception then if sqlerrm<>'Akses scan ditolak' then raise; end if; end;
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.activity_events where branch_id='TEST_LOCAL'
   and entity_id='REF-DIRECT' and action='DIRECT_OUTBOUND' and reason='Synthetic test reason')
 then raise exception 'FAIL: direct outbound audit missing'; end if;
 if (select count(*) from public.activity_events where branch_id='TEST_LOCAL'
   and entity_id='REF-DIRECT' and action='DIRECT_OUTBOUND')<>1
 then raise exception 'FAIL: duplicate direct outbound audit'; end if;
end $$;
-- Mutate only synthetic rows to verify proof is tied to revision and Pending is refused.
insert into wms_private.receipt_proofs(branch_id,reference_number,snapshot,source,operation_id,actor_id)
 values('TEST_LOCAL','REF-RACE',wms_private.scan_snapshot('TEST_LOCAL','REF-RACE'),'packing',gen_random_uuid(),
 '00000000-0000-4000-8000-000000000002');
update public.wms_documents set payload=payload||'{"testRevisionChange":true}'::jsonb
 where branch_id='TEST_LOCAL' and collection_name='orders' and document_id='ORDER-A';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
do $$ begin
 if public.get_order_scan_status('TEST_LOCAL','REF-A','packing')->>'current'<>'false'
 then raise exception 'FAIL: stale session recovery not flagged'; end if;
 begin
  perform public.get_verified_order_receipt('TEST_LOCAL','REF-A');
  raise exception 'FAIL: stale receipt proof';
 exception when raise_exception then if sqlerrm<>'Bukti resi tidak sesuai order terkini' then raise; end if; end;
 begin
  perform public.get_verified_order_receipt('TEST_LOCAL','REF-RACE');
  raise exception 'FAIL: pending receipt proof';
 exception when raise_exception then if sqlerrm<>'Bukti resi tidak sesuai order terkini' then raise; end if; end;
end $$;
reset role;
delete from wms_private.receipt_proofs where branch_id='TEST_LOCAL' and reference_number='REF-RACE';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
do $$ begin
 perform public.start_order_scan('a0000000-0000-4000-8000-000000000001','TEST_LOCAL','REF-RACE','sorting','A2');
 perform public.cancel_order_scan('a0000000-0000-4000-8000-000000000001');
 perform public.cancel_order_scan('a0000000-0000-4000-8000-000000000001');
 if public.get_order_scan_status('TEST_LOCAL','REF-RACE','sorting')->>'state'<>'cancelled'
 then raise exception 'FAIL: cancelled session recovered as active'; end if;
end $$;
reset role;
\echo Sequential RPC and SQL-role tests passed.
