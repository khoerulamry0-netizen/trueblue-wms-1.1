import { branchId, buildSeedDocuments, operators } from './local-seed-data.mjs';

class SeedPreflightError extends Error {}

class SeedOperationError extends Error {}

function permissionDiagnostic(error) {
  if (error?.code !== '42501' || typeof error.message !== 'string') return null;
  const knownMessages = {
    'permission denied for schema wms_private': 'schema wms_private',
    'permission denied for table wms_documents': 'table wms_documents (schema not reported)',
    'permission denied for table profiles': 'table profiles (schema not reported)',
    'permission denied for table stock_movements': 'table stock_movements (schema not reported)',
    'permission denied for table activity_events': 'table activity_events (schema not reported)',
    'permission denied for sequence document_revision_seq': 'sequence document_revision_seq (schema not reported)',
    'permission denied for sequence stock_movements_id_seq': 'sequence stock_movements_id_seq (schema not reported)',
    'permission denied for sequence activity_events_id_seq': 'sequence activity_events_id_seq (schema not reported)',
    'permission denied for function order_deducted': 'function order_deducted (schema not reported)',
    'new row violates row-level security policy for table "wms_documents"': 'row-level security on table wms_documents (schema not reported)',
    'new row violates row-level security policy for table "stock_movements"': 'row-level security on table stock_movements (schema not reported)',
    'new row violates row-level security policy for table "activity_events"': 'row-level security on table activity_events (schema not reported)',
  };
  return Object.hasOwn(knownMessages, error.message) ? knownMessages[error.message] : null;
}

function seedFailure(label, result) {
  const categories = {
    '42501': 'insufficient privilege',
    '23502': 'not-null constraint',
    '23503': 'foreign-key constraint',
    '23505': 'unique constraint',
    '23514': 'check constraint',
    '22P02': 'invalid input',
    'PGRST204': 'schema cache column',
    'PGRST301': 'JWT validation',
    'PGRST302': 'missing JWT',
  };
  const code = Object.hasOwn(categories, result.error?.code) ? result.error.code : null;
  const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : 'unavailable';
  const permission = permissionDiagnostic(result.error);
  return new SeedOperationError(`${label} failed (category: ${code ? categories[code] : 'unclassified'}; code: ${code ?? 'withheld'}; HTTP status: ${status}${permission ? `; reported object/category: ${permission}` : ''}). Details withheld.`);
}

export async function runSeed(store, passwords, now) {
  const documents = buildSeedDocuments(now);
  const created = [];
  let pending = 'preflight (no writes attempted)';
  const write = async (label, action) => {
    pending = label;
    const result = await action();
    created.push(label);
    pending = 'none';
    return result;
  };
  try {
    if (passwords.length !== operators.length || passwords.some((password) => !password || password.length < 12) ||
        new Set(passwords).size !== passwords.length) {
      throw new SeedPreflightError('Provide two distinct local operator passwords of at least 12 characters.');
    }
    const collisions = await store.findCollisions(branchId, operators, documents);
    if (collisions.length) throw new SeedPreflightError(`Fixture collision: ${collisions.join(', ')}. No writes attempted.`);
    await write(`branch ${branchId}`, () => store.createBranch(branchId));
    for (const [index, operator] of operators.entries()) {
      const user = await write(`Auth user and automatic Viewer profile ${operator.email}`, () => store.createUser(operator, passwords[index]));
      await write(`operator profile ${operator.email} (${user.id})`, () => store.assignProfile(user, operator, branchId));
    }
    await write('402 WMS fixture documents (2 warehouses, 100 catalog, 200 stock, 100 orders)', () => store.insertDocuments(documents));
    return created;
  } catch (error) {
    const safeMessage = error instanceof SeedPreflightError || error instanceof SeedOperationError
      ? error.message : 'A local seed operation failed; do not retry before investigating.';
    throw new Error(`${safeMessage}\nConfirmed completed: ${created.length ? created.join('; ') : 'none'}.\n` +
      `Operation requiring inspection (may have committed despite an error): ${pending}.`);
  }
}

export async function recoverSeedDocuments(store, now) {
  const documents = buildSeedDocuments(now);
  try {
    await store.verifyRecoveryState(branchId, operators);
  } catch (error) {
    if (error instanceof SeedPreflightError || error instanceof SeedOperationError) throw error;
    throw new Error('Recovery preflight failed; no document insert attempted. Details withheld.');
  }
  try {
    await store.insertDocuments(documents);
    await store.verifyRecoveryDocuments(branchId, documents);
  } catch (error) {
    const detail = error instanceof SeedOperationError ? ` ${error.message}` : '';
    throw new Error(`Document recovery failed or verification is incomplete.${detail} The insert may have committed; inspect local state before retrying.`);
  }
}

