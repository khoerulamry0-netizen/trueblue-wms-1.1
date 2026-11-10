import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const srcDir = process.cwd();
const scratchDir = 'C:\\Users\\khoer\\.gemini\\antigravity\\brain\\f90326e9-3a58-4add-9ba7-611b7b3a5242\\scratch\\clean-staging';
const destZipArtifact = 'C:\\Users\\khoer\\.gemini\\antigravity\\brain\\f90326e9-3a58-4add-9ba7-611b7b3a5242\\trueblue-wms-clean-template.zip';
const destZipPublic = path.join(srcDir, 'public', 'trueblue-wms-clean-template.zip');

const excludeList = new Set([
  'node_modules',
  '.git',
  '.vite-temp',
  '.prod-compare-tmp',
  'dist',
  'scratch',
  '.user_uploaded'
]);

if (fs.existsSync(scratchDir)) {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
fs.mkdirSync(scratchDir, { recursive: true });

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const base = path.basename(src);
    if (excludeList.has(base)) return;
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    const ext = path.extname(src).toLowerCase();
    if (ext === '.zip') return;
    fs.copyFileSync(src, dest);
  }
}

console.log('Copying clean files to staging...');
for (const item of fs.readdirSync(srcDir)) {
  if (excludeList.has(item)) continue;
  copyRecursive(path.join(srcDir, item), path.join(scratchDir, item));
}

console.log('Staging done. Compressing archive with PowerShell Compress-Archive...');
if (fs.existsSync(destZipArtifact)) fs.unlinkSync(destZipArtifact);
if (fs.existsSync(destZipPublic)) fs.unlinkSync(destZipPublic);

const psCmd = `powershell -NoProfile -Command "Compress-Archive -Path '${scratchDir}\\*' -DestinationPath '${destZipArtifact}' -CompressionLevel Optimal -Force"`;
execSync(psCmd, { stdio: 'inherit' });

fs.copyFileSync(destZipArtifact, destZipPublic);

const sizeMb = (fs.statSync(destZipArtifact).size / (1024 * 1024)).toFixed(2);
console.log(`ZIP created successfully! Size: ${sizeMb} MB`);
