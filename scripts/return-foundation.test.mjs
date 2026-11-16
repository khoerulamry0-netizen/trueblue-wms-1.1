import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const manager=readFileSync(new URL('../src/components/ReturnManager.tsx',import.meta.url),'utf8');
const shell=readFileSync(new URL('../src/components/AppShell.tsx',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const client=readFileSync(new URL('../src/supabase.ts',import.meta.url),'utf8');
const migration=readFileSync(new URL('../supabase/migrations/20261113020500_return_qc_workflow.sql',import.meta.url),'utf8');

test('return is exposed in operations navigation',()=>{
 assert.match(shell,/id: 'return'.*nav\.return.*RotateCcw/);
});

test('return QC has controlled decisions without video dependency',()=>{
 assert.match(manager,/Antrean QC Return/);
 assert.match(manager,/handleQcDecision\(returnCase\.caseId, 'ACCEPT'\)/);
 assert.match(manager,/handleQcDecision\(returnCase\.caseId, 'QUARANTINE'\)/);
 assert.match(manager,/handleQcDecision\(returnCase\.caseId, 'REJECT'\)/);
 assert.match(app,/onProcessQc=\{handleProcessReturnQc\}/);
 assert.match(client,/.rpc\('process_return_qc'/);
 assert.doesNotMatch(manager,/uploadReturnVideo|returnDriveAdmin|capture="environment"|Preview video unboxing|Google Drive Evidence/);
 assert.doesNotMatch(client,/uploadReturnVideo|returnDriveAdmin|deleteReturnEvidence/);
});

test('return operations keep SLA and visible queue',()=>{
 assert.match(manager,/Lewat SLA 24 jam/);
 assert.match(manager,/visiblePendingReturnCases/);
});

test('return stock posting is server-side, authorized, locked, and idempotent',()=>{
 assert.match(migration,/security definer/);
 assert.match(migration,/actor_role not in \('Administrator','Admin'\)/);
 assert.match(migration,/pg_advisory_xact_lock/);
 assert.match(migration,/idempotent',true/);
 assert.match(migration,/on conflict\(branch_id,collection_name,document_id\) do update/);
 assert.match(migration,/decision<>'REJECT'/);
 assert.match(migration,/grant execute .* to authenticated/);
});

test('return intake is ready for QC and does not post stock before QC',()=>{
 assert.match(manager,/status: 'READY_FOR_QC'/);
 assert.match(manager,/evidenceStatus: 'READY'/);
 assert.match(manager,/location: 'RETURN-QC'/);
 assert.doesNotMatch(manager,/onAddStockItem/);
 assert.doesNotMatch(manager,/onAddStockItemsBatch/);
});
