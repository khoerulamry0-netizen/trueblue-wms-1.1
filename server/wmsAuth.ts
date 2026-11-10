import { createClient } from '@supabase/supabase-js';

export async function verifyWmsUser(token: string | undefined, url: string | undefined, key: string | undefined, fetcher: typeof fetch = fetch) {
  if (!token || !url || !key) return { status: 401 as const };
  const client = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` }, fetch: fetcher },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return { status: 401 as const };
  // getUser(token) does not set the session for subsequent RLS-protected queries.
  // The same verified bearer token must therefore be forwarded above.
  const { data: profile, error: profileError } = await client.from('profiles')
    .select('is_active').eq('id', data.user.id).maybeSingle();
  if (profileError) return { status: 503 as const };
  if (!profile?.is_active) return { status: 403 as const };
  return { status: 200 as const, userId: data.user.id };
}
