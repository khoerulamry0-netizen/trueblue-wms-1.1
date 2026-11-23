-- B2B, Online, Hybrid Branch Configuration, Shipping & Manifest, and Unassigned Order Classification

alter table public.branches
  add column if not exists operation_type text not null default 'HYBRID';

alter table public.branches
  drop constraint if exists branches_operation_type_check;

alter table public.branches
  add constraint branches_operation_type_check
  check (operation_type in ('B2B', 'ONLINE', 'HYBRID'));

update public.branches
set operation_type = 'HYBRID'
where operation_type is null;

-- Expand allowed roles on public.profiles to include Shipping
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
      and pg_get_constraintdef(oid) ilike '%Packer%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('Administrator', 'Admin', 'Picker', 'Packer', 'Shipping', 'Viewer'));

-- Restrictive read policy for Shipping role (orders, warehouses, settings only)
drop policy if exists documents_shipping_read on public.wms_documents;
create policy documents_shipping_read
  on public.wms_documents
  as restrictive
  for select
  to authenticated
  using (
    (select public.wms_current_role()) is distinct from 'Shipping'
    or collection_name in ('orders', 'warehouses', 'settings')
  );

-- Durable Shipping Manifest ledger table
create table if not exists public.shipping_manifests (
  manifest_id text primary key,
  branch_id text not null references public.branches(id) on delete cascade,
  warehouse_id text not null default 'WH-CENTRAL',
  warehouse_name text not null default '',
  order_type text not null check (order_type in ('B2B', 'ONLINE')),
  courier_name text not null,
  sender_name text not null default '',
  driver_name text,
  driver_phone text,
  vehicle_plate text,
  handed_over_by text not null,
  handed_over_by_id uuid references auth.users(id) on delete set null,
  handed_over_at timestamptz not null default now(),
  total_orders integer not null default 0 check (total_orders >= 0),
  total_qty_pcs numeric not null default 0 check (total_qty_pcs >= 0),
  order_references jsonb not null default '[]'::jsonb,
  notes text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELLED')),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists shipping_manifests_branch_created_idx
  on public.shipping_manifests (branch_id, created_at desc);

create index if not exists shipping_manifests_handed_over_by_id_idx
  on public.shipping_manifests (handed_over_by_id);

create index if not exists shipping_manifests_cancelled_by_id_idx
  on public.shipping_manifests (cancelled_by);

alter table public.shipping_manifests enable row level security;
revoke all on public.shipping_manifests from public, anon;
grant select on public.shipping_manifests to authenticated;

drop policy if exists shipping_manifests_read on public.shipping_manifests;
create policy shipping_manifests_read
  on public.shipping_manifests
  for select
  to authenticated
  using (
    (select wms_private.can_access_branch(branch_id))
    and (select public.wms_current_role()) in ('Administrator', 'Admin', 'Shipping', 'Viewer')
  );

-- Save or update branch including operation_type ('B2B', 'ONLINE', 'HYBRID')
create or replace function public.save_branch(
  p_id text,
  p_name text,
  p_operation_type text default 'HYBRID'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_name text;
  v_op text;
  v_actor text;
  v_exists boolean;
  v_row public.branches%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  v_id := upper(trim(coalesce(p_id, '')));
  v_name := trim(coalesce(p_name, ''));
  v_op := upper(trim(coalesce(nullif(p_operation_type, ''), 'HYBRID')));

  if v_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then
    raise exception 'Kode cabang harus 2â€“32 karakter (A-Z, 0-9, -, _).';
  end if;
  if length(v_name) not between 1 and 100 then
    raise exception 'Nama cabang harus 1â€“100 karakter.';
  end if;
  if v_op not in ('B2B', 'ONLINE', 'HYBRID') then
    raise exception 'Tipe operasional cabang harus B2B, ONLINE, atau HYBRID.';
  end if;

  select exists(select 1 from public.branches where id = v_id) into v_exists;

  if not v_exists then
    if not wms_private.is_hq() then
      raise exception 'Hanya Administrator kantor pusat yang dapat membuat cabang baru.';
    end if;
    insert into public.branches (id, name, operation_type)
    values (v_id, v_name, v_op)
    returning * into v_row;
  else
    if not wms_private.is_hq() and not (public.wms_is_admin() and wms_private.can_access_branch(v_id)) then
      raise exception 'Hanya admin cabang yang berwenang dapat mengubah konfigurasi cabang.';
    end if;

    if not wms_private.is_hq() then
      -- Branch Admin may update operation_type of their own branch; name remains locked unless HQ
      update public.branches
      set operation_type = v_op
      where id = v_id
      returning * into v_row;
    else
      update public.branches
      set name = v_name,
          operation_type = v_op
      where id = v_id
      returning * into v_row;
    end if;
  end if;

  select coalesce(nullif(full_name, ''), email) into v_actor
  from public.profiles where id = auth.uid();

  insert into public.activity_events (
    branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
  ) values (
    v_id,
    'branches',
    v_id,
    case when v_exists then 'BRANCH_UPDATE' else 'BRANCH_CREATE' end,
    auth.uid(),
    coalesce(v_actor, 'Admin WMS'),
    jsonb_build_object('id', v_row.id, 'name', v_row.name, 'operation_type', v_row.operation_type),
    'Konfigurasi tipe operasional cabang: ' || v_row.operation_type
  );

  return jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'operation_type', v_row.operation_type
  );
end;
$$;

revoke all on function public.save_branch(text, text, text) from public, anon;
grant execute on function public.save_branch(text, text, text) to authenticated;

-- Atomic Shipping Manifest commit & cancellation RPC
create or replace function public.commit_shipping_manifest(
  p_request_id uuid,
  p_branch_id text,
  p_order_refs text[],
  p_manifest jsonb default '{}'::jsonb,
  p_action text default 'create'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_actor text;
  v_action text;
  v_branch_op text;
  v_req wms_private.write_requests%rowtype;
  v_body jsonb;
  v_refs text[];
  v_manifest_id text;
  v_order_types text[];
  v_order_type text;
  v_handed_over_at timestamptz;
  v_now_iso text;
  v_matched_count integer := 0;
  v_updated_count integer := 0;
  v_total_qty numeric := 0;
  v_existing_manifest public.shipping_manifests%rowtype;
  v_ref text;
  v_result jsonb;
begin
  v_role := public.wms_current_role();
  if auth.uid() is null or v_role not in ('Administrator', 'Admin', 'Shipping') or not wms_private.can_access_branch(p_branch_id) then
    raise exception 'Akses Shipping & Manifest ditolak untuk pengguna atau cabang ini.';
  end if;

  if p_request_id is null then
    raise exception 'Request ID transaksi wajib diisi.';
  end if;

  v_action := lower(trim(coalesce(nullif(p_action, ''), 'create')));
  if v_action not in ('create', 'cancel') then
    raise exception 'Aksi manifest harus create atau cancel.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('write:' || p_request_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('write-branch:' || p_branch_id, 0));

  v_body := jsonb_build_object(
    'action', v_action,
    'refs', coalesce(to_jsonb(p_order_refs), '[]'::jsonb),
    'manifest', coalesce(p_manifest, '{}'::jsonb)
  );

  select * into v_req from wms_private.write_requests where id = p_request_id;
  if found then
    if v_req.actor_id <> auth.uid() or v_req.branch_id <> p_branch_id or v_req.body is distinct from v_body then
      raise exception 'ID transaksi manifest sudah digunakan untuk permintaan lain.';
    end if;
    return v_req.result;
  end if;

  select coalesce(nullif(full_name, ''), email) into v_actor
  from public.profiles where id = auth.uid();
  v_actor := coalesce(nullif(trim(coalesce(p_manifest->>'handedOverBy', '')), ''), v_actor, 'Petugas Shipping');

  select coalesce(operation_type, 'HYBRID') into v_branch_op
  from public.branches where id = p_branch_id;
  v_branch_op := coalesce(v_branch_op, 'HYBRID');

  v_manifest_id := trim(coalesce(p_manifest->>'manifestId', p_manifest->>'manifest_id', ''));

  select coalesce(array_agg(distinct upper(trim(r))), array[]::text[])
  into v_refs
  from unnest(coalesce(p_order_refs, array[]::text[])) as r
  where trim(coalesce(r, '')) <> '';

  if v_action = 'cancel' then
    if v_manifest_id = '' and coalesce(array_length(v_refs, 1), 0) = 0 then
      raise exception 'Referensi manifest atau order untuk pembatalan tidak ditemukan.';
    end if;

    if v_manifest_id <> '' then
      select * into v_existing_manifest
      from public.shipping_manifests
      where manifest_id = v_manifest_id and branch_id = p_branch_id
      for update;

      if found then
        update public.shipping_manifests
        set status = 'CANCELLED',
            cancelled_at = now(),
            cancelled_by = auth.uid()
        where manifest_id = v_manifest_id and branch_id = p_branch_id;

        if coalesce(array_length(v_refs, 1), 0) = 0 then
          select coalesce(array_agg(distinct upper(trim(val))), array[]::text[])
          into v_refs
          from jsonb_array_elements_text(coalesce(v_existing_manifest.order_references, '[]'::jsonb)) as val
          where trim(coalesce(val, '')) <> '';
        end if;
      end if;
    end if;

    perform set_config('wms.operation_id', p_request_id::text, true);
    perform set_config('wms.operation_type', 'SHIPPING_MANIFEST_CANCEL', true);
    perform set_config('wms.reason', 'Pembatalan manifest ekspedisi ' || coalesce(nullif(v_manifest_id, ''), '-'), true);

    with locked as (
      select d.document_id, d.payload
      from public.wms_documents d
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and (
          (v_manifest_id <> '' and d.payload->>'manifestId' = v_manifest_id)
          or (
            coalesce(array_length(v_refs, 1), 0) > 0
            and (
              upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
              or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
              or upper(trim(d.document_id)) = any(v_refs)
            )
          )
        )
      order by d.document_id
      for update
    ),
    updated as (
      update public.wms_documents d
      set payload = (d.payload - 'shippedAt' - 'shippedBy' - 'manifestId') || jsonb_build_object('shipped', false)
      from locked l
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and d.document_id = l.document_id
      returning 1
    )
    select count(*) into v_updated_count from updated;

    v_result := jsonb_build_object(
      'success', true,
      'action', 'cancel',
      'manifestId', nullif(v_manifest_id, ''),
      'updatedCount', v_updated_count
    );

    insert into wms_private.write_requests (id, actor_id, branch_id, body, result)
    values (p_request_id, auth.uid(), p_branch_id, v_body, v_result);

    return v_result;
  end if;

  -- Action: create
  if coalesce(array_length(v_refs, 1), 0) = 0 then
    raise exception 'Pilih minimal 1 order untuk dibuatkan manifest pengiriman.';
  end if;
  if v_manifest_id = '' then
    raise exception 'Nomor Manifest (manifestId) wajib diisi.';
  end if;

  -- Lock candidate order rows consistently before validating
  perform 1
  from public.wms_documents d
  where d.branch_id = p_branch_id
    and d.collection_name = 'orders'
    and (
      upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
      or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
      or upper(trim(d.document_id)) = any(v_refs)
    )
  order by d.document_id
  for update;

  -- Ensure every submitted reference actually exists in branch orders
  foreach v_ref in array v_refs loop
    if not exists (
      select 1
      from public.wms_documents d
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and (
          upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = v_ref
          or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = v_ref
          or upper(trim(d.document_id)) = v_ref
        )
    ) then
      raise exception 'Referensi order % tidak ditemukan di cabang %.', v_ref, p_branch_id;
    end if;
  end loop;

  if exists (
    select 1
    from public.wms_documents d
    where d.branch_id = p_branch_id
      and d.collection_name = 'orders'
      and (
        upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
        or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
        or upper(trim(d.document_id)) = any(v_refs)
      )
      and coalesce(d.payload->>'status', 'Pending') <> 'Completed'
  ) then
    raise exception 'Semua order pada manifest harus berstatus Completed (selesai packing).';
  end if;

  if exists (
    select 1
    from public.wms_documents d
    where d.branch_id = p_branch_id
      and d.collection_name = 'orders'
      and (
        upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
        or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
        or upper(trim(d.document_id)) = any(v_refs)
      )
      and coalesce((d.payload->>'shipped')::boolean, false) = true
  ) then
    raise exception 'Ada order yang sudah tercatat terkirim pada manifest lain (double shipping diblokir).';
  end if;

  if exists (
    select 1
    from public.wms_documents d
    where d.branch_id = p_branch_id
      and d.collection_name = 'orders'
      and (
        upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
        or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
        or upper(trim(d.document_id)) = any(v_refs)
      )
      and upper(trim(coalesce(d.payload->>'orderType', d.payload->>'order_type', 'UNASSIGNED'))) not in ('B2B', 'ONLINE')
  ) then
    raise exception 'Order UNASSIGNED tidak boleh masuk manifest. Minta Admin mengklasifikasikan order terlebih dahulu.';
  end if;

  select array_agg(distinct upper(trim(coalesce(d.payload->>'orderType', d.payload->>'order_type', '')))),
         count(*),
         coalesce(sum((d.payload->>'qty')::numeric), 0)
  into v_order_types, v_matched_count, v_total_qty
  from public.wms_documents d
  where d.branch_id = p_branch_id
    and d.collection_name = 'orders'
    and (
      upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
      or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
      or upper(trim(d.document_id)) = any(v_refs)
    );

  if coalesce(array_length(v_order_types, 1), 0) > 1 then
    raise exception 'Manifest B2B dan Manifest Online harus dibuat terpisah dan tidak boleh digabung dalam satu dokumen.';
  end if;

  v_order_type := v_order_types[1];
  if v_order_type not in ('B2B', 'ONLINE') then
    raise exception 'Jenis order manifest tidak valid.';
  end if;

  if v_branch_op <> 'HYBRID' and v_branch_op <> v_order_type then
    raise exception 'Cabang bertipe % tidak mengizinkan manifest order %.', v_branch_op, v_order_type;
  end if;

  v_handed_over_at := coalesce(
    nullif(p_manifest->>'handedOverAt', '')::timestamptz,
    now()
  );
  v_now_iso := to_char(v_handed_over_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.shipping_manifests (
    manifest_id,
    branch_id,
    warehouse_id,
    warehouse_name,
    order_type,
    courier_name,
    sender_name,
    driver_name,
    driver_phone,
    vehicle_plate,
    handed_over_by,
    handed_over_by_id,
    handed_over_at,
    total_orders,
    total_qty_pcs,
    order_references,
    notes,
    status
  ) values (
    v_manifest_id,
    p_branch_id,
    coalesce(nullif(trim(p_manifest->>'warehouseId'), ''), 'WH-CENTRAL'),
    coalesce(trim(p_manifest->>'warehouseName'), ''),
    v_order_type,
    coalesce(nullif(trim(p_manifest->>'courierName'), ''), 'EKSPEDISI'),
    coalesce(trim(p_manifest->>'senderName'), ''),
    nullif(trim(coalesce(p_manifest->>'driverName', '')), ''),
    nullif(trim(coalesce(p_manifest->>'driverPhone', '')), ''),
    nullif(upper(trim(coalesce(p_manifest->>'vehiclePlate', ''))), ''),
    v_actor,
    auth.uid(),
    v_handed_over_at,
    coalesce((p_manifest->>'totalOrders')::integer, array_length(v_refs, 1), 0),
    coalesce((p_manifest->>'totalQtyPcs')::numeric, v_total_qty, 0),
    to_jsonb(v_refs),
    nullif(trim(coalesce(p_manifest->>'notes', '')), ''),
    'ACTIVE'
  )
  on conflict (manifest_id) do nothing;

  perform set_config('wms.operation_id', p_request_id::text, true);
  perform set_config('wms.operation_type', 'SHIPPING_MANIFEST', true);
  perform set_config('wms.reason', 'Serah terima ekspedisi ' || v_manifest_id || ' (' || v_order_type || ')', true);

  with updated as (
    update public.wms_documents d
    set payload = d.payload || jsonb_build_object(
      'shipped', true,
      'shippedAt', v_now_iso,
      'shippedBy', v_actor,
      'manifestId', v_manifest_id
    )
    where d.branch_id = p_branch_id
      and d.collection_name = 'orders'
      and (
        upper(trim(coalesce(d.payload->>'referenceNumber', ''))) = any(v_refs)
        or upper(trim(coalesce(d.payload->>'orderNumber', ''))) = any(v_refs)
        or upper(trim(d.document_id)) = any(v_refs)
      )
    returning 1
  )
  select count(*) into v_updated_count from updated;

  v_result := jsonb_build_object(
    'success', true,
    'action', 'create',
    'manifestId', v_manifest_id,
    'orderType', v_order_type,
    'updatedCount', v_updated_count
  );

  insert into wms_private.write_requests (id, actor_id, branch_id, body, result)
  values (p_request_id, auth.uid(), p_branch_id, v_body, v_result);

  return v_result;
end;
$$;

revoke all on function public.commit_shipping_manifest(uuid, text, text[], jsonb, text) from public, anon;
grant execute on function public.commit_shipping_manifest(uuid, text, text[], jsonb, text) to authenticated;

-- Admin-only order classification RPC (assigns B2B or ONLINE without touching stock or workflow state)
create or replace function public.assign_order_types(
  p_request_id uuid,
  p_branch_id text,
  p_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_actor text;
  v_req wms_private.write_requests%rowtype;
  v_item jsonb;
  v_doc_id text;
  v_ref text;
  v_type text;
  v_updated_count integer := 0;
  v_now_iso text;
  v_result jsonb;
begin
  v_role := public.wms_current_role();
  if auth.uid() is null or v_role not in ('Administrator', 'Admin') or not wms_private.can_access_branch(p_branch_id) then
    raise exception 'Hanya Admin atau Administrator cabang yang dapat mengklasifikasikan order.';
  end if;

  if p_request_id is null or jsonb_typeof(p_assignments) is distinct from 'array' or jsonb_array_length(p_assignments) not between 1 and 2000 then
    raise exception 'Daftar klasifikasi order harus berisi 1â€“2000 entri.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('write:' || p_request_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('write-branch:' || p_branch_id, 0));

  select * into v_req from wms_private.write_requests where id = p_request_id;
  if found then
    if v_req.actor_id <> auth.uid() or v_req.branch_id <> p_branch_id or v_req.body is distinct from p_assignments then
      raise exception 'ID permintaan klasifikasi sudah digunakan.';
    end if;
    return v_req.result;
  end if;

  select coalesce(nullif(full_name, ''), email) into v_actor
  from public.profiles where id = auth.uid();
  v_actor := coalesce(v_actor, 'Admin WMS');
  v_now_iso := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  perform set_config('wms.operation_id', p_request_id::text, true);
  perform set_config('wms.operation_type', 'ORDER_TYPE_ASSIGNMENT', true);
  perform set_config('wms.reason', 'Klasifikasi jenis order (B2B/ONLINE) oleh Admin', true);

  for v_item in select value from jsonb_array_elements(p_assignments) loop
    v_doc_id := trim(coalesce(v_item->>'document_id', v_item->>'id', ''));
    v_ref := upper(trim(coalesce(v_item->>'referenceNumber', v_item->>'reference_number', '')));
    v_type := upper(trim(coalesce(v_item->>'order_type', v_item->>'orderType', '')));

    if v_type not in ('B2B', 'ONLINE') then
      raise exception 'Nilai klasifikasi order harus B2B atau ONLINE.';
    end if;
    if v_doc_id = '' and v_ref = '' then
      raise exception 'Setiap baris klasifikasi wajib menyertakan document_id atau referenceNumber.';
    end if;

    with target_rows as (
      select d.document_id, d.payload
      from public.wms_documents d
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and coalesce(d.payload->>'status', 'Pending') <> 'Cancelled'
        and (
          (v_doc_id <> '' and d.document_id = v_doc_id)
          or (v_ref <> '' and upper(trim(coalesce(d.payload->>'referenceNumber', d.payload->>'orderNumber', ''))) = v_ref)
        )
      order by d.document_id
      for update
    ),
    updated as (
      update public.wms_documents d
      set payload = d.payload || jsonb_build_object(
        'orderType', v_type,
        'orderTypeAssignedAt', v_now_iso,
        'orderTypeAssignedBy', v_actor
      )
      from target_rows t
      where d.branch_id = p_branch_id
        and d.collection_name = 'orders'
        and d.document_id = t.document_id
      returning 1
    )
    select v_updated_count + count(*) into v_updated_count from updated;
  end loop;

  v_result := jsonb_build_object('success', true, 'updatedCount', v_updated_count);

  insert into wms_private.write_requests (id, actor_id, branch_id, body, result)
  values (p_request_id, auth.uid(), p_branch_id, p_assignments, v_result);

  return v_result;
end;
$$;

revoke all on function public.assign_order_types(uuid, text, jsonb) from public, anon;
grant execute on function public.assign_order_types(uuid, text, jsonb) to authenticated;

-- Admin user management SQL RPC (supports create, update, delete directly in Postgres)
create or replace function public.admin_manage_user(body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor record;
  v_action text;
  v_target_id uuid;
  v_target record;
  v_branch_id text;
  v_full_name text;
  v_role text;
  v_username text;
  v_password text;
  v_email text;
  v_new_id uuid;
  v_instance_id uuid;
  v_admin_count integer;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'Sesi masuk tidak valid.');
  end if;

  select role, is_active, branch_id, full_name, email
  into v_actor
  from public.profiles
  where id = auth.uid();

  if not found or not v_actor.is_active or v_actor.role not in ('Admin', 'Administrator') then
    return jsonb_build_object('error', 'Hanya admin WMS yang dapat mengelola akun.');
  end if;

  v_action := lower(trim(coalesce(body->>'action', '')));
  v_branch_id := upper(coalesce(nullif(trim(coalesce(body->>'branchId', '')), ''), v_actor.branch_id, 'CENTER'));
  v_full_name := trim(coalesce(body->>'fullName', ''));
  v_role := trim(coalesce(body->>'role', ''));

  if v_actor.role <> 'Administrator' and v_branch_id <> v_actor.branch_id then
    return jsonb_build_object('error', 'Akses cabang ditolak.');
  end if;
  if v_actor.role <> 'Administrator' and v_role = 'Administrator' then
    return jsonb_build_object('error', 'Hanya kantor pusat dapat memberikan akses Administrator.');
  end if;

  if v_action = 'create' then
    v_username := lower(trim(coalesce(body->>'username', '')));
    v_password := coalesce(body->>'password', '');
    v_full_name := coalesce(nullif(v_full_name, ''), v_username);

    if v_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$'
       or length(v_password) < 8
       or length(v_password) > 128
       or length(v_full_name) not between 1 and 120
       or v_role not in ('Administrator', 'Admin', 'Picker', 'Packer', 'Shipping', 'Viewer') then
      return jsonb_build_object('error', 'ID, password (minimal 8 karakter), nama, atau peran tidak valid.');
    end if;

    if not exists (select 1 from public.branches where id = v_branch_id) then
      if v_actor.role = 'Administrator' then
        insert into public.branches (id, name, operation_type)
        values (v_branch_id, v_branch_id, 'HYBRID')
        on conflict (id) do nothing;
      else
        return jsonb_build_object('error', 'Akses cabang ditolak: Cabang "' || v_branch_id || '" tidak terdaftar.');
      end if;
    end if;

    v_email := v_username || '@operators.blues.invalid';

    if exists (select 1 from auth.users where lower(email) = v_email) then
      return jsonb_build_object('error', 'ID akun "' || v_username || '" sudah terdaftar.');
    end if;

    v_new_id := gen_random_uuid();
    select coalesce(
      (select u.instance_id from auth.users u where u.id = auth.uid()),
      '00000000-0000-0000-0000-000000000000'::uuid
    ) into v_instance_id;

    insert into auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    ) values (
      v_new_id,
      v_instance_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_password, gen_salt('bf')),
      now(),
      '',
      '',
      '',
      '',
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', v_full_name),
      now(),
      now()
    );

    insert into auth.identities (
      id,
      user_id,
      provider_id,
      identity_data,
      provider,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),
      v_new_id,
      v_new_id::text,
      jsonb_build_object(
        'sub', v_new_id::text,
        'email', v_email,
        'email_verified', true,
        'phone_verified', false
      ),
      'email',
      now(),
      now(),
      now()
    ) on conflict (provider_id, provider) do nothing;

    insert into public.profiles (id, email, full_name, role, branch_id, is_active)
    values (v_new_id, v_email, v_full_name, v_role, v_branch_id, true)
    on conflict (id) do update set
      email = excluded.email,
      full_name = excluded.full_name,
      role = excluded.role,
      branch_id = excluded.branch_id,
      is_active = true;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_new_id::text, 'ACCOUNT_CREATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('username', v_username, 'fullName', v_full_name, 'role', v_role, 'branch_id', v_branch_id),
      'Pengelolaan akun oleh admin'
    );

    return jsonb_build_object('success', true, 'userId', v_new_id::text, 'username', v_username);
  elsif v_action = 'update' then
    if coalesce(trim(body->>'userId'), '') = '' or length(v_full_name) not between 1 and 120
       or v_role not in ('Administrator', 'Admin', 'Picker', 'Packer', 'Shipping', 'Viewer') then
      return jsonb_build_object('error', 'Profil atau peran tidak valid.');
    end if;

    v_target_id := (body->>'userId')::uuid;
    select id, role, is_active, branch_id into v_target
    from public.profiles where id = v_target_id for update;

    if not found then
      return jsonb_build_object('error', 'Akun tidak ditemukan.');
    end if;
    if v_actor.role <> 'Administrator' and (v_target.branch_id <> v_actor.branch_id or v_target.role = 'Administrator') then
      return jsonb_build_object('error', 'Akses akun ditolak.');
    end if;

    if v_target.is_active and v_target.role = 'Administrator' and v_role <> 'Administrator' then
      select count(*) into v_admin_count from public.profiles where role = 'Administrator' and is_active;
      if v_admin_count <= 1 then
        return jsonb_build_object('error', 'Admin terakhir tidak dapat diturunkan perannya.');
      end if;
    end if;

    update public.profiles
    set full_name = v_full_name,
        role = v_role,
        branch_id = v_branch_id
    where id = v_target_id;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_target_id::text, 'ACCOUNT_UPDATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('fullName', v_full_name, 'role', v_role, 'branch_id', v_branch_id),
      'Pengelolaan akun oleh admin'
    );

    return jsonb_build_object('success', true);
  elsif v_action = 'delete' then
    if coalesce(trim(body->>'userId'), '') = '' then
      return jsonb_build_object('error', 'ID akun tidak valid.');
    end if;

    v_target_id := (body->>'userId')::uuid;
    if v_target_id = auth.uid() then
      return jsonb_build_object('error', 'Akun aktif tidak dapat menonaktifkan dirinya sendiri.');
    end if;

    select id, role, is_active, branch_id into v_target
    from public.profiles where id = v_target_id for update;
    if not found then
      return jsonb_build_object('error', 'Akun tidak ditemukan.');
    end if;
    if v_actor.role <> 'Administrator' and (v_target.branch_id <> v_actor.branch_id or v_target.role = 'Administrator') then
      return jsonb_build_object('error', 'Akses akun ditolak.');
    end if;

    if v_target.is_active and v_target.role = 'Administrator' then
      select count(*) into v_admin_count from public.profiles where role = 'Administrator' and is_active;
      if v_admin_count <= 1 then
        return jsonb_build_object('error', 'Admin terakhir tidak dapat dihapus atau dinonaktifkan.');
      end if;
    end if;

    update public.profiles set is_active = false where id = v_target_id;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_target_id::text, 'ACCOUNT_DEACTIVATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('userId', v_target_id::text),
      'Penonaktifan akun oleh admin'
    );

    return jsonb_build_object('success', true);
  end if;

  return jsonb_build_object('error', 'Aksi pengelolaan akun tidak dikenal.');
