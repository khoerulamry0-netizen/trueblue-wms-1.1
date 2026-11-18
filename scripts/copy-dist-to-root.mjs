import fs from 'node:fs';
import path from 'node:path';

// The application is served from this project's dist directory. Mirroring to
// parent directories is only a legacy convenience and can fail (or crash the
// Node process) when those directories are managed by another process.
if (process.env.MIRROR_DIST_TO_PARENT !== 'true') {
  console.log('Skipping optional parent dist mirror. Set MIRROR_DIST_TO_PARENT=true to enable it.');
  process.exit(0);
}

try {
  const currentDist = path.resolve('dist');
  const parentDist = path.resolve('..', 'dist');
  const grandParentDist = path.resolve('..', '..', 'dist');
  
  if (fs.existsSync(currentDist)) {
    console.log(`Copying built dist from ${currentDist} to ${parentDist}...`);
    fs.cpSync(currentDist, parentDist, { recursive: true });
    
    try {
      fs.cpSync(currentDist, grandParentDist, { recursive: true });
    } catch {}
    console.log('Successfully mirrored dist to parent root directories.');
  }
} catch (err) {
  console.warn('Note: Could not mirror dist to parent (ignoring):', err.message);
}
