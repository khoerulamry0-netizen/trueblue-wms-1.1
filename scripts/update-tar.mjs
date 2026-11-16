import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const srcDir = process.cwd();
const stagingParent = path.join(os.tmpdir(), 'trueblue-wms-tar-staging');
const stagingDir = path.join(stagingParent, 'unified-wms');
const destTar = path.resolve(srcDir, '..', '..', 'unified-wms-source.tar.gz');

const excludeNames = new Set([
  'node_modules',
  '.git',
  '.vite-temp',
  '.prod-compare-tmp',
  'dist',
  'scratch',
  '.user_uploaded'
]);

if (fs.existsSync(stagingParent)) fs.rmSync(stagingParent, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

console.log('Copying directory tree using fs.cpSync...');
fs.cpSync(srcDir, stagingDir, {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    if (excludeNames.has(base)) return false;
    if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return false;
    if (src.endsWith('.zip')) return false;
    return true;
  }
});

// Verify staging structure:
console.log('Verifying staging structure:');
console.log('src/main.tsx exists:', fs.existsSync(path.join(stagingDir, 'src', 'main.tsx')));
console.log('src/App.tsx exists:', fs.existsSync(path.join(stagingDir, 'src', 'App.tsx')));
console.log('index.html exists:', fs.existsSync(path.join(stagingDir, 'index.html')));

console.log('Packing tar.gz...');
execSync(`tar -czf "${destTar}" -C "${stagingParent}" unified-wms`, { stdio: 'inherit' });
const size = (fs.statSync(destTar).size / 1024 / 1024).toFixed(2);
console.log('Updated unified-wms-source.tar.gz! Size:', size, 'MB');
