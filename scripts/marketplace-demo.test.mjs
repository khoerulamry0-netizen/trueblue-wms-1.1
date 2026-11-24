import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(new URL('../supabase/migrations/20261118042505_marketplace_integrations.sql', import.meta.url), 'utf8');
const component = fs.readFileSync(new URL('../src/components/MarketplaceIntegration.tsx', import.meta.url), 'utf8');

test('marketplace demo schema is isolated, unique and admin guarded', () => {
  assert.match(migration, /unique \(company_id, marketplace, store_id, external_order_id\)/);
  assert.match(migration, /alter table public\.marketplace_orders enable row level security/);
  assert.match(migration, /public\.wms_is_admin\(\)/);
  assert.match(migration, /check \(mode in \('DEMO', 'LIVE'\)\)/);
});

test('demo connector cannot write operational order or stock collections', () => {
  assert.doesNotMatch(component, /from\(['"]orders['"]\)/);
  assert.doesNotMatch(component, /from\(['"]stock['"]\)/);
  assert.match(component, /marketplace_orders/);
  assert.match(component, /DEMO.*tidak menyentuh stok/);
});

test('unmapped demo orders remain blocked until mapping is saved', () => {
  assert.match(component, /PERLU_MAPPING/);
  assert.match(component, /SIAP_DITINJAU/);
  assert.match(component, /marketplace_sku_mappings/);
  assert.match(component, /Tidak masuk antrean picking/);
});
