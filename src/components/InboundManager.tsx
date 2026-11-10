import ModalFrame from './ModalFrame';
import React, { useState, useEffect, useRef } from 'react';
import { collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch } from '../supabase';
import { db, handleSupabaseError, OperationType } from '../supabase';
import { StockItem, DccLog, CatalogItem, InboundReceiptItem, isInboundReceiptItem } from '../types';
import { getProductPackSizes, calculatePackQuantities, formatNumber, getExpiredStatus, normalizeDateToDmy, getCanonicalStockId, findStockIndex, getStockStatus, isNoExpiryDate } from '../utils/calculations';
import { findSkuId } from '../data/barcodeMap';
import * as XLSX from 'xlsx';
import { 
  Truck, 
  PackageCheck, 
  Plus, 
  CheckCircle2, 
  AlertTriangle, 
  Search, 
  ShieldCheck, 
  ArrowRight,
  Sparkles,
  ClipboardList,
  Building2,
  MapPin,
  Trash2,
  X,
  FileText,
  Upload,
  Download,
  Send,
  Layers,
  FileSpreadsheet,
  RefreshCw,
  Boxes,
  HelpCircle,
  FileCheck2,
  SlidersHorizontal,
  ChevronDown
} from 'lucide-react';

interface InboundManagerProps {
  stock: StockItem[];
  catalog: CatalogItem[];
  onUpdateStock: (updatedStock: StockItem[]) => void;
  onAddLog: (log: Omit<DccLog, 'id' | 'timestamp'>) => void;
  onAddBatchLogs?: (logs: Omit<DccLog, 'id' | 'timestamp'>[]) => void;
  currentUser: any;
}

interface ParsedInboundRow {
  id: string;
  lineIndex: number;
  skuId: string;
  skuName: string;
  qty: number;
  location: string;
  expiredDate: string;
  poNumber?: string;
  supplierName?: string;
  notes?: string;
  originalText: string;
  isValid: boolean;
  error?: string;
}

