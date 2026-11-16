-- Migration: Izinkan Administrator menghapus cabang dan buat RPC delete_wms_branch

-- 1. Berikan permission DELETE ke authenticated role pada table branches
grant delete on public.branches to authenticated;

-- 2. Buat policy RLS branches_delete (hanya Administrator yang boleh delete)
drop policy if exists branches_delete on public.branches;
create policy branches_delete on public.branches 
for delete to authenticated 
using (
  exists(
    select 1 from public.profiles 
    where id = auth.uid() and is_active and role = 'Administrator'
  )
);

-- 3. Buat RPC function delete_wms_branch untuk membersihkan relasi sebelum delete
create or replace function public.delete_wms_branch(p_branch_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_hq boolean;
  v_count int;
  v_fallback_branch text;
begin
  -- 1. Validasi hak akses (khusus Administrator)
  select exists(
    select 1 from public.profiles 
    where id = auth.uid() and is_active and role = 'Administrator'
  ) into v_is_hq;

  if not coalesce(v_is_hq, false) then
    raise exception 'Hanya Administrator yang memiliki akses menghapus cabang.';
  end if;

  -- 2. Validasi keberadaan cabang
  if not exists(select 1 from public.branches where id = p_branch_id) then
    raise exception 'Cabang % tidak ditemukan.', p_branch_id;
  end if;

  -- 3. Validasi minimal 1 cabang
  select count(*) into v_count from public.branches;
  if v_count <= 1 then
    raise exception 'Tidak dapat menghapus cabang. Minimal harus ada 1 cabang terdaftar.';
  end if;

  -- 4. Cari fallback branch untuk memindahkan profil user yang terhubung
  select id into v_fallback_branch 
  from public.branches 
  where id <> p_branch_id 
  order by case when id = 'CENTER' then 0 else 1 end, id 
  limit 1;

  -- 5. Bersihkan / alihkan referensi foreign keys:
  -- Update profiles yang terikat ke cabang ini
  update public.profiles 
  set branch_id = v_fallback_branch 
  where branch_id = p_branch_id;

  -- Hapus dokumen wms di cabang ini (jika ada sisa dokumen kosong/audit)
  delete from public.wms_documents where branch_id = p_branch_id;

  -- Hapus transfer cabang terkait jika ada
  delete from public.branch_transfers where source_branch = p_branch_id or destination_branch = p_branch_id;

  -- 6. Hapus cabang dari master branches
  delete from public.branches where id = p_branch_id;

  return jsonb_build_object('success', true, 'message', 'Cabang ' || p_branch_id || ' berhasil dihapus.');
end;
$$;

revoke all on function public.delete_wms_branch(text) from public, anon;
grant execute on function public.delete_wms_branch(text) to authenticated;
