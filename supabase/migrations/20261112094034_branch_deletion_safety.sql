-- Local-only hardening for branch deletion. Do not apply to hosted projects.

-- Branches can only be deleted through the guarded RPC. Direct table DELETE
-- bypasses the last-branch and retained-data checks below.
revoke delete on table public.branches from public, anon, authenticated;
drop policy if exists branches_delete on public.branches;

create or replace function public.delete_wms_branch(p_branch_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_branch_id text;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active
      and role = 'Administrator'
  ) then
    raise exception 'Hanya Administrator aktif yang dapat menghapus cabang.';
  end if;

  if p_branch_id is null or p_branch_id !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then
    raise exception 'Kode cabang tidak valid.';
  end if;

  -- Serialize deletions so concurrent requests cannot remove the final branch.
  perform pg_advisory_xact_lock(hashtextextended('wms-branch-delete-global', 0));
  select id into v_branch_id
  from public.branches
  where id = p_branch_id
  for update;

  if v_branch_id is null then
    raise exception 'Cabang % tidak ditemukan.', p_branch_id;
  end if;

  select count(*) into v_count from public.branches;
  if v_count <= 1 then
    raise exception 'Tidak dapat menghapus cabang terakhir.';
  end if;

  -- Never reassign users implicitly: that would grant them access to another
  -- branch under the branch-scoped RLS policies.
  if exists (select 1 from public.profiles where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki profil akun. Pindahkan atau hapus akun secara terpisah terlebih dahulu.';
  end if;

  -- Keep operational documents, transfers, audit history and backups intact.
  -- Until an archive-and-restore workflow exists, used branches are not deletable.
  if exists (select 1 from public.wms_documents where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki dokumen WMS. Arsipkan dan tinjau data sebelum menghapus cabang.';
  end if;
  if exists (
    select 1 from public.branch_transfers
    where source_branch = p_branch_id or destination_branch = p_branch_id
  ) then
    raise exception 'Cabang masih memiliki riwayat transfer.';
  end if;
  if exists (select 1 from public.stock_movements where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki riwayat mutasi stok.';
  end if;
  if exists (select 1 from public.activity_events where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki catatan audit.';
  end if;
  if exists (select 1 from public.branch_backups where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki backup yang tersimpan.';
  end if;
  if exists (select 1 from wms_private.period_archives where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki arsip periode.';
  end if;
  if exists (select 1 from wms_private.stock_purge_plans where branch_id = p_branch_id) then
    raise exception 'Cabang masih memiliki rencana pengosongan stok.';
  end if;

  delete from wms_private.write_requests where branch_id = p_branch_id;
  delete from public.branches where id = p_branch_id;

  return jsonb_build_object('success', true, 'message', 'Cabang kosong berhasil dihapus.');
end;
$$;

revoke all on function public.delete_wms_branch(text) from public, anon;
grant execute on function public.delete_wms_branch(text) to authenticated;
