-- All PREPARED plans were cancelled by the preceding migration. The public
-- interlock no longer needs elevated privileges or access to the private RPC.
create or replace function public.branch_deletion_action(
  p_action text,
  p_branch_id text,
  p_plan_id uuid,
  p_confirmation text default '',
  p_reason text default '',
  p_file jsonb default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sesi login diperlukan';
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
