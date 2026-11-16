import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  branchSupportsOperation,
  classifyWebhookOrderType,
  formatOrderTypeBadge,
  isOrderVisibleForBranchManifest,
  isOrderVisibleForOperation,
  isQuickOutboundItem,
  normalizeBranchOperationType,
  normalizeOrderType,
  resolveOrderType,
  validateManifestOrderSelection,
} from '../src/utils/orderType.ts';

const shell = readFileSync(new URL('../src/components/AppShell.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const outboundManager = readFileSync(new URL('../src/components/OutboundManager.tsx', import.meta.url), 'utf8');
const courierManifest = readFileSync(new URL('../src/components/CourierManifestManager.tsx', import.meta.url), 'utf8');
const bulkOutbound = readFileSync(new URL('../src/components/BulkOutbound.tsx', import.meta.url), 'utf8');
const mabangOutbound = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../supabase/migrations/20261116000000_b2b_online_hybrid_shipping.sql', import.meta.url),
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

test('webhook classification accepts only explicit orderType or whitelisted online marketplace sources', () => {
  assert.deepEqual(classifyWebhookOrderType({ marketplace: 'Shopee' }), {
    orderType: 'ONLINE',
    orderSource: 'SHOPEE',
    trusted: true,
  });
  assert.deepEqual(classifyWebhookOrderType({ platform: 'TikTok Shop' }), {
    orderType: 'ONLINE',
    orderSource: 'TIKTOK_SHOP',
    trusted: true,
  });
  assert.deepEqual(classifyWebhookOrderType({ orderSource: 'EDI_DISTRIBUTOR', orderType: 'B2B' }), {
    orderType: 'B2B',
    orderSource: 'EDI_DISTRIBUTOR',
    trusted: true,
  });
  assert.deepEqual(classifyWebhookOrderType({ noPo: 'PO-B2B-100', source: 'UNKNOWN_ERP' }), {
    orderType: 'UNASSIGNED',
    orderSource: 'UNKNOWN_ERP',
    trusted: false,
  });
  assert.deepEqual(classifyWebhookOrderType(null), {
    orderType: 'UNASSIGNED',
    orderSource: 'WEBHOOK_UNKNOWN',
    trusted: false,
  });
});

test('queue and manifest visibility enforce B2B vs ONLINE vs HYBRID isolation', () => {
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

  assert.equal(isOrderVisibleForBranchManifest(legacyOrder, 'HYBRID', 'ALL'), false);
  assert.equal(isOrderVisibleForBranchManifest(b2bOrder, 'ONLINE', 'ALL'), false);
  assert.equal(isOrderVisibleForBranchManifest(b2bOrder, 'HYBRID', 'ONLINE'), false);
  assert.equal(isOrderVisibleForBranchManifest(b2bOrder, 'HYBRID', 'B2B'), true);
  assert.equal(isQuickOutboundItem({ outboundType: 'quick' }), true);
  assert.equal(formatOrderTypeBadge('UNASSIGNED'), 'UNASSIGNED');
});

test('manifest selection rejects mixed channels, UNASSIGNED, double shipping, and mismatched branches', () => {
  assert.equal(validateManifestOrderSelection([], 'HYBRID').ok, false);
  assert.equal(
    validateManifestOrderSelection([{ orderType: 'B2B', shipped: false }, { orderType: 'ONLINE', shipped: false }], 'HYBRID').ok,
    false
  );
  assert.equal(
    validateManifestOrderSelection([{ shipped: false }], 'HYBRID').ok,
    false
  );
  assert.equal(
    validateManifestOrderSelection([{ orderType: 'B2B', shipped: true }], 'HYBRID').ok,
    false
  );
  assert.equal(
    validateManifestOrderSelection([{ orderType: 'ONLINE', shipped: false }], 'B2B').ok,
    false
  );
  assert.deepEqual(
    validateManifestOrderSelection([{ orderType: 'ONLINE', shipped: false }], 'HYBRID'),
    { ok: true, orderType: 'ONLINE' }
  );
});

test('navigation, role access, HYBRID quick outbound, and branding contracts are intact', () => {
  assert.match(shell, /nav\.outboundB2bGroup/);
  assert.match(shell, /nav\.outboundOnlineGroup/);
  assert.match(shell, /nav\.shippingGroup/);
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
    'shipping-manifest',
  ]) {
    assert.match(shell, new RegExp(`id:\\s*'${id}'`));
  }
  assert.match(shell, /Shipping/);
  assert.match(shell, /TRUEBLUE/);
  assert.doesNotMatch(shell, /WMS Demo/i);

  assert.match(app, /handleAssignOrderType/);
  assert.match(app, /handleUpdateOrdersShipped/);
  assert.match(app, /UnassignedOrdersBanner/);
  assert.match(app, /CourierManifestManager/);
  assert.match(app, /MarketplaceWebhook/);
  assert.match(outboundManager, /branchOperationType === 'HYBRID'/);
  assert.match(courierManifest, /validateManifestOrderSelection/);
  assert.match(bulkOutbound, /channelMode/);
  assert.match(mabangOutbound, /requireExplicitOnlineType/);
});

test('PostgreSQL migration includes branch operation_type, Shipping role RLS, manifests table, and locked RPCs', () => {
  assert.match(migration, /operation_type/);
  assert.match(migration, /'Shipping'/);
  assert.match(migration, /documents_shipping_read/);
  assert.match(migration, /create table if not exists public\.shipping_manifests/i);
  assert.match(migration, /create or replace function public\.save_branch/i);
  assert.match(migration, /create or replace function public\.commit_shipping_manifest/i);
  assert.match(migration, /create or replace function public\.assign_order_types/i);
  assert.match(migration, /create or replace function public\.admin_manage_user/i);
  assert.match(migration, /create or replace function public\.marketplace_order_webhook/i);
  assert.match(migration, /pg_advisory_xact_lock/);
});
