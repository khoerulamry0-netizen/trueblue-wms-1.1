const identifier = '[a-z_][a-z0-9_$]*';
const qualified = `${identifier}(?:\\s*\\.\\s*${identifier})?`;

function statements(sql) {
  const result = [];
  let text = '';
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end;
      text += ' ';
    } else if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      text += ' ';
    } else if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i++] === "'") break;
      }
      text += ' null ';
    } else if (sql[i] === '$') {
      const tag = sql.slice(i).match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/i)?.[0];
      if (!tag) { text += sql[i++]; continue; }
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error(`Unterminated dollar quote ${tag}`);
      i = end + tag.length;
      text += ' body ';
    } else if (sql[i] === ';') {
      if (text.trim()) result.push(text.trim());
      text = '';
      i++;
    } else {
      text += sql[i++];
    }
  }
  if (text.trim()) throw new Error('Unterminated SQL statement');
  return result;
}

function objectName(name, defaultSchema = 'public') {
  const parts = name.toLowerCase().replace(/\s/g, '').split('.');
  return parts.length === 1 ? `${defaultSchema}.${parts[0]}` : parts.join('.');
}

function normalizedType(type) {
  const normalized = type.toLowerCase().trim().replace(/\s+/g, ' ');
  const aliases = {
    int: 'integer', int4: 'integer', 'pg_catalog.int4': 'integer',
    int8: 'bigint', 'pg_catalog.int8': 'bigint',
    int2: 'smallint', 'pg_catalog.int2': 'smallint',
    bool: 'boolean', 'pg_catalog.bool': 'boolean',
    'character varying': 'varchar', 'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
  };
  return aliases[normalized] ?? normalized;
}

function functionArguments(args, isDrop) {
  if (!args.trim()) return [];
  return args.split(',').map((arg) => {
    const declaration = arg.trim().replace(/\s+(?:default\b|=)[\s\S]*$/i, '').trim();
    const parts = declaration.split(/\s+/);
    if (/^(out|inout|variadic)$/i.test(parts[0])) {
      throw new Error(`Unsupported function argument mode: ${declaration}`);
    }
    if (/^in$/i.test(parts[0])) parts.shift();
    if (!isDrop && parts.length > 1 && !/^(double|character|timestamp|time|bit)$/i.test(parts[0])) parts.shift();
    const type = parts.join(' ');
    if (!/^[a-z_][a-z0-9_.$]*(?:\s+(?:varying|precision|with|without|time|zone))*?(?:\[\])?$/i.test(type)) {
      throw new Error(`Unsupported function argument type: ${declaration}`);
    }
    return normalizedType(type);
  });
}

export function findMigrationConflicts(migrations) {
  const functions = new Map();
  const relations = new Map();
  const triggers = new Map();
  const policies = new Map();
  const conflicts = [];
  const name = `(${qualified})`;
  for (const migration of migrations) {
    for (const statement of statements(migration.sql)) {
      let match;
      if ((match = statement.match(new RegExp(`^(create\\s+(or\\s+replace\\s+)?|drop\\s+(?:if\\s+exists\\s+)?)function\\s+${name}\\s*\\(([^()]*)\\)`, 'i')))) {
        const dropping = /^drop/i.test(match[1]);
        const key = `${objectName(match[3])}(${functionArguments(match[4], dropping).join(',')})`;
        if (dropping) { functions.delete(key); continue; }
        const returns = statement.slice(match[0].length).match(/^\s*returns\s+(table\s*\([^)]*\)|setof\s+[\w.]+|[\w.]+(?:\[\])?)/i);
        if (!returns) throw new Error(`Unsupported return type for function ${key} in ${migration.name}`);
        const returnType = returns[1].toLowerCase().replace(/\s+/g, ' ').trim();
        const previous = functions.get(key);
        if (previous && !match[2]) conflicts.push(`function ${key} in ${migration.name} already created in ${previous.source}`);
        if (previous && match[2] && previous.returnType !== returnType) {
          conflicts.push(`function ${key} in ${migration.name} changes return type from ${previous.returnType} to ${returnType}`);
        }
        functions.set(key, { source: migration.name, returnType });
        continue;
      }
      if ((match = statement.match(new RegExp(`^(create|drop)\\s+(?:(or\\s+replace)\\s+)?(trigger|policy)\\s+(?:(if\\s+exists)\\s+)?(${identifier})\\b[\\s\\S]*?\\bon\\s+${name}\\b`, 'i')))) {
        const map = match[3].toLowerCase() === 'trigger' ? triggers : policies;
        const key = `${objectName(match[6])}:${match[5].toLowerCase()}`;
        if (/^drop$/i.test(match[1])) map.delete(key);
        else {
          if (map.has(key) && !match[2]) conflicts.push(`${match[3].toLowerCase()} ${key} in ${migration.name} already created in ${map.get(key)}`);
          map.set(key, migration.name);
        }
        continue;
      }
      if ((match = statement.match(new RegExp(`^(create|drop)\\s+(?:unique\\s+)?(table|index)\\s+(?:(if\\s+(?:not\\s+)?exists)\\s+)?${name}\\b`, 'i')))) {
        const isIndex = /^index$/i.test(match[2]);
        const table = isIndex && /^create$/i.test(match[1])
          ? statement.match(new RegExp(`\\bon\\s+(?:only\\s+)?${name}\\b`, 'i'))?.[1]
          : null;
        if (isIndex && /^create$/i.test(match[1]) && !table) throw new Error(`Cannot determine index schema in ${migration.name}: ${statement.slice(0, 100)}`);
        const schema = table ? objectName(table).split('.')[0] : 'public';
        const key = objectName(match[4], schema);
        if (/^drop$/i.test(match[1])) relations.delete(key);
        else {
          if (relations.has(key) && !match[3]) conflicts.push(`${match[2].toLowerCase()} ${key} in ${migration.name} already created in ${relations.get(key)}`);
          relations.set(key, migration.name);
        }
        continue;
      }
      if (/^(?:create|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:function|trigger|policy|table|index)\b/i.test(statement)) {
        throw new Error(`Unsupported object definition in ${migration.name}: ${statement.slice(0, 120)}`);
      }
    }
  }
  return conflicts;
}
