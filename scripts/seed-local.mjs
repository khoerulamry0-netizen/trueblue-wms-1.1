import { createClient } from '@supabase/supabase-js';
import { localApiFetch, readLocalSupabaseStatus } from './local-supabase.mjs';
import { createSeedStore, runSeed } from './local-seed-runner.mjs';

const passwords = [process.env.WMS_LOCAL_PICKER_PASSWORD, process.env.WMS_LOCAL_PACKER_PASSWORD];
const { apiUrl, serviceRoleKey } = readLocalSupabaseStatus();
const supabase = createClient(apiUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: localApiFetch },
});
try {
  await runSeed(createSeedStore(supabase), passwords, new Date().toISOString());
  console.log('Created DEV_LOCAL fixture: 2 warehouses, 100 SKUs, 200 stock positions, 100 pending orders, Picker and Packer.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local seed failed; inspect local fixture state before retrying.');
  process.exitCode = 1;
}
