import { createClient } from '@supabase/supabase-js';
import { localApiFetch, readLocalSupabaseStatus } from './local-supabase.mjs';
import { createSeedStore, recoverSeedDocuments } from './local-seed-runner.mjs';

if (process.env.WMS_LOCAL_DOCUMENT_RECOVERY !== 'I_APPROVE_DOCUMENT_RECOVERY') {
  throw new Error('Document recovery requires explicit approval via WMS_LOCAL_DOCUMENT_RECOVERY.');
}

const { apiUrl, serviceRoleKey } = readLocalSupabaseStatus();
const supabase = createClient(apiUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: localApiFetch },
});
try {
  await recoverSeedDocuments(createSeedStore(supabase), new Date().toISOString());
  console.log('Verified 402 DEV_LOCAL fixture IDs: 2 warehouses, 100 catalog, 200 stock, 100 orders.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local document recovery failed; inspect local state before retrying.');
  process.exitCode = 1;
}
