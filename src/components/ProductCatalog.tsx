import React, { useState, useMemo, useRef } from 'react';
import { CatalogItem, StockItem } from '../types';
import { calculatePackQuantities, formatNumber } from '../utils/calculations';
import { getProductBrand, getBarcodeForSku, BARCODE_MAP } from '../data/barcodeMap';
import * as XLSX from 'xlsx';
import { 
  Plus, 
  Search, 
  Package, 
  Trash2, 
  Edit3, 
  X, 
  AlertTriangle, 
  CheckCircle,
  Hash,
  Database,
  Layers,
  ArrowRight,
  Download,
  Upload,
  FileSpreadsheet,
  RefreshCw,
  Link,
  Info,
  Check,
  FileText,
  MapPin,
  Boxes,
  Tag,
  QrCode,
  Copy
} from 'lucide-react';

interface ProductCatalogProps {
  catalog: CatalogItem[];
  stock: StockItem[];
  userRole?: string;
  onAddCatalogItem: (item: Omit<CatalogItem, 'id'>) => Promise<boolean>;
  onUpdateCatalogItem: (skuId: string, updatedFields: Partial<CatalogItem>) => Promise<boolean>;
  onDeleteCatalogItem: (skuId: string) => Promise<boolean>;
  onBatchImportCatalog: (items: Omit<CatalogItem, 'id'>[], mode: 'merge' | 'replace') => Promise<boolean>;
  onSyncStockToCatalog: () => Promise<{ addedCount: number }>;
}

