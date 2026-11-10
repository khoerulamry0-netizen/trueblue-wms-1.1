import {initialOutboundMode,isOrderRowPicked,type OutboundMode} from '../utils/dashboardView';
import {startConfirmedOrderSession} from '../utils/confirmedOrderSession';
import { scanServerUnavailable } from '../utils/packingValidation';
import { getActiveBranch, SERVER_SCAN_ENABLED, serverScanRpc, supabase } from '../supabase';
import { createScanServerSession } from '../utils/sortingServerSession';
import type { ScanProgress } from '../utils/serverScanRpc';
import type {OrderSessionResult} from '../utils/orderSession';
import React, { useState, useMemo, useRef } from 'react';
import { StockItem, OutboundItem, Warehouse } from '../types';
import { 
  formatNumber, 
  getExpiredStatus, 
  isNearExpiryStatus, 
  getLockedStockSummary, 
  getAvailableStockPool, 
  getItemStockBreakdown,
  normalizeDateToDmy,
  isZoneOrUrbanLocation,
  isStockPickable
} from '../utils/calculations';
import { 
  FileText, 
  HelpCircle, 
  CheckCircle, 
  AlertTriangle, 
  Trash2, 
  X, 
  Layers, 
  ArrowRight,
  Sparkles,
  Barcode,
  Scan,
  Volume2,
  Plus,
  ClipboardList,
  PackageCheck,
  AlertCircle,
  ArrowLeft,
  Check,
  PackageOpen,
  Play,
  Printer,
  Circle,
  History,
  Lock,
  UserCheck,
  ShieldAlert,
  Unlock,
  Calendar,
  Boxes
} from 'lucide-react';
import { findSkuId, getBarcodeForSku, BARCODE_MAP } from '../data/barcodeMap';
import HistoryOrder from './HistoryOrder';
import OrderFileImport from './OrderFileImport';
import BatchPickingModal from './BatchPickingModal';
import CourierManifestManager from './CourierManifestManager';
import { Navigation, Truck } from 'lucide-react';
import { WarehousePickingRouteConfig } from '../types';
import { getWarehouseRouteScore, describeRouteConfig, DEFAULT_TRUEBLUE_ROUTE_CONFIG } from '../utils/warehouseRouting';

export const getLocationRank = (loc: string, config?: WarehousePickingRouteConfig): number => {
  return getWarehouseRouteScore(loc, config);
};


interface BulkOutboundProps {
  initialMode?: OutboundMode;
  stock: StockItem[];
  warehouses?: Warehouse[];
  onProcessOutbound: (items: Omit<OutboundItem, 'id' | 'timestamp'>[]) => Promise<boolean>;
  currentUser?: { username: string; role: string; fullName: string } | null;
  orderHistory?: OutboundItem[];
  onEditOrderHistory?: (newItem: OutboundItem, oldItem: OutboundItem, isPackerEdit?: boolean) => Promise<boolean>;
  onEditOrderHistoryBatch?: (refNum: string, updatedItems: OutboundItem[], isPicking?: boolean) => Promise<boolean>;
  onEditMultipleOrdersBatch?: (updates: import('../utils/orderCompletion').OrderCompletion[]) => Promise<boolean>;
  onDeleteOrderHistory?: (item: OutboundItem) => boolean;
  onDeleteMultipleOrders?: (items: OutboundItem[]) => boolean;
  onClearAllOrderHistory?: () => Promise<boolean> | void;
  onBatchEditExpiredDate?: (items: OutboundItem[], newRawExpDate: string) => Promise<boolean>;
  onUpdateOrderSession?: (
    refNum: string,
    sessionData: {
      pickingBy?: string | null;
      pickingStartedAt?: string | null;
      packingBy?: string | null;
      packingStartedAt?: string | null;
    }
  ) => Promise<OrderSessionResult | false>;
  onUpdateOrdersShipped?: (orderRefs: string[], manifestInfo: any, isCancelled?: boolean) => Promise<boolean>;
}

interface ParsedRow {
  skuId: string;
  qty: number;
  originalText: string;
  isValid: boolean;
  error?: string;
  allocatedLines: {
    location: string;
    expiredDate: string;
    qtyAllocated: number;
  }[];
}

