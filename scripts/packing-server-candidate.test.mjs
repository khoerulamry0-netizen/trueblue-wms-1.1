import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../supabase/snippets/packing-server-candidate.sql', import.meta.url), 'utf8');

test('candidate keeps scan data private and checks actor and branch', () => {
  assert.match(sql, /revoke all on wms_private\.scan_sessions, wms_private\.scan_events,[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(sql, /not wms_private\.can_access_branch\(p_branch\)/i);
  assert.match(sql, /s\.actor_id<>auth\.uid\(\)/i);
  assert.match(sql, /p\.is_active[\s\S]*p\.role in \('Administrator','Admin','Packer'\)/i);
});

test('candidate records a single event and rejects invalid SKU, excess and reused request bodies', () => {
  assert.match(sql, /primary key \(session_id, request_id\)/i);
  assert.match(sql, /prior\.input_code<>trim\(p_code\)/i);
  assert.match(sql, /matched_count<>1/i);
  assert.match(sql, /e\.document_id=v->>'id'\) < \(v->>'qty'\)::numeric/i);
  assert.match(sql, /raise exception 'Jumlah scan berlebih'/i);
});

test('candidate gates sorting and completion with protected transaction-scoped authority', () => {
  assert.match(sql, /create trigger a_guard_scan_order before insert or update/i);
  assert.match(sql, /a\.transaction_id=txid_current\(\) and a\.actor_id=auth\.uid\(\)/i);
  assert.match(sql, /s\.phase='sorting' and s\.state='finished'[\s\S]*s\.snapshot=v_snapshot/i);
  assert.match(sql, /wms_private\.scan_snapshot\(s\.branch_id,s\.reference_number\)<>s\.snapshot/i);
  assert.match(sql, /e\.document_id=v->>'id'\)\s*<>\s*\(v->>'qty'\)::numeric/i);
  assert.match(sql, /wms_private\.commit_wms_write\(p_request,s\.branch_id,changes,'\[\]'::jsonb\)/i);
});

test('packing compares the stored sorting snapshot to the current snapshot without a name collision', () => {
  const start = sql.match(/create function public\.start_order_scan\([\s\S]*?end; \$\$;/i)?.[0];
  assert.ok(start, 'start_order_scan must exist');
  assert.match(start, /declare v_snapshot jsonb/i);
  assert.match(start, /v_snapshot\s*=\s*wms_private\.scan_snapshot\(p_branch,p_reference\)/i);
  assert.match(start, /s\.snapshot\s*=\s*v_snapshot/i);
  assert.doesNotMatch(start, /declare snapshot jsonb|s\.snapshot\s*=\s*snapshot\b/i);
  assert.match(start, /values\(p_session,p_branch,p_reference,p_phase,trim\(p_basket\),auth\.uid\(\),v_snapshot\)/i);
});

test('candidate requires Administrator and an audit reason for direct outbound', () => {
  assert.match(sql, /p\.role='Administrator'/i);
  assert.match(sql, /length\(trim\(p_reason\)\),0\) not between 10 and 500/i);
  assert.match(sql, /Outbound langsung hanya untuk order baru/i);
  assert.match(sql, /insert into public\.activity_events[\s\S]*'DIRECT_OUTBOUND'/i);
});

test('recovery and receipt evidence stay private and are revision bound', () => {
  assert.match(sql, /create unique index scan_sessions_one_open[\s\S]*where state='open'/i);
  assert.match(sql, /create function public\.get_order_scan_status[\s\S]*x\.actor_id=auth\.uid\(\)/i);
  assert.match(sql, /'counts',counts,'events',events[\s\S]*'finish_request',s\.finish_request/i);
  assert.match(sql, /s\.state='finished' and s\.finish_request=p_request/i);
  assert.match(sql, /create table wms_private\.receipt_proofs/i);
  assert.match(sql, /current_snapshot<>proof\.snapshot/i);
  assert.match(sql, /v->>'status' is distinct from 'Completed'/i);
  assert.match(sql, /create function public\.get_direct_outbound_status[\s\S]*r\.actor_id=auth\.uid\(\)/i);
});
