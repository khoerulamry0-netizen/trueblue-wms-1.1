-- Cache request-scoped helper results once per statement and merge equivalent
-- permissive SELECT policies. The resulting access rules are unchanged.
alter policy profiles_read_own_or_admin on public.profiles
using (
  id = (select auth.uid())
  or (select wms_private.is_hq())
  or (
    (select public.wms_is_admin())
    and wms_private.can_access_branch(branch_id)
  )
);

alter policy branches_read on public.branches
using (
  wms_private.can_access_branch(id)
  or (select wms_private.is_inventory_viewer())
);
drop policy if exists branches_inventory_viewer_read on public.branches;

alter policy wms_documents_read_authenticated on public.wms_documents
using (
  wms_private.can_access_branch(branch_id)
  or (
    collection_name = any (array['stock'::text, 'warehouses'::text, 'catalog'::text])
    and (select wms_private.is_inventory_viewer())
  )
);
drop policy if exists documents_inventory_viewer_read on public.wms_documents;

alter policy wms_documents_insert_operator on public.wms_documents
with check (
  (select public.wms_can_operate())
  and wms_private.can_access_branch(branch_id)
);
alter policy wms_documents_update_operator on public.wms_documents
using (
  (select public.wms_can_operate())
  and wms_private.can_access_branch(branch_id)
)
with check (
  (select public.wms_can_operate())
  and wms_private.can_access_branch(branch_id)
);
alter policy wms_documents_delete_operator on public.wms_documents
using (
  (select public.wms_can_operate())
  and wms_private.can_access_branch(branch_id)
);

-- Cover every foreign key reported by the database advisor. These indexes also
-- reduce lock duration when referenced profile, branch, or backup rows change.
create index if not exists activity_events_actor_id_idx
  on public.activity_events(actor_id);
create index if not exists branch_backups_created_by_idx
  on public.branch_backups(created_by);
create index if not exists branch_transfers_created_by_idx
  on public.branch_transfers(created_by);
create index if not exists stock_movements_actor_id_idx
  on public.stock_movements(actor_id);
create index if not exists wms_documents_updated_by_idx
  on public.wms_documents(updated_by);

create index if not exists period_archives_actor_id_idx
  on wms_private.period_archives(actor_id);
create index if not exists period_archives_backup_id_idx
  on wms_private.period_archives(backup_id);
create index if not exists period_archives_branch_id_idx
  on wms_private.period_archives(branch_id);

create index if not exists stock_purge_plans_actor_id_idx
  on wms_private.stock_purge_plans(actor_id);
create index if not exists stock_purge_plans_backup_id_idx
  on wms_private.stock_purge_plans(backup_id);
create index if not exists stock_purge_plans_branch_id_idx
  on wms_private.stock_purge_plans(branch_id);
