import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  branchSupportsOperation,
  formatOrderTypeBadge,
  isOrderVisibleForOperation,
  isQuickOutboundItem,
  normalizeBranchOperationType,
  normalizeOrderType,
  resolveOrderType,
} from '../src/utils/orderType.ts';

const shell = readFileSync(new URL('../src/components/AppShell.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const outboundManager = readFileSync(new URL('../src/components/OutboundManager.tsx', import.meta.url), 'utf8');
const bulkOutbound = readFileSync(new URL('../src/components/BulkOutbound.tsx', import.meta.url), 'utf8');
const mabangOutbound = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../supabase/migrations/20261116000000_b2b_online_hybrid_shipping.sql', import.meta.url),
  'utf8'
);
const removalMigration = readFileSync(
  new URL('../supabase/migrations/20261116010000_remove_shipping_manifest_and_marketplace_webhook.sql', import.meta.url),
  'utf8'
);

test('orderType helpers never infer B2B or ONLINE from PO number or customer name', () => {
  assert.equal(resolveOrderType({ noPo: 'PO-B2B-9999', customerName: 'PT Wholesale Jaya' }), 'UNASSIGNED');
  assert.equal(resolveOrderType({ referenceNumber: 'SHOPEE-261116-01', customerName: 'Shopee Customer' }), 'UNASSIGNED');
  assert.equal(resolveOrderType({ orderType: 'b2b' }), 'B2B');
  assert.equal(resolveOrderType({ order_type: 'online' }), 'ONLINE');
  assert.equal(normalizeOrderType('UNKNOWN'), 'UNASSIGNED');
  assert.equal(normalizeBranchOperationType('unknown', 'HYBRID'), 'HYBRID');
  assert.equal(normalizeBranchOperationType('b2b'), 'B2B');
});

test('queue visibility enforces B2B vs ONLINE vs HYBRID isolation', () => {
  const b2bOrder = { orderType: 'B2B', shipped: false };
  const onlineOrder = { orderType: 'ONLINE', shipped: false };
  const legacyOrder = { noPo: 'PO-001', shipped: false };

  assert.equal(branchSupportsOperation('B2B', 'B2B'), true);
  assert.equal(branchSupportsOperation('B2B', 'ONLINE'), false);
  assert.equal(branchSupportsOperation('ONLINE', 'ONLINE'), true);
  assert.equal(branchSupportsOperation('ONLINE', 'B2B'), false);
  assert.equal(branchSupportsOperation('HYBRID', 'B2B'), true);
  assert.equal(branchSupportsOperation('HYBRID', 'ONLINE'), true);

  assert.equal(isOrderVisibleForOperation(b2bOrder, 'B2B', 'HYBRID'), true);
  assert.equal(isOrderVisibleForOperation(b2bOrder, 'ONLINE', 'HYBRID'), false);
  assert.equal(isOrderVisibleForOperation(onlineOrder, 'ONLINE', 'B2B'), false);
  assert.equal(isOrderVisibleForOperation(legacyOrder, 'B2B', 'HYBRID'), false);
  assert.equal(isOrderVisibleForOperation(legacyOrder, 'ONLINE', 'HYBRID'), false);

  assert.equal(isQuickOutboundItem({ outboundType: 'quick' }), true);
  assert.equal(formatOrderTypeBadge('UNASSIGNED'), 'UNASSIGNED');
});

test('navigation, role access, HYBRID quick outbound, and branding contracts are intact', () => {
  assert.match(shell, /nav\.outboundB2bGroup/);
  assert.match(shell, /nav\.outboundOnlineGroup/);
  for (const id of [
    'b2b-input',
    'b2b-picking',
    'b2b-packing',
    'b2b-history',
    'online-input',
    'online-picking',
    'online-sorting',
    'online-packing',
    'online-history',
  ]) {
    assert.match(shell, new RegExp(`id:\\s*'${id}'`));
  }
  assert.match(shell, /Shipping/);
  assert.match(shell, /TRUEBLUE/);
  assert.doesNotMatch(shell, /WMS Demo/i);

  assert.match(app, /handleAssignOrderType/);
  assert.match(app, /UnassignedOrdersBanner/);
  assert.doesNotMatch(app, /CourierManifestManager|MarketplaceWebhook|shipping-manifest|marketplace-webhook/);
  assert.doesNotMatch(shell, /CourierManifestManager|MarketplaceWebhook|shipping-manifest|marketplace-webhook/);
  assert.match(outboundManager, /branchOperationType === 'HYBRID'/);
  assert.match(bulkOutbound, /channelMode/);
  assert.match(mabangOutbound, /requireExplicitOnlineType/);
});

test('PostgreSQL migration keeps branch operation_type and removes retired RPCs', () => {
  assert.match(migration, /operation_type/);
  assert.match(migration, /'Shipping'/);
  assert.match(migration, /documents_shipping_read/);
  assert.match(migration, /create or replace function public\.save_branch/i);
  assert.match(migration, /create or replace function public\.assign_order_types/i);
  assert.match(migration, /create or replace function public\.admin_manage_user/i);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(removalMigration, /drop function if exists public\.commit_shipping_manifest/i);
  assert.match(removalMigration, /drop function if exists public\.marketplace_order_webhook/i);
  assert.match(removalMigration, /drop table if exists public\.shipping_manifests/i);
});
