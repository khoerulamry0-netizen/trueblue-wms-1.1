import assert from 'node:assert/strict';
import test from 'node:test';
import { removeRedundantDashboard, terminateFinalFunction, verifyFunctionTerminators } from './build-local-migrations.mjs';
import { findMigrationConflicts } from './check-migration-conflicts.mjs';

const fn = "create function wms_private.example() returns void language plpgsql as $body$begin null; end;$body$";

test('terminates a final function without changing its body or trailing comments', () => {
  const source = `${fn}\n-- source note\n`;
  const result = terminateFinalFunction(source, 'source.sql');
  assert.equal(result, `${fn};\n-- source note\n`);
  verifyFunctionTerminators(result, 'source.sql');
});

test('preserves terminators separated from the body by whitespace and comments', () => {
  const source = `${fn}\n/* comment */\n;\n`;
  assert.equal(terminateFinalFunction(source, 'source.sql'), source);
  verifyFunctionTerminators(source, 'source.sql');
});

test('rejects a missing terminator before another statement', () => {
  const source = `${fn}\n-- comment\ncreate table public.example(id integer);`;
  assert.throws(() => terminateFinalFunction(source, 'source.sql'), /Missing SQL terminator after function example/);
  assert.throws(() => verifyFunctionTerminators(source, 'source.sql'), /Missing SQL terminator after function example/);
});

test('detects an unterminated body and an absent final terminator', () => {
  assert.throws(() => terminateFinalFunction(fn.replace('end;$body$', 'end;'), 'source.sql'), /Unterminated function body/);
  assert.throws(() => verifyFunctionTerminators(fn, 'source.sql'), /Missing SQL terminator after function example/);
});

test('validates every function, including earlier definitions', () => {
  const source = `${fn};\n${fn.replace('example()', 'second()')};`;
  assert.equal(terminateFinalFunction(source, 'source.sql'), source);
  verifyFunctionTerminators(source, 'source.sql');
  assert.throws(() => verifyFunctionTerminators(source.replace('$body$;\n', '$body$\n'), 'source.sql'), /function example/);
});

test('consolidates only an identical final HQ dashboard definition', () => {
  const dashboard = fn.replace('example()', 'hq_dashboard()') + ';';
  assert.equal(removeRedundantDashboard(`select 1;\n${dashboard}\n`, dashboard), 'select 1;\n\n');
  assert.throws(() => removeRedundantDashboard(dashboard, dashboard.replace('null', 'raise notice null')), /definitions differ/);
  assert.throws(() => removeRedundantDashboard(`${dashboard}\nselect 1;`, dashboard), /final source statement/);
  assert.throws(() => removeRedundantDashboard(`${dashboard}\n${dashboard}`, dashboard), /exactly one/);
});

const audit = (...sql) => findMigrationConflicts(sql.map((content, index) => ({ name: `migration${index + 1}.sql`, sql: content })));
const sqlFunction = (args, replace = '') => `create ${replace}function public.f(${args}) returns integer language sql as $$select 1$$;`;

test('detects duplicate input signatures across migrations and allows overloads and replacements', () => {
  assert.equal(audit(sqlFunction('x integer'), sqlFunction('other int4')).length, 1);
  assert.equal(audit(sqlFunction('x integer'), sqlFunction('x text')).length, 0);
  assert.equal(audit(sqlFunction('x integer'), sqlFunction('x integer', 'or replace ')).length, 0);
  assert.equal(audit(sqlFunction('x integer'), `drop function public.f(integer); ${sqlFunction('x int')}`).length, 0);
  assert.match(audit(sqlFunction('x integer'), sqlFunction('x int', 'or replace ').replace('returns integer', 'returns text'))[0], /changes return type/);
});

test('detects duplicates of tables, indexes, policies and triggers in their correct scopes', () => {
  const first = `create table public.t(id integer);
    create index idx on public.t(id);
    create policy pol on public.t using(true);
    create trigger trg before insert on public.t for each row execute function public.f();`;
  assert.equal(audit(first, first).length, 4);
  assert.equal(audit(first, `create table if not exists public.t(id integer);
    create index if not exists idx on public.t(id);
    create policy pol on public.other using(true);
    create trigger trg before insert on public.other for each row execute function public.f();`).length, 0);
  assert.equal(audit(first, `drop policy pol on public.t; create policy pol on public.t using(true);
    drop trigger trg on public.t; create trigger trg before insert on public.t for each row execute function public.f();`).length, 0);
  assert.equal(audit('create table public.idx(id integer);', 'create index idx on public.other(id);').length, 1);
});

test('ignores declarations in comments and function bodies and rejects unsupported object syntax', () => {
  const source = `-- create table public.t(id integer);
    create function public.f() returns void language plpgsql as $body$
    begin perform 'create table public.t(id integer);'; end;$body$;
    create table public.t(id integer);`;
  assert.equal(audit(source).length, 0);
  assert.throws(() => audit('create function "public"."f"() returns void language sql as $$select 1$$;'), /Unsupported object definition/);
});
