import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const allowedRoles = new Set(['Admin', 'Administrator', 'Picker', 'Packer', 'Shipping', 'Viewer']);

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed' });

  const authorization = request.headers.get('Authorization');
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!authorization || !url || !anonKey || !serviceRoleKey) {
    return response(401, { error: 'Sesi atau konfigurasi Supabase tidak tersedia.' });
  }

  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return response(401, { error: 'Sesi masuk tidak valid.' });

  const serviceClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: actor, error: actorError } = await serviceClient
    .from('profiles')
    .select('role,is_active,branch_id,full_name')
    .eq('id', authData.user.id)
    .maybeSingle();
  if (actorError || !actor || !actor.is_active || !['Admin', 'Administrator'].includes(actor.role)) {
    return response(403, { error: 'Hanya admin WMS yang dapat mengelola akun.' });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return response(400, { error: 'Format permintaan tidak valid.' });
  }

  const branchId = typeof body.branchId === 'string' ? body.branchId.trim() : actor.branch_id;
  const { data: branch } = await serviceClient.from('branches').select('id').eq('id', branchId).maybeSingle();
  if (!branch || (actor.role !== 'Administrator' && branchId !== actor.branch_id)) return response(403, { error: 'Akses cabang ditolak.' });
  if (actor.role !== 'Administrator' && body.role === 'Administrator') return response(403, { error: 'Hanya kantor pusat dapat memberikan akses Administrator.' });
  const auditAccount = async (action: string, userId: string, details: Record<string, unknown>) => {
    await serviceClient.from('activity_events').insert({ branch_id: branchId, entity_type: 'accounts', entity_id: userId, action,
      actor_id: authData.user.id, actor_name: actor.full_name || authData.user.email || 'Admin',
      after_data: details, reason: 'Pengelolaan akun oleh admin' });
  };
  const action = body.action;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const role = typeof body.role === 'string' ? body.role : '';
  const targetId = typeof body.userId === 'string' ? body.userId : '';

  if (action === 'create') {
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) || password.length < 8 || password.length > 128 || !fullName || fullName.length > 120 || !allowedRoles.has(role)) {
      return response(400, { error: 'ID, password (minimal 8 karakter), nama, atau peran tidak valid.' });
    }
    // Internal Auth identifier only; no mailbox or email delivery is required.
    const accountEmail = username + '@operators.blues.invalid';
    const { data, error } = await serviceClient.auth.admin.createUser({
      email: accountEmail, password, email_confirm: true,
      user_metadata: { full_name: fullName }
    });
    if (error || !data.user) return response(400, { error: 'ID sudah terdaftar atau akun tidak dapat dibuat.' });
    const { error: profileError } = await serviceClient.from('profiles')
      .update({ email: accountEmail, full_name: fullName, role, branch_id: branchId, is_active: true }).eq('id', data.user.id);
    if (profileError) {
      await serviceClient.auth.admin.deleteUser(data.user.id);
      return response(500, { error: 'Profil gagal disimpan. Silakan coba lagi.' });
    }
    await auditAccount('ACCOUNT_CREATE',data.user.id,{username,fullName,role,branch_id:branchId});
    return response(200, { success: true, userId: data.user.id, username });
  }

  if (action === 'invite') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName || fullName.length > 120 || !allowedRoles.has(role)) {
      return response(400, { error: 'Email, nama, atau peran tidak valid.' });
    }
    const { data, error } = await serviceClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName }
    });
    if (error || !data.user) return response(400, { error: error?.message ?? 'Undangan tidak dapat dibuat.' });
    const { error: profileError } = await serviceClient
      .from('profiles')
      .update({ email, full_name: fullName, role, branch_id: branchId, is_active: true })
      .eq('id', data.user.id);
    if (profileError) return response(500, { error: 'Akun dibuat, tetapi profil belum dapat disimpan.' });
    await auditAccount('ACCOUNT_CREATE',data.user.id,{email,fullName,role,branch_id:branchId});
    return response(200, { success: true, userId: data.user.id, email });
  }

  if (action === 'update') {
    if (!targetId || !fullName || fullName.length > 120 || !allowedRoles.has(role)) {
      return response(400, { error: 'Profil atau peran tidak valid.' });
    }
    const { data: target } = await serviceClient.from('profiles').select('role,is_active,branch_id').eq('id', targetId).maybeSingle();
    if (!target) return response(404, { error: 'Akun tidak ditemukan.' });
    if (actor.role !== 'Administrator' && (target.branch_id !== actor.branch_id || target.role === 'Administrator')) return response(403, { error: 'Akses akun ditolak.' });
    if (target.is_active && target.role === 'Administrator' && role !== 'Administrator') {
      const { count } = await serviceClient
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'Administrator')
        .eq('is_active', true);
      if ((count ?? 0) <= 1) return response(409, { error: 'Admin terakhir tidak dapat diturunkan perannya.' });
    }
    const { error } = await serviceClient
      .from('profiles')
      .update({ full_name: fullName, role, branch_id: branchId })
      .eq('id', targetId);
    if (error) return response(400, { error: error.message });
    await auditAccount('ACCOUNT_UPDATE',targetId,{fullName,role,branch_id:branchId});
    return response(200, { success: true });
  }

  if (action === 'delete') {
    if (!targetId || targetId === authData.user.id) return response(400, { error: 'Akun aktif tidak dapat menghapus dirinya sendiri.' });
    const { data: target } = await serviceClient.from('profiles').select('role,is_active,branch_id').eq('id', targetId).maybeSingle();
    if (!target) return response(404, { error: 'Akun tidak ditemukan.' });
    if (actor.role !== 'Administrator' && (target.branch_id !== actor.branch_id || target.role === 'Administrator')) return response(403, { error: 'Akses akun ditolak.' });
    if (target.is_active && target.role === 'Administrator') {
      const { count } = await serviceClient
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'Administrator')
        .eq('is_active', true);
      if ((count ?? 0) <= 1) return response(409, { error: 'Admin terakhir tidak dapat dihapus.' });
    }
    const { error } = await serviceClient.auth.admin.deleteUser(targetId);
    if (error) return response(400, { error: error.message });
    await auditAccount('ACCOUNT_DELETE',targetId,{userId:targetId});
    return response(200, { success: true });
  }

  return response(400, { error: 'Aksi tidak dikenal.' });
});
