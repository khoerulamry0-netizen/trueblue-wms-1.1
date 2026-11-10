import { randomUUID } from 'node:crypto';

const authCodes = new Set([
  'signup_disabled', 'email_address_invalid', 'email_address_not_authorized', 'user_already_exists',
  'weak_password', 'validation_failed', 'over_request_rate_limit', 'over_email_send_rate_limit',
  'email_not_confirmed', 'request_timeout', 'unexpected_failure',
]);

function authFailure(stage, error) {
  const code = authCodes.has(error?.code) ? error.code : 'unrecognized';
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? String(error.status) : 'unavailable';
  return new Error(`Local admin ${stage} failed (category: ${code}; HTTP status: ${status}). Details withheld; inspect local Auth state before retrying.`);
}

export async function bootstrapLocalAdmin(authClient, createAdminClient, email, password) {
  if (typeof email !== 'string' || !/^[a-z0-9][a-z0-9._+-]*@example\.(?:invalid|com|net|org)$/.test(email)) {
    throw new Error('Use a new dummy administrator email at a reserved example domain.');
  }
  const marker = randomUUID();
  let signup;
  try {
    signup = await authClient.auth.signUp({ email, password, options: { data: { wms_local_bootstrap_nonce: marker } } });
  } catch (error) {
    throw authFailure('signup', error);
  }
  if (signup.error) throw authFailure('signup', signup.error);
  const session = signup.data?.session;
  const newUser = signup.data?.user;
  if (!session) {
    throw new Error('Local admin signup returned no session (category: confirmation required or existing account). No promotion attempted; inspect local Auth and profile state before using a new dummy email.');
  }
  let verification;
  try {
    verification = await authClient.auth.getUser(session.access_token);
  } catch (error) {
    throw authFailure('identity verification', error);
  }
  if (verification.error) throw authFailure('identity verification', verification.error);
  const verified = verification.data?.user;
  if (!verified?.id || verified.id !== newUser?.id || verified.id !== session.user?.id ||
      verified.email?.toLowerCase() !== email || verified.user_metadata?.wms_local_bootstrap_nonce !== marker ||
      !Array.isArray(newUser.identities) || newUser.identities.length === 0) {
    throw new Error('Could not verify the authenticated local administrator identity.');
  }

  let existing;
  let adminClient;
  try {
    adminClient = createAdminClient();
    const result = await adminClient.from('profiles')
      .select('id,email,role,is_active,branch_id').eq('id', verified.id).maybeSingle();
    if (result.error) throw new Error('profile read failed');
    existing = result.data;
  } catch {
    throw new Error('Verified local profile lookup failed; promotion was not attempted.');
  }
  if (!existing || existing.id !== verified.id || existing.email?.toLowerCase() !== email) {
    throw new Error('Verified local user has no matching readable profile; promotion was not attempted.');
  }
  if (existing.role !== 'Viewer' || existing.is_active !== false || existing.branch_id !== 'CENTER') {
    throw new Error('New local user profile is not the expected inactive CENTER Viewer; promotion was not attempted.');
  }
  let result;
  try {
    result = await adminClient.from('profiles')
      .update({ role: 'Administrator', is_active: true, branch_id: 'CENTER' })
      .eq('id', existing.id).eq('email', existing.email).eq('role', existing.role)
      .eq('is_active', existing.is_active).eq('branch_id', existing.branch_id)
      .select('id,role,is_active,branch_id').maybeSingle();
  } catch {
    throw new Error('Administrator promotion failed or its outcome is uncertain. Inspect the local profile before retrying.');
  }
  const profile = result.data;
  if (result.error || !profile || profile.id !== verified.id || profile.role !== 'Administrator' || !profile.is_active || profile.branch_id !== 'CENTER') {
    throw new Error('Administrator promotion failed or the profile changed concurrently. Inspect the local profile before retrying.');
  }
}
