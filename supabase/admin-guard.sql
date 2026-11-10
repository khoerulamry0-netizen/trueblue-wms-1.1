begin;
lock table public.profiles in share row exclusive mode;
create table if not exists wms_private.admin_guard(singleton boolean primary key default true check(singleton),active_count integer not null check(active_count>=1));
revoke all on wms_private.admin_guard from public,anon,authenticated;
alter table wms_private.admin_guard enable row level security;
insert into wms_private.admin_guard(singleton,active_count) select true,count(*)::int from public.profiles where role='Administrator' and is_active on conflict(singleton) do update set active_count=excluded.active_count;
create or replace function wms_private.protect_last_administrator() returns trigger language plpgsql security definer set search_path='' as $guard$
declare was_admin boolean:=false; is_admin boolean:=false;
begin
 if tg_op<>'INSERT' then was_admin:=old.role='Administrator' and old.is_active;end if;
 if tg_op<>'DELETE' then is_admin:=new.role='Administrator' and new.is_active;end if;
 if was_admin and not is_admin then
  update wms_private.admin_guard set active_count=active_count-1 where singleton and active_count>1;
  if not found then raise exception 'Administrator aktif terakhir tidak dapat dihapus, dinonaktifkan, atau diturunkan perannya';end if;
 elsif is_admin and not was_admin then
  update wms_private.admin_guard set active_count=active_count+1 where singleton;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$guard$;
revoke all on function wms_private.protect_last_administrator() from public,anon,authenticated;
drop trigger if exists protect_last_administrator on public.profiles;
create trigger protect_last_administrator before insert or update or delete on public.profiles for each row execute function wms_private.protect_last_administrator();
commit;