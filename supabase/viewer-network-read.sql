create or replace function wms_private.is_inventory_viewer() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.profiles where id=auth.uid() and is_active and role='Viewer') $$;
revoke all on function wms_private.is_inventory_viewer() from public,anon;
grant execute on function wms_private.is_inventory_viewer() to authenticated;
drop policy if exists branches_inventory_viewer_read on public.branches;
create policy branches_inventory_viewer_read on public.branches for select to authenticated using ((select wms_private.is_inventory_viewer()));
drop policy if exists documents_inventory_viewer_read on public.wms_documents;
create policy documents_inventory_viewer_read on public.wms_documents as restrictive for select to authenticated using (
 not (select wms_private.is_inventory_viewer())
 or collection_name in ('stock','warehouses','catalog')
);
