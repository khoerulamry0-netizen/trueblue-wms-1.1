import React, { useState, useMemo, useRef } from 'react';
import { Warehouse, InterWarehouseTransfer, StockItem, DccLog, WarehouseType, InterWarehouseTransferItem, PickingRoutePattern, WarehousePickingRouteConfig } from '../types';
import { formatNumber, calculatePackQuantities, getProductPackSizes, normalizeDateToDmy, getCanonicalStockId, findStockIndex, getExpiredStatus, isStockPickable } from '../utils/calculations';
import { ROUTE_PRESETS, describeRouteConfig, DEFAULT_TRUEBLUE_ROUTE_CONFIG, DEFAULT_CENTRAL_WAREHOUSE, ensureCentralWarehouse } from '../utils/warehouseRouting';
import { 
  Building2, 
  Plus, 
  ArrowLeftRight, 
  Truck, 
  MapPin, 
  Phone, 
  User, 
  CheckCircle2, 
  Clock, 
  Printer, 
  Search, 
  Filter, 
  Package, 
  Layers, 
  Edit3, 
  Trash2, 
  FileText, 
  X, 
  AlertTriangle, 
  Boxes, 
  ChevronRight, 
  Share2, 
  Download,
  ShieldCheck,
  Send,
  Eye,
  Store,
  RefreshCw,
  Barcode,
  Navigation,
  UploadCloud,
  FileSpreadsheet,
  Check
} from 'lucide-react';
import * as XLSX from 'xlsx';
import LocationTransferManager from './LocationTransferManager';
import { db } from '../supabase';
import { writeBatch, doc } from '../supabase';

interface SubWarehouseManagerProps {
  warehouses: Warehouse[];
  onUpdateWarehouses: (updated: Warehouse[]) => void;
  transfers: InterWarehouseTransfer[];
  onUpdateTransfers: (updated: InterWarehouseTransfer[]) => void;
  stock: StockItem[];
  onUpdateStock: (updated: StockItem[]) => void;
  logs: DccLog[];
  onUpdateLogs: (updated: DccLog[]) => void;
  currentUser: { username: string; role: string; fullName: string } | null;
  activeWarehouseFilter: string;
  onSelectWarehouseFilter: (whId: string) => void;
  onNavigateToInventoryTab?: (whId?: string) => void;
  onBulkInternalTransfer?: (items: {
    skuId: string;
    qty: number;
    expiredDate: string;
    fromLocation: string;
    toLocation: string;
    warehouseId?: string;
    refNo?: string;
    operator?: string;
  }[]) => boolean;
  onExecuteTransferAtomic?: (newTransfer: InterWarehouseTransfer, updatedStock: StockItem[], newLogs: DccLog[]) => Promise<void>;
}

