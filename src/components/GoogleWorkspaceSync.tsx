import React, { useState, useEffect, useRef } from 'react';
import { db } from '../supabase';
import { doc, writeBatch, setDoc } from '../supabase';
import { StockItem, CatalogItem, DccLog } from '../types';
type GoogleProfile = { email?: string; displayName?: string };
import { calculatePackQuantities, getExpiredStatus, getCanonicalStockId, normalizeDateToDmy } from '../utils/calculations';
import { 
  Cloud, 
  FileSpreadsheet, 
  Download, 
  Upload, 
  Plus, 
  Search, 
  CheckCircle2, 
  AlertTriangle, 
  Loader2, 
  RefreshCw, 
  FileText, 
  Database, 
  LogOut, 
  ExternalLink,
  Info
} from 'lucide-react';

interface GoogleWorkspaceSyncProps {
  stock: StockItem[];
  onUpdateStock: (updatedStock: StockItem[]) => void;
  catalog: CatalogItem[];
  onUpdateCatalog: (updatedCatalog: CatalogItem[]) => void;
  logs: DccLog[];
  onUpdateLogs: (updatedLogs: DccLog[]) => void;
  currentUser: { username: string; role: string; fullName: string } | null;
}

export default function GoogleWorkspaceSync({
  stock,
  onUpdateStock,
  catalog,
  onUpdateCatalog,
  logs,
  onUpdateLogs,
  currentUser
}: GoogleWorkspaceSyncProps) {
  // Auth state
  const [googleUser, setGoogleUser] = useState<GoogleProfile | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => {
    // Check if we have an active session token in memory (via window or a global)
    return (window as any).__googleAccessToken || null;
  });
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Drive state
  const [driveFiles, setDriveFiles] = useState<any[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Selection state
  const [selectedSpreadsheet, setSelectedSpreadsheet] = useState<{ id: string; name: string } | null>(() => {
    const cached = localStorage.getItem('dcc_selected_spreadsheet');
    return cached ? JSON.parse(cached) : null;
  });
  const [manualSheetId, setManualSheetId] = useState('');

  // Status message
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Manual token input state
  const [manualAccessToken, setManualAccessToken] = useState('');
  const [isVerifyingToken, setIsVerifyingToken] = useState(false);
  const [showManualTokenInput, setShowManualTokenInput] = useState(false);

  // Custom confirmation dialog state to bypass iframe modal blocking
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    onConfirm: () => void;
  } | null>(null);

  // Fetch Drive spreadsheets once connected
  useEffect(() => {
    if (accessToken) {
      fetchSpreadsheets();
    }
  }, [accessToken]);

  // Save selected spreadsheet
  useEffect(() => {
    if (selectedSpreadsheet) {
      localStorage.setItem('dcc_selected_spreadsheet', JSON.stringify(selectedSpreadsheet));
    } else {
      localStorage.removeItem('dcc_selected_spreadsheet');
    }
  }, [selectedSpreadsheet]);

  // Google Drive access is kept separate from WMS sign-in. Configure Google OAuth or paste a short-lived access token below.
  const handleConnectGoogle = async (_preferRedirect = false) => {
    setShowManualTokenInput(true);
    setStatusMsg({ type: 'info', text: 'Untuk menghubungkan Google Sheets, gunakan token OAuth Google dengan izin Drive dan Sheets.' });
  };

  // Verify and connect via manual OAuth Access Token
  const handleVerifyManualToken = async () => {
    if (!manualAccessToken.trim()) return;
    setIsVerifyingToken(true);
    setStatusMsg(null);
    try {
      const token = manualAccessToken.trim();
      const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        throw new Error('Access Token tidak valid atau sudah kadaluwarsa.');
      }
      const userData = await res.json();
      setAccessToken(token);
      (window as any).__googleAccessToken = token;
      setGoogleUser({ email: userData.email, displayName: userData.name || userData.email } as any);
      setStatusMsg({ type: 'success', text: `✓ Berhasil terhubung ke akun Google: ${userData.email}` });
    } catch (err: any) {
      console.error('Verify token error:', err);
      setStatusMsg({ 
        type: 'error', 
        text: `Gagal memverifikasi Access Token: ${err.message || 'Token tidak valid'}. Pastikan token memiliki scope Drive & Sheets.` 
      });
    } finally {
      setIsVerifyingToken(false);
    }
  };

  const handleDisconnectGoogle = () => {
    setAccessToken(null);
    (window as any).__googleAccessToken = null;
    setSelectedSpreadsheet(null);
    setDriveFiles([]);
    setStatusMsg({ type: 'info', text: 'Koneksi akun Google terputus.' });
  };

  // Fetch lists of spreadsheets from Google Drive
  const fetchSpreadsheets = async () => {
    if (!accessToken) return;
    setIsLoadingFiles(true);
    try {
      const q = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,webViewLink)&orderBy=modifiedTime desc&pageSize=30`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );
      if (!res.ok) {
        if (res.status === 401) {
          // Token expired
          handleDisconnectGoogle();
          throw new Error('Sesi Google telah kedaluwarsa. Silakan sambungkan kembali.');
        }
        throw new Error(`Gagal memuat file: ${res.statusText}`);
      }
      const data = await res.json();
      setDriveFiles(data.files || []);
    } catch (err: any) {
      console.error('Fetch Drive error:', err);
      setStatusMsg({ type: 'error', text: err.message || 'Gagal memuat daftar file Google Sheets.' });
    } finally {
      setIsLoadingFiles(false);
    }
  };

  // Handle Manual Sheet ID Binding
  const handleBindManualSheet = async () => {
    if (!manualSheetId.trim()) return;
    let sheetId = manualSheetId.trim();
    // Support full Spreadsheet URLs
    if (sheetId.includes('/d/')) {
      const parts = sheetId.split('/d/');
      if (parts[1]) {
        sheetId = parts[1].split('/')[0];
      }
    }
    
    setIsSyncing(true);
    setStatusMsg(null);
    try {
      // Validate spreadsheet ID by fetching metadata
      const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties(title)`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) {
        throw new Error('ID Spreadsheet tidak valid atau tidak memiliki izin akses.');
      }
      const meta = await res.json();
      const name = meta.properties?.title || 'Spreadsheet Tanpa Nama';
      setSelectedSpreadsheet({ id: sheetId, name });
      setManualSheetId('');
      setStatusMsg({ type: 'success', text: `Spreadsheet "${name}" berhasil dihubungkan!` });
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: err.message || 'Gagal menghubungkan Spreadsheet manual.' });
    } finally {
      setIsSyncing(false);
    }
  };

  // Create a brand new Spreadsheet in Google Drive
  const handleCreateNewSpreadsheet = async () => {
    if (!accessToken) return;
    setIsSyncing(true);
    setStatusMsg(null);
    try {
      const dateStr = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      const title = `TRUEBLUE WMS WMS Backup - ${dateStr}`;

      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: {
              title: title
            }
          })
        }
      );
      if (!response.ok) {
        throw new Error('Gagal membuat Spreadsheet baru di Drive.');
      }
      const data = await response.json();
      setSelectedSpreadsheet({ id: data.spreadsheetId, name: title });
      setStatusMsg({ type: 'success', text: `Sukses membuat Spreadsheet baru: "${title}"` });
      fetchSpreadsheets(); // refresh file list
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: err.message || 'Gagal membuat Spreadsheet baru.' });
    } finally {
      setIsSyncing(false);
    }
  };

  // Ensure Sheet Tabs Exist
  const ensureTabsExist = async (spreadsheetId: string, tabsNeeded: string[]): Promise<boolean> => {
    try {
      const metaRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(title)`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );
      if (!metaRes.ok) return false;
      const meta = await metaRes.json();
      const existingTitles: string[] = meta.sheets?.map((s: any) => s.properties?.title) || [];
      
      const missingTabs = tabsNeeded.filter(tab => !existingTitles.includes(tab));
      if (missingTabs.length === 0) return true;

      // Add missing tabs
      const requests = missingTabs.map(title => ({
        addSheet: {
          properties: { title }
        }
      }));

      const addSheetResponse = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ requests })
        }
      );
      return addSheetResponse.ok;
    } catch (err) {
      console.error('Error ensuring tabs exist:', err);
      return false;
    }
  };

  // 1. EXPORT STOCK TO SHEET
  const runExportStock = async () => {
    if (!selectedSpreadsheet || !accessToken) return;

    setIsSyncing(true);
    setStatusMsg(null);
    try {
      const tabName = 'Stok Barang';
      await ensureTabsExist(selectedSpreadsheet.id, [tabName]);

      // Construct payload
      const headers = [
        'ID',
        'SKU ID',
        'SKU Name',
        'Expired Date',
        'Location',
        'Qty',
        'Qty/CTN',
        'Qty Inner/PCS',
        'Status'
      ];
      
      const rows = stock.map(item => [
        item.id,
        item.skuId,
        item.skuName,
        item.expiredDate,
        item.location,
        item.qty,
        item.qtyCtnSize,
        item.qtyInnerSize,
        item.status
      ]);

      const values = [headers, ...rows];

      // Clear existing values first
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${selectedSpreadsheet.id}/values/${encodeURIComponent(tabName)}!A1:Z1000:clear`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      // Write values
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${selectedSpreadsheet.id}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ values })
        }
      );

      if (!res.ok) {
        throw new Error('Gagal menulis data ke Google Sheets.');
      }

      setStatusMsg({ 
        type: 'success', 
        text: `✓ Berhasil mengekspor ${stock.length} item stok ke tab "${tabName}"!` 
      });
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: err.message || 'Gagal mengekspor data stok.' });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleExportStock = () => {
    if (!selectedSpreadsheet || !accessToken) return;
    setConfirmModal({
      isOpen: true,
      title: 'SINKRONISASI EKSPOR STOK',
      message: `Apakah Anda yakin ingin mengekspor seluruh data stok saat ini (${stock.length} baris) ke Google Spreadsheet "${selectedSpreadsheet.name}"?\n\nData pada lembar "Stok Barang" akan ditimpa.`,
      confirmText: 'Ya, Ekspor Stok',
      onConfirm: () => {
        setConfirmModal(null);
        runExportStock();
      }
    });
  };

  // 2. EXPORT CATALOG TO SHEET
  const runExportCatalog = async () => {
    if (!selectedSpreadsheet || !accessToken) return;

    setIsSyncing(true);
    setStatusMsg(null);
    try {
      const tabName = 'Katalog Barang';
      await ensureTabsExist(selectedSpreadsheet.id, [tabName]);

      const headers = ['SKU ID', 'SKU Name', 'Qty CTN Size', 'Qty Inner Size'];
      const rows = catalog.map(item => [
        item.skuId,
        item.skuName,
        item.qtyCtnSize,
        item.qtyInnerSize
      ]);

      const values = [headers, ...rows];

      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${selectedSpreadsheet.id}/values/${encodeURIComponent(tabName)}!A1:Z1000:clear`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${selectedSpreadsheet.id}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ values })
        }
      );

      if (!res.ok) {
        throw new Error('Gagal menulis data katalog.');
      }

      setStatusMsg({ type: 'success', text: `✓ Berhasil mengekspor ${catalog.length} item katalog ke tab "${tabName}"!` });
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: err.message || 'Gagal mengekspor katalog.' });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleExportCatalog = () => {
    if (!selectedSpreadsheet || !accessToken) return;
    setConfirmModal({
      isOpen: true,
      title: 'EKSPOR KATALOG BARANG',
      message: `Ekspor ${catalog.length} katalog ke Google Spreadsheet "${selectedSpreadsheet.name}"?\n\nData pada lembar "Katalog Barang" akan ditimpa.`,
      confirmText: 'Ya, Ekspor Katalog',
      onConfirm: () => {
        setConfirmModal(null);
        runExportCatalog();
      }
    });
  };

  // 3. EXPORT AUDIT TRAIL LOGS TO SHEET
  const runExportLogs = async () => {
    if (!selectedSpreadsheet || !accessToken) return;

    setIsSyncing(true);
    setStatusMsg(null);
    try {
      const tabName = 'Audit Logs';
      await ensureTabsExist(selectedSpreadsheet.id, [tabName]);

      const headers = ['Timestamp', 'Type', 'SKU ID', 'SKU Name', 'Location From', 'Location To', 'Qty', 'User', 'Description'];
      const rows = logs.map(item => [
        item.timestamp,
        item.type,
        item.skuId,
        item.skuName,
        item.locationFrom,
        item.locationTo,
        item.qty,
        item.user,
        item.description
      ]);

      const values = [headers, ...rows];

      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${selectedSpreadsheet.id}/values/${encodeURIComponent(tabName)}!A1:Z2000:clear`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${selectedSpreadsheet.id}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ values })
        }
      );

      if (!res.ok) {
        throw new Error('Gagal menulis data log.');
      }

      setStatusMsg({ type: 'success', text: `✓ Berhasil mengekspor ${logs.length} baris log ke tab "${tabName}"!` });
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: err.message || 'Gagal mengekspor logs.' });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleExportLogs = () => {
    if (!selectedSpreadsheet || !accessToken) return;
    setConfirmModal({
      isOpen: true,
      title: 'EKSPOR AUDIT LOGS',
      message: `Ekspor ${logs.length} catatan log transaksi ke Google Spreadsheet "${selectedSpreadsheet.name}"?\n\nData pada lembar "Audit Logs" akan ditimpa.`,
      confirmText: 'Ya, Ekspor Logs',
      onConfirm: () => {
        setConfirmModal(null);
        runExportLogs();
      }
    });
  };

  // 4. IMPORT STOCK FROM SHEET
  const handleImportStock = async () => {
    if (!selectedSpreadsheet || !accessToken) return;
    setIsSyncing(true);
    setStatusMsg(null);
    try {
      const tabName = 'Stok Barang';
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${selectedSpreadsheet.id}/values/${encodeURIComponent(tabName)}!A1:I1000`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      if (!res.ok) {
        throw new Error(`Gagal membaca tab "${tabName}". Pastikan lembar tab tersebut ada di spreadsheet Anda.`);
      }

      const data = await res.json();
      const rows: string[][] = data.values;
      
      if (!rows || rows.length < 2) {
        throw new Error('Tab "Stok Barang" kosong atau tidak memiliki baris data.');
      }

      // Check header row (row index 0)
      const h = rows[0].map(item => item?.trim()?.toLowerCase() || '');
      
      const idxSkuId = h.findIndex(col => ['sku id', 'sku', 'kode sku', 'kode barang', 'kode', 'id'].some(s => col === s || col.includes(s)));
      const idxSkuName = h.findIndex(col => ['sku name', 'nama sku', 'nama barang', 'nama', 'item name', 'product name', 'produk'].some(s => col === s || col.includes(s)));
      const idxExp = h.findIndex(col => ['expired date', 'expired', 'tanggal expired', 'ed', 'exp', 'kadaluarsa', 'tanggal kadaluarsa'].some(s => col === s || col.includes(s)));
      const idxLoc = h.findIndex(col => ['location', 'lokasi', 'rak', 'shelf', 'posisi'].some(s => col === s || col.includes(s)));
      const idxQty = h.findIndex(col => ['qty', 'quantity', 'jumlah', 'kuantitas', 'pcs', 'stok', 'stock'].some(s => col === s || col.includes(s)));
      
      // Look for carton size
      const idxCtnSize = h.findIndex(col => ['qty/ctn', 'ctn size', 'karton', 'isi karton', 'dus', 'per karton', 'qty ctn size', 'qty ctn'].some(s => col === s || col.includes(s)));
      // Look for inner size
      const idxInnerSize = h.findIndex(col => ['qty inner', 'inner size', 'inner', 'isi inner', 'per inner', 'inner pcs', 'qty/inner', 'qty inner size'].some(s => col === s || col.includes(s)));

      if (idxSkuId === -1 || idxSkuName === -1 || idxExp === -1 || idxLoc === -1 || idxQty === -1) {
        throw new Error('Kolom wajib tidak lengkap atau tidak ditemukan! Pastikan baris pertama berisi tajuk kolom wajib seperti: SKU ID, SKU Name, Expired Date, Location, Qty');
      }

      const importedItems: StockItem[] = [];
      const errorRows: string[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0 || !row[idxSkuId]) continue; // skip blank rows

        const skuId = row[idxSkuId]?.trim();
        const skuName = row[idxSkuName]?.trim() || 'Produk Baru';
        const expiredDate = row[idxExp]?.trim() || '-';
        const location = row[idxLoc]?.trim() || 'N/A';
        const qtyRaw = parseInt(row[idxQty], 10);
        
        let qtyCtnSize = 0;
        let qtyInnerSize = 0;

        if (idxCtnSize !== -1 && row[idxCtnSize]) {
          qtyCtnSize = parseInt(row[idxCtnSize], 10) || 0;
        }
        if (idxInnerSize !== -1 && row[idxInnerSize]) {
          qtyInnerSize = parseInt(row[idxInnerSize], 10) || 0;
        }

        // Try to autofill packaging size from current catalog if zero
        if (qtyCtnSize === 0 || qtyInnerSize === 0) {
          const catMatch = catalog.find(c => c.skuId.toLowerCase() === skuId.toLowerCase());
          if (catMatch) {
            if (qtyCtnSize === 0) qtyCtnSize = catMatch.qtyCtnSize;
            if (qtyInnerSize === 0) qtyInnerSize = catMatch.qtyInnerSize;
          }
        }

        if (isNaN(qtyRaw) || qtyRaw < 0) {
          errorRows.push(`Baris ${i + 1}: Qty "${row[idxQty]}" tidak valid.`);
          continue;
        }

        const id = getCanonicalStockId(skuId, expiredDate, location);
        const packs = calculatePackQuantities(qtyRaw, qtyCtnSize, qtyInnerSize);
        const normEd = normalizeDateToDmy(expiredDate);
        const status = getExpiredStatus(normEd);

        importedItems.push({
          id,
          skuId,
          skuName,
          expiredDate: normEd,
          location,
          qty: qtyRaw,
          totalQtySku: qtyRaw, // Recalculated dynamically
          qtyCtnSize,
          qtyCtn: packs.qtyCtn,
          qtyInnerSize,
          qtyInner: packs.qtyInner,
          qtyLoose: packs.qtyLoose,
          status
        });
      }

      if (errorRows.length > 0) {
        throw new Error(`Gagal memproses baris berikut:\n${errorRows.slice(0, 5).join('\n')}${errorRows.length > 5 ? '\ndan lainnya...' : ''}`);
      }

      // De-duplicate identical IDs
      const mergedMap = new Map<string, StockItem>();
      importedItems.forEach(item => {
        const existing = mergedMap.get(item.id);
        if (existing) {
          const mergedQty = existing.qty + item.qty;
          const packs = calculatePackQuantities(mergedQty, existing.qtyCtnSize, existing.qtyInnerSize);
          mergedMap.set(item.id, {
            ...existing,
            qty: mergedQty,
            qtyCtn: packs.qtyCtn,
            qtyInner: packs.qtyInner,
            qtyLoose: packs.qtyLoose
          });
        } else {
          mergedMap.set(item.id, item);
        }
      });

      const finalizedStockList = Array.from(mergedMap.values());

      // Recalculate totalQtySku
      const skuTotals: Record<string, number> = {};
      finalizedStockList.forEach(item => {
        skuTotals[item.skuId] = (skuTotals[item.skuId] || 0) + item.qty;
      });

      const finalized = finalizedStockList.map(item => ({
        ...item,
        totalQtySku: skuTotals[item.skuId] || 0
      }));

      // Confirm Overwrite or Merge
      setConfirmModal({
        isOpen: true,
        title: 'IMPORT DATA STOK',
        message: `• Ditemukan ${finalized.length} baris data stok siap di-import.\n\n` +
          `• Klik 'Ya, Impor & Timpa' untuk mengganti (Over-write) seluruh data stok di database dengan data sheet ini.`,
        confirmText: 'Ya, Impor & Timpa',
        onConfirm: () => {
          setConfirmModal(null);
          onUpdateStock(finalized);
          
          // Log this sync operation
          const newLog: DccLog = {
            id: `log_sheet_import_${Date.now()}`,
            timestamp: new Date().toISOString(),
            type: 'ADJUSTMENT',
            skuId: 'SHEETS_IMPORT',
            skuName: 'Sinkronisasi Google Sheets',
            locationFrom: 'Google Sheet',
            locationTo: 'System Stock',
            qty: finalized.reduce((sum, item) => sum + item.qty, 0),
            description: `SINKRONISASI STOK: Over-write stok masal dari Google Sheet "${selectedSpreadsheet.name}". Total ${finalized.length} record stok.`,
            user: currentUser?.fullName || 'Operator Google'
          };
          onUpdateLogs([newLog, ...logs]);

          setStatusMsg({
            type: 'success',
            text: `✓ Sukses meng-overwrite database! ${finalized.length} record stok disinkronkan dari Google Sheets.`
          });
        }
      });
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: err.message || 'Gagal memproses import data stok.' });
    } finally {
      setIsSyncing(false);
    }
  };

  // 5. IMPORT CATALOG FROM SHEET
  const handleImportCatalog = async () => {
    if (!selectedSpreadsheet || !accessToken) return;
    setIsSyncing(true);
    setStatusMsg(null);
    try {
      const tabName = 'Katalog Barang';
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${selectedSpreadsheet.id}/values/${encodeURIComponent(tabName)}!A1:D1000`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      if (!res.ok) {
        throw new Error(`Gagal membaca tab "${tabName}". Pastikan lembar tab tersebut ada.`);
      }

      const data = await res.json();
      const rows: string[][] = data.values;
      
      if (!rows || rows.length < 2) {
        throw new Error('Tab "Katalog Barang" kosong atau tidak memiliki data.');
      }

      const h = rows[0].map(item => item?.trim()?.toLowerCase() || '');
      const idxSkuId = h.findIndex(col => ['sku id', 'sku', 'kode sku', 'kode barang', 'kode', 'id'].some(s => col === s || col.includes(s)));
      const idxSkuName = h.findIndex(col => ['sku name', 'nama sku', 'nama barang', 'nama', 'item name', 'product name', 'produk'].some(s => col === s || col.includes(s)));
      const idxCtnSize = h.findIndex(col => ['qty/ctn', 'ctn size', 'karton', 'isi karton', 'dus', 'per karton', 'qty ctn size', 'qty ctn'].some(s => col === s || col.includes(s)));
      const idxInnerSize = h.findIndex(col => ['qty inner', 'inner size', 'inner', 'isi inner', 'per inner', 'inner pcs', 'qty/inner', 'qty inner size'].some(s => col === s || col.includes(s)));

      if (idxSkuId === -1 || idxSkuName === -1 || idxCtnSize === -1 || idxInnerSize === -1) {
        throw new Error('Kolom wajib katalog tidak lengkap atau tidak ditemukan! Pastikan kolom berisikan: SKU ID, SKU Name, Qty CTN Size, Qty Inner Size');
      }

      const importedCatalog: CatalogItem[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0 || !row[idxSkuId]) continue;

        const skuId = row[idxSkuId].trim();
        const skuName = row[idxSkuName].trim();
        const qtyCtnSize = parseInt(row[idxCtnSize], 10) || 0;
        const qtyInnerSize = parseInt(row[idxInnerSize], 10) || 0;

        importedCatalog.push({
          id: skuId.toUpperCase(),
          skuId,
          skuName,
          qtyCtnSize,
          qtyInnerSize
        });
      }

      setConfirmModal({
        isOpen: true,
        title: 'IMPORT KATALOG BARANG',
        message: `Ingin menimpa data katalog saat ini dengan ${importedCatalog.length} item dari Google Sheets?`,
        confirmText: 'Ya, Impor Katalog',
        onConfirm: async () => {
          setConfirmModal(null);
          try {
            // Save to Supabase batch
            const batch = writeBatch(db);
            importedCatalog.forEach(item => {
              batch.set(doc(db, 'catalog', item.id), item);
            });
            await batch.commit();

            onUpdateCatalog(importedCatalog);

            setStatusMsg({
              type: 'success',
              text: `✓ Berhasil memperbarui ${importedCatalog.length} katalog produk dari Google Sheets!`
            });
          } catch (e: any) {
            console.error(e);
            setStatusMsg({ type: 'error', text: 'Gagal memperbarui katalog di Supabase.' });
          }
        }
      });
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: err.message || 'Gagal memproses import katalog.' });
    } finally {
      setIsSyncing(false);
    }
  };

  // Filter drive files based on query
  const filteredFiles = driveFiles.filter(f => 
    f.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Upper Status Banner */}
      <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20 text-emerald-400">
            <Cloud className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              Google Workspace Integrator
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Hubungkan sistem manajemen pergudangan WMS ini langsung dengan Google Sheets dan Google Drive Anda untuk backup otomatis dan sinkronisasi dua arah.
            </p>
          </div>
        </div>

        {/* Auth Action */}
        <div className="flex items-center gap-2.5">
          {!accessToken ? (
            <button
              onClick={() => handleConnectGoogle()}
              disabled={isLoggingIn}
              className="gsi-material-button w-full sm:w-auto hover:scale-[1.02] transition-transform shadow-lg shadow-emerald-500/5"
            >
              <div className="gsi-material-button-state"></div>
              <div className="gsi-material-button-content-wrapper flex items-center gap-2.5 px-4 py-2.5">
                <div className="gsi-material-button-icon">
                  <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style={{ display: "block", width: "18px", height: "18px" }}>
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                    <path fill="none" d="M0 0h48v48H0z"></path>
                  </svg>
                </div>
                <span className="gsi-material-button-contents text-slate-250 text-xs font-bold font-sans">Sambungkan Google</span>
              </div>
            </button>
          ) : (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold px-3 py-1.5 rounded-xl text-center">
                ● Tersambung: {googleUser?.email || 'Google Drive'}
              </div>
              <button
                onClick={handleDisconnectGoogle}
                className="flex items-center justify-center gap-1.5 text-xs text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/15 border border-rose-500/10 px-3 py-1.5 rounded-xl cursor-pointer transition-colors"
                title="Disconnect Google Account"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Disconnect</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Custom Confirmation Modal */}
      {confirmModal && confirmModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-[#141822] border border-slate-700/80 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-start gap-3.5">
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div className="space-y-1.5 min-w-0 flex-1">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">{confirmModal.title}</h3>
                <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-line">{confirmModal.message}</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-800">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-extrabold transition-all cursor-pointer shadow-lg shadow-emerald-500/20"
              >
                {confirmModal.confirmText || 'Konfirmasi'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Status Msg */}
      {statusMsg && (
        <div className={`p-4 rounded-xl border flex items-start gap-3 text-xs ${
          statusMsg.type === 'success' 
            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
            : statusMsg.type === 'error'
            ? 'bg-rose-500/10 border-rose-500/25 text-rose-450'
            : 'bg-indigo-500/10 border-indigo-500/25 text-indigo-400'
        }`}>
          {statusMsg.type === 'error' ? (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <span className="whitespace-pre-line leading-relaxed">{statusMsg.text}</span>
        </div>
      )}

      {accessToken ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* LEFT: Spreadsheet Selection / File Browser (Col 5) */}
          <div className="lg:col-span-5 bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 space-y-4">
            <div className="border-b border-slate-800/60 pb-3">
              <h3 className="text-sm font-extrabold text-white uppercase tracking-wider flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                Pilih Google Sheet
              </h3>
              <p className="text-[11px] text-slate-500 mt-1">
                Pilih lembar kerja spreadsheet untuk sinkronisasi data master.
              </p>
            </div>

            {/* Selected Spreadsheet Card */}
            {selectedSpreadsheet ? (
              <div className="bg-[#161B25] border border-emerald-500/20 p-4 rounded-xl flex items-center justify-between gap-3 shadow-lg shadow-emerald-500/5">
                <div className="space-y-1 min-w-0">
                  <span className="text-[9px] uppercase tracking-wider font-black text-emerald-400 block">SPREADSHEET TERHUBUNG:</span>
                  <span className="text-xs font-bold text-slate-200 block truncate" title={selectedSpreadsheet.name}>
                    {selectedSpreadsheet.name}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500 block truncate">
                    ID: {selectedSpreadsheet.id}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <a
                    href={`https://docs.google.com/spreadsheets/d/${selectedSpreadsheet.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                    title="Buka Spreadsheet di Tab Baru"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    onClick={() => setSelectedSpreadsheet(null)}
                    className="p-1.5 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/10 rounded-lg text-rose-400 hover:text-rose-300 transition-colors text-xs font-bold"
                    title="Lepas Spreadsheet"
                  >
                    Ubah
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-slate-950/40 p-4 rounded-xl border border-dashed border-slate-800 text-center space-y-3">
                <p className="text-xs text-slate-400">Belum ada spreadsheet yang terhubung.</p>
                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                  <button
                    onClick={handleCreateNewSpreadsheet}
                    disabled={isSyncing}
                    className="text-xs font-bold px-3 py-1.5 bg-emerald-500 text-slate-950 hover:bg-emerald-400 rounded-xl flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    Buat Baru di Drive
                  </button>
                </div>
              </div>
            )}

            {/* Input Manual Spreadsheet ID / URL */}
            <div className="space-y-2">
              <label className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block">Hubungkan via URL / ID Spreadsheet:</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="https://docs.google.com/spreadsheets/d/... atau ID"
                  value={manualSheetId}
                  onChange={(e) => setManualSheetId(e.target.value)}
                  className="flex-1 bg-[#161B25] border border-slate-800 focus:border-emerald-500 text-xs rounded-xl px-3 py-2 outline-none text-slate-300"
                />
                <button
                  onClick={handleBindManualSheet}
                  disabled={!manualSheetId.trim() || isSyncing}
                  className="bg-slate-800 hover:bg-slate-750 text-white border border-slate-700 px-3 py-2 rounded-xl text-xs font-bold disabled:opacity-50 transition-colors"
                >
                  Hubungkan
                </button>
              </div>
            </div>

            {/* Drive Browser List */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Browser Google Drive:</span>
                <button
                  onClick={fetchSpreadsheets}
                  disabled={isLoadingFiles}
                  className="p-1 hover:bg-slate-800/60 rounded text-slate-400 hover:text-slate-200 transition-colors"
                  title="Segarkan Folder Drive"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingFiles ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {/* Search drive */}
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-2.5 text-slate-500">
                  <Search className="w-3.5 h-3.5" />
                </span>
                <input
                  type="text"
                  placeholder="Cari Google Sheet..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-[#161B25] border border-slate-800 focus:border-emerald-500 text-xs rounded-xl pl-8 pr-3 py-2 outline-none text-slate-300"
                />
              </div>

              {/* File list container */}
              <div className="bg-[#141821]/60 rounded-xl border border-slate-800/80 overflow-hidden divide-y divide-slate-800/50 max-h-[220px] overflow-y-auto scrollbar-thin">
                {isLoadingFiles ? (
                  <div className="p-8 text-center text-slate-500 text-xs flex items-center justify-center gap-1.5">
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                    Memuat dari Drive...
                  </div>
                ) : filteredFiles.length === 0 ? (
                  <div className="p-8 text-center text-slate-500 text-xs">
                    Tidak ditemukan Spreadsheet.
                  </div>
                ) : (
                  filteredFiles.map((file) => (
                    <div 
                      key={file.id} 
                      className={`p-3 flex items-center justify-between gap-3 text-xs hover:bg-[#1A202D]/40 transition-colors cursor-pointer ${
                        selectedSpreadsheet?.id === file.id ? 'bg-[#1A202D]/60' : ''
                      }`}
                      onClick={() => setSelectedSpreadsheet({ id: file.id, name: file.name })}
                    >
                      <div className="min-w-0 flex-1">
                        <span className="font-semibold text-slate-200 block truncate" title={file.name}>
                          {file.name}
                        </span>
                        <span className="text-[9px] text-slate-500 block">
                          Dimodifikasi: {new Date(file.modifiedTime).toLocaleDateString('id-ID')}
                        </span>
                      </div>
                      {selectedSpreadsheet?.id === file.id && (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: Synchronizer Console (Col 7) */}
          <div className="lg:col-span-7 space-y-6">
            {/* Sync Console */}
            <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 space-y-5">
              <div className="border-b border-slate-800/60 pb-3">
                <h3 className="text-sm font-extrabold text-white uppercase tracking-wider flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-emerald-400" />
                  Pusat Sinkronisasi Data Master
                </h3>
                <p className="text-[11px] text-slate-500 mt-1">
                  Pilih tindakan ekspor atau impor di bawah ini untuk mentransfer data secara instan.
                </p>
              </div>

              {!selectedSpreadsheet ? (
                <div className="flex flex-col items-center justify-center p-12 bg-slate-950/20 border border-dashed border-slate-800 rounded-2xl text-center space-y-2">
                  <Info className="w-8 h-8 text-slate-500" />
                  <p className="text-xs font-semibold text-slate-400">Konsol Terkunci</p>
                  <p className="text-[11px] text-slate-500 max-w-sm leading-relaxed">
                    Harap buat atau pilih salah satu Google Sheet di sebelah kiri untuk mulai mengaktifkan konsol sinkronisasi data.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {/* Export Box */}
                  <div className="bg-[#141922] border border-slate-800 p-4 rounded-xl space-y-3.5">
                    <div className="border-b border-slate-800/60 pb-2">
                      <span className="text-[10px] uppercase font-black text-rose-450 tracking-wider flex items-center gap-1.5">
                        <Upload className="w-3 h-3" />
                        Ekspor ke Google Sheet
                      </span>
                      <p className="text-[10px] text-slate-500 mt-0.5">Tulis data lokal ke cloud Google Sheets.</p>
                    </div>

                    <div className="space-y-2">
                      {/* Export Stock */}
                      <button
                        onClick={handleExportStock}
                        disabled={isSyncing}
                        className="w-full text-left text-xs bg-slate-900 hover:bg-slate-850 text-slate-200 hover:text-white border border-slate-800/85 hover:border-slate-700 p-3 rounded-lg flex items-center justify-between cursor-pointer disabled:opacity-50 transition-all"
                      >
                        <div className="flex items-center gap-2.5">
                          <PackageIcon className="w-4 h-4 text-rose-400 shrink-0" />
                          <div>
                            <span className="font-bold block">Ekspor Stok Barang</span>
                            <span className="text-[9px] text-slate-500 font-mono block">{stock.length} baris siap diekspor</span>
                          </div>
                        </div>
                        <Download className="w-3.5 h-3.5 text-slate-400" />
                      </button>

                      {/* Export Catalog */}
                      <button
                        onClick={handleExportCatalog}
                        disabled={isSyncing}
                        className="w-full text-left text-xs bg-slate-900 hover:bg-slate-850 text-slate-200 hover:text-white border border-slate-800/85 hover:border-slate-700 p-3 rounded-lg flex items-center justify-between cursor-pointer disabled:opacity-50 transition-all"
                      >
                        <div className="flex items-center gap-2.5">
                          <Database className="w-4 h-4 text-indigo-400 shrink-0" />
                          <div>
                            <span className="font-bold block">Ekspor Katalog Produk</span>
                            <span className="text-[9px] text-slate-500 font-mono block">{catalog.length} item siap diekspor</span>
                          </div>
                        </div>
                        <Download className="w-3.5 h-3.5 text-slate-400" />
                      </button>

                      {/* Export Logs */}
                      <button
                        onClick={handleExportLogs}
                        disabled={isSyncing}
                        className="w-full text-left text-xs bg-slate-900 hover:bg-slate-850 text-slate-200 hover:text-white border border-slate-800/85 hover:border-slate-700 p-3 rounded-lg flex items-center justify-between cursor-pointer disabled:opacity-50 transition-all"
                      >
                        <div className="flex items-center gap-2.5">
                          <FileText className="w-4 h-4 text-emerald-400 shrink-0" />
                          <div>
                            <span className="font-bold block">Ekspor Audit Trail Logs</span>
                            <span className="text-[9px] text-slate-500 font-mono block">{logs.length} catatan logs siap diekspor</span>
                          </div>
                        </div>
                        <Download className="w-3.5 h-3.5 text-slate-400" />
                      </button>
                    </div>
                  </div>

                  {/* Import Box */}
                  <div className="bg-[#141922] border border-slate-800 p-4 rounded-xl space-y-3.5">
                    <div className="border-b border-slate-800/60 pb-2">
                      <span className="text-[10px] uppercase font-black text-emerald-450 tracking-wider flex items-center gap-1.5">
                        <Download className="w-3 h-3" />
                        Impor dari Google Sheet
                      </span>
                      <p className="text-[10px] text-slate-500 mt-0.5">Tarik dan timpa data lokal dari Google Sheets.</p>
                    </div>

                    <div className="space-y-2">
                      {/* Import Stock */}
                      <button
                        onClick={handleImportStock}
                        disabled={isSyncing}
                        className="w-full text-left text-xs bg-slate-900 hover:bg-slate-850 text-slate-200 hover:text-white border border-slate-800/85 hover:border-slate-700 p-3 rounded-lg flex items-center justify-between cursor-pointer disabled:opacity-50 transition-all"
                      >
                        <div className="flex items-center gap-2.5">
                          <PackageIcon className="w-4 h-4 text-emerald-400 shrink-0" />
                          <div>
                            <span className="font-bold block">Impor Stok Barang</span>
                            <span className="text-[9px] text-slate-500 block">Menarik data dari tab "Stok Barang"</span>
                          </div>
                        </div>
                        <Upload className="w-3.5 h-3.5 text-slate-450" />
                      </button>

                      {/* Import Catalog */}
                      <button
                        onClick={handleImportCatalog}
                        disabled={isSyncing}
                        className="w-full text-left text-xs bg-slate-900 hover:bg-slate-850 text-slate-200 hover:text-white border border-slate-800/85 hover:border-slate-700 p-3 rounded-lg flex items-center justify-between cursor-pointer disabled:opacity-50 transition-all"
                      >
                        <div className="flex items-center gap-2.5">
                          <Database className="w-4 h-4 text-indigo-400 shrink-0" />
                          <div>
                            <span className="font-bold block">Impor Katalog Produk</span>
                            <span className="text-[9px] text-slate-500 block">Menarik data dari tab "Katalog Barang"</span>
                          </div>
                        </div>
                        <Upload className="w-3.5 h-3.5 text-slate-450" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Template Format Instructions card */}
            <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 space-y-3.5">
              <h4 className="text-xs font-extrabold text-slate-200 uppercase tracking-widest flex items-center gap-1.5">
                <Info className="w-4 h-4 text-emerald-400" />
                Panduan Format Sinkronisasi Google Sheets
              </h4>
              <div className="text-xs text-slate-400 space-y-2.5 leading-relaxed">
                <p>
                  Untuk memastikan impor data berjalan lancar tanpa hambatan, struktur kolom pada lembar kerja Google Sheets harus sesuai ketentuan:
                </p>
                <div className="space-y-1.5 pl-3 border-l-2 border-slate-800">
                  <div>
                    <strong className="text-slate-300">Tab "Stok Barang":</strong>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Kolom baris pertama wajib: <code className="text-emerald-400 font-mono bg-emerald-500/5 px-1 py-0.5 rounded">SKU ID</code>, <code className="text-emerald-400 font-mono bg-emerald-500/5 px-1 py-0.5 rounded">SKU Name</code>, <code className="text-emerald-400 font-mono bg-emerald-500/5 px-1 py-0.5 rounded">Expired Date</code>, <code className="text-emerald-400 font-mono bg-emerald-500/5 px-1 py-0.5 rounded">Location</code>, <code className="text-emerald-400 font-mono bg-emerald-500/5 px-1 py-0.5 rounded">Qty</code>. 
                    </p>
                    <p className="text-[10px] text-slate-500 italic">
                      *Tips: Format Tanggal Expired DD/MM/YYYY atau "No Expired". Qty harus berupa bilangan bulat positif.
                    </p>
                  </div>
                  <div className="pt-1.5">
                    <strong className="text-slate-300">Tab "Katalog Barang":</strong>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Kolom baris pertama wajib: <code className="text-indigo-400 font-mono bg-indigo-500/5 px-1 py-0.5 rounded">SKU ID</code>, <code className="text-indigo-400 font-mono bg-indigo-500/5 px-1 py-0.5 rounded">SKU Name</code>, <code className="text-indigo-400 font-mono bg-indigo-500/5 px-1 py-0.5 rounded">Qty CTN Size</code>, <code className="text-indigo-400 font-mono bg-indigo-500/5 px-1 py-0.5 rounded">Qty Inner Size</code>.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-8 text-center space-y-5 max-w-lg mx-auto shadow-2xl">
          <div className="bg-slate-900 p-4 rounded-full w-16 h-16 flex items-center justify-center mx-auto border border-slate-800">
            <Cloud className="w-8 h-8 text-emerald-400 animate-pulse" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-base font-bold text-white">Google Integration Terkunci</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Hubungkan akun Google Anda untuk membaca dan menulis lembar kerja spreadsheet secara otomatis di Google Drive Anda.
            </p>
          </div>

          <div className="space-y-2.5 pt-2">
            {/* Primary Popup Connect Button */}
            <button
              onClick={() => handleConnectGoogle(false)}
              disabled={isLoggingIn}
              className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-500/10 cursor-pointer uppercase tracking-wider disabled:opacity-50"
            >
              {isLoggingIn ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Cloud className="w-4 h-4" />
              )}
              Sambungkan Akun Google (Pop-up)
            </button>

            {/* Redirect Fallback Connect Button */}
            <button
              onClick={() => handleConnectGoogle(true)}
              disabled={isLoggingIn}
              className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl flex items-center justify-center gap-2 border border-slate-700 transition-all cursor-pointer disabled:opacity-50"
            >
              <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
              Masuk via Redirect
            </button>

            {/* Manual OAuth Access Token Toggle */}
            <button
              onClick={() => setShowManualTokenInput(!showManualTokenInput)}
              className="w-full py-2 text-indigo-400 hover:text-indigo-300 font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <span>{showManualTokenInput ? '▲ Sembunyikan Form Token Manual' : '▼ Gunakan Access Token Manual (Koneksi Langsung)'}</span>
            </button>
          </div>

          {/* Manual Access Token Form */}
          {showManualTokenInput && (
            <div className="p-4 bg-slate-950/80 border border-indigo-500/30 rounded-xl text-left space-y-3 animate-in fade-in duration-200">
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-200 block">Input Google OAuth Access Token:</label>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  Bypass pemblokiran pop-up Chrome dengan memasukkan OAuth Access Token langsung.
                </p>
              </div>
              <div className="space-y-2">
                <input
                  type="password"
                  placeholder="ya29.a0A..."
                  value={manualAccessToken}
                  onChange={(e) => setManualAccessToken(e.target.value)}
                  className="w-full bg-[#161B25] border border-slate-800 focus:border-indigo-500 text-xs rounded-xl px-3 py-2 outline-none text-slate-200 font-mono"
                />
                <button
                  onClick={handleVerifyManualToken}
                  disabled={!manualAccessToken.trim() || isVerifyingToken}
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
                >
                  {isVerifyingToken ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Verifikasi & Sambungkan Token
                </button>
              </div>
            </div>
          )}

          {/* Chrome Popup Fix Instructions */}
          <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl text-left text-[11px] text-slate-400 space-y-2">
            <span className="font-bold text-slate-300 block flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              Cara Mengatasi Pop-up Terblokir di Chrome:
            </span>
            <ol className="text-[10px] text-slate-400 space-y-1 pl-4 list-decimal leading-relaxed">
              <li>Lihat ke sudut kanan <strong>Address Bar Chrome</strong> (sebelah kanan URL web).</li>
              <li>Klik ikon <strong>Pop-up diblokir</strong> 🚫 (atau ikon gembok 🔒).</li>
              <li>Pilih <strong className="text-emerald-400">"Selalu izinkan pop-up dan pengalihan dari [URL ini]"</strong>.</li>
              <li>Klik tombol <strong className="text-white">"Sambungkan Akun Google"</strong> sekali lagi.</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

// Simple internal icon for layout consistency
function PackageIcon({ className }: { className?: string }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      fill="none" 
      viewBox="0 0 24 24" 
      strokeWidth={2} 
      stroke="currentColor" 
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
    </svg>
  );
}
