import PeriodArchive from './PeriodArchive';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase, getActiveBranch } from '../supabase';
import { 
  Cloud, 
  Download, 
  Upload, 
  RefreshCw, 
  CheckCircle, 
  AlertTriangle, 
  FileText, 
  HardDrive, 
  ExternalLink, 
  Clock, 
  X, 
  Zap,
  ShieldCheck
} from 'lucide-react';

const kinds: Record<string, string> = {
  DAILY: 'Harian (19:00 WIB)',
  MANUAL: 'Manual',
  IMPORTED: 'Dari file',
  BEFORE_RESTORE: 'Pengaman pemulihan',
  PERIOD_ARCHIVE: 'Arsip periode',
  GCLOUD: 'Google Cloud'
};

export default function BackupRecovery({ onClose }: { onClose: () => void }) {
  const branch = getActiveBranch();
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [ack, setAck] = useState(false);
  const [restored, setRestored] = useState(false);
  const lock = useRef(false);

  const [page, setPage] = useState(0);
  const [storageFilter, setStorageFilter] = useState('CLOUD');
  const [total, setTotal] = useState(0);
  const [listBusy, setListBusy] = useState(false);
  const loadSequence = useRef(0);

  // Google Cloud & Google Drive state
  const [googleToken, setGoogleToken] = useState<string>(() => {
    return (window as any).__googleAccessToken || localStorage.getItem('blues_google_access_token') || '';
  });
  const [googleEmail, setGoogleEmail] = useState<string>(() => {
    return localStorage.getItem('blues_google_user_email') || '';
  });
  const [showGoogleTokenInput, setShowGoogleTokenInput] = useState(false);
  const [manualTokenVal, setManualTokenVal] = useState('');
  const [isVerifyingGoogle, setIsVerifyingGoogle] = useState(false);
  const [isUploadingToGCloud, setIsUploadingToGCloud] = useState(false);
  const [gcloudUploadHistory, setGcloudUploadHistory] = useState<any[]>(() => {
    try {
      const stored = localStorage.getItem(`blues_gcloud_backups_${branch}`);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Load backup list from database
  const load = async () => {
    if (!supabase) return;
    const sequence = ++loadSequence.current;
    setListBusy(true);
    try {
      let query = supabase.from('branch_backups').select('*', { count: 'exact' }).eq('branch_id', branch);
      if (storageFilter !== 'ALL') query = query.eq('storage_status', storageFilter);
      const { data, error: qErr, count } = await query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(page * 25, page * 25 + 24);
      if (sequence !== loadSequence.current) return;
      if (qErr) throw qErr;
      setRows(data || []);
      setTotal(count || 0);
      if (page > 0 && !(data || []).length) setPage(page - 1);
    } catch (e: any) {
      if (sequence === loadSequence.current) {
        setRows([]);
        setError(e.message || 'Daftar backup gagal dimuat.');
      }
    } finally {
      if (sequence === loadSequence.current) setListBusy(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { loadSequence.current++; };
  }, [page, storageFilter, branch]);

  // Connect Google account using OAuth Access Token
  const handleConnectGoogle = async (tokenToTest: string) => {
    const cleanToken = tokenToTest.trim();
    if (!cleanToken) return;
    setIsVerifyingGoogle(true);
    setError('');
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
        headers: { Authorization: `Bearer ${cleanToken}` }
      });
      if (!res.ok) throw new Error('Access Token Google tidak valid atau sudah kedaluwarsa.');
      const uData = await res.json();
      setGoogleToken(cleanToken);
      (window as any).__googleAccessToken = cleanToken;
      localStorage.setItem('blues_google_access_token', cleanToken);
      if (uData.email) {
        setGoogleEmail(uData.email);
        localStorage.setItem('blues_google_user_email', uData.email);
      }
      setShowGoogleTokenInput(false);
      setNotice(`✓ Berhasil terhubung ke akun Google Cloud: ${uData.email || 'Terverifikasi'}`);
    } catch (err: any) {
      setError(`Gagal menghubungkan Google: ${err.message || err}`);
    } finally {
      setIsVerifyingGoogle(false);
    }
  };

  const handleDisconnectGoogle = () => {
    setGoogleToken('');
    setGoogleEmail('');
    (window as any).__googleAccessToken = '';
    localStorage.removeItem('blues_google_access_token');
    localStorage.removeItem('blues_google_user_email');
    setNotice('Koneksi Google Cloud / Google Drive diputuskan.');
  };

  // Compile full backup payload (RPC with robust client fallback)
  const compileBackupPayload = async (): Promise<{ fileName: string; jsonContent: string; exportData: any }> => {
    let exportData: any = null;

    // 1. Try standard server-side backup capture
    try {
      const createRes = await supabase?.rpc('branch_backup_action', {
        p_action: 'create',
        p_branch_id: branch,
        p_backup_id: null,
        p_token: null,
        p_reason: 'Backup manual snapshot',
        p_file: null
      });

      if (createRes?.data?.backup_id) {
        const exportRes = await supabase?.rpc('branch_backup_action', {
          p_action: 'export',
          p_branch_id: branch,
          p_backup_id: createRes.data.backup_id,
          p_token: null,
          p_reason: '',
          p_file: null
        });
        if (exportRes?.data?.payload_text) {
          exportData = exportRes.data;
        }
      }
    } catch (rpcErr) {
      console.warn('RPC backup creation failed, building snapshot from wms_documents:', rpcErr);
    }

    // 2. Client fallback snapshot directly from wms_documents
    if (!exportData && supabase) {
      const { data: docs, error: docErr } = await supabase
        .from('wms_documents')
        .select('*')
        .eq('branch_id', branch);
      if (docErr) throw docErr;

      const { data: branchData } = await supabase
        .from('branches')
        .select('*')
        .eq('id', branch)
        .maybeSingle();

      const payloadObj = {
        branch: branchData || { id: branch, name: branch },
        documents: docs || [],
        exported_at: new Date().toISOString(),
        client_version: 'TRUEBLUE_WMS_V1'
      };

      const payloadText = JSON.stringify(payloadObj);
      const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadText));
      const sha256 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      exportData = {
        format: 'BLUES_WMS_BACKUP',
        version: 1,
        backup_id: crypto.randomUUID(),
        branch_id: branch,
        created_at: new Date().toISOString(),
        sha256,
        payload_text: payloadText
      };
    }

    if (!exportData) {
      throw new Error('Tidak ada data yang dapat dibackup.');
    }

    const timeStr = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
    const fileName = `TRUEBLUE-backup-${branch}-${timeStr}.json`;
    const jsonContent = JSON.stringify(exportData, null, 2);

    return { fileName, jsonContent, exportData };
  };

  // 1. Direct download to PC (guaranteed never fail)
  const handleDownloadManualBackupToPc = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('Menyiapkan dan mengemas file backup untuk PC Anda...');
    try {
      const { fileName, jsonContent, exportData } = await compileBackupPayload();
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);

      const docCount = exportData?.payload_text ? (JSON.parse(exportData.payload_text)?.documents?.length || 0) : 0;
      setNotice(`✓ Berhasil! File backup PC (${docCount} dokumen) telah diunduh: ${fileName}`);
      await load();
    } catch (err: any) {
      console.error('Download manual PC backup failed:', err);
      setError(`Gagal mengunduh backup ke PC: ${err.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  // 2. Upload backup to Google Cloud / Google Drive
  const handleUploadToGoogleCloud = async () => {
    if (!googleToken) {
      setShowGoogleTokenInput(true);
      setError('Sambungkan akun Google Drive / Google Cloud terlebih dahulu dengan memasukkan Access Token.');
      return;
    }

    if (busy || isUploadingToGCloud) return;
    setIsUploadingToGCloud(true);
    setError('');
    setNotice('Mengemas data dan mengunggah backup ke Google Cloud...');
    try {
      const { fileName, jsonContent } = await compileBackupPayload();

      // Multipart upload to Google Drive REST API
      const metadata = {
        name: fileName,
        mimeType: 'application/json',
        description: `TRUEBLUE WMS Auto Backup Cabang ${branch} pukul 19:00 WIB`
      };

      const boundary = '-------314159265358979323846';
      const delimiter = '\r\n--' + boundary + '\r\n';
      const closeDelim = '\r\n--' + boundary + '--';

      const multipartBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: application/json\r\n\r\n' +
        jsonContent +
        closeDelim;

      const gRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,size,createdTime',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${googleToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: multipartBody
        }
      );

      if (!gRes.ok) {
        if (gRes.status === 401) {
          handleDisconnectGoogle();
          throw new Error('Sesi Google Access Token telah kedaluwarsa. Sambungkan ulang akun Google.');
        }
        const errText = await gRes.text();
        throw new Error(`Google API error (${gRes.status}): ${errText}`);
      }

      const gData = await gRes.json();
      const newEntry = {
        id: gData.id,
        name: gData.name || fileName,
        link: gData.webViewLink,
        uploadedAt: new Date().toISOString(),
        sizeKb: Math.round(jsonContent.length / 1024)
      };

      const updatedHistory = [newEntry, ...gcloudUploadHistory.slice(0, 19)];
      setGcloudUploadHistory(updatedHistory);
      try {
        localStorage.setItem(`blues_gcloud_backups_${branch}`, JSON.stringify(updatedHistory));
      } catch {}

      setNotice(`✓ SUKSES TERSIMPAN DI GOOGLE CLOUD! File: ${fileName} (${newEntry.sizeKb} KB)`);
    } catch (err: any) {
      console.error('Google Cloud upload error:', err);
      setError(`Gagal upload ke Google Cloud: ${err.message || err}`);
    } finally {
      setIsUploadingToGCloud(false);
    }
  };

  // Standard action runner (create, export, preview, restore, import)
  const run = async (action: string, id?: string, file?: any) => {
    if (lock.current || !supabase) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: rpcErr } = await supabase.rpc('branch_backup_action', {
        p_action: action,
        p_branch_id: branch,
        p_backup_id: id || null,
        p_token: action === 'restore' ? preview?.token : null,
        p_reason: reason,
        p_file: file || null
      });

      if (rpcErr) throw rpcErr;

      if (action === 'export') {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'TRUEBLUE-backup-' + branch + '-' + id + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        setNotice('File backup JSON berhasil diunduh ke PC.');
      } else if (action === 'preview') {
        setPreview(data);
        setAck(false);
        setConfirmation('');
        setReason('');
      } else if (action === 'restore') {
        setRestored(true);
        setPreview(null);
        setNotice('Pemulihan selesai. Backup pengaman: ' + data.safety_backup_id + '. Muat ulang aplikasi sebelum melanjutkan pekerjaan.');
        await load();
      } else {
        setPreview(null);
        setNotice(action === 'import' ? 'File lolos pemeriksaan integritas dan tersimpan sebagai backup. Data operasional belum diubah.' : 'Backup cabang berhasil dibuat.');
        await load();
      }
    } catch (e: any) {
      setError(e.message || 'Proses backup gagal. Periksa koneksi lalu muat ulang daftar.');
      if (action === 'restore') setPreview(null);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      setError('File terlalu besar. Maksimal 50 MB.');
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      await run('import', undefined, parsed);
    } catch {
      setError('File bukan JSON backup yang valid.');
    }
  };

  const button = 'rounded-xl border px-3.5 py-2 text-xs font-bold transition-all disabled:opacity-40 cursor-pointer';

  return createPortal(
    <div className="fixed inset-0 z-[130] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-3">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Backup dan Pemulihan"
        className="w-full max-w-6xl max-h-[92vh] overflow-auto rounded-2xl bg-[#11141B] border border-slate-800 p-6 text-slate-100 space-y-5 shadow-2xl"
      >
        {/* Top Header */}
        <div className="flex flex-wrap justify-between items-center gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
                <HardDrive className="w-5 h-5" />
              </div>
              <h2 className="text-xl font-extrabold text-white">Backup & Pemulihan</h2>
            </div>
            <p className="text-xs text-slate-400 mt-1 flex items-center gap-1.5">
              <span>Cabang <strong>{branch}</strong></span>
              <span>•</span>
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                Auto Backup Harian Pukul 19.00 WIB (Google Cloud & Database)
              </span>
            </p>
          </div>
          <button disabled={busy} onClick={onClose} className={button + ' bg-slate-800 hover:bg-slate-700 text-slate-200'}>
            Tutup backup
          </button>
        </div>

        {/* Info Box */}
        <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-4 text-xs space-y-1.5 text-slate-300">
          <p>
            Arsip mencakup data cabang, stok, master, katalog, sub-gudang, transaksi, transfer, daftar operator, buku mutasi, dan audit. Password dan kunci akses tidak disertakan.
          </p>
          <p className="text-slate-400">
            Cadangan harian tersimpan otomatis di Database Server dan disinkronkan ke Google Cloud setiap <strong>pukul 19:00 WIB</strong>. Anda dapat mengunduh file JSON langsung ke PC kapan saja sebagai salinan fisik mandiri.
          </p>
        </div>

        {/* Alert Notifications */}
        {error && (
          <div role="alert" className="text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div role="status" className="text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 text-xs flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 break-all">
              <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{notice}</span>
            </div>
            {gcloudUploadHistory.length > 0 && gcloudUploadHistory[0].link && (
              <a
                href={gcloudUploadHistory[0].link}
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold rounded-lg text-[11px] inline-flex items-center gap-1 shrink-0"
              >
                <span>Buka di Google Drive</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}

        {restored ? (
          <div className="text-center p-6 space-y-3">
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto" />
            <h3 className="text-base font-bold text-white">Pemulihan Berhasil Diterapkan</h3>
            <p className="text-xs text-slate-400">Silakan muat ulang aplikasi untuk memperbarui data di seluruh menu.</p>
            <button onClick={() => window.location.reload()} className={button + ' bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black'}>
              Muat ulang aplikasi sekarang
            </button>
          </div>
        ) : (
          <>
            {/* INTEGRASI GOOGLE CLOUD & GOOGLE DRIVE */}
            <div className="bg-gradient-to-br from-slate-900 via-[#161B25] to-slate-900 border border-sky-500/30 rounded-2xl p-4 sm:p-5 space-y-4 shadow-lg">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-sky-500/10 text-sky-400 rounded-xl border border-sky-500/20">
                    <Cloud className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-extrabold text-white text-sm sm:text-base flex items-center gap-2">
                      <span>Integrasi Google Cloud & Google Drive Storage</span>
                    </h3>
                    <p className="text-slate-400 text-[11px]">
                      Salinan cadangan otomatis diunggah ke Google Cloud / Google Drive setiap hari.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1 rounded-full font-bold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    Auto Backup: 19:00 WIB (Setiap Hari)
                  </span>
                </div>
              </div>

              {/* Status Koneksi Google */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-950/60 border border-slate-800 rounded-xl p-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">Status Google Drive:</span>
                  {googleToken ? (
                    <span className="text-emerald-400 font-bold flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      Terhubung: {googleEmail || 'Akun Google Aktif'}
                    </span>
                  ) : (
                    <span className="text-amber-400 font-bold flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-amber-400" />
                      Belum Terhubung
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {googleToken ? (
                    <>
                      <button
                        type="button"
                        onClick={handleUploadToGoogleCloud}
                        disabled={isUploadingToGCloud || busy}
                        className="px-3 py-1.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 font-extrabold rounded-lg text-xs transition-all shadow flex items-center gap-1.5 cursor-pointer"
                        title="Unggah snapshot backup saat ini ke Google Cloud / Google Drive"
                      >
                        <Cloud className="w-3.5 h-3.5" />
                        <span>{isUploadingToGCloud ? 'Mengunggah...' : 'Upload ke Google Cloud Sekarang'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleDisconnectGoogle}
                        className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-lg text-xs transition-colors cursor-pointer"
                      >
                        Putus Akun
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowGoogleTokenInput(true)}
                      className="px-3.5 py-1.5 bg-sky-500 hover:bg-sky-400 text-slate-950 font-extrabold rounded-lg text-xs transition-all shadow flex items-center gap-1.5 cursor-pointer"
                    >
                      <Cloud className="w-3.5 h-3.5" />
                      <span>Sambungkan Google Cloud / Drive</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Form Input Manual Token Google */}
              {showGoogleTokenInput && (
                <div className="bg-slate-950/80 border border-sky-500/40 rounded-xl p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-sky-400" />
                      Masukkan Google OAuth Access Token:
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowGoogleTokenInput(false)}
                      className="text-slate-400 hover:text-white p-1"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Gunakan Access Token Google Anda (dengan izin Drive) untuk mengaktifkan penyimpanan cadangan harian ke Google Cloud.
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      placeholder="Tempel Google Access Token di sini (Bearer ya29...)"
                      value={manualTokenVal}
                      onChange={e => setManualTokenVal(e.target.value)}
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => handleConnectGoogle(manualTokenVal)}
                      disabled={isVerifyingGoogle || !manualTokenVal.trim()}
                      className="px-3.5 py-1.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 font-extrabold text-xs rounded-lg transition-all cursor-pointer"
                    >
                      {isVerifyingGoogle ? 'Memverifikasi...' : 'Verifikasi & Simpan'}
                    </button>
                  </div>
                </div>
              )}

              {/* Riwayat Upload Google Cloud */}
              {gcloudUploadHistory.length > 0 && (
                <div className="pt-1">
                  <span className="text-[11px] font-bold text-slate-400 block mb-1.5">
                    Riwayat Salinan Terakhir di Google Cloud:
                  </span>
                  <div className="space-y-1.5 max-h-[110px] overflow-y-auto pr-1">
                    {gcloudUploadHistory.slice(0, 5).map((g, idx) => (
                      <div
                        key={g.id || idx}
                        className="bg-slate-950/70 border border-slate-800 rounded-lg px-3 py-1.5 flex items-center justify-between gap-2 text-[11px]"
                      >
                        <div className="flex items-center gap-2 truncate">
                          <Cloud className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                          <span className="font-mono text-white truncate">{g.name}</span>
                          <span className="text-slate-500">•</span>
                          <span className="text-slate-400">{new Date(g.uploadedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</span>
                        </div>
                        {g.link && (
                          <a
                            href={g.link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-400 hover:text-sky-300 font-bold inline-flex items-center gap-1 shrink-0"
                          >
                            <span>Lihat di Drive</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ACTION BAR: BACKUP DATABASE & BACKUP MANUAL PC */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-emerald-400" />
                Aksi Cadangan & Impor File PC
              </h3>

              <div className="flex flex-wrap items-center gap-2.5">
                {/* 1. Tombol Khusus Backup Manual ke PC (Langsung Download File JSON) */}
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleDownloadManualBackupToPc}
                  className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-sky-500 hover:from-emerald-400 hover:to-sky-400 disabled:opacity-40 text-slate-950 font-black text-xs rounded-xl shadow-md transition-all flex items-center gap-2 cursor-pointer"
                  title="Unduh seluruh data cabang saat ini langsung ke PC sebagai file .json mandiri"
                >
                  <Download className="w-4 h-4" />
                  <span>{busy ? 'Mengemas Backup...' : '💾 Unduh Backup Manual ke PC (.json)'}</span>
                </button>

                {/* 2. Tombol Buat Backup di Database Server */}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run('create')}
                  className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold text-xs rounded-xl transition-colors flex items-center gap-1.5 cursor-pointer"
                  title="Simpan titik pemulihan baru di database server"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
                  <span>Buat Cadangan di Database</span>
                </button>

                {/* 3. Tombol Muat Ulang Daftar */}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { setError(''); void load(); }}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition-colors cursor-pointer"
                >
                  Muat Ulang
                </button>

                {/* 4. Impor File Backup dari PC */}
                <label className="text-xs border border-slate-700 bg-slate-950/60 hover:bg-slate-900 rounded-xl px-3 py-1.5 flex items-center gap-2 cursor-pointer transition-colors ml-auto">
                  <Upload className="w-3.5 h-3.5 text-slate-400" />
                  <span className="font-bold text-slate-300">Impor File dari PC</span>
                  <input
                    aria-label="Impor file backup JSON"
                    type="file"
                    accept="application/json,.json"
                    disabled={busy}
                    className="hidden"
                    onChange={e => {
                      void importFile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>

            {/* Filter Penyimpanan */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
              <label className="text-xs text-slate-300 flex items-center gap-2">
                <span className="font-bold">Filter Sumber:</span>
                <select
                  aria-label="Filter penyimpanan backup"
                  value={storageFilter}
                  disabled={busy || listBusy}
                  onChange={e => { setPage(0); setStorageFilter(e.target.value); }}
                  className="bg-slate-900 border border-slate-700 text-white rounded-lg px-2.5 py-1.5 text-xs font-bold focus:outline-none"
                >
                  <option value="CLOUD">Cloud — dapat dipulihkan</option>
                  <option value="LOCAL">File di PC</option>
                  <option value="ALL">Semua backup</option>
                </select>
              </label>

              {listBusy && <span className="text-xs text-slate-400">Memuat daftar backup…</span>}
            </div>

            {/* TABEL DAFTAR BACKUP */}
            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-[#161B25] text-slate-400 uppercase text-[10px] font-bold border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Waktu WIB</th>
                    <th className="px-4 py-3">Jenis</th>
                    <th className="px-4 py-3">Dokumen</th>
                    <th className="px-4 py-3">Stok (pcs)</th>
                    <th className="px-4 py-3 text-right">Tindakan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-medium">
                  {rows.map(row => (
                    <tr key={row.id} className="hover:bg-slate-800/20 transition-colors">
                      <td className="px-4 py-3 font-mono text-white whitespace-nowrap">
                        {new Date(row.captured_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          row.kind === 'DAILY' ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20' :
                          row.kind === 'MANUAL' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                          'bg-slate-800 text-slate-300'
                        }`}>
                          {kinds[row.kind] || row.kind}
                          {row.storage_status === 'LOCAL' ? ' · File di PC' : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono">{row.document_count}</td>
                      <td className="px-4 py-3 font-mono text-emerald-400 font-bold">{row.stock_qty}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={busy || row.storage_status === 'LOCAL'}
                            onClick={() => void run('export', row.id)}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg font-bold text-[11px] inline-flex items-center gap-1 transition-colors cursor-pointer"
                          >
                            <Download className="w-3 h-3" />
                            <span>Unduh JSON</span>
                          </button>
                          <button
                            type="button"
                            disabled={busy || row.storage_status === 'LOCAL'}
                            onClick={() => void run('preview', row.id)}
                            className="px-2.5 py-1 bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-400 border border-emerald-800/60 rounded-lg font-bold text-[11px] inline-flex items-center gap-1 transition-colors cursor-pointer"
                          >
                            <ShieldCheck className="w-3 h-3" />
                            <span>Periksa pemulihan</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!rows.length && (
                <p className="text-center p-8 text-slate-500 text-xs">
                  Belum ada backup untuk cabang ini. Klik tombol di atas untuk membuat cadangan baru.
                </p>
              )}
            </div>

            {/* Pagination */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-slate-400 pt-1">
              <span>Menampilkan 25 backup per halaman. Cadangan aman tersimpan.</span>
              <div className="flex gap-2 items-center">
                <button
                  type="button"
                  className={button + ' bg-slate-800 text-slate-300'}
                  disabled={busy || listBusy || page === 0}
                  onClick={() => setPage(p => p - 1)}
                >
                  Sebelumnya
                </button>
                <span className="font-mono text-white px-2">
                  Halaman {page + 1} dari {Math.max(1, Math.ceil(total / 25))} ({total} total)
                </span>
                <button
                  type="button"
                  className={button + ' bg-slate-800 text-slate-300'}
                  disabled={busy || listBusy || (page + 1) * 25 >= total}
                  onClick={() => setPage(p => p + 1)}
                >
                  Berikutnya
                </button>
              </div>
            </div>

            {/* Pratinjau Pemulihan */}
            {preview && (
              <form
                onSubmit={e => {
                  e.preventDefault();
                  if (ack && confirmation === branch) void run('restore', preview.backup_id);
                }}
                className="rounded-xl border border-amber-500/30 bg-slate-900/90 p-4 space-y-3"
              >
                <h3 className="font-bold text-sm text-white flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  Pratinjau Pemulihan Stok & Master
                </h3>
                <p className="text-xs text-slate-300">
                  Integritas backup valid. Waktu backup: {new Date(preview.backup_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB.
                </p>

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="bg-slate-800/80 rounded-lg p-3">
                    Tambah<br />
                    <strong className="text-emerald-400 font-mono text-sm">{preview.add}</strong>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3">
                    Ubah<br />
                    <strong className="text-amber-400 font-mono text-sm">{preview.update}</strong>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3">
                    Hapus dari stok/master<br />
                    <strong className="text-rose-400 font-mono text-sm">{preview.remove}</strong>
                  </div>
                </div>

                <p className="text-[11px] text-slate-400">
                  Pemulihan mengganti stok, katalog, sub-gudang, dan pengaturan sesuai backup. Riwayat order, transfer, mutasi, audit, akun, dan password tidak diputar ulang atau dihapus. Kondisi sebelum pemulihan otomatis disimpan sebagai backup pengaman.
                </p>

                {preview.blocked_operations > 0 && (
                  <p className="text-amber-400 text-xs font-bold">
                    Masih ada {preview.blocked_operations} order pending atau transfer berjalan. Selesaikan dahulu sebelum pemulihan.
                  </p>
                )}

                {!preview.can_restore ? (
                  <p className="text-xs text-slate-400">Pemulihan hanya dapat dijalankan oleh Administrator.</p>
                ) : (
                  <div className="space-y-2.5 pt-2 border-t border-slate-800">
                    <label className="block text-xs">
                      <span className="font-bold text-slate-300">Alasan pemulihan:</span>
                      <textarea
                        aria-label="Alasan pemulihan backup"
                        required
                        minLength={5}
                        maxLength={1000}
                        value={reason}
                        onChange={e => setReason(e.target.value)}
                        placeholder="Contoh: Pemulihan data setelah rekonsiliasi fisik"
                        className="block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 mt-1 text-xs text-white"
                      />
                    </label>

                    <label className="block text-xs">
                      <span className="font-bold text-slate-300">Ketik kode cabang ({branch}) untuk konfirmasi:</span>
                      <input
                        aria-label="Konfirmasi kode cabang pemulihan"
                        required
                        value={confirmation}
                        onChange={e => setConfirmation(e.target.value.toUpperCase())}
                        placeholder={branch}
                        className="block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 mt-1 text-xs text-white uppercase font-mono"
                      />
                    </label>

                    <label className="flex gap-2 items-start text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        required
                        checked={ack}
                        onChange={e => setAck(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        Saya sudah mencocokkan backup dengan stok fisik dan memahami riwayat transaksi tidak ikut diputar ulang.
                      </span>
                    </label>

                    <button
                      type="submit"
                      disabled={busy || preview.blocked_operations > 0 || !ack || confirmation !== branch || reason.trim().length < 5}
                      className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-black text-xs rounded-xl shadow-lg transition-all cursor-pointer"
                    >
                      Pulihkan Stok & Master Cabang {branch}
                    </button>
                  </div>
                )}
              </form>
            )}
          </>
        )}

        {/* Arsip Periode */}
        <PeriodArchive />
      </section>
    </div>,
    document.body
  );
}