export default function SubWarehouseManager({
  warehouses,
  onUpdateWarehouses,
  transfers,
  onUpdateTransfers,
  stock,
  onUpdateStock,
  logs,
  onUpdateLogs,
  currentUser,
  activeWarehouseFilter,
  onSelectWarehouseFilter,
  onNavigateToInventoryTab,
  onBulkInternalTransfer,
  onExecuteTransferAtomic
}: SubWarehouseManagerProps) {
  // Jamin Gudang Pusat (WH-CENTRAL) selalu aktif dan tampil di seluruh daftar gudang
  const allWarehouses = useMemo(() => {
    return ensureCentralWarehouse(warehouses);
  }, [warehouses]);

  // Otomatis sinkronisasi Gudang Pusat jika belum tercatat di database
  React.useEffect(() => {
    if (!warehouses || warehouses.length === 0) {
      onUpdateWarehouses([DEFAULT_CENTRAL_WAREHOUSE]);
    } else if (!warehouses.some(w => w.isCentral || (w.id || '').toUpperCase() === 'WH-CENTRAL')) {
      onUpdateWarehouses(ensureCentralWarehouse(warehouses));
    }
  }, [warehouses, onUpdateWarehouses]);

  const [activeTab, setActiveTab] = useState<'location-transfer' | 'transfer' | 'warehouses' | 'matrix' | 'history'>('location-transfer');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState('');

  // Modals
  const [isAddWhModalOpen, setIsAddWhModalOpen] = useState(false);
  const [editingWh, setEditingWh] = useState<Warehouse | null>(null);
  const [selectedTransferForPrint, setSelectedTransferForPrint] = useState<InterWarehouseTransfer | null>(null);
  const [transferSuccessDialog, setTransferSuccessDialog] = useState<InterWarehouseTransfer | null>(null);
  const [selectedWhForStockModal, setSelectedWhForStockModal] = useState<Warehouse | null>(null);
  const [whStockModalSearch, setWhStockModalSearch] = useState('');

  // New Warehouse Form State
  const [whForm, setWhForm] = useState({
    code: '',
    name: '',
    type: 'SUB_BRANCH' as WarehouseType,
    address: '',
    city: '',
    picName: '',
    picPhone: '',
    capacityCbm: 500,
    notes: '',
    isCentral: false,
    pickingPattern: 'TRUEBLUE_DC' as PickingRoutePattern,
    aisleSequenceInput: 'E, F, D, DISPLAY'
  });

  // Transfer Form State
  const [transferSourceWh, setTransferSourceWh] = useState<string>('WH-CENTRAL');
  const [transferTargetWh, setTransferTargetWh] = useState<string>('');
  const [transferCourier, setTransferCourier] = useState('Armada Truk Internal PT DCC');
  const [transferVehiclePlate, setTransferVehiclePlate] = useState('B 9482 KDC');
  const [transferDriverName, setTransferDriverName] = useState('');
  const [transferDriverPhone, setTransferDriverPhone] = useState('');
  const [transferNotes, setTransferNotes] = useState('');
  const [transferItems, setTransferItems] = useState<InterWarehouseTransferItem[]>([]);

  // Auto-select target warehouse different from source
  React.useEffect(() => {
    if (!transferTargetWh || transferTargetWh === transferSourceWh) {
      const otherWh = allWarehouses.find(w => w.id !== transferSourceWh);
      if (otherWh) setTransferTargetWh(otherWh.id);
    }
  }, [transferSourceWh, transferTargetWh, allWarehouses]);

  // Bulk Transfer Import Modal State
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importTab, setImportTab] = useState<'upload' | 'paste'>('upload');
  const [importRawText, setImportRawText] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [importParsedItems, setImportParsedItems] = useState<{
    rawSku: string;
    qty: number;
    rawExpDate?: string;
    rawLocation?: string;
    rawTargetLocation?: string;
    notes?: string;
    matchedStock?: StockItem;
    status: 'VALID' | 'WARNING_QTY' | 'NOT_FOUND';
    statusMessage: string;
  }[]>([]);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  // Unduh File Template Excel / CSV untuk Transfer Antar Gudang
  const handleDownloadTransferTemplate = (format: 'xlsx' | 'csv' = 'xlsx') => {
    try {
      const templateData = [
        {
          'SKU ID': '8809647240012',
          'Qty (Pcs)': 10,
          'Expired Date (Opsional: DD/MM/YYYY)': '15/12/2026',
          'Lokasi Asal (Opsional)': 'E-01-01',
          'Lokasi Tujuan (Opsional)': 'RACK-STORAGE',
          'Catatan (Opsional)': 'Transfer pembukaan cabang'
        },
        {
          'SKU ID': '8809647240029',
          'Qty (Pcs)': 24,
          'Expired Date (Opsional: DD/MM/YYYY)': '20/08/2027',
          'Lokasi Asal (Opsional)': 'F-02-03',
          'Lokasi Tujuan (Opsional)': 'RACK-INBOUND',
          'Catatan (Opsional)': 'Pemerataan stok reguler'
        },
        {
          'SKU ID': '8809647240036',
          'Qty (Pcs)': 50,
          'Expired Date (Opsional: DD/MM/YYYY)': '',
          'Lokasi Asal (Opsional)': '',
          'Lokasi Tujuan (Opsional)': '',
          'Catatan (Opsional)': 'Stok cadangan'
        }
      ];

      const ws = XLSX.utils.json_to_sheet(templateData);
      ws['!cols'] = [
        { wch: 22 },
        { wch: 14 },
        { wch: 34 },
        { wch: 24 },
        { wch: 26 },
        { wch: 32 }
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Template Transfer Gudang');

      if (format === 'csv') {
        XLSX.writeFile(wb, 'Template_Transfer_Antar_Gudang.csv', { bookType: 'csv' });
      } else {
        XLSX.writeFile(wb, 'Template_Transfer_Antar_Gudang.xlsx');
      }
    } catch (err) {
      console.error('Gagal mengunduh template transfer', err);
      alert('Gagal mengunduh file template Excel.');
    }
  };

  // Item selector in transfer
  const [selectedStockForTransfer, setSelectedStockForTransfer] = useState<string>('');
  const [inputTransferQty, setInputTransferQty] = useState<number>(0);

  // Available stock items in the selected source warehouse (mendukung semua lokasi termasuk ZONE 1 & URBAN)
  const sourceStockItems = useMemo(() => {
    return stock.filter(item => {
      const itemWh = (item.warehouseId || 'WH-CENTRAL').toUpperCase();
      return itemWh === transferSourceWh.toUpperCase() && item.qty > 0;
    });
  }, [stock, transferSourceWh]);

  // Aggregate stats per warehouse
  const warehouseStats = useMemo(() => {
    const stats: Record<string, { totalSkus: number; totalPcs: number; totalCtns: number }> = {};
    allWarehouses.forEach(w => {
      stats[w.id.toUpperCase()] = { totalSkus: 0, totalPcs: 0, totalCtns: 0 };
    });

    const skuSets: Record<string, Set<string>> = {};
    stock.forEach(item => {
      const whId = (item.warehouseId || 'WH-CENTRAL').trim().toUpperCase();
      if (!stats[whId]) {
        stats[whId] = { totalSkus: 0, totalPcs: 0, totalCtns: 0 };
      }
      if (item.qty > 0) {
        (skuSets[whId] ||= new Set()).add(item.skuId.trim().toUpperCase());
        stats[whId].totalSkus = skuSets[whId].size;
        stats[whId].totalPcs += Number(item.qty) || 0;
        stats[whId].totalCtns += Number(item.qtyCtn) || 0;
      }
    });

    return stats;
  }, [allWarehouses, stock]);

  // Total summary across network
  const networkSummary = useMemo(() => {
    const totalWarehouses = allWarehouses.length;
    const activeWarehouses = allWarehouses.filter(w => w.status === 'ACTIVE').length;
    const totalPcs = stock.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const totalCapacity = allWarehouses.reduce((sum, w) => sum + (w.capacityCbm || 0), 0);
    const inTransitTransfers = transfers.filter(t => t.status === 'IN_TRANSIT').length;
    return { totalWarehouses, activeWarehouses, totalPcs, totalCapacity, inTransitTransfers };
  }, [allWarehouses, stock, transfers]);

  // Filtered warehouses
  const filteredWarehouses = useMemo(() => {
    return allWarehouses.filter(w => {
      const matchesSearch = 
        w.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        w.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
        w.city.toLowerCase().includes(searchTerm.toLowerCase()) ||
        w.picName.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesType = typeFilter === 'ALL' || w.type === typeFilter;
      return matchesSearch && matchesType;
    });
  }, [allWarehouses, searchTerm, typeFilter]);

  // Handle Save / Add Warehouse
  const handleSaveWarehouse = (e: React.FormEvent) => {
    e.preventDefault();
    if (!whForm.code.trim() || !whForm.name.trim()) {
      alert('Kode dan Nama Gudang wajib diisi!');
      return;
    }

    const cleanCode = whForm.code.trim().toUpperCase().replace(/[^A-Z0-9_\-]/g, '_');

    // Parse daftar urutan lorong/rak
    const parsedAisles = whForm.aisleSequenceInput
      .split(/[,;\s]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    const pickingRouteConfig: WarehousePickingRouteConfig = {
      pattern: whForm.pickingPattern,
      aisleSequence: parsedAisles.length > 0 ? parsedAisles : ['A', 'B', 'C'],
      customRules: ROUTE_PRESETS.find(p => p.id === whForm.pickingPattern)?.description
    };

    if (editingWh) {
      // Update existing
      const updated = warehouses.map(w => {
        if (w.id === editingWh.id) {
          return {
            ...w,
            name: whForm.name.trim(),
            type: whForm.type,
            address: whForm.address.trim(),
            city: whForm.city.trim(),
            picName: whForm.picName.trim(),
            picPhone: whForm.picPhone.trim(),
            capacityCbm: Number(whForm.capacityCbm) || 500,
            notes: whForm.notes.trim(),
            isCentral: whForm.isCentral,
            pickingRouteConfig,
            updatedAt: new Date().toISOString()
          };
        }
        return w;
      });
      onUpdateWarehouses(updated);
      setEditingWh(null);
    } else {
      // Check duplicate code
      if (warehouses.some(w => w.id === cleanCode || w.code.toUpperCase() === cleanCode)) {
        alert(`Kode Gudang "${cleanCode}" sudah terdaftar! Gunakan kode lain.`);
        return;
      }

      const newWarehouse: Warehouse = {
        id: cleanCode,
        code: cleanCode,
        name: whForm.name.trim(),
        type: whForm.type,
        address: whForm.address.trim(),
        city: whForm.city.trim() || 'Indonesia',
        picName: whForm.picName.trim() || 'Staff Logistik',
        picPhone: whForm.picPhone.trim() || '-',
        capacityCbm: Number(whForm.capacityCbm) || 500,
        status: 'ACTIVE',
        isCentral: whForm.isCentral,
        notes: whForm.notes.trim(),
        pickingRouteConfig,
        createdAt: new Date().toISOString()
      };

      onUpdateWarehouses([...warehouses, newWarehouse]);
    }

    setIsAddWhModalOpen(false);
    setWhForm({
      code: '',
      name: '',
      type: 'SUB_BRANCH',
      address: '',
      city: '',
      picName: '',
      picPhone: '',
      capacityCbm: 500,
      notes: '',
      isCentral: false,
      pickingPattern: 'TRUEBLUE_DC',
      aisleSequenceInput: 'E, F, D, DISPLAY'
    });
  };

  // Open Edit Modal
  const handleOpenEdit = (w: Warehouse) => {
    setEditingWh(w);
    setWhForm({
      code: w.code,
      name: w.name,
      type: w.type,
      address: w.address,
      city: w.city,
      picName: w.picName,
      picPhone: w.picPhone,
      capacityCbm: w.capacityCbm || 500,
      notes: w.notes || '',
      isCentral: !!w.isCentral,
      pickingPattern: (w.pickingRouteConfig?.pattern || (w.isCentral ? 'TRUEBLUE_DC' : 'LINEAR_ASC')) as PickingRoutePattern,
      aisleSequenceInput: (w.pickingRouteConfig?.aisleSequence || (w.isCentral ? ['E', 'F', 'D', 'DISPLAY'] : ['A', 'B', 'C', 'D'])).join(', ')
    });
    setIsAddWhModalOpen(true);
  };

  // Toggle Warehouse Status
  const handleToggleStatus = (id: string) => {
    const target = warehouses.find(w => w.id === id);
    if (target?.isCentral) {
      alert('Gudang Pusat (Central DC) tidak dapat dinonaktifkan.');
      return;
    }
    const updated = warehouses.map(w => {
      if (w.id === id) {
        return {
          ...w,
          status: (w.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE') as any,
          updatedAt: new Date().toISOString()
        };
      }
      return w;
    });
    onUpdateWarehouses(updated);
  };

  // Delete Warehouse (only if empty)
  const handleDeleteWarehouse = (id: string) => {
    const target = warehouses.find(w => w.id === id);
    if (target?.isCentral) {
      alert('Gudang Pusat (Central DC) tidak dapat dihapus.');
      return;
    }
    const pcsInWh = stock.filter(s => (s.warehouseId || 'WH-CENTRAL') === id).reduce((sum, i) => sum + i.qty, 0);
    if (pcsInWh > 0) {
      alert(`Gudang "${target?.name}" masih memiliki ${formatNumber(pcsInWh)} pcs stok barang. Harap transfer atau kosongkan stok sebelum menghapus gudang.`);
      return;
    }
    if (confirm(`Yakin ingin menghapus sub-gudang "${target?.name}" (${id})?`)) {
      onUpdateWarehouses(warehouses.filter(w => w.id !== id));
    }
  };

  // Add Item to Transfer List
  const handleAddItemToTransfer = () => {
    if (!selectedStockForTransfer) {
      alert('Pilih SKU dari daftar stok gudang asal!');
      return;
    }
    const stockItem = stock.find(s => s.id === selectedStockForTransfer);
    if (!stockItem) return;

    if (inputTransferQty <= 0) {
      alert('Jumlah transfer harus lebih dari 0 pcs!');
      return;
    }

    if (inputTransferQty > stockItem.qty) {
      alert(`Stok tidak mencukupi! Stok tersedia di ${stockItem.location}: ${formatNumber(stockItem.qty)} pcs.`);
      return;
    }

    // Check if already in transfer items
    const existingIdx = transferItems.findIndex(i => i.skuId === stockItem.skuId && i.expiredDate === stockItem.expiredDate && i.sourceLocation === stockItem.location);
    const { qtyCtnSize, qtyInnerSize } = getProductPackSizes(stockItem.skuId);
    const splits = calculatePackQuantities(inputTransferQty, qtyCtnSize, qtyInnerSize);

    if (existingIdx > -1) {
      const existing = transferItems[existingIdx];
      const newQty = existing.qty + inputTransferQty;
      if (newQty > stockItem.qty) {
        alert(`Total Qty transfer melebihi stok yang ada (${formatNumber(stockItem.qty)} pcs)!`);
        return;
      }
      const newSplits = calculatePackQuantities(newQty, qtyCtnSize, qtyInnerSize);
      const updated = [...transferItems];
      updated[existingIdx] = {
        ...existing,
        qty: newQty,
        qtyCtn: newSplits.qtyCtn,
        qtyInner: newSplits.qtyInner,
        qtyLoose: newSplits.qtyLoose
      };
      setTransferItems(updated);
    } else {
      setTransferItems([
        ...transferItems,
        {
          skuId: stockItem.skuId,
          skuName: stockItem.skuName,
          expiredDate: stockItem.expiredDate,
          sourceLocation: stockItem.location,
          targetLocation: 'RACK-INBOUND',
          sourceStockId: stockItem.id,
          qty: inputTransferQty,
          qtyCtn: splits.qtyCtn,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose
        }
      ]);
    }

    setInputTransferQty(0);
    setSelectedStockForTransfer('');
  };

  // Remove Item from Transfer List
  const handleRemoveTransferItem = (index: number) => {
    setTransferItems(transferItems.filter((_, idx) => idx !== index));
  };

  // Process Inter-Warehouse Transfer Execution
  const transferSubmitLock=useRef(false);
  const handleExecuteTransfer = async () => {
    if(transferSubmitLock.current)return;
    transferSubmitLock.current=true;
    try {
    console.log('Executing transfer, targetWh:', transferTargetWh, 'sourceWh:', transferSourceWh);
    if (!transferTargetWh) {
      console.error('Target warehouse not selected');
      alert('Pilih gudang tujuan terlebih dahulu!');
      return;
    }
    if (transferSourceWh === transferTargetWh) {
      alert('Gudang Asal dan Gudang Tujuan tidak boleh sama! Pilih gudang tujuan yang berbeda.');
      return;
    }

    if (transferItems.length === 0) {
      alert('Daftar barang transfer masih kosong! Masukkan minimal 1 SKU.');
      return;
    }

    if (transferItems.some(i => !Number.isSafeInteger(i.qty) || i.qty <= 0)) { alert('Jumlah transfer harus bilangan bulat lebih dari nol.'); return; }
    // Validate the aggregate demand for each exact source lot.
    const demands = new Map<string, number>();
    for (const tItem of transferItems) {
      const sourceId = getCanonicalStockId(tItem.skuId, tItem.expiredDate, tItem.sourceLocation, transferSourceWh);
      let sIdx = findStockIndex(stock, tItem.skuId, tItem.expiredDate, tItem.sourceLocation, sourceId, transferSourceWh);


      if (!Number.isSafeInteger(tItem.qty) || tItem.qty <= 0) {
        alert('Transfer ditolak: jumlah harus bulat positif.'); return;
      }
      const demand = (demands.get(sourceId) || 0) + tItem.qty;
      demands.set(sourceId,demand);
      if (sIdx === -1 || stock[sIdx].qty < demand) {
        const availableQty = stock
          .filter(s =>
            (s.warehouseId || 'WH-CENTRAL').toUpperCase() === transferSourceWh.toUpperCase() &&
            s.skuId.trim().toLowerCase() === tItem.skuId.trim().toLowerCase()
          )
          .reduce((sum, s) => sum + s.qty, 0);

        alert(`Stok tidak mencukupi untuk SKU ${tItem.skuId}! Diminta: ${tItem.qty} pcs, Tersedia: ${availableQty} pcs di gudang asal (${transferSourceWh}).`);
        return;
      }
    }

    const sourceWh = allWarehouses.find(w => w.id === transferSourceWh) || { name: transferSourceWh };
    const targetWh = allWarehouses.find(w => w.id === transferTargetWh) || { name: transferTargetWh };

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomSeq = String(Math.floor(100 + Math.random() * 900));
    const transferId = `TRF-${dateStr}-${randomSeq}`;
    const sjNumber = `SJ-MUTASI-${dateStr}-${randomSeq}`;

    const totalSkus = transferItems.length;
    const totalQty = transferItems.reduce((sum, item) => sum + item.qty, 0);

    const newTransfer: InterWarehouseTransfer = {
      id: transferId,
      transferNumber: transferId,
      suratJalanNumber: sjNumber,
      sourceWarehouseId: transferSourceWh,
      sourceWarehouseName: sourceWh.name,
      targetWarehouseId: transferTargetWh,
      targetWarehouseName: targetWh.name,
      status: 'COMPLETED', // Direct instant update to stock with receipt
      items: transferItems,
      totalSkus,
      totalQty,
      courierName: transferCourier,
      vehiclePlate: transferVehiclePlate,
      driverName: transferDriverName || 'Driver Ekspedisi DCC',
      driverPhone: transferDriverPhone || '-',
      notes: transferNotes || 'Transfer mutasi stok antar cabang',
      createdBy: currentUser?.fullName || currentUser?.username || 'admin',
      createdAt: new Date().toISOString(),
      dispatchedAt: new Date().toISOString(),
      dispatchedBy: currentUser?.fullName || 'admin',
      receivedAt: new Date().toISOString(),
      receivedBy: `${targetWh.name} Staff`
    };

    // Update Stock: Deduct from source warehouse, Add to target warehouse
    let updatedStock = [...stock];
    const newLogs: DccLog[] = [];

    transferItems.forEach(tItem => {
      // 1. Deduct from Source Warehouse
      let sIdx = -1;

      // Priority 1: Match by direct stock ID if available
      if (tItem.sourceStockId) {
        sIdx = updatedStock.findIndex(s => s.id === tItem.sourceStockId);
      }

      // Priority 2: Match by canonical ID or normalized field match
      if (sIdx === -1) {
        const sourceId = getCanonicalStockId(tItem.skuId, tItem.expiredDate, tItem.sourceLocation, transferSourceWh);
        sIdx = findStockIndex(updatedStock, tItem.skuId, tItem.expiredDate, tItem.sourceLocation, sourceId, transferSourceWh);
      }

      // Priority 3: Match by SKU and exact location in source warehouse
      if (sIdx === -1) {
        const cleanLoc = (tItem.sourceLocation || '').trim().toUpperCase().replace(/[-_\s]/g, '');
        sIdx = updatedStock.findIndex(s =>
          (s.warehouseId || 'WH-CENTRAL').toUpperCase() === transferSourceWh.toUpperCase() &&
          s.skuId.trim().toLowerCase() === tItem.skuId.trim().toLowerCase() &&
          (s.location || '').trim().toUpperCase().replace(/[-_\s]/g, '') === cleanLoc
        );
      }

      // Priority 4: Fallback match by SKU and warehouse with sufficient qty
      if (sIdx === -1) {
        sIdx = updatedStock.findIndex(s =>
          (s.warehouseId || 'WH-CENTRAL').toUpperCase() === transferSourceWh.toUpperCase() &&
          s.skuId.trim().toLowerCase() === tItem.skuId.trim().toLowerCase() &&
          s.qty >= tItem.qty
        );
      }

      // Priority 5: Fallback match by SKU and warehouse
      if (sIdx === -1) {
        sIdx = updatedStock.findIndex(s =>
          (s.warehouseId || 'WH-CENTRAL').toUpperCase() === transferSourceWh.toUpperCase() &&
          s.skuId.trim().toLowerCase() === tItem.skuId.trim().toLowerCase()
        );
      }



      if (sIdx > -1) {
        const currentItem = updatedStock[sIdx];
        const newQty = Math.max(0, currentItem.qty - tItem.qty);
        const { qtyCtnSize, qtyInnerSize } = getProductPackSizes(tItem.skuId);
        const splits = calculatePackQuantities(newQty, qtyCtnSize, qtyInnerSize);

        updatedStock[sIdx] = {
          ...currentItem,
          qty: newQty,
          qtyCtn: splits.qtyCtn,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose
        };
      }

      // 2. Add / Upsert to Target Warehouse
      const targetLoc = tItem.targetLocation || 'RACK-INBOUND';
      const targetId = getCanonicalStockId(tItem.skuId, tItem.expiredDate, targetLoc, transferTargetWh);
      const tIdx = findStockIndex(updatedStock, tItem.skuId, tItem.expiredDate, targetLoc, targetId, transferTargetWh);

      const { qtyCtnSize, qtyInnerSize } = getProductPackSizes(tItem.skuId);

      if (tIdx > -1) {
        const existingTarget = updatedStock[tIdx];
        const newQty = existingTarget.qty + tItem.qty;
        const splits = calculatePackQuantities(newQty, qtyCtnSize, qtyInnerSize);
        updatedStock[tIdx] = {
          ...existingTarget,
          warehouseId: transferTargetWh,
          warehouseName: targetWh.name,
          qty: newQty,
          qtyCtn: splits.qtyCtn,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose
        };
      } else {
        const splits = calculatePackQuantities(tItem.qty, qtyCtnSize, qtyInnerSize);
        updatedStock.push({
          id: targetId,
          skuId: tItem.skuId,
          skuName: tItem.skuName,
          expiredDate: tItem.expiredDate,
          location: targetLoc,
          warehouseId: transferTargetWh,
          warehouseName: targetWh.name,
          qty: tItem.qty,
          totalQtySku: tItem.qty,
          qtyCtnSize,
          qtyCtn: splits.qtyCtn,
          qtyInnerSize,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose,
          status: getExpiredStatus(tItem.expiredDate)
        });
      }

      // 3. Create DCC Log entry
      newLogs.push({
        id: `LOG-TRF-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        timestamp: new Date().toISOString(),
        type: 'TRANSFER',
        skuId: tItem.skuId,
        skuName: tItem.skuName,
        locationFrom: `${sourceWh.name} (${tItem.sourceLocation})`,
        locationTo: `${targetWh.name} (${targetLoc})`,
        qty: tItem.qty,
        description: `Mutasi Antar Gudang: ${sjNumber} via ${transferCourier} (${transferVehiclePlate})`,
        user: currentUser?.fullName || 'admin',
        expiredDate: tItem.expiredDate,
        warehouseId: transferSourceWh,
        warehouseName: sourceWh.name,
        targetWarehouseId: transferTargetWh,
        targetWarehouseName: targetWh.name
      });
    });

    try {
      if (onExecuteTransferAtomic) {
        await onExecuteTransferAtomic(newTransfer, updatedStock, newLogs);
      } else {
        await onUpdateStock(updatedStock);
        await onUpdateTransfers([newTransfer, ...transfers]);
        await onUpdateLogs([...newLogs, ...logs]);
      }
      
      // Reset Form
      setTransferItems([]);
      setTransferNotes('');
      setTransferDriverName('');

      // Show friendly success confirmation dialog (does not auto-hijack screen with invoice)
      setTransferSuccessDialog(newTransfer);
    } catch (e) {
      console.error('Failed to execute transfer:', e);
      const errMsg = e instanceof Error ? e.message : 'Terjadi kesalahan pada database.';
      alert('Gagal melakukan transfer! ' + errMsg);
    }
    } finally {transferSubmitLock.current=false;}
  };

  // Internal Location Transfer Handler (Fallback if not provided by parent)
  const handleInternalTransfer = (items: {
    skuId: string;
    qty: number;
    expiredDate: string;
    fromLocation: string;
    toLocation: string;
    warehouseId?: string;
    refNo?: string;
    operator?: string;
  }[]): boolean => {
    let updatedStock = [...stock];
    const newLogs: DccLog[] = [];
    const timestamp = new Date().toISOString();

    for (const item of items) {
      const formattedExpDate = normalizeDateToDmy(item.expiredDate);

      // Find source item with fallbacks
      let sourceIdx = findStockIndex(updatedStock, item.skuId, formattedExpDate, item.fromLocation, undefined, item.warehouseId);
      if (sourceIdx === -1) {
        sourceIdx = updatedStock.findIndex(s =>
          s.skuId.trim().toLowerCase() === item.skuId.trim().toLowerCase() &&
          s.location.trim().toLowerCase() === item.fromLocation.trim().toLowerCase() &&
          s.qty >= item.qty
        );
      }
      if (sourceIdx === -1) {
        sourceIdx = updatedStock.findIndex(s =>
          s.skuId.trim().toLowerCase() === item.skuId.trim().toLowerCase() &&
          s.location.trim().toLowerCase() === item.fromLocation.trim().toLowerCase()
        );
      }

      if (sourceIdx === -1 || updatedStock[sourceIdx].qty < item.qty) {
        const avail = sourceIdx > -1 ? updatedStock[sourceIdx].qty : 0;
        alert(`Stok SKU ${item.skuId} di lokasi ${item.fromLocation} tidak mencukupi (tersedia: ${avail} pcs, diminta: ${item.qty} pcs) untuk transfer internal.`);
        return false;
      }

      const srcItem = updatedStock[sourceIdx];
      const actualExpDate = srcItem.expiredDate || formattedExpDate || 'No Expired';
      const srcNewQty = Math.max(0, srcItem.qty - item.qty);
      const { qtyCtnSize, qtyInnerSize } = getProductPackSizes(item.skuId);
      const srcSplits = calculatePackQuantities(srcNewQty, srcItem.qtyCtnSize || qtyCtnSize, srcItem.qtyInnerSize || qtyInnerSize);

      updatedStock[sourceIdx] = {
        ...srcItem,
        qty: srcNewQty,
        qtyCtn: srcSplits.qtyCtn,
        qtyInner: srcSplits.qtyInner,
        qtyLoose: srcSplits.qtyLoose
      };

      // Add or merge into target location
      let targetIdx = findStockIndex(updatedStock, item.skuId, actualExpDate, item.toLocation, undefined, srcItem.warehouseId);
      if (targetIdx === -1) {
        targetIdx = updatedStock.findIndex(s =>
          s.skuId.trim().toLowerCase() === item.skuId.trim().toLowerCase() &&
          s.location.trim().toLowerCase() === item.toLocation.trim().toLowerCase() &&
          (s.expiredDate || '').trim().toLowerCase() === actualExpDate.trim().toLowerCase() &&
          (s.warehouseId || 'WH-CENTRAL').toUpperCase() === (srcItem.warehouseId || 'WH-CENTRAL').toUpperCase()
        );
      }

      if (targetIdx > -1) {
        const tarItem = updatedStock[targetIdx];
        const tarNewQty = tarItem.qty + item.qty;
        const tarSplits = calculatePackQuantities(tarNewQty, tarItem.qtyCtnSize || qtyCtnSize, tarItem.qtyInnerSize || qtyInnerSize);

        updatedStock[targetIdx] = {
          ...tarItem,
          qty: tarNewQty,
          qtyCtn: tarSplits.qtyCtn,
          qtyInner: tarSplits.qtyInner,
          qtyLoose: tarSplits.qtyLoose
        };
      } else {
        const targetId = getCanonicalStockId(item.skuId, actualExpDate, item.toLocation, srcItem.warehouseId);
        const newStatus = getExpiredStatus(actualExpDate);
        const splits = calculatePackQuantities(item.qty, srcItem.qtyCtnSize || qtyCtnSize, srcItem.qtyInnerSize || qtyInnerSize);

        updatedStock.unshift({
          id: targetId,
          skuId: item.skuId,
          skuName: srcItem.skuName,
          expiredDate: actualExpDate,
          location: item.toLocation,
          qty: item.qty,
          qtyCtnSize: srcItem.qtyCtnSize || qtyCtnSize,
          qtyCtn: splits.qtyCtn,
          qtyInnerSize: srcItem.qtyInnerSize || qtyInnerSize,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose,
          status: newStatus,
          totalQtySku: item.qty,
          warehouseId: srcItem.warehouseId,
          warehouseName: srcItem.warehouseName
        });
      }

      newLogs.push({
        id: `log_tr_loc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp,
        type: 'TRANSFER',
        skuId: item.skuId,
        skuName: srcItem.skuName,
        locationFrom: item.fromLocation,
        locationTo: item.toLocation,
        qty: item.qty,
        description: `Transfer Antar Lokasi: ${item.fromLocation} -> ${item.toLocation}`,
        user: item.operator || currentUser?.fullName || 'Operator',
        expiredDate: actualExpDate,
        warehouseId: srcItem.warehouseId,
        warehouseName: srcItem.warehouseName
      });
    }

    onUpdateStock(updatedStock);
    onUpdateLogs([...newLogs, ...logs]);
    return true;
  };

  // Export Warehouse Data to Excel
  const handleExportWarehousesToExcel = () => {
    const data = warehouses.map((w, idx) => {
      const stats = warehouseStats[w.id] || { totalSkus: 0, totalPcs: 0, totalCtns: 0 };
      return {
        'No': idx + 1,
        'Kode Gudang': w.code,
        'Nama Gudang': w.name,
        'Tipe': w.type,
        'Kota': w.city,
        'Alamat Lengkap': w.address,
        'Kepala Gudang / PIC': w.picName,
        'Kontak PIC': w.picPhone,
        'Kapasitas (m3)': w.capacityCbm || 0,
        'Total SKU': stats.totalSkus,
        'Total Stok (Pcs)': stats.totalPcs,
        'Total Karton': stats.totalCtns,
        'Status': w.status,
        'Pusat': w.isCentral ? 'YA' : 'TIDAK'
      };
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Daftar Sub Gudang');
    XLSX.writeFile(wb, `O_TWO_O_Sub_Warehouses_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // Helper untuk parsing teks copy-paste ke antrean transfer
  const handleParseRawInput = (rawText: string) => {
    setImportRawText(rawText);
    if (!rawText.trim()) {
      setImportParsedItems([]);
      return;
    }
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const parsed = lines.map(line => {
      const parts = line.split(/[\t,;]+/).map(p => p.trim()).filter(Boolean);
      const finalParts = parts.length >= 2 ? parts : line.split(/\s+/).map(p => p.trim()).filter(Boolean);
      const rawSku = (finalParts[0] || '').toUpperCase();
      const rawQty = parseInt(finalParts[1] || '0', 10);
      const rawExpDate = finalParts[2] || '';
      const rawLocation = finalParts[3] || '';
      const notes = finalParts.slice(4).join(' ') || '';

      if (!rawSku || isNaN(rawQty) || rawQty <= 0) return null;

      const candidates = sourceStockItems.filter(s => (s.skuId || '').trim().toUpperCase() === rawSku);
      const cleanRawLoc = rawLocation ? rawLocation.trim().toUpperCase().replace(/[-_\s]/g, '') : '';
      const exactLocMatched = cleanRawLoc ? candidates.find(s => s.location.trim().toUpperCase().replace(/[-_\s]/g, '') === cleanRawLoc) : undefined;
      const matched = exactLocMatched || candidates.find(s => s.qty >= rawQty) || candidates[0] || stock.find(s => (s.skuId || '').trim().toUpperCase() === rawSku);
      const chosenLoc = rawLocation || matched?.location || 'RACK-STORAGE';
      const cleanChosenLoc = chosenLoc.trim().toUpperCase().replace(/[-_\s]/g, '');

      const locCandidates = candidates.filter(s => s.location.trim().toUpperCase().replace(/[-_\s]/g, '') === cleanChosenLoc);
      const locQty = locCandidates.reduce((sum, s) => sum + s.qty, 0);
      const totalAvailableQty = candidates.reduce((sum, s) => sum + s.qty, 0);
      const availableQty = locCandidates.length > 0 ? locQty : totalAvailableQty;

      let status: 'VALID' | 'WARNING_QTY' | 'NOT_FOUND' = 'VALID';
      let statusMessage = `✓ Stok Tersedia (${formatNumber(availableQty)} Pcs)`;

      if (availableQty <= 0) {
        status = 'NOT_FOUND';
        statusMessage = `❌ Stok tidak tersedia di ${chosenLoc || transferSourceWh}`;
      } else if (availableQty < rawQty) {
        status = 'WARNING_QTY';
        statusMessage = `⚠️ Stok kurang (Tersedia ${formatNumber(availableQty)} / Diminta ${formatNumber(rawQty)})`;
      }

      return {
        rawSku,
        qty: rawQty,
        rawExpDate: rawExpDate ? normalizeDateToDmy(rawExpDate) : (exactLocMatched?.expiredDate || matched?.expiredDate || '-'),
        rawLocation: chosenLoc,
        notes,
        matchedStock: matched,
        status,
        statusMessage
      };
    }).filter(Boolean) as typeof importParsedItems;

    setImportParsedItems(parsed);
  };

  // Helper untuk membaca file Excel (.xlsx / .csv)
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[firstSheetName];
        const jsonRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (!jsonRows || jsonRows.length === 0) {
          alert('File Excel kosong atau format tabel tidak terdeteksi.');
          return;
        }

        const parsed = jsonRows.map((row: any) => {
          const keys = Object.keys(row);
          const findKey = (patterns: string[]) => keys.find(k => patterns.some(p => k.toLowerCase().includes(p)));

          const skuKey = findKey(['sku', 'kode', 'barcode', 'item']);
          const qtyKey = findKey(['qty', 'jumlah', 'kuantitas', 'pcs', 'banyak']);
          const expKey = findKey(['exp', 'ed', 'kadaluarsa', 'date']);
          const locKey = findKey(['lokasi_asal', 'asal', 'source_location', 'lokasi', 'location', 'rak']);
          const targetLocKey = findKey(['lokasi_tujuan', 'tujuan', 'target_location', 'target', 'dest', 'ke']);
          const notesKey = findKey(['catatan', 'keterangan', 'note']);

          const rawSku = (skuKey ? row[skuKey] : row[keys[0]] || '').toString().trim().toUpperCase();
          const rawQtyStr = (qtyKey ? row[qtyKey] : row[keys[1]] || '0').toString().replace(/[^0-9]/g, '');
          const qty = parseInt(rawQtyStr, 10);
          const rawExpDate = (expKey ? row[expKey] : '').toString().trim();
          const rawLocation = (locKey ? row[locKey] : '').toString().trim();
          const rawTargetLocation = (targetLocKey ? row[targetLocKey] : '').toString().trim();
          const notes = (notesKey ? row[notesKey] : '').toString().trim();

          if (!rawSku || isNaN(qty) || qty <= 0) return null;

          const candidates = sourceStockItems.filter(s => (s.skuId || '').trim().toUpperCase() === rawSku);
          const cleanRawLoc = rawLocation ? rawLocation.trim().toUpperCase().replace(/[-_\s]/g, '') : '';
          const exactLocMatched = cleanRawLoc ? candidates.find(s => s.location.trim().toUpperCase().replace(/[-_\s]/g, '') === cleanRawLoc) : undefined;
          const matched = exactLocMatched || candidates.find(s => s.qty >= qty) || candidates[0] || stock.find(s => (s.skuId || '').trim().toUpperCase() === rawSku);
          const chosenLoc = rawLocation || matched?.location || 'RACK-STORAGE';
          const cleanChosenLoc = chosenLoc.trim().toUpperCase().replace(/[-_\s]/g, '');

          const locCandidates = candidates.filter(s => s.location.trim().toUpperCase().replace(/[-_\s]/g, '') === cleanChosenLoc);
          const locQty = locCandidates.reduce((sum, s) => sum + s.qty, 0);
          const totalAvailableQty = candidates.reduce((sum, s) => sum + s.qty, 0);
          const availableQty = locCandidates.length > 0 ? locQty : totalAvailableQty;

          let status: 'VALID' | 'WARNING_QTY' | 'NOT_FOUND' = 'VALID';
          let statusMessage = `✓ Stok Tersedia (${formatNumber(availableQty)} Pcs)`;

          if (availableQty <= 0) {
            status = 'NOT_FOUND';
            statusMessage = `❌ Stok tidak tersedia di ${chosenLoc || transferSourceWh}`;
          } else if (availableQty < qty) {
            status = 'WARNING_QTY';
            statusMessage = `⚠️ Stok kurang (Tersedia ${formatNumber(availableQty)} / Diminta ${formatNumber(qty)})`;
          }

          return {
            rawSku,
            qty,
            rawExpDate: rawExpDate ? normalizeDateToDmy(rawExpDate) : (exactLocMatched?.expiredDate || matched?.expiredDate || '-'),
            rawLocation: chosenLoc,
            rawTargetLocation: rawTargetLocation || 'RACK-INBOUND',
            notes,
            matchedStock: matched,
            status,
            statusMessage
          };
        }).filter(Boolean) as typeof importParsedItems;

        setImportParsedItems(parsed);
      } catch (err) {
        console.error('Gagal membaca file Excel', err);
        alert('Gagal membaca file Excel/CSV. Pastikan format tabel sesuai.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Update pilihan lokasi asal pada baris pratinjau impor massal transfer
  const handleUpdateImportItemLocation = (itemIndex: number, newLoc: string) => {
    setImportParsedItems(prev => {
      const next = [...prev];
      if (!next[itemIndex]) return prev;
      const item = { ...next[itemIndex] };
      item.rawLocation = newLoc;

      const candidates = sourceStockItems.filter(s => (s.skuId || '').trim().toUpperCase() === item.rawSku);
      const cleanNewLoc = newLoc.trim().toUpperCase().replace(/[-_\s]/g, '');
      const exactLoc = candidates.find(s => s.location.trim().toUpperCase().replace(/[-_\s]/g, '') === cleanNewLoc);
      const matched = exactLoc || candidates[0] || item.matchedStock;
      item.matchedStock = matched;
      if (exactLoc?.expiredDate && exactLoc.expiredDate !== '-') {
        item.rawExpDate = exactLoc.expiredDate;
      }

      const locCandidates = candidates.filter(s => s.location.trim().toUpperCase().replace(/[-_\s]/g, '') === cleanNewLoc);
      const locQty = locCandidates.reduce((sum, s) => sum + s.qty, 0);
      const totalAvailableQty = candidates.reduce((sum, s) => sum + s.qty, 0);
      const availableQty = locCandidates.length > 0 ? locQty : totalAvailableQty;

      if (availableQty <= 0) {
        item.status = 'NOT_FOUND';
        item.statusMessage = `❌ Stok tidak tersedia di ${newLoc || transferSourceWh}`;
      } else if (availableQty < item.qty) {
        item.status = 'WARNING_QTY';
        item.statusMessage = `⚠️ Stok kurang (Tersedia ${formatNumber(availableQty)} / Diminta ${formatNumber(item.qty)})`;
      } else {
        item.status = 'VALID';
        item.statusMessage = `✓ Stok Tersedia (${formatNumber(availableQty)} Pcs)`;
      }

      next[itemIndex] = item;
      return next;
    });
  };

  // Masukkan item yang valid ke daftar transfer antrean
  const handleCommitImport = () => {
    const validItems = importParsedItems.filter(item => item.status !== 'NOT_FOUND');
    if (validItems.length === 0) {
      alert('Tidak ada item valid yang dapat ditambahkan.');
      return;
    }

    const newTransferItems: InterWarehouseTransferItem[] = validItems.map(item => {
      const { qtyCtnSize, qtyInnerSize } = getProductPackSizes(item.rawSku);
      const splits = calculatePackQuantities(item.qty, qtyCtnSize, qtyInnerSize);
      const pickedStock = item.matchedStock;

      return {
        skuId: pickedStock?.skuId || item.rawSku,
        skuName: pickedStock?.skuName || `${item.rawSku} Product`,
        expiredDate: item.rawExpDate || pickedStock?.expiredDate || '-',
        sourceLocation: item.rawLocation || pickedStock?.location || 'RACK-STORAGE',
        targetLocation: item.rawTargetLocation || 'RACK-INBOUND',
        sourceStockId: pickedStock?.id,
        qty: item.qty,
        qtyCtn: splits.qtyCtn,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose
      };
    });

    setTransferItems(prev => [...prev, ...newTransferItems]);
    setIsImportModalOpen(false);
    setImportRawText('');
    setImportFileName('');
    setImportParsedItems([]);
    if (importFileInputRef.current) importFileInputRef.current.value = '';
  };

  return (
    <div className="space-y-6">
      {/* Top Banner / Header */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-950/80 to-slate-900 border border-indigo-500/30 p-5 md:p-6 shadow-2xl">
        <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3.5 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-600/30 border border-indigo-500/40 text-indigo-400 shadow-inner">
              <Building2 className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-indigo-500/20 text-indigo-400 border border-indigo-500/40">
                  Multi-Warehouse Network
                </span>
                <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Realtime Sync
                </span>
              </div>
              <h1 className="text-xl md:text-2xl font-black text-white tracking-tight mt-1">
                Sistem Manajemen Sub-Gudang & Cabang
              </h1>
              <p className="text-xs md:text-sm text-slate-400 mt-0.5">
                Kelola multi-lokasi gudang pusat & regional, monitor stok per cabang, serta buat Surat Jalan transfer antar gudang resmi.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
            <button
              onClick={() => {
                setEditingWh(null);
                setWhForm({
                  code: '',
                  name: '',
                  type: 'SUB_BRANCH',
                  address: '',
                  city: '',
                  picName: '',
                  picPhone: '',
                  capacityCbm: 500,
                  notes: '',
                  isCentral: false,
                  pickingPattern: 'TRUEBLUE_DC',
                  aisleSequenceInput: 'E, F, D, DISPLAY'
                });
                setIsAddWhModalOpen(true);
              }}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-xs font-bold shadow-lg shadow-indigo-600/30 transition-all cursor-pointer active:scale-95"
            >
              <Plus className="w-4 h-4" />
              <span>Tambah Sub-Gudang</span>
            </button>

            <button
              onClick={() => setActiveTab('transfer')}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-200 text-xs font-bold shadow-md transition-all cursor-pointer active:scale-95"
            >
              <ArrowLeftRight className="w-4 h-4 text-emerald-400" />
              <span>Transfer Antar Gudang</span>
            </button>

            <button
              onClick={() => handleDownloadTransferTemplate('xlsx')}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-emerald-400 hover:text-emerald-300 text-xs font-bold transition-all cursor-pointer"
              title="Unduh Template Excel untuk Transfer Antar Gudang"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Template Transfer</span>
            </button>

            <button
              onClick={handleExportWarehousesToExcel}
              className="p-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-300 hover:text-white transition-all cursor-pointer"
              title="Download Data Gudang Excel"
            >
              <Download className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Global Summary Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-5 border-t border-slate-800/80">
          <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
              Jaringan Gudang
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-black text-white">{networkSummary.totalWarehouses}</span>
              <span className="text-xs text-emerald-400 font-bold">({networkSummary.activeWarehouses} Aktif)</span>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
              Total Stok Tersebar
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-black text-emerald-400">{formatNumber(networkSummary.totalPcs)}</span>
              <span className="text-xs text-slate-400 font-bold">pcs</span>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
              Total Kapasitas Ruang
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-black text-indigo-400">{formatNumber(networkSummary.totalCapacity)}</span>
              <span className="text-xs text-slate-400 font-bold">m³</span>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
              Mutasi / Transfer
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-black text-amber-400">{transfers.length}</span>
              <span className="text-xs text-slate-400 font-bold">transaksi</span>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3 overflow-x-auto scrollbar-none">
        <button
          onClick={() => setActiveTab('location-transfer')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
            activeTab === 'location-transfer'
              ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg shadow-emerald-600/20'
              : 'bg-slate-900/60 text-slate-400 hover:text-slate-200 border-slate-800 hover:bg-slate-800/60'
          }`}
        >
          <Layers className="w-4 h-4 text-emerald-300" />
          <span>Transfer Antar Lokasi (Rak ke Rak)</span>
        </button>

        <button
          onClick={() => setActiveTab('transfer')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
            activeTab === 'transfer'
              ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900/60 text-slate-400 hover:text-slate-200 border-slate-800 hover:bg-slate-800/60'
          }`}
        >
          <ArrowLeftRight className="w-4 h-4 text-indigo-300" />
          <span>Transfer Antar Gudang (Cabang)</span>
        </button>

        <button
          onClick={() => setActiveTab('warehouses')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
            activeTab === 'warehouses'
              ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900/60 text-slate-400 hover:text-slate-200 border-slate-800 hover:bg-slate-800/60'
          }`}
        >
          <Building2 className="w-4 h-4" />
          <span>Daftar Sub-Gudang ({warehouses.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('matrix')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
            activeTab === 'matrix'
              ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900/60 text-slate-400 hover:text-slate-200 border-slate-800 hover:bg-slate-800/60'
          }`}
        >
          <Boxes className="w-4 h-4" />
          <span>Matriks Stok Antar Cabang</span>
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
            activeTab === 'history'
              ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900/60 text-slate-400 hover:text-slate-200 border-slate-800 hover:bg-slate-800/60'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>Riwayat Mutasi Antar Gudang ({transfers.length})</span>
        </button>
      </div>

      {/* TAB 0: TRANSFER ANTAR LOKASI (INTERNAL RAK KE RAK) */}
      {activeTab === 'location-transfer' && (
        <LocationTransferManager 
          stock={stock}
          logs={logs}
          onBulkInternalTransfer={onBulkInternalTransfer || handleInternalTransfer}
          currentUser={currentUser}
        />
      )}

      {/* TAB 1: DAFTAR SUB-GUDANG */}
      {activeTab === 'warehouses' && (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/60 border border-slate-800 p-3 rounded-2xl">
            <div className="relative w-full sm:w-80">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Cari kode gudang, nama, kota, PIC..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto scrollbar-none">
              <span className="text-xs text-slate-400 font-semibold flex items-center gap-1 shrink-0">
                <Filter className="w-3.5 h-3.5" />
                Tipe:
              </span>
              {[
                { id: 'ALL', label: 'Semua Tipe' },
                { id: 'CENTRAL', label: 'Gudang Pusat' },
                { id: 'SUB_BRANCH', label: 'Sub-Gudang Cabang' },
                { id: 'RETAIL', label: 'Toko / Display' },
                { id: 'TRANSIT', label: 'Transit / Retur' }
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setTypeFilter(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
                    typeFilter === f.id
                      ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Warehouse Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredWarehouses.map(wh => {
              const stats = warehouseStats[wh.id] || { totalSkus: 0, totalPcs: 0, totalCtns: 0 };
              const isSelected = activeWarehouseFilter === wh.id;

              return (
                <div
                  key={wh.id}
                  className={`relative rounded-2xl border transition-all duration-200 overflow-hidden flex flex-col justify-between ${
                    isSelected
                      ? 'bg-gradient-to-b from-indigo-950/40 to-slate-900 border-indigo-500 shadow-xl shadow-indigo-500/10 ring-1 ring-indigo-500'
                      : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  {/* Top Header Card */}
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-2.5 py-1 rounded-lg text-xs font-black uppercase tracking-wider border ${
                          wh.isCentral
                            ? 'bg-amber-500/15 text-amber-400 border-amber-500/40'
                            : wh.type === 'RETAIL'
                            ? 'bg-purple-500/15 text-purple-400 border-purple-500/40'
                            : wh.type === 'TRANSIT'
                            ? 'bg-rose-500/15 text-rose-400 border-rose-500/40'
                            : 'bg-indigo-500/15 text-indigo-400 border-indigo-500/40'
                        }`}>
                          {wh.code}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-400">
                          {wh.type === 'CENTRAL' ? 'DC Pusat' : wh.type === 'RETAIL' ? 'Display / Toko' : wh.type === 'TRANSIT' ? 'Karantina' : 'Cabang Regional'}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleToggleStatus(wh.id)}
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors cursor-pointer ${
                            wh.status === 'ACTIVE'
                              ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
                              : 'bg-slate-800 text-slate-400 border-slate-700'
                          }`}
                        >
                          {wh.status === 'ACTIVE' ? 'Aktif' : 'Non-Aktif'}
                        </button>
                      </div>
                    </div>

                    <h3 className="text-base font-extrabold text-white mb-1.5 flex items-center gap-2">
                      {wh.name}
                      {wh.isCentral && <span className="text-xs text-amber-400 font-black">★ PUSAT</span>}
                    </h3>

                    <p className="text-xs text-slate-400 flex items-start gap-1.5 line-clamp-2 mb-4">
                      <MapPin className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
                      <span>{wh.address}, <strong className="text-slate-300">{wh.city}</strong></span>
                    </p>

                    {/* Stock Metrics Bar */}
                    <div className="grid grid-cols-3 gap-2 p-3 rounded-xl bg-slate-950/70 border border-slate-800/80 mb-4">
                      <div>
                        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">SKU</span>
                        <span className="text-sm font-black text-white">{formatNumber(stats.totalSkus)}</span>
                      </div>
                      <div>
                        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Total Pcs</span>
                        <span className="text-sm font-black text-emerald-400">{formatNumber(stats.totalPcs)}</span>
                      </div>
                      <div>
                        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Kapasitas</span>
                        <span className="text-sm font-black text-indigo-400">{wh.capacityCbm || 0} m³</span>
                      </div>
                    </div>

                    {/* PIC & Contact */}
                    <div className="flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/70 pt-3">
                      <div className="flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-slate-500" />
                        <span>PIC: <strong className="text-slate-300">{wh.picName}</strong></span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-400">
                        <Phone className="w-3.5 h-3.5 text-slate-500" />
                        <span>{wh.picPhone}</span>
                      </div>
                    </div>

                    {/* Picking Route Badge */}
                    <div className="mt-3 px-3 py-2 rounded-xl bg-indigo-950/40 border border-indigo-500/20 text-[11px] flex items-center justify-between gap-2">
                      <span className="text-slate-400 flex items-center gap-1 font-semibold shrink-0">
                        <Navigation className="w-3.5 h-3.5 text-indigo-400" />
                        Alur Picking:
                      </span>
                      <span className="font-bold text-indigo-300 font-mono text-[10px] truncate" title={describeRouteConfig(wh.pickingRouteConfig)}>
                        {describeRouteConfig(wh.pickingRouteConfig)}
                      </span>
                    </div>
                  </div>

                  {/* Bottom Action Footer */}
                  <div className="bg-slate-950/80 border-t border-slate-800/80 px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setSelectedWhForStockModal(wh)}
                        className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 transition-all cursor-pointer shadow-sm active:scale-95"
                        title="Lihat rincian seluruh stok barang di gudang ini"
                      >
                        <Package className="w-3.5 h-3.5" />
                        <span>Lihat Stok ({formatNumber(stats.totalPcs)})</span>
                      </button>

                      <button
                        onClick={() => {
                          onSelectWarehouseFilter(wh.id);
                          if (onNavigateToInventoryTab) {
                            onNavigateToInventoryTab(wh.id);
                          }
                        }}
                        className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                            : 'bg-slate-800/70 text-slate-300 hover:text-white hover:bg-slate-700'
                        }`}
                        title="Buka dan filter gudang ini di menu Stok Barang"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>{isSelected ? 'Aktif' : 'Pilih'}</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setTransferSourceWh(wh.id);
                          setTransferItems([]);
                          setSelectedStockForTransfer('');
                          const otherWh = allWarehouses.find(w => w.id !== wh.id);
                          if (otherWh) setTransferTargetWh(otherWh.id);
                          setActiveTab('transfer');
                        }}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-slate-800 transition-colors cursor-pointer"
                        title="Buat Mutasi Keluar dari Gudang ini"
                      >
                        <ArrowLeftRight className="w-4 h-4" />
                      </button>

                      <button
                        onClick={() => handleOpenEdit(wh)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-400 hover:bg-slate-800 transition-colors cursor-pointer"
                        title="Edit Info Gudang"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>

                      {!wh.isCentral && (
                        <button
                          onClick={() => handleDeleteWarehouse(wh.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors cursor-pointer"
                          title="Hapus Sub-Gudang"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: TRANSFER ANTAR SUB-GUDANG */}
      {activeTab === 'transfer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Form: Route & Dispatch Details */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-2xl space-y-4 shadow-xl">
              <h2 className="text-base font-extrabold text-white flex items-center gap-2">
                <Truck className="w-5 h-5 text-indigo-400" />
                <span>Pilih Gudang Asal & Tujuan Transfer</span>
              </h2>

              <div className="space-y-3">
                {/* Source Warehouse */}
                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                    Gudang Asal (Pengirim)
                  </label>
                  <select
                    value={transferSourceWh}
                    onChange={e => {
                      const newSource = e.target.value;
                      setTransferSourceWh(newSource);
                      setTransferItems([]);
                      setSelectedStockForTransfer('');
                      if (transferTargetWh === newSource || !transferTargetWh) {
                        const otherWh = allWarehouses.find(w => w.id !== newSource);
                        if (otherWh) setTransferTargetWh(otherWh.id);
                      }
                    }}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-semibold text-white focus:outline-none focus:border-indigo-500"
                  >
                    {allWarehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.code} - {w.name} {w.isCentral ? '(★ PUSAT)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Target Warehouse */}
                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                    Gudang Tujuan (Penerima)
                  </label>
                  <select
                    value={transferTargetWh}
                    onChange={e => setTransferTargetWh(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-semibold text-white focus:outline-none focus:border-indigo-500"
                  >
                    {allWarehouses.map(w => (
                      <option key={w.id} value={w.id} disabled={w.id === transferSourceWh}>
                        {w.code} - {w.name} {w.isCentral ? '(★ PUSAT)' : ''} {w.id === transferSourceWh ? '(Asal)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  Catatan / Keterangan Transfer
                </label>
                <textarea
                  rows={2}
                  value={transferNotes}
                  onChange={e => setTransferNotes(e.target.value)}
                  placeholder="Drop stok pembukaan cabang / pemerataan stok reguler..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              {/* Execution Button */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleExecuteTransfer}
                  disabled={transferItems.length === 0}
                  className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
                    transferItems.length > 0
                      ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-lg shadow-emerald-600/30 active:scale-98'
                      : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  <Send className="w-4 h-4" />
                  <span>Transfer Stok Sekarang</span>
                </button>
              </div>
            </div>
          </div>

          {/* Right Panel: Item Selector and Staging Table */}
          <div className="lg:col-span-7 space-y-4">
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-2xl space-y-4 shadow-xl">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-extrabold text-white flex items-center gap-2">
                  <Package className="w-5 h-5 text-indigo-400" />
                  <span>Daftar Barang Transfer (SKU)</span>
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDownloadTransferTemplate('xlsx')}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 font-bold rounded-lg text-[10px] border border-emerald-500/30 transition-all cursor-pointer"
                    title="Unduh Template Excel untuk Transfer Antar Gudang"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Unduh Template (.xlsx)
                  </button>
                  <button
                    onClick={() => {
                      setIsImportModalOpen(true);
                      setImportParsedItems([]);
                      setImportFileName('');
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 font-bold rounded-lg text-[10px] border border-indigo-500/30 transition-all cursor-pointer"
                  >
                    <UploadCloud className="w-3.5 h-3.5" />
                    Impor SKU (Excel/CSV)
                  </button>
                  <span className="text-xs font-bold text-indigo-400 bg-indigo-500/10 px-2.5 py-1 rounded-lg border border-indigo-500/20">
                    {transferItems.length} SKU Dipilih
                  </span>
                </div>
              </div>

              {/* Add Item Form Bar */}
              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/90 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                  <div className="sm:col-span-7">
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                      Pilih SKU dari Stok {allWarehouses.find(w => w.id === transferSourceWh)?.name || transferSourceWh}
                    </label>
                    <select
                      value={selectedStockForTransfer}
                      onChange={e => setSelectedStockForTransfer(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">-- Pilih Barang di Gudang Asal ({sourceStockItems.length} Tersedia) --</option>
                      {sourceStockItems.map(item => (
                        <option key={item.id} value={item.id}>
                          {item.skuId} | {item.skuName.slice(0, 32)}... | Lok: {item.location} | ED: {item.expiredDate} | Sisa: {item.qty} pcs
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sm:col-span-3">
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                      Qty Transfer (Pcs)
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={inputTransferQty || ''}
                      onChange={e => setInputTransferQty(Math.max(0, parseInt(e.target.value) || 0))}
                      placeholder="Jumlah pcs"
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white font-bold text-emerald-400 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <button
                      type="button"
                      onClick={handleAddItemToTransfer}
                      className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1 active:scale-95"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Tambah</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Items Staging Table */}
              <div className="border border-slate-800 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 font-bold border-b border-slate-800">
                    <tr>
                      <th className="p-3">SKU & Nama Produk</th>
                      <th className="p-3">Expired Date</th>
                      <th className="p-3">Lokasi Asal ({allWarehouses.find(w => w.id === transferSourceWh)?.code || 'Asal'})</th>
                      <th className="p-3">Lokasi Tujuan ({allWarehouses.find(w => w.id === transferTargetWh)?.code || 'Tujuan'})</th>
                      <th className="p-3 text-right">Qty (Pcs)</th>
                      <th className="p-3 text-center">Konversi Pack</th>
                      <th className="p-3 text-center">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                    {transferItems.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-8 text-center text-slate-500 font-medium">
                          Belum ada barang yang dimasukkan. Pilih SKU di atas lalu klik "Tambah".
                        </td>
                      </tr>
                    ) : (
                      transferItems.map((item, idx) => {
                        const skuUpper = (item.skuId || '').trim().toUpperCase();
                        let availableLocationsForSku = sourceStockItems.filter(
                          s => (s.skuId || '').trim().toUpperCase() === skuUpper && s.qty > 0
                        );
                        if (availableLocationsForSku.length === 0) {
                          availableLocationsForSku = stock.filter(
                            s => (s.warehouseId || 'WH-CENTRAL').toUpperCase() === transferSourceWh.toUpperCase() &&
                                 (s.skuId || '').trim().toUpperCase() === skuUpper && s.qty > 0
                          );
                        }

                        const exactMatch = availableLocationsForSku.find(
                          s => s.location === item.sourceLocation && s.expiredDate === item.expiredDate
                        );
                        const locationOnlyMatch = availableLocationsForSku.find(
                          s => s.location === item.sourceLocation
                        );
                        const activeMatch = exactMatch || locationOnlyMatch;
                        const selectValue = activeMatch
                          ? `${activeMatch.location}|||${activeMatch.expiredDate}`
                          : `${item.sourceLocation}|||${item.expiredDate}`;

                        return (
                          <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                            <td className="p-3">
                              <span className="font-mono font-bold text-indigo-400">{item.skuId}</span>
                              <p className="text-white font-semibold line-clamp-1">{item.skuName}</p>
                            </td>
                            <td className="p-3 font-mono text-slate-300">{item.expiredDate}</td>
                            <td className="p-3">
                              <select
                                value={selectValue}
                                onChange={(e) => {
                                  const [selectedLoc, selectedEd] = e.target.value.split('|||');
                                  const matchedStock =
                                    availableLocationsForSku.find(
                                      s => s.location === selectedLoc && s.expiredDate === selectedEd
                                    ) || availableLocationsForSku.find(s => s.location === selectedLoc);

                                  const newItems = [...transferItems];
                                  newItems[idx] = {
                                    ...newItems[idx],
                                    sourceLocation: selectedLoc,
                                    expiredDate: matchedStock
                                      ? matchedStock.expiredDate
                                      : selectedEd || newItems[idx].expiredDate
                                  };
                                  setTransferItems(newItems);
                                }}
                                className="px-2.5 py-1.5 rounded-lg bg-slate-950 text-white font-mono text-[11px] font-bold border border-indigo-500/40 hover:border-indigo-400 focus:border-indigo-400 outline-none cursor-pointer w-full max-w-[240px]"
                              >
                                {!activeMatch && (
                                  <option value={`${item.sourceLocation}|||${item.expiredDate}`}>
                                    {item.sourceLocation || 'Pilih Lokasi'} (Stok: 0 pcs)
                                  </option>
                                )}
                                {availableLocationsForSku.map((s, sIdx) => (
                                  <option key={`${s.id}-${sIdx}`} value={`${s.location}|||${s.expiredDate}`}>
                                    {s.location} — Stok: {formatNumber(s.qty)} pcs (ED: {s.expiredDate})
                                  </option>
                                ))}
                              </select>
                              <div className="flex items-center gap-1.5 mt-1">
                                {activeMatch ? (
                                  <span
                                    className={`text-[10px] font-mono font-semibold ${
                                      item.qty > activeMatch.qty ? 'text-rose-400' : 'text-emerald-400/90'
                                    }`}
                                  >
                                    Sisa stok: {formatNumber(activeMatch.qty)} pcs
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-rose-400 font-semibold">
                                    Stok tidak tersedia di lokasi ini
                                  </span>
                                )}
                                {availableLocationsForSku.length > 1 && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-bold border border-indigo-500/30">
                                    {availableLocationsForSku.length} lokasi tersedia
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="p-3">
                              <input
                                type="text"
                                value={item.targetLocation || 'RACK-INBOUND'}
                                onChange={(e) => {
                                  const newItems = [...transferItems];
                                  newItems[idx] = {
                                    ...newItems[idx],
                                    targetLocation: e.target.value.toUpperCase().trim() || 'RACK-INBOUND'
                                  };
                                  setTransferItems(newItems);
                                }}
                                placeholder="RACK-INBOUND"
                                className="px-2 py-1.5 bg-slate-950 border border-slate-700 hover:border-indigo-500 focus:border-indigo-500 rounded-lg text-xs font-mono text-white outline-none w-28 uppercase"
                              />
                            </td>
                            <td className="p-3 text-right font-black text-emerald-400 text-sm">
                              {formatNumber(item.qty)}
                            </td>
                            <td className="p-3 text-center text-[10px] text-slate-400 font-mono">
                              {item.qtyCtn || 0} CTN + {item.qtyInner || 0} In + {item.qtyLoose || 0} Ls
                            </td>
                            <td className="p-3 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveTransferItem(idx)}
                                className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors cursor-pointer"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Total Summary Footer */}
              {transferItems.length > 0 && (
                <div className="flex items-center justify-between p-3.5 bg-slate-950/70 border border-slate-800 rounded-xl">
                  <span className="text-xs text-slate-400 font-bold">
                    Total: <strong className="text-white">{transferItems.length} SKU</strong>
                  </span>
                  <span className="text-xs text-slate-400 font-bold">
                    Total Qty Transfer:{' '}
                    <strong className="text-emerald-400 text-sm">
                      {formatNumber(transferItems.reduce((sum, i) => sum + i.qty, 0))} pcs
                    </strong>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: MATRIKS STOK ANTAR CABANG */}
      {activeTab === 'matrix' && (
        <div className="space-y-4">
          <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-3">
            <h2 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Boxes className="w-4 h-4 text-indigo-400" />
              <span>Peta Distribusi Stok per SKU di Semua Gudang</span>
            </h2>
            <div className="relative w-full sm:w-72">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Cari SKU atau Nama..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Matrix Table */}
          <div className="border border-slate-800 rounded-2xl overflow-hidden bg-slate-900/60 overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-950 text-slate-400 font-bold border-b border-slate-800">
                <tr>
                  <th className="p-3.5 sticky left-0 bg-slate-950 z-10 w-64">SKU & Nama Produk</th>
                  <th className="p-3.5 text-center bg-slate-950/90 font-black text-white border-r border-slate-800">
                    Total Global
                  </th>
                  {allWarehouses.map(w => (
                    <th key={w.id} className="p-3 text-center min-w-[130px] border-r border-slate-800/80">
                      <span className="text-[10px] uppercase font-black text-indigo-400 block">{w.code}</span>
                      <span className="text-slate-300 font-semibold text-[11px] truncate block max-w-[140px]">
                        {w.city} {w.isCentral ? '(PUSAT)' : ''}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {Array.from(new Set(stock.map(s => s.skuId)))
                  .filter(sku => {
                    const sample = stock.find(s => s.skuId === sku);
                    return (
                      sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
                      (sample?.skuName || '').toLowerCase().includes(searchTerm.toLowerCase())
                    );
                  })
                  .slice(0, 50)
                  .map(sku => {
                    const sample = stock.find(s => s.skuId === sku);
                    const globalQty = stock.filter(s => s.skuId === sku).reduce((sum, i) => sum + i.qty, 0);

                    return (
                      <tr key={sku} className="hover:bg-slate-800/40 transition-colors">
                        <td className="p-3.5 sticky left-0 bg-slate-900/95 z-10 border-r border-slate-800">
                          <span className="font-mono font-bold text-indigo-400">{sku}</span>
                          <p className="text-white font-semibold line-clamp-1 text-[11px]">
                            {sample?.skuName || `${sku} Product`}
                          </p>
                        </td>

                        <td className="p-3.5 text-center font-black text-emerald-400 text-sm bg-slate-950/40 border-r border-slate-800">
                          {formatNumber(globalQty)}
                        </td>

                        {allWarehouses.map(w => {
                          const whQty = stock
                            .filter(s => s.skuId === sku && (s.warehouseId || 'WH-CENTRAL').toUpperCase() === w.id.toUpperCase())
                            .reduce((sum, i) => sum + i.qty, 0);

                          return (
                            <td
                              key={w.id}
                              className={`p-3 text-center font-mono border-r border-slate-800/60 ${
                                whQty > 0 ? 'text-white font-bold' : 'text-slate-600'
                              }`}
                            >
                              {whQty > 0 ? formatNumber(whQty) : '-'}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: HISTORI SURAT JALAN MUTASI */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-3">
            <h2 className="text-sm font-extrabold text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-indigo-400" />
              <span>Semua Histori Surat Jalan & Mutasi Antar Gudang</span>
            </h2>
          </div>

          <div className="border border-slate-800 rounded-2xl overflow-hidden bg-slate-900/60">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400 font-bold border-b border-slate-800">
                <tr>
                  <th className="p-3.5">No. Surat Jalan</th>
                  <th className="p-3.5">Tanggal</th>
                  <th className="p-3.5">Rute Gudang</th>
                  <th className="p-3.5">Kurir & Armada</th>
                  <th className="p-3.5 text-center">Total SKU</th>
                  <th className="p-3.5 text-right">Total Qty (Pcs)</th>
                  <th className="p-3.5 text-center">Status</th>
                  <th className="p-3.5 text-center">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {transfers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-slate-500 font-medium">
                      Belum ada riwayat mutasi antar gudang.
                    </td>
                  </tr>
                ) : (
                  transfers.map(trf => (
                    <tr key={trf.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="p-3.5">
                        <span className="font-mono font-bold text-indigo-400">{trf.suratJalanNumber}</span>
                        <p className="text-[10px] text-slate-500 font-mono">{trf.transferNumber}</p>
                      </td>
                      <td className="p-3.5 text-slate-300 font-mono text-[11px]">
                        {new Date(trf.createdAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="p-3.5">
                        <div className="flex items-center gap-1.5 font-bold text-white text-[11px]">
                          <span className="text-slate-300">{trf.sourceWarehouseName}</span>
                          <ChevronRight className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                          <span className="text-indigo-400">{trf.targetWarehouseName}</span>
                        </div>
                      </td>
                      <td className="p-3.5">
                        <span className="text-slate-300 font-semibold block">{trf.courierName}</span>
                        <span className="text-[10px] text-slate-500 font-mono">
                          {trf.vehiclePlate} {trf.driverName ? `• ${trf.driverName}` : ''}
                        </span>
                      </td>
                      <td className="p-3.5 text-center font-bold text-white">{trf.totalSkus}</td>
                      <td className="p-3.5 text-right font-black text-emerald-400 text-sm">
                        {formatNumber(trf.totalQty)}
                      </td>
                      <td className="p-3.5 text-center">
                        <span className="px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                          {trf.status === 'RECEIVED' || trf.status === 'COMPLETED' ? 'DITERIMA' : trf.status}
                        </span>
                      </td>
                      <td className="p-3.5 text-center">
                        <button
                          onClick={() => setSelectedTransferForPrint(trf)}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600 hover:text-white border border-indigo-500/30 text-xs font-bold transition-all cursor-pointer mx-auto"
                        >
                          <Printer className="w-3.5 h-3.5" />
                          <span>Cetak SJ</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: TAMBAH / EDIT SUB-GUDANG */}
      {isAddWhModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-lg p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                  <Building2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-black text-white">
                    {editingWh ? 'Edit Data Sub-Gudang' : 'Tambah Sub-Gudang Baru'}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Masukkan kode unik, alamat, dan penanggung jawab cabang gudang.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsAddWhModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveWarehouse} className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Kode Gudang (Unique)
                  </label>
                  <input
                    type="text"
                    required
                    disabled={!!editingWh}
                    value={whForm.code}
                    onChange={e => setWhForm({ ...whForm, code: e.target.value.toUpperCase() })}
                    placeholder="Contoh: WH-SUB-YGY"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono font-bold text-white uppercase focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Tipe Gudang
                  </label>
                  <select
                    value={whForm.type}
                    onChange={e => setWhForm({ ...whForm, type: e.target.value as WarehouseType })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-semibold text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="SUB_BRANCH">Sub-Gudang Cabang</option>
                    <option value="CENTRAL">Gudang Pusat (Central DC)</option>
                    <option value="RETAIL">Toko / Outlet Display</option>
                    <option value="TRANSIT">Transit & Karantina Retur</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  Nama Gudang / Cabang
                </label>
                <input
                  type="text"
                  required
                  value={whForm.name}
                  onChange={e => setWhForm({ ...whForm, name: e.target.value })}
                  placeholder="Contoh: Sub Gudang Yogyakarta (Jawa Tengah)"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Kota / Wilayah
                  </label>
                  <input
                    type="text"
                    required
                    value={whForm.city}
                    onChange={e => setWhForm({ ...whForm, city: e.target.value })}
                    placeholder="Contoh: Yogyakarta"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Kapasitas Ruang (m³)
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={whForm.capacityCbm}
                    onChange={e => setWhForm({ ...whForm, capacityCbm: parseInt(e.target.value) || 0 })}
                    placeholder="Contoh: 600"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  Alamat Lengkap
                </label>
                <textarea
                  rows={2}
                  required
                  value={whForm.address}
                  onChange={e => setWhForm({ ...whForm, address: e.target.value })}
                  placeholder="Nama jalan, nomor gudang, kompleks industri/pergudangan..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Kepala Gudang / PIC
                  </label>
                  <input
                    type="text"
                    required
                    value={whForm.picName}
                    onChange={e => setWhForm({ ...whForm, picName: e.target.value })}
                    placeholder="Nama PIC Cabang"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    No Telepon / WhatsApp
                  </label>
                  <input
                    type="text"
                    required
                    value={whForm.picPhone}
                    onChange={e => setWhForm({ ...whForm, picPhone: e.target.value })}
                    placeholder="0812-xxxx-xxxx"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  Catatan Tambahan
                </label>
                <input
                  type="text"
                  value={whForm.notes}
                  onChange={e => setWhForm({ ...whForm, notes: e.target.value })}
                  placeholder="Catatan akses truk kontainer, jam operasional, dll."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Seksi Pengaturan Alur Rute Picking Rak */}
              <div className="bg-indigo-950/20 border border-indigo-500/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-indigo-300 flex items-center gap-1.5 uppercase tracking-wide">
                    <Navigation className="w-4 h-4 text-indigo-400" />
                    Pengaturan Alur Rute Picking Rak
                  </span>
                  <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full font-bold">
                    Khusus Gudang Ini
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Tentukan bagaimana picker akan bergerak mengambil barang di rak gudang ini untuk meminimalkan waktu jalan operator.
                </p>

                <div>
                  <label className="text-[11px] font-bold text-slate-300 block mb-1">
                    Pilih Pola Alur Rute
                  </label>
                  <select
                    value={whForm.pickingPattern}
                    onChange={e => {
                      const pattern = e.target.value as PickingRoutePattern;
                      const preset = ROUTE_PRESETS.find(p => p.id === pattern);
                      setWhForm({
                        ...whForm,
                        pickingPattern: pattern,
                        aisleSequenceInput: preset ? preset.defaultAisles.join(', ') : whForm.aisleSequenceInput
                      });
                    }}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 font-bold"
                  >
                    {ROUTE_PRESETS.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-indigo-300/80 mt-1">
                    {ROUTE_PRESETS.find(p => p.id === whForm.pickingPattern)?.description}
                  </p>
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-300 block mb-1">
                    Daftar Lorong / Urutan Rak (Pisahkan dengan koma)
                  </label>
                  <input
                    type="text"
                    value={whForm.aisleSequenceInput}
                    onChange={e => setWhForm({ ...whForm, aisleSequenceInput: e.target.value.toUpperCase() })}
                    placeholder="Contoh: A, B, C, D atau E, F, D, DISPLAY"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono font-bold"
                  />
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    Barang pada rak yang berada di urutan lebih awal akan dipick terlebih dahulu oleh operator picker.
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAddWhModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-400 hover:text-white bg-slate-800/80 hover:bg-slate-700 transition-colors cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all cursor-pointer active:scale-95"
                >
                  {editingWh ? 'Simpan Perubahan' : 'Tambah Gudang'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL CETAK SURAT JALAN RESMI (PRINTABLE VIEW) */}
      {selectedTransferForPrint && (
        <div 
          className="fixed inset-0 z-50 flex items-start justify-center p-4 md:p-6 bg-black/90 backdrop-blur-md animate-in fade-in overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedTransferForPrint(null);
            }
          }}
        >
          {/* Floating Close Button for Instant Exit */}
          <button
            onClick={() => setSelectedTransferForPrint(null)}
            className="fixed top-4 right-4 z-60 p-3 rounded-full bg-slate-800/90 text-white hover:bg-rose-600 transition-all shadow-2xl cursor-pointer print:hidden"
            title="Tutup Surat Jalan (Esc)"
          >
            <X className="w-6 h-6" />
          </button>

          <div 
            onClick={(e) => e.stopPropagation()}
            className="bg-white text-slate-900 rounded-3xl w-full max-w-4xl p-6 md:p-8 shadow-2xl relative my-6 print:p-0 print:m-0 print:shadow-none print:w-full print:max-w-none"
          >
            {/* Top Toolbar (Sticky, Hidden on print) */}
            <div className="sticky top-0 bg-white/95 backdrop-blur-xs z-30 flex items-center justify-between pb-4 mb-6 border-b border-slate-200 print:hidden">
              <div className="flex items-center gap-2">
                <Printer className="w-5 h-5 text-indigo-600" />
                <span className="text-sm font-black text-slate-900">
                  Pratinjau Dokumen: <span className="font-mono text-indigo-600">{selectedTransferForPrint.suratJalanNumber}</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-md transition-all cursor-pointer active:scale-95"
                >
                  <Printer className="w-4 h-4" />
                  <span>Cetak / Simpan PDF</span>
                </button>
                <button
                  onClick={() => setSelectedTransferForPrint(null)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition-colors cursor-pointer border border-slate-300"
                >
                  <X className="w-4 h-4" />
                  <span>Tutup</span>
                </button>
              </div>
            </div>

            {/* Print Document Body */}
            <div className="space-y-6 print:space-y-4">
              {/* Document Header */}
              <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
                <div className="flex items-center gap-3">
                  <Boxes className="h-8 w-8 text-slate-950" />
                  <div>
                    <h2 className="text-base font-black text-slate-950 tracking-tight">
                      TRUEBLUE WMS
                    </h2>
                    <p className="text-[11px] text-slate-600">
                      Central DC & Multi-Warehouse Logistics Network
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Kawasan Pergudangan Kamal Muara Blok B-8, Jakarta Utara | Telp: (021) 5566-7788
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <span className="inline-block px-3 py-1 rounded bg-slate-900 text-white font-black text-xs tracking-wider uppercase mb-1">
                    SURAT JALAN MUTASI
                  </span>
                  <p className="text-sm font-black font-mono text-slate-900">
                    {selectedTransferForPrint.suratJalanNumber}
                  </p>
                  <p className="text-[10px] text-slate-500 font-mono">
                    Tgl: {new Date(selectedTransferForPrint.createdAt).toLocaleDateString('id-ID', { dateStyle: 'long' })}
                  </p>
                </div>
              </div>

              {/* Sender & Receiver Info */}
              <div className="grid grid-cols-2 gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs">
                <div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-0.5">
                    Gudang Pengirim (Asal):
                  </span>
                  <p className="font-extrabold text-slate-900 text-sm">
                    {selectedTransferForPrint.sourceWarehouseName}
                  </p>
                  <p className="text-slate-600 text-[11px] mt-0.5">
                    Kode: <strong>{selectedTransferForPrint.sourceWarehouseId}</strong>
                  </p>
                </div>

                <div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-0.5">
                    Gudang Penerima (Tujuan):
                  </span>
                  <p className="font-extrabold text-slate-900 text-sm">
                    {selectedTransferForPrint.targetWarehouseName}
                  </p>
                  <p className="text-slate-600 text-[11px] mt-0.5">
                    Kode: <strong>{selectedTransferForPrint.targetWarehouseId}</strong>
                  </p>
                </div>
              </div>

              {/* Transport & Courier Info */}
              <div className="grid grid-cols-3 gap-3 text-xs border border-slate-200 rounded-xl p-3 bg-white">
                <div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase block">Ekspedisi / Armada</span>
                  <span className="font-bold text-slate-900">{selectedTransferForPrint.courierName}</span>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase block">Nomor Plat Polisi</span>
                  <span className="font-bold font-mono text-slate-900">{selectedTransferForPrint.vehiclePlate}</span>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase block">Nama Supir / Pengantar</span>
                  <span className="font-bold text-slate-900">{selectedTransferForPrint.driverName || '-'}</span>
                </div>
              </div>

              {/* Items Table */}
              <div className="border border-slate-300 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-300">
                    <tr>
                      <th className="p-2.5 text-center w-10">No</th>
                      <th className="p-2.5">Kode SKU</th>
                      <th className="p-2.5">Nama Produk</th>
                      <th className="p-2.5">Expired Date</th>
                      <th className="p-2.5 text-center">Rincian Pack</th>
                      <th className="p-2.5 text-right">Jumlah (Pcs)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-slate-800">
                    {selectedTransferForPrint.items.map((it, idx) => (
                      <tr key={idx}>
                        <td className="p-2.5 text-center font-bold text-slate-500">{idx + 1}</td>
                        <td className="p-2.5 font-mono font-bold text-slate-900">{it.skuId}</td>
                        <td className="p-2.5 font-semibold">{it.skuName}</td>
                        <td className="p-2.5 font-mono text-slate-600">{it.expiredDate}</td>
                        <td className="p-2.5 text-center font-mono text-[10px] text-slate-600">
                          {it.qtyCtn || 0} CTN + {it.qtyInner || 0} In + {it.qtyLoose || 0} Ls
                        </td>
                        <td className="p-2.5 text-right font-black text-slate-950 font-mono">
                          {formatNumber(it.qty)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-100 font-black text-slate-900 border-t-2 border-slate-300">
                    <tr>
                      <td colSpan={5} className="p-2.5 text-right uppercase">
                        Total Jumlah Barang:
                      </td>
                      <td className="p-2.5 text-right font-mono text-sm">
                        {formatNumber(selectedTransferForPrint.totalQty)} pcs
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Notes */}
              {selectedTransferForPrint.notes && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
                  <strong>Catatan Khusus:</strong> {selectedTransferForPrint.notes}
                </div>
              )}

              {/* Signature Columns */}
              <div className="grid grid-cols-3 gap-4 pt-6 text-center text-xs">
                <div className="border border-slate-300 rounded-xl p-3 flex flex-col justify-between h-36">
                  <span className="font-bold text-slate-700 uppercase text-[10px]">
                    Diserahkan Oleh (Gudang Asal)
                  </span>
                  <div className="border-b border-dashed border-slate-400 w-3/4 mx-auto mb-1" />
                  <div>
                    <p className="font-bold text-slate-900">{selectedTransferForPrint.createdBy}</p>
                    <p className="text-[10px] text-slate-500">Kepala Gudang / Logistik</p>
                  </div>
                </div>

                <div className="border border-slate-300 rounded-xl p-3 flex flex-col justify-between h-36">
                  <span className="font-bold text-slate-700 uppercase text-[10px]">
                    Dibawa Oleh (Supir / Ekspedisi)
                  </span>
                  <div className="border-b border-dashed border-slate-400 w-3/4 mx-auto mb-1" />
                  <div>
                    <p className="font-bold text-slate-900">{selectedTransferForPrint.driverName || 'Driver'}</p>
                    <p className="text-[10px] text-slate-500">{selectedTransferForPrint.vehiclePlate}</p>
                  </div>
                </div>

                <div className="border border-slate-300 rounded-xl p-3 flex flex-col justify-between h-36">
                  <span className="font-bold text-slate-700 uppercase text-[10px]">
                    Diterima Oleh (Gudang Tujuan)
                  </span>
                  <div className="border-b border-dashed border-slate-400 w-3/4 mx-auto mb-1" />
                  <div>
                    <p className="font-bold text-slate-900">
                      ( ..................................... )
                    </p>
                    <p className="text-[10px] text-slate-500">Tanda Tangan & Cap Gudang</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Sticky Toolbar (Hidden on print) */}
            <div className="sticky bottom-0 bg-white/95 backdrop-blur-xs z-30 pt-4 mt-8 border-t border-slate-200 flex items-center justify-between print:hidden">
              <span className="text-xs text-slate-500 font-medium">
                Total: <strong className="text-slate-900">{selectedTransferForPrint.items.length} SKU</strong> ({formatNumber(selectedTransferForPrint.totalQty)} pcs)
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-md transition-all cursor-pointer"
                >
                  <Printer className="w-4 h-4" />
                  <span>Cetak Dokumen</span>
                </button>
                <button
                  onClick={() => setSelectedTransferForPrint(null)}
                  className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-colors cursor-pointer"
                >
                  Tutup Pratinjau
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DIALOG KONFIRMASI SUKSES TRANSFER ANTAR GUDANG */}
      {transferSuccessDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in">
          <div className="bg-[#11141B] border border-slate-800 rounded-3xl w-full max-w-lg p-6 shadow-2xl relative text-slate-100 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-black text-white">Transfer Antar Gudang Berhasil!</h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  No. Surat Jalan: <span className="text-emerald-400 font-bold">{transferSuccessDialog.suratJalanNumber}</span>
                </p>
              </div>
            </div>

            <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-4 space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Gudang Asal:</span>
                <span className="font-bold text-white">{transferSuccessDialog.sourceWarehouseName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Gudang Tujuan:</span>
                <span className="font-bold text-emerald-400">{transferSuccessDialog.targetWarehouseName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Total Muatan:</span>
                <span className="font-bold font-mono text-white">
                  {transferSuccessDialog.items.length} SKU • {formatNumber(transferSuccessDialog.totalQty)} Pcs
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Ekspedisi:</span>
                <span className="text-slate-300 font-medium">
                  {transferSuccessDialog.courierName} ({transferSuccessDialog.vehiclePlate})
                </span>
              </div>
            </div>

            <div className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl text-xs text-emerald-300">
              ✓ Stok di <strong>{transferSuccessDialog.sourceWarehouseName}</strong> telah dipotong dan stok di <strong>{transferSuccessDialog.targetWarehouseName}</strong> telah otomatis bertambah.
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-2 pt-2">
              <button
                onClick={() => {
                  setSelectedTransferForPrint(transferSuccessDialog);
                  setTransferSuccessDialog(null);
                }}
                className="w-full sm:flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-lg shadow-indigo-600/30 transition-all cursor-pointer"
              >
                <Printer className="w-4 h-4" />
                <span>Lihat Surat Jalan</span>
              </button>
              <button
                onClick={() => {
                  setTransferSuccessDialog(null);
                  setActiveTab('history');
                }}
                className="w-full sm:flex-1 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs transition-colors cursor-pointer"
              >
                Riwayat Mutasi
              </button>
              <button
                onClick={() => setTransferSuccessDialog(null)}
                className="w-full sm:w-auto p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
                title="Tutup Dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: DAFTAR STOK GUDANG TERPILIH */}
      {selectedWhForStockModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 md:p-6 z-50 overflow-y-auto">
          <div className="bg-[#11141B] rounded-2xl max-w-5xl w-full shadow-2xl border border-slate-800 flex flex-col max-h-[90vh] overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-950/70 border-b border-slate-800 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                  <Building2 className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      {selectedWhForStockModal.code}
                    </span>
                    <span className="text-xs text-slate-400 font-medium">
                      {selectedWhForStockModal.city} • PIC: {selectedWhForStockModal.picName}
                    </span>
                  </div>
                  <h3 className="font-extrabold text-white text-base md:text-lg mt-0.5">
                    Stok Fisik: {selectedWhForStockModal.name}
                  </h3>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    onSelectWarehouseFilter(selectedWhForStockModal.id);
                    if (onNavigateToInventoryTab) {
                      onNavigateToInventoryTab(selectedWhForStockModal.id);
                    }
                    setSelectedWhForStockModal(null);
                  }}
                  className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all cursor-pointer shadow-md"
                  title="Buka seluruh fitur stok di menu Stok Barang"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Buka di Menu Stok Utama</span>
                </button>

                <button
                  onClick={() => {
                    setSelectedWhForStockModal(null);
                    setWhStockModalSearch('');
                  }}
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="p-4 md:p-6 space-y-4 overflow-y-auto flex-1">
              {(() => {
                const whItems = stock.filter(item => {
                  const itemWh = (item.warehouseId || 'WH-CENTRAL').toUpperCase();
                  return itemWh === selectedWhForStockModal.id.toUpperCase() && item.qty > 0;
                });

                const filteredModalItems = whItems.filter(item => {
                  if (!whStockModalSearch.trim()) return true;
                  const query = whStockModalSearch.toLowerCase();
                  return (
                    item.skuId.toLowerCase().includes(query) ||
                    item.skuName.toLowerCase().includes(query) ||
                    item.location.toLowerCase().includes(query)
                  );
                });

                const totalPcsInWh = whItems.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
                const totalCtnsInWh = whItems.reduce((sum, item) => sum + (Number(item.qtyCtn) || 0), 0);

                const handleExportWhStockExcel = () => {
                  const exportRows = filteredModalItems.map((item, idx) => ({
                    'No': idx + 1,
                    'Gudang': selectedWhForStockModal.name,
                    'Kode Gudang': selectedWhForStockModal.code,
                    'SKU ID': item.skuId,
                    'Nama Barang': item.skuName,
                    'Expired Date': item.expiredDate,
                    'Lokasi Rak': item.location,
                    'Qty Fisik (Pcs)': item.qty,
                    'Qty CTN': item.qtyCtn,
                    'Qty Inner': item.qtyInner,
                    'Qty Loose': item.qtyLoose,
                    'Status ED': item.status
                  }));
                  const ws = XLSX.utils.json_to_sheet(exportRows);
                  const wb = XLSX.utils.book_new();
                  XLSX.utils.book_append_sheet(wb, ws, `Stok ${selectedWhForStockModal.code}`);
                  XLSX.writeFile(wb, `Stok_${selectedWhForStockModal.code}_${new Date().toISOString().slice(0, 10)}.xlsx`);
                };

                return (
                  <>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-900/80 border border-slate-800 p-3 rounded-xl">
                      <div className="flex items-center gap-4 text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-400 font-medium">Total SKU:</span>
                          <span className="font-mono font-bold text-white text-sm">{formatNumber(whItems.length)}</span>
                        </div>
                        <div className="w-px h-4 bg-slate-700" />
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-400 font-medium">Total Fisik:</span>
                          <span className="font-mono font-black text-emerald-400 text-sm">{formatNumber(totalPcsInWh)} Pcs</span>
                        </div>
                        <div className="w-px h-4 bg-slate-700" />
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-400 font-medium">Total Karton:</span>
                          <span className="font-mono font-bold text-indigo-400 text-sm">{formatNumber(totalCtnsInWh)} CTN</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 w-full sm:w-auto">
                        <div className="relative flex-1 sm:w-64">
                          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            placeholder="Cari SKU, nama, rak..."
                            value={whStockModalSearch}
                            onChange={(e) => setWhStockModalSearch(e.target.value)}
                            className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#161B25] border border-slate-800 rounded-lg text-slate-200 outline-none focus:border-indigo-500"
                          />
                        </div>
                        <button
                          onClick={handleExportWhStockExcel}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg border border-slate-700 transition-colors shrink-0 cursor-pointer"
                          title="Download Excel Stok Gudang Ini"
                        >
                          <Download className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="hidden sm:inline">Excel</span>
                        </button>
                      </div>
                    </div>

                    {/* Stock Table */}
                    <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-950/60">
                      <div className="overflow-x-auto max-h-[50vh]">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead className="bg-slate-900/90 text-slate-400 font-bold uppercase tracking-wider sticky top-0 z-10 border-b border-slate-800">
                            <tr>
                              <th className="py-2.5 px-3 w-10 text-center">No</th>
                              <th className="py-2.5 px-3">SKU ID & Nama Produk</th>
                              <th className="py-2.5 px-3 text-center">Expired Date</th>
                              <th className="py-2.5 px-3 text-center">Lokasi Rak</th>
                              <th className="py-2.5 px-3 text-right">Qty Fisik</th>
                              <th className="py-2.5 px-3 text-center">Breakdown Kemasan</th>
                              <th className="py-2.5 px-3 text-center">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60">
                            {filteredModalItems.length === 0 ? (
                              <tr>
                                <td colSpan={7} className="py-12 text-center text-slate-500">
                                  <Package className="w-10 h-10 stroke-1 mx-auto mb-2 text-slate-600" />
                                  <p className="font-bold text-slate-400">Belum ada stok fisik di gudang ini</p>
                                  <p className="text-[11px] text-slate-500 mt-1">
                                    Gunakan menu <strong>"Transfer Antar Gudang"</strong> untuk memutasikan barang dari Gudang Pusat ke gudang ini.
                                  </p>
                                </td>
                              </tr>
                            ) : (
                              filteredModalItems.map((item, idx) => (
                                <tr key={item.id} className="hover:bg-slate-850/50 transition-colors">
                                  <td className="py-2.5 px-3 text-center text-slate-500 font-mono">{idx + 1}</td>
                                  <td className="py-2.5 px-3">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded text-[10px]">
                                        {item.skuId}
                                      </span>
                                      <span className="font-bold text-white truncate max-w-xs">{item.skuName}</span>
                                    </div>
                                  </td>
                                  <td className="py-2.5 px-3 text-center font-mono text-slate-300">{item.expiredDate}</td>
                                  <td className="py-2.5 px-3 text-center">
                                    <span className="font-mono font-bold text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded text-[10px]">
                                      {item.location}
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-3 text-right">
                                    <span className="font-mono font-black text-emerald-400 text-sm">
                                      {formatNumber(item.qty)}
                                    </span>
                                    <span className="text-[10px] text-slate-400 ml-1">pcs</span>
                                  </td>
                                  <td className="py-2.5 px-3 text-center font-mono text-slate-400 text-[11px]">
                                    {item.qtyCtn} CTN • {item.qtyInner} INR • {item.qtyLoose} LSE
                                  </td>
                                  <td className="py-2.5 px-3 text-center">
                                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                                      {item.status}
                                    </span>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between shrink-0">
              <span className="text-xs text-slate-400">
                Gudang: <strong className="text-white">{selectedWhForStockModal.name}</strong> ({selectedWhForStockModal.code})
              </span>
              <button
                onClick={() => {
                  setSelectedWhForStockModal(null);
                  setWhStockModalSearch('');
                }}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition-colors cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
      {/* EXCEL / CSV BULK IMPORT MODAL FOR TRANSFER */}
      {isImportModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-[#11141B] rounded-2xl max-w-3xl w-full shadow-2xl border border-slate-800/85 overflow-hidden flex flex-col max-h-[92vh]">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-950/60 border-b border-slate-800/60 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center">
                  <FileSpreadsheet className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-extrabold text-white text-sm">
                    Impor Massal Item Transfer (Excel / CSV)
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Gudang Asal: <strong className="text-emerald-400 font-mono">{transferSourceWh}</strong> → Gudang Tujuan: <strong className="text-indigo-400 font-mono">{transferTargetWh || 'Pilih Tujuan'}</strong>
                  </p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setIsImportModalOpen(false);
                  setImportRawText('');
                  setImportFileName('');
                  setImportParsedItems([]);
                }}
                className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-4">
              {/* Template Download Banner */}
              <div className="bg-gradient-to-r from-emerald-950/30 via-slate-900 to-indigo-950/30 border border-emerald-500/30 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-md">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black text-emerald-400 flex items-center gap-1.5">
                      <Download className="w-4 h-4" />
                      Template Resmi Transfer Antar Gudang
                    </span>
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-300 font-bold px-2 py-0.5 rounded-full">
                      Format Standar
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300">
                    Kolom: <strong>SKU ID</strong>, <strong>Qty (Pcs)</strong>, <em>Expired Date (Opsional)</em>, <em>Lokasi Asal (Opsional)</em>, <em>Catatan</em>.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleDownloadTransferTemplate('xlsx')}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    <span>Unduh Excel (.xlsx)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadTransferTemplate('csv')}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <span>CSV</span>
                  </button>
                </div>
              </div>

              {/* Input Method Switcher */}
              <div className="flex border-b border-slate-800 gap-4 text-xs font-bold">
                <button
                  type="button"
                  onClick={() => setImportTab('upload')}
                  className={`pb-2.5 flex items-center gap-2 transition-all cursor-pointer ${
                    importTab === 'upload'
                      ? 'text-indigo-400 border-b-2 border-indigo-500 font-extrabold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <UploadCloud className="w-4 h-4" />
                  <span>Unggah File Excel / CSV</span>
                </button>
                <button
                  type="button"
                  onClick={() => setImportTab('paste')}
                  className={`pb-2.5 flex items-center gap-2 transition-all cursor-pointer ${
                    importTab === 'paste'
                      ? 'text-indigo-400 border-b-2 border-indigo-500 font-extrabold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <FileText className="w-4 h-4" />
                  <span>Tempel Teks (Copy-Paste)</span>
                </button>
              </div>

              {/* Upload Tab */}
              {importTab === 'upload' && (
                <div className="space-y-3">
                  <div 
                    onClick={() => importFileInputRef.current?.click()}
                    className="border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-2xl p-6 text-center bg-slate-950/50 hover:bg-slate-950 transition-all cursor-pointer space-y-2"
                  >
                    <input
                      ref={importFileInputRef}
                      type="file"
                      accept=".xlsx, .xls, .csv"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                    <UploadCloud className="w-8 h-8 text-indigo-400 mx-auto" />
                    <div className="text-xs font-bold text-white">
                      Klik untuk memilih file Excel atau drag & drop file ke sini
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Mendukung file format <strong>.xlsx</strong>, <strong>.xls</strong>, atau <strong>.csv</strong>
                    </p>
                    {importFileName && (
                      <div className="inline-flex items-center gap-2 px-3 py-1 bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 rounded-lg text-xs font-mono font-bold mt-2">
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        <span>{importFileName}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Paste Tab */}
              {importTab === 'paste' && (
                <div className="space-y-2">
                  <label className="text-[11px] font-bold text-slate-400 block">
                    Salin baris dari spreadsheet dan tempel di bawah ini (SKU [TAB] Qty [TAB] Expired [TAB] Lokasi):
                  </label>
                  <textarea
                    rows={5}
                    value={importRawText}
                    onChange={e => handleParseRawInput(e.target.value)}
                    placeholder={'8809647240012\t10\t15/12/2026\tE-01-01\n8809647240029\t24\t20/08/2027\tF-02-03'}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-xs font-mono text-white focus:border-indigo-500 outline-none"
                  />
                </div>
              )}

              {/* Parsed Items Preview Table */}
              {importParsedItems.length > 0 && (
                <div className="space-y-2.5 pt-2 border-t border-slate-800">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Pratinjau Data Transfer ({importParsedItems.length} Baris Terdeteksi)
                    </span>
                    <span className="text-[11px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
                      {importParsedItems.filter(i => i.status !== 'NOT_FOUND').length} Siap Ditambahkan
                    </span>
                  </div>

                  <div className="border border-slate-800 rounded-xl overflow-hidden max-h-[220px] overflow-y-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950 text-slate-400 text-[10px] font-bold uppercase sticky top-0 border-b border-slate-800">
                        <tr>
                          <th className="p-2 w-8 text-center">No</th>
                          <th className="p-2">SKU & Nama Barang</th>
                          <th className="p-2 text-center w-20">Qty Diminta</th>
                          <th className="p-2 text-center w-24">Stok {transferSourceWh}</th>
                          <th className="p-2 min-w-[160px]">Lokasi Asal</th>
                          <th className="p-2">Status Validasi</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 font-medium">
                        {importParsedItems.map((item, idx) => (
                          <tr key={idx} className="hover:bg-slate-800/30 transition-colors text-[11px]">
                            <td className="p-2 text-center text-slate-500 font-mono">{idx + 1}</td>
                            <td className="p-2">
                              <div className="font-bold text-white font-mono">{item.rawSku}</div>
                              <div className="text-[10px] text-slate-400 truncate max-w-[200px]">
                                {item.matchedStock?.skuName || 'Nama tidak terdaftar'}
                              </div>
                            </td>
                            <td className="p-2 text-center font-bold text-white font-mono">{item.qty} pcs</td>
                            <td className="p-2 text-center font-mono">
                              {(() => {
                                const skuCandidates = sourceStockItems.filter(s => (s.skuId||'').toUpperCase() === item.rawSku);
                                const currentLoc = (item.rawLocation || item.matchedStock?.location || '').trim().toUpperCase();
                                const cleanCurrentLoc = currentLoc.replace(/[-_\s]/g, '');
                                const locCandidates = skuCandidates.filter(s => s.location.trim().toUpperCase().replace(/[-_\s]/g, '') === cleanCurrentLoc);
                                const showQty = locCandidates.length > 0 ? locCandidates.reduce((sum, s) => sum + s.qty, 0) : skuCandidates.reduce((sum, s) => sum + s.qty, 0);

                                return showQty > 0 ? (
                                  <span className="text-emerald-400 font-bold">{formatNumber(showQty)} pcs</span>
                                ) : (
                                  <span className="text-rose-400 font-bold">0 pcs</span>
                                );
                              })()}
                            </td>
                            <td className="p-2">
                              {(() => {
                                const skuCandidates = sourceStockItems.filter(s => (s.skuId || '').trim().toUpperCase() === item.rawSku);
                                const currentLocation = item.rawLocation || item.matchedStock?.location || '';
                                const cleanCurrentLoc = currentLocation.trim().toUpperCase().replace(/[-_\s]/g, '');
                                const matchingCandidate = skuCandidates.find(c => c.location.trim().toUpperCase().replace(/[-_\s]/g, '') === cleanCurrentLoc);
                                const selectValue = matchingCandidate ? matchingCandidate.location : currentLocation;
                                const hasCurrentInCandidates = Boolean(matchingCandidate);

                                return (
                                  <select
                                    value={selectValue}
                                    onChange={(e) => handleUpdateImportItemLocation(idx, e.target.value)}
                                    className="w-full bg-slate-900 border border-slate-700 hover:border-indigo-500 rounded-lg px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-indigo-500 cursor-pointer"
                                  >
                                    {skuCandidates.length > 0 ? (
                                      skuCandidates.map((c, cIdx) => (
                                        <option key={`${c.location}-${c.expiredDate}-${cIdx}`} value={c.location}>
                                          {c.location} ({formatNumber(c.qty)} pcs{c.expiredDate ? ` • ${c.expiredDate}` : ''})
                                        </option>
                                      ))
                                    ) : (
                                      <option value={currentLocation}>
                                        {currentLocation || 'Tidak ada stok'}
                                      </option>
                                    )}
                                    {currentLocation && !hasCurrentInCandidates && (
                                      <option value={currentLocation}>
                                        {currentLocation} (Dari File)
                                      </option>
                                    )}
                                  </select>
                                );
                              })()}
                            </td>
                            <td className="p-2">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                item.status === 'VALID'
                                  ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                                  : item.status === 'WARNING_QTY'
                                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/30'
                                  : 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
                              }`}>
                                {item.statusMessage}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between shrink-0">
              <span className="text-xs text-slate-400">
                {importParsedItems.length > 0 ? (
                  <span>
                    Valid: <strong className="text-emerald-400">{importParsedItems.filter(i => i.status !== 'NOT_FOUND').length}</strong> dari {importParsedItems.length} baris
                  </span>
                ) : (
                  <span>Pilih file Excel atau tempel baris data untuk melihat pratinjau.</span>
                )}
              </span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsImportModalOpen(false);
                    setImportRawText('');
                    setImportFileName('');
                    setImportParsedItems([]);
                  }}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition-colors cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={importParsedItems.filter(i => i.status !== 'NOT_FOUND').length === 0}
                  onClick={handleCommitImport}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/30 transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Tambahkan ({importParsedItems.filter(i => i.status !== 'NOT_FOUND').length} SKU Valid)</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
