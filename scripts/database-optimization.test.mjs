import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20261112235800_optimize_rls_and_foreign_key_indexes.sql', import.meta.url),
  'utf8',
);

test('RLS helpers are cached and duplicate read policies are removed', () => {
  assert.match(migration, /id = \(select auth\.uid\(\)\)/i);
  assert.match(migration, /drop policy if exists branches_inventory_viewer_read/i);
  assert.match(migration, /drop policy if exists documents_inventory_viewer_read/i);
  assert.match(migration, /\(select public\.wms_can_operate\(\)\)/i);
});

test('all advisor-reported foreign keys have covering indexes', () => {
  for (const index of [
    'activity_events_actor_id_idx',
    'branch_backups_created_by_idx',
    'branch_transfers_created_by_idx',
    'stock_movements_actor_id_idx',
    'wms_documents_updated_by_idx',
    'period_archives_actor_id_idx',
    'period_archives_backup_id_idx',
    'period_archives_branch_id_idx',
    'stock_purge_plans_actor_id_idx',
    'stock_purge_plans_backup_id_idx',
    'stock_purge_plans_branch_id_idx',
  ]) {
    assert.match(migration, new RegExp(`create index if not exists ${index}`, 'i'));
  }
});