export default function InboundManager({
  stock,
  catalog,
  onUpdateStock,
  onAddLog,
  onAddBatchLogs,
  currentUser
}: InboundManagerProps) {
  // Inbound History State
  const [inboundHistory, setInboundHistory] = useState<InboundReceiptItem[]>([]);

  // Supabase Realtime Listener
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'inbound'), (snapshot) => {
      const list: InboundReceiptItem[] = [];
      let invalidRecordCount = 0;
      snapshot.forEach(d => {
        const item = d.data();
        if (!isInboundReceiptItem(item)) {
          invalidRecordCount++;
          return;
        }
        list.push(item);
      });
      if (invalidRecordCount > 0) {
        handleSupabaseError(
          new Error(`${invalidRecordCount} dokumen inbound memiliki format tidak valid; riwayat yang sedang ditampilkan dipertahankan.`),
          OperationType.GET,
          'inbound'
        );
        return;
      }
      list.sort((a, b) => new Date(b.receivedDate).getTime() - new Date(a.receivedDate).getTime());
      setInboundHistory(list);
    }, (err) => {
      console.warn('Inbound Supabase listener failed:', err);
      handleSupabaseError(err, OperationType.GET, 'inbound');
    });
    return () => unsub();
  }, []);

  const inboundLock = useRef(false);
  const commitInbound = async (updatedStock:StockItem[] | null, logItems:Omit<DccLog,'id'|'timestamp'>[], receipts:InboundReceiptItem[]) => {
    if (updatedStock) for (const row of updatedStock) {
      const before = stock.find(s => s.id === row.id);
      if (before && (['Damage','Expired'].includes(getStockStatus(before)) || /karantina|quarantine|qc[ _-]*hold/i.test(before.location)) && getStockStatus(before) !== getStockStatus(row)) {
        throw new Error(`Inbound tidak boleh mengubah kondisi stok rusak atau ditahan pada rak [${row.location}]. Pilih rak tujuan lain.`);
      }
    }
    const batch=writeBatch(db);
    if(updatedStock){
      const skuTotals:Record<string,number>={};
      for(const row of updatedStock){const k=row.skuId.trim().toUpperCase();skuTotals[k]=(skuTotals[k]||0)+row.qty;}
      for(const row of updatedStock){const before=stock.find(s=>s.id===row.id);if(!before || before.qty!==row.qty) batch.set(doc(db,'stock',row.id),{...row,totalQtySku:skuTotals[row.skuId.trim().toUpperCase()]??row.qty});}
    }
    for(const log of logItems){const id='inbound_log_'+crypto.randomUUID();batch.set(doc(db,'logs',id),{...log,id,timestamp:new Date().toISOString()});}
    for(const row of receipts) batch.set(doc(db,'inbound',row.id),row);
    await batch.commit();
  };
  const saveInboundHistory = async (items:InboundReceiptItem[]) => {
    const changed=items.filter(row=>JSON.stringify(inboundHistory.find(old=>old.id===row.id))!==JSON.stringify(row));
    await commitInbound(null,[],changed);
  };

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeImportTab, setActiveImportTab] = useState<'excel' | 'text' | 'manual'>('excel');

  // Direct Execution Option: "INSTANT_PUTAWAY" (Langsung Masuk Stok) vs "INBOUND_QUEUE" (Masuk Antrean Inbound / QC)
  const [executionMode, setExecutionMode] = useState<'INSTANT_PUTAWAY' | 'INBOUND_QUEUE'>('INSTANT_PUTAWAY');

  // Header PO Metadata States
  const [poNumber, setPoNumber] = useState(() => {
    const today = new Date();
    const yyyymm = today.toISOString().slice(0, 7).replace('-', '');
    return `PO-${yyyymm}-${Math.floor(100 + Math.random() * 900)}`;
  });
  const [supplierName, setSupplierName] = useState('Supplier Contoh');
  const [defaultLocation, setDefaultLocation] = useState('RAK-A01');
  const [defaultExpDate, setDefaultExpDate] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 2);
    return d.toISOString().slice(0, 10);
  });
  const [qcStatus, setQcStatus] = useState<'RECEIVED' | 'QC_HOLD'>('RECEIVED');
  const [notes, setNotes] = useState('Penerimaan Inbound Massal');

  // Raw Input & Drag Drop
  const [inputText, setInputText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Manual Row Builder States
  const [selectedSku, setSelectedSku] = useState('');
  const [manualQty, setManualQty] = useState('');
  const [manualLoc, setManualLoc] = useState('');
  const [manualExp, setManualExp] = useState('');

  // Search & Filters for History
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');

  // Parsed Rows for Live Preview
  const [parsedRows, setParsedRows] = useState<ParsedInboundRow[]>([]);

  // Parse Text Input into Multi-SKU Parsed Rows
  useEffect(() => {
    if (!inputText.trim()) {
      setParsedRows([]);
      return;
    }

    const lines = inputText.split('\n');
    const results: ParsedInboundRow[] = [];
    let detectedPoInText = '';
    let detectedSupplierInText = '';

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Skip comments
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
        return;
      }

      // Smart delimiter detection: tab, pipe, semicolon, or comma
      let parts: string[];
      if (trimmed.includes('\t')) {
        parts = trimmed.split('\t').map(p => p.trim());
      } else if (trimmed.includes('|')) {
        parts = trimmed.split('|').map(p => p.trim());
      } else if (trimmed.includes(';')) {
        parts = trimmed.split(';').map(p => p.trim());
      } else if (trimmed.includes(',')) {
        parts = trimmed.split(',').map(p => p.trim());
      } else {
        parts = trimmed.split(/\s+/).map(p => p.trim());
      }
      parts = parts.filter(p => p.length > 0);

      if (parts.length === 0) return;

      // Skip actual header row (e.g. "SKU ID", "Qty Diterima", "Nama Barang", etc.)
      const firstCellNorm = (parts[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const secondCellNorm = (parts[1] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const isHeaderFirst = /^(sku|skuid|kodesku|kodebarang|kode|itemcode|nopo|nomorpo|supplier|principal|no)$/.test(firstCellNorm);
      const isHeaderSecond = /^(qty|quantity|jumlah|pcs|supplier|principal|namabarang|itemname|deskripsi|nama)$/.test(secondCellNorm);
      if (isHeaderFirst && isHeaderSecond) {
        return; // Skip table header row
      }

      let rowSku = '';
      let rowQtyStr = '';
      let rowLoc = '';
      let rowExp = '';
      let rowPo = '';
      let rowSupplier = '';
      let rowNotes = '';

      // Pattern A: Template format 6-8 columns:
      // [No PO, Supplier, SKU ID, Nama Barang, Qty Diterima, Lokasi Target, Expired Date, Catatan]
      if (parts.length >= 6 && (parts[0].toUpperCase().startsWith('PO') || parts[0].includes('/') || isNaN(Number(parts[1].replace(/[^\d]/g, ''))))) {
        rowPo = parts[0] || '';
        rowSupplier = parts[1] || '';
        rowSku = parts[2] || '';
        rowQtyStr = parts[4] || '';
        rowLoc = parts[5] || '';
        rowExp = parts[6] || '';
        rowNotes = parts[7] || '';
      } 
      // Pattern B: 5 columns: SKU, Nama, Qty, Lokasi, Exp Date
      else if (parts.length >= 5 && isNaN(Number(parts[1].replace(/[^\d]/g, '')))) {
        rowSku = parts[0] || '';
        rowQtyStr = parts[2] || '';
        rowLoc = parts[3] || '';
        rowExp = parts[4] || '';
      } 
      // Pattern C: Standard 2-4 columns: SKU, Qty, [Lokasi], [Exp Date]
      else {
        rowSku = parts[0] || '';
        rowQtyStr = parts[1] || '';
        rowLoc = parts[2] || '';
        rowExp = parts[3] || '';
      }

      if (rowPo && !detectedPoInText) detectedPoInText = rowPo;
      if (rowSupplier && !detectedSupplierInText) detectedSupplierInText = rowSupplier;

      if (!rowSku) {
        results.push({
          id: `line-${idx}`,
          lineIndex: idx,
          skuId: 'UNKNOWN',
          skuName: 'Unknown Item',
          qty: 0,
          location: defaultLocation || 'RAK-A01',
          expiredDate: normalizeDateToDmy(defaultExpDate) || '31/12/2028',
          originalText: trimmed,
          isValid: false,
          error: 'Format baris tidak valid. SKU ID tidak ditemukan.'
        });
        return;
      }

      const cleanSkuId = findSkuId(rowSku).toUpperCase();
      const sanitizedQty = /^\d+$/.test(rowQtyStr.trim()) ? Number(rowQtyStr) : NaN;
      const lineLoc = (rowLoc || defaultLocation || 'RAK-A01').toUpperCase();
      const lineExpDate = normalizeDateToDmy(rowExp) || normalizeDateToDmy(defaultExpDate) || '31/12/2028';

      if (!Number.isSafeInteger(sanitizedQty) || sanitizedQty <= 0) {
        results.push({
          id: `line-${idx}`,
          lineIndex: idx,
          skuId: cleanSkuId,
          skuName: 'Item Belum Terdeteksi',
          qty: 0,
          location: lineLoc,
          expiredDate: lineExpDate,
          originalText: trimmed,
          isValid: false,
          error: `Kuantitas "${rowQtyStr || '0'}" harus berupa angka bulat positif.`
        });
        return;
      }

      // Find Name in Catalog or Stock
      const catalogMatch = catalog.find(c => c.skuId.toUpperCase() === cleanSkuId || c.skuId.toUpperCase() === rowSku.toUpperCase());
      const stockMatch = stock.find(s => s.skuId.toUpperCase() === cleanSkuId || s.skuId.toUpperCase() === rowSku.toUpperCase());
      const skuName = catalogMatch?.skuName || stockMatch?.skuName || `${cleanSkuId} Product`;

      results.push({
        id: `line-${idx}`,
        lineIndex: idx,
        skuId: cleanSkuId,
        skuName,
        qty: sanitizedQty,
        location: lineLoc,
        expiredDate: lineExpDate,
        poNumber: rowPo,
        supplierName: rowSupplier,
        notes: rowNotes,
        originalText: trimmed,
        isValid: true
      });
    });

    if (detectedPoInText && (!poNumber || poNumber.startsWith('PO-'))) {
      setPoNumber(detectedPoInText);
    }
    if (detectedSupplierInText && (!supplierName || supplierName === 'Supplier Contoh')) {
      setSupplierName(detectedSupplierInText);
    }

    setParsedRows(results);
  }, [inputText, defaultLocation, defaultExpDate, catalog, stock]);

  // Excel Download Template Handler
  const handleDownloadTemplateExcel = () => {
    const templateData = [
      {
        'No PO / Surat Jalan': 'PO-2026/09/001',
        'Supplier / Principal': 'Supplier Contoh',
        'SKU ID': 'SKU-001',
        'Nama Barang': 'Barang Contoh 1',
        'Qty Diterima (Pcs)': 240,
        'Lokasi Target': 'RAK-A01',
        'Expired Date (DD/MM/YYYY)': '15/08/2028',
        'Catatan': 'Penerimaan Inbound Kontainer B2B'
      },
      {
        'No PO / Surat Jalan': 'PO-2026/09/001',
        'Supplier / Principal': 'Supplier Contoh',
        'SKU ID': 'SKU-002',
        'Nama Barang': 'Barang Contoh 2',
        'Qty Diterima (Pcs)': 180,
        'Lokasi Target': 'RAK-A01',
        'Expired Date (DD/MM/YYYY)': '15/08/2028',
        'Catatan': 'Penerimaan Inbound Kontainer B2B'
      },
      {
        'No PO / Surat Jalan': 'PO-2026/09/002',
        'Supplier / Principal': 'Supplier Contoh',
        'SKU ID': 'SKU-003',
        'Nama Barang': 'Barang Contoh 3',
        'Qty Diterima (Pcs)': 500,
        'Lokasi Target': 'RAK-A03',
        'Expired Date (DD/MM/YYYY)': '31/12/2028',
        'Catatan': 'Restock Gudang Utama'
      },
      {
        'No PO / Surat Jalan': 'PO-2026/09/002',
        'Supplier / Principal': 'Supplier Contoh',
        'SKU ID': 'SKU-004',
        'Nama Barang': 'Barang Contoh 4',
        'Qty Diterima (Pcs)': 300,
        'Lokasi Target': 'RAK-A04',
        'Expired Date (DD/MM/YYYY)': '10/05/2028',
        'Catatan': 'Restock Gudang Utama'
      }
    ];

    const worksheet = XLSX.utils.json_to_sheet(templateData);

    // Auto-fit column widths
    const colWidths = [
      { wch: 22 }, // No PO
      { wch: 30 }, // Supplier
      { wch: 18 }, // SKU ID
      { wch: 40 }, // Nama Barang
      { wch: 20 }, // Qty
      { wch: 16 }, // Lokasi
      { wch: 26 }, // Exp Date
      { wch: 35 }  // Catatan
    ];
    worksheet['!cols'] = colWidths;

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'TEMPLATE_INBOUND');
    XLSX.writeFile(workbook, 'Template_Import_Inbound_Massal.xlsx');
  };

  // CSV Download Template Handler
  const handleDownloadTemplateCsv = () => {
    const csvContent = "data:text/csv;charset=utf-8," + 
      "No PO,Supplier,SKU ID,Nama Barang,Qty Diterima,Lokasi Target,Expired Date,Catatan\n" +
      "PO-2026/09/001,Supplier Contoh,SKU-001,Barang Contoh 1,240,RAK-A01,15/08/2028,Penerimaan Inbound\n" +
      "PO-2026/09/001,Supplier Contoh,SKU-002,Barang Contoh 2,180,RAK-A01,15/08/2028,Penerimaan Inbound\n" +
      "PO-2026/09/002,Supplier Contoh,SKU-003,Barang Contoh 3,500,RAK-A03,31/12/2028,Restock Gudang\n" +
      "PO-2026/09/002,Supplier Contoh,SKU-004,Barang Contoh 4,300,RAK-A04,10/05/2028,Restock Gudang\n";

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "Template_Import_Inbound_Massal.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Excel / CSV Upload Processor
  const processExcelFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows: any[] = XLSX.utils.sheet_to_json(worksheet);

        if (rows.length === 0) {
          alert('File Excel/CSV tidak memiliki data baris untuk diproses.');
          return;
        }

        const lines: string[] = [];
        let detectedPo = '';
        let detectedSupplier = '';

        rows.forEach(row => {
          const keys = Object.keys(row);
          const findKeyVal = (candidates: string[]) => {
            const matchedKey = keys.find(k => {
              const cleanKey = k.toLowerCase().replace(/[^a-z0-9]/g, '');
              return candidates.some(c => {
                const cleanC = c.toLowerCase().replace(/[^a-z0-9]/g, '');
                return cleanKey === cleanC || cleanKey.includes(cleanC);
              });
            });
            const val = matchedKey !== undefined ? row[matchedKey] : '';
            return val !== undefined && val !== null ? String(val).trim() : '';
          };

          const rawSkuId = findKeyVal([
            'skuid', 'sku', 'kodesku', 'kodebarang', 'kode', 'itemcode', 'itemno', 
            'barcode', 'kodeproduk', 'productcode', 'partnumber', 'idbarang', 'id'
          ]);
          const rawName = findKeyVal([
            'namabarang', 'namaproduk', 'productname', 'itemname', 'nama', 'deskripsi', 'description'
          ]);
          const rawQty = findKeyVal([
            'qtyditerimapcs', 'qtyditerima', 'qty', 'quantity', 'jumlah', 'pcs', 
            'kuantitas', 'jumlahpcs', 'diterima', 'totalqty', 'vol', 'volume', 'unit', 'units', 'stokmasuk', 'jumlahmasuk'
          ]);
          const rawExpiredDate = findKeyVal([
            'expireddateddmmyyyy', 'expireddate', 'expdate', 'ed', 'tanggalexp', 
            'tanggaled', 'expired', 'tglkadaluarsa', 'kadaluarsa', 'bestbefore', 'tglexp', 'tglkadaluwarsa'
          ]);
          const rawLocation = findKeyVal([
            'lokasitarget', 'targetlocation', 'lokasi', 'rak', 'bin', 'posisi', 
            'lokasirak', 'raktarget', 'raklokasi', 'lokasipenyimpanan'
          ]);
          const po = findKeyVal([
            'noposuratjalan', 'nopo', 'nomerpo', 'ponumber', 'suratjalan', 
            'nosj', 'po', 'noorder', 'orderno', 'nomorpo', 'nomorsuratjalan'
          ]);
          const supplier = findKeyVal([
            'supplierprincipal', 'supplier', 'principal', 'namasupplier', 
            'pengirim', 'vendor', 'pemasok'
          ]);

          if (po && !detectedPo) detectedPo = po;
          if (supplier && !detectedSupplier) detectedSupplier = supplier;

          let skuId = rawSkuId;
          // Fallback: If SKU ID is missing but Name exists, search in catalog
          if (!skuId && rawName) {
            const catMatch = catalog.find(c => 
              c.skuName.toLowerCase().includes(rawName.toLowerCase()) || 
              rawName.toLowerCase().includes(c.skuName.toLowerCase())
            );
            if (catMatch) skuId = catMatch.skuId;
          }

          const cleanQty = /^\d+$/.test(String(rawQty).trim()) ? Number(rawQty) : NaN;

          if (skuId) {
            const loc = rawLocation || defaultLocation || 'RAK-A01';
            const exp = normalizeDateToDmy(rawExpiredDate) || normalizeDateToDmy(defaultExpDate) || '31/12/2028';
            lines.push(`${skuId}\t${Number.isSafeInteger(cleanQty) && cleanQty > 0 ? cleanQty : `INVALID:${rawQty}`}\t${loc}\t${exp}`);
          }
        });

        if (detectedPo && (!poNumber || poNumber.startsWith('PO-'))) setPoNumber(detectedPo);
        if (detectedSupplier && (!supplierName || supplierName === 'Supplier Contoh')) setSupplierName(detectedSupplier);

        if (lines.length > 0) {
          setInputText(prev => prev ? `${prev}\n${lines.join('\n')}` : lines.join('\n'));
          alert(`✓ ${lines.length} baris SKU dimuat untuk diperiksa dari file "${file.name}"!`);
        } else {
          alert('Format kolom tidak terdeteksi. Pastikan file memuat minimal kolom SKU ID (atau Nama Barang) dan Qty Diterima.');
        }
      } catch (err) {
        console.error('Error reading file:', err);
        alert('Gagal membaca file. Pastikan file berformat Excel (.xlsx, .xls) atau .csv');
      }
    };

    reader.readAsArrayBuffer(file);
  };

  const handleExcelFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    processExcelFile(file);
    if (event.target) event.target.value = '';
  };

  const handleDropFile = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processExcelFile(e.dataTransfer.files[0]);
    }
  };

  // Add Row via Manual Builder Form
  const handleAddManualRow = () => {
    if (!selectedSku || !manualQty) {
      alert('Pilih SKU ID dan masukkan Jumlah Diterima.');
      return;
    }

    const qtyNum = /^\d+$/.test(manualQty.trim()) ? Number(manualQty) : NaN;
    if (!Number.isSafeInteger(qtyNum) || qtyNum <= 0) {
      alert('Jumlah diterima harus berupa bilangan bulat positif, tanpa tanda minus atau desimal.');
      return;
    }

    const loc = manualLoc.trim() ? manualLoc.trim().toUpperCase() : defaultLocation || 'RAK-A01';
    const exp = manualExp.trim() ? normalizeDateToDmy(manualExp.trim()) : normalizeDateToDmy(defaultExpDate) || '31/12/2028';

    const newLine = `${selectedSku}\t${qtyNum}\t${loc}\t${exp}`;
    setInputText(prev => prev ? `${prev}\n${newLine}` : newLine);

    // Clear manual inputs
    setSelectedSku('');
    setManualQty('');
    setManualLoc('');
    setManualExp('');
  };

  // Remove single parsed row
  const handleRemoveParsedRow = (index: number) => {
    const targetRow = parsedRows[index];
    if (!targetRow) return;
    const rawLines = inputText.split('\n');
    rawLines.splice(targetRow.lineIndex, 1);
    setInputText(rawLines.join('\n'));
  };

  // Smart Suggestion Helper
  const suggestPutawayLocation = (sku: string) => {
    const existing = stock.filter(
      s =>
        s.skuId.toUpperCase() === sku.toUpperCase() &&
        s.location !== 'TRANSIT' &&
        s.location.toUpperCase() !== 'KARANTINA' &&
        !['Damage', 'Expired', 'Karantina'].includes(getStockStatus(s))
    );
    if (existing.length > 0) {
      return existing[0].location;
    }
    const defaultRacks = ['RAK-A01', 'RAK-E02', 'RAK-A03', 'RAK-F02', 'RAK-A04', 'RAK-A01'];
    return defaultRacks[Math.floor(Math.random() * defaultRacks.length)];
  };

  const handleUpdateRowLocation = (index: number, newLoc: string) => {
    const targetRow = parsedRows[index];
    if (!targetRow) return;
    const rawLines = inputText.split('\n');
    if (rawLines[targetRow.lineIndex] !== undefined) {
      const cleanLoc = newLoc.toUpperCase();
      if (targetRow.poNumber || targetRow.supplierName) {
        rawLines[targetRow.lineIndex] = `${targetRow.poNumber || poNumber}\t${targetRow.supplierName || supplierName}\t${targetRow.skuId}\t${targetRow.skuName}\t${targetRow.qty}\t${cleanLoc}\t${targetRow.expiredDate}\t${targetRow.notes || ''}`;
      } else {
        rawLines[targetRow.lineIndex] = `${targetRow.skuId}\t${targetRow.qty}\t${cleanLoc}\t${targetRow.expiredDate}`;
      }
      setInputText(rawLines.join('\n'));
    }
  };

  // Submit Inbound Batch Execution
  const handleExecuteInboundBatch = async (e?: React.FormEvent | React.MouseEvent) => {
    if(inboundLock.current)return;inboundLock.current=true;
    try {
    if (e && e.preventDefault) e.preventDefault();

    const activePo = poNumber.trim() || `PO-${new Date().toISOString().slice(0, 7).replace('-', '')}-${Math.floor(100 + Math.random() * 900)}`;
    const activeSupplier = supplierName.trim() || 'Supplier Contoh';

    if (parsedRows.some(r => !r.isValid || !Number.isSafeInteger(r.qty) || r.qty <= 0)) {
      alert('Masih ada baris inbound tidak valid. Perbaiki atau hapus baris tersebut sebelum menyimpan.'); return;
    }
    if (executionMode === 'INSTANT_PUTAWAY' && qcStatus === 'QC_HOLD') {
      alert('QC Hold tidak boleh langsung masuk stok. Pilih Simpan ke Antrean Inbound agar tetap ditahan untuk pemeriksaan QC.'); return;
    }
    const validRows = parsedRows.filter(r => r.isValid);
    if (validRows.length === 0) {
      alert('Belum ada SKU valid yang diinput. Silakan upload Excel, paste teks format SKU dan Qty, atau tambahkan manual dari katalog.');
      return;
    }

    const timestampStr = new Date().toISOString().split('T')[0];
    const operatorName = currentUser?.fullName || 'WMS Inbound Officer';

    // Option A: INSTANT PUTAWAY DIRECT TO STOCK
    if (executionMode === 'INSTANT_PUTAWAY') {
      for (const row of validRows) {
        if (/karantina|quarantine|qc[ _-]*hold|damage|rusak/i.test(row.location)) {
          alert(`Rak tujuan [${row.location}] merupakan lokasi karantina atau barang rusak. Ubah ke rak penyimpanan normal untuk penerimaan langsung.`);
          return;
        }
        const normEd = normalizeDateToDmy(row.expiredDate);
        const targetId = getCanonicalStockId(row.skuId, normEd, row.location);
        const index = findStockIndex(stock, row.skuId, normEd, row.location, targetId);
        if (index !== -1) {
          const existingStatus = getStockStatus(stock[index]);
          if (['Damage', 'Expired'].includes(existingStatus)) {
            alert(`Rak tujuan [${row.location}] berisi stok berstatus "${existingStatus}" untuk SKU [${row.skuId}]. Pilih rak lain agar kondisi barang tidak tercampur.`);
            return;
          }
        }
      }
      const updatedStock = [...stock];
      const batchLogs: Omit<DccLog, 'id' | 'timestamp'>[] = [];

      validRows.forEach((row) => {
        const normEd = normalizeDateToDmy(row.expiredDate);
        const targetId = getCanonicalStockId(row.skuId, normEd, row.location);
        const existingIndex = findStockIndex(updatedStock, row.skuId, normEd, row.location, targetId);

        const packSpec = getProductPackSizes(row.skuId);

        if (existingIndex !== -1) {
          const currentItem = updatedStock[existingIndex];
          const newQty = currentItem.qty + row.qty;
          const packs = calculatePackQuantities(newQty, packSpec.qtyCtnSize, packSpec.qtyInnerSize);

          updatedStock[existingIndex] = {
            ...currentItem,
            id: targetId,
            qty: newQty,
            qtyCtn: packs.qtyCtn,
            qtyInner: packs.qtyInner,
            qtyLoose: packs.qtyLoose,
            status: getExpiredStatus(normEd)
          };
        } else {
          const packs = calculatePackQuantities(row.qty, packSpec.qtyCtnSize, packSpec.qtyInnerSize);
          updatedStock.push({
            id: targetId,
            skuId: row.skuId,
            skuName: row.skuName,
            expiredDate: normEd,
            location: row.location,
            qty: row.qty,
            totalQtySku: row.qty,
            qtyCtnSize: packSpec.qtyCtnSize,
            qtyCtn: packs.qtyCtn,
            qtyInnerSize: packSpec.qtyInnerSize,
            qtyInner: packs.qtyInner,
            qtyLoose: packs.qtyLoose,
            status: getExpiredStatus(normEd)
          });
        }

        // Add Log
        batchLogs.push({
          type: 'INBOUND',
          skuId: row.skuId,
          skuName: row.skuName,
          locationFrom: `PO: ${activePo}`,
          locationTo: row.location,
          qty: row.qty,
          description: `Inbound Massal PO: ${activePo} [${activeSupplier}]`,
          user: operatorName,
          expiredDate: normEd
        });
      });

      // Also create history records with PUTAWAY status
      const newItems: InboundReceiptItem[] = validRows.map((row, idx) => ({
        id: `INB-${crypto.randomUUID()}`,
        poNumber: activePo,
        supplierName: activeSupplier,
        skuId: row.skuId,
        skuName: row.skuName,
        expiredDate: normalizeDateToDmy(row.expiredDate),
        receivedQty: row.qty,
        targetLocation: row.location,
        status: 'PUTAWAY',
        receivedDate: timestampStr,
        operator: operatorName,
        notes: (notes || 'Penerimaan Inbound Massal').trim()
      }));

      const updated = [...newItems, ...inboundHistory];
      await commitInbound(updatedStock,batchLogs,newItems);

      const totalPcs = validRows.reduce((sum, r) => sum + r.qty, 0);
      alert(`✓ SUKSES INBOUND MASSAL (DIRECT PUTAWAY)\n\nNomor PO: ${activePo}\nTotal SKU: ${validRows.length} SKU\nTotal Jumlah: ${formatNumber(totalPcs)} Pcs\n\nStok gudang telah berhasil bertambah secara instan.`);
    } else {
      // Option B: SAVE AS INBOUND QUEUE / STAGING (READY FOR STEP-BY-STEP PUTAWAY)
      const newItems: InboundReceiptItem[] = validRows.map((row, idx) => ({
        id: `INB-${crypto.randomUUID()}`,
        poNumber: activePo,
        supplierName: activeSupplier,
        skuId: row.skuId,
        skuName: row.skuName,
        expiredDate: normalizeDateToDmy(row.expiredDate),
        receivedQty: row.qty,
        targetLocation: row.location,
        status: qcStatus,
        receivedDate: timestampStr,
        operator: operatorName,
        notes: (notes || 'Penerimaan Inbound Massal').trim()
      }));

      const updated = [...newItems, ...inboundHistory];
      await commitInbound(null,[],newItems);

      const totalPcs = validRows.reduce((sum, r) => sum + r.qty, 0);
      alert(`✓ SUKSES MENERIMA INBOUND KE ANTREAN\n\nNomor PO: ${activePo}\nTotal SKU: ${validRows.length} SKU (${formatNumber(totalPcs)} Pcs)\nStatus: ${qcStatus === 'RECEIVED' ? 'Siap Putaway' : 'Karantina QC'}`);
    }

    // Reset Modal
    setInputText('');
    setPoNumber(`PO-${new Date().toISOString().slice(0, 7).replace('-', '')}-${Math.floor(100 + Math.random() * 900)}`);
    setNotes('Penerimaan Inbound Massal');
    setIsModalOpen(false);
    } catch(e:any){alert(e.message || 'Inbound gagal disimpan. Data form tetap tersedia.');}
    finally{inboundLock.current=false;}
  };

  const handleReleaseQcHold = async (receipt: InboundReceiptItem) => {
    if (inboundLock.current) return;
    inboundLock.current = true;
    try {
      if (receipt.status !== 'QC_HOLD') return;
      if (!confirm(`Verifikasi Lolos QC:\n\nUbah status ${formatNumber(receipt.receivedQty)} Pcs SKU [${receipt.skuId}] dari Karantina QC menjadi "Siap Putaway"?`)) return;
      const updatedItem: InboundReceiptItem = { ...receipt, status: 'RECEIVED' };
      await saveInboundHistory(inboundHistory.map(i => (i.id === receipt.id ? updatedItem : i)));
    } catch (e: any) {
      alert(e.message || 'Gagal memperbarui status QC.');
    } finally {
      inboundLock.current = false;
    }
  };

  // Putaway Single Item
  const handleExecutePutaway = async (receipt: InboundReceiptItem) => {
    if(inboundLock.current)return;inboundLock.current=true;
    try {
    if (receipt.status === 'PUTAWAY') return;
    if (receipt.status === 'QC_HOLD') { alert('Barang masih ditahan QC. Selesaikan pemeriksaan QC sebelum putaway.'); return; }

    const confirmMsg = `Proses Putaway Barang:\n\nMasukan ${formatNumber(receipt.receivedQty)} Pcs SKU [${receipt.skuId}] ke Rak Lokasi [${receipt.targetLocation}]?\n\nStok gudang akan langsung bertambah secara otomatis.`;
    if (!confirm(confirmMsg)) return;

    const updatedStock = [...stock];
    const normEd = normalizeDateToDmy(receipt.expiredDate);
    const targetId = getCanonicalStockId(receipt.skuId, normEd, receipt.targetLocation);
    const existingIndex = findStockIndex(updatedStock, receipt.skuId, normEd, receipt.targetLocation, targetId);

    if (/karantina|quarantine|qc[ _-]*hold|damage|rusak/i.test(receipt.targetLocation)) {
      alert(`Rak tujuan [${receipt.targetLocation}] merupakan lokasi karantina atau barang rusak. Ubah ke rak penyimpanan normal sebelum putaway.`);
      return;
    }
    if (existingIndex !== -1) {
      const existingStatus = getStockStatus(updatedStock[existingIndex]);
      if (['Damage', 'Expired'].includes(existingStatus)) {
        alert(`Rak tujuan [${receipt.targetLocation}] berisi stok berstatus "${existingStatus}" untuk SKU [${receipt.skuId}]. Ubah rak tujuan sebelum putaway.`);
        return;
      }
    }
    const packSpec = getProductPackSizes(receipt.skuId);

    if (existingIndex !== -1) {
      const currentItem = updatedStock[existingIndex];
      const newQty = currentItem.qty + receipt.receivedQty;
      const packs = calculatePackQuantities(newQty, packSpec.qtyCtnSize, packSpec.qtyInnerSize);

      updatedStock[existingIndex] = {
        ...currentItem,
        id: targetId,
        qty: newQty,
        qtyCtn: packs.qtyCtn,
        qtyInner: packs.qtyInner,
        qtyLoose: packs.qtyLoose,
        status: getExpiredStatus(normEd)
      };
    } else {
      const packs = calculatePackQuantities(receipt.receivedQty, packSpec.qtyCtnSize, packSpec.qtyInnerSize);
      updatedStock.push({
        id: targetId,
        skuId: receipt.skuId,
        skuName: receipt.skuName,
        expiredDate: normEd,
        location: receipt.targetLocation,
        qty: receipt.receivedQty,
        totalQtySku: receipt.receivedQty,
        qtyCtnSize: packSpec.qtyCtnSize,
        qtyCtn: packs.qtyCtn,
        qtyInnerSize: packSpec.qtyInnerSize,
        qtyInner: packs.qtyInner,
        qtyLoose: packs.qtyLoose,
        status: getExpiredStatus(normEd)
      });
    }

    const putawayLog: Omit<DccLog,'id'|'timestamp'> = {
      type: 'INBOUND',
      skuId: receipt.skuId,
      skuName: receipt.skuName,
      locationFrom: `INBOUND PO (${receipt.poNumber})`,
      locationTo: receipt.targetLocation,
      qty: receipt.receivedQty,
      description: `Putaway Inbound PO: ${receipt.poNumber} [${receipt.supplierName}]`,
      user: currentUser?.fullName || 'WMS Inbound Staff',
      expiredDate: normEd
    };

    const updatedHistory = inboundHistory.map(item => 
      item.id === receipt.id ? { ...item, status: 'PUTAWAY' as const } : item
    );
    await commitInbound(updatedStock,[putawayLog],updatedHistory.filter(i=>i.id===receipt.id));
    } catch(e:any){alert(e.message || 'Inbound gagal disimpan. Data form tetap tersedia.');}
    finally{inboundLock.current=false;}
  };

  // Batch Putaway All Pending Items
  const handleBatchPutawayAllPending = async () => {
    if(inboundLock.current)return;inboundLock.current=true;
    try {
    const pendingItems = inboundHistory.filter(i => i.status === 'RECEIVED');
    if (pendingItems.length === 0) {
      alert('Tidak ada item inbound dengan status "Siap Putaway".');
      return;
    }

    const totalPcs = pendingItems.reduce((s, i) => s + i.receivedQty, 0);
    const confirmMsg = `Proses Putaway Massal:\n\nApakah Anda yakin ingin melakukan Putaway untuk SEMUA ${pendingItems.length} item antrean (${formatNumber(totalPcs)} Pcs) ke rak masing-masing?\n\nStok gudang akan langsung bertambah.`;
    if (!confirm(confirmMsg)) return;

    for (const receipt of pendingItems) {
      if (/karantina|quarantine|qc[ _-]*hold|damage|rusak/i.test(receipt.targetLocation)) {
        alert(`SKU [${receipt.skuId}] tidak dapat di-putaway: Rak tujuan [${receipt.targetLocation}] merupakan lokasi karantina atau barang rusak. Ubah rak tujuan terlebih dahulu.`);
        return;
      }
      const normEd = normalizeDateToDmy(receipt.expiredDate);
      const targetId = getCanonicalStockId(receipt.skuId, normEd, receipt.targetLocation);
      const existingIndex = findStockIndex(stock, receipt.skuId, normEd, receipt.targetLocation, targetId);
      if (existingIndex !== -1) {
        const existingStatus = getStockStatus(stock[existingIndex]);
        if (['Damage', 'Expired'].includes(existingStatus)) {
          alert(`Rak tujuan [${receipt.targetLocation}] berisi stok berstatus "${existingStatus}" untuk SKU [${receipt.skuId}]. Ubah rak tujuan sebelum putaway massal.`);
          return;
        }
      }
    }

    const updatedStock = [...stock];
    const batchLogs: Omit<DccLog, 'id' | 'timestamp'>[] = [];

    pendingItems.forEach(receipt => {
      const normEd = normalizeDateToDmy(receipt.expiredDate);
      const targetId = getCanonicalStockId(receipt.skuId, normEd, receipt.targetLocation);
      const existingIndex = findStockIndex(updatedStock, receipt.skuId, normEd, receipt.targetLocation, targetId);

      const packSpec = getProductPackSizes(receipt.skuId);

      if (existingIndex !== -1) {
        const currentItem = updatedStock[existingIndex];
        const newQty = currentItem.qty + receipt.receivedQty;
        const packs = calculatePackQuantities(newQty, packSpec.qtyCtnSize, packSpec.qtyInnerSize);

        updatedStock[existingIndex] = {
          ...currentItem,
          id: targetId,
          qty: newQty,
          qtyCtn: packs.qtyCtn,
          qtyInner: packs.qtyInner,
          qtyLoose: packs.qtyLoose,
          status: getExpiredStatus(normEd)
        };
      } else {
        const packs = calculatePackQuantities(receipt.receivedQty, packSpec.qtyCtnSize, packSpec.qtyInnerSize);
        updatedStock.push({
          id: targetId,
          skuId: receipt.skuId,
          skuName: receipt.skuName,
          expiredDate: normEd,
          location: receipt.targetLocation,
          qty: receipt.receivedQty,
          totalQtySku: receipt.receivedQty,
          qtyCtnSize: packSpec.qtyCtnSize,
          qtyCtn: packs.qtyCtn,
          qtyInnerSize: packSpec.qtyInnerSize,
          qtyInner: packs.qtyInner,
          qtyLoose: packs.qtyLoose,
          status: getExpiredStatus(normEd)
        });
      }

      batchLogs.push({
        type: 'INBOUND',
        skuId: receipt.skuId,
        skuName: receipt.skuName,
        locationFrom: `INBOUND PO (${receipt.poNumber})`,
        locationTo: receipt.targetLocation,
        qty: receipt.receivedQty,
        description: `Batch Putaway Inbound PO: ${receipt.poNumber} [${receipt.supplierName}]`,
        user: currentUser?.fullName || 'WMS Inbound Staff',
        expiredDate: normEd
      });
    });

    const pendingIds = new Set(pendingItems.map(p => p.id));
    const updatedHistory = inboundHistory.map(item => 
      pendingIds.has(item.id) ? { ...item, status: 'PUTAWAY' as const } : item
    );
    await commitInbound(updatedStock,batchLogs,updatedHistory.filter(i=>pendingIds.has(i.id)));

    alert(`✓ Sukses memproses Putaway massal untuk ${pendingItems.length} SKU (${formatNumber(totalPcs)} Pcs)!`);
    } catch(e:any){alert(e.message || 'Inbound gagal disimpan. Data form tetap tersedia.');}
    finally{inboundLock.current=false;}
  };

  const handleDeleteInbound = async (id: string) => {
    if (confirm('Hapus riwayat penerimaan inbound ini secara permanen?')) {
      const updated = inboundHistory.filter(i => i.id !== id);
      setInboundHistory(updated);
      try {
        await deleteDoc(doc(db, 'inbound', id));
      } catch (err) {
        console.warn('Delete inbound document from Supabase failed:', err);
        handleSupabaseError(err, OperationType.DELETE, `inbound/${id}`);
      }
    }
  };

  const handleClearAllInbound = async () => {
    if (inboundHistory.length === 0) return;
    if (confirm(`Apakah Anda yakin ingin MENGHAPUS SEMUA (${inboundHistory.length}) riwayat inbound secara permanen?`)) {
      const idsToDelete = inboundHistory.map(i => i.id);
      setInboundHistory([]);
      try {
        await Promise.all(idsToDelete.map(id => deleteDoc(doc(db, 'inbound', id))));
      } catch (err) {
        console.warn('Gagal menghapus semua data inbound dari Supabase:', err);
        handleSupabaseError(err, OperationType.DELETE, 'inbound');
      }
    }
  };

  // Export Inbound History to Excel
  const handleExportInboundHistory = () => {
    if (inboundHistory.length === 0) {
      alert('Tidak ada riwayat inbound untuk diekspor.');
      return;
    }

    const exportData = inboundHistory.map((item, idx) => ({
      'No': idx + 1,
      'No PO / Surat Jalan': item.poNumber,
      'Tanggal Diterima': item.receivedDate,
      'Supplier': item.supplierName,
      'SKU ID': item.skuId,
      'Nama Barang': item.skuName,
      'Qty Diterima (Pcs)': item.receivedQty,
      'Lokasi Target': item.targetLocation,
      'Expired Date': item.expiredDate,
      'Status': item.status === 'PUTAWAY' ? 'Sudah Putaway' : item.status === 'RECEIVED' ? 'Siap Putaway' : 'QC Hold',
      'Operator': item.operator,
      'Catatan': item.notes || '-'
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'RIWAYAT_INBOUND');
    XLSX.writeFile(workbook, `Laporan_Inbound_WMS_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // Filter History
  const filteredHistory = inboundHistory.filter(item => {
    const matchesSearch = 
      item.poNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.supplierName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.skuId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.skuName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.targetLocation.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = filterStatus === 'ALL' || item.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const pendingPutawayCount = inboundHistory.filter(i => i.status === 'RECEIVED').length;
  const putawayDoneCount = inboundHistory.filter(i => i.status === 'PUTAWAY').length;
  const qcHoldCount = inboundHistory.filter(i => i.status === 'QC_HOLD').length;
  const totalReceivedQty = inboundHistory.reduce((sum, i) => sum + i.receivedQty, 0);

  const validRowsCount = parsedRows.filter(r => r.isValid).length;
  const validTotalPcs = parsedRows.filter(r => r.isValid).reduce((sum, r) => sum + r.qty, 0);

  return (
    <div className="blues-inbound space-y-6">
      {/* Top Banner Header */}
      <div className="blues-inbound-summary bg-slate-900 border border-slate-800 rounded-xl p-5">

        
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5 relative z-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-semibold mb-2">
              <Truck className="w-3.5 h-3.5" />
              <span>INBOUND</span>
            </div>
            <h2 className="text-xl md:text-2xl font-black text-slate-100 tracking-tight flex items-center gap-2">
              Penerimaan barang
            </h2>
            <p className="text-slate-400 text-xs md:text-sm mt-1 max-w-2xl leading-relaxed">
              Catat barang masuk, periksa QC, dan tempatkan stok ke rak tujuan.
            </p>
          </div>

          {/* Action Buttons Toolbar */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {/* Download Template Excel */}
            <button
              onClick={handleDownloadTemplateExcel}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 hover:border-amber-500/60 font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center gap-2 shadow-sm"
              title="Download Template Excel (.xlsx)"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              <span>Download Template Excel</span>
            </button>

            {/* Import Massal Inbound Button */}
            <button
              onClick={() => {
                setActiveImportTab('excel');
                setIsModalOpen(true);
              }}
              className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs md:text-sm rounded-xl shadow-lg shadow-emerald-500/20 transition-all cursor-pointer flex items-center gap-2"
            >
              <Upload className="w-4 h-4 stroke-[3]" />
              <span>Import Massal Inbound</span>
            </button>
          </div>
        </div>

        {/* Metric Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6 pt-5 border-t border-slate-800/80">
          <div className="bg-slate-950/60 border border-slate-800/60 p-3.5 rounded-xl">
            <span className="text-[11px] font-medium text-slate-400 block">Total Qty Inbound Masuk</span>
            <span className="text-lg font-bold text-emerald-400 mt-1 block font-mono">
              {formatNumber(totalReceivedQty)} <span className="text-xs text-slate-400 font-normal">Pcs</span>
            </span>
          </div>

          <div className="bg-slate-950/60 border border-slate-800/60 p-3.5 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-400 block">Antrean Siap Putaway</span>
              {pendingPutawayCount > 0 && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300">
                  Perlu Aksi
                </span>
              )}
            </div>
            <span className="text-lg font-bold text-amber-400 mt-1 block font-mono">
              {pendingPutawayCount} <span className="text-xs text-slate-400 font-normal">Item SKU</span>
            </span>
          </div>

          <div className="bg-slate-950/60 border border-slate-800/60 p-3.5 rounded-xl">
            <span className="text-[11px] font-medium text-slate-400 block">Selesai Putaway ke Rak</span>
            <span className="text-lg font-bold text-teal-400 mt-1 block font-mono">
              {putawayDoneCount} <span className="text-xs text-slate-400 font-normal">Item SKU</span>
            </span>
          </div>

          <div className="bg-slate-950/60 border border-slate-800/60 p-3.5 rounded-xl">
            <span className="text-[11px] font-medium text-slate-400 block">Karantina / QC Hold</span>
            <span className="text-lg font-bold text-rose-400 mt-1 block font-mono">
              {qcHoldCount} <span className="text-xs text-slate-400 font-normal">Item SKU</span>
            </span>
          </div>
        </div>
      </div>

      {/* Batch Actions & Filter Bar */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4 flex flex-col md:flex-row gap-3 items-center justify-between shadow-sm">
        {/* Search */}
        <div className="relative w-full md:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Cari PO, Supplier, SKU, Rak, Tanggal..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
          />
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-2 w-full md:w-auto overflow-x-auto scrollbar-none">
          <button
            onClick={() => setFilterStatus('ALL')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all shrink-0 cursor-pointer ${
              filterStatus === 'ALL'
                ? 'bg-slate-800 text-slate-100 border-slate-700'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            Semua ({inboundHistory.length})
          </button>

          <button
            onClick={() => setFilterStatus('RECEIVED')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all shrink-0 cursor-pointer ${
              filterStatus === 'RECEIVED'
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            Siap Putaway ({pendingPutawayCount})
          </button>

          <button
            onClick={() => setFilterStatus('PUTAWAY')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all shrink-0 cursor-pointer ${
              filterStatus === 'PUTAWAY'
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            Sudah Putaway ({putawayDoneCount})
          </button>

          <button
            onClick={() => setFilterStatus('QC_HOLD')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all shrink-0 cursor-pointer ${
              filterStatus === 'QC_HOLD'
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            QC Hold ({qcHoldCount})
          </button>

          {/* Right Action Buttons */}
          <div className="flex items-center gap-2 ml-auto shrink-0">
            {/* Export Excel Button */}
            <button
              onClick={handleExportInboundHistory}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-semibold text-xs rounded-lg transition-all border border-slate-700 cursor-pointer flex items-center gap-1.5"
              title="Ekspor Riwayat ke Excel"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>Ekspor (.xlsx)</span>
            </button>

            {/* Clear All Inbound Button */}
            {inboundHistory.length > 0 && (
              <button
                onClick={handleClearAllInbound}
                className="px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 font-semibold text-xs rounded-lg transition-all border border-rose-500/30 cursor-pointer flex items-center gap-1.5"
                title="Hapus Semua Riwayat Inbound Permanen"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                <span>Hapus Semua</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Batch Putaway Callout when there are pending items */}
      {pendingPutawayCount > 0 && filterStatus !== 'PUTAWAY' && (
        <div className="bg-gradient-to-r from-amber-950/40 to-slate-900/60 border border-amber-500/30 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-lg">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-amber-500/20 text-amber-400 rounded-xl border border-amber-500/30 shrink-0">
              <Boxes className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-amber-300 flex items-center gap-2">
                <span>Terdapat {pendingPutawayCount} SKU Inbound Menunggu Penempatan (Putaway)</span>
              </h4>
              <p className="text-xs text-slate-400 mt-0.5">
                Barang yang sudah diterima dapat langsung dialokasikan ke rak target gudang secara massal atau satu per satu.
              </p>
            </div>
          </div>

          <button
            onClick={handleBatchPutawayAllPending}
            className="w-full sm:w-auto px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-amber-500/20 transition-all cursor-pointer flex items-center justify-center gap-2 shrink-0"
          >
            <CheckCircle2 className="w-4 h-4 stroke-[3]" />
            <span>Putaway Semua ({pendingPutawayCount} SKU)</span>
          </button>
        </div>
      )}

      {/* Inbound History Table */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800/80 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-emerald-400" />
            <span>Riwayat Penerimaan Inbound & Eksekusi Putaway</span>
          </h3>
          <span className="text-xs text-slate-400 font-mono">Menampilkan: {filteredHistory.length} Record</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800/80">
              <tr>
                <th className="p-3.5">No PO / Tanggal</th>
                <th className="p-3.5">Supplier / Principal</th>
                <th className="p-3.5">Kode SKU & Nama Barang</th>
                <th className="p-3.5 text-center">Expired Date</th>
                <th className="p-3.5 text-center">Jumlah Diterima</th>
                <th className="p-3.5 text-center">Lokasi Target</th>
                <th className="p-3.5 text-center">Status QC</th>
                <th className="p-3.5 text-right">Aksi SOP Putaway</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 text-slate-300">
              {filteredHistory.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-12 text-center text-slate-500">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Truck className="w-8 h-8 text-slate-600 mb-1" />
                      <span className="font-semibold text-slate-400">Tidak ada transaksi penerimaan inbound yang ditemukan</span>
                      <span className="text-[11px] text-slate-500">Gunakan tombol "Import Massal Inbound" untuk menambahkan data penerimaan baru.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredHistory.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="p-3.5 font-mono">
                      <div className="font-bold text-slate-200">{item.poNumber}</div>
                      <div className="text-[11px] text-slate-500">{item.receivedDate}</div>
                    </td>
                    <td className="p-3.5 font-medium text-slate-300">
                      <div className="flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span>{item.supplierName}</span>
                      </div>
                    </td>
                    <td className="p-3.5">
                      <div className="font-bold text-emerald-400 font-mono">{item.skuId}</div>
                      <div className="text-[11px] text-slate-400 line-clamp-1">{item.skuName}</div>
                    </td>
                    <td className="p-3.5 text-center font-mono text-slate-300">
                      {isNoExpiryDate(item.expiredDate) || item.expiredDate === 'No Expired' ? 'Tanpa kedaluwarsa' : item.expiredDate}
                    </td>
                    <td className="p-3.5 text-center font-bold text-slate-100 font-mono text-sm">
                      {formatNumber(item.receivedQty)} <span className="text-[10px] font-normal text-slate-400">Pcs</span>
                    </td>
                    <td className="p-3.5 text-center">
                      <span className="inline-flex items-center gap-1 font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-amber-300 border border-slate-700">
                        <MapPin className="w-3 h-3" />
                        {item.targetLocation}
                      </span>
                    </td>
                    <td className="p-3.5 text-center">
                      {item.status === 'PUTAWAY' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                          <CheckCircle2 className="w-3 h-3" />
                          Putaway Selesai
                        </span>
                      )}
                      {item.status === 'RECEIVED' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                          <PackageCheck className="w-3 h-3" />
                          Siap Putaway
                        </span>
                      )}
                      {item.status === 'QC_HOLD' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                          <AlertTriangle className="w-3 h-3" />
                          Karantina QC
                        </span>
                      )}
                    </td>
                    <td className="p-3.5 text-right space-x-2">
                      {item.status === 'QC_HOLD' && (
                        <button
                          onClick={() => handleReleaseQcHold(item)}
                          className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg transition-all shadow-md shadow-amber-500/10 cursor-pointer inline-flex items-center gap-1"
                          title="Verifikasi Lolos QC agar siap Putaway"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 stroke-[2.5]" />
                          <span>Lolos QC</span>
                        </button>
                      )}
                      {item.status === 'RECEIVED' && (
                        <button
                          onClick={() => handleExecutePutaway(item)}
                          className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition-all shadow-md shadow-emerald-500/10 cursor-pointer inline-flex items-center gap-1"
                        >
                          <ArrowRight className="w-3.5 h-3.5 stroke-[3]" />
                          <span>Putaway</span>
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteInbound(item.id)}
                        className="p-1.5 text-slate-500 hover:text-rose-400 transition-colors cursor-pointer"
                        title="Hapus Record"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODAL IMPORT MASSAL & PENERIMAAN INBOUND */}
      {isModalOpen && (
        <ModalFrame titleId="inbound-import-title" onClose={()=>setIsModalOpen(false)} className="blues-inbound-dialog">
            
            {/* Modal Header */}
            <div className="blues-inbound-modal-header">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-emerald-500/15 text-emerald-400 rounded-xl border border-emerald-500/30">
                  <Upload className="w-5 h-5" />
                </div>
                <div>
                  <h3 id="inbound-import-title" className="text-base font-semibold text-slate-100 flex flex-wrap items-center gap-2">
                    <span>Impor inbound massal</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                      Excel / CSV / Teks
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Unggah file Excel/CSV atau copy-paste baris SKU untuk menerima dan mendistribusikan stok secara massal.
                  </p>
                </div>
              </div>

              <button
                data-modal-close aria-label="Tutup impor inbound" type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-100 bg-slate-800 hover:bg-slate-700 rounded-lg cursor-pointer transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content Scrollable */}
            <div className="blues-inbound-modal-body">
              
              {/* Header Info PO & Supplier */}
              <div className="blues-inbound-details">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">Nomor PO / Surat Jalan *</label>
                  <input
                    type="text"
                    required
                    aria-label="Nomor PO / Surat Jalan" placeholder="Contoh: PO-2026/09/001"
                    value={poNumber}
                    onChange={(e) => setPoNumber(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500/50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">Supplier / Pengirim *</label>
                  <input
                    type="text"
                    required
                    aria-label="Supplier / Pengirim" placeholder="Contoh: Supplier Contoh"
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">Default Rak & Expired Date</label>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      aria-label="Rak default" placeholder="Lokasi (RAK-A01)"
                      value={defaultLocation}
                      onChange={(e) => setDefaultLocation(e.target.value.toUpperCase())}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-2 text-xs text-slate-200 font-mono uppercase focus:outline-none focus:border-emerald-500/50"
                    />
                    <input
                      type="date"
                      aria-label="Kedaluwarsa default" value={defaultExpDate}
                      onChange={(e) => setDefaultExpDate(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500/50"
                    />
                  </div>
                </div>

                <div className="blues-inbound-notes">
                  <label className="block text-xs font-bold text-slate-300 mb-1">Catatan Inbound</label>
                  <input
                    type="text"
                    aria-label="Catatan inbound" placeholder="Contoh: Batch Inbound Kontainer B2B #01"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">Status Verifikasi QC</label>
                  <div className="flex items-center gap-3 pt-1">
                    <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="radio"
                        name="qc"
                        checked={qcStatus === 'RECEIVED'}
                        onChange={() => setQcStatus('RECEIVED')}
                        className="accent-emerald-500"
                      />
                      <span>QC Pass</span>
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="radio"
                        name="qc"
                        checked={qcStatus === 'QC_HOLD'}
                        onChange={() => setQcStatus('QC_HOLD')}
                        className="accent-rose-500"
                      />
                      <span className="text-rose-400">QC Hold</span>
                    </label>
                  </div>
                </div>
              </div>

              <fieldset className="blues-inbound-modes"><legend>Alur penerimaan</legend><div>
                <label className={executionMode==='INSTANT_PUTAWAY'?'is-selected':''}><input type="radio" name="inbound-execution" value="INSTANT_PUTAWAY" checked={executionMode==='INSTANT_PUTAWAY'} onChange={()=>setExecutionMode('INSTANT_PUTAWAY')}/><span><strong>Langsung masuk stok</strong><small>Barang diterima dan langsung ditempatkan ke rak tujuan.</small></span></label>
                <label className={executionMode==='INBOUND_QUEUE'?'is-selected':''}><input type="radio" name="inbound-execution" value="INBOUND_QUEUE" checked={executionMode==='INBOUND_QUEUE'} onChange={()=>setExecutionMode('INBOUND_QUEUE')}/><span><strong>Simpan ke antrean inbound</strong><small>Lakukan pemeriksaan QC dan putaway pada langkah berikutnya.</small></span></label>
              </div></fieldset>

              {/* Import Method Tabs */}
              <div className="blues-inbound-import-method space-y-3">
                <div className="blues-inbound-import-tabs flex flex-wrap items-center justify-between border-b border-slate-800 pb-2 gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveImportTab('excel')}
                      className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                        activeImportTab === 'excel'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'text-slate-400 hover:text-slate-200 border border-transparent'
                      }`}
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>Upload File Excel / CSV</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveImportTab('text')}
                      className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                        activeImportTab === 'text'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'text-slate-400 hover:text-slate-200 border border-transparent'
                      }`}
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>Copy-Paste Teks Massal</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveImportTab('manual')}
                      className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                        activeImportTab === 'manual'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'text-slate-400 hover:text-slate-200 border border-transparent'
                      }`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Tambah Manual (Pilih Katalog)</span>
                    </button>
                  </div>

                  {/* Quick Template Download buttons inside modal */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleDownloadTemplateExcel}
                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold text-xs rounded-lg transition-all cursor-pointer flex items-center gap-1.5 border border-amber-500/30"
                    >
                      <Download className="w-3.5 h-3.5 text-amber-400" />
                      <span>Template .xlsx</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleDownloadTemplateCsv}
                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs rounded-lg transition-all cursor-pointer flex items-center gap-1.5 border border-slate-700"
                    >
                      <Download className="w-3.5 h-3.5 text-slate-400" />
                      <span>Template .csv</span>
                    </button>
                  </div>
                </div>

                {/* Tab 1: Drag & Drop File Excel / CSV */}
                {activeImportTab === 'excel' && (
                  <div className="space-y-3">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleExcelFileUpload}
                      accept=".xlsx, .xls, .csv"
                      className="hidden"
                    />

                    <div
                      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDropFile}
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
                        isDragging 
                          ? 'border-emerald-400 bg-emerald-500/10' 
                          : 'border-slate-700 hover:border-emerald-500/50 bg-slate-950/50 hover:bg-slate-950'
                      }`}
                    >
                      <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto mb-3">
                        <Upload className="w-6 h-6" />
                      </div>
                      <h4 className="text-sm font-bold text-slate-200">
                        Klik untuk Pilih File atau Tarik (Drag & Drop) File ke Sini
                      </h4>
                      <p className="text-xs text-slate-400 mt-1">
                        Mendukung format spreadsheet <span className="text-emerald-400 font-semibold">.xlsx</span>, <span className="text-emerald-400 font-semibold">.xls</span>, atau <span className="text-emerald-400 font-semibold">.csv</span>
                      </p>
                      <div className="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-[11px] text-slate-400">
                        <FileCheck2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Kolom otomatis terdeteksi: SKU ID, Qty, Rak/Lokasi, Exp Date, PO, Supplier</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Tab 2: Copy-Paste Teks Area */}
                {activeImportTab === 'text' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>Format Input: <code className="text-emerald-400 font-mono bg-slate-950 px-1 py-0.5 rounded">SKU [TAB/KOMA] QTY [LOKASI] [EXP_DATE]</code></span>
                      <button
                        type="button"
                        onClick={() => setInputText('SKU-001\t240\tRAK-A01\t15/08/2028\nSKU-002\t180\tRAK-A01\t15/08/2028\nSKU-003\t500\tRAK-A03\t31/12/2028\nSKU-004\t300\tRAK-A04\t10/05/2028')}
                        className="text-emerald-400 hover:underline font-medium cursor-pointer"
                      >
                        Muat Format Contoh
                      </button>
                    </div>
                    <textarea
                      rows={5}
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder={`SKU-001\t240\tRAK-A01\t15/08/2028\nSKU-002\t180\tRAK-A01\t15/08/2028\nSKU-003\t500\tRAK-A03\t31/12/2028`}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500/50 leading-relaxed placeholder-slate-600"
                    />
                  </div>
                )}

                {/* Tab 3: Manual Row Builder */}
                {activeImportTab === 'manual' && (
                  <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5">
                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-bold text-slate-400 mb-1">Pilih SKU dari Katalog</label>
                        <select
                          value={selectedSku}
                          onChange={(e) => setSelectedSku(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500/50"
                        >
                          <option value="">-- Pilih Kode SKU --</option>
                          {catalog.map(c => (
                            <option key={c.id} value={c.skuId}>
                              {c.skuId} - {c.skuName}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-slate-400 mb-1">Jumlah Diterima (Pcs)</label>
                        <input
                          type="number"
                          min="1"
                          placeholder="Contoh: 100"
                          value={manualQty}
                          onChange={(e) => setManualQty(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500/50"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-slate-400 mb-1">Rak Putaway Target</label>
                        <input
                          type="text"
                          placeholder={defaultLocation}
                          value={manualLoc}
                          onChange={(e) => setManualLoc(e.target.value.toUpperCase())}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono uppercase focus:outline-none focus:border-emerald-500/50"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleAddManualRow}
                        className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shadow-md shadow-emerald-500/10"
                      >
                        <Plus className="w-3.5 h-3.5 stroke-[3]" />
                        <span>Tambah Ke Daftar Inbound</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Live Preview Table of Parsed Multi-SKU Items */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-200 flex items-center gap-2 uppercase tracking-wider">
                    <Layers className="w-4 h-4 text-emerald-400" />
                    <span>Daftar Pratinjau SKU Diterima ({validRowsCount} SKU Valid)</span>
                  </h4>

                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 font-mono font-bold text-xs border border-emerald-500/20">
                      Total: {formatNumber(validTotalPcs)} Pcs
                    </span>
                    {parsedRows.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setInputText('')}
                        className="text-[11px] text-rose-400 hover:underline cursor-pointer font-medium"
                      >
                        Bersihkan Semua
                      </button>
                    )}
                  </div>
                </div>

                <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
                      <tr>
                        <th className="p-3">#</th>
                        <th className="p-3">Kode SKU</th>
                        <th className="p-3">Nama Barang</th>
                        <th className="p-3 text-center">Jumlah Pcs</th>
                        <th className="p-3 text-center">Rak Target</th>
                        <th className="p-3 text-center">Expired Date</th>
                        <th className="p-3 text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-slate-300">
                      {parsedRows.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="p-8 text-center text-slate-500">
                            Belum ada baris SKU yang terdeteksi. Silakan upload file Excel atau paste format SKU di atas.
                          </td>
                        </tr>
                      ) : (
                        parsedRows.map((row, idx) => (
                          <tr key={row.id} className={row.isValid ? 'hover:bg-slate-900/50' : 'bg-rose-950/20 text-rose-300'}>
                            <td className="p-3 font-mono text-slate-500">{idx + 1}</td>
                            <td className="p-3 font-bold font-mono text-emerald-400">{row.skuId}</td>
                            <td className="p-3">
                              <div className="font-semibold text-slate-200">{row.skuName}</div>
                              {!row.isValid && row.error && (
                                <div className="text-[10px] text-rose-400 mt-0.5">{row.error}</div>
                              )}
                            </td>
                            <td className="p-3 text-center font-bold font-mono text-slate-100 text-sm">
                              {formatNumber(row.qty)}
                            </td>
                            <td className="p-3 text-center">
                              <div className="flex items-center justify-center gap-1">
                                <input
                                  type="text"
                                  value={row.location}
                                  onChange={(e) => handleUpdateRowLocation(idx, e.target.value)}
                                  className="w-24 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-center font-mono font-bold text-amber-300 uppercase focus:outline-none focus:border-emerald-500"
                                />
                                <button
                                  type="button"
                                  title="Rekomendasi Rak Pintar"
                                  onClick={() => handleUpdateRowLocation(idx, suggestPutawayLocation(row.skuId))}
                                  className="p-1 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 rounded cursor-pointer"
                                >
                                  <Sparkles className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                            <td className="p-3 text-center font-mono text-slate-300">
                              {row.expiredDate}
                            </td>
                            <td className="p-3 text-right">
                              <button
                                type="button"
                                onClick={() => handleRemoveParsedRow(idx)}
                                className="p-1 text-slate-500 hover:text-rose-400 transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>

            {/* Modal Footer Actions */}
            <div className="blues-inbound-modal-footer">
              <div className="text-xs text-slate-400 text-center sm:text-left">
                <span>Siap Diproses: </span>
                <span className="font-bold text-emerald-400 font-mono">{validRowsCount} SKU</span>
                <span> ({formatNumber(validTotalPcs)} Pcs)</span>
                <span className="block text-[11px] text-slate-500 mt-0.5">
                  Mode: <strong className="text-slate-300">{executionMode === 'INSTANT_PUTAWAY' ? 'Langsung Masuk Stok Gudang' : 'Simpan ke Antrean Inbound'}</strong>
                </span>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs rounded-xl cursor-pointer transition-all"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleExecuteInboundBatch}
                  className={`px-5 py-2 font-black text-xs rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${
                    validRowsCount > 0
                      ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20 active:scale-95'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
                  }`}
                  title={validRowsCount === 0 ? 'Upload Excel atau masukkan data SKU terlebih dahulu' : 'Eksekusi Inbound Sekarang'}
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>
                    {executionMode === 'INSTANT_PUTAWAY'
                      ? `Proses Inbound & Masuk Stok (${validRowsCount} SKU)`
                      : `Terima Inbound ke Antrean (${validRowsCount} SKU)`}
                  </span>
                </button>
              </div>
            </div>

        </ModalFrame>
      )}
    </div>
  );
}
