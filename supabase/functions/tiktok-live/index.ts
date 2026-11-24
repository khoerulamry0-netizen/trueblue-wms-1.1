import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const COMPANY_ID = 'DEFAULT';
const TIKTOK_AUTH_HOST = Deno.env.get('TIKTOK_AUTH_HOST') || 'https://auth.tiktok-shops.com';
const TIKTOK_API_HOST = Deno.env.get('TIKTOK_API_HOST') || 'https://open-api.tiktokglobalshop.com';

function requiredSecret(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Secret ${name} belum dipasang di Supabase Edge Function.`);
  return value;
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signTikTokRequest(
  path: string,
  params: Record<string, string>,
  bodyStr = ''
) {
  const secret = requiredSecret('TIKTOK_APP_SECRET');
  const sortedKeys = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort();
  const paramStr = sortedKeys.map(k => `${k}${params[k]}`).join('');
  const signBase = `${secret}${path}${paramStr}${bodyStr}${secret}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signBase)));
}

function serviceClient() {
  const url = requiredSecret('SUPABASE_URL');
  return createClient(url, requiredSecret('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function actorFromRequest(request: Request) {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return { error: json({ error: 'Sesi masuk tidak tersedia.' }, 401) } as const;
  const url = requiredSecret('SUPABASE_URL');
  const anon = createClient(url, requiredSecret('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await anon.auth.getUser();
  if (error || !data.user) return { error: json({ error: 'Sesi masuk tidak valid.' }, 401) } as const;
  const admin = serviceClient();
  const { data: actor } = await admin
    .from('profiles')
    .select('role,is_active,branch_id,full_name')
    .eq('id', data.user.id)
    .maybeSingle();
  if (!actor?.is_active || !['Admin', 'Administrator'].includes(actor.role)) {
    return { error: json({ error: 'Hanya admin WMS yang dapat mengelola TikTok Shop Live.' }, 403) } as const;
  }
  return { admin, actor, userId: data.user.id } as const;
}

async function exchangeAuthCode(code: string) {
  const appKey = requiredSecret('TIKTOK_APP_KEY');
  const appSecret = requiredSecret('TIKTOK_APP_SECRET');
  const params = new URLSearchParams({
    app_key: appKey,
    app_secret: appSecret,
    auth_code: code,
    grant_type: 'authorized_code',
  });
  const response = await fetch(`${TIKTOK_AUTH_HOST}/api/v2/token/get?${params.toString()}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0 || !payload.data?.access_token) {
    throw new Error(payload.message || 'TikTok Shop menolak pertukaran token OAuth.');
  }
  return payload.data as Record<string, unknown>;
}

async function refreshTokenIfNeeded(
  admin: ReturnType<typeof serviceClient>,
  storeId: string,
  credential: Record<string, unknown>
) {
  const expiresAt = new Date(String(credential.access_token_expires_at)).getTime();
  if (expiresAt > Date.now() + 5 * 60 * 1000) return credential;

  const params = new URLSearchParams({
    app_key: requiredSecret('TIKTOK_APP_KEY'),
    app_secret: requiredSecret('TIKTOK_APP_SECRET'),
    refresh_token: String(credential.refresh_token),
    grant_type: 'refresh_token',
  });
  const response = await fetch(`${TIKTOK_AUTH_HOST}/api/v2/token/refresh?${params.toString()}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0 || !payload.data?.access_token) {
    throw new Error(payload.message || 'Gagal memperbarui token TikTok Shop.');
  }
  const data = payload.data as Record<string, unknown>;
  const accessExpSec = Number(data.access_token_expire_in || Math.floor(Date.now() / 1000) + 4 * 60 * 60);
  const next = {
    ...credential,
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token || credential.refresh_token),
    access_token_expires_at: new Date(accessExpSec * 1000).toISOString(),
  };
  await admin
    .from('marketplace_tiktok_credentials')
    .update({
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      access_token_expires_at: next.access_token_expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('store_id', storeId);
  return next;
}

async function tiktokApiCall(
  method: 'GET' | 'POST',
  path: string,
  accessToken: string,
  query: Record<string, string> = {},
  body?: Record<string, unknown>
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params: Record<string, string> = {
    app_key: requiredSecret('TIKTOK_APP_KEY'),
    timestamp,
    ...query,
  };
  const bodyStr = method === 'POST' && body ? JSON.stringify(body) : '';
  const sign = await signTikTokRequest(path, params, bodyStr);
  const urlParams = new URLSearchParams({ ...params, sign });
  const response = await fetch(`${TIKTOK_API_HOST}${path}?${urlParams.toString()}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tts-access-token': accessToken,
    },
    ...(method === 'POST' ? { body: bodyStr } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    throw new Error(payload.message || 'Permintaan TikTok Shop API gagal.');
  }
  return (payload.data || payload) as Record<string, unknown>;
}

async function callback(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const admin = serviceClient();
  const { data: pending } = await admin
    .from('marketplace_tiktok_oauth_states')
    .select('*')
    .eq('state', state)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!pending || !code) {
    return new Response(
      '<h1>Otorisasi TikTok Shop gagal</h1><p>Link tidak valid atau sudah kedaluwarsa. Tutup halaman ini dan mulai lagi dari WMS.</p>',
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  try {
    const token = await exchangeAuthCode(code);
    const accessToken = String(token.access_token);
    const refreshToken = String(token.refresh_token || '');
    const accessExpSec = Number(token.access_token_expire_in || Math.floor(Date.now() / 1000) + 4 * 60 * 60);
    const refreshExpSec = Number(token.refresh_token_expire_in || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);

    // Fetch authorized shops so we get shop_id, shop_cipher, and official shop_name
    const shopsData = await tiktokApiCall('GET', '/authorization/202309/shops', accessToken);
    const shopList = Array.isArray(shopsData.shops) ? (shopsData.shops as Record<string, unknown>[]) : [];
    const primaryShop = shopList[0] || {};
    const shopId = String(primaryShop.id || token.open_id || crypto.randomUUID());
    const shopCipher = String(primaryShop.cipher || '');
    const resolvedName =
      String(primaryShop.name || '').trim() ||
      pending.store_name ||
      `TikTok Shop ${shopId}`;

    const storeKey = `TIKTOK-LIVE-${shopId}`;
    const { data: existingStore } = await admin
      .from('marketplace_stores')
      .select('id')
      .eq('company_id', pending.company_id)
      .eq('marketplace', 'TIKTOK')
      .eq('store_key', storeKey)
      .maybeSingle();

    let storeId = existingStore?.id as string | undefined;
    if (storeId) {
      await admin
        .from('marketplace_stores')
        .update({
          store_name: resolvedName,
          connection_status: 'CONNECTED',
          external_shop_code: shopId,
          external_shop_cipher: shopCipher,
          live_authorized_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', storeId);
    } else {
      const { data: inserted, error: insertError } = await admin
        .from('marketplace_stores')
        .insert({
          company_id: pending.company_id,
          marketplace: 'TIKTOK',
          store_key: storeKey,
          store_name: resolvedName,
          mode: 'LIVE',
          connection_status: 'CONNECTED',
          external_shop_code: shopId,
          external_shop_cipher: shopCipher,
          live_authorized_at: new Date().toISOString(),
          created_by: pending.created_by,
        })
        .select('id')
        .single();
      if (insertError || !inserted) throw new Error('Toko TikTok Shop gagal disimpan di WMS.');
      storeId = inserted.id;
    }

    const { error: credError } = await admin
      .from('marketplace_tiktok_credentials')
      .upsert(
        {
          store_id: storeId,
          shop_id: shopId,
          shop_cipher: shopCipher,
          access_token: accessToken,
          refresh_token: refreshToken,
          access_token_expires_at: new Date(accessExpSec * 1000).toISOString(),
          refresh_token_expires_at: new Date(refreshExpSec * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'store_id' }
      );
    if (credError) throw new Error('Token TikTok Shop gagal disimpan di server.');

    await admin.from('marketplace_tiktok_oauth_states').delete().eq('state', state);
    const appUrl = Deno.env.get('WMS_APP_URL') || new URL('/', pending.redirect_uri).origin;
    return new Response(
      `<script>window.location.replace(${JSON.stringify(`${appUrl}/?marketplace=connected&platform=tiktok`)});</script><p>TikTok Shop berhasil terhubung. Kembali ke WMS…</p>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  } catch (error) {
    await admin.from('marketplace_tiktok_oauth_states').delete().eq('state', state);
    return new Response(
      `<h1>Otorisasi TikTok Shop gagal</h1><p>${String(error instanceof Error ? error.message : 'Kesalahan server').replace(/[<>&]/g, '')}</p>`,
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method === 'GET') return callback(request);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Format permintaan tidak valid.' }, 400);
  }

  const session = await actorFromRequest(request);
  if ('error' in session) return session.error;
  const { admin, userId } = session;
  const action = String(body.action || '');

  try {
    if (action === 'authorize') {
      const redirectUri = requiredSecret('TIKTOK_REDIRECT_URI');
      const serviceId = Deno.env.get('TIKTOK_SERVICE_ID')?.trim();
      const appKey = requiredSecret('TIKTOK_APP_KEY');
      const state = crypto.randomUUID();
      const storeName =
        typeof body.storeName === 'string' && body.storeName.trim()
          ? body.storeName.trim().slice(0, 160)
          : 'TikTok Shop Live';

      await admin.from('marketplace_tiktok_oauth_states').insert({
        state,
        company_id: COMPANY_ID,
        store_name: storeName,
        created_by: userId,
        redirect_uri: redirectUri,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

      const authorizationUrl = serviceId
        ? `https://services.tiktokshop.com/open/authorize?${new URLSearchParams({ service_id: serviceId, state }).toString()}`
        : `${TIKTOK_AUTH_HOST}/oauth/authorize?${new URLSearchParams({ app_key: appKey, state }).toString()}`;

      return json({ authorizationUrl });
    }

    if (action === 'status') {
      const { data, error } = await admin
        .from('marketplace_stores')
        .select('id,store_name,store_key,connection_status,external_shop_code,last_synced_at,last_error')
        .eq('company_id', COMPANY_ID)
        .eq('marketplace', 'TIKTOK')
        .eq('mode', 'LIVE')
        .order('created_at');
      if (error) throw error;
      return json({
        stores: data || [],
        configured: Boolean(
          Deno.env.get('TIKTOK_APP_KEY') &&
            Deno.env.get('TIKTOK_APP_SECRET') &&
            Deno.env.get('TIKTOK_REDIRECT_URI')
        ),
      });
    }

    if (action === 'sync') {
      const storeId = typeof body.storeId === 'string' ? body.storeId : '';
      const { data: store } = await admin
        .from('marketplace_stores')
        .select('id,external_shop_code,external_shop_cipher,connection_status')
        .eq('id', storeId)
        .eq('marketplace', 'TIKTOK')
        .eq('mode', 'LIVE')
        .maybeSingle();
      if (!store || store.connection_status !== 'CONNECTED') {
        return json({ error: 'Toko TikTok Shop Live belum terhubung.' }, 409);
      }

      const { data: credential } = await admin
        .from('marketplace_tiktok_credentials')
        .select('*')
        .eq('store_id', store.id)
        .maybeSingle();
      if (!credential) {
        return json({ error: 'Kredensial TikTok Shop tidak ditemukan di server.' }, 409);
      }

      const current = await refreshTokenIfNeeded(admin, store.id, credential);
      const nowSec = Math.floor(Date.now() / 1000);
      const ordersResp = await tiktokApiCall(
        'POST',
        '/order/202309/orders/search',
        String(current.access_token),
        {
          page_size: '50',
          ...(current.shop_cipher ? { shop_cipher: String(current.shop_cipher) } : {}),
        },
        {
          create_time_ge: nowSec - 7 * 24 * 60 * 60,
          create_time_lt: nowSec,
        }
      );

      const rawOrders = Array.isArray(ordersResp.orders)
        ? (ordersResp.orders as Record<string, unknown>[])
        : [];
      const { data: mappings } = await admin
        .from('marketplace_sku_mappings')
        .select('external_sku,external_variant')
        .eq('store_id', store.id);
      const mappedKeys = new Set(
        (mappings || []).map(
          row =>
            `${String(row.external_sku).trim().toUpperCase()}|${String(row.external_variant || '').trim().toUpperCase()}`
        )
      );

      let newCount = 0;
      let existingCount = 0;

      for (const order of rawOrders) {
        const externalOrderId = String(order.id || '').trim();
        if (!externalOrderId) continue;
        const lineItems = Array.isArray(order.line_items)
          ? (order.line_items as Record<string, unknown>[])
          : [];
        const items = lineItems
          .map(li => ({
            external_sku: String(li.seller_sku || li.sku_id || li.product_id || '').trim(),
            variant: String(li.sku_name || '').trim() || 'Default',
            qty: Number(li.quantity || 1),
          }))
          .filter(it => it.external_sku && Number.isFinite(it.qty) && it.qty > 0);
        if (!items.length) continue;

        const ready = items.every(it =>
          mappedKeys.has(`${it.external_sku.toUpperCase()}|${it.variant.toUpperCase()}`)
        );
        const { error: insertError } = await admin.from('marketplace_orders').insert({
          company_id: COMPANY_ID,
          store_id: store.id,
          marketplace: 'TIKTOK',
          external_order_id: externalOrderId,
          order_payload: { source: 'TIKTOK_LIVE', items },
          status: ready ? 'SIAP_DITINJAU' : 'PERLU_MAPPING',
        });
        if (insertError?.code === '23505') existingCount++;
        else if (insertError) throw insertError;
        else newCount++;
      }

      const finished = new Date().toISOString();
      await admin
        .from('marketplace_stores')
        .update({ last_synced_at: finished, last_error: null })
        .eq('id', store.id);
      await admin.from('marketplace_sync_runs').insert({
        company_id: COMPANY_ID,
        store_id: store.id,
        started_at: new Date(Date.now() - 1000).toISOString(),
        finished_at: finished,
        new_order_count: newCount,
        existing_order_count: existingCount,
        created_by: userId,
      });

      return json({
        success: true,
        storeId: store.id,
        orderCount: rawOrders.length,
        newCount,
        existingCount,
      });
    }

    return json({ error: 'Aksi TikTok Shop Live tidak dikenal.' }, 400);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'TikTok Shop Live gagal diproses.' },
      400
    );
  }
});
