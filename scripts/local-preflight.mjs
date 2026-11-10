import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localApiFetch, readLocalSupabaseStatus } from './local-supabase.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function verifyBranchMetadataGit(runGit) {
  const tracked = runGit(['ls-files', '--', 'supabase/.branches/']);
  if (tracked.error || tracked.status !== 0) throw new Error('Cannot verify whether Supabase branch metadata is tracked.');
  if (tracked.stdout.trim()) throw new Error('Supabase branch metadata is already tracked; ignoring it does not remove tracked files.');
  const ignored = runGit(['check-ignore', '--no-index', '-q', '--', 'supabase/.branches/_current_branch']);
  if (ignored.error || ignored.status !== 0) throw new Error('Supabase branch metadata is not confirmed ignored by Git.');
}

export async function runPreflight({ getStatus, fetchApi, checkMetadata }) {
  checkMetadata();
  const { apiUrl, anonKey } = getStatus();
  if (apiUrl !== 'http://127.0.0.1:54321' || !anonKey) throw new Error('Local API target or anonymous key is missing.');
  let response;
  try {
    response = await fetchApi(`${apiUrl}/auth/v1/health`, {
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Local Auth health check failed or timed out.');
  }
  if (!response.ok) throw new Error(`Local Auth health check returned HTTP ${response.status}.`);
  return { apiUrl, anonKey };
}

export async function runLocalPreflight() {
  const status = await runPreflight({
    getStatus: readLocalSupabaseStatus,
    fetchApi: localApiFetch,
    checkMetadata: () => verifyBranchMetadataGit((args) => spawnSync('git', args, {
      cwd: root, encoding: 'utf8', windowsHide: true,
    })),
  });
  console.log('Local preflight passed: unified-wms-dev, loopback-only Docker ports, local database targets, and API health.');
  console.log('Supabase branch metadata is ignored and not tracked. No database writes were performed.');
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runLocalPreflight();
  } catch (error) {
    console.error(`Local preflight failed: ${error instanceof Error ? error.message : 'Unexpected error.'}`);
    process.exitCode = 1;
  }
}
