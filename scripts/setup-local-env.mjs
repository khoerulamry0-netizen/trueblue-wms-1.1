import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalPreflight } from './local-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keys = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];

export function verifyEnvGit(runGit) {
  const tracked = runGit(['ls-files', '--', '.env']);
  if (tracked.error || tracked.status !== 0 || typeof tracked.stdout !== 'string') {
    throw new Error('Cannot verify whether .env is tracked.');
  }
  if (tracked.stdout.trim()) throw new Error('.env is tracked; setup cannot write secrets.');
  const ignored = runGit(['check-ignore', '--no-index', '-q', '--', '.env']);
  if (ignored.error || ignored.status !== 0) throw new Error('.env is not confirmed ignored by Git.');
}

export function updateEnv(contents, apiUrl, anonKey) {
  if (apiUrl !== 'http://127.0.0.1:54321' || typeof anonKey !== 'string' || !/^[A-Za-z0-9._-]+$/.test(anonKey)) {
    throw new Error('Local API URL or anonymous key is invalid.');
  }
  const values = {
    VITE_SUPABASE_URL: apiUrl, VITE_SUPABASE_ANON_KEY: anonKey,
    SUPABASE_URL: apiUrl, SUPABASE_ANON_KEY: anonKey,
  };
  const seen = new Set();
  const lines = contents.split(/\r?\n/);
  const updated = lines.map((line) => {
    if (/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*['"]/.test(line) &&
        !/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|"[^"]*")\s*(?:#.*)?$/.test(line)) {
      throw new Error('Unsupported quoted or multiline setting in .env; no changes made.');
    }
    const match = line.match(/^\s*(?:export\s+)?(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY|SUPABASE_URL|SUPABASE_ANON_KEY)\s*=(.*)$/);
    if (!match) return line;
    if (seen.has(match[1]) || !/^\s*(?:'[^']*'|"[^"]*"|[^'"]*)\s*$/.test(match[2])) {
      throw new Error('Ambiguous or duplicate Supabase setting in .env; no changes made.');
    }
    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });
  if (updated.at(-1) === '') updated.pop();
  for (const key of keys) if (!seen.has(key)) updated.push(`${key}=${values[key]}`);
  return `${updated.join('\n')}\n`;
}

export async function setupLocalEnv({ runGit, preflight, readEnv, writeEnv }) {
  verifyEnvGit(runGit);
  let status;
  try {
    status = await preflight();
  } catch {
    throw new Error('Local preflight failed; .env was not changed.');
  }
  const { apiUrl, anonKey } = status;
  const updated = updateEnv(readEnv(), apiUrl, anonKey);
  try {
    writeEnv(updated);
  } catch {
    throw new Error('Writing .env failed; inspect the file before retrying.');
  }
}

function readEnvFile(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('.env must be a regular file, not a link.');
  return readFileSync(file, 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = path.join(root, '.env');
    await setupLocalEnv({
      runGit: (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }),
      preflight: runLocalPreflight,
      readEnv: () => readEnvFile(file),
      writeEnv: (contents) => writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 }),
    });
    console.log('Local .env configured; anonymous key withheld.');
  } catch (error) {
    const safeMessages = new Set([
      'Cannot verify whether .env is tracked.', '.env is tracked; setup cannot write secrets.',
      '.env is not confirmed ignored by Git.', 'Local preflight failed; .env was not changed.',
      'Local API URL or anonymous key is invalid.', 'Ambiguous or duplicate Supabase setting in .env; no changes made.',
      'Unsupported quoted or multiline setting in .env; no changes made.',
      '.env must be a regular file, not a link.', 'Writing .env failed; inspect the file before retrying.',
    ]);
    const message = error instanceof Error && safeMessages.has(error.message)
      ? error.message : 'Unexpected setup or file access error; inspect .env before retrying.';
    console.error(`Local .env setup failed: ${message}`);
    process.exitCode = 1;
  }
}