export default function BulkOutbound({ 
  stock = [], 
  warehouses = [],
  onProcessOutbound,
  currentUser,
  orderHistory = [],
  onEditOrderHistory,
  onEditOrderHistoryBatch,
  onEditMultipleOrdersBatch,
  onDeleteOrderHistory,
  onDeleteMultipleOrders,
  onClearAllOrderHistory,
  onBatchEditExpiredDate,
  onUpdateOrderSession,
  onUpdateOrdersShipped,
  initialMode
}: BulkOutboundProps) {
  const [inputText, setInputText] = useState('');
  const [refNumber, setRefNumber] = useState(`OUT-BULK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`);
  const [orderNumber, setOrderNumber] = useState('');
  const [batchNumberInput, setBatchNumberInput] = useState('');
  const [noPo, setNoPo] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [showInstructions, setShowInstructions] = useState(true);
  const [requirePacking, setRequirePacking] = useState(true);
  const availableWarehouses: Warehouse[] = useMemo(() => {
    return warehouses && warehouses.length > 0
      ? warehouses
      : [{
          id: 'WH-CENTRAL',
          code: 'CENTRAL',
          name: 'Gudang Pusat',
          type: 'CENTRAL',
          address: '-',
          city: 'Jakarta',
          picName: 'Staff Logistik',
          picPhone: '-',
          status: 'ACTIVE',
          isCentral: true,
          createdAt: new Date().toISOString()
        }];
  }, [warehouses]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>(warehouses?.[0]?.id || 'WH-CENTRAL');

  const activeWarehouse = useMemo(() => {
    return availableWarehouses.find(w => w.id.toUpperCase() === (selectedWarehouseId || '').toUpperCase()) || availableWarehouses[0];
  }, [availableWarehouses, selectedWarehouseId]);

  const activeRouteConfig = activeWarehouse?.pickingRouteConfig || DEFAULT_TRUEBLUE_ROUTE_CONFIG;

  React.useEffect(() => {
    if (availableWarehouses.length > 0 && (!selectedWarehouseId || !availableWarehouses.some(w => w.id.toUpperCase() === selectedWarehouseId.toUpperCase()))) {
      setSelectedWarehouseId(availableWarehouses[0].id);
    }
  }, [availableWarehouses, selectedWarehouseId]);

  // High-level mode selection tab: 'create', 'pick', 'validate', 'history' or 'manifest'
  const [activeModeTab, setActiveModeTab] = useState<'create' | 'pick' | 'validate' | 'history' | 'manifest'>(() => {
    return initialOutboundMode(currentUser?.role, initialMode);
  });

  // Enforce mode lock for Packer, Picker, and Shipping roles
  React.useEffect(() => {
    if (currentUser?.role === 'Shipping' && activeModeTab !== 'manifest') {
      setActiveModeTab('manifest');
    } else if (currentUser?.role === 'Packer' && activeModeTab !== 'validate') {
      setActiveModeTab('validate');
    } else if (currentUser?.role === 'Picker' && activeModeTab !== 'pick') {
      setActiveModeTab('pick');
    }
  }, [currentUser?.role, activeModeTab]);

  // Listen for manifest updates to keep the tab 5 badge in sync
  const [manifestVersion, setManifestVersion] = useState(0);
  React.useEffect(() => {
    const onManifestUpdated = () => setManifestVersion(v => v + 1);
    window.addEventListener('blues-manifests-updated', onManifestUpdated);
    return () => window.removeEventListener('blues-manifests-updated', onManifestUpdated);
  }, []);

  const unmanifestedCompletedCount = React.useMemo(() => {
    const manifestedSet = new Set<string>();
    const activeWh = (selectedWarehouseId || 'WH-CENTRAL').toUpperCase();
    try {
      const raw = localStorage.getItem('blues-shipping-manifests');
      if (raw) {
        const list = JSON.parse(raw);
        list
          .filter((m: any) => (!m.warehouseId || (m.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh))
          .forEach((m: any) => (m.orderReferences || []).forEach((r: string) => manifestedSet.add(r)));
      }
    } catch {}
    const pendingRefs = new Set<string>();
    orderHistory.forEach(i => {
      const ref = i.referenceNumber || i.orderNumber || i.id;
      const iWh = (i.warehouseId || 'WH-CENTRAL').toUpperCase();
      if (i.status === 'Completed' && iWh === activeWh && !i.shipped && !manifestedSet.has(ref)) {
        pendingRefs.add(ref);
      }
    });
    return pendingRefs.size;
  }, [orderHistory, manifestVersion, selectedWarehouseId]);

  // Active picking/packing states
  const [activePickerRef, setActivePickerRef] = useState<string | null>(null);
  const sessionStartBusy=useRef(false);
  const pickingSaveBusy=useRef(false);
  const [startingSession,setStartingSession]=useState(false);
  const [savingPicking,setSavingPicking]=useState(false);
  const [pickingFeedback,setPickingFeedback]=useState('');
  const [pickingItems, setPickingItems] = useState<OutboundItem[]>([]);
  const [confirmedPickingIds, setConfirmedPickingIds] = useState<{ [id: string]: boolean }>({});
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [tempExpDate, setTempExpDate] = useState<string>('');
  const [showMobilePickingSummary, setShowMobilePickingSummary] = useState(false);
  const [hideConfirmedPicker, setHideConfirmedPicker] = useState(true);

  // Active packing validation session states
  const [activePackingRef, setActivePackingRef] = useState<string | null>(null);
  const [lastPackedOrder, setLastPackedOrder] = useState<any | null>(null);
  const [packingScannedQty, setPackingScannedQty] = useState<{ [itemId: string]: number }>({});
  const [packingScanError, setPackingScanError] = useState<string | null>(null);
  const [packingScanSuccess, setPackingScanSuccess] = useState<string | null>(null);
  const [packingManualCode, setPackingManualCode] = useState('');
  const [packingTask, setPackingTask] = useState<{branch:string; actor:string; reference:string; basket:string} | null>(null);
  const [packingReady, setPackingReady] = useState(false);
  const [packingFinished, setPackingFinished] = useState(false);
  const [packingBusy, setPackingBusy] = useState(false);
  const packingBusyRef = useRef(false);
  const packingControllers = useRef(new Map<string, ReturnType<typeof createScanServerSession>>());

  // Iframe check and clipboard states
  const [isInIframe, setIsInIframe] = useState(false);
  const [copiedReceipt, setCopiedReceipt] = useState(false);
  const [showBatchPickingModal, setShowBatchPickingModal] = useState(false);

  // Custom dialogs state for browser confirm block bypass
  const [customConfirmState, setCustomConfirmState] = useState<{
    type: 'bulk_outbound' | 'unpicked_packing' | 'unconfirmed_picking';
    message?: string;
    details?: {
      invalidRowsCount: number;
      overallMismatch: boolean;
      under24Items: string[];
    };
    onConfirm: () => void;
  } | null>(null);

  const [bulkProcessError, setBulkProcessError] = useState<string | null>(null);
  const [bulkProcessSuccess, setBulkProcessSuccess] = useState<string | null>(null);

  const playFinishSound = () => {
    try {
      // 1. Voice Speech Synthesis to say "FINISH"
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); // Stop any ongoing speech
        const utterance = new SpeechSynthesisUtterance('FINISH');
        utterance.lang = 'en-US';
        utterance.rate = 1.15;
        utterance.pitch = 1.05;
        window.speechSynthesis.speak(utterance);
      }
      
      // 2. Play a cool high-tech success chime using Web Audio API
      if (typeof window.AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined') {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextClass();
        const now = ctx.currentTime;
        
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gainNode = ctx.createGain();
        
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(523.25, now); // C5
        osc1.frequency.exponentialRampToValueAtTime(1046.50, now + 0.12); // C6
        
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(659.25, now); // E5
        osc2.frequency.exponentialRampToValueAtTime(1318.51, now + 0.12); // E6
        
        gainNode.gain.setValueAtTime(0.12, now);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
        
        osc1.connect(gainNode);
        osc2.connect(gainNode);
        gainNode.connect(ctx.destination);
        
        osc1.start(now);
        osc2.start(now);
        
        osc1.stop(now + 0.25);
        osc2.stop(now + 0.25);
      }
    } catch (err) {
      console.error('Error playing sound:', err);
    }
  };

  React.useEffect(() => {
    try {
      setIsInIframe(window.self !== window.top);
    } catch (e) {
      setIsInIframe(true);
    }
  }, []);

  const handleCopyReceipt = () => {
    if (!lastPackedOrder) return;
    const dateStr = new Date().toLocaleString('id-ID');
    const itemsText = lastPackedOrder.items.map((item: any) => 
      `- ${item.skuId} (${item.skuName}) | Rak: ${item.location} | Exp: ${item.expiredDate} | Qty: ${item.qty} pcs`
    ).join('\n');

    const receiptText = `==================================
RESI OUTBOUND / PACKING SLIP
INVENTORY WAREHOUSE OFFLINE
Tanggal: ${dateStr}
==================================
No. Referensi : ${lastPackedOrder.referenceNumber}
No. Order     : ${lastPackedOrder.orderNumber || '-'}
No. PO        : ${lastPackedOrder.noPo || '-'}
Customer      : ${lastPackedOrder.customerName || 'N/A'}
Packer        : ${currentUser?.fullName || 'Simulated Packer'}
Status        : 100% VERIFIED
----------------------------------
DETAIL BARANG:
${itemsText}
----------------------------------
TOTAL QTY     : ${lastPackedOrder.totalQty} pcs
==================================`;

    navigator.clipboard.writeText(receiptText);
    setCopiedReceipt(true);
    setTimeout(() => setCopiedReceipt(false), 2500);
  };

  const handleDownloadReceipt = () => {
    if (!lastPackedOrder) return;
    const dateStr = new Date().toLocaleString('id-ID');
    const itemsText = lastPackedOrder.items.map((item: any) => 
      `- ${item.skuId} (${item.skuName}) | Rak: ${item.location} | Exp: ${item.expiredDate} | Qty: ${item.qty} pcs`
    ).join('\n');

    const receiptText = `==================================
RESI OUTBOUND / PACKING SLIP
INVENTORY WAREHOUSE OFFLINE
Tanggal: ${dateStr}
==================================
No. Referensi : ${lastPackedOrder.referenceNumber}
No. Order     : ${lastPackedOrder.orderNumber || '-'}
No. PO        : ${lastPackedOrder.noPo || '-'}
Customer      : ${lastPackedOrder.customerName || 'N/A'}
Packer        : ${currentUser?.fullName || 'Simulated Packer'}
Status        : 100% VERIFIED
----------------------------------
DETAIL BARANG:
${itemsText}
----------------------------------
TOTAL QTY     : ${lastPackedOrder.totalQty} pcs
==================================`;

    const blob = new Blob([receiptText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Resi_${lastPackedOrder.referenceNumber}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // New Barcode Scan states
  const [orderInputMode, setOrderInputMode] = useState<'scan' | 'bulk'>('bulk');
  const [barcodeSearchInput, setBarcodeSearchInput] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [scannedItems, setScannedItems] = useState<{ skuId: string; skuName: string; qty: number }[]>([]);
  const [scannedItemsError, setScannedItemsError] = useState<string | null>(null);
  const [scannedItemsSuccess, setScannedItemsSuccess] = useState<string | null>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);

  // Stock Locking & Reservation calculation for Pending un-deducted orders
  const lockedStockSummary = useMemo(() => getLockedStockSummary(orderHistory), [orderHistory]);
  const availableStockPool = useMemo(() => getAvailableStockPool(stock, orderHistory), [stock, orderHistory]);

  // Allocatable Outbound Stock Pool: filtered by warehouse
  const allocatableOutboundStockPool = useMemo(() => {
    const activeWh = (selectedWarehouseId || 'WH-CENTRAL').toUpperCase();
    return availableStockPool
      .filter(item => (item.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh);
  }, [availableStockPool, selectedWarehouseId]);

  // Group pending orders from orderHistory
  const pendingOrders = useMemo(() => {
    const groups: { [ref: string]: {
      referenceNumber: string;
      orderNumber?: string;
      noPo?: string;
      customerName?: string;
      timestamp: string;
      items: OutboundItem[];
      totalQty: number;
      isPicked: boolean;
      pickingBy?: string;
      pickingStartedAt?: string;
      packingBy?: string;
      packingStartedAt?: string;
    }} = {};

    (orderHistory || []).forEach(item => {
      if (item.status === 'Pending') {
        if (!groups[item.referenceNumber]) {
          groups[item.referenceNumber] = {
            referenceNumber: item.referenceNumber,
            orderNumber: item.orderNumber,
            noPo: item.noPo,
            customerName: item.customerName,
            timestamp: item.timestamp,
            items: [],
            totalQty: 0,
            isPicked: true,
            pickingBy: item.pickingBy,
            pickingStartedAt: item.pickingStartedAt,
            packingBy: item.packingBy,
            packingStartedAt: item.packingStartedAt
          };
        }
        groups[item.referenceNumber].items.push(item);
        groups[item.referenceNumber].totalQty += item.qty;
        if (!isOrderRowPicked(item)) {
          groups[item.referenceNumber].isPicked = false;
        }
        if (item.pickingBy && !groups[item.referenceNumber].pickingBy) {
          groups[item.referenceNumber].pickingBy = item.pickingBy;
        }
        if (item.pickingStartedAt && !groups[item.referenceNumber].pickingStartedAt) {
          groups[item.referenceNumber].pickingStartedAt = item.pickingStartedAt;
        }
        if (item.packingBy && !groups[item.referenceNumber].packingBy) {
          groups[item.referenceNumber].packingBy = item.packingBy;
        }
        if (item.packingStartedAt && !groups[item.referenceNumber].packingStartedAt) {
          groups[item.referenceNumber].packingStartedAt = item.packingStartedAt;
        }
      }
    });

    return Object.values(groups).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [orderHistory]);

  // Only orders that need picking (not yet picked) are shown to the Picker
  const pickerPendingOrders = useMemo(() => {
    return pendingOrders.filter(ord => !ord.isPicked);
  }, [pendingOrders]);

  // Only orders that are ready to pack (fully picked) are shown to the Packer
  const packerPendingOrders = useMemo(() => {
    return pendingOrders.filter(ord => ord.isPicked);
  }, [pendingOrders]);

  const handleForceReleaseLock = (refNum: string, type: 'picking' | 'packing') => {
    if (onUpdateOrderSession) {
      if (type === 'picking') {
        onUpdateOrderSession(refNum, { pickingBy: null, pickingStartedAt: null });
      } else {
        onUpdateOrderSession(refNum, { packingBy: null, packingStartedAt: null });
      }
    }
  };

  const handleStartPicking = async (refNum: string) => {
    if(sessionStartBusy.current)return;
    const ord = pendingOrders.find(o => o.referenceNumber === refNum);
    if (!ord) return;

    const myName = currentUser?.fullName || currentUser?.username || 'User';

    if (ord.pickingBy && ord.pickingBy !== myName && activePickerRef !== refNum) {
      setCustomConfirmState({
        type: 'unconfirmed_picking',
        message: `PERINGATAN SINKRONISASI REALTIME:\nDokumen order ${refNum} saat ini sedang DIPICKING oleh "${ord.pickingBy}" di perangkat lain.\n\nPerangkat lain tidak dapat memulai proses picking pada dokumen ini.`,
        onConfirm: () => setCustomConfirmState(null)
      });
      return;
    }

    sessionStartBusy.current=true;setStartingSession(true);setPickingFeedback('');
    try {
      const confirmed=await startConfirmedOrderSession(refNum,{pickingBy:myName,pickingStartedAt:new Date().toISOString()},onUpdateOrderSession);
      setPickingItems([...confirmed].sort((a,b)=>getLocationRank(a.location)-getLocationRank(b.location)));
      setConfirmedPickingIds({});setActivePickerRef(refNum);
    }catch(e){setPickingFeedback(e instanceof Error?e.message:'Sesi picking gagal dimuat. Coba buka ulang order.');}
    finally{sessionStartBusy.current=false;setStartingSession(false);}
  };

  const handleCancelPicking = () => {
    if (activePickerRef && onUpdateOrderSession) {
      onUpdateOrderSession(activePickerRef, {
        pickingBy: null,
        pickingStartedAt: null
      });
    }
    setActivePickerRef(null);
    setPickingItems([]);
    setConfirmedPickingIds({});
  };

  const packingIdentity = async () => {
    if (!SERVER_SCAN_ENABLED || !supabase) throw new Error(scanServerUnavailable);
    const branch = getActiveBranch();
    const {data, error} = await supabase.auth.getUser();
    if (error || !data.user || branch !== getActiveBranch()) throw new Error('Identitas operator atau cabang tidak terverifikasi.');
    return {branch, actor:data.user.id};
  };
  const packingLock = async <T,>(name: string, action: () => Promise<T>): Promise<T> => {
    if (!navigator.locks) throw new Error('Browser tidak mendukung penguncian sesi packing yang aman.');
    return navigator.locks.request(name, {ifAvailable:true}, async held => {
      if (!held) throw new Error('Sesi packing sedang digunakan di tab lain.');
      return action();
    });
  };
  const packingTaskKey = (branch: string, actor: string) => `wms-packing-task-v1:${JSON.stringify([branch, actor])}`;
  const packingController = async (task: NonNullable<typeof packingTask>) => {
    const identity = await packingIdentity();
    if (identity.branch !== task.branch || identity.actor !== task.actor) throw new Error('Operator atau cabang berubah; buka ulang sesi.');
    const key = JSON.stringify([task.branch, task.actor, task.reference]);
    let controller = packingControllers.current.get(key);
    if (!controller) {
      controller = createScanServerSession(serverScanRpc, localStorage, () => crypto.randomUUID(),
        task.branch, task.actor, task.reference, 'packing', packingLock);
      packingControllers.current.set(key, controller);
    }
    return controller;
  };
  const applyPackingProgress = (task: NonNullable<typeof packingTask>, progress: ScanProgress) => {
    if (progress.reference !== task.reference || progress.basket !== task.basket ||
        progress.session.branch !== task.branch || progress.session.phase !== 'packing' || !progress.current) {
      throw new Error('Sesi packing server tidak cocok atau order telah berubah.');
    }
    const order = pendingOrders.find(candidate => candidate.referenceNumber === task.reference);
    if (order && (order.items.length !== progress.counts.length || order.items.some(item =>
      !progress.counts.some(line => line.documentId === item.id && line.required === item.qty &&
        line.sku.trim().toUpperCase() === item.skuId.trim().toUpperCase())))) {
      throw new Error('Baris order tidak cocok dengan sesi server. Muat ulang data.');
    }
    setPackingScannedQty(Object.fromEntries(progress.counts.map(line => [line.documentId, line.scanned])));
    setPackingFinished(false);
    setPackingReady(progress.state === 'open');
  };
  const verifyPackingCompletion = async (task: NonNullable<typeof packingTask>, progress: ScanProgress) => {
    if (progress.state !== 'finished' || !progress.current || !progress.finishRequest) throw new Error('Penyelesaian packing belum dikonfirmasi server.');
    await packingController(task);
    const receipt = await serverScanRpc.receipt(task.branch, task.reference);
    if (receipt.source !== 'packing' || receipt.operationId !== progress.finishRequest) throw new Error('Bukti resi tidak cocok dengan penyelesaian packing.');
    setPackingReady(false); setPackingFinished(true); setPackingScanError(null);
    setPackingScanSuccess(`Packing ${task.reference} dikonfirmasi server. Cetak resi tetap dinonaktifkan.`);
  };
  const recoverPackingTask = async (task: NonNullable<typeof packingTask>) => {
    const controller = await packingController(task);
    let progress = await controller.open(task.basket);
    if (controller.hasPending()) progress = await controller.retry();
    applyPackingProgress(task, progress);
    if (progress.state === 'finished') await verifyPackingCompletion(task, progress);
    else if (progress.state !== 'open') throw new Error('Sesi packing tidak aktif.');
    else { setPackingScanError(null); setPackingScanSuccess('Progres packing dipulihkan dari server.'); }
  };

  React.useEffect(() => {
    if (!SERVER_SCAN_ENABLED || !currentUser || currentUser.role === 'Picker') return;
    let active = true;
    let acquired = false;
    (async () => {
      try {
        const {branch, actor} = await packingIdentity();
        const raw = localStorage.getItem(packingTaskKey(branch, actor));
        if (!raw || !active) return;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Data pemulihan packing tidak valid.');
        const entry = value as Record<string, unknown>;
        if (typeof entry.reference !== 'string' || !entry.reference || typeof entry.basket !== 'string' || !entry.basket) throw new Error('Data pemulihan packing tidak valid.');
        const task = {branch, actor, reference:entry.reference, basket:entry.basket};
        if (!active || packingBusyRef.current) return;
        acquired = true; packingBusyRef.current = true; setPackingBusy(true);
        setPackingTask(task); setActivePackingRef(task.reference);
        await recoverPackingTask(task);
      } catch (error) {
        if (active) { setPackingReady(false); setPackingScanError(error instanceof Error ? error.message : 'Pemulihan packing gagal.'); }
      } finally {
        if (acquired) packingBusyRef.current = false;
        if (active && acquired) setPackingBusy(false);
      }
    })();
    return () => {active = false;};
  }, [currentUser?.username, currentUser?.role]);

  const startPacking = async (ref: string) => {
    if (packingBusyRef.current) return;
    if (!SERVER_SCAN_ENABLED) {
      // Fallback mode: Operasional packing berjalan langsung di perangkat client
      const ord = pendingOrders.find(o => o.referenceNumber === ref);
      if (!ord) return;
      const myName = currentUser?.fullName || currentUser?.username || 'Packer';
      if (onUpdateOrderSession) {
        onUpdateOrderSession(ref, {
          packingBy: myName,
          packingStartedAt: new Date().toISOString()
        }).catch(() => {});
      }
      setActivePackingRef(ref);
      setPackingScannedQty({});
      setPackingScanError(null);
      setPackingScanSuccess(null);
      setPackingManualCode('');
      setPackingFinished(false);
      setPackingReady(true);
      return;
    }
    if (packingTask && !packingFinished) {
      setPackingScanError('Pulihkan atau selesaikan sesi packing sebelumnya.'); return;
    }
    const ord = pendingOrders.find(o => o.referenceNumber === ref);
    const basket = ord?.items[0]?.basketNumber?.trim();
    if (!ord || !basket || ord.items.some(item => item.basketNumber?.trim() !== basket)) {
      setPackingScanError('Order pending atau keranjang sortir tidak konsisten.'); return;
    }
    packingBusyRef.current = true; setPackingBusy(true); setPackingReady(false); setPackingScanError(null);
    try {
      const {branch, actor} = await packingIdentity();
      const task = {branch, actor, reference:ref, basket};
      const key = packingTaskKey(branch, actor);
      await packingLock(key, async () => {
        const existing = localStorage.getItem(key);
        const previous = packingTask && JSON.stringify({reference:packingTask.reference,basket:packingTask.basket});
        if (existing && !(packingFinished && existing === previous)) throw new Error('Sesi packing tersimpan belum dipulihkan.');
        localStorage.setItem(key, JSON.stringify({reference:task.reference,basket:task.basket}));
      });
      setPackingTask(task); setActivePackingRef(ref); setPackingFinished(false); setPackingScanSuccess(null);
      await recoverPackingTask(task);
    } catch (error) {
      setPackingReady(false); setPackingScanError(error instanceof Error ? error.message : 'Sesi packing gagal.');
    } finally { packingBusyRef.current = false; setPackingBusy(false); }
  };
  const cancelPacking = () => {
    if (packingBusyRef.current) return;
    if (activePackingRef && onUpdateOrderSession) {
      onUpdateOrderSession(activePackingRef, {
        packingBy: null,
        packingStartedAt: null
      }).catch(() => {});
    }
    setActivePackingRef(null);
    setPackingScannedQty({});
    setPackingScanError(null);
    setPackingScanSuccess(null);
  };

  const handlePackerEditExpiredDate = async (item: OutboundItem, newExpDate: string) => {
    if (!onEditOrderHistory) return;
    const normalizedEd = normalizeDateToDmy(newExpDate);
    const updatedItem: OutboundItem = {
      ...item,
      expiredDate: normalizedEd
    };
    const success = await onEditOrderHistory(updatedItem, item, true);
    if (success) {
      setPackingScanSuccess(`✓ Expired Date SKU ${item.skuId} berhasil diubah ke ${normalizedEd} sesuai fisik.`);
      setPackingScanError(null);
    } else {
      setPackingScanError(`❌ Gagal mengubah Expired Date.`);
      setPackingScanSuccess(null);
    }
  };

  const confirmPickingCompleted = () => {
    if (!activePickerRef || !onEditOrderHistoryBatch) return;

    // Verify all active items (qty > 0) are confirmed OK by the picker
    const activeItemsToPick = pickingItems.filter(item => item.qty > 0);
    const unconfirmedItems = activeItemsToPick.filter(item => !confirmedPickingIds[item.id]);

    const executeConfirmPicking = async () => {
      if(pickingSaveBusy.current)return;
      pickingSaveBusy.current=true;setSavingPicking(true);setPickingFeedback('');
      try{const success=await onEditOrderHistoryBatch(activePickerRef,pickingItems,true);
       if(success){setActivePickerRef(null);setPickingItems([]);setConfirmedPickingIds({});setActiveModeTab('validate');playFinishSound();}
       else setPickingFeedback('Picking belum tersimpan. Periksa pesan kesalahan; jika versi order berubah, kembali dan buka ulang order untuk memuat data terbaru.');
      }catch(e){setPickingFeedback(e instanceof Error?e.message:'Picking belum tersimpan. Periksa data terbaru.');}
      finally{pickingSaveBusy.current=false;setSavingPicking(false);}
    };

    if (unconfirmedItems.length > 0) {
      setCustomConfirmState({
        type: 'unconfirmed_picking',
        message: `Masih ada ${unconfirmedItems.length} SKU yang belum Anda konfirmasi OK. Apakah Anda yakin ingin melanjutkan dan menyelesaikan picking?`,
        onConfirm: () => {
          executeConfirmPicking();
          setCustomConfirmState(null);
        }
      });
      return;
    }

    executeConfirmPicking();
  };

  const handlePackingScan = async (scannedText: string) => {
    if (packingBusyRef.current) return;
    const barcode = scannedText.trim();
    if (!SERVER_SCAN_ENABLED) {
      if (!barcode || !activePackingRef) return;
      const skuId = findSkuId(barcode) || barcode;
      const orderItems = (orderHistory || []).filter(
        item => item.referenceNumber === activePackingRef && item.status === 'Pending'
      );
      if (orderItems.length === 0) {
        setPackingScanError('Order tidak ditemukan atau sudah selesai.');
        triggerErrorSound();
        return;
      }
      const targetItem = orderItems.find(item => {
        const currentScanned = packingScannedQty[item.id] || 0;
        return item.skuId.toLowerCase() === skuId.toLowerCase() && currentScanned < item.qty;
      });
      if (targetItem) {
        setPackingScannedQty(prev => ({
          ...prev,
          [targetItem.id]: (prev[targetItem.id] || 0) + 1
        }));
        setPackingScanSuccess(`✓ Memindai SKU ${targetItem.skuId} (${targetItem.skuName}) (+1 Pcs)`);
        setPackingScanError(null);
        setPackingManualCode('');
        triggerBeep();
      } else {
        const itemWithSku = orderItems.find(item => item.skuId.toLowerCase() === skuId.toLowerCase());
        if (itemWithSku) {
          setPackingScanError(`❌ SKU ${skuId} sudah lengkap (${itemWithSku.qty}/${itemWithSku.qty} pcs)!`);
        } else {
          setPackingScanError(`❌ SKU ${skuId} tidak terdaftar dalam order ${activePackingRef}!`);
        }
        setPackingScanSuccess(null);
        triggerErrorSound();
      }
      return;
    }
    if (!SERVER_SCAN_ENABLED || !packingTask || !packingReady || !barcode) {
      setPackingScanError(SERVER_SCAN_ENABLED ? 'Pulihkan sesi packing sebelum scan.' : scanServerUnavailable); return;
    }
    packingBusyRef.current = true; setPackingBusy(true);
    try {
      const controller = await packingController(packingTask);
      const progress = await controller.scan(packingTask.basket, barcode);
      applyPackingProgress(packingTask, progress);
      setPackingManualCode(''); setPackingScanError(null); setPackingScanSuccess('Scan dikonfirmasi server.');
      triggerBeep();
    } catch (error) {
      setPackingReady(false); setPackingScanSuccess(null);
      setPackingScanError(error instanceof Error ? error.message : 'Scan belum terkonfirmasi.');
      triggerErrorSound();
    } finally { packingBusyRef.current = false; setPackingBusy(false); }
  };
  const handleRecoverPacking = async () => {
    if (packingBusyRef.current || !SERVER_SCAN_ENABLED || !packingTask) return;
    packingBusyRef.current = true; setPackingBusy(true); setPackingReady(false);
    setActivePackingRef(packingTask.reference);
    try { await recoverPackingTask(packingTask); }
    catch (error) { setPackingScanSuccess(null); setPackingScanError(error instanceof Error ? error.message : 'Pemulihan packing gagal.'); }
    finally { packingBusyRef.current = false; setPackingBusy(false); }
  };
  const confirmPackingCompleted = async () => {
    if (!SERVER_SCAN_ENABLED) {
      const activeOrder = pendingOrders.find(ord => ord.referenceNumber === activePackingRef);
      if (!activeOrder || !onEditOrderHistoryBatch) return;

      const updatedItems = activeOrder.items.map(item => ({
        ...item,
        status: 'Completed' as const,
        scanned: true
      }));

      const success = await onEditOrderHistoryBatch(activePackingRef, updatedItems, false);
      if (success) {
        setLastPackedOrder(activeOrder);
        setActivePackingRef(null);
        setPackingScannedQty({});
        setPackingFinished(true);
        setPackingScanSuccess('✓ Validasi Packing & Scan selesai. Status dokumen diubah ke Completed.');
      }
      return;
    }
    if (packingBusyRef.current || !SERVER_SCAN_ENABLED || !packingTask || !packingReady) return;
    packingBusyRef.current = true; setPackingBusy(true); setPackingReady(false);
    try {
      const controller = await packingController(packingTask);
      const progress = await controller.finish(packingTask.basket);
      applyPackingProgress(packingTask, progress);
      await verifyPackingCompletion(packingTask, progress);
    } catch (error) {
      setPackingScanSuccess(null); setPackingScanError(error instanceof Error ? error.message : 'Penyelesaian belum dikonfirmasi.');
    } finally { packingBusyRef.current = false; setPackingBusy(false); }
  };

  // Sound generator for barcode gun simulation
  const triggerBeep = () => {
    if (!soundEnabled) return;
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(1200, audioCtx.currentTime); // Crisp scanner gun pitch
      gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);

      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.08); // Short 80ms beep
    } catch (e) {
      console.warn('Audio feedback blocked by browser policies', e);
    }
  };

  const triggerErrorSound = () => {
    if (!soundEnabled) return;
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(160, audioCtx.currentTime); // Low error buzz
      gainNode.gain.setValueAtTime(0.12, audioCtx.currentTime);

      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.25); // 250ms buzz
    } catch (e) {
      console.warn(e);
    }
  };

  // Date parsing utility for FEFO sorting
  const parseDateForSort = (dateStr: string): Date => {
    const norm = normalizeDateToDmy(dateStr || '');
    if (!norm || norm === '-' || norm === 'No expired' || norm === 'No Expired' || norm === 'NO ED') {
      return new Date(2050, 0, 1); // Way in the future
    }
    const parts = norm.split('/');
    if (parts.length === 3) {
      const d = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const y = parseInt(parts[2], 10);
      if (!isNaN(d) && !isNaN(m) && !isNaN(y)) {
        return new Date(y, m, d);
      }
    }
    return new Date(2045, 0, 1);
  };

  // Sync scanned items to FEFO engine
  const syncScannedToInputText = (itemsList: { skuId: string; qty: number }[]) => {
    const text = itemsList.map(item => `${item.skuId}\t${item.qty}`).join('\n');
    setInputText(text);
    handleParseDataDirect(text);
  };

  // Parse action with bypass state scope
  const handleParseDataDirect = (text: string, whOverride?: string) => {
    if (!text.trim()) {
      setParsedRows([]);
      return;
    }

    const activeWh = (whOverride || selectedWarehouseId || 'WH-CENTRAL').toUpperCase();
    const poolForWh = availableStockPool
      .filter(item => (item.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh)
      .filter(item => isStockPickable(item));

    const lines = text.split('\n');
    const newParsedRows: ParsedRow[] = [];
    // Clone allocatable stock pool filtered by warehouse
    const stockClone: StockItem[] = JSON.parse(JSON.stringify(poolForWh));

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const parts = trimmed.split(/[\t,;]+/).map(p => p.trim()).filter(p => p);
      const finalParts = parts.length >= 2 ? parts : trimmed.split(/\s+/).map(p => p.trim()).filter(p => p);

      if (finalParts.length < 2) {
        newParsedRows.push({
          skuId: finalParts[0] || 'Unknown',
          qty: 0,
          originalText: trimmed,
          isValid: false,
          error: 'Format tidak valid. Gunakan format SKU [TAB] QTY.',
          allocatedLines: []
        });
        return;
      }

      const skuId = findSkuId(finalParts[0]).toUpperCase();
      const qtyStr = finalParts[1];
      const qty = parseInt(qtyStr, 10);

      if (isNaN(qty) || qty <= 0) {
        newParsedRows.push({
          skuId,
          qty: 0,
          originalText: trimmed,
          isValid: false,
          error: `Kuantitas "${qtyStr}" harus berupa angka bulat positif.`,
          allocatedLines: []
        });
        return;
      }

      // Check matches from allocatable stock pool
      const matches = stockClone.filter(item => 
        item.skuId.toLowerCase() === skuId.toLowerCase() && item.qty > 0
      );

      const physicalMatches = stock.filter(item => 
        (item.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh &&
        item.skuId.toLowerCase() === skuId.toLowerCase() && item.qty > 0
      );
      const totalPhysical = physicalMatches.reduce((sum, item) => sum + item.qty, 0);
      const lockedForSku = lockedStockSummary.byWarehouseSku.get(`${activeWh}__${skuId.toUpperCase()}`) || 0;

      if (matches.length === 0) {
        let errorMsg = `SKU "${skuId}" tidak memiliki stok aktif di gudang terpilih (${activeWh}) atau tidak terdaftar.`;
        if (totalPhysical > 0 && lockedForSku > 0) {
          errorMsg = `SKU "${skuId}" memiliki stok fisik (${totalPhysical} pcs) namun seluruhnya sedang TERKUNCI oleh order pending (${lockedForSku} pcs).`;
        }

        newParsedRows.push({
          skuId,
          qty,
          originalText: trimmed,
          isValid: false,
          error: errorMsg,
          allocatedLines: []
        });
        return;
      }

      const safeAllocatableLocations = matches
        .sort((a, b) => {
          const dateDiff = parseDateForSort(a.expiredDate).getTime() - parseDateForSort(b.expiredDate).getTime();
          if (dateDiff !== 0) return dateDiff;
          return getLocationRank(a.location) - getLocationRank(b.location);
        });

      if (safeAllocatableLocations.length === 0) {
        newParsedRows.push({
          skuId,
          qty,
          originalText: trimmed,
          isValid: false,
          error: `SKU "${skuId}" tidak memiliki stok aktif di lokasi manapun.`,
          allocatedLines: []
        });
        return;
      }

      const totalAvailable = safeAllocatableLocations.reduce((sum, item) => sum + item.qty, 0);
      if (qty > totalAvailable) {
        let errorMsg = `Stok bersih tidak mencukupi! Diminta: ${qty} pcs, Tersedia: ${totalAvailable} pcs.`;
        if (lockedForSku > 0) {
          errorMsg = `Stok bebas tidak mencukupi! Diminta: ${qty} pcs, Tersedia bebas: ${totalAvailable} pcs (Total Fisik: ${totalPhysical} pcs, Terkunci Order Lain: ${lockedForSku} pcs).`;
        }

        newParsedRows.push({
          skuId,
          qty,
          originalText: trimmed,
          isValid: false,
          error: errorMsg,
          allocatedLines: []
        });
        return;
      }

      let remainingToAllocate = qty;
      const allocated: { location: string; expiredDate: string; qtyAllocated: number }[] = [];

      for (const locItem of safeAllocatableLocations) {
        if (remainingToAllocate <= 0) break;
        const take = Math.min(remainingToAllocate, locItem.qty);
        allocated.push({
          location: locItem.location,
          expiredDate: locItem.expiredDate,
          qtyAllocated: take
        });
        locItem.qty -= take;
        remainingToAllocate -= take;
      }

      newParsedRows.push({
        skuId,
        qty,
        originalText: trimmed,
        isValid: true,
        allocatedLines: allocated
      });
    });

    setParsedRows(newParsedRows);
  };

  const handleBarcodeScan = (scannedValue: string) => {
    const trimmed = scannedValue.trim();
    if (!trimmed) return;

    setScannedItemsError(null);
    setScannedItemsSuccess(null);

    // Resolve code (barcode or SKU ID) to clean SKU ID
    const resolvedSkuId = findSkuId(trimmed);
    const activeWh = (selectedWarehouseId || 'WH-CENTRAL').toUpperCase();

    // Check stock presence & availability in selected warehouse
    const matchedPhysical = stock.filter(item => 
      (item.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh &&
      item.skuId.toLowerCase() === resolvedSkuId.toLowerCase() && item.qty > 0
    );

    if (matchedPhysical.length === 0) {
      triggerErrorSound();
      setScannedItemsError(`❌ Kode / Barcode "${trimmed}" tidak memiliki stok aktif di gudang terpilih (${activeWh}).`);
      return;
    }

    const skuName = matchedPhysical[0].skuName;
    const validAllocatable = allocatableOutboundStockPool.filter(item => 
      item.skuId.toLowerCase() === resolvedSkuId.toLowerCase() && item.qty > 0
    );
    const availableQty = validAllocatable.reduce((sum, item) => sum + item.qty, 0);

    const existingCurrentScanned = scannedItems.find(
      item => item.skuId.toLowerCase() === resolvedSkuId.toLowerCase()
    )?.qty || 0;

    if (availableQty <= 0) {
      triggerErrorSound();
      const totalPhysical = matchedPhysical.reduce((sum, item) => sum + item.qty, 0);
      const lockedQty = lockedStockSummary.byWarehouseSku.get(`${activeWh}__${resolvedSkuId.toUpperCase()}`) || 0;
      setScannedItemsError(`❌ Stok SKU "${resolvedSkuId}" tidak tersedia di rak aktif! Total fisik: ${totalPhysical} pcs, namun ${lockedQty} pcs sedang TERKUNCI oleh order pending.`);
      return;
    }

    if (existingCurrentScanned + 1 > availableQty) {
      triggerErrorSound();
      setScannedItemsError(`❌ Kuantitas scan (${existingCurrentScanned + 1} pcs) melebihi sisa stok rak aktif yang dapat diambil (${availableQty} pcs).`);
      return;
    }

    setScannedItems(prev => {
      const existingIdx = prev.findIndex(item => item.skuId.toLowerCase() === resolvedSkuId.toLowerCase());
      let updated = [];
      if (existingIdx >= 0) {
        updated = [...prev];
        updated[existingIdx] = {
          ...updated[existingIdx],
          qty: updated[existingIdx].qty + 1
        };
      } else {
        updated = [
          {
            skuId: resolvedSkuId,
            skuName,
            qty: 1
          },
          ...prev
        ];
      }
      triggerBeep();
      setScannedItemsSuccess(`✓ Scan sukses: ${resolvedSkuId} - ${skuName} (+1 pcs). Sisa bebas: ${availableQty - (existingCurrentScanned + 1)} pcs`);
      syncScannedToInputText(updated);
      return updated;
    });

    setBarcodeSearchInput('');
    if (scanInputRef.current) {
      scanInputRef.current.focus();
    }
  };

  const handleUpdateScannedQty = (skuId: string, newQty: number) => {
    if (newQty <= 0) {
      handleRemoveScannedItem(skuId);
      return;
    }

    const activeWh = (selectedWarehouseId || 'WH-CENTRAL').toUpperCase();
    const matchedPhysical = stock.filter(item => 
      (item.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh &&
      item.skuId.toLowerCase() === skuId.toLowerCase() && item.qty > 0
    );
    const totalPhysical = matchedPhysical.reduce((sum, item) => sum + item.qty, 0);
    const lockedQty = lockedStockSummary.byWarehouseSku.get(`${activeWh}__${skuId.toUpperCase()}`) || 0;
    const validAllocatable = allocatableOutboundStockPool.filter(item =>
      item.skuId.toLowerCase() === skuId.toLowerCase() && item.qty > 0 && isStockPickable(item)
    );
    const availableQty = validAllocatable.reduce((sum, item) => sum + item.qty, 0);

    if (newQty > availableQty) {
      triggerErrorSound();
      setScannedItemsError(`❌ Kuantitas (${newQty} pcs) melebihi stok bersih rak aktif yang tersedia (${availableQty} pcs). Total fisik: ${totalPhysical} pcs, Terkunci: ${lockedQty} pcs.`);
      return;
    }

    setScannedItemsError(null);
    setScannedItems(prev => {
      const updated = prev.map(item => {
        if (item.skuId.toLowerCase() === skuId.toLowerCase()) {
          return { ...item, qty: newQty };
        }
        return item;
      });
      syncScannedToInputText(updated);
      return updated;
    });
  };

  const handleRemoveScannedItem = (skuId: string) => {
    setScannedItems(prev => {
      const updated = prev.filter(item => item.skuId.toLowerCase() !== skuId.toLowerCase());
      syncScannedToInputText(updated);
      return updated;
    });
  };

  const handleParseData = (text: string, whOverride?: string) => {
    setInputText(text);
    handleParseDataDirect(text, whOverride);
  };

  const handleUpdateAllocation = (rowIndex: number, lineIndex: number, newLocation: string, newExpiredDate: string) => {
    if (!isStockPickable({ location: newLocation, expiredDate: newExpiredDate, status: getExpiredStatus(newExpiredDate) })) {
      alert(`⚠️ LOKASI TIDAK LAYAK PICK:\nLokasi "${newLocation}" (Exp: ${newExpiredDate}) berstatus Rusak/Expired/Karantina/Transit dan tidak dapat dialokasikan untuk outbound.`);
      return;
    }

    setParsedRows(prev => prev.map((row, rIdx) => {
      if (rIdx !== rowIndex) return row;
      const updatedLines = row.allocatedLines.map((line, lIdx) => {
        if (lIdx !== lineIndex) return line;
        return {
          ...line,
          location: newLocation,
          expiredDate: newExpiredDate
        };
      });
      return {
        ...row,
        allocatedLines: updatedLines
      };
    }));
  };

  const handleUpdateQty = (rowIndex: number, lineIndex: number, newQty: number) => {
    setParsedRows(prev => prev.map((row, rIdx) => {
      if (rIdx !== rowIndex) return row;
      const updatedLines = row.allocatedLines.map((line, lIdx) => {
        if (lIdx !== lineIndex) return line;
        return {
          ...line,
          qtyAllocated: newQty
        };
      });
      return {
        ...row,
        allocatedLines: updatedLines
      };
    }));
  };

  const handleAddAllocationLine = (rowIndex: number) => {
    const activeWh = (selectedWarehouseId || 'WH-CENTRAL').toUpperCase();
    setParsedRows(prev => prev.map((row, rIdx) => {
      if (rIdx !== rowIndex) return row;
      const matchedStocks = allocatableOutboundStockPool.filter(item => item.skuId.toLowerCase() === row.skuId.toLowerCase() && item.qty > 0 && isStockPickable(item));
      const fallbackStock = stock.filter(item => (item.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh && item.skuId.toLowerCase() === row.skuId.toLowerCase() && isStockPickable(item));
      const firstStock = matchedStocks[0] || fallbackStock[0] || { location: 'E1-01-01', expiredDate: '01/01/2028' };
      return {
        ...row,
        allocatedLines: [
          ...row.allocatedLines,
          {
            location: firstStock.location,
            expiredDate: firstStock.expiredDate,
            qtyAllocated: 0
          }
        ]
      };
    }));
  };

  const handleRemoveAllocationLine = (rowIndex: number, lineIndex: number) => {
    setParsedRows(prev => prev.map((row, rIdx) => {
      if (rIdx !== rowIndex) return row;
      return {
        ...row,
        allocatedLines: row.allocatedLines.filter((_, lIdx) => lIdx !== lineIndex)
      };
    }));
  };

  const handleClear = () => {
    setInputText('');
    setBatchNumberInput('');
    setParsedRows([]);
    setScannedItems([]);
    setScannedItemsError(null);
    setScannedItemsSuccess(null);
    setBarcodeSearchInput('');
  };

  const executeProcessBulk = async (validRows: ParsedRow[]) => {
    // Convert parsed allocations into standard outbound items
    const outboundItemsToProcess: Omit<OutboundItem, 'id' | 'timestamp'>[] = [];
    const targetWarehouseId = selectedWarehouseId || 'WH-CENTRAL';

    validRows.forEach(row => {
      // Find original item metadata to carry SKU Name
      const itemMeta = stock.find(item => item.skuId.toLowerCase() === row.skuId.toLowerCase());
      const skuName = itemMeta ? itemMeta.skuName : `${row.skuId} Product`;

      row.allocatedLines.forEach(alloc => {
        const outItem: Omit<OutboundItem, 'id' | 'timestamp'> = {
          referenceNumber: refNumber,
          skuId: row.skuId,
          skuName,
          expiredDate: alloc.expiredDate,
          qty: alloc.qtyAllocated,
          location: alloc.location,
          scanned: !requirePacking, // if immediate, marked as scanned
          status: requirePacking ? 'Pending' : 'Completed',
          picked: !requirePacking,
          batchNumber: batchNumberInput.trim() || refNumber,
          warehouseId: targetWarehouseId
        };
        if (orderNumber.trim()) outItem.orderNumber = orderNumber.trim();
        if (noPo.trim()) outItem.noPo = noPo.trim();
        if (customerName.trim()) outItem.customerName = customerName.trim();

        outboundItemsToProcess.push(outItem);
      });
    });

    if(!await onProcessOutbound(outboundItemsToProcess))return;
    handleClear();
    setOrderNumber('');
    setBatchNumberInput('');
    setNoPo('');
    setCustomerName('');
    setRefNumber(`OUT-BULK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`);
    
    const msg = requirePacking 
      ? `✓ Sukses! Draft order (${refNumber}) berhasil dibuat. Stok BELUM terpotong sampai Picker menyelesaikan proses picking.`
      : `✓ Sukses! Outbound massal langsung diselesaikan (Completed) & stok terpotong secara real-time.`;
    setBulkProcessSuccess(msg);
    setTimeout(() => {
      setBulkProcessSuccess(null);
    }, 6000);
  };

  const handleProcessBulk = () => {
    setBulkProcessError(null);
    setBulkProcessSuccess(null);

    const validRows = parsedRows.filter(r => r.isValid);
    const invalidRows = parsedRows.filter(r => !r.isValid);

    if (validRows.length === 0) {
      setBulkProcessError('Tidak ada data outbound valid untuk diproses. Silakan input SKU & kuantitas terlebih dahulu.');
      return;
    }

    const overallMismatch = validRows.some(row => {
      const totalAllocated = row.allocatedLines.reduce((sum, line) => sum + line.qtyAllocated, 0);
      return totalAllocated !== row.qty;
    });

    // Check if any allocated line is near expiry (Under 24M / 18M / 6M / 3M)
    const under24Items: { skuId: string; expiredDate: string }[] = [];
    validRows.forEach(row => {
      row.allocatedLines.forEach(line => {
        const status = getExpiredStatus(line.expiredDate);
        if (isNearExpiryStatus(status)) {
          under24Items.push({ skuId: row.skuId, expiredDate: line.expiredDate });
        }
      });
    });

    // If there are warnings, open custom confirm dialog
    if (invalidRows.length > 0 || overallMismatch || under24Items.length > 0) {
      setCustomConfirmState({
        type: 'bulk_outbound',
        details: {
          invalidRowsCount: invalidRows.length,
          overallMismatch,
          under24Items: under24Items.map(item => `${item.skuId} (ED: ${item.expiredDate})`)
        },
        onConfirm: () => {
          executeProcessBulk(validRows);
          setCustomConfirmState(null);
        }
      });
      return;
    }

    // No warnings: execute directly!
    executeProcessBulk(validRows);
  };

  // Compute status totals for preview
  const totalRowsParsed = parsedRows.length;
  const validCount = parsedRows.filter(r => r.isValid).length;
  const invalidCount = parsedRows.filter(r => !r.isValid).length;

  return (
    <div className="space-y-6">
      {pickingFeedback&&<p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{pickingFeedback}</p>}
      {startingSession&&<p role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">Memuat sesi order yang sudah dikonfirmasi server…</p>}
      {savingPicking&&<p role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">Menyimpan picking, tunggu konfirmasi server…</p>}
      {/* Warehouse Selector */}
      <div className="bg-[#11141B] p-4 rounded-xl border border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="text-xs font-bold text-slate-400 uppercase">Pilih Gudang Asal:</label>
          <select
            value={selectedWarehouseId}
            onChange={(e) => {
              const nextWh = e.target.value;
              setSelectedWarehouseId(nextWh);
              if (inputText.trim()) {
                handleParseDataDirect(inputText, nextWh);
              }
            }}
            className="bg-[#161B25] text-white text-sm font-bold px-3 py-2 rounded-lg border border-slate-800 focus:ring-2 focus:ring-emerald-500 outline-none"
          >
            {availableWarehouses.map(w => (
              <option key={w.id} value={w.id}>
                {w.name} — [{describeRouteConfig(w.pickingRouteConfig)}]
              </option>
            ))}
          </select>
        </div>
      </div>
      
      {/* High-level Role-based Navigation Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800 pb-4 gap-4">
        <div className="flex flex-wrap gap-2">
          {currentUser?.role !== 'Packer' && currentUser?.role !== 'Picker' && currentUser?.role !== 'Shipping' && (
            <button
              onClick={() => setActiveModeTab('create')}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all border flex items-center gap-2 cursor-pointer ${
                activeModeTab === 'create'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-500 shadow-md'
                  : 'text-slate-400 hover:text-white bg-[#11141B] border-slate-800/80'
              }`}
            >
              <ClipboardList className="w-4 h-4" />
              <span>1. Input Order Baru (Admin)</span>
            </button>
          )}

          {currentUser?.role !== 'Packer' && currentUser?.role !== 'Shipping' && (
            <button
              onClick={() => setActiveModeTab('pick')}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all border flex items-center gap-2 cursor-pointer relative ${
                activeModeTab === 'pick'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-500 shadow-md'
                  : 'text-slate-400 hover:text-white bg-[#11141B] border-slate-800/80'
              }`}
            >
              <Layers className="w-4 h-4 text-amber-400" />
              <span>2. Pengambilan Barang (Picker)</span>
              {pendingOrders.filter(o => !o.isPicked).length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-slate-950 shadow-sm animate-pulse">
                  {pendingOrders.filter(o => !o.isPicked).length}
                </span>
              )}
            </button>
          )}

          {currentUser?.role !== 'Picker' && currentUser?.role !== 'Shipping' && (
            <button
              onClick={() => setActiveModeTab('validate')}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all border flex items-center gap-2 cursor-pointer relative ${
                activeModeTab === 'validate'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-500 shadow-md'
                  : 'text-slate-400 hover:text-white bg-[#11141B] border-slate-800/80'
              }`}
            >
              <Scan className="w-4 h-4 text-emerald-400" />
              <span>3. Validasi Packing & Scan (Packer)</span>
              {pendingOrders.filter(o => o.isPicked).length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-slate-950 shadow-sm animate-pulse">
                  {pendingOrders.filter(o => o.isPicked).length}
                </span>
              )}
            </button>
          )}

          {currentUser?.role !== 'Packer' && currentUser?.role !== 'Picker' && (
            <button
              onClick={() => setActiveModeTab('history')}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all border flex items-center gap-2 cursor-pointer relative ${
                activeModeTab === 'history'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-500 shadow-md'
                  : 'text-slate-400 hover:text-white bg-[#11141B] border-slate-800/80'
              }`}
            >
              <History className="w-4 h-4 text-emerald-450" />
              <span>4. Riwayat Order</span>
            </button>
          )}

          {currentUser?.role !== 'Picker' && (
            <button
              onClick={() => setActiveModeTab('manifest')}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all border flex items-center gap-2 cursor-pointer relative ${
                activeModeTab === 'manifest'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-500 shadow-md'
                  : 'text-slate-400 hover:text-white bg-[#11141B] border-slate-800/80'
              }`}
            >
              <Truck className="w-4 h-4 text-amber-400" />
              <span>5. Manifest Ekspedisi</span>
              {unmanifestedCompletedCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-slate-950 shadow-sm">
                  {unmanifestedCompletedCount}
                </span>
              )}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 bg-slate-900 border border-slate-800/80 px-3 py-1.5 rounded-lg shrink-0">
          <div className={`h-1.5 w-1.5 rounded-full ${currentUser?.role === 'Packer' ? 'bg-amber-400 animate-pulse' : currentUser?.role === 'Picker' ? 'bg-indigo-400 animate-pulse' : 'bg-emerald-400 animate-pulse'}`}></div>
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">
            Operator: {currentUser?.fullName || 'Simulated User'} ({currentUser?.role || 'Guest'})
          </span>
        </div>
      </div>

      {activeModeTab === 'create' && currentUser?.role !== 'Packer' && currentUser?.role !== 'Picker' && (
        <div className="space-y-6">
          {/* Dynamic Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-white tracking-tight">Penginputan Outbound Massal</h2>
          <p className="text-xs text-slate-400 mt-1">
            Salin & tempel baris dari Microsoft Excel/Google Sheets untuk penulisan data outbound dan otomatisasi alokasi lokasi rute picker.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400 font-semibold uppercase">No. Dokumen:</span>
          <span className="font-mono font-bold text-xs bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-lg text-emerald-400">
            {refNumber}
          </span>
        </div>
      </div>

      {['Administrator', 'Admin'].includes(currentUser?.role || '') && <OrderFileImport stock={stock} orderHistory={orderHistory} warehouseId={selectedWarehouseId || 'WH-CENTRAL'} />}

      {/* Instructions Panel */}
      {showInstructions && (
        <div className="bg-[#161B25] border border-slate-800/80 rounded-xl p-4 relative">
          <button 
            onClick={() => setShowInstructions(false)}
            className="absolute top-3 right-3 text-slate-500 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
          <h4 className="font-bold text-emerald-400 text-xs flex items-center gap-1">
            <HelpCircle className="w-4 h-4" />
            Panduan Format Copy-Paste Excel/Sheets
          </h4>
          <p className="text-xs text-slate-350 mt-1.5 leading-relaxed">
            Gunakan format kolom dari Excel atau Google Sheets berupa: <strong>SKU_ID [TAB] KUANTITAS</strong> (pisahkan antar baris dengan Enter). Sistem akan otomatis mengalokasikan stok berdasarkan rute picker.
          </p>
        </div>
      )}

      {/* Bulk Board Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Input Board */}
        <div className="lg:col-span-5 space-y-4">
          {/* Metadata Outbound */}
          <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md space-y-4">
            <h3 className="text-xs font-bold text-slate-300 uppercase flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              Parameter Dokumen & Outbound
            </h3>
            
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Order Number</label>
                  <input
                    type="text"
                    placeholder="Contoh: ORD-10029"
                    value={orderNumber}
                    onChange={(e) => setOrderNumber(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-indigo-400 uppercase mb-1 flex items-center gap-1">
                    <Boxes className="w-3 h-3" />
                    <span>Nomor Batch</span>
                  </label>
                  <input
                    type="text"
                    placeholder="Contoh: BATCH-OCT-01 (Opsional)"
                    value={batchNumberInput}
                    onChange={(e) => setBatchNumberInput(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs bg-[#161B25] border border-indigo-500/30 text-indigo-200 rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">No PO</label>
                  <input
                    type="text"
                    placeholder="Contoh: PO-9876"
                    value={noPo}
                    onChange={(e) => setNoPo(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Customer Name</label>
                  <input
                    type="text"
                    placeholder="Contoh: PT. Pelanggan"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                  />
                </div>
              </div>

              {/* Require Packing Validation toggle */}
              <div className="pt-2 border-t border-slate-800/45">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={requirePacking}
                    onChange={(e) => setRequirePacking(e.target.checked)}
                    className="rounded border-slate-800 text-emerald-500 focus:ring-emerald-500 bg-[#161B25] w-4 h-4 cursor-pointer"
                  />
                  <div>
                    <span className="text-xs font-bold text-slate-300">Draft · menunggu pengambilan (picking) dan pengemasan (packing)</span>
                    <p className="text-[10px] text-slate-400 leading-none mt-0.5">Stok belum terpotong. Stok akan terpotong setelah Picker menyelesaikan proses picking.</p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Input Box (Bulk Copy-Paste Excel/Sheets OR Scan Barcode Mode) */}
          <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md space-y-4">
            <div className="flex flex-wrap justify-between items-center gap-2">
              <div className="flex items-center gap-1.5 bg-[#161B25] p-1 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setOrderInputMode('bulk')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                    orderInputMode === 'bulk'
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  Bulk Copy-Paste
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOrderInputMode('scan');
                    setTimeout(() => scanInputRef.current?.focus(), 50);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                    orderInputMode === 'scan'
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Scan className="w-3.5 h-3.5" />
                  Scan Barcode / SKU
                </button>
              </div>
              {(inputText || scannedItems.length > 0) && (
                <button
                  onClick={handleClear}
                  className="text-xs font-bold text-rose-450 hover:text-rose-400 flex items-center gap-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Hapus Semua
                </button>
              )}
            </div>

            {orderInputMode === 'bulk' ? (
              <textarea
                value={inputText}
                onChange={(e) => handleParseData(e.target.value)}
                rows={12}
                placeholder="Paste data Excel atau ketik di sini...&#10;Contoh:&#10;1019&#9;20&#10;9144-01&#9;15&#10;HC001&#9;40"
                className="w-full px-4 py-3 text-sm bg-[#161B25] border border-slate-805 rounded-xl font-mono focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-slate-100 outline-none resize-none placeholder:text-slate-500"
              />
            ) : (
              <div className="space-y-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleBarcodeScan(barcodeSearchInput);
                  }}
                  className="flex gap-2"
                >
                  <div className="relative flex-1">
                    <Barcode className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      ref={scanInputRef}
                      type="text"
                      value={barcodeSearchInput}
                      onChange={(e) => setBarcodeSearchInput(e.target.value)}
                      placeholder="Scan barcode atau ketik SKU lalu Enter..."
                      className="w-full pl-9 pr-3 py-2.5 text-sm bg-[#161B25] border border-slate-800 rounded-xl font-mono focus:ring-2 focus:ring-emerald-500 text-white outline-none uppercase"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Tambah
                  </button>
                </form>

                {scannedItemsError && (
                  <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-semibold flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{scannedItemsError}</span>
                  </div>
                )}
                {scannedItemsSuccess && (
                  <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{scannedItemsSuccess}</span>
                  </div>
                )}

                <div className="max-h-[220px] overflow-y-auto divide-y divide-slate-800/60 border border-slate-800 rounded-xl bg-[#161B25] p-2">
                  {scannedItems.length === 0 ? (
                    <p className="text-xs text-slate-500 text-center py-8">
                      Belum ada SKU yang di-scan. Arahkan scanner ke kotak input di atas.
                    </p>
                  ) : (
                    scannedItems.map((item) => (
                      <div key={item.skuId} className="py-2 px-2 flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0 flex-1">
                          <span className="font-mono font-bold text-emerald-400">{item.skuId}</span>
                          <p className="text-slate-300 truncate text-[11px]">{item.skuName}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <input
                            type="number"
                            min={1}
                            value={item.qty}
                            onChange={(e) => handleUpdateScannedQty(item.skuId, parseInt(e.target.value, 10) || 0)}
                            className="w-16 px-2 py-1 text-center font-mono font-bold bg-[#11141B] border border-slate-700 rounded-lg text-white text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveScannedItem(item.skuId)}
                            className="p-1 text-slate-500 hover:text-rose-400 cursor-pointer"
                            title="Hapus item"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Validation Counts Summary */}
            {totalRowsParsed > 0 && (
              <div className="grid grid-cols-3 gap-2 pt-2 text-center">
                <div className="bg-[#161B25] p-2 rounded-lg border border-slate-800">
                  <p className="text-[10px] text-slate-400 font-semibold uppercase">Total Baris</p>
                  <p className="text-base font-bold text-white">{totalRowsParsed}</p>
                </div>
                <div className="bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20 text-emerald-400">
                  <p className="text-[10px] text-emerald-400 font-semibold uppercase">Valid</p>
                  <p className="text-base font-bold">{validCount}</p>
                </div>
                <div className="bg-rose-500/10 p-2 rounded-lg border border-rose-500/20 text-rose-400">
                  <p className="text-[10px] text-rose-450 font-semibold uppercase">Error</p>
                  <p className="text-base font-bold">{invalidCount}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Allocation Results Preview */}
        <div className="lg:col-span-7">
          <div className="bg-[#11141B] rounded-xl border border-slate-800/60 shadow-md h-full flex flex-col min-h-[380px]">
            <div className="p-4 border-b border-slate-800/60 bg-slate-950/40 rounded-t-xl flex justify-between items-center">
              <h3 className="font-bold text-white text-sm flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                Hasil Alokasi Rute Picker Real-Time
              </h3>
              <span className="text-[11px] text-slate-400 font-medium">Validasi Stok Bersih Otomatis</span>
            </div>

            {/* Allocation rows list */}
            <div className="p-4 flex-1 overflow-y-auto max-h-[360px] divide-y divide-slate-800/60">
              {parsedRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-20 text-slate-500 h-full">
                  <Layers className="w-12 h-12 stroke-1 mb-2 text-slate-600" />
                  <p className="text-sm font-bold text-slate-400">Belum Ada Data Di-input</p>
                  <p className="text-xs text-slate-500 mt-1 max-w-[280px]">
                    Ketik atau tempel SKU ID dan Kuantitas di area input untuk melihat visualisasi alokasi lokasi secara instan.
                  </p>
                </div>
              ) : (
                parsedRows.map((row, idx) => {
                  const hasUnder24 = row.allocatedLines.some(line => {
                    const status = getExpiredStatus(line.expiredDate);
                    return isNearExpiryStatus(status);
                  });
                  return (
                    <div key={idx} className="py-3.5 space-y-2">
                      {/* Header Row Status */}
                      <div className="flex justify-between items-start text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`font-mono font-bold px-2 py-0.5 rounded text-xs ${row.isValid ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
                            {row.skuId}
                          </span>
                          <span className="text-slate-400 font-mono">Diminta: <strong className="text-white">{row.qty}</strong> pcs</span>
                          {row.isValid && hasUnder24 && (
                            <span className="flex items-center gap-1 text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 font-extrabold px-1.5 py-0.5 rounded-md animate-pulse">
                              <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                              ED Dekat (&lt;24M)
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2.5">
                          {row.isValid ? (
                            <div className="flex items-center gap-2">
                              {hasUnder24 && (
                                <span className="text-[10px] text-amber-400 font-bold font-mono">ED Dekat!</span>
                              )}
                              <span className="flex items-center gap-1 text-emerald-400 font-bold text-[11px]">
                                <CheckCircle className="w-3.5 h-3.5" />
                                Alokasi Lolos
                              </span>
                            </div>
                          ) : (
                            <span className="flex items-center gap-1 text-rose-400 font-bold text-[11px]" title={row.error}>
                              <AlertTriangle className="w-3.5 h-3.5" />
                              Error Validasi
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              const updated = parsedRows.filter((_, rIdx) => rIdx !== idx);
                              setParsedRows(updated);
                              const newText = updated.map(r => `${r.skuId}\t${r.qty}`).join('\n');
                              setInputText(newText);
                            }}
                            className="p-1 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-md transition-colors cursor-pointer"
                            title="Hapus SKU ini dari daftar"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Allocated locations display or Error line */}
                      {row.isValid ? (
                        <div className="bg-[#161B25] rounded-xl p-3 border border-slate-800 space-y-3">
                          <div className="flex justify-between items-center pb-1.5 border-b border-slate-800/60">
                            <p className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Lokasi Pengambilan Terpilih (Rute Picker):</p>
                            <button
                              type="button"
                              onClick={() => handleAddAllocationLine(idx)}
                              className="text-[10px] text-emerald-400 hover:text-emerald-300 font-extrabold flex items-center gap-1 bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-0.5 rounded cursor-pointer transition-colors"
                            >
                              + Tambah Lokasi
                            </button>
                          </div>

                          <div className="space-y-2.5">
                            {row.allocatedLines.map((alloc, aidx) => {
                              const activeWh = (selectedWarehouseId || 'WH-CENTRAL').toUpperCase();
                              const skuStockOptions = stock.filter(item => 
                                (item.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh &&
                                item.skuId.toLowerCase() === row.skuId.toLowerCase() && item.qty > 0
                              );
                              const allocStatus = getExpiredStatus(alloc.expiredDate);
                              const isLineUnder24 = isNearExpiryStatus(allocStatus);

                              return (
                                <div key={aidx} className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-2.5 rounded-lg border transition-colors ${isLineUnder24 ? 'bg-amber-950/15 border-amber-500/30' : 'bg-slate-950/40 border-slate-800'}`}>
                                  {/* Dropdown Selector */}
                                  <div className="flex-1 min-w-0">
                                    <label className="block text-[9px] text-slate-500 font-bold uppercase mb-0.5">Pilih Lokasi & Exp:</label>
                                    <select
                                      value={`${alloc.location}||${alloc.expiredDate}`}
                                      onChange={(e) => {
                                        const [loc, exp] = e.target.value.split('||');
                                        handleUpdateAllocation(idx, aidx, loc, exp);
                                      }}
                                      className="w-full bg-[#161B25] border border-slate-800 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer font-medium"
                                    >
                                      {!skuStockOptions.some(opt => opt.location === alloc.location && opt.expiredDate === alloc.expiredDate) && (
                                        <option value={`${alloc.location}||${alloc.expiredDate}`}>
                                          {alloc.location} (Exp: {alloc.expiredDate}) - Aktif
                                        </option>
                                      )}
                                      {skuStockOptions.map((opt, oidx) => {
                                        const isUnpickable = !isStockPickable(opt);
                                        const isDamageExp = opt.status === 'Damage' || opt.status === 'Expired';
                                        const breakdown = getItemStockBreakdown(opt, lockedStockSummary);
                                        const lockLabel = breakdown.lockedQty > 0 ? ` (Tersedia: ${breakdown.availableQty} pcs, 🔒 Terkunci: ${breakdown.lockedQty} pcs)` : ` (Stok: ${opt.qty} pcs)`;
                                        return (
                                          <option 
                                            key={oidx} 
                                            value={`${opt.location}||${opt.expiredDate}`}
                                            disabled={isUnpickable}
                                            className={isUnpickable ? 'text-rose-450 bg-slate-900 font-bold' : ''}
                                          >
                                            {opt.location} (Exp: {opt.expiredDate}){isDamageExp ? ` ⛔ [${opt.status}]` : isUnpickable ? ' ⛔ [Non-Pickable/Karantina]' : ''}{lockLabel}
                                          </option>
                                        );
                                      })}
                                    </select>
                                    {isLineUnder24 && (
                                      <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-400 font-extrabold bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-md w-fit">
                                        <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                                        <span>ED di bawah 24 bulan! ({alloc.expiredDate})</span>
                                      </div>
                                    )}
                                  </div>

                                  {/* Qty and Action */}
                                  <div className="flex items-end gap-2.5 shrink-0">
                                    <div>
                                      <label className="block text-[9px] text-slate-500 font-bold uppercase mb-0.5 text-right">Qty Ambil:</label>
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="number"
                                          min="1"
                                          value={alloc.qtyAllocated}
                                          onChange={(e) => {
                                            const val = parseInt(e.target.value, 10);
                                            if (!isNaN(val)) {
                                              handleUpdateQty(idx, aidx, val);
                                            }
                                          }}
                                          className="w-16 bg-[#161B25] border border-slate-800 text-white font-extrabold text-xs text-center rounded-lg py-1 focus:ring-1 focus:ring-emerald-500 outline-none"
                                        />
                                        <span className="text-slate-500 text-xs">pcs</span>
                                      </div>
                                    </div>

                                    {row.allocatedLines.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveAllocationLine(idx, aidx)}
                                        className="p-1.5 text-rose-450 hover:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 rounded-lg transition-colors cursor-pointer"
                                        title="Hapus baris alokasi"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {/* Qty Allocation Warning Banner */}
                          {(() => {
                            const totalAllocated = row.allocatedLines.reduce((sum, l) => sum + l.qtyAllocated, 0);
                            if (totalAllocated !== row.qty) {
                              return (
                                <div className="flex items-center gap-1.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] font-bold px-2.5 py-1.5 rounded-lg">
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                  <span>Alokasi ({totalAllocated} pcs) tidak sama dengan permintaan ({row.qty} pcs)!</span>
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      ) : (
                        <p className="text-xs text-rose-400 font-medium bg-rose-500/10 p-2 rounded-lg border border-rose-500/20">
                          {row.error}
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Summary Actions */}
            {(() => {
              const overallMismatch = parsedRows.some(row => {
                if (!row.isValid) return false;
                const totalAllocated = row.allocatedLines.reduce((sum, line) => sum + line.qtyAllocated, 0);
                return totalAllocated !== row.qty;
              });

              const isButtonDisabled = parsedRows.length === 0 || validCount === 0;

              return (
                <div className="p-4 border-t border-slate-800/60 bg-slate-950/40 rounded-b-xl space-y-2">
                  {overallMismatch && (
                    <p className="text-[11px] text-rose-450 font-semibold text-center bg-rose-500/5 py-1 rounded border border-rose-500/10">
                      ⚠ Ada ketidakcocokan jumlah alokasi SKU dengan kuantitas diminta. Sistem akan memproses sesuai kuantitas alokasi aktual.
                    </p>
                  )}
                  {invalidCount > 0 && (
                    <p className="text-[11px] text-amber-450 font-semibold text-center bg-amber-500/5 py-1 rounded border border-amber-500/10">
                      ⚠ Ada {invalidCount} SKU bermasalah yang akan otomatis diabaikan saat pengiriman.
                    </p>
                  )}
                  {bulkProcessError && (
                    <p className="text-[11px] text-rose-450 font-semibold text-center bg-rose-500/10 py-1.5 px-3 rounded-lg border border-rose-500/20">
                      ⚠ {bulkProcessError}
                    </p>
                  )}
                  {bulkProcessSuccess && (
                    <p className="text-[11px] text-emerald-450 font-semibold text-center bg-emerald-500/10 py-1.5 px-3 rounded-lg border border-emerald-500/20 animate-pulse">
                      {bulkProcessSuccess}
                    </p>
                  )}
                  <button
                    disabled={isButtonDisabled}
                    onClick={handleProcessBulk}
                    className={`w-full py-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-2 transition-all shadow-md cursor-pointer ${isButtonDisabled ? 'bg-slate-800/50 text-slate-600 shadow-none cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-450 text-slate-950 shadow-emerald-500/10'}`}
                  >
                    <CheckCircle className="w-4 h-4" />
                    {overallMismatch 
                      ? `PROSES MASSAL OUTBOUND (${validCount} SKU) - GUNAKAN STOK AKTUAL` 
                      : `PROSES MASSAL OUTBOUND (${validCount} SKU)`}
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  )}

      {/* THE GORGEOUS PICKER RENDER */}
      {activeModeTab === 'pick' && currentUser?.role !== 'Packer' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          {activePickerRef === null ? (
            // LIST OF PENDING ORDERS FOR PICKER
            <div className="space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#11141B] rounded-2xl p-6 border border-slate-800/60 shadow-md">
                <div>
                  <h3 className="text-lg font-extrabold text-white flex items-center gap-2">
                    <Layers className="w-5 h-5 text-amber-400" />
                    Antrean Picking & Pengambilan Barang
                  </h3>
                  <p className="text-slate-400 mt-1 text-xs leading-relaxed">
                    Daftar order outbound yang memerlukan pengambilan fisik barang dari rak/lokasi gudang. Pilih order untuk menentukan atau menyesuaikan lokasi pengambilan beserta kuantitas aktual.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setShowBatchPickingModal(true)}
                    className="px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-extrabold text-xs rounded-xl shadow-lg shadow-indigo-500/20 flex items-center gap-2 cursor-pointer transition-all border border-indigo-400/30"
                  >
                    <Navigation className="w-4 h-4" />
                    Wave / Batch Picking (Rute Terurut)
                  </button>

                  <div className="bg-slate-900 border border-slate-800 px-4 py-2 rounded-xl text-center">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Menunggu Pick</p>
                    <p className="text-lg font-black text-amber-400 font-mono">
                      {pickerPendingOrders.length} Order
                    </p>
                  </div>
                </div>
              </div>

              {pickerPendingOrders.length === 0 ? (
                <div className="bg-[#11141B] border border-slate-800/60 rounded-xl p-12 text-center shadow-lg">
                  <div className="inline-flex p-4 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mb-4">
                    <PackageCheck className="w-10 h-10" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-200">Semua Order Berhasil Dipick!</h4>
                  <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                    Tidak ada antrean picking pending saat ini. Silakan berkoordinasi dengan tim packer.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {pickerPendingOrders.map((ord) => {
                    const myName = currentUser?.fullName || currentUser?.username || 'User';
                    const isBeingPickedByOther = ord.pickingBy && ord.pickingBy !== myName && activePickerRef !== ord.referenceNumber;

                    return (
                      <div 
                        key={ord.referenceNumber}
                        className="bg-[#11141B] border border-slate-800 hover:border-slate-700/80 rounded-xl p-5 shadow-md flex flex-col justify-between transition-all"
                      >
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="font-mono text-xs font-black text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
                              {ord.referenceNumber}
                            </span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {ord.pickingBy && (
                                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-sky-500/15 text-sky-400 border border-sky-500/30 flex items-center gap-1 animate-pulse">
                                  <UserCheck className="w-3 h-3 text-sky-400" />
                                  SEDANG DIPICKING: {ord.pickingBy}
                                </span>
                              )}
                              {ord.isPicked ? (
                                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                                  <Check className="w-3 h-3 text-emerald-400 stroke-[3]" />
                                  SUDAH DIPICKING
                                </span>
                              ) : (
                                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse">
                                  BELUM DIPICKING
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="space-y-1.5 text-xs text-slate-300">
                            <div className="flex justify-between">
                              <span className="text-slate-500 font-medium">Customer:</span>
                              <span className="font-bold text-slate-200">{ord.customerName || 'N/A'}</span>
                            </div>
                            {ord.orderNumber && (
                              <div className="flex justify-between">
                                <span className="text-slate-500 font-medium">No. Order:</span>
                                <span className="font-mono font-bold text-slate-200">{ord.orderNumber}</span>
                              </div>
                            )}
                            {ord.noPo && (
                              <div className="flex justify-between">
                                <span className="text-slate-500 font-medium">No. PO:</span>
                                <span className="font-mono font-bold text-slate-200">{ord.noPo}</span>
                              </div>
                            )}
                            <div className="flex justify-between">
                              <span className="text-slate-500 font-medium">Waktu Order:</span>
                              <span className="font-mono text-slate-400">{new Date(ord.timestamp).toLocaleString('id-ID')}</span>
                            </div>
                          </div>

                          <div className="border-t border-slate-800/60 pt-3 flex items-center justify-between text-xs">
                            <div>
                              <p className="text-[10px] text-slate-550 font-bold uppercase">Detail Item</p>
                              <p className="text-slate-200 font-bold mt-0.5">
                                {ord.items.length} Line Item <span className="text-slate-550">•</span> {ord.totalQty} Pcs
                              </p>
                            </div>
                          </div>
                        </div>

                        {isBeingPickedByOther ? (
                          <div className="mt-4 space-y-1.5">
                            <button
                              disabled
                              className="w-full py-2.5 text-xs font-extrabold rounded-lg flex items-center justify-center gap-2 bg-slate-800 text-slate-400 border border-slate-700/80 cursor-not-allowed opacity-80"
                            >
                              <Lock className="w-3.5 h-3.5 text-amber-400" />
                              Sedang Dipicking oleh {ord.pickingBy}
                            </button>
                            <div className="flex items-center justify-between px-1 text-[10px] text-slate-500">
                              <span className="flex items-center gap-1"><ShieldAlert className="w-3 h-3 text-amber-400/80" /> Terkunci di perangkat lain</span>
                              {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin' || currentUser?.role === 'Manager') && (
                                <button
                                  onClick={() => handleForceReleaseLock(ord.referenceNumber, 'picking')}
                                  className="text-amber-400 hover:underline hover:text-amber-300 font-bold cursor-pointer"
                                >
                                  Reset Lock
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <button
                            disabled={startingSession}
                              onClick={() => void handleStartPicking(ord.referenceNumber)}
                            className={`w-full mt-4 py-2.5 text-xs font-extrabold rounded-lg flex items-center justify-center gap-2 transition-all cursor-pointer shadow-sm ${
                              ord.isPicked
                                ? 'bg-[#1b212f]/30 hover:bg-slate-800 text-slate-300 border border-slate-800'
                                : 'bg-amber-500 hover:bg-amber-450 text-slate-950 shadow-amber-500/10'
                            }`}
                          >
                            <Play className="w-3.5 h-3.5" />
                            {ord.isPicked ? 'Sesuaikan / Edit Lokasi Picking' : 'Mulai Pengambilan (Picking)'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            // ACTIVE PICKING SESSION SCREEN
            (() => {
              const activeOrder = pendingOrders.find(ord => ord.referenceNumber === activePickerRef);
              if (!activeOrder) return null;

              // Aggregate target quantities per SKU
              const targetSkuQtys: { [sku: string]: number } = {};
              activeOrder.items.forEach(it => {
                targetSkuQtys[it.skuId] = (targetSkuQtys[it.skuId] || 0) + it.qty;
              });

              // Aggregate current picked quantities per SKU from pickingItems local state
              const pickedSkuQtys: { [sku: string]: number } = {};
              pickingItems.forEach(it => {
                pickedSkuQtys[it.skuId] = (pickedSkuQtys[it.skuId] || 0) + it.qty;
              });

              return (
                <div className="relative pb-24 lg:pb-0">
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-200">
                  {/* Left Column: List of items to pick */}
                  <div className="lg:col-span-8 space-y-4">
                    <div className="bg-[#11141B] rounded-xl border border-slate-800 p-4 sm:p-5 space-y-4">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                        <button
                          onClick={handleCancelPicking}
                          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-bold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                        >
                          <ArrowLeft className="w-4 h-4" />
                          Kembali
                        </button>

                        {/* Hide Confirmed Toggle */}
                        <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-slate-400 hover:text-white font-medium bg-[#161B25] px-3 py-1.5 rounded-lg border border-slate-850">
                          <input
                            type="checkbox"
                            checked={hideConfirmedPicker}
                            onChange={(e) => setHideConfirmedPicker(e.target.checked)}
                            className="rounded border-slate-800 text-amber-500 focus:ring-amber-500 bg-[#11141B] w-4 h-4 cursor-pointer"
                          />
                          Sembunyikan Selesai (OK)
                        </label>

                        <div className="text-right">
                          <p className="text-[10px] font-bold text-slate-500 uppercase">Sesi Dokumen Picking</p>
                          <p className="font-mono text-xs font-extrabold text-amber-400">{activePickerRef}</p>
                        </div>
                      </div>

                      {/* Mobile Warning/Tips Banner */}
                      <div className="block lg:hidden bg-amber-500/10 border border-amber-500/20 text-amber-400 p-3 rounded-lg text-[11px] leading-relaxed">
                        💡 <strong>Mode HP Aktif:</strong> Gunakan tombol <span className="font-extrabold text-white">-</span> dan <span className="font-extrabold text-white">+</span> untuk merubah kuantitas tanpa mengetik. Klik tombol <strong>OK</strong> saat selesai di setiap item.
                      </div>

                      <div className="divide-y divide-slate-800/60 space-y-4">
                        {pickingItems
                          .map((item, originalIdx) => ({ item, originalIdx }))
                          .filter(({ item }) => !hideConfirmedPicker || !confirmedPickingIds[item.id])
                          .map(({ item, originalIdx }) => {
                            const itemWh = (item.warehouseId || 'WH-CENTRAL').toUpperCase();
                            const skuStockOptions = stock.filter(s => 
                              (s.warehouseId || 'WH-CENTRAL').toUpperCase() === itemWh &&
                              s.skuId.toLowerCase() === item.skuId.toLowerCase() && 
                              s.qty > 0 &&
                              s.status !== 'Damage' && s.status !== 'Expired'
                            ).sort((a, b) => getLocationRank(a.location) - getLocationRank(b.location));

                            return (
                              <div key={item.id} className="pt-4 first:pt-0 space-y-3">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-xs font-extrabold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/15">
                                      {item.skuId}
                                    </span>
                                    <h4 className="text-xs font-bold text-slate-200">{item.skuName}</h4>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const targetTotal = targetSkuQtys[item.skuId] || item.qty;

                                        // Find unused or next stock option for new split line
                                        const unusedOpt = skuStockOptions.find(opt => 
                                          !(opt.location === item.location && opt.expiredDate === item.expiredDate)
                                        ) || skuStockOptions[0];

                                        const newLoc = unusedOpt ? unusedOpt.location : item.location;
                                        const newExp = unusedOpt ? unusedOpt.expiredDate : item.expiredDate;

                                        // Calculate sum of other split lines for this SKU excluding parent item
                                        const otherLinesSum = pickingItems
                                          .filter(p => p.skuId === item.skuId && p.id !== item.id)
                                          .reduce((s, p) => s + p.qty, 0);

                                        const remainingNeeded = Math.max(0, targetTotal - (otherLinesSum + item.qty));
                                        const newSplitQty = remainingNeeded > 0 ? remainingNeeded : 0;

                                        const newSplit: OutboundItem = {
                                          ...item,
                                          id: `temp_pick_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
                                          location: newLoc,
                                          expiredDate: newExp,
                                          qty: newSplitQty,
                                          picked: true
                                        };

                                        setPickingItems(prev => {
                                          const next = [...prev];
                                          const parentIdx = next.findIndex(p => p.id === item.id);
                                          if (parentIdx !== -1) {
                                            next.splice(parentIdx + 1, 0, newSplit);
                                          }
                                          return next;
                                        });
                                      }}
                                      className="px-2 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-[10px] font-bold rounded border border-emerald-500/20 transition-all cursor-pointer"
                                    >
                                      + Split Lokasi
                                    </button>

                                  {pickingItems.filter(p => p.skuId === item.skuId).length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setPickingItems(prev => prev.filter(p => p.id !== item.id));
                                      }}
                                      className="p-1 text-rose-450 hover:text-rose-400 bg-rose-500/10 rounded transition-all cursor-pointer"
                                      title="Hapus baris split ini"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                                <div className={`grid grid-cols-1 md:grid-cols-3 gap-3.5 p-3 sm:p-4 rounded-xl border transition-all ${
                                  confirmedPickingIds[item.id]
                                    ? 'bg-emerald-950/15 border-emerald-500/40 shadow-md shadow-emerald-500/5'
                                    : 'bg-slate-950/40 border-slate-850/60'
                                }`}>
                                  {/* Choose Location */}
                                  <div>
                                    <label className="block text-[9px] text-slate-400 font-bold uppercase mb-1">
                                      Lokasi Rak Gudang Ambil:
                                    </label>
                                    <select
                                      value={`${item.location}||${item.expiredDate}`}
                                      onChange={(e) => {
                                        const [loc, exp] = e.target.value.split('||');
                                        setPickingItems(prev => prev.map(p => {
                                          if (p.id !== item.id) return p;
                                          return { ...p, location: loc, expiredDate: exp };
                                        }));
                                      }}
                                      className="w-full h-[40px] bg-[#11141B] border border-slate-800 text-slate-200 text-xs rounded-lg px-2.5 py-1.5 focus:ring-1 focus:ring-amber-500 outline-none cursor-pointer font-bold"
                                    >
                                      {!skuStockOptions.some(opt => opt.location === item.location && opt.expiredDate === item.expiredDate) && (
                                        <option value={`${item.location}||${item.expiredDate}`}>
                                          Rak {item.location} (Exp: {item.expiredDate})
                                        </option>
                                      )}
                                      {skuStockOptions.map((opt, oidx) => (
                                        <option key={oidx} value={`${opt.location}||${opt.expiredDate}`}>
                                          Rak {opt.location} (Exp: {opt.expiredDate}) - Stok: {opt.qty} pcs
                                        </option>
                                      ))}
                                    </select>
                                  </div>

                                  {/* Choose quantity with elegant plus/minus buttons */}
                                  <div>
                                    <label className="block text-[9px] text-slate-400 font-bold uppercase mb-1">
                                      Kuantitas Diambil (Pcs):
                                    </label>
                                    <div className="flex items-center bg-[#11141B] border border-slate-800 rounded-lg p-0.5 w-full h-[40px]">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setPickingItems(prev => prev.map(p => p.id === item.id ? { ...p, qty: Math.max(0, p.qty - 1) } : p));
                                        }}
                                        className="w-10 h-full flex items-center justify-center text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-750 rounded-md transition-colors cursor-pointer text-sm font-black active:scale-90 shrink-0"
                                      >
                                        -
                                      </button>
                                      <input
                                        type="number"
                                        min="0"
                                        value={item.qty}
                                        onChange={(e) => {
                                          const val = parseInt(e.target.value, 10);
                                          if (!isNaN(val)) {
                                            setPickingItems(prev => prev.map(p => p.id === item.id ? { ...p, qty: Math.max(0, val) } : p));
                                          }
                                        }}
                                        className="w-full h-full bg-transparent text-white font-extrabold text-xs text-center outline-none font-mono focus:ring-0 border-none"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setPickingItems(prev => prev.map(p => p.id === item.id ? { ...p, qty: p.qty + 1 } : p));
                                        }}
                                        className="w-10 h-full flex items-center justify-center text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-750 rounded-md transition-colors cursor-pointer text-sm font-black active:scale-90 shrink-0"
                                      >
                                        +
                                      </button>
                                    </div>
                                  </div>

                                  {/* SKU Confirmation OK Button */}
                                  <div className="flex items-end">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const nextState = !confirmedPickingIds[item.id];
                                        setConfirmedPickingIds(prev => ({
                                          ...prev,
                                          [item.id]: nextState
                                        }));
                                        if (nextState) {
                                          playFinishSound();
                                        }
                                      }}
                                      className={`w-full h-[40px] px-3 text-xs font-bold rounded-lg border transition-all flex items-center justify-center gap-2 cursor-pointer ${
                                        confirmedPickingIds[item.id]
                                          ? 'bg-emerald-500 text-slate-950 border-emerald-500 hover:bg-emerald-450 shadow-md shadow-emerald-500/10 font-extrabold'
                                          : 'bg-[#11141B] hover:bg-slate-800 text-slate-300 border-slate-800'
                                      }`}
                                    >
                                      {confirmedPickingIds[item.id] ? (
                                        <>
                                          <CheckCircle className="w-4 h-4 text-slate-950 shrink-0" />
                                          <span>SUDAH OK</span>
                                        </>
                                      ) : (
                                        <>
                                          <Circle className="w-4 h-4 text-slate-500 shrink-0" />
                                          <span>KONFIRMASI OK</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>
                              </div>                           </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Right Column (Desktop Only / Sidebar) */}
                  <div className="hidden lg:block lg:col-span-4 space-y-4">
                    <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800 shadow-md space-y-4 sticky top-24">
                      <div>
                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider mb-2">
                          Ringkasan Target vs Hasil Pick
                        </h3>
                        <p className="text-[11px] text-slate-500 leading-relaxed mb-4">
                          Semua SKU harus diambil sesuai dengan jumlah total target order sebelum mengkonfirmasi.
                        </p>
                      </div>

                      <div className="space-y-2 max-h-[280px] overflow-y-auto divide-y divide-slate-800/40 pr-1">
                        {Object.keys(targetSkuQtys).map(sku => {
                          const target = targetSkuQtys[sku];
                          const picked = pickedSkuQtys[sku] || 0;
                          const isMatch = target === picked;

                          return (
                            <div key={sku} className="pt-2 first:pt-0 flex items-center justify-between text-xs">
                              <div>
                                <span className="font-mono font-bold text-slate-200">{sku}</span>
                              </div>
                              <div className="flex items-center gap-2 text-right">
                                <span className="font-mono font-bold">
                                  <span className={isMatch ? 'text-emerald-400' : picked > target ? 'text-blue-400' : 'text-amber-500'}>
                                    {picked}
                                  </span>
                                  <span className="text-slate-550"> / {target} Pcs</span>
                                </span>
                                {isMatch ? (
                                  <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[9px] font-black uppercase">
                                    Cukup
                                  </span>
                                ) : (
                                  <span className="bg-amber-500/10 border border-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded text-[9px] font-black uppercase">
                                    Selisih
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* SKU Confirmation Progress */}
                      <div className="bg-[#161B25] p-3.5 rounded-xl border border-slate-800/80 text-xs space-y-2">
                        <div className="flex justify-between font-bold text-[10px] text-slate-400">
                          <span className="uppercase">Progress Konfirmasi SKU OK:</span>
                          <span className="font-mono text-emerald-400 font-extrabold text-[11px]">
                            {pickingItems.filter(item => item.qty > 0 && confirmedPickingIds[item.id]).length} / {pickingItems.filter(item => item.qty > 0).length} baris lokasi
                          </span>
                        </div>
                        <div className="w-full bg-slate-850 h-1.5 rounded-full overflow-hidden">
                          <div 
                            className="bg-emerald-400 h-full transition-all duration-300"
                            style={{ 
                              width: `${(pickingItems.filter(item => item.qty > 0).length > 0) 
                                ? (pickingItems.filter(item => item.qty > 0 && confirmedPickingIds[item.id]).length / pickingItems.filter(item => item.qty > 0).length) * 100 
                                : 0}%` 
                            }}
                          />
                        </div>
                      </div>

                      <button
                        disabled={savingPicking||startingSession}
                        onClick={confirmPickingCompleted}
                        className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 rounded-xl text-xs font-extrabold flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-500/10 font-black tracking-wider uppercase cursor-pointer"
                      >
                        <PackageCheck className="w-4 h-4" />
                        Selesaikan pengambilan · lanjut pengemasan
                      </button>
                    </div>
                  </div>
                </div>

                {/* MOBILE-ONLY STICKY BOTTOM BAR */}
                <div className="fixed bottom-0 left-0 right-0 z-45 bg-[#11141B]/95 backdrop-blur-md border-t border-slate-800 p-4 block lg:hidden shadow-2xl">
                  <div className="flex items-center justify-between gap-3 max-w-xl mx-auto">
                    <div className="flex flex-col">
                      <span className="text-[9px] text-slate-400 uppercase font-black tracking-wider">Progress OK</span>
                      <span className="text-xs font-black text-amber-400 font-mono">
                        {pickingItems.filter(item => item.qty > 0 && confirmedPickingIds[item.id]).length} / {pickingItems.filter(item => item.qty > 0).length} baris lokasi
                      </span>
                    </div>

                    <div className="flex items-center gap-2 flex-1 justify-end">
                      <button
                        type="button"
                        onClick={() => setShowMobilePickingSummary(true)}
                        className="p-3 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded-xl border border-slate-700 transition-colors flex items-center justify-center cursor-pointer active:scale-95 animate-pulse"
                        title="Tampilkan Ringkasan Detail"
                      >
                        <ClipboardList className="w-5 h-5" />
                      </button>

                      <button
                        type="button"
                        disabled={savingPicking||startingSession}
                        onClick={confirmPickingCompleted}
                        className="flex-1 max-w-[200px] py-3 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-black text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-md active:scale-95 cursor-pointer uppercase tracking-wider font-black"
                      >
                        <PackageCheck className="w-4 h-4" />
                        <span>Kirim</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* MOBILE-ONLY DETAIL SUMMARY OVERLAY DIALOG */}
                {showMobilePickingSummary && (
                  <>
                    <div
                      className="fixed inset-0 bg-black/60 z-50 cursor-pointer"
                      onClick={() => setShowMobilePickingSummary(false)}
                    />
                    <div
                      className="fixed bottom-0 left-0 right-0 max-h-[85vh] bg-[#11141B] border-t border-slate-800 rounded-t-3xl p-6 z-50 flex flex-col justify-between shadow-2xl overflow-hidden"
                    >
                      <div className="flex flex-col overflow-y-auto flex-1 pb-4">
                        <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                          <div>
                            <h3 className="text-sm font-black text-white uppercase tracking-wider">
                              Ringkasan Target vs Hasil Pick
                            </h3>
                            <p className="text-[10px] text-slate-550">Target vs Qty yang telah diambil</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowMobilePickingSummary(false)}
                            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-850 cursor-pointer"
                          >
                            <X className="w-5 h-5" />
                          </button>
                        </div>

                        <div className="space-y-3 divide-y divide-slate-800/40">
                          {Object.keys(targetSkuQtys).map(sku => {
                            const target = targetSkuQtys[sku];
                            const picked = pickedSkuQtys[sku] || 0;
                            const isMatch = target === picked;

                            return (
                              <div key={sku} className="pt-3 first:pt-0 flex items-center justify-between text-xs">
                                <div>
                                  <span className="font-mono font-bold text-slate-200">{sku}</span>
                                </div>
                                <div className="flex items-center gap-2 text-right">
                                  <span className="font-mono font-bold">
                                    <span className={isMatch ? 'text-emerald-400' : picked > target ? 'text-blue-400' : 'text-amber-500'}>
                                      {picked}
                                    </span>
                                    <span className="text-slate-550"> / {target} Pcs</span>
                                  </span>
                                  {isMatch ? (
                                    <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[9px] font-black uppercase">
                                      Cukup
                                    </span>
                                  ) : (
                                    <span className="bg-amber-500/10 border border-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded text-[9px] font-black uppercase">
                                      Selisih
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* SKU Confirmation Progress */}
                        <div className="bg-[#161B25] p-3.5 rounded-xl border border-slate-800/80 text-xs space-y-2 mt-6">
                          <div className="flex justify-between font-bold text-[10px] text-slate-400">
                            <span className="uppercase">Progress Konfirmasi SKU OK:</span>
                            <span className="font-mono text-emerald-400 font-extrabold text-[11px]">
                              {pickingItems.filter(item => item.qty > 0 && confirmedPickingIds[item.id]).length} / {pickingItems.filter(item => item.qty > 0).length} baris lokasi
                            </span>
                          </div>
                          <div className="w-full bg-slate-850 h-1.5 rounded-full overflow-hidden">
                            <div 
                              className="bg-emerald-400 h-full transition-all duration-300"
                              style={{ 
                                width: `${(pickingItems.filter(item => item.qty > 0).length > 0) 
                                  ? (pickingItems.filter(item => item.qty > 0 && confirmedPickingIds[item.id]).length / pickingItems.filter(item => item.qty > 0).length) * 100 
                                  : 0}%` 
                              }}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="pt-4 border-t border-slate-800 bg-[#11141B]">
                        <button
                          onClick={() => {
                            setShowMobilePickingSummary(false);
                            confirmPickingCompleted();
                          }}
                          className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all uppercase tracking-wider cursor-pointer font-black"
                        >
                          <PackageCheck className="w-4 h-4" />
                          Selesaikan pengambilan · lanjut pengemasan
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })()
          )}
        </div>
      )}

      {/* THE GORGEOUS PACKING VALIDATION RENDER */}
      {activeModeTab === 'validate' && currentUser?.role !== 'Picker' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          {packingScanError && <p role="alert" className="rounded-lg bg-red-100 p-3 text-sm text-red-900">{packingScanError}</p>}
          {packingScanSuccess && <p role="status" className="rounded-lg bg-emerald-100 p-3 text-sm text-emerald-900">{packingScanSuccess}</p>}
          {packingTask && SERVER_SCAN_ENABLED && (
            <button type="button" onClick={handleRecoverPacking} disabled={packingBusy}
              className="px-3 py-2 text-xs font-bold rounded-lg bg-slate-700 text-white disabled:opacity-50">
              Pulihkan sesi packing {packingTask.reference}
            </button>
          )}
          {activePackingRef === null ? (
            // LIST OF PENDING ORDERS
            <div className="space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#11141B] rounded-2xl p-6 border border-slate-800/60 shadow-md">
                <div>
                  <h3 className="text-lg font-extrabold text-white flex items-center gap-2">
                    <PackageOpen className="w-5 h-5 text-amber-400" />
                    Antrean Packing & Scan Barang
                  </h3>
                  <p className="text-slate-400 mt-1 text-xs leading-relaxed">
                    Berikut adalah daftar dokumen order outbound (Pending) yang diinput oleh Administrator. Packer wajib memindai setiap item fisik untuk validasi SKU dan kuantitas sebelum dikirim.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="bg-slate-900 border border-slate-800 px-4 py-2 rounded-xl text-center">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Total Antrean</p>
                    <p className="text-lg font-black text-amber-400 font-mono">{packerPendingOrders.length} Order</p>
                  </div>
                </div>
              </div>

              {packerPendingOrders.length === 0 ? (
                <div className="bg-[#11141B] border border-slate-800/60 rounded-xl p-12 text-center shadow-lg">
                  <div className="inline-flex p-4 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mb-4">
                    <PackageCheck className="w-10 h-10" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-200">Luar Biasa! Semua Order Telah Selesai Dikemas</h4>
                  <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                    Tidak ada antrean order outbound berstatus Siap dikemas saat ini. Pekerjaan Anda terselesaikan dengan rapi!
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {packerPendingOrders.map((ord) => {
                    return (
                      <div 
                        key={ord.referenceNumber}
                        className="bg-[#11141B] border border-slate-800 hover:border-slate-700/80 rounded-xl p-5 shadow-md flex flex-col justify-between transition-all"
                      >
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="font-mono text-xs font-black text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
                              {ord.referenceNumber}
                            </span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {ord.packingBy && (
                                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-purple-500/15 text-purple-300 border border-purple-500/30 flex items-center gap-1 animate-pulse">
                                  <UserCheck className="w-3 h-3 text-purple-400" />
                                  SEDANG DIPACKING: {ord.packingBy}
                                </span>
                              )}
                              {ord.isPicked ? (
                                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                                  <Check className="w-3 h-3 text-emerald-400 stroke-[3]" />
                                  READY TO PACK
                                </span>
                              ) : (
                                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse">
                                  AWAITING PICKING
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="space-y-1.5 text-xs text-slate-300">
                            <div className="flex justify-between">
                              <span className="text-slate-500 font-medium">Customer:</span>
                              <span className="font-bold text-slate-200">{ord.customerName || 'N/A'}</span>
                            </div>
                            {ord.orderNumber && (
                              <div className="flex justify-between">
                                <span className="text-slate-500 font-medium">No. Order:</span>
                                <span className="font-mono font-bold text-slate-200">{ord.orderNumber}</span>
                              </div>
                            )}
                            {ord.noPo && (
                              <div className="flex justify-between">
                                <span className="text-slate-500 font-medium">No. PO:</span>
                                <span className="font-mono font-bold text-slate-200">{ord.noPo}</span>
                              </div>
                            )}
                            <div className="flex justify-between">
                              <span className="text-slate-500 font-medium">Tanggal Masuk:</span>
                              <span className="font-mono text-slate-400">{new Date(ord.timestamp).toLocaleString('id-ID')}</span>
                            </div>
                          </div>

                          <div className="border-t border-slate-800/60 pt-3 flex items-center justify-between text-xs">
                            <div>
                              <p className="text-[10px] text-slate-550 font-bold uppercase">Detail Item</p>
                              <p className="text-slate-200 font-bold mt-0.5">
                                {new Set(ord.items.map(i => i.skuId)).size} SKU <span className="text-slate-550">•</span> {ord.totalQty} Pcs
                              </p>
                            </div>
                          </div>
                        </div>

                          <button
                            onClick={() => startPacking(ord.referenceNumber)}
                            disabled={packingBusy || (SERVER_SCAN_ENABLED && !!(packingTask && !packingFinished))}
                            className="w-full mt-4 py-2.5 bg-[#161B25] hover:bg-emerald-500 hover:text-slate-950 border border-slate-800 hover:border-emerald-500 text-slate-350 text-xs font-extrabold rounded-lg flex items-center justify-center gap-2 transition-all cursor-pointer shadow-sm group"
                          >
                            <Play className="w-3.5 h-3.5 text-emerald-400 group-hover:text-slate-950" />
                            Mulai Packing & Scan Barang
                          </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            // ACTIVE PACKING STATION
            (() => {
              const activeOrder = pendingOrders.find(ord => ord.referenceNumber === activePackingRef);
              if (!activeOrder) return (
                <div className="rounded-xl bg-slate-800 p-4 text-sm text-white">
                  Order {activePackingRef} tidak lagi ada dalam daftar pending.
                  <button type="button" onClick={cancelPacking} disabled={packingBusy} className="ml-3 underline">Kembali</button>
                </div>
              );

              // Sort active order items by picking location sequence (getLocationRank)
              const sortedActiveOrderItems = [...activeOrder.items].sort((a, b) => {
                const rankA = getLocationRank(a.location || '', activeRouteConfig);
                const rankB = getLocationRank(b.location || '', activeRouteConfig);
                if (rankA !== rankB) return rankA - rankB;
                const locComp = (a.location || '').localeCompare(b.location || '');
                if (locComp !== 0) return locComp;
                return (a.skuId || '').localeCompare(b.skuId || '');
              });

              // Group items by exact SKU ID preserving Picker route order
              const map = new Map<string, {
                skuId: string;
                skuName: string;
                items: OutboundItem[];
                totalQty: number;
                locations: string[];
                expiredDates: string[];
              }>();

              sortedActiveOrderItems.forEach(item => {
                const key = item.skuId;
                if (!map.has(key)) {
                  map.set(key, {
                    skuId: item.skuId,
                    skuName: item.skuName,
                    items: [item],
                    totalQty: item.qty,
                    locations: item.location ? [item.location] : [],
                    expiredDates: item.expiredDate ? [item.expiredDate] : []
                  });
                } else {
                  const existing = map.get(key)!;
                  existing.items.push(item);
                  existing.totalQty += item.qty;
                  if (item.location && !existing.locations.includes(item.location)) {
                    existing.locations.push(item.location);
                  }
                  if (item.expiredDate && !existing.expiredDates.includes(item.expiredDate)) {
                    existing.expiredDates.push(item.expiredDate);
                  }
                }
              });

              const mergedPackerItems = Array.from(map.values()).map(merged => {
                merged.locations.sort((a, b) => getLocationRank(a, activeRouteConfig) - getLocationRank(b, activeRouteConfig));
                return merged;
              });

              mergedPackerItems.sort((a, b) => {
                const minRankA = a.locations.length > 0 ? Math.min(...a.locations.map(loc => getLocationRank(loc, activeRouteConfig))) : 10000;
                const minRankB = b.locations.length > 0 ? Math.min(...b.locations.map(loc => getLocationRank(loc, activeRouteConfig))) : 10000;
                if (minRankA !== minRankB) return minRankA - minRankB;
                const locA = a.locations[0] || '';
                const locB = b.locations[0] || '';
                const locComp = locA.localeCompare(locB);
                if (locComp !== 0) return locComp;
                return a.skuId.localeCompare(b.skuId);
              });
              const totalOrderLines = mergedPackerItems.length;
              const totalOrderPcs = activeOrder.totalQty;
              
              let totalScannedPcs = 0;
              let completedSkuCount = 0;
              mergedPackerItems.forEach(merged => {
                const scanned = merged.items.reduce((sum, sub) => sum + (packingScannedQty[sub.id] || 0), 0);
                totalScannedPcs += scanned;
                if (scanned === merged.totalQty) {
                  completedSkuCount++;
                }
              });

              const overallPercent = Math.round((totalScannedPcs / totalOrderPcs) * 100) || 0;
              const isFullyPacked = completedSkuCount === totalOrderLines;

              return (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in zoom-in-95 duration-150">
                  <div className="lg:col-span-12 rounded-xl bg-slate-900 border border-slate-800 p-3 text-xs font-bold text-slate-300 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle className="w-4 h-4" />
                      Stasiun Packing Aktif — Validasi barcode fisik 100% sebelum serah terima kurir.
                    </span>
                    <span className="font-mono text-amber-400 text-[11px] hidden sm:inline">
                      Alur Rak Gudang: {describeRouteConfig(activeRouteConfig)} ({activeWarehouse?.name})
                    </span>
                  </div>
                  {/* Left Column: Items Checklist */}
                  <div className="lg:col-span-7 space-y-4">
                    <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md flex items-center justify-between">
                      <button
                        onClick={cancelPacking}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        Kembali
                      </button>
                      <div className="text-right">
                        <span className="text-[10px] font-bold text-slate-550 uppercase">PACKING STATION ORDER</span>
                        <h4 className="font-mono text-sm font-black text-emerald-400">{activePackingRef}</h4>
                      </div>
                    </div>

                    <div className="bg-[#11141B] rounded-xl border border-slate-800/60 overflow-hidden shadow-md">
                      <div className="bg-[#151922] px-5 py-3 border-b border-slate-800/80 flex justify-between items-center">
                        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">SKU yang Harus Dikemas</h3>
                        <span className="text-xs font-extrabold text-amber-400 font-mono bg-amber-450/5 border border-amber-400/20 px-2.5 py-0.5 rounded">
                          {completedSkuCount} / {totalOrderLines} SKU Terpenuhi
                        </span>
                      </div>

                      <div className="p-4 space-y-3.5 max-h-[550px] overflow-y-auto divide-y divide-slate-800/40">
                        {(() => {
                          const activePackerList = mergedPackerItems.filter(m => {
                            const sc = m.items.reduce((s, x) => s + (packingScannedQty[x.id] || 0), 0);
                            return sc < m.totalQty;
                          });

                          if (activePackerList.length === 0) {
                            return (
                              <div className="py-12 text-center text-slate-400 flex flex-col items-center justify-center">
                                <CheckCircle className="w-12 h-12 text-emerald-400 mb-2 animate-bounce" />
                                <p className="font-bold text-sm text-slate-200">Semua SKU Telah Selesai Dikemas!</p>
                                <p className="text-xs text-slate-500 mt-1">Silakan konfirmasi penyelesaian order & cetak resi pada panel sebelah kanan.</p>
                              </div>
                            );
                          }

                          return activePackerList.map((merged) => {
                          const scannedVal = merged.items.reduce((sum, sub) => sum + (packingScannedQty[sub.id] || 0), 0);
                          const isDone = scannedVal === merged.totalQty;
                          const percent = Math.min(100, Math.round((scannedVal / merged.totalQty) * 100));

                          const locationText = merged.locations.length > 0 ? merged.locations.join(', ') : 'N/A';
                          
                          // Compute ED breakdown with quantities
                          const edMap = new Map<string, { qty: number; scanned: number }>();
                          merged.items.forEach(sub => {
                            const ed = sub.expiredDate || 'N/A';
                            const current = edMap.get(ed) || { qty: 0, scanned: 0 };
                            const subScanned = packingScannedQty[sub.id] || 0;
                            edMap.set(ed, {
                              qty: current.qty + sub.qty,
                              scanned: current.scanned + subScanned
                            });
                          });
                          const edBreakdown = Array.from(edMap.entries()).map(([date, info]) => ({ date, ...info }));
                          const expiredText = merged.expiredDates.length > 0 ? merged.expiredDates.join(', ') : 'N/A';
                          const isEditingExp = merged.items.some(sub => sub.id === editingItemId) || editingItemId === merged.skuId;

                          return (
                            <div key={merged.skuId} className={`pt-3.5 first:pt-0 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all ${isDone ? 'opacity-80' : ''}`}>
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs font-extrabold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/15">
                                    {merged.skuId}
                                  </span>
                                  <h4 className="text-xs font-bold text-slate-200">{merged.skuName}</h4>
                                </div>
                                <div className="flex flex-wrap items-center gap-y-1 gap-x-3 text-[11px] text-slate-500">
                                  <span className="flex items-center gap-1">
                                    <strong className="text-slate-400">Rak:</strong> 
                                    <span className="font-mono font-bold text-white bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">{locationText}</span>
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <strong className="text-slate-400">Expired:</strong> 
                                    {isEditingExp ? (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <div className="relative flex items-center">
                                          <input
                                            type="text"
                                            value={tempExpDate}
                                            onChange={(e) => setTempExpDate(e.target.value)}
                                            placeholder="DD/MM/YYYY"
                                            className="font-mono bg-slate-900 border border-slate-700 text-white text-[10px] pl-2 pr-7 py-0.5 rounded focus:ring-1 focus:ring-amber-500 outline-none w-36 font-bold"
                                          />
                                          <label className="absolute right-1 text-slate-400 hover:text-amber-400 transition-colors p-0.5 cursor-pointer" title="Pilih Tanggal dari Kalender">
                                            <Calendar className="w-3.5 h-3.5" />
                                            <input
                                              type="date"
                                              className="sr-only"
                                              onChange={(e) => {
                                                if (e.target.value) {
                                                  setTempExpDate(normalizeDateToDmy(e.target.value));
                                                }
                                              }}
                                            />
                                          </label>
                                        </div>
                                        <button
                                          onClick={async () => {
                                            if(!tempExpDate.trim()||!onBatchEditExpiredDate)return;
                                            const normDate=normalizeDateToDmy(tempExpDate.trim());
                                            const success=await onBatchEditExpiredDate(merged.items,normDate);
                                            if(!success){setPackingScanSuccess(null);setPackingScanError('Perubahan kedaluwarsa ditolak. Alokasi stok yang sudah dipotong harus tetap terlacak.');return;}
                                            setPackingScanSuccess('Kedaluwarsa order berhasil disimpan.');
                                            setPackingScanError(null);
                                            setEditingItemId(null);
                                          }}
                                          className="p-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded cursor-pointer transition-colors"
                                          title="Simpan Tanggal Expired"
                                        >
                                          <Check className="w-3 h-3" />
                                        </button>
                                        <button
                                          onClick={() => setEditingItemId(null)}
                                          className="p-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded cursor-pointer transition-colors"
                                          title="Batal"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        {edBreakdown.map((b, bIdx) => (
                                          <div key={bIdx} className="flex items-center gap-1 bg-slate-900/80 border border-slate-800 px-2 py-0.5 rounded-md text-[10px] font-mono">
                                            <span className="text-amber-400 font-bold">{b.date}</span>
                                            <span className="text-emerald-400 font-extrabold">({b.qty} pcs)</span>
                                          </div>
                                        ))}
                                        <button
                                          onClick={() => {
                                            setEditingItemId(merged.skuId);
                                            setTempExpDate(expiredText);
                                          }}
                                          className="text-slate-550 hover:text-amber-400 p-0.5 transition-colors cursor-pointer"
                                          title="Ubah Expired Date sesuai fisik"
                                        >
                                          <Sparkles className="w-3 h-3 text-amber-500" />
                                        </button>
                                      </div>
                                    )}
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
                                <div className="text-right space-y-1">
                                  <p className="text-xs font-black font-mono">
                                    <span className={isDone ? "text-emerald-400" : scannedVal > 0 ? "text-amber-400" : "text-slate-400"}>{scannedVal}</span>
                                    <span className="text-slate-550"> / {merged.totalQty} pcs</span>
                                  </p>
                                  <div className="w-24 bg-slate-800 h-1.5 rounded-full overflow-hidden">
                                    <div 
                                      className={`h-full transition-all duration-300 ${isDone ? 'bg-emerald-500' : 'bg-amber-400'}`}
                                      style={{ width: `${percent}%` }}
                                    />
                                  </div>
                                </div>

                                <div className="flex items-center gap-1.5">
                                  {!isDone && (
                                    <button
                                      disabled
                                      className="px-2.5 py-1.5 bg-sky-500/10 hover:bg-sky-500 text-sky-400 hover:text-slate-950 border border-sky-500/20 text-[10px] font-bold rounded-lg transition-colors cursor-pointer flex items-center gap-1 shrink-0"
                                      title="Set kuantitas sesuai order"
                                    >
                                      <CheckCircle className="w-3.5 h-3.5" />
                                      Sesuai
                                    </button>
                                  )}

                                  {!isDone ? (
                                    <button
                                      disabled
                                      className="px-2.5 py-1.5 bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/20 text-[10px] font-bold rounded-lg transition-colors cursor-pointer flex items-center gap-1 shrink-0"
                                      title="Scan +1 SKU"
                                    >
                                      <Scan className="w-3.5 h-3.5" />
                                      Scan +1
                                    </button>
                                  ) : (
                                    <span className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 flex items-center justify-center gap-1 text-[10px] font-extrabold shrink-0">
                                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                                      Selesai
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        });
                      })()}
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Console / Scanner simulator */}
                  <div className="lg:col-span-5 space-y-4">
                    <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md space-y-5">
                      <div>
                        <h3 className="text-sm font-extrabold text-white flex items-center gap-1.5">
                          <Barcode className="w-4 h-4 text-emerald-400" />
                          Simulasi Scanner Gun
                        </h3>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          Arahkan kursor ke input di bawah ini dan tembak barcode barang, atau gunakan tombol pintas untuk simulasi.
                        </p>
                      </div>

                      {/* Simulated laser scan box */}
                      <form 
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handlePackingScan(packingManualCode);
                        }}
                        className="space-y-3"
                      >
                        <div className="relative overflow-hidden bg-[#0A0D14] border border-slate-800 focus-within:border-emerald-500/50 rounded-xl p-4 flex flex-col items-center justify-center group min-h-[140px]">
                          {/* Flashing laser line effect */}
                          <div className="absolute top-1/2 left-0 w-full h-[2px] bg-rose-600/80 shadow-[0_0_10px_#e11d48] animate-pulse z-10"></div>
                          
                          <p className="text-[10px] font-bold text-slate-550 uppercase tracking-widest mb-3 z-0">
                            LASER BARCODE AKTIF
                          </p>

                          <input
                            type="text"
                            placeholder="Input SKU / Scan Barcode..."
                            value={packingManualCode}
                            disabled={SERVER_SCAN_ENABLED ? (!packingReady || packingBusy) : packingBusy}
                            onChange={(e) => setPackingManualCode(e.target.value)}
                            className="relative z-20 w-full px-4 py-3 bg-[#11141B] border border-slate-850 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-white font-mono text-center text-sm font-bold rounded-lg outline-none placeholder:text-slate-600 shadow-inner"
                            autoFocus
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={SERVER_SCAN_ENABLED ? (!packingReady || packingBusy) : packingBusy}
                          className="w-full py-2 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-black text-xs rounded-xl tracking-wider uppercase transition-colors cursor-pointer"
                        >
                          Kirim Scan Barcode (Enter)
                        </button>
                      </form>

                      {/* Audio toggle */}
                      <div className="flex items-center justify-between bg-slate-900/60 p-3 rounded-lg border border-slate-850">
                        <span className="text-xs text-[#8d9ab3] font-medium">Suara Hasil Scan</span>
                        <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-slate-300 font-bold hover:text-white">
                          <input
                            type="checkbox"
                            checked={soundEnabled}
                            onChange={(e) => setSoundEnabled(e.target.checked)}
                            className="rounded border-slate-800 text-emerald-500 focus:ring-emerald-500 bg-[#161B25] w-4 h-4 cursor-pointer"
                          />
                          {soundEnabled ? 'Aktif' : 'Nonaktif'}
                        </label>
                      </div>

                      {/* Realtime Scan Banner logs */}
                      {packingScanSuccess && (
                        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl p-4 text-xs font-extrabold flex items-center gap-2 animate-pulse">
                          <CheckCircle className="w-4 h-4 shrink-0" />
                          <span>{packingScanSuccess}</span>
                        </div>
                      )}

                      {packingScanError && (
                        <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl p-4 text-xs font-extrabold flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          <span>{packingScanError}</span>
                        </div>
                      )}

                      {/* Cheat sheet buttons of unique SKU codes in order */}
                      <div className="space-y-2 border-t border-slate-800/60 pt-4">
                        <label className="block text-[10px] font-black text-[#8d9ab3] uppercase tracking-wider">
                          Daftar SKU Pintasan (Klik untuk Simulasi):
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {mergedPackerItems.map(m => m.skuId).map((sku: string) => (
                            <button
                              key={sku}
                              disabled
                              className="px-3 py-1.5 bg-[#161B25] hover:bg-slate-800 border border-slate-850 hover:border-slate-700 text-slate-300 hover:text-white font-mono text-xs font-bold rounded-lg transition-colors cursor-pointer"
                            >
                              {sku}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Progress tracking summary */}
                    <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md space-y-4">
                      <div>
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide">Ringkasan Kemajuan Packing</h4>
                        <div className="flex justify-between items-end mt-2">
                          <p className="text-2xl font-black text-white font-mono">{overallPercent}%</p>
                          <p className="text-xs text-slate-400 font-mono font-semibold">{totalScannedPcs} / {totalOrderPcs} Pcs Kemas</p>
                        </div>
                        <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden mt-2">
                          <div 
                            className="h-full bg-emerald-500 bg-gradient-to-r from-amber-500 to-emerald-400 transition-all duration-300"
                            style={{ width: `${overallPercent}%` }}
                          />
                        </div>
                      </div>

                      {/* Confirm Packing Button */}
                      <button
                        disabled={!isFullyPacked || packingBusy || (SERVER_SCAN_ENABLED && !packingReady)}
                        onClick={confirmPackingCompleted}
                        className={`w-full py-3.5 rounded-xl text-xs font-extrabold flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer ${
                          isFullyPacked 
                            ? 'bg-emerald-500 hover:bg-emerald-450 text-slate-950 shadow-emerald-500/20 font-black' 
                            : 'bg-slate-800/50 text-slate-600 cursor-not-allowed shadow-none border border-slate-850'
                        }`}
                      >
                        <PackageCheck className="w-4 h-4" />
                        KONFIRMASI & SELESAIKAN PACKING
                      </button>
                      {!isFullyPacked && (
                        <p className="text-[10px] text-slate-550 text-center italic">
                          *Tombol konfirmasi aktif jika semua kuantitas SKU telah divalidasi (100%).
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      )}

      {/* LAST PACKED ORDER PRINT MODAL */}
      {lastPackedOrder && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-[#11141B] border border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-150 flex flex-col my-8">
            
            {/* Modal Header */}
            <div className="bg-[#151922] px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle className="w-5 h-5 stroke-[2.5]" />
                <h3 className="font-extrabold text-white text-sm uppercase tracking-wider">Packing Berhasil Diselesaikan!</h3>
              </div>
              <button 
                onClick={() => setLastPackedOrder(null)}
                className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body / Printable Container */}
            <div className="p-6 overflow-y-auto space-y-6 max-h-[70vh]">
              <p className="text-xs text-slate-400 leading-relaxed">
                Order <span className="font-mono font-bold text-white bg-slate-800 px-1.5 py-0.5 rounded">{lastPackedOrder.referenceNumber}</span> telah berhasil dipacking dengan kuantitas yang divalidasi penuh. Anda dapat langsung mencetak resi pengiriman / packing slip di bawah ini:
              </p>

              {isInIframe && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3.5 text-xs text-amber-400 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0 text-amber-500 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-extrabold uppercase tracking-wide text-[10px]">Peringatan Keamanan Browser (Iframe):</p>
                    <p className="leading-relaxed text-[11px] text-slate-300">
                      Browser memblokir pemanggilan dialog printer (<code className="font-mono bg-amber-500/10 px-1 py-0.5 rounded text-amber-400">window.print()</code>) karena aplikasi sedang berjalan di dalam panel preview editor ini. 
                    </p>
                    <p className="leading-relaxed text-[11px] text-slate-350">
                      👉 <strong>Solusi:</strong> Silakan klik tombol <strong>"Buka di Tab Baru" (ikon di pojok kanan atas preview)</strong> agar printer fisik Anda dapat merespon, atau gunakan alternatif tombol <strong>"Salin Teks Resi"</strong> di bawah.
                    </p>
                  </div>
                </div>
              )}

              {/* High fidelity thermal receipt / printable slip style container */}
              <div 
                id="printable-receipt"
                className="bg-white text-slate-900 rounded-xl p-6 border-2 border-dashed border-slate-300 shadow-sm font-mono text-xs space-y-4"
              >
                {/* Print only CSS */}
                <style dangerouslySetInnerHTML={{__html: `
                  @media print {
                    /* Reset everything to allow proper multi-page flowing */
                    html, body, #root, #root > div {
                      overflow: visible !important;
                      height: auto !important;
                      min-height: auto !important;
                      max-height: none !important;
                      position: relative !important;
                      background: white !important;
                      color: black !important;
                      padding: 0 !important;
                      margin: 0 !important;
                    }
                    
                    /* Hide absolutely everything in body by default */
                    body {
                      background: white !important;
                      color: black !important;
                      visibility: hidden !important;
                    }
                    
                    /* But make sure the printable receipt wrapper and all its contents are visible */
                    #printable-receipt-wrapper,
                    #printable-receipt-wrapper * {
                      visibility: visible !important;
                    }
                    
                    /* Ensure all ancestor divs of the printable wrapper allow overflow and do not enforce fixed size */
                    div, section, main, header, footer {
                      overflow: visible !important;
                      max-height: none !important;
                      height: auto !important;
                    }
                    
                    /* Disable background dimmers and backdrop blurs during printing */
                    .fixed {
                      position: absolute !important;
                      background: transparent !important;
                      backdrop-filter: none !important;
                      box-shadow: none !important;
                      border: none !important;
                      left: 0 !important;
                      top: 0 !important;
                      width: 100% !important;
                      height: auto !important;
                      max-height: none !important;
                      padding: 0 !important;
                      margin: 0 !important;
                      overflow: visible !important;
                    }
                    
                    /* Position the printable wrapper perfectly at the top left of the print viewport */
                    #printable-receipt-wrapper {
                      position: absolute !important;
                      left: 0 !important;
                      top: 0 !important;
                      width: 100% !important;
                      height: auto !important;
                      overflow: visible !important;
                      background: white !important;
                      color: black !important;
                      margin: 0 !important;
                      padding: 0 !important;
                      display: block !important;
                    }
                    
                    /* Style the printable receipt box nicely for full-page standard or thermal prints */
                    #printable-receipt {
                      width: 100% !important;
                      max-width: 100% !important;
                      border: none !important;
                      box-shadow: none !important;
                      padding: 20px !important;
                      margin: 0 !important;
                      background: white !important;
                      color: black !important;
                    }
                  }
                `}} />

                <div id="printable-receipt-wrapper">
                  {/* Receipt Header */}
                  <div className="text-center border-b border-slate-300 pb-4 space-y-1">
                    <h2 className="text-lg font-black tracking-tight text-slate-950">RESI OUTBOUND / PACKING SLIP</h2>
                    <p className="text-[10px] text-slate-600">INVENTORY WAREHOUSE OFFLINE</p>
                    <p className="text-[9px] text-slate-500">{new Date().toLocaleString('id-ID')}</p>
                  </div>

                  {/* Metadata details */}
                  <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-[11px] border-b border-slate-300 pb-4 mt-4">
                    <div>
                      <span className="text-slate-500 uppercase block text-[9px] font-bold">No. Referensi:</span>
                      <strong className="text-slate-950 font-mono text-xs">{lastPackedOrder.referenceNumber}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 uppercase block text-[9px] font-bold">No. Order / Invoice:</span>
                      <strong className="text-slate-950 font-mono">{lastPackedOrder.orderNumber || '-'}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 uppercase block text-[9px] font-bold">No. PO:</span>
                      <strong className="text-slate-950 font-mono">{lastPackedOrder.noPo || '-'}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 uppercase block text-[9px] font-bold">Customer:</span>
                      <strong className="text-slate-950">{lastPackedOrder.customerName || 'N/A'}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 uppercase block text-[9px] font-bold">Packer / Validator:</span>
                      <strong className="text-slate-950">{currentUser?.fullName || 'Simulated Packer'}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 uppercase block text-[9px] font-bold">Status Validasi:</span>
                      <strong className="text-emerald-700 uppercase">100% VERIFIED</strong>
                    </div>
                  </div>

                  {/* Items Table */}
                  <div className="space-y-2 mt-4">
                    <span className="text-slate-500 uppercase text-[9px] font-bold block">Detail Item yang Dikemas:</span>
                    <table className="w-full text-left text-[11px] border-collapse">
                      <thead>
                        <tr className="border-b-2 border-slate-950 text-slate-950 font-bold">
                          <th className="py-1 text-left">SKU / Nama</th>
                          <th className="py-1 text-center">Rak</th>
                          <th className="py-1 text-center">Expired</th>
                          <th className="py-1 text-right">Qty</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {[...lastPackedOrder.items].sort((a: any, b: any) => getLocationRank(a.location || '') - getLocationRank(b.location || '')).map((item: any) => (
                          <tr key={item.id} className="text-slate-900">
                            <td className="py-2 pr-2">
                              <span className="font-bold font-mono">{item.skuId}</span>
                              <span className="block text-[10px] text-slate-600 line-clamp-1">{item.skuName}</span>
                            </td>
                            <td className="py-2 text-center font-mono font-bold text-slate-800">{item.location}</td>
                            <td className="py-2 text-center text-slate-600 font-mono text-[10px]">{item.expiredDate}</td>
                            <td className="py-2 text-right font-bold text-slate-950">{formatNumber(item.qty)} pcs</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Summary Totals */}
                  <div className="border-t border-slate-300 pt-3 flex justify-between items-center text-xs mt-4">
                    <span className="font-bold text-slate-950">TOTAL BARANG:</span>
                    <strong className="text-sm font-black text-slate-950 font-mono">{formatNumber(lastPackedOrder.totalQty)} Pcs</strong>
                  </div>

                  {/* Signatures / Footers */}
                  <div className="border-t border-dashed border-slate-300 pt-4 flex justify-between items-center text-[10px] text-slate-600 mt-6">
                    <div className="text-center w-24">
                      <p className="mb-8">Penerima,</p>
                      <p className="border-t border-slate-400 pt-1 font-bold">( . . . . . . . . . )</p>
                    </div>
                    <div className="text-center w-24">
                      <p className="mb-8">Packer,</p>
                      <p className="border-t border-slate-400 pt-1 font-bold">({currentUser?.fullName?.split(' ')[0] || 'Packer'})</p>
                    </div>
                  </div>

                  <div className="text-center text-[8px] text-slate-450 pt-4 border-t border-slate-200 mt-6">
                    Terima kasih atas dedikasi Anda dalam pengemasan yang akurat dan tepat waktu!
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="bg-[#151922] px-6 py-4 border-t border-slate-800 flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => {
                  window.print();
                }}
                className="flex-1 py-3 bg-emerald-500 hover:bg-emerald-450 text-slate-950 text-xs font-black rounded-xl tracking-wider uppercase transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10"
              >
                <Printer className="w-4 h-4" />
                Cetak Resi / Print Packing Slip
              </button>

              <button
                onClick={handleCopyReceipt}
                className={`px-5 py-3 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 border ${
                  copiedReceipt 
                    ? 'bg-emerald-500/15 border-emerald-500 text-emerald-400' 
                    : 'bg-[#1a202c] border-slate-800 text-slate-350 hover:text-white hover:bg-slate-800'
                }`}
              >
                <ClipboardList className="w-4 h-4" />
                {copiedReceipt ? 'Teks Resi Disalin!' : 'Salin Teks Resi'}
              </button>

              <button
                onClick={handleDownloadReceipt}
                className="px-5 py-3 text-xs font-bold rounded-xl bg-[#1a202c] border border-slate-800 text-slate-350 hover:text-white hover:bg-slate-800 transition-all cursor-pointer flex items-center justify-center gap-2"
                title="Unduh resi sebagai file .txt"
              >
                <FileText className="w-4 h-4 text-emerald-450" />
                Unduh File Resi (.txt)
              </button>
              
              <button
                onClick={() => setLastPackedOrder(null)}
                className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-bold rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-1.5"
              >
                Selesai & Lanjut Order Berikutnya
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

          </div>
        </div>
      )}

      {activeModeTab === 'history' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <HistoryOrder
            orderHistory={orderHistory}
            currentUser={currentUser}
            onEditOrderHistory={onEditOrderHistory}
            onDeleteOrderHistory={onDeleteOrderHistory}
            onDeleteMultipleOrders={onDeleteMultipleOrders}
            onClearAllOrderHistory={onClearAllOrderHistory}
          />
        </div>
      )}

      {activeModeTab === 'manifest' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <CourierManifestManager
            orderHistory={orderHistory}
            currentUser={currentUser}
            onUpdateOrdersShipped={onUpdateOrdersShipped}
            warehouses={availableWarehouses}
            selectedWarehouseId={selectedWarehouseId}
            onSelectWarehouseId={setSelectedWarehouseId}
          />
        </div>
      )}

      {/* CUSTOM CONFIRMATION DIALOG MODAL */}
      {customConfirmState && (
        <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-[#11141B] border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in zoom-in-95 duration-150 flex flex-col my-8">
            {/* Modal Header */}
            <div className="bg-[#151922] px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-400">
                <AlertTriangle className="w-5 h-5 stroke-[2]" />
                <h3 className="font-extrabold text-white text-sm uppercase tracking-wider">
                  {customConfirmState.type === 'bulk_outbound' ? 'Konfirmasi Outbound Massal' : 'Butuh Konfirmasi Anda'}
                </h3>
              </div>
              <button 
                onClick={() => setCustomConfirmState(null)}
                className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-4 max-h-[60vh] text-sm text-slate-300">
              {customConfirmState.type === 'bulk_outbound' && customConfirmState.details ? (
                <div className="space-y-4">
                  <p className="text-xs text-slate-400">
                    Sistem mendeteksi beberapa kondisi khusus dalam data outbound massal yang Anda masukkan. Mohon tinjau detail berikut sebelum melanjutkan:
                  </p>

                  {customConfirmState.details.invalidRowsCount > 0 && (
                    <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl space-y-1">
                      <p className="text-xs font-bold text-amber-400 uppercase tracking-wide">⚠ Baris Bermasalah Diabaikan</p>
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        Terdapat <strong>{customConfirmState.details.invalidRowsCount} baris</strong> yang memiliki format salah atau stok tidak mencukupi. Baris-baris ini akan otomatis dilewati saat pengolahan order.
                      </p>
                    </div>
                  )}

                  {customConfirmState.details.overallMismatch && (
                    <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl space-y-1">
                      <p className="text-xs font-bold text-rose-450 uppercase tracking-wide">⚠ Selisih Kuantitas Alokasi</p>
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        Ada ketidakcocokan jumlah alokasi lokasi dengan kuantitas yang diminta pada beberapa SKU. Sistem akan memproses pengeluaran barang sesuai kuantitas alokasi aktual yang tersedia.
                      </p>
                    </div>
                  )}

                  {customConfirmState.details.under24Items.length > 0 && (
                    <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl space-y-1">
                      <p className="text-xs font-bold text-amber-400 uppercase tracking-wide">⚠ Peringatan Expired Date (Dekat / Under 24M)</p>
                      <p className="text-[11px] text-slate-300 leading-relaxed mb-1.5">
                        Terdapat SKU dengan Expired Date di bawah 24 bulan atau Near ED yang terpilih untuk alokasi:
                      </p>
                      <ul className="text-[10px] text-slate-350 list-disc list-inside space-y-0.5 max-h-24 overflow-y-auto">
                        {customConfirmState.details.under24Items.map((item, idx) => (
                          <li key={idx} className="font-mono">{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <p className="text-xs text-slate-400 font-medium">
                    Apakah Anda yakin ingin memproses draft order ini?
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="leading-relaxed text-xs text-slate-300 whitespace-pre-line">
                    {customConfirmState.message}
                  </p>
                </div>
              )}
            </div>

            {/* Modal Actions */}
            <div className="bg-[#151922] px-6 py-4 border-t border-slate-800 flex gap-3 justify-end">
              <button
                onClick={() => setCustomConfirmState(null)}
                className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-bold rounded-xl transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                onClick={customConfirmState.onConfirm}
                className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 text-xs font-black rounded-xl tracking-wider uppercase transition-colors cursor-pointer flex items-center gap-1.5 shadow-lg shadow-emerald-500/10"
              >
                Ya, Lanjutkan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch / Wave Picking Route Modal */}
      {showBatchPickingModal && (
        <BatchPickingModal
          isOpen={showBatchPickingModal}
          onClose={() => setShowBatchPickingModal(false)}
          orderHistory={orderHistory}
          allStock={stock}
          warehouses={availableWarehouses}
          selectedWarehouseId={selectedWarehouseId}
          onCompleteBatchPicking={async (referenceNumbers) => {
            if(!onEditMultipleOrdersBatch)return false;
            const updates=referenceNumbers.map(refNum=>({refNum,updatedItems:orderHistory.filter(o=>o.referenceNumber===refNum&&o.status==='Pending'),isPicking:true}));
            return await onEditMultipleOrdersBatch(updates);

          }}
        />
      )}
    </div>
  );
}