export default function ProductCatalog({
  catalog,
  stock,
  userRole,
  onAddCatalogItem,
  onUpdateCatalogItem,
  onDeleteCatalogItem,
  onBatchImportCatalog,
  onSyncStockToCatalog
}: ProductCatalogProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'ALL' | 'IN_STOCK' | 'NO_STOCK'>('ALL');

  // Modal states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'add' | 'edit'>('add');
  const [editingSkuId, setEditingSkuId] = useState('');

  // Form states
  const [skuIdInput, setSkuIdInput] = useState('');
  const [skuNameInput, setSkuNameInput] = useState('');
  const [brandInput, setBrandInput] = useState('');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [qtyCtnInput, setQtyCtnInput] = useState('144');
  const [qtyInnerInput, setQtyInnerInput] = useState('12');
  const [formError, setFormError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [copiedBarcode, setCopiedBarcode] = useState<string | null>(null);

  // Import Modal States
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importTabMode, setImportTabMode] = useState<'file' | 'paste'>('file');
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [isProcessingImport, setIsProcessingImport] = useState(false);
  const [isSyncingStock, setIsSyncingStock] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // File parse error / preview state
  const [parsedImportRows, setParsedImportRows] = useState<Array<{
    skuId: string;
    skuName: string;
    brand: string;
    barcode: string;
    qtyCtnSize: number;
    qtyInnerSize: number;
    status: 'NEW' | 'UPDATE' | 'INVALID';
    errorReason?: string;
  }>>([]);

  const [catalogConfirmModal, setCatalogConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    warningType?: 'danger' | 'warning' | 'info' | 'success';
    confirmText?: string;
    showCancel?: boolean;
    onConfirm?: () => void;
  } | null>(null);

  const isAdmin = userRole !== 'Packer' && userRole !== 'Picker';

  const handleCopyBarcode = (bc: string) => {
    if (!bc || bc === '-') return;
    navigator.clipboard.writeText(bc);
    setCopiedBarcode(bc);
    setTimeout(() => setCopiedBarcode(null), 2000);
  };

  // 1. STOCK LINKAGE MAP (SKU ID -> Stock statistics)
  const stockSummaryMap = useMemo(() => {
    const map = new Map<string, {
      totalQtyPcs: number;
      locations: Set<string>;
      locationsList: string[];
      stockItemsCount: number;
    }>();

    stock.forEach(item => {
      const skuKey = (item.skuId || '').trim().toUpperCase();
      if (!skuKey) return;

      if (!map.has(skuKey)) {
        map.set(skuKey, {
          totalQtyPcs: 0,
          locations: new Set<string>(),
          locationsList: [],
          stockItemsCount: 0
        });
      }

      const entry = map.get(skuKey)!;
      entry.totalQtyPcs += item.qty;
      entry.stockItemsCount += 1;
      if (item.location) {
        entry.locations.add(item.location.trim().toUpperCase());
      }
    });

    // Convert location sets to arrays
    map.forEach(value => {
      value.locationsList = Array.from(value.locations).sort();
    });

    return map;
  }, [stock]);

  // Unmapped Stock SKUs (stock items that exist in stock but not in catalog)
  const unmappedStockSkus = useMemo(() => {
    const catalogSkuSet = new Set(catalog.map(c => c.skuId.toUpperCase()));
    const unmappedMap = new Map<string, { skuId: string; skuName: string; totalQty: number; locations: Set<string>; locationCount: number }>();

    stock.forEach(item => {
      const normSku = (item.skuId || '').trim().toUpperCase();
      if (normSku && !catalogSkuSet.has(normSku)) {
        if (!unmappedMap.has(normSku)) {
          unmappedMap.set(normSku, {
            skuId: item.skuId,
            skuName: item.skuName || 'SKU Belum Terdaftar Di Katalog',
            totalQty: 0,
            locations: new Set<string>(),
            locationCount: 0
          });
        }
        const entry = unmappedMap.get(normSku)!;
        entry.totalQty += item.qty;
        if (item.location) {
          entry.locations.add(item.location.trim().toUpperCase());
          entry.locationCount = entry.locations.size;
        }
      }
    });

    return Array.from(unmappedMap.values());
  }, [catalog, stock]);

  // Filtered Catalog
  const filteredCatalog = useMemo(() => {
    return catalog.filter(item => {
      const term = searchTerm.toLowerCase();
      const normSku = (item.skuId || '').toUpperCase();
      const itemBrand = getProductBrand(item.skuId, item.skuName, item.brand);
      const itemBarcode = getBarcodeForSku(item.skuId, item.barcode);

      const matchesSearch = (
        normSku.toLowerCase().includes(term) ||
        (item.skuName || '').toLowerCase().includes(term) ||
        (itemBrand || '').toLowerCase().includes(term) ||
        (itemBarcode || '').toLowerCase().includes(term)
      );

      if (!matchesSearch) return false;

      const stockData = stockSummaryMap.get(normSku);
      const hasStock = stockData && stockData.totalQtyPcs > 0;

      if (activeTab === 'IN_STOCK') return hasStock;
      if (activeTab === 'NO_STOCK') return !hasStock;

      return true;
    });
  }, [catalog, searchTerm, activeTab, stockSummaryMap]);

  const displayedCatalog = filteredCatalog;

  // Catalog Statistics
  const stats = useMemo(() => {
    let skusWithStock = 0;
    let totalStockVolumePcs = 0;

    catalog.forEach(item => {
      const normSku = item.skuId.toUpperCase();
      const stockData = stockSummaryMap.get(normSku);
      if (stockData && stockData.totalQtyPcs > 0) {
        skusWithStock += 1;
        totalStockVolumePcs += stockData.totalQtyPcs;
      }
    });

    return {
      totalCatalogSkus: catalog.length,
      skusWithStock,
      totalStockVolumePcs,
      unmappedStockCount: unmappedStockSkus.length
    };
  }, [catalog, stockSummaryMap, unmappedStockSkus]);

  // Modal Open Handlers
  const handleOpenAddModal = () => {
    if (!isAdmin) return;
    setModalMode('add');
    setSkuIdInput('');
    setSkuNameInput('');
    setBrandInput('');
    setBarcodeInput('');
    setQtyCtnInput('144');
    setQtyInnerInput('12');
    setFormError('');
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (item: CatalogItem) => {
    if (!isAdmin) return;
    setModalMode('edit');
    setEditingSkuId(item.skuId);
    setSkuIdInput(item.skuId);
    setSkuNameInput(item.skuName);
    setBrandInput(getProductBrand(item.skuId, item.skuName, item.brand));
    setBarcodeInput(getBarcodeForSku(item.skuId, item.barcode));
    setQtyCtnInput(String(item.qtyCtnSize));
    setQtyInnerInput(String(item.qtyInnerSize));
    setFormError('');
    setIsModalOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setSuccessMsg('');

    const trimmedSkuId = skuIdInput.trim().toUpperCase();
    const trimmedSkuName = skuNameInput.trim();
    const trimmedBrand = getProductBrand(trimmedSkuId, trimmedSkuName, brandInput.trim());
    const rawBarcode = barcodeInput.trim();
    const trimmedBarcode = modalMode === 'edit'
      ? (rawBarcode && rawBarcode !== '-' ? rawBarcode : (BARCODE_MAP[trimmedSkuId] || '-'))
      : getBarcodeForSku(trimmedSkuId, rawBarcode);
    const ctnVal = parseInt(qtyCtnInput, 10);
    const innerVal = parseInt(qtyInnerInput, 10);

    if (!trimmedSkuId) {
      setFormError('SKU ID tidak boleh kosong.');
      return;
    }
    if (!trimmedSkuName) {
      setFormError('Nama SKU tidak boleh kosong.');
      return;
    }
    if (isNaN(ctnVal) || ctnVal <= 0) {
      setFormError('Qty CTN harus berupa angka positif.');
      return;
    }
    if (isNaN(innerVal) || innerVal <= 0) {
      setFormError('Qty Inner harus berupa angka positif.');
      return;
    }

    if (modalMode === 'add') {
      const exists = catalog.some(item => item.skuId.toUpperCase() === trimmedSkuId);
      if (exists) {
        setFormError(`SKU "${trimmedSkuId}" sudah terdaftar dalam katalog.`);
        return;
      }

      const success = await onAddCatalogItem({
        skuId: trimmedSkuId,
        skuName: trimmedSkuName,
        brand: trimmedBrand,
        barcode: trimmedBarcode,
        qtyCtnSize: ctnVal,
        qtyInnerSize: innerVal
      });

      if (success) {
        setSuccessMsg(`SKU "${trimmedSkuId}" (${trimmedBrand}) berhasil ditambahkan dan terhubung dengan sistem barcode & stok.`);
        setIsModalOpen(false);
      } else {
        setFormError('Gagal menambahkan item ke katalog. Silakan coba lagi.');
      }
    } else {
      const success = await onUpdateCatalogItem(editingSkuId, {
        skuName: trimmedSkuName,
        brand: trimmedBrand,
        barcode: trimmedBarcode,
        qtyCtnSize: ctnVal,
        qtyInnerSize: innerVal
      });

      if (success) {
        setSuccessMsg(`SKU "${trimmedSkuId}" berhasil diperbarui. Data Brand, Barcode & stok terhubung otomatis.`);
        setIsModalOpen(false);
      } else {
        setFormError('Gagal memperbarui item katalog. Silakan coba lagi.');
      }
    }
  };

  const handleDeleteItem = async (item: CatalogItem) => {
    if (!isAdmin) return;
    if (confirm(`Apakah Anda yakin ingin menghapus SKU "${item.skuId}" dari katalog?\n\nTindakan ini tidak akan menghapus stok fisik yang ada di sistem.`)) {
      const success = await onDeleteCatalogItem(item.skuId);
      if (success) {
        setSuccessMsg(`SKU "${item.skuId}" berhasil dihapus dari katalog.`);
      } else {
        alert('Gagal menghapus item dari katalog.');
      }
    }
  };

  // Sync Missing Stock SKUs to Catalog
  const handleSyncStock = async () => {
    setIsSyncingStock(true);
    setSuccessMsg('');
    const res = await onSyncStockToCatalog();
    setIsSyncingStock(false);
    if (res.addedCount > 0) {
      setSuccessMsg(`Berhasil menyinkronkan ${res.addedCount} SKU stok ke katalog master barang beserta Brand & Barcode sistem!`);
    } else {
      setSuccessMsg('Semua data stok sistem sudah terdaftar di katalog master barang.');
    }
  };

  // EXPORT CATALOG TO EXCEL
  const handleExportCatalog = () => {
    const catalogRows = catalog.map((item, idx) => {
      const normSku = item.skuId.toUpperCase();
      const itemBrand = getProductBrand(item.skuId, item.skuName, item.brand);
      const itemBarcode = getBarcodeForSku(item.skuId, item.barcode);
      const stockData = stockSummaryMap.get(normSku);
      const totalQtyPcs = stockData ? stockData.totalQtyPcs : 0;
      const locationCount = stockData ? stockData.locationsList.length : 0;
      const locationsStr = stockData && stockData.locationsList.length > 0 ? stockData.locationsList.join(', ') : '-';
      
      const splits = calculatePackQuantities(totalQtyPcs, item.qtyCtnSize, item.qtyInnerSize);

      return {
        'NO': idx + 1,
        'SKU ID': item.skuId,
        'NAMA BARANG / SKU': item.skuName,
        'BRAND': itemBrand,
        'BARCODE (TERHUBUNG SCANNER)': itemBarcode,
        'QTY CTN (PCS)': item.qtyCtnSize,
        'QTY INNER (PCS)': item.qtyInnerSize,
        'TOTAL STOK SISTEM (PCS)': totalQtyPcs,
        'STOK KARTON (CTN)': splits.qtyCtn,
        'STOK INNER (BOX)': splits.qtyInner,
        'STOK LOOSE (PCS)': splits.qtyLoose,
        'JUMLAH LOKASI RAK': locationCount,
        'DAFTAR LOKASI RAK': locationsStr,
        'STATUS STOK': totalQtyPcs > 0 ? 'TERHUBUNG (ADA STOK)' : 'BELUM ADA STOK'
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(catalogRows);

    // Auto fit column width
    worksheet['!cols'] = [
      { wch: 6 },
      { wch: 18 },
      { wch: 38 },
      { wch: 18 },
      { wch: 22 },
      { wch: 15 },
      { wch: 15 },
      { wch: 22 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 30 },
      { wch: 24 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'KATALOG_MASTER_BARANG');

    const timestamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `Katalog_Master_Barang_WMS_${timestamp}.xlsx`);
  };

  // DOWNLOAD TEMPLATE EXCEL FOR IMPORT
  const handleDownloadTemplate = () => {
    const templateData = [
      {
        'SKU ID': 'SKU-001',
        'Nama Barang': 'SKU-001 Produk Contoh 1',
        'Brand': '',
        'Barcode': '',
        'Qty CTN': 1000,
        'Qty Inner': 12
      },
      {
        'SKU ID': 'SKU-002',
        'Nama Barang': 'SKU-002 Produk Contoh 2',
        'Brand': '',
        'Barcode': '',
        'Qty CTN': 576,
        'Qty Inner': 12
      },
      {
        'SKU ID': 'SKU-003',
        'Nama Barang': 'SKU-003 Produk Contoh 3',
        'Brand': '',
        'Barcode': '',
        'Qty CTN': 720,
        'Qty Inner': 120
      },
      {
        'SKU ID': 'SKU-004',
        'Nama Barang': 'SKU-004 Produk Contoh 4',
        'Brand': '',
        'Barcode': '',
        'Qty CTN': 576,
        'Qty Inner': 12
      }
    ];

    const worksheet = XLSX.utils.json_to_sheet(templateData);
    worksheet['!cols'] = [
      { wch: 18 },
      { wch: 36 },
      { wch: 18 },
      { wch: 20 },
      { wch: 15 },
      { wch: 15 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'TEMPLATE_IMPORT');
    XLSX.writeFile(workbook, 'Template_Import_Katalog_Barang.xlsx');
  };

  // FILE IMPORT / PARSE HANDLERS
  const parseRawSheetData = (rawJson: any[]) => {
    const catalogMap = new Map<string, CatalogItem>();
    catalog.forEach(c => catalogMap.set(c.skuId.toUpperCase(), c));

    const parsed: Array<{
      skuId: string;
      skuName: string;
      brand: string;
      barcode: string;
      qtyCtnSize: number;
      qtyInnerSize: number;
      status: 'NEW' | 'UPDATE' | 'INVALID';
      errorReason?: string;
    }> = [];

    rawJson.forEach((row: any) => {
      // Find keys flexibly
      const keys = Object.keys(row);
      const getVal = (possibleNames: string[]) => {
        const foundKey = keys.find(k => {
          const cleanK = k.trim().toLowerCase().replace(/[\_\-\/\s]/g, '');
          return possibleNames.some(p => p.toLowerCase().replace(/[\_\-\/\s]/g, '') === cleanK);
        });
        return foundKey ? row[foundKey] : undefined;
      };

      const rawSkuId = String(getVal(['sku id', 'kodesku', 'sku', 'kode barang', 'id sku', 'skuid']) || '').trim().toUpperCase();
      const rawSkuName = String(getVal(['nama barang', 'namasku', 'nama product', 'nama', 'description', 'product name', 'skuname']) || '').trim();
      const rawBrandInput = String(getVal(['brand', 'merk', 'merek', 'pabrik', 'produsen', 'vendor']) || '').trim();
      const rawBarcodeInput = String(getVal(['barcode', 'upc', 'ean', 'kode barcode', 'qr', 'scancode']) || '').trim();

      const rawQtyCtn = parseInt(getVal(['qty ctn', 'qty ctn size', 'qtyctn', 'ctn size', 'ctn', 'karton', 'qty karton']) || '144', 10);
      const rawQtyInner = parseInt(getVal(['qty inner', 'qty inner size', 'qtyinner', 'inner size', 'inner', 'box', 'qty box']) || '12', 10);

      if (!rawSkuId) {
        parsed.push({
          skuId: '-',
          skuName: rawSkuName || '-',
          brand: rawBrandInput || '-',
          barcode: rawBarcodeInput || '-',
          qtyCtnSize: rawQtyCtn || 144,
          qtyInnerSize: rawQtyInner || 12,
          status: 'INVALID',
          errorReason: 'SKU ID Kosong'
        });
        return;
      }

      if (!rawSkuName) {
        parsed.push({
          skuId: rawSkuId,
          skuName: '-',
          brand: rawBrandInput || getProductBrand(rawSkuId, rawSkuName),
          barcode: rawBarcodeInput || getBarcodeForSku(rawSkuId),
          qtyCtnSize: rawQtyCtn || 144,
          qtyInnerSize: rawQtyInner || 12,
          status: 'INVALID',
          errorReason: 'Nama Barang Kosong'
        });
        return;
      }

      const isUpdate = catalogMap.has(rawSkuId);
      const resolvedBrand = getProductBrand(rawSkuId, rawSkuName, rawBrandInput);
      const resolvedBarcode = getBarcodeForSku(rawSkuId, rawBarcodeInput);

      parsed.push({
        skuId: rawSkuId,
        skuName: rawSkuName,
        brand: resolvedBrand,
        barcode: resolvedBarcode,
        qtyCtnSize: isNaN(rawQtyCtn) || rawQtyCtn <= 0 ? 144 : rawQtyCtn,
        qtyInnerSize: isNaN(rawQtyInner) || rawQtyInner <= 0 ? 12 : rawQtyInner,
        status: isUpdate ? 'UPDATE' : 'NEW'
      });
    });

    setParsedImportRows(parsed);
  };

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rawJson = XLSX.utils.sheet_to_json(worksheet);
        parseRawSheetData(rawJson);
      } catch (err) {
        console.error('Error parsing excel:', err);
        alert('Gagal membaca file Excel/CSV. Pastikan format file valid.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
    if (e.target) e.target.value = '';
  };

  const handleParsePastedText = () => {
    if (!importText.trim()) {
      setParsedImportRows([]);
      return;
    }

    const lines = importText.split('\n');
    const rawJson: any[] = [];

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      
      // Split by tab or comma
      const parts = trimmed.includes('\t') ? trimmed.split('\t') : trimmed.split(',');
      if (parts.length >= 2) {
        const skuId = parts[0].trim();
        const skuName = parts[1].trim();
        const brand = parts[2] ? parts[2].trim() : '';
        const barcode = parts[3] ? parts[3].trim() : '';
        const qtyCtn = parts[4] ? parseInt(parts[4].trim(), 10) : 144;
        const qtyInner = parts[5] ? parseInt(parts[5].trim(), 10) : 12;

        if (skuId.toLowerCase() === 'sku id' || skuId.toLowerCase() === 'sku') return; // skip header line

        rawJson.push({
          'SKU ID': skuId,
          'Nama Barang': skuName,
          'Brand': brand,
          'Barcode': barcode,
          'Qty CTN': qtyCtn,
          'Qty Inner': qtyInner
        });
      }
    });

    parseRawSheetData(rawJson);
  };

  const executeCatalogImport = async (validItems: typeof parsedImportRows) => {
    setIsProcessingImport(true);

    const itemsToImport = validItems.map(item => ({
      skuId: item.skuId.toUpperCase(),
      skuName: item.skuName,
      brand: item.brand,
      barcode: item.barcode,
      qtyCtnSize: item.qtyCtnSize,
      qtyInnerSize: item.qtyInnerSize
    }));

    const success = await onBatchImportCatalog(itemsToImport, importMode);
    setIsProcessingImport(false);

    if (success) {
      setSuccessMsg(`Berhasil meng-import ${itemsToImport.length} SKU ke katalog master barang! Brand, Barcode & stok terhubung otomatis.`);
      setIsImportModalOpen(false);
      setParsedImportRows([]);
      setImportText('');

      setCatalogConfirmModal({
        isOpen: true,
        title: 'Import Katalog Berhasil!',
        message: `✓ Berhasil meng-import ${itemsToImport.length} SKU ke katalog master barang! Brand, Barcode & stok terhubung otomatis.`,
        warningType: 'success',
        confirmText: 'OK, SELESAI',
        showCancel: false,
        onConfirm: () => setCatalogConfirmModal(null)
      });
    } else {
      setCatalogConfirmModal({
        isOpen: true,
        title: 'Gagal Import Katalog',
        message: 'Gagal meng-import data katalog. Silakan periksa koneksi atau format data lalu coba lagi.',
        warningType: 'danger',
        confirmText: 'OK, Coba Lagi',
        showCancel: false,
        onConfirm: () => setCatalogConfirmModal(null)
      });
    }
  };

  const handleConfirmImport = async () => {
    const validItems = parsedImportRows.filter(r => r.status !== 'INVALID');
    if (validItems.length === 0) {
      setCatalogConfirmModal({
        isOpen: true,
        title: 'Data Tidak Valid',
        message: 'Tidak ada data valid yang terdeteksi untuk di-import.',
        warningType: 'info',
        confirmText: 'OK',
        showCancel: false,
        onConfirm: () => setCatalogConfirmModal(null)
      });
      return;
    }

    if (importMode === 'replace') {
      setCatalogConfirmModal({
        isOpen: true,
        title: 'Konfirmasi Gantikan Seluruh Katalog',
        message: `PERINGATAN SANGAT PENTING:\nAnda memilih mode "Gantikan Seluruh Katalog".\nSemua ${catalog.length} item katalog lama akan DIHAPUS dan digantikan dengan ${validItems.length} item katalog baru ini.\n\nApakah Anda YAKIN ingin melanjutkan?`,
        warningType: 'danger',
        confirmText: 'OK, YA GANTIKAN & IMPORT',
        showCancel: true,
        onConfirm: () => {
          setCatalogConfirmModal(null);
          executeCatalogImport(validItems);
        }
      });
      return;
    }

    executeCatalogImport(validItems);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-gradient-to-r from-indigo-900/40 via-slate-900/40 to-emerald-950/20 rounded-2xl p-5 sm:p-6 border border-slate-800/80 shadow-lg relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-5 pointer-events-none">
          <Database className="w-48 h-48" />
        </div>
        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-black text-slate-100 tracking-tight flex items-center gap-2">
                <Database className="w-6 h-6 text-indigo-400" />
                Katalog Master Barang & Sinkronisasi Stok
              </h1>
              <span className="text-[10px] font-mono bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <Link className="w-3 h-3" /> System Connected
              </span>
            </div>
            <p className="text-xs text-slate-400 max-w-2xl">
              Pusat data master produk yang mendefinisikan SKU, nama barang, merek, barcode, dan ukuran kemasan. Data terhubung dengan scanner barcode dan stok fisik di seluruh rak gudang.
            </p>
          </div>

          {/* Top Action Buttons */}
          <div className="flex items-center flex-wrap gap-2.5 shrink-0 self-start lg:self-center">
            {/* Export Excel Button */}
            <button
              onClick={handleExportCatalog}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 active:scale-95 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md"
              title="Export Katalog ke file Excel (.xlsx) beserta Brand & Barcode"
            >
              <Download className="w-4 h-4 text-emerald-400" />
              <span>Export Excel</span>
            </button>

            {/* Import Excel Button */}
            {isAdmin && (
              <button
                onClick={() => {
                  setParsedImportRows([]);
                  setImportText('');
                  setIsImportModalOpen(true);
                }}
                className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 active:scale-95 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md"
                title="Import data katalog dari file Excel / teks"
              >
                <Upload className="w-4 h-4 text-indigo-400" />
                <span>Import Excel</span>
              </button>
            )}

            {/* Add New SKU Button */}
            {isAdmin && (
              <button
                id="btn-add-catalog-item"
                onClick={handleOpenAddModal}
                className="flex items-center justify-center gap-1.5 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 active:scale-95 text-xs font-bold text-white rounded-xl transition-all cursor-pointer shadow-lg shadow-indigo-500/10"
              >
                <Plus className="w-4 h-4" />
                <span>Tambah SKU Baru</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Connected Stock Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[#11141B] border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between space-y-2 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider font-mono">Total SKU Katalog</span>
            <Database className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <div className="text-xl font-black text-white font-mono">{formatNumber(stats.totalCatalogSkus)}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Master SKU terdaftar</div>
          </div>
        </div>

        <div className="bg-[#11141B] border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between space-y-2 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider font-mono">Terhubung Stok</span>
            <Link className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <div className="text-xl font-black text-emerald-400 font-mono">
              {formatNumber(stats.skusWithStock)} <span className="text-xs text-slate-500 font-normal">/ {stats.totalCatalogSkus} SKU</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">Aktif di stok gudang</div>
          </div>
        </div>

        <div className="bg-[#11141B] border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between space-y-2 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider font-mono">Total Volume Stok</span>
            <Boxes className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <div className="text-xl font-black text-cyan-400 font-mono">{formatNumber(stats.totalStockVolumePcs)} <span className="text-xs text-slate-500 font-normal">Pcs</span></div>
            <div className="text-[10px] text-slate-500 mt-0.5">Total pcs terhubung</div>
          </div>
        </div>

        <div className="bg-[#11141B] border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between space-y-2 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider font-mono">Stok Belum Di Katalog</span>
            <AlertTriangle className={`w-4 h-4 ${stats.unmappedStockCount > 0 ? 'text-amber-400' : 'text-slate-600'}`} />
          </div>
          <div>
            <div className={`text-xl font-black font-mono ${stats.unmappedStockCount > 0 ? 'text-amber-400' : 'text-slate-400'}`}>
              {formatNumber(stats.unmappedStockCount)} <span className="text-xs text-slate-500 font-normal">SKU</span>
            </div>
            {isAdmin && stats.unmappedStockCount > 0 ? (
              <button
                onClick={handleSyncStock}
                disabled={isSyncingStock}
                className="mt-1 text-[10px] text-amber-300 underline hover:text-amber-200 font-bold flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${isSyncingStock ? 'animate-spin' : ''}`} />
                <span>Daftarkan otomatis</span>
              </button>
            ) : (
              <div className="text-[10px] text-slate-500 mt-0.5">Semua stok terdaftar</div>
            )}
          </div>
        </div>
      </div>

      {/* Success Notification */}
      {successMsg && (
        <div className="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 text-xs text-emerald-400">
          <CheckCircle className="w-4 h-4 shrink-0 text-emerald-500" />
          <span className="font-medium">{successMsg}</span>
        </div>
      )}

      {/* Main Filter & Table Area */}
      <div className="bg-[#11141B] rounded-2xl border border-slate-800/80 shadow-md overflow-hidden">
        {/* Search Bar & Tabs */}
        <div className="p-4 border-b border-slate-800/60 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
            <input
              type="text"
              placeholder="Cari SKU ID, Nama Barang, Brand, atau Barcode..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto">
            <button
              onClick={() => setActiveTab('ALL')}
              className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
                activeTab === 'ALL'
                  ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/20'
                  : 'bg-[#161B25] text-slate-400 hover:text-slate-200'
              }`}
            >
              Semua SKU ({catalog.length})
            </button>
            <button
              onClick={() => setActiveTab('IN_STOCK')}
              className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
                activeTab === 'IN_STOCK'
                  ? 'bg-emerald-500 text-slate-950 font-black shadow-md shadow-emerald-500/20'
                  : 'bg-[#161B25] text-slate-400 hover:text-slate-200'
              }`}
            >
              Ada di Stok ({stats.skusWithStock})
            </button>
            <button
              onClick={() => setActiveTab('NO_STOCK')}
              className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
                activeTab === 'NO_STOCK'
                  ? 'bg-slate-700 text-slate-100 font-bold shadow-md'
                  : 'bg-[#161B25] text-slate-400 hover:text-slate-200'
              }`}
            >
              Belum Ada Stok ({catalog.length - stats.skusWithStock})
            </button>
          </div>
        </div>

        {/* Catalog Table */}
        <div 
          className="overflow-x-auto max-h-[680px] overflow-y-auto relative scroll-smooth border-b border-slate-850"
        >
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-20 bg-[#11141B]">
              <tr className="bg-slate-950/80 backdrop-blur-md text-[10px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-850 shadow-sm">
                <th className="py-3 px-4 w-32">SKU ID</th>
                <th className="py-3 px-4">Nama Barang</th>
                <th className="py-3 px-4 w-32">Brand</th>
                <th className="py-3 px-4 text-center w-36">Barcode</th>
                <th className="py-3 px-4 text-center w-28">Qty / CTN</th>
                <th className="py-3 px-4 text-center w-28">Qty / Inner</th>
                <th className="py-3 px-4 text-center w-44">Stok Sistem (Pcs)</th>
                <th className="py-3 px-4 text-center w-36">Lokasi Rak</th>
                {isAdmin && <th className="py-3 px-4 text-center w-20">Aksi</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850/60 text-xs">
              {filteredCatalog.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 9 : 8} className="py-12 text-center text-slate-500">
                    <Package className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                    Tidak ada SKU yang cocok dengan pencarian / filter Anda.
                  </td>
                </tr>
              ) : (
                <>
                  {displayedCatalog.map((item) => {
                  const normSku = item.skuId.toUpperCase();
                  const itemBrand = getProductBrand(item.skuId, item.skuName, item.brand);
                  const itemBarcode = getBarcodeForSku(item.skuId, item.barcode);
                  const stockData = stockSummaryMap.get(normSku);
                  const totalQtyPcs = stockData ? stockData.totalQtyPcs : 0;
                  const locationsList = stockData ? stockData.locationsList : [];
                  const splits = calculatePackQuantities(totalQtyPcs, item.qtyCtnSize, item.qtyInnerSize);

                  return (
                    <tr key={item.skuId} className="hover:bg-slate-800/20 transition-colors">
                      <td className="py-3.5 px-4 font-mono font-black text-indigo-400 select-all">
                        {item.skuId}
                      </td>
                      <td className="py-3.5 px-4 font-semibold text-slate-200">
                        {item.skuName}
                      </td>
                      {/* Brand Column beside Item Name */}
                      <td className="py-3.5 px-4">
                        <span className="inline-flex items-center gap-1 font-bold text-[10px] px-2.5 py-1 rounded-md bg-purple-950/60 border border-purple-500/30 text-purple-300">
                          <Tag className="w-2.5 h-2.5 text-purple-400" />
                          {itemBrand}
                        </span>
                      </td>
                      {/* Barcode Column connected to system */}
                      <td className="py-3.5 px-4 text-center">
                        <div className="flex items-center justify-center">
                          <button
                            onClick={() => handleCopyBarcode(itemBarcode)}
                            title="Klik untuk salin barcode scanner"
                            className="inline-flex items-center gap-1 font-mono text-[11px] font-bold px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-300 hover:border-indigo-500 hover:text-indigo-300 transition-all cursor-pointer group"
                          >
                            <QrCode className="w-3 h-3 text-indigo-400 group-hover:scale-110 transition-transform" />
                            <span>{itemBarcode}</span>
                            {copiedBarcode === itemBarcode ? (
                              <Check className="w-2.5 h-2.5 text-emerald-400 ml-0.5" />
                            ) : (
                              <Copy className="w-2.5 h-2.5 text-slate-500 opacity-0 group-hover:opacity-100 ml-0.5 transition-opacity" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-center font-bold text-emerald-400 font-mono">
                        {item.qtyCtnSize} <span className="text-[10px] font-normal text-slate-500">pcs</span>
                      </td>
                      <td className="py-3.5 px-4 text-center font-bold text-amber-400 font-mono">
                        {item.qtyInnerSize} <span className="text-[10px] font-normal text-slate-500">pcs</span>
                      </td>
                      {/* Stok Sistem Connected Column */}
                      <td className="py-3.5 px-4 text-center">
                        {totalQtyPcs > 0 ? (
                          <div className="space-y-0.5">
                            <span className="font-mono font-black text-emerald-400 text-xs">
                              {formatNumber(totalQtyPcs)} Pcs
                            </span>
                            <div className="text-[10px] text-slate-400 font-mono">
                              {splits.qtyCtn > 0 && <span className="text-emerald-300 font-semibold">{splits.qtyCtn} Ctn </span>}
                              {splits.qtyInner > 0 && <span className="text-amber-300 font-semibold">{splits.qtyInner} Inner </span>}
                              {splits.qtyLoose > 0 && <span className="text-slate-400">{splits.qtyLoose} Loose</span>}
                            </div>
                          </div>
                        ) : (
                          <span className="inline-block text-[10px] font-bold bg-slate-800/80 text-slate-500 px-2.5 py-1 rounded-md font-mono">
                            Belum Ada Stok
                          </span>
                        )}
                      </td>
                      {/* Lokasi Rak Column */}
                      <td className="py-3.5 px-4 text-center">
                        {locationsList.length > 0 ? (
                          <div className="flex items-center justify-center flex-wrap gap-1 max-w-[140px] mx-auto">
                            {locationsList.slice(0, 3).map(loc => (
                              <span key={loc} className="text-[10px] font-mono font-bold bg-indigo-950/60 border border-indigo-500/30 text-indigo-300 px-1.5 py-0.5 rounded">
                                {loc}
                              </span>
                            ))}
                            {locationsList.length > 3 && (
                              <span className="text-[9px] font-mono text-slate-400 font-bold" title={locationsList.join(', ')}>
                                +{locationsList.length - 3} rak
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-600 text-[11px]">-</span>
                        )}
                      </td>
                      {isAdmin && (
                        <td className="py-3.5 px-4 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              title="Edit Item Katalog"
                              onClick={() => handleOpenEditModal(item)}
                              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              title="Hapus Item"
                              onClick={() => handleDeleteItem(item)}
                              className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Catalog Add/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[#11141B] rounded-2xl border border-slate-800 shadow-2xl overflow-hidden relative">
            <button
              onClick={() => setIsModalOpen(false)}
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="p-5 border-b border-slate-850">
              <h2 className="text-sm font-black text-slate-200 tracking-tight flex items-center gap-2">
                <Database className="w-4.5 h-4.5 text-indigo-400" />
                {modalMode === 'add' ? 'Tambah SKU Baru ke Katalog' : `Edit SKU: ${editingSkuId}`}
              </h2>
            </div>

            <form onSubmit={handleFormSubmit} className="p-5 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs p-2.5 rounded-lg">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                  <span>{formError}</span>
                </div>
              )}

              {/* SKU ID Input */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">
                  SKU ID (Kode SKU)
                </label>
                <input
                  type="text"
                  required
                  disabled={modalMode === 'edit'}
                  placeholder="e.g. SKU-001"
                  value={skuIdInput}
                  onChange={(e) => setSkuIdInput(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 uppercase font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>

              {/* SKU Name Input */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">
                  Nama SKU / Barang
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. SKU-001 Produk Contoh"
                  value={skuNameInput}
                  onChange={(e) => setSkuNameInput(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>

              {/* Brand and Barcode inputs */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5 text-purple-400" /> Brand / Merk
                  </label>
                  <input
                    type="text"
                    list="brand-suggestions"
                    placeholder="contoh brand"
                    value={brandInput}
                    onChange={(e) => setBrandInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 font-semibold"
                  />
                  <datalist id="brand-suggestions">
                      <option value="Merek Contoh" />
                  </datalist>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1">
                    <QrCode className="w-3.5 h-3.5 text-indigo-400" /> Barcode
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. "
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              {/* Pack Sizes */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1">
                    <Layers className="w-3.5 h-3.5 text-emerald-400" /> Qty / CTN
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={qtyCtnInput}
                    onChange={(e) => setQtyCtnInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 font-mono"
                  />
                  <span className="text-[9px] text-slate-500 mt-1 block">Berapa pcs dalam 1 Karton</span>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1">
                    <Hash className="w-3.5 h-3.5 text-amber-400" /> Qty / INNER
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={qtyInnerInput}
                    onChange={(e) => setQtyInnerInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 font-mono"
                  />
                  <span className="text-[9px] text-slate-500 mt-1 block">Berapa pcs dalam 1 Inner box</span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-4 flex items-center justify-end gap-3 border-t border-slate-850">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 active:scale-95 text-xs font-bold text-white rounded-xl transition-all cursor-pointer shadow-lg shadow-indigo-500/10 flex items-center gap-1.5"
                >
                  <span>Simpan Katalog</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* IMPORT EXCEL MODAL */}
      {isImportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-3xl bg-[#11141B] rounded-2xl border border-slate-800 shadow-2xl overflow-hidden my-8 relative">
            <button
              onClick={() => setIsImportModalOpen(false)}
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors cursor-pointer z-10"
            >
              <X className="w-4.5 h-4.5" />
            </button>

            <div className="p-5 border-b border-slate-850 bg-slate-900/40">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-indigo-400" />
                <h2 className="text-base font-black text-slate-100 tracking-tight">
                  Import Data Katalog Master Barang (Excel / CSV)
                </h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Upload file Excel (.xlsx, .xls) atau salin data dari spreadsheet. Sistem akan memetakan kolom SKU ID, Nama Barang, Qty CTN, dan Qty Inner secara otomatis.
              </p>
            </div>

            <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto">
              {/* Download Template Banner */}
              <div className="flex items-center justify-between bg-indigo-950/40 border border-indigo-500/30 rounded-xl p-3 text-xs text-indigo-200">
                <div className="flex items-center gap-2.5">
                  <Info className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span>Belum memiliki format file? Unduh template resmi kami.</span>
                </div>
                <button
                  onClick={handleDownloadTemplate}
                  className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-lg transition-all text-xs cursor-pointer shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Unduh Template</span>
                </button>
              </div>

              {/* Import Source Tabs */}
              <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                <button
                  onClick={() => setImportTabMode('file')}
                  className={`px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
                    importTabMode === 'file'
                      ? 'bg-indigo-500 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200 bg-[#161B25]'
                  }`}
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload File Excel (.xlsx)</span>
                </button>
                <button
                  onClick={() => setImportTabMode('paste')}
                  className={`px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
                    importTabMode === 'paste'
                      ? 'bg-indigo-500 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200 bg-[#161B25]'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Copy - Paste Text Spreadsheet</span>
                </button>
              </div>

              {/* Tab 1: Upload File */}
              {importTabMode === 'file' && (
                <div>
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept=".xlsx, .xls, .csv"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.dataTransfer.files?.[0]) {
                        processFile(e.dataTransfer.files[0]);
                      }
                    }}
                    className="border-2 border-dashed border-slate-700 hover:border-indigo-500/70 bg-[#161B25]/60 rounded-2xl p-8 text-center cursor-pointer transition-all hover:bg-indigo-950/10 group"
                  >
                    <Upload className="w-10 h-10 mx-auto text-slate-500 group-hover:text-indigo-400 mb-3 transition-colors" />
                    <div className="text-xs font-bold text-slate-200 group-hover:text-white">
                      Klik di sini untuk memilih file Excel / CSV
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1 font-mono">
                      Format didukung: .xlsx, .xls, .csv
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: Paste Data */}
              {importTabMode === 'paste' && (
                <div className="space-y-2">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase">
                    Tempel Data dari Excel / Google Sheets (Kolom: SKU ID | Nama Barang | Qty CTN | Qty Inner)
                  </label>
                  <textarea
                    rows={5}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder={`SKU-001\tProduk Contoh 1\t1000\t12\nSKU-002\tProduk Contoh 2\t576\t12`}
                    className="w-full p-3 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    onClick={handleParsePastedText}
                    className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 rounded-xl transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Pratinjau Data Tempelan</span>
                  </button>
                </div>
              )}

              {/* Parsed Preview Section */}
              {parsedImportRows.length > 0 && (
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between border-t border-slate-800 pt-4">
                    <h3 className="text-xs font-black text-slate-200 flex items-center gap-2">
                      <span>Pratinjau Hasil Pembacaan Data</span>
                      <span className="text-[10px] bg-indigo-950 border border-indigo-500/30 text-indigo-300 px-2 py-0.5 rounded-full font-mono">
                        {parsedImportRows.length} Baris
                      </span>
                    </h3>

                    <div className="flex items-center gap-3 text-[10px] font-mono">
                      <span className="text-emerald-400 font-bold">
                        +{parsedImportRows.filter(r => r.status === 'NEW').length} SKU Baru
                      </span>
                      <span className="text-amber-400 font-bold">
                        ~{parsedImportRows.filter(r => r.status === 'UPDATE').length} Update SKU
                      </span>
                      {parsedImportRows.filter(r => r.status === 'INVALID').length > 0 && (
                        <span className="text-rose-400 font-bold">
                          !{parsedImportRows.filter(r => r.status === 'INVALID').length} Tidak Valid
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Preview Table */}
                  <div className="max-h-48 overflow-y-auto border border-slate-800 rounded-xl overflow-hidden bg-[#161B25]">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-900/80 text-[10px] font-bold text-slate-400 uppercase sticky top-0">
                        <tr>
                          <th className="p-2.5">SKU ID</th>
                          <th className="p-2.5">Nama Barang</th>
                          <th className="p-2.5">Brand</th>
                          <th className="p-2.5 font-mono">Barcode</th>
                          <th className="p-2.5 text-center">Qty / CTN</th>
                          <th className="p-2.5 text-center">Qty / Inner</th>
                          <th className="p-2.5 text-center">Status Import</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 font-mono">
                        {parsedImportRows.slice(0, 50).map((row, idx) => (
                          <tr key={idx} className="hover:bg-slate-800/30">
                            <td className="p-2 font-bold text-indigo-400">{row.skuId}</td>
                            <td className="p-2 text-slate-200 font-sans">{row.skuName}</td>
                            <td className="p-2 text-purple-300 font-sans text-[11px] font-bold">{row.brand || '-'}</td>
                            <td className="p-2 text-slate-300 text-[11px] font-mono">{row.barcode || '-'}</td>
                            <td className="p-2 text-center text-emerald-400 font-bold">{row.qtyCtnSize}</td>
                            <td className="p-2 text-center text-amber-400 font-bold">{row.qtyInnerSize}</td>
                            <td className="p-2 text-center">
                              {row.status === 'NEW' && (
                                <span className="bg-emerald-500/15 text-emerald-400 text-[9px] font-extrabold px-2 py-0.5 rounded-full border border-emerald-500/30">
                                  + BARU
                                </span>
                              )}
                              {row.status === 'UPDATE' && (
                                <span className="bg-amber-500/15 text-amber-400 text-[9px] font-extrabold px-2 py-0.5 rounded-full border border-amber-500/30">
                                  ~ UPDATE
                                </span>
                              )}
                              {row.status === 'INVALID' && (
                                <span className="bg-rose-500/15 text-rose-400 text-[9px] font-extrabold px-2 py-0.5 rounded-full border border-rose-500/30" title={row.errorReason}>
                                  ! INVALID
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mode Selection */}
                  <div className="bg-[#161B25] p-3.5 rounded-xl border border-slate-800 space-y-2">
                    <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono">
                      Pilihan Mode Simpan Data Import Katalog:
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-all ${
                        importMode === 'merge'
                          ? 'bg-indigo-500/10 border-indigo-500 text-white'
                          : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}>
                        <input
                          type="radio"
                          name="catalogImportMode"
                          checked={importMode === 'merge'}
                          onChange={() => setImportMode('merge')}
                          className="mt-0.5 accent-indigo-500"
                        />
                        <div>
                          <div className="text-xs font-bold text-slate-100">Gabungkan / Update (Rekomendasi)</div>
                          <div className="text-[10px] text-slate-400">Tambahkan SKU baru dan perbarui informasi ukuran SKU yang sudah ada.</div>
                        </div>
                      </label>

                      <label className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-all ${
                        importMode === 'replace'
                          ? 'bg-rose-500/10 border-rose-500 text-white'
                          : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}>
                        <input
                          type="radio"
                          name="catalogImportMode"
                          checked={importMode === 'replace'}
                          onChange={() => setImportMode('replace')}
                          className="mt-0.5 accent-rose-500"
                        />
                        <div>
                          <div className="text-xs font-bold text-rose-400">Gantikan Seluruh Katalog</div>
                          <div className="text-[10px] text-slate-400">Hapus seluruh katalog lama dan ganti dengan data import baru ini.</div>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-5 border-t border-slate-850 flex items-center justify-end gap-3 bg-slate-900/40">
              <button
                type="button"
                onClick={() => setIsImportModalOpen(false)}
                className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={parsedImportRows.filter(r => r.status !== 'INVALID').length === 0 || isProcessingImport}
                onClick={handleConfirmImport}
                className="px-5 py-2.5 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 text-xs font-bold text-white rounded-xl transition-all cursor-pointer shadow-lg shadow-indigo-500/10 flex items-center gap-2"
              >
                {isProcessingImport ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Memproses Import...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Konfirmasi Import ({parsedImportRows.filter(r => r.status !== 'INVALID').length} SKU)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POPUP MODAL KONFIRMASI / SUKSES IMPORT KATALOG (DI TENGAH LAYAR DENGAN TOMBOL OK) */}
      {catalogConfirmModal && catalogConfirmModal.isOpen && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-[9999] animate-fade-in">
          <div className="bg-[#11141B] rounded-2xl max-w-md w-full shadow-2xl border border-slate-700/80 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
            <div className={`px-6 py-5 border-b flex items-center gap-3 ${
              catalogConfirmModal.warningType === 'danger' 
                ? 'bg-rose-950/40 border-rose-900/50 text-rose-400' 
                : catalogConfirmModal.warningType === 'warning'
                ? 'bg-amber-950/40 border-amber-900/50 text-amber-400'
                : catalogConfirmModal.warningType === 'success'
                ? 'bg-emerald-950/40 border-emerald-900/50 text-emerald-400'
                : 'bg-indigo-950/40 border-indigo-900/50 text-indigo-400'
            }`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 border ${
                catalogConfirmModal.warningType === 'danger' 
                  ? 'bg-rose-500/20 border-rose-500/30 text-rose-400' 
                  : catalogConfirmModal.warningType === 'warning'
                  ? 'bg-amber-500/20 border-amber-500/30 text-amber-400'
                  : catalogConfirmModal.warningType === 'success'
                  ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
                  : 'bg-indigo-500/20 border-indigo-500/30 text-indigo-400'
              }`}>
                {catalogConfirmModal.warningType === 'success' ? (
                  <CheckCircle className="w-6 h-6" />
                ) : catalogConfirmModal.warningType === 'danger' || catalogConfirmModal.warningType === 'warning' ? (
                  <AlertTriangle className="w-6 h-6 animate-pulse" />
                ) : (
                  <Info className="w-6 h-6" />
                )}
              </div>
              <div>
                <h3 className="font-extrabold text-white text-base leading-snug">{catalogConfirmModal.title}</h3>
                <p className="text-[11px] opacity-80">Sistem Impor Katalog WMS</p>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-[#161B25] rounded-xl p-4 border border-slate-800 text-xs text-slate-200 leading-relaxed whitespace-pre-line font-medium">
                {catalogConfirmModal.message}
              </div>
            </div>

            <div className="px-6 py-4 bg-[#0A0C10] border-t border-slate-800/80 flex items-center justify-end gap-3">
              {catalogConfirmModal.showCancel && (
                <button
                  type="button"
                  onClick={() => setCatalogConfirmModal(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Batal
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (catalogConfirmModal.onConfirm) {
                    catalogConfirmModal.onConfirm();
                  } else {
                    setCatalogConfirmModal(null);
                  }
                }}
                className={`px-6 py-2.5 font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer flex items-center justify-center gap-2 ${
                  catalogConfirmModal.warningType === 'danger'
                    ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30'
                    : catalogConfirmModal.warningType === 'warning'
                    ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/30'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30'
                }`}
              >
                {catalogConfirmModal.confirmText || 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
