import '@supabase/functions-js/edge-runtime.d.ts';
import { withSupabase } from '@supabase/server';

type DriveConfig = { sharedDriveId: string; rootFolderId: string; maxFileMb: number; retentionDays: number; verifiedAt?: string; folderName?: string };
const json = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(value.trim());
const base64Url = (input: Uint8Array | string) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function driveCredentials() {
  const raw = Deno.env.get('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON');
  if (!raw) return null;
  const credentials = JSON.parse(raw);
  if (!credentials.client_email || !credentials.private_key) throw new Error('Secret service account tidak valid.');
  return credentials as { client_email: string; private_key: string };
}

async function driveToken(credentials: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const unsigned = `${header}.${claim}`;
  const pem = credentials.private_key.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const der = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64Url(new Uint8Array(signature))}` })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error('Autentikasi service account Google Drive gagal.');
  return result.access_token as string;
}

async function inspectFolder(token: string, folderId: string) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,driveId&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error('Folder Google Drive tidak dapat diakses oleh service account.');
  if (data.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Root Folder ID bukan folder Google Drive.');
  return data;
}

const safeFileName = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'return-video';
async function inspectUploadedFile(token: string, fileId: string) {
  const fields = 'id,name,mimeType,size,webViewLink,md5Checksum,createdTime,parents,appProperties,trashed';
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error('File video tidak ditemukan di Google Drive.');
  return data;
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, ctx) => {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const actorId = ctx.userClaims?.sub;
    if (!actorId) return json({ error: 'Sesi masuk tidak valid.' }, 401);
    const { data: actor } = await ctx.supabaseAdmin.from('profiles').select('role,is_active,branch_id,full_name').eq('id', actorId).maybeSingle();
    if (!actor?.is_active || !['Admin', 'Administrator'].includes(actor.role)) return json({ error: 'Hanya Administrator yang dapat mengatur Google Drive return.' }, 403);

    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return json({ error: 'Format permintaan tidak valid.' }, 400); }
    const branchId = typeof body.branchId === 'string' && body.branchId.trim() ? body.branchId.trim() : actor.branch_id;
    if (actor.role !== 'Administrator' && branchId !== actor.branch_id) return json({ error: 'Akses cabang ditolak.' }, 403);
    const documentId = 'RETURN_DRIVE_CONFIG';
    const loadConfig = async () => {
      const { data } = await ctx.supabaseAdmin.from('wms_documents').select('payload').eq('branch_id', branchId).eq('collection_name', 'settings').eq('document_id', documentId).maybeSingle();
      return (data?.payload || null) as DriveConfig | null;
    };
    const loadCase = async (caseId: string) => {
      const { data, error } = await ctx.supabaseAdmin.from('wms_documents').select('document_id,payload').eq('branch_id', branchId).eq('collection_name', 'returns').contains('payload', { caseId });
      if (error) throw new Error('Kasus return gagal dibaca.');
      if (!data?.length) throw new Error('Kasus return tidak ditemukan.');
      return data as Array<{document_id:string;payload:Record<string,unknown>}>;
    };

    let credentials: Awaited<ReturnType<typeof driveCredentials>> = null;
    try { credentials = await driveCredentials(); } catch (error) { return json({ error: error instanceof Error ? error.message : 'Secret Google Drive tidak valid.' }, 500); }
    if (body.action === 'status') {
      const config = await loadConfig();
      return json({ configured: Boolean(config?.rootFolderId), credentialsConfigured: Boolean(credentials), serviceAccountEmail: credentials?.client_email || null, config });
    }
    if (body.action === 'save-config') {
      const sharedDriveId = typeof body.sharedDriveId === 'string' ? body.sharedDriveId.trim() : '';
      const rootFolderId = typeof body.rootFolderId === 'string' ? body.rootFolderId.trim() : '';
      const maxFileMb = Number(body.maxFileMb), retentionDays = Number(body.retentionDays);
      if ((sharedDriveId && !validId(sharedDriveId)) || !validId(rootFolderId) || !Number.isInteger(maxFileMb) || maxFileMb < 10 || maxFileMb > 5120 || !Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) return json({ error: 'Konfigurasi Drive tidak valid.' }, 400);
      const config: DriveConfig = { sharedDriveId, rootFolderId, maxFileMb, retentionDays };
      const { error } = await ctx.supabaseAdmin.from('wms_documents').upsert({ branch_id: branchId, collection_name: 'settings', document_id: documentId, payload: config, updated_by: actorId }, { onConflict: 'branch_id,collection_name,document_id' });
      if (error) return json({ error: 'Konfigurasi gagal disimpan.' }, 500);
      await ctx.supabaseAdmin.from('activity_events').insert({ branch_id: branchId, entity_type: 'settings', entity_id: documentId, action: 'RETURN_DRIVE_CONFIG_UPDATE', actor_id: actorId, actor_name: actor.full_name || 'Administrator', after_data: { ...config, credentialsConfigured: Boolean(credentials) }, reason: 'Konfigurasi evidence return' });
      return json({ success: true, config, credentialsConfigured: Boolean(credentials) });
    }
    if (body.action === 'test') {
      const config = await loadConfig();
      if (!config?.rootFolderId) return json({ error: 'Simpan Root Folder ID terlebih dahulu.' }, 400);
      if (!credentials) return json({ error: 'Secret service account belum dipasang di backend.' }, 409);
      try {
        const folder = await inspectFolder(await driveToken(credentials), config.rootFolderId);
        if (config.sharedDriveId && folder.driveId !== config.sharedDriveId) throw new Error('Folder tidak berada di Shared Drive yang dipilih.');
        const verifiedConfig = { ...config, verifiedAt: new Date().toISOString(), folderName: String(folder.name || 'Return Evidence') };
        const { error: verifyWriteError } = await ctx.supabaseAdmin.from('wms_documents').update({ payload: verifiedConfig, updated_by: actorId }).eq('branch_id', branchId).eq('collection_name', 'settings').eq('document_id', documentId);
        if (verifyWriteError) throw new Error('Hasil tes koneksi gagal dicatat.');
        await ctx.supabaseAdmin.from('activity_events').insert({ branch_id: branchId, entity_type: 'settings', entity_id: documentId, action: 'RETURN_DRIVE_CONNECTION_VERIFIED', actor_id: actorId, actor_name: actor.full_name || 'Administrator', after_data: { folderId: folder.id, folderName: folder.name, driveId: folder.driveId || null, verifiedAt: verifiedConfig.verifiedAt }, reason: 'Tes koneksi Google Drive return berhasil' });
        return json({ success: true, folder: { id: folder.id, name: folder.name, driveId: folder.driveId || null }, serviceAccountEmail: credentials.client_email });
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Tes koneksi Google Drive gagal.' }, 400); }
    }
    if (body.action === 'start-upload') {
      const caseId = typeof body.caseId === 'string' ? body.caseId.trim() : '';
      const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
      const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
      const fileSize = Number(body.fileSize);
      if (!caseId || !fileName || !mimeType.startsWith('video/') || !Number.isSafeInteger(fileSize) || fileSize <= 0) return json({ error: 'File video tidak valid.' }, 400);
      const config = await loadConfig();
      if (!config?.rootFolderId || !credentials) return json({ error: 'Google Drive return belum siap.' }, 409);
      if (fileSize > config.maxFileMb * 1024 * 1024) return json({ error: `Ukuran video melebihi batas ${config.maxFileMb} MB.` }, 413);
      try {
        const caseRows = await loadCase(caseId);
        if (caseRows.some(row => ['RESTOCKED','KARANTINA','QC_REJECTED'].includes(String(row.payload.status || '')))) throw new Error('Kasus return sudah selesai dan tidak dapat menerima video baru.');
        if (caseRows.some(row => row.payload.evidenceStatus === 'READY')) throw new Error('Video evidence kasus ini sudah terverifikasi.');
        const token = await driveToken(credentials);
        await inspectFolder(token, config.rootFolderId);
        const returnNumber = String(caseRows[0].payload.returnNumber || caseId);
        const extension = safeFileName(fileName).split('.').pop()?.slice(0, 10) || 'mp4';
        const driveName = `${safeFileName(returnNumber)}_${Date.now()}.${extension}`;
        const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,md5Checksum,createdTime,parents,appProperties', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(fileSize) },
          body: JSON.stringify({ name: driveName, mimeType, parents: [config.rootFolderId], appProperties: { branchId, caseId, returnNumber } })
        });
        const sessionUrl = init.headers.get('Location');
        if (!init.ok || !sessionUrl) throw new Error('Sesi upload Google Drive gagal dibuat.');
        const startedAt = new Date().toISOString();
        const startWrites = await Promise.all(caseRows.map(row => ctx.supabaseAdmin.from('wms_documents').update({ payload: { ...row.payload, evidenceStatus: 'UPLOADING', evidenceFileName: driveName, evidenceMimeType: mimeType, evidenceSize: fileSize, evidenceUploadStartedAt: startedAt, evidenceUploadedById: actorId }, updated_by: actorId }).eq('branch_id', branchId).eq('collection_name', 'returns').eq('document_id', row.document_id)));
        if (startWrites.some(write => write.error)) throw new Error('Status awal upload gagal dicatat.');
        return json({ success: true, sessionUrl, chunkSize: 8 * 1024 * 1024, expiresInSeconds: 604800 });
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Sesi upload gagal dibuat.' }, 400); }
    }
    if (body.action === 'finalize-upload') {
      const caseId = typeof body.caseId === 'string' ? body.caseId.trim() : '';
      const fileId = typeof body.fileId === 'string' ? body.fileId.trim() : '';
      if (!caseId || !validId(fileId)) return json({ error: 'Identitas upload tidak valid.' }, 400);
      const config = await loadConfig();
      if (!config?.rootFolderId || !credentials) return json({ error: 'Google Drive return belum siap.' }, 409);
      try {
        const caseRows = await loadCase(caseId);
        const file = await inspectUploadedFile(await driveToken(credentials), fileId);
        const size = Number(file.size);
        if (file.trashed || !String(file.mimeType || '').startsWith('video/') || !Array.isArray(file.parents) || !file.parents.includes(config.rootFolderId) || file.appProperties?.branchId !== branchId || file.appProperties?.caseId !== caseId || !Number.isSafeInteger(size) || size <= 0 || size > config.maxFileMb * 1024 * 1024) throw new Error('Verifikasi file Google Drive gagal.');
        const uploadedAt = new Date().toISOString();
        const finalWrites = await Promise.all(caseRows.map(row => ctx.supabaseAdmin.from('wms_documents').update({ payload: { ...row.payload, evidenceStatus: 'READY', evidenceUrl: file.webViewLink, evidenceFileId: file.id, evidenceFileName: file.name, evidenceMimeType: file.mimeType, evidenceSize: size, evidenceChecksum: file.md5Checksum || null, evidenceUploadedAt: uploadedAt, evidenceUploadedBy: actor.full_name || ctx.userClaims?.email || 'Administrator', evidenceUploadedById: actorId }, updated_by: actorId }).eq('branch_id', branchId).eq('collection_name', 'returns').eq('document_id', row.document_id)));
        if (finalWrites.some(write => write.error)) throw new Error('Metadata evidence gagal disimpan.');
        await ctx.supabaseAdmin.from('activity_events').insert({ branch_id: branchId, entity_type: 'returns', entity_id: caseId, action: 'RETURN_EVIDENCE_UPLOAD', actor_id: actorId, actor_name: actor.full_name || 'Administrator', after_data: { fileId: file.id, name: file.name, mimeType: file.mimeType, size, checksum: file.md5Checksum || null }, reason: 'Video unboxing return terverifikasi' });
        return json({ success: true, file: { id: file.id, name: file.name, webViewLink: file.webViewLink, mimeType: file.mimeType, size, checksum: file.md5Checksum || null } });
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Finalisasi video gagal.' }, 400); }
    }
    if (body.action === 'delete-evidence') {
      if (actor.role !== 'Administrator') return json({ error: 'Hanya Administrator pusat yang dapat menghapus evidence.' }, 403);
      const caseId = typeof body.caseId === 'string' ? body.caseId.trim() : '';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!caseId || reason.length < 8 || reason.length > 300) return json({ error: 'Alasan penghapusan minimal 8 karakter.' }, 400);
      if (!credentials) return json({ error: 'Google Drive return belum siap.' }, 409);
      try {
        const caseRows = await loadCase(caseId);
        if (caseRows.some(row => ['RESTOCKED','KARANTINA','QC_REJECTED'].includes(String(row.payload.status || '')))) throw new Error('Evidence kasus yang sudah diproses tidak dapat dihapus.');
        const fileId = String(caseRows[0].payload.evidenceFileId || '');
        if (!validId(fileId) || caseRows.some(row => row.payload.evidenceFileId !== fileId)) throw new Error('Evidence kasus tidak konsisten.');
        const token = await driveToken(credentials);
        const file = await inspectUploadedFile(token, fileId);
        if (file.appProperties?.branchId !== branchId || file.appProperties?.caseId !== caseId) throw new Error('Identitas evidence Google Drive tidak sesuai.');
        const deleted = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
        if (!deleted.ok) throw new Error('Evidence gagal dipindahkan ke Trash Google Drive.');
        const deletedAt = new Date().toISOString();
        const writes = await Promise.all(caseRows.map(row => {
          const payload = { ...row.payload, evidenceStatus: 'MISSING', evidenceUrl: null, evidenceFileId: null, evidenceDeletedAt: deletedAt, evidenceDeletedBy: actor.full_name || 'Administrator', evidenceDeleteReason: reason };
          return ctx.supabaseAdmin.from('wms_documents').update({ payload, updated_by: actorId }).eq('branch_id', branchId).eq('collection_name', 'returns').eq('document_id', row.document_id);
        }));
        if (writes.some(write => write.error)) {
          await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: false }) });
          throw new Error('Status penghapusan evidence gagal dicatat; file dipulihkan dari Trash.');
        }
        await ctx.supabaseAdmin.from('activity_events').insert({ branch_id: branchId, entity_type: 'returns', entity_id: caseId, action: 'RETURN_EVIDENCE_DELETE', actor_id: actorId, actor_name: actor.full_name || 'Administrator', before_data: { fileId, name: file.name, checksum: file.md5Checksum || null }, after_data: { evidenceStatus: 'MISSING', deletedAt }, reason });
        return json({ success: true });
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Penghapusan evidence gagal.' }, 400); }
    }
    return json({ error: 'Aksi tidak dikenal.' }, 400);
  })
};
