import { createClient } from '@supabase/supabase-js';
import { localApiFetch, readLocalSupabaseStatus } from './local-supabase.mjs';
import { bootstrapLocalAdmin } from './local-admin-runner.mjs';

const email = process.env.WMS_LOCAL_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.WMS_LOCAL_ADMIN_PASSWORD;
if (!email || !password) throw new Error('Set the local administrator email and password before bootstrap.');

const { apiUrl, anonKey, serviceRoleKey } = readLocalSupabaseStatus();
const options = { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: localApiFetch } };
const authClient = createClient(apiUrl, anonKey, options);
try {
  await bootstrapLocalAdmin(authClient, () => createClient(apiUrl, serviceRoleKey, options), email, password);
  console.log('Verified local administrator is active in CENTER.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local administrator bootstrap failed; inspect local Auth state.');
  process.exitCode = 1;
}
