import {inventoryFocusOptions,matchesInventoryFocus} from '../utils/dashboardView';
import InventoryStockTable from './InventoryStockTable';
import {getInventorySkuTotals,groupStockBySku,inventoryDateLabel,inventoryStatus,inventoryMovementLabel} from '../utils/inventoryView';
import StockPurge from './StockPurge';
import ModalFrame from './ModalFrame';
import {getActiveBranch} from '../supabase';
import {getStockStatus,isStockPickable} from '../utils/calculations';
import React, { useState, useMemo } from 'react';
import { StockItem, DccLog, OutboundItem, Warehouse } from '../types';
import { 
  calculatePackQuantities, 
  calculateTotalFromPacks, 
  getExpiredStatus, 
  isNearExpiryStatus, 
  getStatusBadgeClass, 
  formatNumber, 
  getProductCategory, 
  getProductPackSizes, 
  normalizeDateToDmy, 
  getCanonicalStockId,
  getLockedStockSummary,
  getItemStockBreakdown
} from '../utils/calculations';
import * as XLSX from 'xlsx';
import BarcodeScannerModal from './BarcodeScannerModal';
import { 
  Search, 
  Plus, 
  SlidersHorizontal, 
  MapPin, 
  Calendar, 
  X, 
  Edit3, 
  Trash2, 
  RefreshCw, 
  Info,
  Layers,
  Archive,
  Download,
  CheckCircle,
  FileSpreadsheet,
  Barcode,
  Printer,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Lock,
  Eye,
  Building2
} from 'lucide-react';
import { getBarcodeForSku } from '../data/barcodeMap';
import QRCode from 'qrcode';
import ThermalLabelPrinter, { LabelItemData } from './ThermalLabelPrinter';

// Component for generating on-the-fly QR Code image
function QRCodeImage({ text }: { text: string }) {
  const [qrUrl, setQrUrl] = useState<string>('');

  React.useEffect(() => {
    let active = true;
    QRCode.toDataURL(text, { margin: 1, width: 200, errorCorrectionLevel: 'M' }, (err, url) => {
      if (!err && active) {
        setQrUrl(url);
      }
    });
    return () => {
      active = false;
    };
  }, [text]);

  if (!qrUrl) return <div className="w-16 h-16 md:w-20 md:h-20 bg-slate-200 animate-pulse rounded" />;
  return (
    <img 
      src={qrUrl} 
      alt="QR Code" 
      className="w-16 h-16 md:w-20 md:h-20 object-contain print:w-20 print:h-20" 
      referrerPolicy="no-referrer" 
    />
  );
}


interface InventoryListProps {
  stock: StockItem[];
  onUpdateStock: (updated: StockItem[]) => void | Promise<boolean>;
  onEditStockItem?: (newItem: StockItem, oldItem: StockItem) => Promise<boolean> | boolean;
  onAddStockItem: (newItem: Omit<StockItem, 'id' | 'totalQtySku'>) => Promise<boolean>;
  onDeleteStockItem: (id: string) => void;
  userRole?: string;
  currentUser?: { username: string; role: string; fullName: string } | null;
  logs?: DccLog[];
  orderHistory?: OutboundItem[];
  warehouses?: Warehouse[];
  initialStockFocus?: string;
  activeWarehouseFilter?: string;
  onSelectWarehouseFilter?: (whId: string) => void;
}

