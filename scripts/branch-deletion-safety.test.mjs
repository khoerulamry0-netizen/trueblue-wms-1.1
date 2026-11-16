import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20261112234632_suspend_unsafe_branch_deletion.sql', import.meta.url),
  'utf8',
);
const hardening = readFileSync(
  new URL('../supabase/migrations/20261112235025_harden_branch_deletion_interlock.sql', import.meta.url),
  'utf8',
);
const lossless = readFileSync(
  new URL('../supabase/migrations/20261113000453_lossless_multipart_branch_backup.sql', import.meta.url),
  'utf8',
);
const component = readFileSync(
  new URL('../src/components/BranchDeletion.tsx', import.meta.url),
  'utf8',
);

test('permanent branch deletion is fail-closed while multipart restore is incomplete', () => {
  assert.match(migration, /status = 'CANCELLED'[\s\S]*where status = 'PREPARED'/i);
  assert.match(migration, /revoke all on function wms_private\.branch_deletion_action/i);
  assert.match(migration, /if p_action = 'cancel'/i);
  assert.match(migration, /raise exception using[\s\S]*errcode = '55000'/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\./i);
  assert.match(hardening, /security invoker/i);
  assert.match(hardening, /raise exception using[\s\S]*errcode = '55000'/i);
  assert.doesNotMatch(hardening, /wms_private\.branch_deletion_action\s*\(/i);
});

test('lossless multipart recovery replaces the temporary safety interlock', () => {
  assert.match(lossless, /branch_deletion_parts/i);
  assert.match(lossless, /branch_part_requests[\s\S]*write_requests[\s\S]*period_archives[\s\S]*stock_purge_plans/i);
  assert.match(lossless, /branch_part_backups[\s\S]*backup_payloads/i);
  assert.match(lossless, /Unduh keempat bagian backup sebelum membuat manifest/i);
  assert.match(lossless, /Data cabang berubah setelah backup/i);
  assert.match(lossless, /Pemulihan tidak identik untuk bagian/i);
  assert.match(lossless, /not wms_private\.is_hq\(\)/i);
  assert.match(component, /PERMANENT_DELETION_SAFETY_HOLD=false/);
  assert.match(component, /crypto\.subtle\.digest\('SHA-256'/i);
  assert.match(component, /expectedParts\.length!==4/);
});