export function createSeedStore(supabase) {
  const ensure = (result, label) => {
    if (result.error) throw seedFailure(label, result);
    return result.data;
  };
  return {
    async verifyRecoveryState(branch, users) {
      const branchRow = ensure(await supabase.from('branches').select('id').eq('id', branch).maybeSingle(), 'Recovery branch lookup');
      if (!branchRow || branchRow.id !== branch) throw new SeedPreflightError('Recovery requires the existing DEV_LOCAL branch; no writes attempted.');
      const admins = ensure(await supabase.from('profiles').select('id').eq('role', 'Administrator')
        .eq('is_active', true).eq('branch_id', 'CENTER').limit(1), 'Recovery administrator lookup');
      if (!admins.length) throw new SeedPreflightError('Recovery requires an active CENTER administrator; no writes attempted.');
      const matches = [];
      for (let page = 1; ; page++) {
        const data = ensure(await supabase.auth.admin.listUsers({ page, perPage: 1000 }), 'Recovery Auth lookup');
        matches.push(...data.users.filter((user) => users.some((operator) => operator.email === user.email?.toLowerCase())));
        if (data.users.length < 1000) break;
      }
      for (const operator of users) {
        const found = matches.filter((user) => user.email?.toLowerCase() === operator.email);
        const profiles = ensure(await supabase.from('profiles').select('id,email,role,is_active,branch_id')
          .ilike('email', operator.email).limit(2), 'Recovery profile lookup');
        const profile = profiles[0];
        if (found.length !== 1 || !found[0].id || profiles.length !== 1 || profile.id !== found[0].id ||
            profile.email?.toLowerCase() !== operator.email || profile.role !== operator.role ||
            profile.is_active !== true || profile.branch_id !== branch) {
          throw new SeedPreflightError('Recovery operator identity or profile mismatch; no writes attempted.');
        }
      }
      const existing = ensure(await supabase.from('wms_documents').select('document_id').eq('branch_id', branch).limit(1), 'Recovery document lookup');
      const movements = ensure(await supabase.from('stock_movements').select('id').eq('branch_id', branch).limit(1), 'Recovery stock history lookup');
      const events = ensure(await supabase.from('activity_events').select('id').eq('branch_id', branch)
        .in('entity_type', ['warehouses', 'catalog', 'stock', 'orders']).limit(1), 'Recovery activity history lookup');
      if (existing.length || movements.length || events.length) {
        throw new SeedPreflightError('Recovery found existing branch documents or operational history; no writes attempted.');
      }
    },
    async verifyRecoveryDocuments(branch, docs) {
      for (const collection of [...new Set(docs.map((doc) => doc.collection_name))]) {
        const ids = docs.filter((doc) => doc.collection_name === collection).map((doc) => doc.document_id);
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = ids.slice(offset, offset + 100);
          const rows = ensure(await supabase.from('wms_documents').select('document_id')
            .eq('branch_id', branch).eq('collection_name', collection).in('document_id', batch), 'Recovery verification');
          const found = new Set(rows.map((row) => row.document_id));
          if (batch.some((id) => !found.has(id))) throw new Error('Recovery verification incomplete.');
        }
      }
    },
    async findCollisions(branch, users, docs) {
      const collisions = [];
      const admins = ensure(await supabase.from('profiles').select('id').eq('role', 'Administrator')
        .eq('is_active', true).eq('branch_id', 'CENTER').limit(1), 'Administrator lookup');
      if (!admins.length) throw new SeedPreflightError('An active CENTER administrator is required before seeding. No writes attempted.');
      const existingBranch = ensure(await supabase.from('branches').select('id').eq('id', branch).maybeSingle(), 'Branch lookup');
      if (existingBranch) collisions.push(`branch ${branch}`);
      const emails = users.map((operator) => operator.email);
      for (const email of emails) {
        const profiles = ensure(await supabase.from('profiles').select('email').ilike('email', email).limit(1), 'Profile lookup');
        if (profiles.length) collisions.push('operator profile email');
      }
      for (let page = 1; ; page++) {
        const data = ensure(await supabase.auth.admin.listUsers({ page, perPage: 1000 }), 'Auth lookup');
        if (data.users.some((user) => emails.includes(user.email?.toLowerCase()))) collisions.push('operator Auth email');
        if (data.users.length < 1000) break;
      }
      for (const collection of [...new Set(docs.map((doc) => doc.collection_name))]) {
        const ids = docs.filter((doc) => doc.collection_name === collection).map((doc) => doc.document_id);
        for (let offset = 0; offset < ids.length; offset += 100) {
          const found = ensure(await supabase.from('wms_documents').select('document_id')
            .eq('branch_id', branch).eq('collection_name', collection).in('document_id', ids.slice(offset, offset + 100)), 'Document lookup');
          if (found.length) collisions.push(`${collection} document ID`);
        }
      }
      return [...new Set(collisions)];
    },
    async createBranch(id) {
      ensure(await supabase.from('branches').insert({ id, name: 'Local Development', sender_name: 'Local Sender', sender_phone: '00000000' }), 'Branch insert');
    },
    async createUser(operator, password) {
      const data = ensure(await supabase.auth.admin.createUser({
        email: operator.email, password, email_confirm: true, user_metadata: { full_name: operator.fullName },
      }), 'Auth user creation');
      if (!data.user?.id || data.user.email?.toLowerCase() !== operator.email) throw new Error('Auth user identity is missing.');
      return data.user;
    },
    async assignProfile(user, operator, branch) {
      const profile = ensure(await supabase.from('profiles')
        .update({ full_name: operator.fullName, role: operator.role, is_active: true, branch_id: branch })
        .eq('id', user.id).eq('email', operator.email).eq('role', 'Viewer')
        .eq('is_active', false).eq('branch_id', 'CENTER').select('id').maybeSingle(), 'Profile assignment');
      if (!profile) throw new Error('New user profile missing or changed concurrently.');
    },
    async insertDocuments(documents) {
      ensure(await supabase.from('wms_documents').insert(documents), 'Document insert');
    },
  };
}