end;
$$;

revoke all on function public.admin_manage_user(jsonb) from public, anon;
grant execute on function public.admin_manage_user(jsonb) to authenticated;

-- Hardened Marketplace Webhook RPC (whitelist + explicit orderType, else UNASSIGNED; never guesses from PO/customer)
create or replace function public.marketplace_order_webhook(
  payload jsonb,
  p_secret text default 'TRUEBLUE_WEBHOOK_2026'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_id text;
  v_warehouse_id text;
  v_branch_op text;
  v_order_number text;
  v_customer_name text;
  v_no_po text;
  v_source text;
  v_explicit_type text;
  v_order_type text;
  v_configured_secret text;
  v_items jsonb;
  v_item jsonb;
  v_sku text;
  v_need_num numeric;
  v_stock record;
  v_reserved numeric;
  v_free integer;
  v_need integer;
  v_take integer;
  v_import_items jsonb := '[]'::jsonb;
  v_req_id uuid := gen_random_uuid();
  v_idx integer := 0;
  v_now_iso text;
  v_actor text;
begin
  if auth.uid() is null or not public.wms_is_admin() then
    raise exception 'Webhook simulator hanya dapat dijalankan oleh Admin atau Administrator yang login.';
  end if;

  if jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'Payload webhook harus berupa JSON object.';
  end if;

  v_branch_id := upper(trim(coalesce(nullif(payload->>'branchId', ''), nullif(payload->>'branch_id', ''), 'CENTER')));
  if not wms_private.can_access_branch(v_branch_id) then
    raise exception 'Akses cabang % ditolak untuk webhook.', v_branch_id;
  end if;

  select d.payload->>'secretKey' into v_configured_secret
  from public.wms_documents d
  where d.branch_id = v_branch_id
    and d.collection_name = 'settings'
    and d.document_id = 'marketplace_webhook_config'
  limit 1;

  v_configured_secret := coalesce(nullif(trim(coalesce(v_configured_secret, '')), ''), 'TRUEBLUE_WEBHOOK_2026');
  if trim(coalesce(p_secret, '')) is distinct from v_configured_secret then
    raise exception 'Secret key webhook tidak cocok.';
  end if;

  select coalesce(operation_type, 'HYBRID') into v_branch_op
  from public.branches where id = v_branch_id;
  if not found then
    raise exception 'Cabang % tidak ditemukan.', v_branch_id;
  end if;

  v_warehouse_id := upper(trim(coalesce(nullif(payload->>'warehouseId', ''), nullif(payload->>'warehouse_id', ''), 'WH-CENTRAL')));
  v_order_number := left(trim(coalesce(payload->>'orderNumber', payload->>'order_sn', '')), 128);
  v_customer_name := left(trim(coalesce(nullif(payload->>'customerName', ''), nullif(payload->>'buyer', ''), 'Marketplace Buyer')), 200);
  v_no_po := left(trim(coalesce(payload->>'noPo', '')), 128);

  if length(v_order_number) not between 1 and 128 then
    raise exception 'orderNumber wajib diisi (1â€“128 karakter).';
  end if;

  v_source := upper(regexp_replace(trim(coalesce(
    payload->>'orderSource',
    payload->>'order_source',
    payload->>'marketplace',
    payload->>'platform',
    payload->>'source',
    ''
  )), '\s+', '_', 'g'));

  v_explicit_type := upper(trim(coalesce(payload->>'orderType', payload->>'order_type', '')));
  if v_explicit_type in ('B2B', 'ONLINE') then
    v_order_type := v_explicit_type;
  elsif v_source in ('SHOPEE', 'TIKTOK', 'TIKTOK_SHOP', 'TOKOPEDIA', 'LAZADA', 'BLIBLI', 'MABANG', 'JUBELIO') then
    v_order_type := 'ONLINE';
  else
    v_order_type := 'UNASSIGNED';
  end if;

  if v_order_type in ('B2B', 'ONLINE') and v_branch_op <> 'HYBRID' and v_branch_op <> v_order_type then
    raise exception 'Order bertipe % tidak diizinkan masuk ke cabang bertipe %.', v_order_type, v_branch_op;
  end if;

  v_items := coalesce(payload->'items', '[]'::jsonb);
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Payload webhook wajib menyertakan minimal 1 item SKU.';
  end if;

  v_now_iso := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  select coalesce(nullif(full_name, ''), email) into v_actor from public.profiles where id = auth.uid();

  perform pg_advisory_xact_lock(hashtextextended('write-branch:' || v_branch_id, 0));

  for v_item in select value from jsonb_array_elements(v_items) loop
    v_sku := upper(trim(coalesce(v_item->>'skuId', v_item->>'sku', '')));
    v_need_num := coalesce((v_item->>'qty')::numeric, 0);
    if v_sku = '' or v_need_num <= 0 or floor(v_need_num) <> v_need_num then
      raise exception 'Item webhook wajib memiliki skuId dan qty bilangan bulat > 0.';
    end if;
    v_need := v_need_num::integer;

    for v_stock in
      select
        d.payload->>'skuId' as sku_id,
        coalesce(nullif(d.payload->>'skuName', ''), d.payload->>'skuId') as sku_name,
        d.payload->>'location' as location,
        coalesce(nullif(d.payload->>'expiredDate', ''), 'No Expired') as expired_date,
        (d.payload->>'qty')::numeric as qty
      from public.wms_documents d
      where d.branch_id = v_branch_id
        and d.collection_name = 'stock'
        and left(d.document_id, 7) <> 'SYSTEM_'
        and upper(trim(d.payload->>'skuId')) = v_sku
        and coalesce(d.payload->>'warehouseId', 'WH-CENTRAL') = v_warehouse_id
        and (d.payload->>'qty')::numeric > 0
        and wms_private.stock_pickable(d.payload)
      order by
        case when coalesce(d.payload->>'expiredDate', 'No Expired') in ('No Expired', '--', '-') then 1 else 0 end,
        d.payload->>'expiredDate',
        d.document_id
    loop
      exit when v_need <= 0;

      select coalesce(sum((o.payload->>'qty')::numeric), 0) into v_reserved
      from public.wms_documents o
      where o.branch_id = v_branch_id
        and o.collection_name = 'orders'
        and coalesce(o.payload->>'status', 'Pending') = 'Pending'
        and coalesce((o.payload->>'stockDeducted')::boolean, false) = false
        and coalesce(o.payload->>'warehouseId', 'WH-CENTRAL') = v_warehouse_id
        and upper(trim(o.payload->>'skuId')) = upper(trim(v_stock.sku_id))
        and upper(trim(o.payload->>'location')) = upper(trim(v_stock.location))
        and coalesce(nullif(o.payload->>'expiredDate', ''), 'No Expired') = v_stock.expired_date;

      v_free := greatest(0, floor(v_stock.qty - v_reserved))::integer;
      if v_free <= 0 then
        continue;
      end if;

      v_take := least(v_need, v_free);
      v_import_items := v_import_items || jsonb_build_array(jsonb_build_object(
        'id', 'IMP_' || replace(v_req_id::text, '-', '') || '_' || v_idx::text,
        'orderNumber', v_order_number,
        'referenceNumber', v_order_number,
        'customerName', v_customer_name,
        'noPo', v_no_po,
        'batchNumber', coalesce(nullif(trim(payload->>'batchNumber'), ''), 'WEBHOOK-' || to_char(now(), 'YYYYMMDD')),
        'skuId', v_stock.sku_id,
        'skuName', v_stock.sku_name,
        'location', v_stock.location,
        'expiredDate', v_stock.expired_date,
        'qty', v_take,
        'warehouseId', v_warehouse_id,
        'status', 'Pending',
        'stockDeducted', false,
        'picked', false,
        'scanned', false,
        'timestamp', v_now_iso,
        'orderType', v_order_type,
        'orderSource', coalesce(nullif(v_source, ''), 'WEBHOOK_UNKNOWN')
      ));
      v_idx := v_idx + 1;
      v_need := v_need - v_take;
    end loop;

    if v_need > 0 then
      raise exception 'Stok pickable SKU % di cabang % (%) tidak mencukupi (kurang % pcs).', v_sku, v_branch_id, v_warehouse_id, v_need;
    end if;
  end loop;

  perform wms_private.import_wms_orders(v_req_id, v_branch_id, v_warehouse_id, v_import_items);

  return jsonb_build_object(
    'success', true,
    'requestId', v_req_id,
    'orderNumber', v_order_number,
    'orderType', v_order_type,
    'orderSource', coalesce(nullif(v_source, ''), 'WEBHOOK_UNKNOWN'),
    'allocatedRows', v_idx,
    'actor', coalesce(v_actor, 'Admin WMS')
  );
end;
$$;

revoke all on function public.marketplace_order_webhook(jsonb, text) from public, anon;
grant execute on function public.marketplace_order_webhook(jsonb, text) to authenticated;

-- Shipping Manifest dan Marketplace Webhook sudah dipensiunkan.
drop function if exists public.commit_shipping_manifest(uuid, text, text[], jsonb, text);
drop function if exists public.marketplace_order_webhook(jsonb, text);
drop table if exists public.shipping_manifests cascade;

