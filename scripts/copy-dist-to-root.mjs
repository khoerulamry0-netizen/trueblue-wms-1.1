import fs from 'node:fs';
import path from 'node:path';

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
