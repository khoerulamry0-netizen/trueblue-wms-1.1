-- ==============================================================================
-- MARKETPLACE WEBHOOK API (SUPABASE REST & RPC)
-- Menerima order otomatis dari Shopee, TikTok Shop, Tokopedia, Mabang, Jubelio, dll.
-- Mengalokasikan stok FEFO secara otomatis ke pesanan Pending di WMS.
-- ==============================================================================

create or replace function public.marketplace_order_webhook(
  payload jsonb,
  p_secret text default 'TRUEBLUE_WEBHOOK_2026'
)
returns jsonb
language plpgsql
security definer
set search_path = public, wms_private, extensions
as $$
declare
  v_branch_id text;
  v_warehouse_id text;
  v_order_number text;
  v_customer_name text;
  v_customer_phone text;
  v_customer_address text;
  v_source text;
  v_items jsonb;
  v_item jsonb;
  v_sku text;
  v_qty numeric;
  v_stock_rec record;
  v_qty_needed numeric;
  v_qty_take numeric;
  v_allocations jsonb := '[]'::jsonb;
  v_request_id uuid := gen_random_uuid();
  v_timestamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_order_items jsonb := '[]'::jsonb;
  v_batch_number text;
  v_item_index int := 0;
  v_doc_id text;
  v_import_result jsonb;
  v_configured_secret text := 'TRUEBLUE_WEBHOOK_2026';