export default function InventoryList({ 
  stock, 
  onUpdateStock, 
  onEditStockItem,
  onAddStockItem, 
  onDeleteStockItem,
  userRole,
  currentUser,
  logs = [],
  orderHistory = [],
  warehouses = [],
  initialStockFocus = 'ALL',
  activeWarehouseFilter = 'ALL',
  onSelectWarehouseFilter
}: InventoryListProps) {
  const isSuperAdmin = currentUser?.role === 'Administrator';
  const isAdmin = isSuperAdmin || currentUser?.role === 'Administrator' || currentUser?.role === 'Admin';
  const isViewer = userRole === 'Viewer' || currentUser?.role === 'Viewer';

  // Stock Locking summary from pending un-deducted orders
  const lockedStockSummary = useMemo(() => getLockedStockSummary(orderHistory), [orderHistory]);

  // Filters state
  const [searchTerm, setSearchTerm] = useState('');
  const [isScanModalOpen, setIsScanModalOpen] = useState(false);
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>(activeWarehouseFilter || 'ALL');
  const [selectedLocation, setSelectedLocation] = useState('ALL');
  const [selectedStatus, setSelectedStatus] = useState(initialStockFocus);
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [hideEmptyStock, setHideEmptyStock] = useState(true);
  const [onlyLowStock, setOnlyLowStock] = useState(false);

  React.useEffect(() => {
    if (initialStockFocus) {
      setSelectedStatus(initialStockFocus);
    }
  }, [initialStockFocus]);

  // Sync selected warehouse when activeWarehouseFilter prop updates
  React.useEffect(() => {
    if (activeWarehouseFilter) {
      setSelectedWarehouse(activeWarehouseFilter);
    }
  }, [activeWarehouseFilter]);

  const handleWarehouseFilterChange = (whId: string) => {
    setSelectedWarehouse(whId);
    if (onSelectWarehouseFilter) {
      onSelectWarehouseFilter(whId);
    }
  };
  
  // Modal states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<StockItem | null>(null);
  const [isDeleteAllModalOpen, setIsDeleteAllModalOpen] = useState(false);
  const [stockWriteBusy,setStockWriteBusy]=useState(false);
  const stockWriteLock=React.useRef(false);
  const [activePrintItem, setActivePrintItem] = useState<StockItem | null>(null);
  const [isThermalPrinterOpen, setIsThermalPrinterOpen] = useState(false);
  const [thermalInitialItems, setThermalInitialItems] = useState<LabelItemData[]>([]);
  const [isInIframe, setIsInIframe] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  React.useEffect(() => {
    try {
      setIsInIframe(window.self !== window.top);
    } catch (e) {
      setIsInIframe(true);
    }
  }, []);

  // SKU History Modal states
  const [selectedHistorySkuId, setSelectedHistorySkuId] = useState<string | null>(null);
  const [selectedHistorySkuName, setSelectedHistorySkuName] = useState<string>('');
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [activeHistoryTab, setActiveHistoryTab] = useState<'all' | 'transfer' | 'order' | 'inbound_adjust'>('all');

  // Import states
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'overwrite' | 'replace'>('merge');
  const [dragActive, setDragActive] = useState(false);
  const [importConfirmModal, setImportConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    warningType?: 'danger' | 'warning' | 'info' | 'success';
    confirmText?: string;
    showCancel?: boolean;
    onConfirm?: () => void;
  } | null>(null);

  // Live parsed import rows
  const parsedImportRows = useMemo(() => {
    if (!importText.trim()) return [];
    
    const lines = importText.split('\n');
    const result: {
      skuId: string;
      skuName: string;
      expiredDate: string;
      location: string;
      qty: number;
      qtyCtnSize: number;
      qtyInnerSize: number;
      isValid: boolean;
      error?: string;
    }[] = [];

    // Helper to parse numbers safely (e.g. "1.500", "1,500", "250")
    const parseQtyVal = (val: string | number | undefined): number => {
      if (typeof val === 'number') return Math.max(0, Math.floor(val));
      if (!val) return 0;
      let str = String(val).trim();
      str = str.replace(/[^0-9.,-]/g, '');
      if (!str) return 0;
      
      if (/^\d{1,3}(\.\d{3})+$/.test(str)) {
        str = str.replace(/\./g, '');
      } else if (/^\d{1,3}(,\d{3})+$/.test(str)) {
        str = str.replace(/,/g, '');
      } else if (str.includes(',') && !str.includes('.')) {
        str = str.replace(',', '.');
      }
      
      const num = Math.floor(parseFloat(str));
      return isNaN(num) ? 0 : Math.max(0, num);
    };

    // Helper to parse date string or excel serial date
    const parseDateVal = (val: string | number | undefined): string => {
      if (!val) return '-';
      let str = String(val).trim();
      if (str === '' || str === '0' || str === '-') return '-';

      if (str.toLowerCase() === 'damage/expired' || str.toLowerCase().includes('damage')) {
        return 'Damage/expired';
      }

      const normalized = normalizeDateToDmy(str);
      return normalized || '-';
    };

    // Smart Header Finder across the top 25 lines
    let headerLineIdx = -1;
    let headerIdxs = {
      skuId: 0,
      skuName: 1,
      expiredDate: 2,
      location: 3,
      qty: 4,
      qtyCtnSize: 5,
      qtyInnerSize: 6
    };
    let hasHeader = false;

    const maxScanLines = Math.min(25, lines.length);
    for (let i = 0; i < maxScanLines; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      
      let parts = l.split('\t');
      if (parts.length < 2) {
        parts = l.split(/[,;]+/);
      }
      const partsLower = parts.map(p => p.trim().toLowerCase());

      const hasSkuCol = partsLower.some(p => ['sku id', 'sku', 'kode sku', 'kode barang', 'kode produk', 'kode', 'item code', 'product code', 'id'].some(s => p === s || p.includes(s)));
      const hasQtyCol = partsLower.some(p => ['qty', 'quantity', 'jumlah', 'kuantitas', 'pcs', 'stok', 'stock', 'saldo', 'sisa', 'fisik'].some(s => p === s || p.includes(s)));
      const hasLocCol = partsLower.some(p => ['location', 'lokasi', 'rak', 'rack', 'shelf', 'posisi', 'gudang', 'bin', 'zona', 'zone'].some(s => p === s || p.includes(s)));
      const hasNameCol = partsLower.some(p => ['sku name', 'nama sku', 'nama barang', 'nama produk', 'nama', 'item name', 'product name', 'produk', 'deskripsi'].some(s => p === s || p.includes(s)));

      if ((hasSkuCol && hasQtyCol) || (hasSkuCol && hasNameCol) || (hasQtyCol && hasLocCol) || (hasSkuCol && hasLocCol)) {
        headerLineIdx = i;
        hasHeader = true;

        const findIdx = (keywords: string[]) => {
          return partsLower.findIndex(p => keywords.some(k => p === k || p.includes(k)));
        };

        const foundSku = findIdx(['sku id', 'sku', 'kode sku', 'kode barang', 'kode produk', 'kode', 'item code', 'id']);
        const foundName = findIdx(['sku name', 'nama sku', 'nama barang', 'nama produk', 'nama', 'item name', 'product name', 'produk', 'deskripsi']);
        const foundExp = findIdx(['expired date', 'expired', 'tanggal expired', 'ed', 'exp', 'kadaluarsa', 'tanggal kadaluarsa', 'tgl expired', 'exp date']);
        const foundLoc = findIdx(['location', 'lokasi', 'rak', 'rack', 'shelf', 'posisi', 'gudang', 'bin', 'zona', 'zone']);
        const foundQty = findIdx(['qty', 'quantity', 'jumlah', 'kuantitas', 'pcs', 'stok', 'stock', 'saldo', 'sisa', 'fisik']);
        const foundCtn = findIdx(['qty/ctn', 'ctn size', 'karton', 'isi karton', 'dus', 'per karton', 'qty ctn size', 'qty ctn']);
        const foundInner = findIdx(['qty inner', 'inner size', 'inner', 'isi inner', 'per inner', 'inner pcs', 'qty/inner', 'qty inner size']);

        headerIdxs = {
          skuId: foundSku !== -1 ? foundSku : 0,
          skuName: foundName !== -1 ? foundName : (parts.length > 1 ? 1 : -1),
          expiredDate: foundExp !== -1 ? foundExp : -1,
          location: foundLoc !== -1 ? foundLoc : -1,
          qty: foundQty !== -1 ? foundQty : (parts.length > 4 ? 4 : parts.length - 1),
          qtyCtnSize: foundCtn !== -1 ? foundCtn : -1,
          qtyInnerSize: foundInner !== -1 ? foundInner : -1,
        };
        break;
      }
    }

    lines.forEach((line, lineIdx) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Skip title rows or header row
      if (hasHeader && lineIdx <= headerLineIdx) {
        return;
      }

      let parts = trimmed.split('\t');
      if (parts.length < 2) {
        parts = trimmed.split(/[,;]+/);
      }

      // Skip lines that look like a header or total summary line
      const firstPartLower = parts[0]?.trim().toLowerCase() || '';
      if (
        firstPartLower.includes('sku id') ||
        firstPartLower.includes('kode sku') ||
        firstPartLower.includes('laporan') ||
        firstPartLower.includes('total') ||
        firstPartLower === 'no' ||
        firstPartLower === 'number'
      ) {
        return;
      }

      const getColStr = (colIdx: number) => (colIdx >= 0 && parts[colIdx] !== undefined) ? parts[colIdx].trim() : '';

      let rawSkuId = getColStr(headerIdxs.skuId);
      let rawSkuName = getColStr(headerIdxs.skuName);
      let rawExpiredDate = getColStr(headerIdxs.expiredDate) || '-';
      let rawLocation = getColStr(headerIdxs.location)?.toUpperCase() || '';
      let rawQtyStr = getColStr(headerIdxs.qty);

      // Smart fallback if no header was detected (e.g. simple 2, 3, or 4 column paste)
      if (!hasHeader) {
        if (parts.length === 2) {
          rawSkuId = parts[0]?.trim() || '';
          rawQtyStr = parts[1]?.trim() || '0';
        } else if (parts.length === 3) {
          rawSkuId = parts[0]?.trim() || '';
          rawLocation = parts[1]?.trim().toUpperCase() || '';
          rawQtyStr = parts[2]?.trim() || '0';
        } else if (parts.length === 4) {
          rawSkuId = parts[0]?.trim() || '';
          rawSkuName = parts[1]?.trim() || '';
          rawLocation = parts[2]?.trim().toUpperCase() || '';
          rawQtyStr = parts[3]?.trim() || '0';
        } else if (parts.length >= 5) {
          rawSkuId = parts[0]?.trim() || '';
          rawSkuName = parts[1]?.trim() || '';
          rawExpiredDate = parts[2]?.trim() || '-';
          rawLocation = parts[3]?.trim().toUpperCase() || '';
          rawQtyStr = parts[4]?.trim() || '0';
        }
      }

      // Clean SKU ID (strip leading # or apostrophes)
      rawSkuId = rawSkuId.replace(/^['#]/, '').trim();

      const qty = parseQtyVal(rawQtyStr);
      const expiredDate = parseDateVal(rawExpiredDate);
      const spec = getProductPackSizes(rawSkuId);

      const rawCtnSize = getColStr(headerIdxs.qtyCtnSize);
      const rawInnerSize = getColStr(headerIdxs.qtyInnerSize);

      const qtyCtnSize = parseQtyVal(rawCtnSize) || spec.qtyCtnSize;
      const qtyInnerSize = parseQtyVal(rawInnerSize) || spec.qtyInnerSize;

      const isValid = !!rawSkuId && !isNaN(qty) && qty >= 0;
      let error = '';
      if (!rawSkuId) error += 'Kode SKU kosong. ';

      result.push({
        skuId: rawSkuId,
        skuName: rawSkuName || `${rawSkuId} Product`,
        expiredDate: (expiredDate && expiredDate !== '-') ? expiredDate : 'No Expired',
        location: rawLocation || 'STAGE-01',
        qty: isNaN(qty) ? 0 : qty,
        qtyCtnSize,
        qtyInnerSize,
        isValid,
        error: error || undefined
      });
    });

    return result;
  }, [importText]);

  // Load a small generic import example
  const handleLoadSampleTemplate = () => {
    const template = `SKU ID\tSKU Name\tExpired Date\tLocation\tQty\tQty/Ctn Size\tQty/Inner Size
SKU-001\tProduk Contoh 1\t31/12/2027\tRAK-A01\t240\t24\t1
SKU-002\tProduk Contoh 2\t30/06/2028\tRAK-A02\t120\t12\t1`;
    setImportText(template);
  };

  // Turn current warehouse stock back into Excel edit layout dynamically
  const handleLoadInitialStockToImport = () => {
    const headers = "SKU ID\tSKU Name\tExpired Date\tLocation\tQty\tQty/Ctn Size\tQty/Inner Size\n";
    const rows = stock.map(item => 
      `${item.skuId}\t${item.skuName}\t${item.expiredDate}\t${item.location}\t${item.qty}\t${item.qtyCtnSize}\t${item.qtyInnerSize}`
    ).join('\n');
    setImportText(headers + rows);
  };

  // Drag and drop CSV / Excel handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
    if (e.target) e.target.value = '';
  };

  const handleFile = (file: File) => {
    const fileName = file.name.toLowerCase();
    const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv');
    
    if (isExcel) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = e.target?.result;
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          
          const rawRows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '' });
          
          if (!rawRows || rawRows.length === 0) {
            alert('File Excel/CSV kosong atau tidak dapat dibaca.');
            return;
          }

          // Convert rows to TSV format for uniform parsing
          const tsvText = rawRows.map(row => 
            row.map(cell => {
              if (cell === null || cell === undefined) return '';
              if (cell instanceof Date) {
                const d = String(cell.getDate()).padStart(2, '0');
                const m = String(cell.getMonth() + 1).padStart(2, '0');
                const y = cell.getFullYear();
                return `${d}/${m}/${y}`;
              }
              return String(cell).replace(/\r?\n|\r/g, ' ').trim();
            }).join('\t')
          ).join('\n');

          setImportText(tsvText);
        } catch (err) {
          console.error('Error reading excel file:', err);
          const textReader = new FileReader();
          textReader.onload = (evt) => {
            if (evt.target?.result) {
              setImportText(evt.target.result as string);
            }
          };
          textReader.readAsText(file);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // Plain text or TSV
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        if (text) {
          setImportText(text);
        }
      };
      reader.readAsText(file);
    }
  };

  const executeImport = async (validRows: typeof parsedImportRows) => {
    if(!isAdmin||stockWriteLock.current)return;
    const total=validRows.reduce((sum,row)=>sum+row.qty,0);
    if(!window.confirm('Cabang '+getActiveBranch()+' · '+validRows.length+' baris lokasi · '+new Set(validRows.map(r=>r.skuId)).size+' SKU unik · '+total.toLocaleString('id-ID')+' pcs. Mode '+importMode+'. Lanjutkan impor?'))return;
    if(importMode==='replace'&&window.prompt('Ketik GANTI '+getActiveBranch()+' untuk mengganti seluruh stok cabang aktif.')!=='GANTI '+getActiveBranch())return;
    stockWriteLock.current=true;setStockWriteBusy(true);
    try {
    let nextStockState: StockItem[] = [];
    const targetWarehouseId = selectedWarehouse && selectedWarehouse !== 'ALL' ? selectedWarehouse : 'WH-CENTRAL';
    const targetWarehouseName = warehouses.find(w => w.id === targetWarehouseId)?.name;

    if (importMode === 'replace') {
      // Overwrite entirely
      nextStockState = validRows.map(item => {
        const splits = calculatePackQuantities(item.qty, item.qtyCtnSize, item.qtyInnerSize);
        const status = getExpiredStatus(item.expiredDate);
        return {
          id: getCanonicalStockId(item.skuId, item.expiredDate, item.location, targetWarehouseId),
          skuId: item.skuId,
          skuName: item.skuName,
          expiredDate: normalizeDateToDmy(item.expiredDate),
          location: item.location,
          qty: item.qty,
          qtyCtnSize: item.qtyCtnSize,
          qtyCtn: splits.qtyCtn,
          qtyInnerSize: item.qtyInnerSize,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose,
          status,
          totalQtySku: 0, // Recalculated below
          warehouseId: targetWarehouseId,
          ...(targetWarehouseName ? { warehouseName: targetWarehouseName } : {})
        };
      });
    } else {
      // Merge or overwrite matches
      const currentStockClone: StockItem[] = JSON.parse(JSON.stringify(stock));

      validRows.forEach(item => {
        const targetId = getCanonicalStockId(item.skuId, item.expiredDate, item.location, targetWarehouseId);
        const existingIdx = currentStockClone.findIndex(s => s.id === targetId);

        if (existingIdx > -1) {
          if (importMode === 'merge') {
            currentStockClone[existingIdx].qty += item.qty;
          } else {
            currentStockClone[existingIdx].qty = item.qty;
            currentStockClone[existingIdx].qtyCtnSize = item.qtyCtnSize;
            currentStockClone[existingIdx].qtyInnerSize = item.qtyInnerSize;
          }
          // Recalculate pack counts & status
          const splits = calculatePackQuantities(
            currentStockClone[existingIdx].qty, 
            currentStockClone[existingIdx].qtyCtnSize, 
            currentStockClone[existingIdx].qtyInnerSize
          );
          currentStockClone[existingIdx].qtyCtn = splits.qtyCtn;
          currentStockClone[existingIdx].qtyInner = splits.qtyInner;
          currentStockClone[existingIdx].qtyLoose = splits.qtyLoose;
          currentStockClone[existingIdx].status = getStockStatus(currentStockClone[existingIdx]);
        } else {
          // Add brand new item row
          const splits = calculatePackQuantities(item.qty, item.qtyCtnSize, item.qtyInnerSize);
          const status = getExpiredStatus(item.expiredDate);
          currentStockClone.push({
            id: targetId,
            skuId: item.skuId,
            skuName: item.skuName,
            expiredDate: item.expiredDate,
            location: item.location,
            qty: item.qty,
            qtyCtnSize: item.qtyCtnSize,
            qtyCtn: splits.qtyCtn,
            qtyInnerSize: item.qtyInnerSize,
            qtyInner: splits.qtyInner,
            qtyLoose: splits.qtyLoose,
            status,
            totalQtySku: 0,
            warehouseId: targetWarehouseId,
            ...(targetWarehouseName ? { warehouseName: targetWarehouseName } : {})
          });
        }
      });

      nextStockState = currentStockClone;
    }

    // Recalculate overall SKU level totals for consistency
    const skuTotals: Record<string, number> = {};
    nextStockState.forEach(item => {
      skuTotals[item.skuId] = (skuTotals[item.skuId] || 0) + item.qty;
    });

    const finalStockState = nextStockState.map(item => ({
      ...item,
      totalQtySku: skuTotals[item.skuId] || item.qty
    }));

    if(await onUpdateStock(finalStockState)===false)throw Error('Stok belum tersimpan. Muat ulang data dan periksa pesan kesalahan.');
    setIsImportModalOpen(false);
    setImportText('');

    // Show custom popup modal in the center of the screen with OK button
    setImportConfirmModal({
      isOpen: true,
      title: 'Import Data Stok Berhasil!',
      message: `✓ Sukses! Berhasil memproses dan mengimpor ${validRows.length} baris data stok secara real-time ke dalam sistem gudang.`,
      warningType: 'success',
      confirmText: 'OK, SELESAI',
      showCancel: false,
      onConfirm: () => setImportConfirmModal(null)
    });
    }catch(error:any){alert(error.message||'Impor gagal.');}finally{stockWriteLock.current=false;setStockWriteBusy(false);}
  };

  const handleProcessImport = () => {
    const validRows = parsedImportRows.filter(r => r.isValid);
    if (validRows.length === 0) {
      setImportConfirmModal({
        isOpen: true,
        title: 'Data Tidak Valid',
        message: 'Tidak ada baris data valid yang terdeteksi untuk diimpor. Mohon periksa kembali file Excel atau teks input Anda.',
        warningType: 'info',
        confirmText: 'OK, Periksa Kembali',
        showCancel: false,
        onConfirm: () => setImportConfirmModal(null)
      });
      return;
    }

    const nearEdCount = validRows.filter(item => {
      const status = getExpiredStatus(item.expiredDate);
      return status === 'Under 6 Month' || status === 'Under 3 Month' || status === 'Near ED';
    }).length;
    const underExpiryCount = validRows.filter(item => {
      const status = getExpiredStatus(item.expiredDate);
      return isNearExpiryStatus(status);
    }).length;

    if (importMode === 'replace') {
      setImportConfirmModal({
        isOpen: true,
        title: 'Konfirmasi Gantikan Seluruh Data',
        message: `PERINGATAN SANGAT PENTING:\nAnda memilih mode 'Gantikan Seluruh Data'.\nMode ini akan MENGHAPUS SEMUA ${stock.length} BARIS STOK LAMA di gudang dan menggantinya HANYA dengan ${validRows.length} baris data import baru ini!\n\nApakah Anda YAKIN ingin melanjutkan?`,
        warningType: 'danger',
        confirmText: 'OK, YA GANTIKAN & IMPORT',
        showCancel: true,
        onConfirm: () => {
          setImportConfirmModal(null);
          executeImport(validRows);
        }
      });
      return;
    }

    if (underExpiryCount > 0) {
      setImportConfirmModal({
        isOpen: true,
        title: 'Peringatan Expired Date (< 24 Bulan)',
        message: `PERINGATAN:\nTerdapat ${underExpiryCount} baris data SKU dengan Expired Date di bawah 24 bulan (termasuk ${nearEdCount} SKU Near ED / Under 6M / Under 3M)!\n\nApakah Anda yakin ingin melanjutkan proses import data stok ini?`,
        warningType: 'warning',
        confirmText: 'OK, YA TETAP IMPORT',
        showCancel: true,
        onConfirm: () => {
          setImportConfirmModal(null);
          executeImport(validRows);
        }
      });
      return;
    }

    executeImport(validRows);
  };

  // Form states (Add/Edit)
  const [formSkuId, setFormSkuId] = useState('');
  const [formSkuName, setFormSkuName] = useState('');
  const [formExpiredDate, setFormExpiredDate] = useState('');
  const [formLocation, setFormLocation] = useState('');
  const [formWarehouseId, setFormWarehouseId] = useState<string>('WH-CENTRAL');
  const [formCtnSize, setFormCtnSize] = useState(720);
  const [formInnerSize, setFormInnerSize] = useState(12);
  const [isManualLocation, setIsManualLocation] = useState(false);
  
  // Toggle between input modes (Total Qty vs Packing Splits)
  const [inputMode, setInputMode] = useState<'total' | 'split'>('total');
  const [formTotalQty, setFormTotalQty] = useState<number>(0);
  const [formQtyCtn, setFormQtyCtn] = useState<number>(0);
  const [formQtyInner, setFormQtyInner] = useState<number>(0);
  const [formQtyLoose, setFormQtyLoose] = useState<number>(0);

  // Unique lists for filtering dropdowns
  const locationsList = useMemo(() => {
    return Array.from(new Set(stock.map(item => item.location))).sort();
  }, [stock]);

  const statusesList = ['AMAN', 'Under 18 Month', 'Under 6 Month', 'Under 3 Month', 'Under 24Month', 'Damage', 'Expired', 'Karantina'];

  const categoriesList = [
    'FAST MOVING',
    'SLOW MOVING',
    'MEDIUM',
    'BELUM ADA OUTBOUND',

  ];

  // Handle SKU ID autofill helper
  const existingSkusMap = useMemo(() => {
    const map: Record<string, { name: string; ctn: number; inner: number }> = {};
    stock.forEach(item => {
      map[item.skuId] = { 
        name: item.skuName, 
        ctn: item.qtyCtnSize, 
        inner: item.qtyInnerSize 
      };
    });
    return map;
  }, [stock]);

  const handleSkuIdChange = (val: string) => {
    setFormSkuId(val);
    const matched = existingSkusMap[val];
    if (matched) {
      setFormSkuName(matched.name);
      setFormCtnSize(matched.ctn);
      setFormInnerSize(matched.inner);
    } else {
      const spec = getProductPackSizes(val);
      if (val) {
        setFormCtnSize(spec.qtyCtnSize);
        setFormInnerSize(spec.qtyInnerSize);
      }
    }
  };

  // Automated calculation inside the form
  const handleFormTotalQtyChange = (qty: number) => {
    setFormTotalQty(qty);
    const splits = calculatePackQuantities(qty, formCtnSize, formInnerSize);
    setFormQtyCtn(splits.qtyCtn);
    setFormQtyInner(splits.qtyInner);
    setFormQtyLoose(splits.qtyLoose);
  };

  const handleSplitChange = (ctn: number, inner: number, loose: number) => {
    setFormQtyCtn(ctn);
    setFormQtyInner(inner);
    setFormQtyLoose(loose);
    const total = calculateTotalFromPacks(ctn, inner, loose, formCtnSize, formInnerSize);
    setFormTotalQty(total);
  };

  const handleOpenAddModal = () => {
    if (!isAdmin) return;
    setFormSkuId('');
    setFormSkuName('');
    setFormExpiredDate('');
    setFormLocation('');
    setFormWarehouseId(selectedWarehouse !== 'ALL' ? selectedWarehouse : 'WH-CENTRAL');
    setFormCtnSize(720);
    setFormInnerSize(12);
    setFormTotalQty(0);
    setFormQtyCtn(0);
    setFormQtyInner(0);
    setFormQtyLoose(0);
    setInputMode('total');
    setIsManualLocation(false);
    setIsAddModalOpen(true);
  };

  const handleOpenEditModal = (item: StockItem) => {
    if (!isAdmin) return;
    setEditingItem(item);
    setFormSkuId(item.skuId);
    setFormSkuName(item.skuName);
    setFormWarehouseId(item.warehouseId || 'WH-CENTRAL');
    
    // Maintain standard DD/MM/YYYY format
    const initialDate = item.expiredDate ? normalizeDateToDmy(item.expiredDate) : '';
    setFormExpiredDate(initialDate !== '-' && initialDate !== 'No Expired' ? initialDate : (item.expiredDate || ''));
    
    setFormLocation(item.location);
    setFormCtnSize(item.qtyCtnSize);
    setFormInnerSize(item.qtyInnerSize);
    setFormTotalQty(item.qty);
    setFormQtyCtn(item.qtyCtn);
    setFormQtyInner(item.qtyInner);
    setFormQtyLoose(item.qtyLoose);
    setInputMode('total');
    if (locationsList.includes(item.location)) {
      setIsManualLocation(false);
    } else {
      setIsManualLocation(true);
    }
    setIsEditModalOpen(true);
  };

  const editingItemActiveOrders = useMemo(() => {
    if (!editingItem) {
      return {
        hasActiveOrders: false,
        refs: [] as string[],
        lockedUnpickedQty: 0,
        pickedPendingQty: 0
      };
    }
    const targetKey = getCanonicalStockId(
      editingItem.skuId,
      editingItem.expiredDate,
      editingItem.location,
      editingItem.warehouseId || 'WH-CENTRAL'
    );
    const matched = (orderHistory || []).filter(
      o =>
        o.status === 'Pending' &&
        o.qty > 0 &&
        getCanonicalStockId(o.skuId, o.expiredDate, o.location, o.warehouseId || 'WH-CENTRAL') === targetKey
    );
    const refs = Array.from(new Set(matched.map(o => o.referenceNumber).filter(Boolean)));
    const lockedUnpickedQty = matched.filter(o => o.stockDeducted !== true).reduce((sum, o) => sum + o.qty, 0);
    const pickedPendingQty = matched.filter(o => o.stockDeducted === true).reduce((sum, o) => sum + o.qty, 0);
    return {
      hasActiveOrders: matched.length > 0,
      refs,
      lockedUnpickedQty,
      pickedPendingQty
    };
  }, [editingItem, orderHistory]);

  const handlePrintCard = (item: StockItem) => {
    setActivePrintItem(item);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSkuId || !formSkuName || !formLocation) {
      alert('Mohon lengkapi SKU ID, SKU Name, dan Lokasi.');
      return;
    }

    const calculatedQty = inputMode === 'total' 
      ? formTotalQty 
      : calculateTotalFromPacks(formQtyCtn, formQtyInner, formQtyLoose, formCtnSize, formInnerSize);

    if (!Number.isSafeInteger(calculatedQty) || calculatedQty <= 0) { alert('Jumlah stok harus berupa bilangan bulat positif.'); return; }
    const calculatedSplits = calculatePackQuantities(calculatedQty, formCtnSize, formInnerSize);
    const normalizedEd = normalizeDateToDmy(formExpiredDate) || 'No Expired';
    const calculatedStatus = getExpiredStatus(normalizedEd);

    if (isNearExpiryStatus(calculatedStatus)) {
      const confirmSave = confirm(`PERINGATAN:\nExpired Date yang dimasukkan (${normalizedEd}) masuk dalam kategori ${calculatedStatus}!\nApakah Anda yakin ingin melanjutkan penyimpanan?`);
      if (!confirmSave) return;
    }

    const whObj = warehouses.find(w => w.id === formWarehouseId);
    if (stockWriteLock.current) return;
    stockWriteLock.current = true; setStockWriteBusy(true);
    try {
    const saved = await onAddStockItem({
      skuId: formSkuId,
      skuName: formSkuName,
      expiredDate: normalizedEd,
      location: formLocation,
      qty: calculatedQty,
      qtyCtnSize: formCtnSize,
      qtyCtn: calculatedSplits.qtyCtn,
      qtyInnerSize: formInnerSize,
      qtyInner: calculatedSplits.qtyInner,
      qtyLoose: calculatedSplits.qtyLoose,
      status: calculatedStatus,
      warehouseId: formWarehouseId,
      warehouseName: whObj?.name || (formWarehouseId === 'WH-CENTRAL' ? 'Gudang Pusat' : formWarehouseId)
    });

    if (saved) setIsAddModalOpen(false);
    } catch (error: any) { alert(error.message || 'Stok gagal disimpan. Form tetap tersedia.'); }
    finally { stockWriteLock.current = false; setStockWriteBusy(false); }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;

    const calculatedQty = inputMode === 'total' 
      ? formTotalQty 
      : calculateTotalFromPacks(formQtyCtn, formQtyInner, formQtyLoose, formCtnSize, formInnerSize);

    const calculatedSplits = calculatePackQuantities(calculatedQty, formCtnSize, formInnerSize);
    const normalizedEd = normalizeDateToDmy(formExpiredDate) || 'No Expired';
    const calculatedStatus = getExpiredStatus(normalizedEd);

    if (isNearExpiryStatus(calculatedStatus)) {
      const confirmSave = confirm(`PERINGATAN:\nExpired Date yang dimasukkan (${normalizedEd}) masuk dalam kategori ${calculatedStatus}!\nApakah Anda yakin ingin melanjutkan penyimpanan?`);
      if (!confirmSave) return;
    }

    const cleanSku = (formSkuId || '').trim().toUpperCase();
    let cleanLoc = (formLocation || '').trim().toUpperCase();
    if (cleanLoc === 'RAK KAYU') cleanLoc = 'RACK DISPLAY';

    const newCanonicalId = getCanonicalStockId(cleanSku, normalizedEd, cleanLoc, formWarehouseId);
    const oldWh = editingItem.warehouseId || 'WH-CENTRAL';
    const oldCanonicalId = getCanonicalStockId(editingItem.skuId, editingItem.expiredDate, editingItem.location, oldWh);
    if (editingItemActiveOrders.hasActiveOrders) {
      const refSummary = `${editingItemActiveOrders.refs.slice(0, 5).join(', ')}${editingItemActiveOrders.refs.length > 5 ? ', ...' : ''}`;
      if (newCanonicalId !== oldCanonicalId) {
        alert(
          `Tidak dapat mengubah Tanggal Kedaluwarsa, Lokasi, atau Gudang karena stok ini sedang terikat pada ${editingItemActiveOrders.refs.length} order berjalan (${refSummary}). Selesaikan atau batalkan order tersebut terlebih dahulu.`
        );
        return;
      }
      if (calculatedQty < editingItemActiveOrders.lockedUnpickedQty) {
        alert(
          `Jumlah stok fisik (${calculatedQty} pcs) tidak boleh dikurangi di bawah jumlah yang sedang dialokasikan ke order menunggu picking (${editingItemActiveOrders.lockedUnpickedQty} pcs pada order: ${refSummary}).`
        );
        return;
      }
    }
    const whObj = warehouses.find(w => w.id === formWarehouseId);

    const updatedItem: StockItem = {
      ...editingItem,
      id: newCanonicalId,
      skuId: cleanSku,
      skuName: formSkuName.trim(),
      expiredDate: normalizedEd,
      location: cleanLoc,
      qty: calculatedQty,
      qtyCtnSize: formCtnSize,
      qtyCtn: calculatedSplits.qtyCtn,
      qtyInnerSize: formInnerSize,
      qtyInner: calculatedSplits.qtyInner,
      qtyLoose: calculatedSplits.qtyLoose,
      status: calculatedStatus,
      warehouseId: formWarehouseId,
      warehouseName: whObj?.name || (formWarehouseId === 'WH-CENTRAL' ? 'Gudang Pusat' : formWarehouseId)
    };

    if (onEditStockItem) {
      if (!await onEditStockItem(updatedItem, editingItem)) return;
    } else {
      const oldWh = editingItem.warehouseId || 'WH-CENTRAL';
      const oldCanonicalId = getCanonicalStockId(editingItem.skuId, editingItem.expiredDate, editingItem.location, oldWh);
      let updatedStock = stock.filter(item => item.id !== editingItem.id && item.id !== oldCanonicalId);
      const existingIdx = updatedStock.findIndex(item => item.id === newCanonicalId);
      if (existingIdx > -1) {
        const existing = updatedStock[existingIdx];
        const newQty = existing.qty + calculatedQty;
        const splits = calculatePackQuantities(newQty, formCtnSize, formInnerSize);
        updatedStock[existingIdx] = {
          ...existing,
          id: newCanonicalId,
          qty: newQty,
          qtyCtn: splits.qtyCtn,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose,
          status: calculatedStatus,
          warehouseId: formWarehouseId,
          warehouseName: updatedItem.warehouseName
        };
      } else {
        updatedStock.unshift(updatedItem);
      }
      onUpdateStock(updatedStock);
    }

    setIsEditModalOpen(false);
    setEditingItem(null);
  };

  const handleDeleteAllStock = () => {
    setIsDeleteAllModalOpen(true);
  };

  const summaryStock = useMemo(() => stock.filter(item => selectedWarehouse === 'ALL' || (item.warehouseId || 'WH-CENTRAL').toUpperCase() === selectedWarehouse.toUpperCase()), [stock, selectedWarehouse]);

  // Filter Logic
  const filteredStock = useMemo(() => {
    return groupStockBySku(stock.filter(item => {
      const itemBarcode = getBarcodeForSku(item.skuId).toLowerCase();
      const matchSearch = 
        item.skuId.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.skuName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.location.toLowerCase().includes(searchTerm.toLowerCase()) ||
        itemBarcode.includes(searchTerm.toLowerCase());
      
      const itemWh = (item.warehouseId || 'WH-CENTRAL').toUpperCase();
      const matchWarehouse = selectedWarehouse === 'ALL' || itemWh === selectedWarehouse.toUpperCase();

      const matchLoc = selectedLocation === 'ALL' || item.location === selectedLocation;
      
      const matchStatus = matchesInventoryFocus(item, selectedStatus, lockedStockSummary);

      const itemCategory = getProductCategory(item.skuId, item.skuName);
      const matchCategory = selectedCategory === 'ALL' || itemCategory === selectedCategory;

      const matchEmptyStock = !hideEmptyStock || (Number(item.qty || 0) > 0);
      const matchLowStock = !onlyLowStock || (item.qty > 0 && item.qty <= 20);

      return matchSearch && matchWarehouse && matchLoc && matchStatus && matchCategory && matchEmptyStock && matchLowStock;
    })).flatMap(group => group.items);
  }, [stock, lockedStockSummary, searchTerm, selectedWarehouse, selectedLocation, selectedStatus, selectedCategory, hideEmptyStock, onlyLowStock]);

  // Pagination & Virtual Scroll state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25); // Start with a compact page, not the entire branch.

  // Reset page to 1 whenever filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, selectedWarehouse, selectedLocation, selectedStatus, selectedCategory, hideEmptyStock, onlyLowStock]);

  const totalFilteredRows = filteredStock.length;
  const isAllPages = pageSize <= 0;
  const totalPages = isAllPages ? 1 : Math.max(1, Math.ceil(totalFilteredRows / pageSize));
  const validCurrentPage = Math.min(currentPage, totalPages);

  const paginatedStock = useMemo(() => {
    if (isAllPages) {
      return filteredStock;
    }
    const startIndex = (validCurrentPage - 1) * pageSize;
    return filteredStock.slice(startIndex, startIndex + pageSize);
  }, [filteredStock, validCurrentPage, pageSize, isAllPages]);

  const startRowIndex = totalFilteredRows === 0 ? 0 : (isAllPages ? 1 : (validCurrentPage - 1) * pageSize + 1);
  const endRowIndex = isAllPages ? totalFilteredRows : Math.min(validCurrentPage * pageSize, totalFilteredRows);

  // Export to Excel helper
  const handleExportExcel = () => {
    if (filteredStock.length === 0) {
      alert('Tidak ada data stok untuk diekspor.');
      return;
    }

    try {
      const exportTotals = getInventorySkuTotals(summaryStock, lockedStockSummary);
      const exportData = filteredStock.map(item => {
        const breakdown = getItemStockBreakdown(item, lockedStockSummary);
        return {
          'SKU ID': item.skuId,
          'Nama Barang': item.skuName,
          'Kedaluwarsa': inventoryDateLabel(item),
          'Lokasi': item.location,
          'Dialokasikan (belum dipick)': breakdown.lockedQty,
          'Qty Lokasi (Fisik)': item.qty,
          'Tersedia untuk Picking': breakdown.availableQty,
          'Kelayakan Picking': isStockPickable(item)?'Layak':'Ditahan',
          'Total Fisik SKU (gudang dipilih)': exportTotals.get(item.skuId.trim().toUpperCase())?.physical || 0,
          'Kemasan (Karton / Inner / Eceran)': `${item.qtyCtn} Karton / ${item.qtyInner} Inner / ${item.qtyLoose} Eceran`,
          'Status': inventoryStatus(item).label
        };
      });

      const worksheet = XLSX.utils.json_to_sheet(exportData);
      
      const colWidths = [
        {wch:15},{wch:36},{wch:20},{wch:18},{wch:25},{wch:18},
        {wch:22},{wch:18},{wch:30},{wch:42},{wch:20}
      ];
      worksheet['!cols'] = colWidths;

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Stok Barang');
      
      const timestamp = new Date().toISOString().substring(0, 10);
      XLSX.writeFile(workbook, `Data_Stok_DCC_${timestamp}.xlsx`);
    } catch (error) {
      console.error(error);
      alert('Gagal mengekspor data stok ke Excel.');
    }
  };

  // Find current stock items for this SKU ID
  const skuStockItems = useMemo(() => {
    if (!selectedHistorySkuId) return [];
    return stock.filter(item => item.skuId === selectedHistorySkuId);
  }, [stock, selectedHistorySkuId]);

  // Total Stock for this SKU
  const totalSkuStockQty = useMemo(() => {
    return skuStockItems.reduce((acc, item) => acc + item.qty, 0);
  }, [skuStockItems]);

  // Filter logs for this SKU ID
  const skuLogs = useMemo(() => {
    if (!selectedHistorySkuId) return [];
    return logs.filter(log => log.skuId === selectedHistorySkuId);
  }, [logs, selectedHistorySkuId]);

  // Filter orderHistory for this SKU ID
  const skuOrders = useMemo(() => {
    if (!selectedHistorySkuId) return [];
    return orderHistory.filter(order => order.skuId === selectedHistorySkuId);
  }, [orderHistory, selectedHistorySkuId]);

  // Build a unified chronological feed
  const unifiedHistoryFeed = useMemo(() => {
    if (!selectedHistorySkuId) return [];
    
    interface UnifiedFeedItem {
      id: string;
      timestamp: string;
      source: 'LOG' | 'ORDER';
      typeLabel: string;
      type: string;
      qty: number;
      location: string;
      details: string;
      user: string;
      status?: string;
      refNo?: string;
    }

    const feed: UnifiedFeedItem[] = [];

    // Add logs
    skuLogs.forEach(log => {
      let typeLabel: string = log.type;
      if (log.type === 'TRANSFER') typeLabel = 'Transfer Antar Lokasi';
      else if (log.type === 'TRANSFER_IN') typeLabel = 'Transfer Masuk';
      else if (log.type === 'TRANSFER_OUT') typeLabel = 'Transfer Keluar';
      else if (log.type === 'INBOUND') typeLabel = 'Inbound Barang';
      else if (log.type === 'OUTBOUND') typeLabel = 'Outbound Barang';
      else if (log.type === 'ADJUSTMENT') typeLabel = 'Penyesuaian Fisik';

      let locationText = '';
      if (log.locationFrom && log.locationTo) {
        locationText = `${log.locationFrom} ➜ ${log.locationTo}`;
      } else if (log.locationFrom) {
        locationText = log.locationFrom;
      } else if (log.locationTo) {
        locationText = log.locationTo;
      }

      feed.push({
        id: log.id,
        timestamp: log.timestamp,
        source: 'LOG',
        typeLabel,
        type: log.type,
        qty: log.qty,
        location: locationText,
        details: log.description,
        user: log.user,
      });
    });

    // Add orders
    skuOrders.forEach(order => {
      feed.push({
        id: order.id,
        timestamp: order.timestamp,
        source: 'ORDER',
        typeLabel: 'Pesanan Outbound (Order)',
        type: 'ORDER',
        qty: order.qty,
        location: order.location,
        details: `Customer: ${order.customerName || 'N/A'} | Ref: ${order.referenceNumber || 'N/A'} ${order.orderNumber ? `| No. Order: ${order.orderNumber}` : ''} ${order.noPo ? `| PO: ${order.noPo}` : ''} ${order.notes ? `| Notes: ${order.notes}` : ''}`,
        user: order.scanned ? 'Selesai Scan Barcode' : 'Pending',
        status: order.status,
        refNo: order.referenceNumber
      });
    });

    // Sort by timestamp descending (newest first)
    return feed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [skuLogs, skuOrders, selectedHistorySkuId]);

  // Filter feed based on active history tab
  const filteredHistoryFeed = useMemo(() => {
    if (activeHistoryTab === 'all') {
      return unifiedHistoryFeed;
    }
    if (activeHistoryTab === 'transfer') {
      return unifiedHistoryFeed.filter(item => 
        item.type === 'TRANSFER' || 
        item.type === 'TRANSFER_IN' || 
        item.type === 'TRANSFER_OUT'
      );
    }
    if (activeHistoryTab === 'order') {
      return unifiedHistoryFeed.filter(item => item.source === 'ORDER' || item.type === 'OUTBOUND');
    }
    if (activeHistoryTab === 'inbound_adjust') {
      return unifiedHistoryFeed.filter(item => item.type === 'INBOUND' || item.type === 'ADJUSTMENT');
    }
    return unifiedHistoryFeed;
  }, [unifiedHistoryFeed, activeHistoryTab]);

  return (
    <div className="space-y-6">
      {/* Header Panel */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-white tracking-tight">Kelola Stok Barang</h2>
          <p className="text-xs text-slate-400 mt-1">
            {isViewer ? 'Pemantauan kuantitas dan rincian stok gudang (Mode Hanya Lihat).' : 'Lihat, edit, hapus, dan sesuaikan rincian stok gudang beserta kuantitas kemasannya.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {userRole === 'Administrator' && (
            <button
              onClick={() => setIsImportModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl text-xs border border-indigo-550/30 transition-all cursor-pointer shadow-sm shadow-indigo-600/10"
            >
              <FileSpreadsheet className="w-4 h-4 text-indigo-200" />
              Impor Massal (Excel/CSV)
            </button>
          )}
          <button
            onClick={() => {
              setThermalInitialItems([]);
              setIsThermalPrinterOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-emerald-600/30 to-teal-600/30 hover:from-emerald-600/40 hover:to-teal-600/40 text-emerald-300 font-bold rounded-xl text-xs border border-emerald-500/40 transition-all cursor-pointer shadow-sm"
          >
            <Printer className="w-4 h-4 text-emerald-400" />
            Cetak Label Barcode Thermal
          </button>
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#161B25] hover:bg-slate-800 text-slate-300 font-bold rounded-xl text-xs border border-slate-800 transition-all cursor-pointer shadow-sm"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
            Ekspor Excel (.xlsx)
          </button>
          {(userRole === 'Administrator' || userRole === 'Admin') && (
            <button
              onClick={handleOpenAddModal}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-md shadow-emerald-500/10 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Tambah Stok Baru
            </button>
          )}
          {userRole === 'Administrator' && (
            <details className="trueblue-stock-admin"><summary>Administrasi stok</summary>
              
              <button
                onClick={handleDeleteAllStock}
                className="flex items-center gap-2 px-4 py-2 bg-rose-900/30 hover:bg-rose-900/65 text-rose-200 hover:text-white font-semibold rounded-xl text-xs border border-rose-800/40 hover:border-rose-700/60 transition-all cursor-pointer shadow-sm shadow-rose-900/10"
              >
                <Trash2 className="w-4 h-4 text-rose-400" />
                Kosongkan stok cabang…
              </button>
            </details>
          )}
        </div>
      </div>

      {/* Viewer Mode Notice Banner */}
      {isViewer && (
        <div className="bg-cyan-500/10 border border-cyan-500/25 rounded-xl px-4 py-3 flex items-center gap-3 text-cyan-300 text-xs shadow-sm">
          <div className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-400 shrink-0">
            <Eye className="w-4 h-4" />
          </div>
          <div>
            <span className="font-bold">Mode Akses Viewer (Hanya Lihat):</span> Anda sedang memantau stok barang gudang. Fitur penambahan, pengeditan, impor, dan penghapusan stok dinonaktifkan sesuai hak akses.
          </div>
        </div>
      )}

      {/* Control Filters Panel */}
      <div className="bg-[#11141B] rounded-xl p-4 border border-slate-800/60 shadow-md space-y-3">
        {/* Quick Warehouse Selector Bar */}
        {warehouses && warehouses.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-2 border-b border-slate-800/60 -mx-1 px-1">
            <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-1 shrink-0 mr-1">
              <Building2 className="w-3.5 h-3.5 text-indigo-400" />
              Gudang:
            </span>
            <button
              type="button"
              onClick={() => handleWarehouseFilterChange('ALL')}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all shrink-0 cursor-pointer border ${
                selectedWarehouse === 'ALL'
                  ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm'
                  : 'bg-[#161B25] text-slate-400 hover:text-slate-200 border-slate-800 hover:bg-slate-800/50'
              }`}
            >
              Semua Gudang ({formatNumber(stock.reduce((a, b) => a + b.qty, 0))} Pcs)
            </button>
            {warehouses.map(w => {
              const whStock = stock.filter(s => (s.warehouseId || 'WH-CENTRAL').toUpperCase() === w.id.toUpperCase());
              const whTotalPcs = whStock.reduce((a, b) => a + b.qty, 0);
              const isActive = selectedWarehouse.toUpperCase() === w.id.toUpperCase();
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => handleWarehouseFilterChange(w.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all shrink-0 cursor-pointer border flex items-center gap-1.5 ${
                    isActive
                      ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm'
                      : 'bg-[#161B25] text-slate-400 hover:text-slate-200 border-slate-800 hover:bg-slate-800/50'
                  }`}
                >
                  <span>{w.name}</span>
                  <span className={`text-[10px] px-1 rounded font-mono ${isActive ? 'bg-indigo-800 text-indigo-200' : 'bg-slate-800 text-slate-400'}`}>
                    {formatNumber(whTotalPcs)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          {/* Search Bar */}
          <div className="relative md:col-span-4 flex items-center">
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
              <Search className="w-4 h-4" />
            </span>
            <input
              type="text"
              aria-label="Cari SKU, nama, barcode atau lokasi" placeholder="Cari SKU ID, Nama Barang, atau Lokasi..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-10 py-2 text-sm bg-[#161B25] border border-slate-800 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:bg-[#1a212f] text-slate-200 outline-none transition-all placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={() => setIsScanModalOpen(true)}
              className="absolute right-2.5 p-1 text-slate-400 hover:text-emerald-400 hover:bg-slate-800 rounded-lg transition-all cursor-pointer"
              title="Pindai barcode barang atau lokasi"
            >
              <Barcode className="w-4.5 h-4.5" />
            </button>
          </div>

          {/* Category Filter */}
          <div className="relative md:col-span-3">
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full pl-3 pr-8 py-2 text-sm bg-[#161B25] border border-slate-800 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:bg-[#1a212f] text-slate-300 outline-none transition-all appearance-none cursor-pointer font-medium"
            >
              <option value="ALL">💄 Semua Kategori</option>
              {categoriesList.map(cat => (
                <option key={cat} value={cat}>{inventoryMovementLabel(cat)}</option>
              ))}
            </select>
          </div>

          {/* Location Filter */}
          <div className="relative md:col-span-2">
            <select
              value={selectedLocation}
              onChange={(e) => setSelectedLocation(e.target.value)}
              className="w-full pl-3 pr-8 py-2 text-sm bg-[#161B25] border border-slate-800 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:bg-[#1a212f] text-slate-300 outline-none transition-all appearance-none cursor-pointer font-medium"
            >
              <option value="ALL">📍 Semua Lokasi</option>
              {locationsList.map(loc => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
            </select>
          </div>

          {/* Expired Status Filter */}
          <div className="relative md:col-span-2">
            <select
              aria-label="Filtrasi kondisi stok"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="w-full pl-3 pr-8 py-2 text-sm bg-[#161B25] border border-slate-800 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:bg-[#1a212f] text-slate-300 outline-none transition-all appearance-none cursor-pointer font-medium"
            >
              <option value="ALL">🛡️ Semua Status</option>
              {inventoryFocusOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          {/* Clear Button */}
          <div className="md:col-span-1 flex items-center justify-center">
            <button
              onClick={() => {
                setSearchTerm('');
                setSelectedLocation('ALL');
                setSelectedStatus('ALL');
                setSelectedCategory('ALL');
                setHideEmptyStock(true);
              }}
              className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-white bg-[#161B25] hover:bg-slate-800 rounded-lg border border-slate-800 w-full transition-all cursor-pointer"
              title="Reset Filter"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Mini stats banner based on filtered results */}
        <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500 px-1 pt-2 font-medium border-t border-slate-800/40 mt-1">
          <div className="flex flex-wrap items-center gap-3">
            <span>{new Set(filteredStock.map(s=>s.skuId)).size} SKU unik · <strong className="text-emerald-400">{paginatedStock.length}</strong> ditampilkan dari <strong className="text-slate-300">{totalFilteredRows}</strong> baris lokasi stok {pageSize > 0 && totalFilteredRows > pageSize ? `(Halaman ${validCurrentPage}/${totalPages})` : ''}.</span>
            <span className="text-slate-800">|</span>
            <label className="flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 cursor-pointer select-none transition-colors">
              <input
                type="checkbox"
                checked={hideEmptyStock}
                onChange={(e) => setHideEmptyStock(e.target.checked)}
                className="rounded border-slate-800 text-indigo-500 focus:ring-0 focus:ring-offset-0 cursor-pointer w-3.5 h-3.5 bg-[#161B25]"
              />
              Sembunyikan Stok Kosong (Qty 0)
            </label>
            <span className="text-slate-800">|</span>
            <label className="flex items-center gap-1.5 text-amber-400 hover:text-amber-300 cursor-pointer select-none transition-colors font-bold">
              <input
                type="checkbox"
                checked={onlyLowStock}
                onChange={(e) => setOnlyLowStock(e.target.checked)}
                className="rounded border-amber-500/50 text-amber-500 focus:ring-0 focus:ring-offset-0 cursor-pointer w-3.5 h-3.5 bg-[#161B25]"
              />
              ⚠️ Reorder Point / Stok Menipis (Qty ≤ 20)
            </label>
            {lockedStockSummary.totalLockedQty > 0 && (
              <>
                <span className="text-slate-800">|</span>
                <span className="text-amber-400 font-bold flex items-center gap-1 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-md">
                  <Lock className="w-3 h-3 text-amber-400" />
                  Dialokasikan ke order: {formatNumber(lockedStockSummary.totalLockedQty)} Pcs ({lockedStockSummary.lockedOrdersCount} order menunggu)
                </span>
              </>
            )}
          </div>
          <div className="flex gap-4">
            <span>Total fisik hasil filter: <strong className="text-emerald-400">{formatNumber(filteredStock.reduce((acc, c) => acc + c.qty, 0))} Pcs</strong></span>
          </div>
        </div>
      </div>

      {/* Main Stock Table */}
      <div className="bg-[#11141B] rounded-xl border border-slate-800/60 shadow-lg overflow-hidden">
        <InventoryStockTable stock={paginatedStock} summaryStock={summaryStock} matchedStock={filteredStock} locked={lockedStockSummary} scopeLabel={selectedWarehouse === 'ALL' ? 'semua gudang di cabang aktif' : (warehouses.find(w => w.id.toUpperCase() === selectedWarehouse.toUpperCase())?.name || selectedWarehouse)} isAdmin={isAdmin}
          onHistory={item => {setSelectedHistorySkuId(item.skuId);setSelectedHistorySkuName(item.skuName);setIsHistoryModalOpen(true);setActiveHistoryTab('all');}}
          onPrint={handlePrintCard} onEdit={handleOpenEditModal}
          onDelete={item => {if(confirm(`Apakah Anda yakin ingin menghapus stok SKU ${item.skuId} di lokasi ${item.location}?`))onDeleteStockItem(item.id);}} />

        {/* Pagination & Footer Controls */}
        <div className="bg-[#11141B] px-4 py-3 border-t border-slate-800/80 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">Tampilkan:</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="bg-[#161B25] border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-emerald-400 font-bold focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer"
              >
                <option value={-1}>Semua ({totalFilteredRows} baris)</option>
                <option value={25}>25 baris per halaman</option>
                <option value={50}>50 baris per halaman</option>
                <option value={100}>100 baris per halaman</option>
                <option value={200}>200 baris per halaman</option>
              </select>
            </div>
            <span className="text-slate-700 hidden sm:inline">|</span>
            <span className="text-slate-400">
              Menampilkan <strong className="text-white">{startRowIndex} - {endRowIndex}</strong> dari <strong className="text-emerald-400">{totalFilteredRows}</strong> baris stok
            </span>
          </div>

          <p className="text-xs">1 SKU dapat memiliki beberapa baris lokasi. Pergerakan 30 hari: cepat ≥100 pcs, sedang 10–99, lambat 1–9; nol = belum ada outbound selesai.</p>
          {/* Page Navigation Buttons */}
          {!isAllPages && totalPages > 1 && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCurrentPage(1)}
                disabled={validCurrentPage === 1}
                className="p-1.5 rounded-lg border border-slate-800 bg-[#161B25] text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                title="Halaman Pertama"
              >
                <ChevronsLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={validCurrentPage === 1}
                className="p-1.5 rounded-lg border border-slate-800 bg-[#161B25] text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                title="Halaman Sebelumnya"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <div className="px-3 py-1 font-mono font-bold text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                Halaman {validCurrentPage} / {totalPages}
              </div>

              <button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={validCurrentPage === totalPages}
                className="p-1.5 rounded-lg border border-slate-800 bg-[#161B25] text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                title="Halaman Selanjutnya"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentPage(totalPages)}
                disabled={validCurrentPage === totalPages}
                className="p-1.5 rounded-lg border border-slate-800 bg-[#161B25] text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                title="Halaman Terakhir"
              >
                <ChevronsRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ADD STOCK MODAL */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-[#11141B] rounded-2xl max-w-xl w-full shadow-2xl border border-slate-800/85 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 bg-slate-950/40 border-b border-slate-800/60 flex justify-between items-center shrink-0">
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <Plus className="w-5 h-5 text-emerald-400" />
                Tambah Stok Baru ke Lokasi
              </h3>
              <button 
                disabled={stockWriteBusy} onClick={() => setIsAddModalOpen(false)}
                className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAddSubmit} className="p-6 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-2 gap-4">
                {/* SKU ID */}
                <div className="col-span-1">
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1">SKU ID</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 1019"
                    value={formSkuId}
                    onChange={(e) => handleSkuIdChange(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                  />
                  {existingSkusMap[formSkuId] && (
                    <span className="text-[10px] text-emerald-400 font-bold block mt-0.5">✓ SKU ditemukan</span>
                  )}
                </div>

                {/* SKU Name */}
                <div className="col-span-1">
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1">SKU Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Lip Gloss Red"
                    value={formSkuName}
                    onChange={(e) => setFormSkuName(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Expired Date */}
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Kedaluwarsa</label>
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      placeholder="e.g. 27/06/2028 atau -"
                      value={formExpiredDate}
                      onChange={(e) => setFormExpiredDate(e.target.value)}
                      className="w-full px-3 py-2 pr-9 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none transition-all font-mono"
                    />
                    <label className="absolute right-2.5 cursor-pointer text-slate-400 hover:text-emerald-400 transition-colors p-1" title="Pilih Tanggal dari Kalender">
                      <Calendar className="w-4 h-4" />
                      <input
                        type="date"
                        className="sr-only"
                        onChange={(e) => {
                          if (e.target.value) {
                            setFormExpiredDate(normalizeDateToDmy(e.target.value));
                          }
                        }}
                      />
                    </label>
                  </div>
                  {formExpiredDate && (
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-slate-400 font-medium">Format:</span>
                      <span className="text-[10px] font-mono text-emerald-400 font-bold bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-800/40">
                        {normalizeDateToDmy(formExpiredDate)}
                      </span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${getStatusBadgeClass(getExpiredStatus(normalizeDateToDmy(formExpiredDate)))}`}>
                        {getExpiredStatus(normalizeDateToDmy(formExpiredDate))}
                      </span>
                    </div>
                  )}
                </div>

                {/* Location */}
                <div className="flex flex-col">
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-xs font-bold text-slate-400 uppercase">Lokasi</label>
                    {locationsList.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setIsManualLocation(!isManualLocation)}
                        className="text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors font-semibold uppercase tracking-wider cursor-pointer"
                      >
                        {isManualLocation ? "Pilih dari Daftar" : "Ketik Manual"}
                      </button>
                    )}
                  </div>
                  {!isManualLocation && locationsList.length > 0 ? (
                    <select
                      required
                      value={formLocation}
                      onChange={(e) => setFormLocation(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none transition-all cursor-pointer font-mono"
                    >
                      <option value="" disabled>-- Pilih Lokasi --</option>
                      {locationsList.map((loc) => (
                        <option key={loc} value={loc}>
                          📍 {loc}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      required
                      placeholder="e.g. E3-01-01 atau ZONE 1"
                      value={formLocation}
                      onChange={(e) => setFormLocation(e.target.value.toUpperCase())}
                      className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none transition-all font-mono"
                    />
                  )}
                </div>
              </div>

              {/* Gudang Selection */}
              {warehouses && warehouses.length > 0 && (
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-indigo-400" />
                    Gudang Penyimpanan
                  </label>
                  <select
                    value={formWarehouseId}
                    onChange={(e) => setFormWarehouseId(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none transition-all cursor-pointer font-bold"
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.code} - {w.name} {w.isCentral ? '(Pusat)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Standard Sizes */}
              <div className="bg-[#161B25] rounded-xl p-3 grid grid-cols-2 gap-4 border border-slate-800">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-0.5">Isi per karton (pcs)</label>
                  <input
                    type="number"
                    value={formCtnSize}
                    onChange={(e) => setFormCtnSize(parseInt(e.target.value, 10) || 0)}
                    className="w-full px-2 py-1 text-xs border border-slate-800 rounded bg-[#11141B] text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-0.5">Isi per inner (pcs)</label>
                  <input
                    type="number"
                    value={formInnerSize}
                    onChange={(e) => setFormInnerSize(parseInt(e.target.value, 10) || 0)}
                    className="w-full px-2 py-1 text-xs border border-slate-800 rounded bg-[#11141B] text-slate-200"
                  />
                </div>
              </div>

              {/* Input Mode Tabs */}
              <div className="space-y-2">
                <div className="flex border-b border-slate-800">
                  <button
                    type="button"
                    onClick={() => setInputMode('total')}
                    className={`flex-1 py-2 text-center text-xs font-bold cursor-pointer ${inputMode === 'total' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    Input total stok (pcs)
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputMode('split')}
                    className={`flex-1 py-2 text-center text-xs font-bold cursor-pointer ${inputMode === 'split' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    Input Berdasarkan Kemasan
                  </button>
                </div>

                {inputMode === 'total' ? (
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Total Quantity (Pcs)</label>
                    <div className="relative">
                      <input
                        type="number"
                        required
                        min="0"
                        value={formTotalQty.toString()}
                        onChange={(e) => handleFormTotalQtyChange(parseInt(e.target.value, 10) || 0)}
                        className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                      <span className="absolute right-3 top-2 text-xs font-semibold text-slate-500">Pcs</span>
                    </div>
                    {/* Auto Breakdown display */}
                    <div className="flex gap-2 mt-2 text-[11px] text-slate-300 bg-[#161B25] p-2 rounded-lg border border-slate-800/60">
                      <span className="font-semibold text-emerald-400">Hasil kemasan otomatis:</span>
                      <span>{formQtyCtn} Karton, {formQtyInner} Inner, {formQtyLoose} Eceran</span>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Karton</label>
                      <input
                        type="number"
                        min="0"
                        value={formQtyCtn}
                        onChange={(e) => handleSplitChange(parseInt(e.target.value, 10) || 0, formQtyInner, formQtyLoose)}
                        className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Inner Box</label>
                      <input
                        type="number"
                        min="0"
                        value={formQtyInner}
                        onChange={(e) => handleSplitChange(formQtyCtn, parseInt(e.target.value, 10) || 0, formQtyLoose)}
                        className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Eceran</label>
                      <input
                        type="number"
                        min="0"
                        value={formQtyLoose}
                        onChange={(e) => handleSplitChange(formQtyCtn, formQtyInner, parseInt(e.target.value, 10) || 0)}
                        className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                    </div>
                    <div className="col-span-3 text-[11px] text-slate-300 bg-[#161B25] p-2 rounded-lg border border-slate-800/60">
                      Total Hasil Kalkulasi: <strong className="text-emerald-400">{formatNumber(formTotalQty)} pcs</strong>
                    </div>
                  </div>
                )}
              </div>

              {/* Submit Button */}
              <div className="pt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 border border-slate-800 rounded-xl text-xs font-semibold text-slate-400 hover:bg-slate-800 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit" disabled={stockWriteBusy}
                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-md shadow-emerald-500/10 cursor-pointer"
                >
                  {stockWriteBusy ? 'Menyimpan…' : 'Simpan Stok'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT STOCK MODAL */}
      {isEditModalOpen && editingItem && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-[#11141B] rounded-2xl max-w-xl w-full shadow-2xl border border-slate-800/85 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 bg-slate-950/40 border-b border-slate-800/60 flex justify-between items-center shrink-0">
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-emerald-400" />
                Edit / Sesuaikan Stok Lokasi
              </h3>
              <button 
                onClick={() => {
                  setIsEditModalOpen(false);
                  setEditingItem(null);
                }}
                className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="p-6 space-y-4 overflow-y-auto flex-1">
              {editingItemActiveOrders.hasActiveOrders && (
                <div className="p-3.5 rounded-xl bg-amber-950/30 border border-amber-500/35 text-xs space-y-1.5">
                  <div className="font-extrabold text-amber-400 flex items-center gap-1.5">
                    <span>🔒 Proteksi Kunci Stok Order Berjalan</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed">
                    Baris stok ini sedang terikat pada <strong>{editingItemActiveOrders.refs.length} order aktif</strong> ({editingItemActiveOrders.refs.slice(0, 5).join(', ')}{editingItemActiveOrders.refs.length > 5 ? ', ...' : ''}).
                    Kolom <strong>Kedaluwarsa</strong>, <strong>Lokasi</strong>, dan <strong>Gudang</strong> dikunci hingga order selesai atau dibatalkan.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-0.5 text-[11px] font-mono">
                    {editingItemActiveOrders.lockedUnpickedQty > 0 && (
                      <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-bold">
                        Menunggu Picking (Min. Qty Fisik): {formatNumber(editingItemActiveOrders.lockedUnpickedQty)} Pcs
                      </span>
                    )}
                    {editingItemActiveOrders.pickedPendingQty > 0 && (
                      <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-bold">
                        Sedang di Sortir / Packing: {formatNumber(editingItemActiveOrders.pickedPendingQty)} Pcs
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {/* SKU ID */}
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1">SKU ID</label>
                  <input
                    type="text"
                    required
                    disabled
                    value={formSkuId}
                    className="w-full px-3 py-2 text-sm bg-slate-950/60 border border-slate-850 text-slate-500 rounded-lg font-mono outline-none"
                  />
                </div>

                {/* SKU Name */}
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1">SKU Name</label>
                  <input
                    type="text"
                    required
                    value={formSkuName}
                    onChange={(e) => setFormSkuName(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Expired Date */}
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1">
                    Kedaluwarsa {editingItemActiveOrders.hasActiveOrders && <span className="text-amber-400">(Terkunci)</span>}
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      disabled={editingItemActiveOrders.hasActiveOrders}
                      placeholder="DD/MM/YYYY (contoh: 27/06/2028)"
                      value={formExpiredDate}
                      onChange={(e) => setFormExpiredDate(e.target.value)}
                      className={`w-full px-3 py-2 pr-9 text-sm border rounded-lg outline-none transition-all font-mono ${
                        editingItemActiveOrders.hasActiveOrders
                          ? 'bg-slate-950/60 border-slate-850 text-slate-500 cursor-not-allowed'
                          : 'bg-[#161B25] border-slate-800 text-slate-100 focus:ring-2 focus:ring-emerald-500'
                      }`}
                    />
                    {!editingItemActiveOrders.hasActiveOrders && (
                      <label className="absolute right-2.5 cursor-pointer text-slate-400 hover:text-emerald-400 transition-colors p-1" title="Pilih Tanggal dari Kalender">
                        <Calendar className="w-4 h-4" />
                        <input
                          type="date"
                          className="sr-only"
                          onChange={(e) => {
                            if (e.target.value) {
                              setFormExpiredDate(normalizeDateToDmy(e.target.value));
                            }
                          }}
                        />
                      </label>
                    )}
                  </div>
                  {formExpiredDate && (
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-slate-400 font-medium">Format:</span>
                      <span className="text-[10px] font-mono text-emerald-400 font-bold bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-800/40">
                        {normalizeDateToDmy(formExpiredDate)}
                      </span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${getStatusBadgeClass(getExpiredStatus(normalizeDateToDmy(formExpiredDate)))}`}>
                        {getExpiredStatus(normalizeDateToDmy(formExpiredDate))}
                      </span>
                    </div>
                  )}
                </div>

                {/* Location */}
                <div className="flex flex-col">
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-xs font-bold text-slate-400 uppercase">
                      Lokasi {editingItemActiveOrders.hasActiveOrders && <span className="text-amber-400">(Terkunci)</span>}
                    </label>
                    {locationsList.length > 0 && !editingItemActiveOrders.hasActiveOrders && (
                      <button
                        type="button"
                        onClick={() => setIsManualLocation(!isManualLocation)}
                        className="text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors font-semibold uppercase tracking-wider cursor-pointer"
                      >
                        {isManualLocation ? "Pilih dari Daftar" : "Ketik Manual"}
                      </button>
                    )}
                  </div>
                  {!isManualLocation && locationsList.length > 0 ? (
                    <select
                      required
                      disabled={editingItemActiveOrders.hasActiveOrders}
                      value={formLocation}
                      onChange={(e) => setFormLocation(e.target.value)}
                      className={`w-full px-3 py-2 text-sm border rounded-lg outline-none transition-all font-mono ${
                        editingItemActiveOrders.hasActiveOrders
                          ? 'bg-slate-950/60 border-slate-850 text-slate-500 cursor-not-allowed'
                          : 'bg-[#161B25] border-slate-800 text-slate-100 focus:ring-2 focus:ring-emerald-500 cursor-pointer'
                      }`}
                    >
                      <option value="" disabled>-- Pilih Lokasi --</option>
                      {locationsList.map((loc) => (
                        <option key={loc} value={loc}>
                          📍 {loc}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      required
                      disabled={editingItemActiveOrders.hasActiveOrders}
                      value={formLocation}
                      onChange={(e) => setFormLocation(e.target.value.toUpperCase())}
                      className={`w-full px-3 py-2 text-sm border rounded-lg outline-none transition-all font-mono ${
                        editingItemActiveOrders.hasActiveOrders
                          ? 'bg-slate-950/60 border-slate-850 text-slate-500 cursor-not-allowed'
                          : 'bg-[#161B25] border-slate-800 text-slate-100 focus:ring-2 focus:ring-emerald-500'
                      }`}
                    />
                  )}
                </div>
              </div>

              {/* Gudang Selection */}
              {warehouses && warehouses.length > 0 && (
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-indigo-400" />
                    Gudang Penyimpanan {editingItemActiveOrders.hasActiveOrders && <span className="text-amber-400">(Terkunci)</span>}
                  </label>
                  <select
                    disabled={editingItemActiveOrders.hasActiveOrders}
                    value={formWarehouseId}
                    onChange={(e) => setFormWarehouseId(e.target.value)}
                    className={`w-full px-3 py-2 text-sm border rounded-lg outline-none transition-all font-bold ${
                      editingItemActiveOrders.hasActiveOrders
                        ? 'bg-slate-950/60 border-slate-850 text-slate-500 cursor-not-allowed'
                        : 'bg-[#161B25] border-slate-800 text-slate-100 focus:ring-2 focus:ring-emerald-500 cursor-pointer'
                    }`}
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.code} - {w.name} {w.isCentral ? '(Pusat)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Standard Sizes */}
              <div className="bg-[#161B25] rounded-xl p-3 grid grid-cols-2 gap-4 border border-slate-800">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-0.5">Isi per karton (pcs)</label>
                  <input
                    type="number"
                    value={formCtnSize}
                    onChange={(e) => setFormCtnSize(parseInt(e.target.value, 10) || 0)}
                    className="w-full px-2 py-1 text-xs border border-slate-800 rounded bg-[#11141B] text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-0.5">Isi per inner (pcs)</label>
                  <input
                    type="number"
                    value={formInnerSize}
                    onChange={(e) => setFormInnerSize(parseInt(e.target.value, 10) || 0)}
                    className="w-full px-2 py-1 text-xs border border-slate-800 rounded bg-[#11141B] text-slate-200"
                  />
                </div>
              </div>

              {/* Input Mode Tabs */}
              <div className="space-y-2">
                <div className="flex border-b border-slate-800">
                  <button
                    type="button"
                    onClick={() => setInputMode('total')}
                    className={`flex-1 py-2 text-center text-xs font-bold cursor-pointer ${inputMode === 'total' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    Sesuaikan total stok (pcs)
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputMode('split')}
                    className={`flex-1 py-2 text-center text-xs font-bold cursor-pointer ${inputMode === 'split' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    Sesuaikan Berdasarkan Kemasan
                  </button>
                </div>

                {inputMode === 'total' ? (
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Total Quantity (Pcs)</label>
                    <div className="relative">
                      <input
                        type="number"
                        required
                        min="0"
                        value={formTotalQty}
                        onChange={(e) => handleFormTotalQtyChange(parseInt(e.target.value, 10) || 0)}
                        className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                      <span className="absolute right-3 top-2 text-xs font-semibold text-slate-500">Pcs</span>
                    </div>
                    {/* Auto Breakdown display */}
                    <div className="flex gap-2 mt-2 text-[11px] text-slate-300 bg-[#161B25] p-2 rounded-lg border border-slate-800/60">
                      <span className="font-semibold text-emerald-400">Hasil kemasan otomatis:</span>
                      <span>{formQtyCtn} Karton, {formQtyInner} Inner, {formQtyLoose} Eceran</span>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Karton</label>
                      <input
                        type="number"
                        min="0"
                        value={formQtyCtn}
                        onChange={(e) => handleSplitChange(parseInt(e.target.value, 10) || 0, formQtyInner, formQtyLoose)}
                        className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Inner Box</label>
                      <input
                        type="number"
                        min="0"
                        value={formQtyInner}
                        onChange={(e) => handleSplitChange(formQtyCtn, parseInt(e.target.value, 10) || 0, formQtyLoose)}
                        className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Eceran</label>
                      <input
                        type="number"
                        min="0"
                        value={formQtyLoose}
                        onChange={(e) => handleSplitChange(formQtyCtn, formQtyInner, parseInt(e.target.value, 10) || 0)}
                        className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-slate-100 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                    </div>
                    <div className="col-span-3 text-[11px] text-slate-300 bg-[#161B25] p-2 rounded-lg border border-slate-800/60">
                      Total Hasil Kalkulasi: <strong className="text-emerald-400">{formatNumber(formTotalQty)} pcs</strong>
                    </div>
                  </div>
                )}
              </div>

              {/* Submit Button */}
              <div className="pt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditModalOpen(false);
                    setEditingItem(null);
                  }}
                  className="px-4 py-2 border border-slate-800 rounded-xl text-xs font-semibold text-slate-400 hover:bg-slate-800 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-md shadow-emerald-500/10 cursor-pointer"
                >
                  Perbarui Stok
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EXCEL / CSV BULK IMPORT MODAL */}
      {isImportModalOpen && !importConfirmModal?.isOpen && (
        <ModalFrame titleId="stock-import-title" className="trueblue-stock-import" onClose={()=>{if(!stockWriteBusy)setIsImportModalOpen(false)}}>
          <div className="bg-[#11141B] rounded-2xl max-w-4xl w-full shadow-2xl border border-slate-800/85 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 bg-slate-950/40 border-b border-slate-800/60 flex justify-between items-center shrink-0">
              <h3 id="stock-import-title" className="font-bold text-white text-base flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-indigo-400" />
                Sistem Impor Data Massal (Excel / CSV)
              </h3>
              <button aria-label="Tutup impor stok" data-modal-close
                onClick={() => {
                  setIsImportModalOpen(false);
                  setImportText('');
                }}
                className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm text-slate-300">
              {/* Top Mode Selectors */}
              <div className="bg-slate-900/40 border border-slate-800/60 p-4 rounded-xl space-y-3">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider">Metode Penggabungan Data</label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${importMode === 'merge' ? 'bg-indigo-650/10 border-indigo-500 text-white' : 'bg-[#161B25] border-slate-800 hover:bg-slate-800/40 text-slate-400'}`}>
                    <input 
                      type="radio" 
                      name="importMode" 
                      value="merge" 
                      checked={importMode === 'merge'} 
                      onChange={() => setImportMode('merge')}
                      className="mt-1 accent-indigo-500 cursor-pointer"
                    />
                    <div>
                      <p className="font-bold text-xs">Gabungkan Kuantitas (Merge)</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">Tambahkan qty impor ke baris lokasi & exp date yang sama.</p>
                    </div>
                  </label>

                  <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${importMode === 'overwrite' ? 'bg-indigo-650/10 border-indigo-500 text-white' : 'bg-[#161B25] border-slate-800 hover:bg-slate-800/40 text-slate-400'}`}>
                    <input 
                      type="radio" 
                      name="importMode" 
                      value="overwrite" 
                      checked={importMode === 'overwrite'} 
                      onChange={() => setImportMode('overwrite')}
                      className="mt-1 accent-indigo-500 cursor-pointer"
                    />
                    <div>
                      <p className="font-bold text-xs">Perbarui Kuantitas (Overwrite)</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">Ganti kuantitas item yang cocok dengan nilai baru.</p>
                    </div>
                  </label>

                  <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${importMode === 'replace' ? 'bg-rose-950/10 border-rose-500/50 text-white' : 'bg-[#161B25] border-slate-800 hover:bg-slate-800/40 text-slate-400'}`}>
                    <input 
                      type="radio" 
                      name="importMode" 
                      value="replace" 
                      checked={importMode === 'replace'} 
                      onChange={() => setImportMode('replace')}
                      className="mt-1 accent-rose-500 cursor-pointer"
                    />
                    <div>
                      <p className="font-bold text-xs text-rose-400">Gantikan Seluruh Data</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">Hapus seluruh stok di gudang dan gantikan dengan data ini.</p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Main Paste / Drop Row */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Input Text / File Drop */}
                <div className="lg:col-span-8 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider">Tempel Data dari Excel / Google Sheets</label>
                    <span className="text-[10px] text-indigo-400 font-semibold bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                      Format Kolom Bertabulasi (\t) atau CSV
                    </span>
                  </div>

                  <div 
                    onDragEnter={handleDrag} 
                    onDragOver={handleDrag} 
                    onDragLeave={handleDrag} 
                    onDrop={handleDrop}
                    className={`relative rounded-xl border-2 border-dashed transition-all ${dragActive ? 'border-indigo-400 bg-indigo-950/20' : 'border-slate-800 bg-slate-950/20'}`}
                  >
                    <textarea
                      placeholder="Tempel baris data Excel Anda di sini...&#10;Contoh format:&#10;SKU ID [TAB] SKU Name [TAB] Expired Date [TAB] Location [TAB] Qty&#10;WR-001	Wardah Sunscreen	12/12/2028	E1-01-01	2450"
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      rows={8}
                      className="w-full px-4 py-3 bg-transparent text-slate-200 outline-none text-xs font-mono placeholder:text-slate-650 resize-none"
                    ></textarea>

                    {/* Drag overlay description */}
                    <div className="absolute bottom-3 right-4 flex items-center gap-2 pointer-events-none">
                      <span className="text-[10px] text-slate-500">Atau seret & taruh file .xlsx / .csv di sini</span>
                    </div>
                  </div>

                  {/* Manual file uploader */}
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">Mendukung file Excel (.xlsx), CSV, dan copy-paste.</span>
                    <label className="text-indigo-400 hover:text-indigo-300 font-bold flex items-center gap-1.5 cursor-pointer">
                      <Download className="w-3.5 h-3.5 rotate-180" />
                      Pilih File Excel / CSV (.xlsx, .csv)
                      <input 
                        type="file" 
                        accept=".xlsx,.xls,.csv,.txt" 
                        onChange={handleFileChange} 
                        className="hidden" 
                      />
                    </label>
                  </div>
                </div>

                {/* Instructions & Quick Action Buttons */}
                <div className="lg:col-span-4 space-y-4">
                  <div className="bg-[#161B25] rounded-xl p-4 border border-slate-850/60 space-y-3">
                    <h4 className="font-bold text-white text-xs uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-800/80 pb-2">
                      <Info className="w-4 h-4 text-indigo-400" />
                      Petunjuk Kolom
                    </h4>
                    <ul className="text-[11px] text-slate-400 space-y-2 list-decimal list-inside leading-relaxed">
                      <li>Kolom harus berurutan (Kiri ke Kanan)</li>
                      <li><strong>1. SKU ID</strong> (Wajib, teks)</li>
                      <li><strong>2. SKU Name</strong> (Wajib/Opsional, teks)</li>
                      <li><strong>3. Expired Date</strong> (Format DD/MM/YYYY atau -)</li>
                      <li><strong>4. Location</strong> (Nama rak, e.g. E1-01-01)</li>
                      <li><strong>5. Qty</strong> (Wajib, angka positif)</li>
                      <li><strong>6. Qty/Ctn Size</strong> (Opsional, bawaan 720)</li>
                      <li><strong>7. Qty/Inner Size</strong> (Opsional, bawaan 12)</li>
                    </ul>

                    <div className="pt-2 space-y-2">
                      <button
                        type="button"
                        onClick={handleLoadSampleTemplate}
                        className="w-full py-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 font-semibold border border-indigo-500/20 rounded-lg text-xs transition-colors cursor-pointer"
                      >
                        ✓ Muat Contoh Format Data
                      </button>
                      <button
                        type="button"
                        onClick={handleLoadInitialStockToImport}
                        className="w-full py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-semibold border border-emerald-500/20 rounded-lg text-xs transition-colors cursor-pointer"
                      >
                        ⚡ Salin Stok Saat Ini ke Editor
                      </button>
                      
                    </div>
                  </div>
                </div>
              </div>

              {/* Parsed Live Preview Table */}
              {parsedImportRows.length > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                      Pratinjau Data Impor ({parsedImportRows.filter(r => r.isValid).length} baris valid dari {parsedImportRows.length} baris)
                    </h4>
                    {parsedImportRows.length > 5 && (
                      <span className="text-[10px] text-slate-500 italic">Menampilkan 5 baris pertama</span>
                    )}
                  </div>

                  <div className="bg-slate-950/40 border border-slate-850 rounded-xl overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-900/60 text-slate-400 font-bold border-b border-slate-800">
                          <th className="py-2 px-3">SKU ID</th>
                          <th className="py-2 px-3">Nama Barang</th>
                          <th className="py-2 px-3 text-center">Kedaluwarsa</th>
                          <th className="py-2 px-3 text-center">Lokasi</th>
                          <th className="py-2 px-3 text-right">Qty (Pcs)</th>
                          <th className="py-2 px-3 text-center">Status Exp</th>
                          <th className="py-2 px-3 text-center">Validitas</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-850/60 font-medium">
                        {parsedImportRows.slice(0, 5).map((row, index) => {
                          const calculatedStatus = getExpiredStatus(row.expiredDate);
                          const statusColor = getStatusBadgeClass(calculatedStatus);

                          return (
                            <tr key={index} className="hover:bg-slate-800/20 text-slate-300">
                              <td className="py-2 px-3 font-mono font-bold text-indigo-300">{row.skuId}</td>
                              <td className="py-2 px-3 truncate max-w-[150px]">{row.skuName}</td>
                              <td className="py-2 px-3 text-center font-mono">{row.expiredDate}</td>
                              <td className="py-2 px-3 text-center font-mono text-indigo-400">{row.location}</td>
                              <td className="py-2 px-3 text-right font-bold text-white">{formatNumber(row.qty)}</td>
                              <td className="py-2 px-3 text-center">
                                <span className={`inline-block px-2 py-0.2 rounded-full text-[10px] border ${statusColor}`}>
                                  {calculatedStatus}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-center">
                                {row.isValid ? (
                                  <span className="text-emerald-450 font-bold">✓ Valid</span>
                                ) : (
                                  <span className="text-rose-400 font-bold" title={row.error}>✗ Error</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 bg-slate-950/40 border-t border-slate-800/60 flex justify-between items-center shrink-0">
              <div className="text-xs text-slate-500">
                Data akan dipecah menjadi Karton, Inner, dan Eceran secara otomatis.
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsImportModalOpen(false);
                    setImportText('');
                  }}
                  className="px-4 py-2 border border-slate-800 rounded-xl text-xs font-semibold text-slate-450 hover:bg-slate-800 hover:text-white cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleProcessImport}
                  disabled={stockWriteBusy}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition-all shadow-md shadow-indigo-600/20 cursor-pointer"
                >
                  Proses & Simpan Ke Database
                </button>
              </div>
            </div>
          </div>
        </ModalFrame>
      )}

      {isDeleteAllModalOpen&&<StockPurge rows={stock.length} qty={stock.reduce((n,s)=>n+s.qty,0)} onClose={()=>setIsDeleteAllModalOpen(false)}/>}

      {/* SKU History Modal */}
      {isHistoryModalOpen && selectedHistorySkuId && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-[#11141B] rounded-2xl max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-800/85 overflow-hidden">
            
            {/* Header */}
            <div className="px-6 py-4 bg-slate-950/40 border-b border-slate-800/60 flex justify-between items-start">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-extrabold text-emerald-400 text-xs bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-0.5 rounded">
                    SKU {selectedHistorySkuId}
                  </span>
                  <span className="text-[10px] bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-mono px-2 py-0.5 rounded flex items-center gap-1">
                    <Barcode className="w-3 h-3" />
                    {getBarcodeForSku(selectedHistorySkuId)}
                  </span>
                </div>
                <h3 className="font-bold text-white text-lg tracking-tight leading-snug">
                  {selectedHistorySkuName || 'Nama Barang Tidak Ditemukan'}
                </h3>
              </div>
              <button 
                onClick={() => {
                  setIsHistoryModalOpen(false);
                  setSelectedHistorySkuId(null);
                }}
                className="p-1.5 hover:bg-slate-800 text-slate-450 hover:text-white rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body: Split into current status & historical feeds */}
            <div className="p-6 overflow-y-auto flex-1 grid grid-cols-1 md:grid-cols-12 gap-6 bg-[#0E1117]">
              
              {/* Left sidebar: Current Stock Status / Locations / Pack Specs */}
              <div className="md:col-span-4 space-y-4">
                <div className="bg-[#151922] rounded-xl p-4 border border-slate-800/60">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Status Stok Saat Ini</h4>
                  
                  {/* Total Qty */}
                  <div className="mb-4">
                    <p className="text-[10px] text-slate-500 font-semibold uppercase">Total Stok Tersedia</p>
                    <p className="text-2xl font-black text-white">
                      {formatNumber(totalSkuStockQty)}
                      <span className="text-sm font-medium text-slate-400 ml-1">pcs</span>
                    </p>
                  </div>

                  {/* Locations Detail list */}
                  <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1">
                    <p className="text-[10px] text-slate-500 font-semibold uppercase">Penyebaran Lokasi</p>
                    {skuStockItems.length === 0 ? (
                      <p className="text-xs text-slate-500 italic">Tidak ada stok di lokasi mana pun</p>
                    ) : (
                      skuStockItems.map(item => (
                        <div key={item.id} className="flex justify-between items-center bg-[#1B212D] border border-slate-800/40 px-2.5 py-1.5 rounded-lg text-xs">
                          <div className="flex items-center gap-1.5 text-indigo-400 font-mono font-bold">
                            <MapPin className="w-3.5 h-3.5 text-indigo-400" />
                            <span>{item.location}</span>
                          </div>
                          <div className="text-right">
                            <span className="font-extrabold text-white font-mono">{formatNumber(item.qty)}</span>
                            <span className="text-[9px] text-slate-500 font-normal ml-0.5"> pcs</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Packaging Specification Spec */}
                <div className="bg-[#151922] rounded-xl p-4 border border-slate-800/60">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Spesifikasi Kemasan</h4>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-[#1B212D]/60 p-2.5 rounded-lg border border-slate-800/40 text-center">
                      <p className="text-[9px] text-slate-500 uppercase font-bold">QTY / Karton</p>
                      <p className="font-black text-emerald-400 text-sm mt-1">{getProductPackSizes(selectedHistorySkuId).qtyCtnSize} <span className="text-[10px] font-normal text-slate-400">pcs</span></p>
                    </div>
                    <div className="bg-[#1B212D]/60 p-2.5 rounded-lg border border-slate-800/40 text-center">
                      <p className="text-[9px] text-slate-500 uppercase font-bold">QTY / Inner Box</p>
                      <p className="font-black text-amber-400 text-sm mt-1">{getProductPackSizes(selectedHistorySkuId).qtyInnerSize} <span className="text-[10px] font-normal text-slate-400">pcs</span></p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right main panel: Movements Feed */}
              <div className="md:col-span-8 flex flex-col space-y-4">
                
                {/* Custom Tab Selector */}
                <div className="flex border-b border-slate-800/60 bg-[#151922] p-1 rounded-xl">
                  <button
                    onClick={() => setActiveHistoryTab('all')}
                    className={`flex-1 text-center py-2 px-3 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      activeHistoryTab === 'all' 
                        ? 'bg-emerald-500 text-slate-950 font-black shadow-md' 
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Semua ({unifiedHistoryFeed.length})
                  </button>
                  <button
                    onClick={() => setActiveHistoryTab('transfer')}
                    className={`flex-1 text-center py-2 px-3 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      activeHistoryTab === 'transfer' 
                        ? 'bg-emerald-500 text-slate-950 font-black shadow-md' 
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Transfer ({unifiedHistoryFeed.filter(i => i.type === 'TRANSFER' || i.type === 'TRANSFER_IN' || i.type === 'TRANSFER_OUT').length})
                  </button>
                  <button
                    onClick={() => setActiveHistoryTab('order')}
                    className={`flex-1 text-center py-2 px-3 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      activeHistoryTab === 'order' 
                        ? 'bg-emerald-500 text-slate-950 font-black shadow-md' 
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Order Outbound ({unifiedHistoryFeed.filter(i => i.source === 'ORDER' || i.type === 'OUTBOUND').length})
                  </button>
                  <button
                    onClick={() => setActiveHistoryTab('inbound_adjust')}
                    className={`flex-1 text-center py-2 px-3 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      activeHistoryTab === 'inbound_adjust' 
                        ? 'bg-emerald-500 text-slate-950 font-black shadow-md' 
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Inbound & Penyesuaian ({unifiedHistoryFeed.filter(i => i.type === 'INBOUND' || i.type === 'ADJUSTMENT').length})
                  </button>
                </div>

                {/* Timeline Feed Container */}
                <div className="flex-1 overflow-y-auto max-h-[450px] pr-1 space-y-3">
                  {filteredHistoryFeed.length === 0 ? (
                    <div className="text-center py-12 bg-[#151922] border border-dashed border-slate-800 rounded-xl">
                      <Archive className="w-12 h-12 text-slate-650 mx-auto mb-2 stroke-1" />
                      <p className="text-sm font-semibold text-slate-400">Tidak ada riwayat pergerakan</p>
                      <p className="text-xs text-slate-550 mt-1">Belum ada aktivitas tercatat untuk SKU ini pada kategori terpilih</p>
                    </div>
                  ) : (
                    <div className="relative border-l border-slate-800 pl-4 ml-2.5 py-1 space-y-4">
                      {filteredHistoryFeed.map((item) => {
                        let dotColor = 'bg-slate-550 border-slate-700';
                        let badgeColor = 'bg-slate-500/10 text-slate-400 border border-slate-500/10';

                        if (item.type === 'TRANSFER' || item.type === 'TRANSFER_IN' || item.type === 'TRANSFER_OUT') {
                          dotColor = 'bg-indigo-500 ring-2 ring-indigo-500/20';
                          badgeColor = 'bg-indigo-550/10 text-indigo-400 border border-indigo-500/20';
                        } else if (item.type === 'ORDER' || item.type === 'OUTBOUND') {
                          dotColor = 'bg-rose-500 ring-2 ring-rose-500/20';
                          badgeColor = 'bg-rose-500/10 text-rose-455 border border-rose-500/20';
                        } else if (item.type === 'INBOUND') {
                          dotColor = 'bg-emerald-500 ring-2 ring-emerald-500/20';
                          badgeColor = 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25';
                        } else if (item.type === 'ADJUSTMENT') {
                          dotColor = 'bg-amber-500 ring-2 ring-amber-500/20';
                          badgeColor = 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
                        }

                        return (
                          <div key={item.id} className="relative group">
                            {/* Timeline Node Dot */}
                            <div className={`absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full ${dotColor} border border-[#0E1117] transition-all`} />

                            <div className="bg-[#151922] border border-slate-800/60 hover:border-slate-750 p-3.5 rounded-xl transition-all space-y-2">
                              {/* Row 1: Header / Badge & Timestamp */}
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ${badgeColor}`}>
                                  {item.typeLabel}
                                </span>
                                <span className="text-slate-500 font-medium font-mono text-[10px]">
                                  {new Date(item.timestamp).toLocaleString('id-ID', {
                                    year: 'numeric',
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit'
                                  })} WIB
                                </span>
                              </div>

                              {/* Row 2: Qty and Locations */}
                              <div className="flex items-center justify-between gap-4 py-0.5">
                                <div className="text-sm font-extrabold text-white font-mono">
                                  {item.type === 'ORDER' || item.type === 'OUTBOUND' || item.type === 'TRANSFER_OUT' ? '-' : '+'}
                                  {formatNumber(item.qty)}
                                  <span className="text-[10px] text-slate-500 font-normal ml-0.5"> pcs</span>
                                </div>
                                <div className="text-xs text-indigo-400 font-mono font-bold bg-[#1B212D] border border-slate-800/50 px-2 py-0.5 rounded flex items-center gap-1">
                                  <MapPin className="w-3 h-3 text-slate-500" />
                                  <span>{item.location || '-'}</span>
                                </div>
                              </div>

                              {/* Row 3: Transaction Details Description */}
                              <p className="text-xs text-slate-300 leading-relaxed font-medium">
                                {item.details}
                              </p>

                              {/* Row 4: Operator Name */}
                              <div className="flex items-center justify-between border-t border-slate-800/40 pt-2 text-[10px] text-slate-500 font-semibold uppercase">
                                <span className="flex items-center gap-1 font-medium">
                                  Operator: <strong className="text-slate-400 uppercase font-extrabold ml-0.5">{item.user || 'Sistem'}</strong>
                                </span>
                                {item.status && (
                                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-extrabold border ${
                                    item.status === 'Completed' 
                                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                                      : item.status === 'Cancelled'
                                      ? 'bg-rose-500/10 text-rose-455 border-rose-500/20'
                                      : 'bg-amber-500/10 text-amber-455 border-amber-500/20'
                                  }`}>
                                    {item.status}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>

            </div>

            {/* Footer buttons */}
            <div className="px-6 py-4 bg-slate-950/40 border-t border-slate-850 flex justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setIsHistoryModalOpen(false);
                  setSelectedHistorySkuId(null);
                }}
                className="px-5 py-2 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-extrabold rounded-xl text-xs shadow-lg transition-all cursor-pointer"
              >
                Tutup Riwayat
              </button>
            </div>

          </div>
        </div>
      )}
      {/* Barcode scanner modal */}
      <BarcodeScannerModal
        isOpen={isScanModalOpen}
        onClose={() => setIsScanModalOpen(false)}
        onScanSuccess={(val) => setSearchTerm(val)}
        stock={stock}
        title="Scan Barcode / Lokasi Stok Barang"
      />

      {/* Print Preview & Action Modal */}
      {activePrintItem && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 print:hidden animate-fade-in">
          <div className="bg-[#11141B] border border-slate-800 rounded-2xl max-w-lg w-full flex flex-col shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-800/80 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Printer className="w-5 h-5 text-indigo-400" />
                <h3 className="font-bold text-white text-base">Cetak Label Rak</h3>
              </div>
              <button 
                onClick={() => setActivePrintItem(null)}
                className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Preview Body */}
            <div className="p-6 flex flex-col items-center justify-center bg-slate-950/30 gap-4">
              <span className="text-[11px] font-bold text-indigo-400 bg-indigo-500/10 border border-indigo-500/15 px-2.5 py-1 rounded-full uppercase tracking-wider">
                Pratinjau Label Cetak (Print Preview)
              </span>

              {/* The exact label card shown on screen as preview */}
              <div className="w-full max-w-sm border-2 border-slate-700 bg-white text-black p-5 rounded-xl flex flex-col justify-between aspect-[1.7/1] shadow-lg">
                <div className="border-b border-gray-300 pb-1.5 flex justify-between items-start">
                  <div>
                    <span className="text-[8px] font-mono tracking-widest font-black text-gray-500 block uppercase">LABELLING RAK GUDANG</span>
                    <h4 className="text-2xl font-black tracking-tight mt-0.5">{activePrintItem.skuId}</h4>
                  </div>
                </div>

                <div className="py-2 flex-1 flex flex-col justify-center">
                  <p className="text-xs font-black leading-tight text-center uppercase tracking-wide break-words text-gray-800">
                    {activePrintItem.skuName}
                  </p>
                </div>

                <div className="border-t border-gray-300 pt-1.5 flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-[7px] font-bold text-gray-400 uppercase">EXPIRED DATE</span>
                    <span className="text-[10px] font-mono font-bold">{activePrintItem.expiredDate}</span>
                  </div>
                  
                  {/* Barcode QR */}
                  <div className="flex flex-col items-center gap-1">
                    <QRCodeImage text={getBarcodeForSku(activePrintItem.skuId) !== '-' ? getBarcodeForSku(activePrintItem.skuId) : activePrintItem.skuId} />
                    <span className="text-[8px] font-mono tracking-wider">
                      {getBarcodeForSku(activePrintItem.skuId) !== '-' ? getBarcodeForSku(activePrintItem.skuId) : activePrintItem.skuId}
                    </span>
                  </div>
                </div>
              </div>

              {/* Alert / Tips for iframe */}
              {isInIframe && (
                <div className="w-full bg-amber-500/10 border border-amber-500/20 rounded-xl p-3.5 text-xs text-amber-400 flex items-start gap-3 text-left">
                  <AlertTriangle className="w-5 h-5 shrink-0 text-amber-500 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-extrabold uppercase tracking-wide text-[10px]">Peringatan Keamanan Browser (Iframe):</p>
                    <p className="leading-relaxed text-[11px] text-slate-300">
                      Browser memblokir cetak otomatis (<code className="font-mono bg-amber-500/10 px-1 py-0.5 rounded text-amber-400">window.print()</code>) karena aplikasi sedang berjalan di dalam panel preview editor ini. 
                    </p>
                    <p className="leading-relaxed text-[11px] text-slate-350">
                      👉 <strong>Solusi:</strong> Silakan klik tombol <strong>"Buka di Tab Baru" (ikon di pojok kanan atas preview)</strong> agar printer fisik Anda dapat merespon secara langsung!
                    </p>
                  </div>
                </div>
              )}

              {printError && (
                <div className="w-full bg-rose-500/10 border border-rose-500/20 rounded-xl p-3 text-xs text-rose-450 flex items-start gap-2.5 text-left">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-extrabold uppercase tracking-wide text-[10px]">Cetak Gagal / Terblokir:</p>
                    <p className="leading-relaxed text-[11px] text-slate-300">
                      Browser menolak membuka dialog cetak. Solusinya, silakan klik tombol ikon persegi dengan tanda panah di pojok kanan atas preview untuk membuka aplikasi di Tab Baru, lalu klik Cetak kembali di sana.
                    </p>
                  </div>
                </div>
              )}

              <div className="w-full text-slate-400 text-xs text-center border border-dashed border-slate-850 p-3 rounded-lg space-y-1">
                <p className="font-semibold text-amber-400">⚠️ Tips Cetak di Browser/Preview:</p>
                <p className="text-[11px] leading-relaxed">
                  Jika dialog cetak printer tidak muncul saat klik tombol <strong>"Mulai Cetak"</strong>, silakan buka aplikasi ini di <strong>Tab Baru</strong> lalu coba cetak kembali.
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-slate-950/40 border-t border-slate-850 flex justify-between gap-2">
              <button
                type="button"
                onClick={() => setActivePrintItem(null)}
                className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    window.print();
                  } catch (err) {
                    console.error("Failed to print within iframe sandbox:", err);
                    setPrintError("Browser membatasi fitur cetak dari dalam iFrame peninjau.");
                  }
                }}
                className="px-5 py-2 bg-indigo-500 hover:bg-indigo-400 text-white font-extrabold rounded-xl text-xs shadow-lg transition-all cursor-pointer flex items-center gap-1.5"
              >
                <Printer className="w-4 h-4" />
                Mulai Cetak
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POPUP MODAL KONFIRMASI / SUKSES IMPORT (DI TENGAH LAYAR DENGAN TOMBOL OK) */}
      {importConfirmModal && importConfirmModal.isOpen && (
        <ModalFrame titleId="stock-import-confirm-title" className="trueblue-inventory-danger" onClose={()=>setImportConfirmModal(null)}>
          <div className="bg-[#11141B] rounded-2xl max-w-md w-full shadow-2xl border border-slate-700/80 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
            <div className={`px-6 py-5 border-b flex items-center gap-3 ${
              importConfirmModal.warningType === 'danger' 
                ? 'bg-rose-950/40 border-rose-900/50 text-rose-400' 
                : importConfirmModal.warningType === 'warning'
                ? 'bg-amber-950/40 border-amber-900/50 text-amber-400'
                : importConfirmModal.warningType === 'success'
                ? 'bg-emerald-950/40 border-emerald-900/50 text-emerald-400'
                : 'bg-indigo-950/40 border-indigo-900/50 text-indigo-400'
            }`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 border ${
                importConfirmModal.warningType === 'danger' 
                  ? 'bg-rose-500/20 border-rose-500/30 text-rose-400' 
                  : importConfirmModal.warningType === 'warning'
                  ? 'bg-amber-500/20 border-amber-500/30 text-amber-400'
                  : importConfirmModal.warningType === 'success'
                  ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
                  : 'bg-indigo-500/20 border-indigo-500/30 text-indigo-400'
              }`}>
                {importConfirmModal.warningType === 'success' ? (
                  <CheckCircle className="w-6 h-6" />
                ) : importConfirmModal.warningType === 'danger' || importConfirmModal.warningType === 'warning' ? (
                  <AlertTriangle className="w-6 h-6 animate-pulse" />
                ) : (
                  <Info className="w-6 h-6" />
                )}
              </div>
              <div>
                <h3 id="stock-import-confirm-title" className="font-extrabold text-white text-base leading-snug">{importConfirmModal.title}</h3>
                <p className="text-[11px] opacity-80">Sistem Impor Data WMS</p>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-[#161B25] rounded-xl p-4 border border-slate-800 text-xs text-slate-200 leading-relaxed whitespace-pre-line font-medium">
                {importConfirmModal.message}
              </div>
            </div>

            <div className="px-6 py-4 bg-[#0A0C10] border-t border-slate-800/80 flex items-center justify-end gap-3">
              {importConfirmModal.showCancel && (
                <button
                  type="button"
                  onClick={() => setImportConfirmModal(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Batal
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (importConfirmModal.onConfirm) {
                    importConfirmModal.onConfirm();
                  } else {
                    setImportConfirmModal(null);
                  }
                }}
                className={`px-6 py-2.5 font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer flex items-center justify-center gap-2 ${
                  importConfirmModal.warningType === 'danger'
                    ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30'
                    : importConfirmModal.warningType === 'warning'
                    ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/30'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30'
                }`}
              >
                {importConfirmModal.confirmText || 'OK'}
              </button>
            </div>
          </div>
        </ModalFrame>
      )}

      {/* Printable Card Container - completely hidden on screen, visible only on print */}
      {activePrintItem && (
        <div className="hidden print:flex print:flex-col print:items-center print:justify-center print:bg-white print:text-black print:p-8 print:min-h-screen print:w-full print-card-container">
          <div className="w-[110mm] h-[65mm] border-4 border-black border-double rounded-xl p-5 flex flex-col justify-between bg-white text-black shadow-none max-w-md mx-auto">
            {/* Header */}
            <div className="border-b-2 border-black pb-2 flex justify-between items-start">
              <div>
                <span className="text-[9px] font-mono tracking-widest font-extrabold uppercase text-gray-700">LABELLING RAK GUDANG</span>
                <h2 className="text-3xl font-black tracking-tight mt-0.5">{activePrintItem.skuId}</h2>
              </div>
            </div>

            {/* Item Name */}
            <div className="py-2 flex-1 flex flex-col justify-center">
              <p className="text-sm font-extrabold leading-tight text-center uppercase tracking-wide break-words">
                {activePrintItem.skuName}
              </p>
            </div>

            {/* Footer / Barcode */}
            <div className="border-t-2 border-black pt-2 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[8px] font-bold text-gray-500">EXPIRED DATE</span>
                <span className="text-xs font-mono font-bold mt-0.5">{activePrintItem.expiredDate}</span>
              </div>
              
              {/* Barcode QR Graphic */}
              <div className="flex flex-col items-center gap-1">
                <QRCodeImage text={getBarcodeForSku(activePrintItem.skuId) !== '-' ? getBarcodeForSku(activePrintItem.skuId) : activePrintItem.skuId} />
                <span className="text-[9px] font-mono font-semibold tracking-widest">
                  {getBarcodeForSku(activePrintItem.skuId) !== '-' ? getBarcodeForSku(activePrintItem.skuId) : activePrintItem.skuId}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Thermal Label Printer Modal */}
      {isThermalPrinterOpen && (
        <ThermalLabelPrinter
          isOpen={isThermalPrinterOpen}
          onClose={() => setIsThermalPrinterOpen(false)}
          allStock={stock}
          allLocations={locationsList.filter(l => l !== 'ALL')}
          initialItems={thermalInitialItems}
          initialMode="product"
        />
      )}
    </div>
  );
}
