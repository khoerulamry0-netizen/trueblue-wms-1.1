import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
const shell=readFileSync(new URL('../src/components/AppShell.tsx',import.meta.url),'utf8');
const outbound=readFileSync(new URL('../src/components/MabangWmsOutbound.tsx',import.meta.url),'utf8');

test('every accent overrides theme variables directly on the body',()=>{
 for(const accent of ['default','blue','green','yellow','pink','orange','purple','black','custom']){
  assert.match(css,new RegExp(`html\\[data-accent="${accent}"\\] body\\.theme-citrus\\{[^}]*--gpt-accent:`));
 }
});

test('accent-driven controls consume the selected CSS variable',()=>{
 assert.match(css,/\.blues-button-primary[^}]*background:var\(--gpt-accent\)/);
 assert.match(css,/\[class\*="text-blue-"\][^{]*\{color:var\(--gpt-accent\)!important;/);
 assert.match(shell,/setAccent\(option\.id\)/);
 assert.match(shell,/setAccent\('custom'\)/);
});

test('wrong-scan alert banners preserve high-contrast red styling across all outbound stages',()=>{
 const alertMatches = outbound.match(/wms-scan-error-alert/g) || [];
 assert.equal(alertMatches.length, 3, 'Picking, Sortir, and Packing error alerts must each use wms-scan-error-alert');
 assert.match(css,/\.wms-scan-error-alert\.wms-scan-error-alert\[class\]\s*\{[^}]*background-color:\s*#dc2626\s*!important;[^}]*background-image:\s*linear-gradient/s);
 assert.match(css,/\.wms-scan-error-alert\s+\.wms-scan-error-message\s*\{[^}]*color:\s*#ffffff\s*!important;/s);
});
