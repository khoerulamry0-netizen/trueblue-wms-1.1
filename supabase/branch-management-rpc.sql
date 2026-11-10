-- ==============================================================================
-- PENGATURAN HAK AKSES DAN FUNGSI KELOLA MASTER CABANG
-- Mengizinkan Administrator Menambah, Mengubah Nama, dan Menghapus Cabang
-- ==============================================================================

-- 1. Berikan hak penuh tabel branches ke authenticated
grant select, insert, update, delete on table public.branches to authenticated;

-- Pastikan policy update dan insert mengizinkan Administrator
drop policy if exists branches_admin_all on public.branches;
create policy branches_admin_all on public.branches
for all to authenticated
using (
  exists (select 1 from public.profiles where id = auth.uid() and is_active and role = 'Administrator')
)
with check (
  exists (select 1 from public.profiles where id = auth.uid() and is_active and role = 'Administrator')
);

-- 2. Fungsi Simpan / Ubah Nama Cabang (save_branch)
create or replace function public.save_branch(p_id text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_actor_id uuid := auth.uid();
  v_role text;
  v_active boolean;
  v_clean_id text := upper(trim(p_id));
  v_clean_name text := trim(p_name);
begin
  select role, is_active into v_role, v_active
  from public.profiles where id = v_actor_id;

  if v_actor_id is null or not coalesce(v_active, false) or v_role <> 'Administrator' then
    raise exception 'Hanya Administrator yang dapat mengelola cabang.';
  end if;

  if v_clean_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then
    raise exception 'Kode cabang tidak valid (minimal 2-32 karakter alfanumerik).';
  end if;
  if length(v_clean_name) < 1 or length(v_clean_name) > 100 then
    raise exception 'Nama cabang harus antara 1-100 karakter.';
  end if;

  insert into public.branches (id, name)
  values (v_clean_id, v_clean_name)
  on conflict (id) do update set
    name = excluded.name;

  return jsonb_build_object('success', true, 'id', v_clean_id, 'name', v_clean_name);
end;
$$;

revoke all on function public.save_branch(text, text) from public, anon;
grant execute on function public.save_branch(text, text) to authenticated;
