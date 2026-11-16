-- Safety interlock: the multipart implementation introduced in
-- 20261112175307 does not contain enough information to restore every table it
-- deletes.  Keep recovery available for already completed, single-file plans,
-- but prevent new destructive plans until a lossless multipart format ships.

update wms_private.branch_deletion_plans
set status = 'CANCELLED',
    payload_text = null
where status = 'PREPARED';

revoke all on function wms_private.branch_deletion_action(text,text,uuid,text,text,jsonb)
from public, anon, authenticated;

create or replace function public.branch_deletion_action(
  p_action text,
  p_branch_id text,
  p_plan_id uuid,
  p_confirmation text default '',
  p_reason text default '',
  p_file jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sesi login diperlukan';
  end if;

  -- Let an administrator close a plan that was opened immediately before this
  -- migration. All other actions are fail-closed.
  if p_action = 'cancel' then
    return wms_private.branch_deletion_action(
      p_action, p_branch_id, p_plan_id, p_confirmation, p_reason, p_file
    );
  end if;

  raise exception using
    errcode = '55000',
    message = 'Penghapusan permanen cabang dinonaktifkan sementara untuk perbaikan backup dan pemulihan. Tidak ada data yang diubah.';
end;
$$;

revoke all on function public.branch_deletion_action(text,text,uuid,text,text,jsonb)
from public, anon;
grant execute on function public.branch_deletion_action(text,text,uuid,text,text,jsonb)
to authenticated;
