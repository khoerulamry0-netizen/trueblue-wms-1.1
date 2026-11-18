import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const COMPANY_ID = 'DEFAULT';
const SHOPEE_HOST = Deno.env.get('SHOPEE_API_HOST') || 'https://partner.shopeemobile.com';
const AUTH_PATH = '/api/v2/shop/auth_partner';
const TOKEN_PATH = '/api/v2/auth/token/get';
const REFRESH_PATH = '/api/v2/auth/access_token/get';

function requiredSecret(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Secret ${name} belum dipasang di Supabase Edge Function.`);
  return value;
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sign(path: string, timestamp: number) {
  const partnerId = requiredSecret('SHOPEE_PARTNER_ID');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(requiredSecret('SHOPEE_PARTNER_KEY')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${partnerId}${path}${timestamp}`)));
}

async function signedUrl(path: string, extra: Record<string, string | number>) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ partner_id: requiredSecret('SHOPEE_PARTNER_ID'), timestamp: String(timestamp), sign: await sign(path, timestamp) });
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return `${SHOPEE_HOST}${path}?${params.toString()}`;
}

function serviceClient() {
  const url = requiredSecret('SUPABASE_URL');
  return createClient(url, requiredSecret('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } });
}

async function actorFromRequest(request: Request) {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return { error: json({ error: 'Sesi masuk tidak tersedia.' }, 401) } as const;
  const url = requiredSecret('SUPABASE_URL');
  const anon = createClient(url, requiredSecret('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: authorization } } });
  const { data, error } = await anon.auth.getUser();
  if (error || !data.user) return { error: json({ error: 'Sesi masuk tidak valid.' }, 401) } as const;
  const admin = serviceClient();
  const { data: actor } = await admin.from('profiles').select('role,is_active,branch_id,full_name').eq('id', data.user.id).maybeSingle();
  if (!actor?.is_active || !['Admin', 'Administrator'].includes(actor.role)) return { error: json({ error: 'Hanya admin WMS yang dapat mengelola Shopee Live.' }, 403) } as const;
  return { admin, actor, userId: data.user.id } as const;
}

async function tokenRequest(path: string, body: Record<string, unknown>) {
  const timestamp = Math.floor(Date.now() / 1000);
  const url = `${SHOPEE_HOST}${path}?${new URLSearchParams({ partner_id: requiredSecret('SHOPEE_PARTNER_ID'), timestamp: String(timestamp), sign: await sign(path, timestamp) })}`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.message || payload.error || 'Shopee menolak otorisasi.');
  return payload as Record<string, unknown>;
}

async function refreshIfNeeded(admin: ReturnType<typeof serviceClient>, storeId: string, credential: Record<string, unknown>) {
  const expiresAt = new Date(String(credential.access_token_expires_at)).getTime();
  if (expiresAt > Date.now() + 5 * 60 * 1000) return credential;
  const refreshed = await tokenRequest(REFRESH_PATH, { shop_id: credential.shop_id, refresh_token: credential.refresh_token });
  const next = { ...credential, access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || credential.refresh_token, access_token_expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() };
  await admin.from('marketplace_shopee_credentials').update({ access_token: next.access_token, refresh_token: next.refresh_token, access_token_expires_at: next.access_token_expires_at, updated_at: new Date().toISOString() }).eq('store_id', storeId);
  return next;
}

async function shopeeGet(path: string, credential: Record<string, unknown>, query: Record<string, string | number>) {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(requiredSecret('SHOPEE_PARTNER_KEY')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const partnerId = requiredSecret('SHOPEE_PARTNER_ID');
  const base = `${partnerId}${path}${timestamp}${credential.access_token}${credential.shop_id}`;
  const signature = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)));
  const params = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign: signature, access_token: String(credential.access_token), shop_id: String(credential.shop_id) });
  for (const [name, value] of Object.entries(query)) params.set(name, String(value));
  const response = await fetch(`${SHOPEE_HOST}${path}?${params.toString()}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.message || payload.error || 'Sinkronisasi Shopee gagal.');
  return payload as Record<string, unknown>;
}

async function callback(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const shopId = Number(url.searchParams.get('shop_id') || 0);
  const admin = serviceClient();
  const { data: pending } = await admin.from('marketplace_shopee_oauth_states').select('*').eq('state', state).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (!pending || !code || !Number.isSafeInteger(shopId) || shopId <= 0) return new Response('<h1>Otorisasi Shopee gagal</h1><p>Link tidak valid atau sudah kedaluwarsa. Tutup halaman ini dan mulai lagi dari WMS.</p>', { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  try {
    const token = await tokenRequest(TOKEN_PATH, { code, shop_id: shopId });
    const { data: store, error: storeError } = await admin.from('marketplace_stores').insert({ company_id: pending.company_id, marketplace: 'SHOPEE', store_key: `SHOPEE-LIVE-${shopId}`, store_name: pending.store_name, mode: 'LIVE', connection_status: 'CONNECTED', external_shop_id: shopId, live_authorized_at: new Date().toISOString(), created_by: pending.created_by }).select('id').single();
    if (storeError || !store) throw new Error('Toko Shopee gagal dibuat di WMS.');
    const { error: credentialError } = await admin.from('marketplace_shopee_credentials').insert({ store_id: store.id, shop_id: shopId, access_token: token.access_token, refresh_token: token.refresh_token, access_token_expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(), refresh_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() });
    if (credentialError) throw new Error('Token Shopee gagal disimpan di server.');
    await admin.from('marketplace_shopee_oauth_states').delete().eq('state', state);
    const appUrl = Deno.env.get('WMS_APP_URL') || new URL('/', pending.redirect_uri).origin;
    return new Response(`<script>window.location.replace(${JSON.stringify(`${appUrl}/?marketplace=connected`)});</script><p>Shopee berhasil terhubung. Kembali ke WMS…</p>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (error) {
    await admin.from('marketplace_shopee_oauth_states').delete().eq('state', state);
    return new Response(`<h1>Otorisasi Shopee gagal</h1><p>${String(error instanceof Error ? error.message : 'Kesalahan server').replace(/[<>&]/g, '')}</p>`, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method === 'GET') return callback(request);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'Format permintaan tidak valid.' }, 400); }
  const session = await actorFromRequest(request);
  if ('error' in session) return session.error;
  const { admin, userId } = session;
  const action = String(body.action || '');
  try {
    if (action === 'authorize') {
      const redirectUri = requiredSecret('SHOPEE_REDIRECT_URI');
      const state = crypto.randomUUID();
      const storeName = typeof body.storeName === 'string' && body.storeName.trim() ? body.storeName.trim().slice(0, 160) : 'Shopee Live';
      await admin.from('marketplace_shopee_oauth_states').insert({ state, company_id: COMPANY_ID, store_name: storeName, created_by: userId, redirect_uri: redirectUri, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
      return json({ authorizationUrl: await signedUrl(AUTH_PATH, { redirect: redirectUri, state }) });
    }
    if (action === 'status') {
      const { data, error } = await admin.from('marketplace_stores').select('id,store_name,store_key,connection_status,external_shop_id,last_synced_at,last_error').eq('company_id', COMPANY_ID).eq('mode', 'LIVE').order('created_at');
      if (error) throw error;
      return json({ stores: data || [], configured: Boolean(Deno.env.get('SHOPEE_PARTNER_ID') && Deno.env.get('SHOPEE_PARTNER_KEY') && Deno.env.get('SHOPEE_REDIRECT_URI')) });
    }
    if (action === 'sync') {
      const storeId = typeof body.storeId === 'string' ? body.storeId : '';
      const { data: store } = await admin.from('marketplace_stores').select('id,external_shop_id,connection_status').eq('id', storeId).eq('mode', 'LIVE').maybeSingle();
      if (!store?.external_shop_id || store.connection_status !== 'CONNECTED') return json({ error: 'Toko Shopee Live belum terhubung.' }, 409);
      const { data: credential } = await admin.from('marketplace_shopee_credentials').select('*').eq('store_id', store.id).maybeSingle();
      if (!credential) return json({ error: 'Kredensial toko tidak ditemukan di server.' }, 409);
      const current = await refreshIfNeeded(admin, store.id, credential);
      const payload = await shopeeGet('/api/v2/order/get_order_list', current, { time_range_field: 'create_time', time_from: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60, time_to: Math.floor(Date.now() / 1000), page_size: 100, cursor: '' });
      const orderSnList = (Array.isArray(payload.order_list) ? payload.order_list : []).map((row: Record<string, unknown>) => String(row.order_sn || '')).filter(Boolean);
      const { data: mappings } = await admin.from('marketplace_sku_mappings').select('external_sku,external_variant').eq('store_id', store.id);
      const mappedKeys = new Set((mappings || []).map(row => `${String(row.external_sku).trim().toUpperCase()}|${String(row.external_variant || '').trim().toUpperCase()}`));
      let newCount = 0;
      let existingCount = 0;
      for (const orderSn of orderSnList.slice(0, 100)) {
        const detail = await shopeeGet('/api/v2/order/get_order_detail', current, { order_sn: orderSn, response_optional_fields: 'item_list' });
        const order = (Array.isArray(detail.order_list) ? detail.order_list[0] : detail) as Record<string, unknown>;
        const items = (Array.isArray(order?.item_list) ? order.item_list : []).map((item: Record<string, unknown>) => {
          const externalSku = String(item.item_sku || item.model_sku || item.item_id || '').trim();
          const variant = String(item.model_name || item.model_sku || '').trim() || 'Default';
          return { external_sku: externalSku, variant, qty: Number(item.model_quantity_purchased || item.quantity_purchased || 1) };
        }).filter(item => item.external_sku && Number.isFinite(item.qty) && item.qty > 0);
        if (!items.length) continue;
        const ready = items.every(item => mappedKeys.has(`${item.external_sku.toUpperCase()}|${item.variant.toUpperCase()}`));
        const { error: insertError } = await admin.from('marketplace_orders').insert({ company_id: COMPANY_ID, store_id: store.id, marketplace: 'SHOPEE', external_order_id: orderSn, order_payload: { source: 'SHOPEE_LIVE', items }, status: ready ? 'SIAP_DITINJAU' : 'PERLU_MAPPING' });
        if (insertError?.code === '23505') existingCount++;
        else if (insertError) throw insertError;
        else newCount++;
      }
      const finished = new Date().toISOString();
      await admin.from('marketplace_stores').update({ last_synced_at: finished, last_error: null }).eq('id', store.id);
      await admin.from('marketplace_sync_runs').insert({ company_id: COMPANY_ID, store_id: store.id, started_at: new Date(Date.now() - 1000).toISOString(), finished_at: finished, new_order_count: newCount, existing_order_count: existingCount, created_by: userId });
      return json({ success: true, storeId: store.id, orderCount: orderSnList.length, newCount, existingCount, note: 'Order Live masuk ke antrean marketplace untuk mapping/review. Tidak dibuat menjadi order WMS dan tidak mengubah stok.' });
    }
    return json({ error: 'Aksi Shopee Live tidak dikenal.' }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Shopee Live gagal diproses.' }, 400);
  }
});
