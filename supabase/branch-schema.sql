
create table public.branches (
 id text primary key check(id ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
 name text not null check(length(trim(name)) between 1 and 100),
 created_at timestamptz not null default now()
);
insert into public.branches(id,name) values ('CENTER','CENTER');
alter table public.profiles add column branch_id text not null default 'CENTER' references public.branches(id);
create index profiles_branch_idx on public.profiles(branch_id);
alter table public.wms_documents add column branch_id text not null default 'CENTER' references public.branches(id);
alter table public.wms_documents drop constraint wms_documents_pkey;
alter table public.wms_documents add primary key (branch_id,collection_name,document_id);
create index wms_documents_branch_updated_idx on public.wms_documents(branch_id,updated_at desc);
create schema if not exists wms_private;
revoke all on schema wms_private from public,anon;
grant usage on schema wms_private to authenticated;
create function wms_private.can_access_branch(target text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active
 and (p.role='Administrator' or p.branch_id=target))
$$;
create function wms_private.is_hq() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and is_active and role='Administrator')
$$;
revoke all on function wms_private.can_access_branch(text),wms_private.is_hq() from public,anon;
grant execute on function wms_private.can_access_branch(text),wms_private.is_hq() to authenticated;
alter table public.branches enable row level security;
revoke all on public.branches from anon,authenticated;
grant select,insert,update on public.branches to authenticated;
create policy branches_read on public.branches for select to authenticated using(wms_private.can_access_branch(id));
create policy branches_create on public.branches for insert to authenticated with check(wms_private.is_hq());
create policy branches_update on public.branches for update to authenticated using(wms_private.is_hq()) with check(wms_private.is_hq());
drop policy profiles_read_own_or_admin on public.profiles;
create policy profiles_read_own_or_admin on public.profiles for select to authenticated using(
 id=auth.uid() or wms_private.is_hq() or (public.wms_is_admin() and wms_private.can_access_branch(branch_id))
);
drop policy wms_documents_read_authenticated on public.wms_documents;
create policy wms_documents_read_authenticated on public.wms_documents for select to authenticated using(wms_private.can_access_branch(branch_id));
drop policy wms_documents_insert_operator on public.wms_documents;
create policy wms_documents_insert_operator on public.wms_documents for insert to authenticated with check(public.wms_can_operate() and wms_private.can_access_branch(branch_id));
drop policy wms_documents_update_operator on public.wms_documents;
create policy wms_documents_update_operator on public.wms_documents for update to authenticated using(public.wms_can_operate() and wms_private.can_access_branch(branch_id)) with check(public.wms_can_operate() and wms_private.can_access_branch(branch_id));
drop policy wms_documents_delete_operator on public.wms_documents;
create policy wms_documents_delete_operator on public.wms_documents for delete to authenticated using(public.wms_can_operate() and wms_private.can_access_branch(branch_id));
drop function public.apply_wms_batch(jsonb,jsonb);
create function public.apply_wms_batch(p_upserts jsonb,p_deletes jsonb,p_branch_id text default 'CENTER')
returns void language plpgsql security invoker set search_path='' as $$
declare item jsonb;
begin
 if not public.wms_can_operate() or not wms_private.can_access_branch(p_branch_id) then raise exception 'Akses cabang ditolak'; end if;
 if jsonb_typeof(coalesce(p_upserts,'[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_deletes,'[]'::jsonb))<>'array' then raise exception 'Invalid batch'; end if;
 for item in select value from jsonb_array_elements(coalesce(p_upserts,'[]'::jsonb)) loop
 insert into public.wms_documents(branch_id,collection_name,document_id,payload,updated_by)
 values(p_branch_id,item->>'collection_name',item->>'document_id',item->'payload',auth.uid())
 on conflict(branch_id,collection_name,document_id) do update set
 payload=case when coalesce((item->>'merge')::boolean,false) then public.wms_documents.payload||excluded.payload else excluded.payload end,
 updated_at=now(),updated_by=auth.uid();
 end loop;
 for item in select value from jsonb_array_elements(coalesce(p_deletes,'[]'::jsonb)) loop
 delete from public.wms_documents where branch_id=p_branch_id and collection_name=item->>'collection_name' and document_id=item->>'document_id';
 end loop;
end;
$$;
revoke all on function public.apply_wms_batch(jsonb,jsonb,text) from public,anon;
grant execute on function public.apply_wms_batch(jsonb,jsonb,text) to authenticated;

revoke all on public.profiles,public.wms_documents from anon,authenticated;
grant select on public.profiles to authenticated;
grant select,insert,update,delete on public.wms_documents to authenticated;
