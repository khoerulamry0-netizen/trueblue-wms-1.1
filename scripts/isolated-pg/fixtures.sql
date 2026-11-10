\set ON_ERROR_STOP on
insert into public.branches(id,name) values ('TEST_LOCAL','Test branch'), ('TEST_OTHER','Other branch');
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000001','admin@example.invalid'),
 ('00000000-0000-4000-8000-000000000002','packer@example.invalid'),
 ('00000000-0000-4000-8000-000000000003','picker@example.invalid'),
 ('00000000-0000-4000-8000-000000000004','other@example.invalid'),
 ('00000000-0000-4000-8000-000000000005','second-packer@example.invalid');
update public.profiles set role='Administrator', is_active=true, branch_id='CENTER'
 where id='00000000-0000-4000-8000-000000000001';
update public.profiles set role='Packer', is_active=true, branch_id='TEST_LOCAL'
 where id='00000000-0000-4000-8000-000000000002';
update public.profiles set role='Picker', is_active=true, branch_id='TEST_LOCAL'
 where id='00000000-0000-4000-8000-000000000003';
update public.profiles set role='Packer', is_active=true, branch_id='TEST_OTHER'
 where id='00000000-0000-4000-8000-000000000004';
update public.profiles set role='Packer', is_active=true, branch_id='TEST_LOCAL'
 where id='00000000-0000-4000-8000-000000000005';
insert into public.wms_documents(branch_id,collection_name,document_id,payload) values
 ('TEST_LOCAL','catalog','SKU-A','{"id":"SKU-A","skuId":"SKU-A","barcode":"TEST-CODE-A"}'),
 ('TEST_LOCAL','stock','WH-CENTRAL_SKU-A_No_Expired_RACK_A',
  '{"id":"WH-CENTRAL_SKU-A_No_Expired_RACK_A","skuId":"SKU-A","skuName":"A","location":"RACK-A","expiredDate":"No Expired","warehouseId":"WH-CENTRAL","qty":10}'),
 ('TEST_LOCAL','orders','ORDER-A',
  '{"id":"ORDER-A","referenceNumber":"REF-A","skuId":"SKU-A","skuName":"A","location":"RACK-A","expiredDate":"No Expired","warehouseId":"WH-CENTRAL","qty":3,"status":"Pending","picked":true,"stockDeducted":true}'),
 ('TEST_LOCAL','orders','ORDER-RACE',
  '{"id":"ORDER-RACE","referenceNumber":"REF-RACE","skuId":"SKU-A","skuName":"A","location":"RACK-A","expiredDate":"No Expired","warehouseId":"WH-CENTRAL","qty":1,"status":"Pending","picked":true,"stockDeducted":true}'),
 ('TEST_LOCAL','orders','ORDER-REPLAY',
  '{"id":"ORDER-REPLAY","referenceNumber":"REF-REPLAY","skuId":"SKU-A","skuName":"A","location":"RACK-A","expiredDate":"No Expired","warehouseId":"WH-CENTRAL","qty":1,"status":"Pending","picked":true,"stockDeducted":true}');
