-- ==============================================================================
-- RPC FUNCTION: delete_branch (LENGKAP & AMAN)
-- Membersihkan seluruh relasi tabel (activity_events, stock_movements, wms_documents, dll)
-- ==============================================================================

create or replace function public.delete_branch(p_branch_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_actor_active boolean;
  v_branch_count int;
  v_transfer_count int;
  v_fallback_branch text;
begin
  -- 1. Validasi: Hanya Administrator aktif yang dapat menghapus cabang
  select role, is_active into v_actor_role, v_actor_active
  from public.profiles where id = v_actor_id;

  if v_actor_id is null or not coalesce(v_actor_active, false) or v_role <> 'Administrator' then
    raise exception 'Hanya Administrator yang dapat menghapus cabang.';
  end if;

  -- 2. Pastikan cabang ada
  if not exists (select 1 from public.branches where id = p_branch_id) then
    raise exception 'Cabang % tidak ditemukan.', p_branch_id;
  end if;

  -- 3. Minimal harus tersisa 1 cabang di sistem
  select count(*) into v_branch_count from public.branches;
  if v_branch_count <= 1 then
    raise exception 'Cabang terakhir tidak dapat dihapus. Sistem memerlukan minimal 1 cabang aktif.';
  end if;

  -- 4. Periksa apakah masih ada transfer antar-gudang aktif
  select count(*) into v_transfer_count
  from public.branch_transfers
  where (source_branch = p_branch_id or destination_branch = p_branch_id)
    and status not in ('RECEIVED', 'CANCELLED');
  if v_transfer_count > 0 then
    raise exception 'Cabang % masih memiliki transfer barang aktif yang belum selesai/dibatalkan.', p_branch_id;
  end if;

  -- 5. Cari cabang alternatif yang masih ada
  select id into v_fallback_branch
  from public.branches
  where id <> p_branch_id
  order by id
  limit 1;

  -- 6. Pindahkan operator cabang ini ke cabang alternatif
  update public.profiles
  set branch_id = v_fallback_branch
  where branch_id = p_branch_id;

  -- 7. Bersihkan seluruh tabel relasi yang memegang foreign key ke cabang ini
  delete from public.activity_events where branch_id = p_branch_id;
  delete from public.stock_movements where branch_id = p_branch_id;
  delete from public.wms_documents where branch_id = p_branch_id;
  delete from public.branch_backups where branch_id = p_branch_id;
  delete from public.branch_transfers where source_branch = p_branch_id or destination_branch = p_branch_id;

  -- 8. Hapus cabang dari master branches
  delete from public.branches where id = p_branch_id;

  -- 9. Catat di audit log cabang yang tersisa
  insert into public.activity_events (branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason)
  values (
    v_fallback_branch,
    'branches',
    p_branch_id,
    'BRANCH_DELETE',
    v_actor_id,
    coalesce((select coalesce(nullif(full_name,''), email) from public.profiles where id = v_actor_id), 'Administrator'),
    jsonb_build_object('deleted_branch', p_branch_id, 'fallback_branch', v_fallback_branch),
    'Penghapusan cabang oleh Administrator'
  );

  return jsonb_build_object('success', true, 'deleted_branch', p_branch_id, 'fallback_branch', v_fallback_branch);
end;
$$;

revoke all on function public.delete_branch(text) from public, anon;
grant execute on function public.delete_branch(text) to authenticated;
