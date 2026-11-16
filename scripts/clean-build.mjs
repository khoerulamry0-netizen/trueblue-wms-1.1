import fs from 'node:fs';
import path from 'node:path';

console.log('--- CLEAN BUILD PRE-FLIGHT ---');
const viteCache = path.resolve('node_modules', '.vite');
const distDir = path.resolve('dist');

if (fs.existsSync(viteCache)) {
  console.log('Removing stale vite cache:', viteCache);
  try { fs.rmSync(viteCache, { recursive: true, force: true }); } catch (e) { console.warn(e.message); }
}

if (fs.existsSync(distDir)) {
  console.log('Removing stale dist directory:', distDir);
  try { fs.rmSync(distDir, { recursive: true, force: true }); } catch (e) { console.warn(e.message); }
}

console.log('--- READY FOR VITE BUILD ---');