begin
  -- 1. Validasi secret token keamanan webhook
  if p_secret is not null and p_secret <> '' and p_secret <> v_configured_secret then
    raise exception 'Webhook secret token tidak valid.';
  end if;

  -- 2. Normalisasi nomor order dan identitas pelanggan
  v_order_number := upper(trim(coalesce(payload->>'order_number', payload->>'orderNumber', payload->>'order_id', payload->>'id', '')));
  if v_order_number = '' then
    raise exception 'Nomor order (order_number) wajib diisi.';
  end if;

  v_customer_name := coalesce(nullif(trim(payload->>'customer_name'), ''), nullif(trim(payload->>'customerName'), ''), nullif(trim(payload->>'buyer_name'), ''), 'Pelanggan Marketplace');
  v_customer_phone := coalesce(nullif(trim(payload->>'customer_phone'), ''), nullif(trim(payload->>'customerPhone'), ''), nullif(trim(payload->>'buyer_phone'), ''), '-');
  v_customer_address := coalesce(nullif(trim(payload->>'customer_address'), ''), nullif(trim(payload->>'customerAddress'), ''), nullif(trim(payload->>'shipping_address'), ''), '-');
  v_source := upper(trim(coalesce(payload->>'source', payload->>'marketplace', payload->>'channel', 'MARKETPLACE')));
  v_branch_id := upper(trim(coalesce(payload->>'branch_id', payload->>'branchId', '')));
  v_warehouse_id := coalesce(nullif(trim(payload->>'warehouse_id'), ''), nullif(trim(payload->>'warehouseId'), ''), 'WH-CENTRAL');

  -- Jika cabang tidak diberikan atau tidak valid, gunakan cabang aktif pertama
  if v_branch_id = '' or not exists (select 1 from public.branches where id = v_branch_id) then
    select id into v_branch_id from public.branches order by id limit 1;
  end if;

  -- 3. Idempotent check: Jika order sudah pernah masuk dan aktif, beri tahu sukses tanpa dobel alokasi
  if exists (
    select 1 from public.wms_documents
    where branch_id = v_branch_id and collection_name = 'orders'
      and upper(trim(payload->>'orderNumber')) = v_order_number
      and payload->>'status' <> 'Cancelled'
  ) then
    return jsonb_build_object(
      'success', true,
      'message', 'Order sudah pernah diterima sebelumnya (idempotent).',
      'order_number', v_order_number,
      'status', 'ALREADY_EXISTS'
    );
  end if;

  -- 4. Validasi daftar barang (items)
  v_items := coalesce(payload->'items', payload->'order_items', payload->'products', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Daftar barang (items) harus berupa array dan minimal berisi 1 barang.';
  end if;

  v_batch_number := coalesce(nullif(trim(payload->>'batch_number'), ''), v_source || '-' || to_char(now() at time zone 'Asia/Jakarta', 'YYYYMMDD'));

  -- 5. Loop tiap barang: Alokasikan stok rak fisik menggunakan FEFO
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_sku := upper(trim(coalesce(v_item->>'skuId', v_item->>'sku', v_item->>'item_sku', v_item->>'kode_barang', '')));
    v_qty := (coalesce(v_item->>'qty', v_item->>'quantity', v_item->>'jumlah', '1'))::numeric;

    if v_sku = '' or v_qty <= 0 then
      raise exception 'SKU atau kuantitas barang tidak valid pada item: %', v_item;
    end if;

    v_qty_needed := v_qty;

    -- Ambil stok fisik aktif dari rak gudang
    for v_stock_rec in
      with active_stock as (
        select
          d.document_id,
          upper(trim(d.payload->>'skuId')) as sku_id,
          coalesce(d.payload->>'skuName', d.payload->>'skuId') as sku_name,
          upper(trim(coalesce(d.payload->>'location', 'DEFAULT'))) as loc,
          coalesce(d.payload->>'expiredDate', 'No Expired') as ed,
          (d.payload->>'qty')::numeric as physical_qty,
          coalesce(d.payload->>'warehouseName', 'Gudang Pusat') as wh_name,
          case
            when coalesce(d.payload->>'expiredDate', 'No Expired') in ('No Expired', '--', '-', '') then '99999999'
            when d.payload->>'expiredDate' ~ '^\d{2}/\d{2}/\d{4}$' then
              substr(d.payload->>'expiredDate', 7, 4) || substr(d.payload->>'expiredDate', 4, 2) || substr(d.payload->>'expiredDate', 1, 2)
            else '99999999'
          end as ed_sort
        from public.wms_documents d
        where d.branch_id = v_branch_id
          and d.collection_name = 'stock'
          and upper(trim(d.payload->>'skuId')) = v_sku
          and coalesce(d.payload->>'warehouseId', 'WH-CENTRAL') = v_warehouse_id
          and left(d.document_id, 7) <> 'SYSTEM_'
          and lower(coalesce(d.payload->>'status', '')) not in ('damage', 'expired')
          and coalesce(d.payload->>'location', '') !~* '(ZONE1|URBAN)'
      ),
      reserved as (
        select
          upper(trim(o.payload->>'skuId')) as sku_id,
          upper(trim(coalesce(o.payload->>'location', 'DEFAULT'))) as loc,
          coalesce(o.payload->>'expiredDate', 'No Expired') as ed,
          sum((o.payload->>'qty')::numeric) as reserved_qty
        from public.wms_documents o
        where o.branch_id = v_branch_id
          and o.collection_name = 'orders'
          and o.payload->>'status' = 'Pending'
          and coalesce((o.payload->>'stockDeducted')::boolean, false) = false
        group by 1, 2, 3
      )
      select
        s.*,
        greatest(0, s.physical_qty - coalesce(r.reserved_qty, 0)) as available_qty
      from active_stock s
      left join reserved r on r.sku_id = s.sku_id and r.loc = s.loc and r.ed = s.ed
      where greatest(0, s.physical_qty - coalesce(r.reserved_qty, 0)) > 0
      order by s.ed_sort asc, s.loc asc
    loop
      if v_qty_needed <= 0 then
        exit;
      end if;

      v_qty_take := least(v_qty_needed, v_stock_rec.available_qty);
      v_item_index := v_item_index + 1;
      v_doc_id := 'IMP_' || replace(v_request_id::text, '-', '') || '_' || v_item_index;

      v_order_items := v_order_items || jsonb_build_array(jsonb_build_object(
        'id', v_doc_id,
        'timestamp', v_timestamp,
        'orderNumber', v_order_number,
        'referenceNumber', v_order_number,
        'customerName', v_customer_name,
        'customerAddress', v_customer_address,
        'customerPhone', v_customer_phone,
        'noPo', v_source,
        'batchNumber', v_batch_number,
        'skuId', v_sku,
        'skuName', v_stock_rec.sku_name,
        'expiredDate', v_stock_rec.ed,
        'location', v_stock_rec.loc,
        'qty', v_qty_take,
        'warehouseId', v_warehouse_id,
        'warehouseName', v_stock_rec.wh_name,
        'status', 'Pending',
        'scanned', false,
        'picked', false,
        'stockDeducted', false
      ));

      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
        'sku', v_sku,
        'location', v_stock_rec.loc,
        'expired_date', v_stock_rec.ed,
        'qty', v_qty_take
      ));

      v_qty_needed := v_qty_needed - v_qty_take;
    end loop;

    if v_qty_needed > 0 then
      raise exception 'Stok tidak cukup untuk SKU %. Kurang % pcs di rak aktif gudang.', v_sku, v_qty_needed;
    end if;
  end loop;

  -- 6. Tulis pesanan ke gateway WMS import_wms_orders
  v_import_result := wms_private.import_wms_orders(
    v_request_id,
    v_branch_id,
    v_warehouse_id,
    v_order_items
  );

  -- 7. Catat aktivitas audit
  insert into public.activity_events (branch_id, entity_type, entity_id, action, actor_name, after_data, reason)
  values (
    v_branch_id,
    'webhook_orders',
    v_order_number,
    'WEBHOOK_ORDER_RECEIVED',
    'Webhook API (' || v_source || ')',
    jsonb_build_object('order_number', v_order_number, 'source', v_source, 'total_items', jsonb_array_length(v_order_items), 'allocations', v_allocations),
    'Order otomatis masuk dari webhook ' || v_source
  );

  return jsonb_build_object(
    'success', true,
    'order_number', v_order_number,
    'branch_id', v_branch_id,
    'warehouse_id', v_warehouse_id,
    'source', v_source,
    'batch_number', v_batch_number,
    'total_lines', jsonb_array_length(v_order_items),
    'allocations', v_allocations,
    'status', 'Pending'
  );
end;
$$;

revoke all on function public.marketplace_order_webhook(jsonb, text) from public;
grant execute on function public.marketplace_order_webhook(jsonb, text) to anon, authenticated;
