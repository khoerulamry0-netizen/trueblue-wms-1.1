import {findActiveBasketConflicts, formatBasketConflictSummary, selectSortLoadCandidates, type SortingTask} from '../utils/orderSorting';
import {buildMasterBasketMonitorData} from '../utils/masterBasketTracker';
import {isOrderClaimedByAnotherPicker, type OrderIssueReportInput, type OrderSessionData, type OrderSessionResult} from '../utils/orderSession';
import { scanServerUnavailable, hasSavedSorting } from '../utils/packingValidation';
import { DEV_BASELINE_SORTING, getActiveBranch, SERVER_SCAN_ENABLED, serverScanRpc, supabase } from '../supabase';
import { createScanServerSession, createSortingServerSession } from '../utils/sortingServerSession';
import type { ScanProgress } from '../utils/serverScanRpc';
import { normalizeDateToDmy, isStockPickable } from '../utils/calculations';
import { resolveOrderType } from '../utils/orderType';
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { 
  StockItem, 
  OutboundItem 
} from '../types';
import { 
  Barcode, 
  Scan, 
  Volume2, 
  VolumeX, 
  CheckCircle2, 
  AlertTriangle, 
  Package, 
  Printer, 
  Layers, 
  Box, 
  RefreshCw, 
  ArrowRight, 
  Check, 
  Copy,
  X, 
  Clock, 
  User, 
  MapPin, 
  Building2, 
  ShoppingBag, 
  FileText,
  Weight,
  HelpCircle,
  ExternalLink,
  ChevronDown,
  Info,
  Maximize2,
  Minimize2,
  PanelLeftClose
} from 'lucide-react';
import { findSkuId, getBarcodeForSku, BARCODE_MAP } from '../data/barcodeMap';
import BasketLabelGeneratorModal from './BasketLabelGeneratorModal';
import MasterBasketMonitorModal from './MasterBasketMonitorModal';
import OrderIssueModal from './OrderIssueModal';
import ShippingReceiptModal, { type ShippingOrderData } from './ShippingReceiptModal';

interface MabangWmsOutboundProps {
  onCompleteSorting?: (tasks:SortingTask[])=>Promise<boolean>;
  stock: StockItem[];
  orderHistory: OutboundItem[];
  currentUser?: { username: string; role: string; fullName: string } | null;
  onEditOrderHistoryBatch?: (refNum: string, updatedItems: OutboundItem[], isPicking?: boolean) => Promise<boolean>;
  onEditMultipleOrdersBatch?: (
    updates: {
      refNum: string;
      updatedItems: OutboundItem[];
      isPicking?: boolean;
    }[]
  ) => Promise<boolean>;
  onUpdateOrderSession?: (references: string | string[], sessionData: OrderSessionData) => Promise<OrderSessionResult | false>;
  onOpenBasketLabelModal?: () => void;
  onSortingSessionReleased?: () => void;
  loadSortingReferences?: () => Promise<string[]>;
  clearSortingIndicatorOnSelection?: boolean;
  resolveSortingTarget?: (barcode: string, orders: {reference: string; basket: string}[]) => Promise<string>;
  onClose?: () => void;
  requestedScreen?: MabangScreen;
  onScreenChange?: (screen: MabangScreen) => void;
  requireExplicitOnlineType?: boolean;
}

export type MabangScreen = 'distribution' | 'sorting' | 'delivery';

function getStoredOrderId(item: OutboundItem): string | undefined {
  return 'orderId' in item && typeof item.orderId === 'string' ? item.orderId : undefined;
}

export default function MabangWmsOutbound({
  stock,
  orderHistory = [],
  currentUser,
  onCompleteSorting,
  onEditOrderHistoryBatch,
  onEditMultipleOrdersBatch,
  onUpdateOrderSession,
  onOpenBasketLabelModal,
  onSortingSessionReleased,
  loadSortingReferences,
  clearSortingIndicatorOnSelection,
  resolveSortingTarget,
  onClose,
  requestedScreen,
  onScreenChange,
  requireExplicitOnlineType = false,
}: MabangWmsOutboundProps) {
  // Screen sub-navigation: Picker starts at 'distribution', Packer starts at 'sorting'
  const isPickerRole = currentUser?.role === 'Picker';
  const isPackerRole = currentUser?.role === 'Packer';
  const isAdminRole = ['Administrator', 'Admin', 'Manager'].includes(currentUser?.role || '');
  const [currentScreen, setCurrentScreen] = useState<MabangScreen>(() => {
    if (isPickerRole) return 'distribution';
    if (isPackerRole) return requestedScreen === 'delivery' ? 'delivery' : 'sorting';
    return requestedScreen || 'distribution';
  });

  const switchScreen = (next: MabangScreen) => {
    const allowed: MabangScreen = isPickerRole
      ? 'distribution'
      : isPackerRole && next === 'distribution'
        ? 'sorting'
        : next;
    setCurrentScreen(allowed);
    onScreenChange?.(allowed);
  };

  useEffect(() => {
    if (!requestedScreen) return;
    const allowed: MabangScreen = isPickerRole
      ? 'distribution'
      : isPackerRole && requestedScreen === 'distribution'
        ? 'sorting'
        : requestedScreen;
    if (allowed !== currentScreen) {
      setCurrentScreen(allowed);
    }
  }, [requestedScreen, isPickerRole, isPackerRole]);

  // Ensure role stays on allowed screens if role changes
  useEffect(() => {
    if (isPickerRole && currentScreen !== 'distribution') {
      setCurrentScreen('distribution');
    } else if (isPackerRole && currentScreen === 'distribution') {
      setCurrentScreen('sorting');
    }
  }, [currentUser?.role, isPickerRole, isPackerRole, currentScreen]);

  // Voice Broadcast State
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [lastSpokenText, setLastSpokenText] = useState<string>('');

  // Shipping Receipt Print Modal State
  const [isBasketLabelModalOpen, setIsBasketLabelModalOpen] = useState(false);
  const [isMasterBasketMonitorOpen, setIsMasterBasketMonitorOpen] = useState(false);
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [operatorFocusMode, setOperatorFocusMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('wms_operator_focus_mode') === 'true';
    } catch {
      return false;
    }
  });
  const toggleOperatorFocusMode = () => {
    setOperatorFocusMode(prev => {
      const next = !prev;
      try { localStorage.setItem('wms_operator_focus_mode', String(next)); } catch {}
      return next;
    });
  };
  useEffect(() => {
    if (!operatorFocusMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isMasterBasketMonitorOpen && !isBasketLabelModalOpen && !issueModalOpen) {
        setOperatorFocusMode(false);
        try { localStorage.setItem('wms_operator_focus_mode', 'false'); } catch {}
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [operatorFocusMode, isMasterBasketMonitorOpen, isBasketLabelModalOpen, issueModalOpen]);
  const activeMasterBasketCount = useMemo(
    () => (isAdminRole ? buildMasterBasketMonitorData(orderHistory).groups.length : 0),
    [isAdminRole, orderHistory]
  );

  // Copy feedback state
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopyText = async (text: string, key: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (!text) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey(prev => (prev === key ? null : prev));
      }, 1500);
    } catch (err) {
      console.error('Failed to copy: ', err);
    }
  };

  // Group pending orders
  const pendingOrders = useMemo(() => {
    const groups: { [ref: string]: {
      referenceNumber: string;
      orderNumber?: string;
      orderId?: string;
      noPo?: string;
      customerName?: string;
      customerPhone?: string;
      batchNumber?: string;
      customerAddress?: string;
      basketNumber?: string;
      masterBasketNumber?: string;
      timestamp: string;
      items: OutboundItem[];
      totalQty: number;
      isPicked: boolean;
      isSorted: boolean;
      sortedBy?: string;
      sortedAt?: string;
      pickingBy?: string;
      pickingStartedAt?: string;
      packingBy?: string;
      packingStartedAt?: string;
      createdBy?: string;
      pickedBy?: string;
      packedBy?: string;
      notes?: string;
      courier?: string;
      shopName?: string;
    }} = {};

    (orderHistory || []).forEach(item => {
      if (item.status === 'Pending') {
        const orderType = resolveOrderType(item);
        if (requireExplicitOnlineType ? orderType !== 'ONLINE' : orderType === 'B2B') return;

        if (!groups[item.referenceNumber]) {
          // Infer courier from batchNumber, customerAddress or orderId
          let courier = 'J&T Express';
          const txt = `${getStoredOrderId(item) || item.orderNumber || ''} ${item.batchNumber || ''} ${item.referenceNumber || ''}`.toUpperCase();
          if (txt.includes('SPX') || txt.includes('SHOPEE')) courier = 'Shopee Xpress';
          else if (txt.includes('SIC') || txt.includes('SICEPAT')) courier = 'SiCepat';
          else if (txt.includes('JNE')) courier = 'JNE';
          else if (txt.includes('NINJA')) courier = 'Ninja Xpress';
          else if (txt.includes('TIKI')) courier = 'TIKI';

          let shopName = 'Toko Online';
          if (item.batchNumber && item.batchNumber.toLowerCase().includes('tiktok')) shopName = 'Toko TikTok';
          else if (item.batchNumber && item.batchNumber.toLowerCase().includes('lazada')) shopName = 'Toko Lazada';

          groups[item.referenceNumber] = {
            referenceNumber: item.referenceNumber,
            orderNumber: item.orderNumber,
            orderId: getStoredOrderId(item) || item.orderNumber || item.batchNumber || item.referenceNumber,
            noPo: item.noPo,
            customerName: item.customerName || 'Pelanggan',
            customerPhone: item.customerPhone || '-',
            batchNumber: item.batchNumber,
            customerAddress: item.customerAddress || '-',
            basketNumber: item.basketNumber || '',
            masterBasketNumber: item.masterBasketNumber || '',
            timestamp: item.timestamp,
            items: [],
            totalQty: 0,
            isPicked: true,
            isSorted: Boolean(item.sortedAt?.trim() && item.sortedBy?.trim()),
            sortedBy: item.sortedBy,
            sortedAt: item.sortedAt,
            pickingBy: item.pickingBy,
            pickingStartedAt: item.pickingStartedAt,
            packingBy: item.packingBy,
            packingStartedAt: item.packingStartedAt,
            createdBy: item.createdBy,
            pickedBy: item.pickedBy,
            packedBy: item.packedBy,
            notes: item.notes || '',
            courier,
            shopName
          };
        }
        groups[item.referenceNumber].items.push(item);
        groups[item.referenceNumber].totalQty += item.qty;
        if (!item.picked) {
          groups[item.referenceNumber].isPicked = false;
        }
        if (!item.sortedAt?.trim() || !item.sortedBy?.trim()) {
          groups[item.referenceNumber].isSorted = false;
        }
        if (item.sortedBy && !groups[item.referenceNumber].sortedBy) {
          groups[item.referenceNumber].sortedBy = item.sortedBy;
        }
        if (item.sortedAt && !groups[item.referenceNumber].sortedAt) {
          groups[item.referenceNumber].sortedAt = item.sortedAt;
        }
      }
    });

    return Object.values(groups).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [orderHistory]);

  // Audio & Voice Broadcast Helper
  const speakVoice = (text: string) => {
    if (!isVoiceEnabled) return;
    try {
      setLastSpokenText(text);
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.05;
        utterance.pitch = 1.0;
        utterance.lang = 'id-ID'; // Indonesian voice
        window.speechSynthesis.speak(utterance);
      }
    } catch {
      // Fallback ignore
    }
  };

  const playBuzzer = (isSuccess: boolean) => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (isSuccess) {
        osc.frequency.setValueAtTime(650, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(920, audioCtx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.15);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, audioCtx.currentTime);
        osc.frequency.setValueAtTime(140, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.25);
      }
    } catch {
      // Ignore
    }
  };

  // =========================================================================
  // SCREEN 1: M DISTRIBUTION (PICKING & BASKET BINDING)
  // GLOBAL BATCH PICKING: MAKSIMAL 20 ORDER NUMBER KE DALAM 1 KERANJANG INDUK
  // =========================================================================
  const [distShipVia, setDistShipVia] = useState<string>('ALL');
  const [distPrioritize, setDistPrioritize] = useState<boolean>(false);
  const [distMaxBatchOrders, setDistMaxBatchOrders] = useState<number>(20);
  const [distActiveTaskRef, setDistActiveTaskRef] = useState<string | null>(null);
  const [distActiveBatchOrders, setDistActiveBatchOrders] = useState<typeof pendingOrders>([]);
  const [distBasketInput, setDistBasketInput] = useState<string>('');
  const distBasketInputRef = useRef<HTMLInputElement>(null);
  const [distBoundBasket, setDistBoundBasket] = useState<string>('');
  const [distProductInput, setDistProductInput] = useState<string>('');
  const [distDisplayImages, setDistDisplayImages] = useState<boolean>(true);
  const [distHideCompleted, setDistHideCompleted] = useState<boolean>(true); // Otomatis sembunyikan item yang sudah lengkap
  const [distPickedCounts, setDistPickedCounts] = useState<{ [skuKey: string]: number }>({});
  const [distCompletedBatchRefs, setDistCompletedBatchRefs] = useState<string[]>([]);
  const [distNotification, setDistNotification] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  const pickerActorName = (currentUser?.fullName || 'Picker Staff').trim();

  // Available unpicked orders for M Distribution
  // Otomatis mengecualikan order yang sudah isPicked, selesai pada batch lokal, atau sedang diklaim Picker lain
  const unpickedOrders = useMemo(() => {
    return pendingOrders.filter(
      ord => !ord.isPicked && !distCompletedBatchRefs.includes(ord.referenceNumber) && !isOrderClaimedByAnotherPicker(ord, pickerActorName)
    );
  }, [pendingOrders, distCompletedBatchRefs, pickerActorName]);

  // Deteksi real-time apakah kode keranjang yang sedang diketik picker sedang aktif dipakai oleh batch lain
  const typedBasketConflict = useMemo(() => {
    const clean = distBasketInput.trim().toUpperCase();
    if (!clean || !distActiveBatchOrders.length) return null;
    const currentBatchRefs = new Set(distActiveBatchOrders.map(o => o.referenceNumber));
    const conflicts = pendingOrders.filter(ord => {
      if (currentBatchRefs.has(ord.referenceNumber)) return false;
      return (ord.basketNumber || '').trim().toUpperCase() === clean;
    });
    if (conflicts.length > 0) {
      return {
        basket: clean,
        count: conflicts.length,
        isPicked: conflicts.some(o => o.isPicked)
      };
    }
    return null;
  }, [distBasketInput, distActiveBatchOrders, pendingOrders]);

  // Helper untuk membandingkan dan mengurutkan rute lokasi fisik gudang
  // Format contoh: AA-01-01, AA-01-02, AB-01-01, RAK-01, PALET-01, dst.
  // Diurutkan berurutan dari lokasi awal (misal AA-01-01) hingga lokasi terakhir
  const compareWarehouseLocations = (locA: string, locB: string) => {
    const a = (locA || '').trim().toUpperCase();
    const b = (locB || '').trim().toUpperCase();
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  };

  // Consolidated Aggregated Items across the 20 batch orders for Global Picking
  // DIURUTKAN SESUAI RUTE PENGAMBILAN PICKER (DARI LOKASI AWAL AA-01-01 S/D LOKASI TERAKHIR PALET)
  const pickingLotKey = (item: {skuId:string; location?:string; expiredDate?:string; warehouseId?:string}) => JSON.stringify([(item.warehouseId || 'WH-CENTRAL').toUpperCase(),item.skuId.trim().toUpperCase(),(item.location || '').trim().toUpperCase(),normalizeDateToDmy(item.expiredDate || '')]);
  const distConsolidatedItems = useMemo(() => {
    if (distActiveBatchOrders.length === 0) return [];
    
    const skuMap: { 
      [skuId: string]: {
        skuId: string;
        skuName: string;
        warehouseId?: string;
        location: string;
        expiredDate?: string;
        totalQty: number;
        orderRefs: string[];
        items: OutboundItem[];
      }
    } = {};

    distActiveBatchOrders.forEach(ord => {
      ord.items.forEach(it => {
        const key = pickingLotKey(it);
        if (!skuMap[key]) {
          skuMap[key] = {
            skuId: it.skuId,
            warehouseId: it.warehouseId || 'WH-CENTRAL',
            skuName: it.skuName,
            location: it.location || 'AA-01-01',
            expiredDate: it.expiredDate,
            totalQty: 0,
            orderRefs: [],
            items: []
          };
        }
        skuMap[key].totalQty += it.qty;
        skuMap[key].items.push(it);
        if (!skuMap[key].orderRefs.includes(ord.referenceNumber)) {
          skuMap[key].orderRefs.push(ord.referenceNumber);
        }
      });
    });

    // Urutkan daftar barang berdasarkan rute lokasi rak fisik gudang (AA-01-01 s/d palet akhir)
    return Object.values(skuMap).sort((itemA, itemB) => {
      const locDiff = compareWarehouseLocations(itemA.location, itemB.location);
      if (locDiff !== 0) return locDiff;
      return itemA.skuId.localeCompare(itemB.skuId);
    });
  }, [distActiveBatchOrders]);

  const distTotalConsolidatedQty = useMemo(() => {
    return distConsolidatedItems.reduce((sum, item) => sum + item.totalQty, 0);
  }, [distConsolidatedItems]);

  const distTotalPickedQty = useMemo(() => {
    return Object.values(distPickedCounts).reduce((sum, q) => sum + q, 0);
  }, [distPickedCounts]);

  // Daftar item yang ditampilkan pada antrean picking:
  // JIKA SUDAH LENGKAP HILANG DARI DAFTAR (sesuai permintaan user)
  const distDisplayItems = useMemo(() => {
    if (!distHideCompleted) return distConsolidatedItems;
    // Jika semua item sudah selesai diambil (100%), tampilkan kembali sebagai ringkasan rute lengkap
    const allDone = distConsolidatedItems.length > 0 && distConsolidatedItems.every(grp => {
      const k = pickingLotKey(grp);
      return (distPickedCounts[k] || 0) >= grp.totalQty;
    });
    if (allDone) return distConsolidatedItems;

    return distConsolidatedItems.filter(grp => {
      const k = pickingLotKey(grp);
      const picked = distPickedCounts[k] || 0;
      return picked < grp.totalQty; // hanya tampilkan item yang masih butuh dipick
    });
  }, [distConsolidatedItems, distPickedCounts, distHideCompleted]);

  // Handle "Ambil tugas" - Ambil Batch Global Maksimal 20 Order
  const handleGetTask = (excludeOrderRefs: string[] = []) => {
    const combinedExcludedRefs = new Set([...distCompletedBatchRefs, ...excludeOrderRefs]);
    const isUnclaimedOrder = (ord: (typeof pendingOrders)[number]) =>
      !(ord.pickingBy || '').trim() && !(ord.masterBasketNumber || ord.basketNumber || '').trim();
    const candidateOrders = pendingOrders
      .filter(ord => {
        if (ord.isPicked || combinedExcludedRefs.has(ord.referenceNumber)) return false;
        if (isOrderClaimedByAnotherPicker(ord, pickerActorName)) return false;
        if (distShipVia === 'ALL') return true;
        return ord.courier?.toLowerCase() === distShipVia.toLowerCase();
      })
      .sort((a, b) => Number(isUnclaimedOrder(b)) - Number(isUnclaimedOrder(a)));

    if (distPrioritize) {
      candidateOrders.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
          return timeA - timeB;
        }
        return a.referenceNumber.localeCompare(b.referenceNumber);
      });
    }

    if (candidateOrders.length === 0) {
      setDistNotification({ type: 'error', message: 'Tidak ada tugas order baru lagi yang perlu di-pick untuk ekspedisi ini!' });
      playBuzzer(false);
      speakVoice('Tidak ada tugas baru');
      return;
    }

    // Ambil maksimal 20 order berikutnya sekaligus untuk Picking Global (Wave / Batch)
    const batchToPick = candidateOrders.slice(0, distMaxBatchOrders);
    const batchId = `BATCH-${new Date().getTime().toString().slice(-6)}`;
    
    setDistActiveBatchOrders(batchToPick);
    setDistActiveTaskRef(batchId);
    
    // Keranjang Induk diisi manual oleh picker sesuai kode keranjang fisik masing-masing
    setDistBasketInput('');
    setDistBoundBasket('');
    
    // Initialize picked counts to 0 for each unique SKU in batch
    const initialCounts: { [skuKey: string]: number } = {};
    batchToPick.forEach(ord => {
      ord.items.forEach(it => {
        const key = pickingLotKey(it);
        initialCounts[key] = 0;
      });
    });
    setDistPickedCounts(initialCounts);

    setDistNotification({ 
      type: 'info', 
      message: `Tugas Picking Batch berhasil diambil: ${batchToPick.length} Order sekaligus (${batchToPick.reduce((sum, o) => sum + o.totalQty, 0)} pcs). Silakan isi/scan kode keranjang fisik Anda lalu klik "Ikat"!` 
    });
    playBuzzer(true);
    speakVoice(`Ambil tugas ${batchToPick.length} pesanan. Silakan isi kode keranjang fisik.`);
  };

  const basketBindingBusy = useRef(false);
  const [isBindingBasket, setIsBindingBasket] = useState(false);

  // Bind basket number
  const handleBindBasket = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (basketBindingBusy.current) return;
    const cleanBasket = distBasketInput.trim().toUpperCase();
    if (!cleanBasket || !distActiveBatchOrders.length || !onUpdateOrderSession) {
      setDistNotification({type:'error',message:!cleanBasket ? 'Nomor keranjang induk tidak boleh kosong!' : 'Ambil tugas terlebih dahulu sebelum mengikat keranjang.'});
      return;
    }

    // CEGAH KERANJANG INDUK YANG SAMA DIGUNAKAN LAGI SEBELUM SELESAI PROSES (COMPLETED)
    const currentBatchRefs = new Set(distActiveBatchOrders.map(o => o.referenceNumber));
    const conflictingOrders = pendingOrders.filter(ord => {
      if (currentBatchRefs.has(ord.referenceNumber)) return false;
      return (ord.basketNumber || '').trim().toUpperCase() === cleanBasket;
    });

    const conflictingHistory = (orderHistory || []).filter(item => {
      if (item.status !== 'Pending') return false;
      if (currentBatchRefs.has(item.referenceNumber)) return false;
      return (item.basketNumber || '').trim().toUpperCase() === cleanBasket;
    });

    if (conflictingOrders.length > 0 || conflictingHistory.length > 0) {
      const busyCount = Math.max(conflictingOrders.length, new Set(conflictingHistory.map(i => i.referenceNumber)).size);
      const isAlreadyPicked = conflictingOrders.some(o => o.isPicked) || conflictingHistory.some(i => i.picked);
      const stage = isAlreadyPicked ? 'Meja Sortir / Packing' : 'Sedang Dipicking oleh Picker Lain';
      setDistNotification({
        type: 'error',
        message: `❌ KERANJANG INDUK SEDANG AKTIF: Keranjang "${cleanBasket}" saat ini masih aktif digunakan oleh ${busyCount} order lain (${stage}) yang belum selesai proses. Tunggu sampai keranjang ini selesai dikemas & dikirim, atau gunakan keranjang fisik yang lain!`
      });
      playBuzzer(false);
      speakVoice('Keranjang induk sedang digunakan order lain');
      setTimeout(() => {
        distBasketInputRef.current?.focus();
        distBasketInputRef.current?.select();
      }, 100);
      return;
    }

    basketBindingBusy.current = true; setIsBindingBasket(true);
    try {
      const result = await onUpdateOrderSession(distActiveBatchOrders.map(o => o.referenceNumber), {basketNumber:cleanBasket,masterBasketNumber:cleanBasket,pickingBy:pickerActorName || 'Picker Staff',pickingStartedAt:new Date().toISOString()});
      if (!result) throw new Error('Server belum mengonfirmasi. Periksa data terbaru sebelum mengulang.');
      setDistActiveBatchOrders(prev => prev.map(order => ({...order,basketNumber:cleanBasket,masterBasketNumber:cleanBasket,pickingBy:pickerActorName || 'Picker Staff',items:result.orders.filter(o => o.referenceNumber === order.referenceNumber)})));
      setDistBoundBasket(cleanBasket);
      setDistNotification({type:'success',message:'Keranjang Induk "'+cleanBasket+'" berhasil diikat untuk '+distActiveBatchOrders.length+' Order!'});
      playBuzzer(true); speakVoice('Keranjang induk '+cleanBasket+' berhasil disimpan.');
    } catch (error: any) {
      setDistNotification({type:'error',message:'Keranjang belum dikonfirmasi: '+(error.message || 'Penyimpanan gagal.')});
      playBuzzer(false);
    } finally { basketBindingBusy.current = false; setIsBindingBasket(false); }
  };

  // Selesaikan seluruh tugas picking batch secara atomic, simpan ke database, muat ke meja sortir, dan bersihkan layar picking
  const finalizeBatchPicking = async (
    basketCode: string,
    ordersToFinalize = distActiveBatchOrders
  ) => {
    if (ordersToFinalize.length === 0 || !basketCode) return;

    const cleanBasket = basketCode.trim().toUpperCase();

    // Verifikasi keranjang tidak konflik dengan batch lain
    const currentBatchRefs = new Set(ordersToFinalize.map(o => o.referenceNumber));
    const conflicts = pendingOrders.filter(ord => {
      if (currentBatchRefs.has(ord.referenceNumber)) return false;
      return (ord.basketNumber || '').trim().toUpperCase() === cleanBasket;
    });
    if (conflicts.length > 0) {
      setDistNotification({
        type: 'error',
        message: `❌ Keranjang Induk "${cleanBasket}" sedang aktif digunakan oleh batch lain (${conflicts.length} order belum selesai). Ganti keranjang fisik lain sebelum menyelesaikan picking!`
      });
      playBuzzer(false);
      speakVoice('Keranjang induk sedang dipakai order lain');
      return;
    }

    // 1. Simpan perubahan ke orderHistory & potong stok untuk semua order di batch ini secara atomic
    const batchUpdates = ordersToFinalize.map(ord => ({
      refNum: ord.referenceNumber,
      updatedItems: ord.items.map(it => ({
        ...it,
        picked: true,
        pickedBy: currentUser?.fullName || 'Picker Staff',
        basketNumber: cleanBasket,
        masterBasketNumber: cleanBasket
      })),
      isPicking: true
    }));

    if (onEditMultipleOrdersBatch) {
      if(!await onEditMultipleOrdersBatch(batchUpdates))return;
    } else if (onEditOrderHistoryBatch) {
      for(const u of batchUpdates)if(!await onEditOrderHistoryBatch(u.refNum,u.updatedItems,u.isPicking))return;
    }

    const finishedRefs = ordersToFinalize.map(o => o.referenceNumber);
    setDistCompletedBatchRefs(prev => Array.from(new Set([...prev, ...finishedRefs])));

    // 2. Otomatis inisialisasi & muat meja Sortir (Screen 2) dengan keranjang induk ini!
    setSortTaskInput(cleanBasket);
    setSortActiveMasterBasket(cleanBasket);

    const rawPrefix = sortPackerPrefix.trim().toUpperCase() || '';
    const batchSlice = ordersToFinalize.slice(0, 20);
    const batchRefs = batchSlice.map(o => o.referenceNumber);
    const proposedBaskets = rawPrefix ? batchSlice.map((_, idx) => `${rawPrefix}${idx + 1}`) : [];
    const prefixConflicts = rawPrefix
      ? findActiveBasketConflicts(orderHistory || [], proposedBaskets, batchRefs)
      : [];
    const currentPrefix = rawPrefix && prefixConflicts.length === 0 ? rawPrefix : '';
    const newSlots: SortBasketSlot[] = batchSlice.map((ord, idx) => {
      const slotNum = idx + 1;
      const initialDecomp: { [itemId: string]: number } = {};
      ord.items.forEach(it => {
        initialDecomp[it.id] = 0;
      });

      return {
        slotNumber: slotNum,
        basketCode: currentPrefix ? `${currentPrefix}${slotNum}` : '',
        isBasketBound: Boolean(currentPrefix),
        order: {
          ...ord,
          basketNumber: cleanBasket,
          masterBasketNumber: cleanBasket,
          isPicked: true
        },
        itemsDecomposed: initialDecomp,
        isComplete: false
      };
    });

    setSortActiveMasterBasket(cleanBasket);
    setSortSlots(newSlots);
    setSortSelectedSlotNumber(1);
    setSortTargetSlotForBind(1);
    setSortBasketInputManual('');
    saveSortSessionToStorage(cleanBasket, currentPrefix, newSlots);
    setSortNotification({ 
      type: prefixConflicts.length > 0 ? 'error' : 'success', 
      message: prefixConflicts.length > 0
        ? `❌ Keranjang Induk "${cleanBasket}" dimuat, namun Kode Packer "${rawPrefix}" DITOLAK karena masih aktif di ${formatBasketConflictSummary(prefixConflicts)}. Gunakan Kode Packer lain!`
        : currentPrefix 
        ? `✓ Batch Selesai! Keranjang Induk "${cleanBasket}" (${newSlots.length} pesanan) dimuat ke meja Sortir (${currentPrefix}1 s/d ${currentPrefix}${newSlots.length}).`
        : `✓ Batch Selesai! Keranjang Induk "${cleanBasket}" (${newSlots.length} pesanan) dimuat ke meja Sortir. Silakan isi kode anak keranjang untuk setiap slot.`
    });

    // 3. Reset total layar picking agar kosong dan siap untuk batch berikutnya!
    setDistActiveBatchOrders([]);
    setDistActiveTaskRef(null);
    setDistBoundBasket('');
    setDistPickedCounts({});
    setDistProductInput('');
    setDistBasketInput('');
    setDistNotification({ 
      type: 'success', 
      message: isPickerRole
        ? `✓ Selesai! Keranjang Induk "${cleanBasket}" (${ordersToFinalize.length} Order) berhasil di-pick dan siap disortir oleh Packer. Silakan lanjutkan pengambilan batch berikutnya.`
        : `✓ Selesai! Keranjang Induk "${cleanBasket}" (${ordersToFinalize.length} Order) berhasil di-pick dan otomatis dipindahkan ke Meja Sortir.` 
    });

    // 4. Pindah ke layar Sortir HANYA jika BUKAN akun Picker
    if (isPickerRole) {
      switchScreen('distribution');
      playBuzzer(true);
      speakVoice(`Semua barang keranjang ${cleanBasket} selesai diambil. Silakan ambil tugas berikutnya.`);
      setTimeout(() => {
        distBasketInputRef.current?.focus();
      }, 100);
    } else {
      switchScreen('sorting');
      playBuzzer(true);
      speakVoice(`Semua barang keranjang ${cleanBasket} selesai. Beralih ke meja sortir.`);
    }
  };

  // Scan product barcode in Global Picking (M Distribution)
  const handleDistScanProduct = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const barcode = distProductInput.trim();
    if (!barcode) return;
    if (distActiveBatchOrders.length === 0) {
      setDistNotification({ type: 'error', message: 'Tidak ada tugas aktif. Klik "Ambil tugas" terlebih dahulu.' });
      playBuzzer(false);
      return;
    }
    if (!distBoundBasket) {
      setDistNotification({ type: 'error', message: 'Harap ikat nomor keranjang distribusi induk terlebih dahulu sebelum scan barang!' });
      playBuzzer(false);
      speakVoice('Harap ikat keranjang induk dahulu');
      return;
    }

    const matchedSkuId = findSkuId(barcode);
    const targetGroup = distConsolidatedItems.find(grp => {
      const itSkuClean = grp.skuId.trim().toUpperCase();
      return (itSkuClean === matchedSkuId || itSkuClean === barcode.toUpperCase()) &&
             ((distPickedCounts[pickingLotKey(grp)] || 0) < grp.totalQty);
    });

    if (targetGroup) {
      const key = pickingLotKey(targetGroup);
      const currentVal = distPickedCounts[key] || 0;
      const nextVal = currentVal + 1;
      const newCounts = { ...distPickedCounts, [key]: nextVal };
      setDistPickedCounts(newCounts);
      setDistProductInput('');
      playBuzzer(true);
      speakVoice(`Barang cocok. Sisa ${targetGroup.totalQty - nextVal}`);

      // Check if all items across all 20 batch orders are picked
      const allPicked = distConsolidatedItems.every(grp => {
        const k = pickingLotKey(grp);
        return (newCounts[k] || 0) >= grp.totalQty;
      });

      if (allPicked) {
        finalizeBatchPicking(distBoundBasket, distActiveBatchOrders);
      } else {
        setDistNotification({ type: 'success', message: `Berhasil pick 1x ${targetGroup.skuName}` });
      }
    } else {
      setDistNotification({ type: 'error', message: `❌ Barcode "${barcode}" tidak ditemukan atau kuantitasnya sudah lengkap di tugas picking ini!` });
      playBuzzer(false);
      speakVoice('Barang salah atau kuantitas sudah cukup');
      setDistProductInput('');
    }
  };

  // Ambil semua barang dalam batch tugas sekaligus (Pick All)
  const handlePickAllCurrentBatch = () => {
    if (distActiveBatchOrders.length === 0) {
      setDistNotification({ type: 'error', message: 'Tidak ada tugas aktif. Klik "Ambil tugas" terlebih dahulu.' });
      playBuzzer(false);
      return;
    }
    if (!distBoundBasket) {
      setDistNotification({ type: 'error', message: 'Harap ikat nomor keranjang induk (misal GB-01) terlebih dahulu!' });
      playBuzzer(false);
      speakVoice('Harap ikat keranjang induk dahulu');
      return;
    }

    if(!window.confirm('Konfirmasi pengambilan massal '+distConsolidatedItems.length+' baris lokasi / '+distTotalConsolidatedQty+' pcs. Pastikan seluruh barang sudah diambil secara fisik. Lanjutkan?'))return;
    // Set seluruh hitungan picked SKU menjadi jumlah totalnya
    const completedCounts: { [sku: string]: number } = {};
    distConsolidatedItems.forEach(grp => {
      completedCounts[pickingLotKey(grp)] = grp.totalQty;
    });
    setDistPickedCounts(completedCounts);

    finalizeBatchPicking(distBoundBasket, distActiveBatchOrders);
  };

  // Complete picking manually for whole batch
  const handleManualCompletePick = () => {
    if (distActiveBatchOrders.length === 0 || !distBoundBasket) return;
    if(distTotalPickedQty<distTotalConsolidatedQty){setDistNotification({type:'error',message:'Verifikasi semua baris lokasi sebelum menyelesaikan pengambilan.'});return;}
    finalizeBatchPicking(distBoundBasket, distActiveBatchOrders);
  };

  // Mulai batch baru setelah batch sebelumnya selesai
  const handleStartNextBatch = () => {
    const finishedRefs = distActiveBatchOrders.map(o => o.referenceNumber);
    const updatedCompletedRefs = Array.from(new Set([...distCompletedBatchRefs, ...finishedRefs]));
    setDistCompletedBatchRefs(updatedCompletedRefs);

    setDistActiveBatchOrders([]);
    setDistActiveTaskRef(null);
    setDistBoundBasket('');
    setDistBasketInput('');
    setDistPickedCounts({});
    setDistNotification(null);
    
    // Panggil handleGetTask dengan daftar order yang sudah diselesaikan agar tidak terpilih kembali
    handleGetTask(finishedRefs);
  };

  // =========================================================================
  // =========================================================================
  // SCREEN 2: M SORTING (PECAH 1 KERANJANG INDUK MENJADI HINGGA 20 BASKET ORDER)
  // SETIAP PACKER MEMILIKI KODE KERANJANG MASING-MASING:
  // MISAL PACKER 1 MEMAKAI KODE "A" -> BASKETNYA A1 s/d A20
  // PACKER 2 MEMAKAI KODE "RR" -> BASKETNYA RR1 s/d RR20
  // =========================================================================
  const [sortTaskInput, setSortTaskInput] = useState<string>('');
  const sortTaskInputRef = useRef<HTMLInputElement>(null);
  const [sortProductInput, setSortProductInput] = useState<string>('');
  const sortProductRef = useRef<HTMLInputElement>(null);
  const sortPackerPrefixRef = useRef<HTMLInputElement>(null);
  const sortBasketInputRef = useRef<HTMLInputElement>(null);
  const [sortCompactMode, setSortCompactMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('wms_sort_compact_mode') === 'true';
    } catch {
      return false;
    }
  });
  const toggleSortCompactMode = () => {
    setSortCompactMode(prev => {
      const next = !prev;
      try { localStorage.setItem('wms_sort_compact_mode', String(next)); } catch {}
      return next;
    });
  };
  const [sortActiveMasterBasket, setSortActiveMasterBasket] = useState<string | null>(null);
  const [sortPackerPrefix, setSortPackerPrefix] = useState<string>(''); // biarkan kosong default-nya sesuai instruksi
  const [sortTargetSlotForBind, setSortTargetSlotForBind] = useState<number>(1);
  const [sortBasketInputManual, setSortBasketInputManual] = useState<string>('');
  const useBaselineSort = DEV_BASELINE_SORTING || !SERVER_SCAN_ENABLED;
  
  // 20 Basket Slots: Mapping each order to basket slot 1 s/d 20
  interface SortBasketSlot {
    slotNumber: number; // 1 to 20
    basketCode: string; // misal A1-A20, RR1-RR20, atau custom
    isBasketBound: boolean; // flag apakah sorter sudah input/scan basketnya
    order: typeof pendingOrders[0];
    itemsDecomposed: { [itemId: string]: number };
    isComplete: boolean;
  }
  const sortSaveBusy=useRef(false);
  const [savingSort,setSavingSort]=useState(false);
  const [sortSlots, setSortSlots] = useState<SortBasketSlot[]>([]);
  const [sortLastAssignedSlot, setSortLastAssignedSlot] = useState<number | null>(null);
  const [sortSelectedSlotNumber, setSortSelectedSlotNumber] = useState<number | null>(null);
  const [sortNotification, setSortNotification] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const sortControllers = useRef(new Map<string, ReturnType<typeof createSortingServerSession>>());
  const [sortStarted, setSortStarted] = useState(false);
  const [sortServerReady, setSortServerReady] = useState(false);
  const sortRestoreAttempted = useRef(false);
  const [sortRightPanelMode, setSortRightPanelMode] = useState<'sku' | 'slot'>('sku');
  const [sortLastScannedSku, setSortLastScannedSku] = useState<{
    skuId: string;
    skuName: string;
    barcode: string;
    basketCode: string;
    slotNumber: number;
    itemScanned: number;
    itemRequired: number;
  } | null>(null);
  const prevSortSnapshotRef = useRef<{
    master: string | null;
    refsKey: string;
    countsByRef: Record<string, Record<string, number>>;
  }>({ master: null, refsKey: '', countsByRef: {} });

  // Deteksi SKU yang baru discan dari perubahan sortSlots agar panel hero & panel kanan
  // selalu sinkron baik di mode server scan maupun baseline tanpa mengubah handler RPC.
  useEffect(() => {
    if (sortSlots.length === 0) {
      prevSortSnapshotRef.current = { master: null, refsKey: '', countsByRef: {} };
      setSortLastScannedSku(null);
      setSortRightPanelMode('sku');
      return;
    }

    const refsKey = sortSlots.map(s => s.order.referenceNumber).join('|');
    const nextCountsByRef: Record<string, Record<string, number>> = {};
    for (const slot of sortSlots) {
      nextCountsByRef[slot.order.referenceNumber] = { ...slot.itemsDecomposed };
    }

    const prev = prevSortSnapshotRef.current;
    const isSameBatch = prev.refsKey === refsKey && prev.master === (sortActiveMasterBasket || null);

    if (!isSameBatch) {
      prevSortSnapshotRef.current = {
        master: sortActiveMasterBasket || null,
        refsKey,
        countsByRef: nextCountsByRef
      };
      setSortLastScannedSku(null);
      setSortRightPanelMode('sku');
      return;
    }

    const increments: Array<{
      slot: SortBasketSlot;
      item: OutboundItem;
      nextCount: number;
      diff: number;
    }> = [];
    let anyDecreased = false;

    for (const slot of sortSlots) {
      const prevMap = prev.countsByRef[slot.order.referenceNumber] || {};
      for (const item of slot.order.items) {
        const before = prevMap[item.id] || 0;
        const after = slot.itemsDecomposed[item.id] || 0;
        if (after > before) {
          increments.push({ slot, item, nextCount: after, diff: after - before });
        } else if (after < before) {
          anyDecreased = true;
        }
      }
    }

    prevSortSnapshotRef.current = {
      master: sortActiveMasterBasket || null,
      refsKey,
      countsByRef: nextCountsByRef
    };

    if (anyDecreased) {
      setSortLastScannedSku(null);
      setSortRightPanelMode('sku');
      return;
    }

    if (increments.length === 1 && increments[0].diff === 1) {
      const { slot, item, nextCount } = increments[0];
      const catalogBarcode =
        getBarcodeForSku(item.skuId) ||
        stock.find(st => st.skuId.trim().toUpperCase() === item.skuId.trim().toUpperCase())?.barcode ||
        '';
      setSortLastScannedSku({
        skuId: item.skuId,
        skuName: item.skuName || item.skuId,
        barcode: catalogBarcode,
        basketCode: slot.basketCode,
        slotNumber: slot.slotNumber,
        itemScanned: nextCount,
        itemRequired: item.qty
      });
      setSortRightPanelMode('sku');
    }
  }, [sortSlots, sortActiveMasterBasket, stock]);

  useEffect(() => {
    if ((DEV_BASELINE_SORTING || (resolveSortingTarget && SERVER_SCAN_ENABLED)) && currentScreen === 'sorting' && !savingSort &&
        sortSlots.length > 0 && sortSlots.every(slot => slot.isBasketBound && slot.basketCode.trim())) {
      sortProductRef.current?.focus();
    }
  }, [resolveSortingTarget, currentScreen, savingSort, sortSlots]);

  // Helper persistence functions for Sortir (Anti-Mati Listrik / Re-load Induk)
  const getSortSessionKey = (branch: string, masterBasket: string) => 
    `wms_mabang_sort_session_${branch.toUpperCase()}_${masterBasket.trim().toUpperCase()}`;
  const getActiveSortMasterKey = (branch: string) => 
    `wms_mabang_active_sort_basket_${branch.toUpperCase()}`;

  const saveSortSessionToStorage = (
    masterBasket: string,
    packerPrefix: string,
    slots: SortBasketSlot[]
  ) => {
    try {
      const branch = getActiveBranch() || 'DEFAULT';
      const cleanBasket = masterBasket.trim().toUpperCase();
      if (!cleanBasket || !slots.length) return;

      const sessionData = {
        branch,
        masterBasket: cleanBasket,
        packerPrefix: packerPrefix.trim().toUpperCase() || '',
        updatedAt: new Date().toISOString(),
        slots: slots.map(s => ({
          slotNumber: s.slotNumber,
          basketCode: s.basketCode,
          isBasketBound: s.isBasketBound,
          referenceNumber: s.order.referenceNumber,
          itemsDecomposed: s.itemsDecomposed,
          isComplete: s.isComplete
        }))
      };

      localStorage.setItem(getSortSessionKey(branch, cleanBasket), JSON.stringify(sessionData));
      localStorage.setItem(getActiveSortMasterKey(branch), cleanBasket);
    } catch (err) {
      console.warn('Gagal menyimpan sesi sortir ke localStorage:', err);
    }
  };

  const clearSortSessionFromStorage = (masterBasket?: string | null) => {
    try {
      const branch = getActiveBranch() || 'DEFAULT';
      if (masterBasket) {
        localStorage.removeItem(getSortSessionKey(branch, masterBasket));
      }
      localStorage.removeItem(getActiveSortMasterKey(branch));
    } catch {}
  };

  const sortingIdentity = async () => {
    if (!SERVER_SCAN_ENABLED || !supabase) throw new Error(scanServerUnavailable);
    const branch = getActiveBranch();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user || branch !== getActiveBranch()) throw new Error('Identitas operator atau cabang tidak terverifikasi.');
    return { branch, actor: data.user.id };
  };
  const sortingLock = async <T,>(name: string, action: () => Promise<T>): Promise<T> => {
    if (!navigator.locks) throw new Error('Browser tidak mendukung penguncian sesi sortir yang aman.');
    return navigator.locks.request(name, {ifAvailable:true}, async held => {
      if (!held) throw new Error('Sesi sortir sedang digunakan di tab lain.');
      return action();
    });
  };
  const sortingController = async (reference: string) => {
    const { branch, actor } = await sortingIdentity();
    const key = JSON.stringify([branch, actor, reference]);
    let controller = sortControllers.current.get(key);
    if (!controller) {
      controller = createSortingServerSession(serverScanRpc, localStorage, () => crypto.randomUUID(), branch, actor, reference, sortingLock);
      sortControllers.current.set(key, controller);
    }
    return controller;
  };
  const sortingTaskKey = (branch: string, actor: string) => `wms-sorting-task-v1:${JSON.stringify([branch, actor])}`;
  const persistSortingTask = async () => {
    const {branch, actor} = await sortingIdentity();
    const key = sortingTaskKey(branch, actor);
    const value = JSON.stringify(sortSlots.map(slot => ({ reference: slot.order.referenceNumber, basket: slot.basketCode })));
    await sortingLock(key, async () => {
      const existing = localStorage.getItem(key);
      if (existing && existing !== value) throw new Error('Tugas sortir tersimpan berbeda. Pulihkan tugas sebelumnya dahulu.');
      localStorage.setItem(key, value);
    });
  };

  const applySortingProgress = (slot: SortBasketSlot, progress: ScanProgress) => {
    if (progress.reference !== slot.order.referenceNumber ||
        progress.counts.length !== slot.order.items.length ||
        slot.order.items.some(item => !progress.counts.some(line =>
          line.documentId === item.id && line.sku.trim().toUpperCase() === item.skuId.trim().toUpperCase() && line.required === item.qty))) {
      throw new Error('Baris order tidak cocok dengan sesi server. Muat ulang data.');
    }
    const counts = Object.fromEntries(progress.counts.map(line => [line.documentId, line.scanned]));
    setSortSlots(previous => {
      const next = previous.map(current => current.order.referenceNumber === slot.order.referenceNumber
        ? { ...current, basketCode: progress.basket, itemsDecomposed: counts,
            isComplete: progress.current && progress.counts.every(line => line.scanned === line.required) }
        : current);
      if (sortActiveMasterBasket) {
        saveSortSessionToStorage(sortActiveMasterBasket, sortPackerPrefix, next);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!SERVER_SCAN_ENABLED || !currentUser || !pendingOrders.length || sortRestoreAttempted.current) return;
    sortRestoreAttempted.current = true;
    let active = true;
    let acquired = false;
    (async () => {
      try {
        const {branch, actor} = await sortingIdentity();
        const raw = localStorage.getItem(sortingTaskKey(branch, actor));
        if (!raw || !active) return;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.length || parsed.length > 20) throw new Error('Tugas sortir tersimpan tidak valid.');
        const restored: SortBasketSlot[] = parsed.map((entry, index) => {
          if (!entry || typeof entry !== 'object' || typeof entry.reference !== 'string' ||
              typeof entry.basket !== 'string' || !entry.basket.trim()) throw new Error('Tugas sortir tersimpan tidak valid.');
          const order = pendingOrders.find(candidate => candidate.referenceNumber === entry.reference);
          if (!order) throw new Error('Order sesi tersimpan tidak ditemukan. Periksa data terbaru.');
          return {slotNumber:index + 1,basketCode:entry.basket,isBasketBound:true,order,itemsDecomposed:{},isComplete:false};
        });
        if (new Set(restored.map(slot => slot.order.referenceNumber)).size !== restored.length) throw new Error('Tugas sortir tersimpan duplikat.');
        if (!active || getActiveBranch() !== branch) return;
        if (sortSaveBusy.current || !active) return;
        acquired = true; sortSaveBusy.current = true; setSavingSort(true); setSortStarted(true);
        setSortSlots(restored); setSortSelectedSlotNumber(1);
        for (const slot of restored) {
          const controller = await sortingController(slot.order.referenceNumber);
          const progress = await controller.open(slot.basketCode);
          if (!active || getActiveBranch() !== branch) return;
          applySortingProgress(slot, progress);
        }
        if (active) {
          setSortServerReady(restored.every(slot => !sortControllers.current.get(JSON.stringify([branch, actor, slot.order.referenceNumber]))?.hasPending()));
          setSortNotification({type:'info',message:'Sesi dipulihkan dari server. Jika ada respons belum diketahui, gunakan Pulihkan sesi.'});
        }
      } catch (error) {
        if (active) { setSortServerReady(false); setSortNotification({type:'error',message:error instanceof Error ? error.message : 'Pemulihan sesi gagal.'}); }
      } finally {
        if (acquired) sortSaveBusy.current = false;
        if (active && acquired) setSavingSort(false);
      }
    })();
    return () => { active = false; };
  }, [currentUser?.username, pendingOrders.length > 0]);

  // Auto-restore sesi sortir setelah mati listrik / refresh browser (Anti-Mati Listrik)
  useEffect(() => {
    if (currentScreen !== 'sorting' || sortSlots.length > 0 || !pendingOrders.length) return;
    try {
      const branch = getActiveBranch() || 'DEFAULT';
      const activeMaster = localStorage.getItem(getActiveSortMasterKey(branch));
      if (!activeMaster) return;

      const savedRaw = localStorage.getItem(getSortSessionKey(branch, activeMaster));
      if (!savedRaw) return;

      const session = JSON.parse(savedRaw);
      if (!session || !session.slots || !Array.isArray(session.slots) || !session.slots.length) return;

      const restoredSlots: SortBasketSlot[] = [];
      for (const s of session.slots) {
        const ord = pendingOrders.find(o => o.referenceNumber === s.referenceNumber && o.isPicked && !o.isSorted);
        if (ord) {
          const initialDecomp: { [itemId: string]: number } = {};
          ord.items.forEach(it => { initialDecomp[it.id] = 0; });
          const itemsDecomp = { ...initialDecomp, ...(s.itemsDecomposed || {}) };
          const isComplete = ord.items.every(line => (itemsDecomp[line.id] || 0) >= line.qty);
          restoredSlots.push({
            slotNumber: s.slotNumber,
            basketCode: s.basketCode,
            isBasketBound: true,
            order: ord,
            itemsDecomposed: itemsDecomp,
            isComplete
          });
        }
      }

      if (restoredSlots.length > 0) {
        setSortActiveMasterBasket(session.masterBasket);
        setSortPackerPrefix(session.packerPrefix || '');
        setSortTaskInput(session.masterBasket);
        setSortSlots(restoredSlots);
        setSortSelectedSlotNumber(1);
        const completedCount = restoredSlots.filter(s => s.isComplete).length;
        const totalScanned = restoredSlots.reduce((sum, s) => sum + Object.values(s.itemsDecomposed).reduce((a, b) => a + b, 0), 0);
        setSortNotification({
          type: 'info',
          message: `⚡ SESI SORTIR DIPULIHKAN: Ditemukan sesi aktif keranjang induk "${session.masterBasket}" (${completedCount} dari ${restoredSlots.length} keranjang selesai, total ${totalScanned} pcs tersortir). Silakan lanjutkan!`
        });
        playBuzzer(true);
        speakVoice(`Sesi sortir keranjang ${session.masterBasket} dipulihkan.`);
        setTimeout(() => {
          sortProductRef.current?.focus();
        }, 150);
      } else {
        clearSortSessionFromStorage(activeMaster);
      }
    } catch (err) {
      console.warn('Gagal memulihkan sesi sortir otomatis:', err);
    }
  }, [currentScreen, pendingOrders]);

  // Cek apakah semua slot yang aktif sudah diinput keranjangnya
  const allBasketsBound = useMemo(() => {
    if (sortSlots.length === 0) return false;
    return sortSlots.every(s => s.isBasketBound && s.basketCode.trim() !== '');
  }, [sortSlots]);

  // Next slot yang belum diikat keranjangnya
  const nextUnboundSlot = useMemo(() => {
    return sortSlots.find(s => !s.isBasketBound);
  }, [sortSlots]);

  // Handler Terapkan Kode Packer (misal "A" -> A1 s/d A20, "RR" -> RR1 s/d RR20)
  const handleApplyPackerPrefix = (prefixToUse?: string): boolean => {
    if (sortStarted || sortSaveBusy.current) { setSortNotification({type:'error',message:'Keranjang tidak dapat diubah setelah sesi server dimulai.'}); return false; }
    if (sortSlots.length === 0) {
      setSortNotification({ type: 'error', message: 'Muat tugas sortir terlebih dahulu sebelum mengatur keranjang packer!' });
      playBuzzer(false);
      return false;
    }

    const cleanPrefix = (prefixToUse || sortPackerPrefix).trim().toUpperCase();
    if (!cleanPrefix) {
      setSortNotification({ type: 'error', message: 'Kode Packer tidak boleh kosong (misal: A, RR, P1)!' });
      playBuzzer(false);
      return false;
    }

    const batchRefs = sortSlots.map(s => s.order.referenceNumber);
    const candidateBaskets = sortSlots.map(s => `${cleanPrefix}${s.slotNumber}`);
    const conflicts = findActiveBasketConflicts(orderHistory || [], candidateBaskets, batchRefs);
    if (conflicts.length > 0) {
      setSortNotification({
        type: 'error',
        message: `❌ DITOLAK: Kode Packer "${cleanPrefix}" bentrok dengan order yang masih aktif (${formatBasketConflictSummary(conflicts)}). Tunggu order di antrian Packing selesai dikemas atau gunakan Kode Packer lain!`
      });
      playBuzzer(false);
      speakVoice('Kode packer masih dipakai di antrian packing');
      setTimeout(() => {
        sortPackerPrefixRef.current?.focus();
        sortPackerPrefixRef.current?.select();
      }, 50);
      return false;
    }

    const updated = sortSlots.map(s => ({
      ...s,
      basketCode: `${cleanPrefix}${s.slotNumber}`,
      isBasketBound: true
    }));

    setSortSlots(updated);
    setSortLastAssignedSlot(null);
    setSortPackerPrefix(cleanPrefix);
    if (sortActiveMasterBasket) {
      saveSortSessionToStorage(sortActiveMasterBasket, cleanPrefix, updated);
    }
    setSortNotification({ 
      type: 'success', 
      message: `✓ Berhasil mengatur keranjang Packer "${cleanPrefix}": ${updated[0].basketCode} s/d ${updated[updated.length - 1].basketCode}!` 
    });
    playBuzzer(true);
    speakVoice(`Keranjang packer ${cleanPrefix} dari satu sampai ${updated.length} terpasang.`);
    setTimeout(() => {
      sortProductRef.current?.focus();
      sortProductRef.current?.select();
    }, 100);
    return true;
  };

  // Load task / master basket for sorting
  const handleLoadSortTask = async (e?: React.FormEvent | null, explicitQuery?: string) => {
    if (e) e.preventDefault();
    if (sortSaveBusy.current || sortStarted) { setSortNotification({type:'error',message:'Selesaikan atau pulihkan sesi sortir sebelum memuat tugas lain.'}); return; }
    const rawQuery = explicitQuery !== undefined ? explicitQuery : sortTaskInput;
    const query = rawQuery.trim().toUpperCase();
    if (!query) return;
    if (explicitQuery !== undefined) {
      setSortTaskInput(query);
    }

    let eligibleOrders = pendingOrders;
    if (loadSortingReferences) {
      sortSaveBusy.current = true; setSavingSort(true);
      try {
        const references = await loadSortingReferences();
        eligibleOrders = pendingOrders.filter(order => references.includes(order.referenceNumber));
      } catch (error) {
        setSortNotification({type:'error',message:error instanceof Error ? error.message : 'Status sortir tidak tersedia.'});
        return;
      } finally { sortSaveBusy.current = false; setSavingSort(false); }
    }

    // Hanya muat pesanan yang benar-benar sudah selesai picking dan belum disortir.
    const {
      readyOrders: matchingOrders,
      fellBackToSingleOrder,
      alreadySortedCount,
      unpickedCount
    } = selectSortLoadCandidates(eligibleOrders, query);


    if (matchingOrders.length > 0) {
      const ordersToDecompose = matchingOrders.slice(0, 20);
      const resolvedSingleBasket = fellBackToSingleOrder
        ? (ordersToDecompose[0].masterBasketNumber || ordersToDecompose[0].basketNumber || '').trim().toUpperCase()
        : '';
      const masterBasketName = resolvedSingleBasket || query || ordersToDecompose[0].masterBasketNumber || ordersToDecompose[0].basketNumber || 'GB-01';
      setSortActiveMasterBasket(masterBasketName);

      // Inisialisasi 20 Slot Keranjang Sortir dengan pemulihan progress sebelumnya (Anti-Mati Listrik)
      const branch = getActiveBranch() || 'DEFAULT';
      const savedRaw = localStorage.getItem(getSortSessionKey(branch, masterBasketName));
      let savedSession: {
        packerPrefix?: string;
        slots?: Array<{
          slotNumber: number;
          basketCode: string;
          isBasketBound?: boolean;
          referenceNumber: string;
          itemsDecomposed: { [itemId: string]: number };
          isComplete: boolean;
        }>;
      } | null = null;

      if (savedRaw) {
        try {
          savedSession = JSON.parse(savedRaw);
        } catch {}
      }

      const batchRefs = ordersToDecompose.map(ord => ord.referenceNumber);
      const rawPrefix = savedSession?.packerPrefix || sortPackerPrefix.trim().toUpperCase() || '';
      const prefixConflicts = rawPrefix
        ? findActiveBasketConflicts(orderHistory || [], ordersToDecompose.map((_, idx) => `${rawPrefix}${idx + 1}`), batchRefs)
        : [];
      const currentPrefix = rawPrefix && prefixConflicts.length === 0 ? rawPrefix : '';
      if (savedSession?.packerPrefix && prefixConflicts.length === 0) {
        setSortPackerPrefix(savedSession.packerPrefix);
      }

      const restoredBasketConflicts: ReturnType<typeof findActiveBasketConflicts> = [];
      let restoredAnyProgress = false;
      const newSlots: SortBasketSlot[] = ordersToDecompose.map((ord, idx) => {
        const slotNum = idx + 1;
        const initialDecomp: { [itemId: string]: number } = {};
        ord.items.forEach(it => {
          initialDecomp[it.id] = 0;
        });

        // Cari apakah ada progres tersimpan untuk order ini
        const prevSlot = savedSession?.slots?.find(s => s.referenceNumber === ord.referenceNumber);
        let itemsDecomp = initialDecomp;
        let prevBasketCode = prevSlot?.basketCode || '';
        if (prevBasketCode) {
          const prevConflicts = findActiveBasketConflicts(orderHistory || [], [prevBasketCode], batchRefs);
          if (prevConflicts.length > 0) {
            restoredBasketConflicts.push(...prevConflicts);
            prevBasketCode = '';
          }
        }
        const basketCode = prevBasketCode || (currentPrefix ? `${currentPrefix}${slotNum}` : '');
        const isBasketBound = Boolean(prevBasketCode ? prevSlot?.isBasketBound : (currentPrefix && basketCode));
        let isComplete = false;

        if (prevSlot && prevSlot.itemsDecomposed) {
          itemsDecomp = { ...initialDecomp, ...prevSlot.itemsDecomposed };
          isComplete = ord.items.every(line => (itemsDecomp[line.id] || 0) >= line.qty);
          if (Object.values(itemsDecomp).some(cnt => cnt > 0)) {
            restoredAnyProgress = true;
          }
        }

        return {
          slotNumber: slotNum,
          basketCode,
          isBasketBound,
          order: ord,
          itemsDecomposed: itemsDecomp,
          isComplete
        };
      });

      setSortSlots(newSlots);
      setSortSelectedSlotNumber(1);
      if (clearSortingIndicatorOnSelection) setSortLastAssignedSlot(null);
      const firstUnbound = newSlots.find(s => !s.isBasketBound);
      setSortTargetSlotForBind(firstUnbound ? firstUnbound.slotNumber : 1);
      setSortBasketInputManual('');

      // Simpan sesi terverifikasi ke storage
      saveSortSessionToStorage(masterBasketName, currentPrefix, newSlots);

      const completedSlotsCount = newSlots.filter(s => s.isComplete).length;
      const totalScannedPcs = newSlots.reduce((acc, s) => acc + Object.values(s.itemsDecomposed).reduce((a, b) => a + b, 0), 0);
      const allBound = newSlots.every(s => s.isBasketBound && s.basketCode.trim());
      const allLoadConflicts = [...prefixConflicts, ...restoredBasketConflicts];

      if (allLoadConflicts.length > 0) {
        setSortNotification({
          type: 'error',
          message: `❌ Order dimuat (${newSlots.length} pesanan), tetapi kode anak keranjang tidak dipasang otomatis karena masih aktif di antrian lain (${formatBasketConflictSummary(allLoadConflicts)}). Isi Kode Packer atau anak keranjang lain!`
        });
        playBuzzer(false);
        speakVoice('Kode keranjang masih aktif di antrian packing. Gunakan kode lain.');
      } else if (restoredAnyProgress) {
        setSortNotification({ 
          type: 'success', 
          message: `⚡ SESI SORTIR DILANJUTKAN: Keranjang Induk "${masterBasketName}" berhasil dimuat kembali! Progress sebelumnya aman (${completedSlotsCount} dari ${newSlots.length} keranjang selesai, total ${totalScannedPcs} pcs tersortir). Silakan lanjutkan!` 
        });
        playBuzzer(true);
        speakVoice(`Sesi sortir keranjang ${masterBasketName} dilanjutkan.`);
      } else {
        setSortNotification({ 
          type: 'success', 
          message: allBound
            ? `Order berhasil dimuat (${newSlots.length} pesanan). Anak keranjang siap digunakan!` 
            : `Order berhasil dimuat (${newSlots.length} pesanan). Silakan isi / scan kode anak keranjang untuk setiap slot terlebih dahulu!`
        });
        playBuzzer(true);
        speakVoice(allBound ? 'Order dimuat. Keranjang siap.' : 'Order dimuat. Silakan isi kode anak keranjang.');
      }
      setTimeout(() => {
        sortPackerPrefixRef.current?.focus();
        sortPackerPrefixRef.current?.select();
      }, 100);
    } else {
      const b2bMatch = (orderHistory || []).find(it => 
        it.status === 'Pending' && 
        Boolean(it.noPo && it.noPo.trim() !== '' && it.noPo.trim() !== '-') &&
        (it.referenceNumber?.toUpperCase() === query || 
         it.orderNumber?.toUpperCase() === query || 
         it.noPo?.toUpperCase() === query ||
         it.basketNumber?.toUpperCase() === query)
      );
      if (b2bMatch) {
        setSortNotification({ 
          type: 'error', 
          message: `Order "${b2bMatch.orderNumber || b2bMatch.referenceNumber}" terdeteksi sebagai Order B2B (No. PO: ${b2bMatch.noPo}). Silakan proses di menu Operasional > Outbound!` 
        });
        playBuzzer(false);
        speakVoice('Order B2B. Buka menu Outbound.');
        return;
      }
      if (unpickedCount > 0) {
        setSortNotification({
          type: 'error',
          message: `Keranjang / order "${query}" (${unpickedCount} pesanan) masih dalam proses 1. Picking. Tidak ada pesanan aktif yang siap disortir!`
        });
        playBuzzer(false);
        speakVoice('Order belum selesai dipick.');
        return;
      }
      if (alreadySortedCount > 0) {
        try {
          const branch = getActiveBranch() || 'DEFAULT';
          localStorage.removeItem(getSortSessionKey(branch, query));
        } catch {}
        setSortNotification({
          type: 'error',
          message: `Keranjang / order "${query}" (${alreadySortedCount} pesanan) sudah selesai disortir dan menunggu di 3. Packing! Tidak ada pesanan aktif yang siap disortir ulang.`
        });
        playBuzzer(false);
        speakVoice(`Keranjang ${query} sudah selesai disortir.`);
        return;
      }
      setSortNotification({ type: 'error', message: `Tidak ada pesanan aktif yang siap disortir untuk "${query}"!` });
      playBuzzer(false);
      speakVoice('Keranjang tidak ditemukan');
    }
  };

  const handleBaselineLoadSortTask = (e?: React.FormEvent) => {
    setSortLastAssignedSlot(null);
    return handleLoadSortTask(e);
  };

  // Handler input / scan basket manual untuk slot tertentu (opsional jika ada basket pengganti)
  const handleBindSlotBasket = (slotNum: number, basketVal?: string) => {
    if (sortStarted || sortSaveBusy.current) { setSortNotification({type:'error',message:'Keranjang tidak dapat diubah setelah sesi server dimulai.'}); return; }
    const code = (basketVal !== undefined ? basketVal : sortBasketInputManual).trim().toUpperCase();
    if (!code) {
      setSortNotification({ type: 'error', message: 'Kode anak keranjang tidak boleh kosong!' });
      playBuzzer(false);
      return;
    }

    // Cek apakah kode basket sama dengan keranjang induk
    if (code === (sortActiveMasterBasket || '').trim().toUpperCase()) {
      setSortNotification({ type: 'error', message: `Kode "${code}" adalah Keranjang Induk! Tidak boleh digunakan sebagai anak keranjang.` });
      playBuzzer(false);
      speakVoice('Tidak boleh memakai kode keranjang induk');
      return;
    }

    // Cek apakah kode basket sudah dipakai di slot lain dalam batch ini
    const isDuplicate = sortSlots.some(s => s.slotNumber !== slotNum && s.basketCode === code && s.isBasketBound);
    if (isDuplicate) {
      setSortNotification({ type: 'error', message: `Kode keranjang "${code}" sudah dipakai di slot lain! Gunakan keranjang berbeda.` });
      playBuzzer(false);
      speakVoice('Keranjang sudah dipakai');
      return;
    }

    // Cek apakah kode anak keranjang masih aktif dipakai oleh order lain di antrian Packing / Sortir / Picking
    const activeConflicts = findActiveBasketConflicts(
      orderHistory || [],
      [code],
      sortSlots.map(s => s.order.referenceNumber)
    );
    if (activeConflicts.length > 0) {
      setSortNotification({
        type: 'error',
        message: `❌ DITOLAK: Kode keranjang "${code}" masih aktif dipakai di ${formatBasketConflictSummary(activeConflicts)}. Tunggu sampai order tersebut selesai dikemas atau gunakan anak keranjang lain!`
      });
      playBuzzer(false);
      speakVoice('Keranjang masih aktif di antrian packing');
      setTimeout(() => {
        sortBasketInputRef.current?.focus();
        sortBasketInputRef.current?.select();
      }, 50);
      return;
    }

    const updated = sortSlots.map(s => {
      if (s.slotNumber === slotNum) {
        return {
          ...s,
          basketCode: code,
          isBasketBound: true
        };
      }
      return s;
    });

    setSortSlots(updated);
    setSortLastAssignedSlot(null);
    setSortBasketInputManual('');
    if (sortActiveMasterBasket) {
      saveSortSessionToStorage(sortActiveMasterBasket, sortPackerPrefix, updated);
    }
    playBuzzer(true);
    speakVoice(`Slot ${slotNum} diikat ke ${code}`);

    const nextUnbound = updated.find(s => !s.isBasketBound);
    if (nextUnbound) {
      setSortTargetSlotForBind(nextUnbound.slotNumber);
      setSortSelectedSlotNumber(nextUnbound.slotNumber);
      setSortNotification({ 
        type: 'success', 
        message: `✓ Slot #${slotNum} diikat ke anak keranjang "${code}". Selanjutnya Slot #${nextUnbound.slotNumber}.` 
      });
      setTimeout(() => {
        sortBasketInputRef.current?.focus();
      }, 50);
    } else {
      setSortNotification({ 
        type: 'success', 
        message: `✓ Semua ${updated.length} anak keranjang berhasil diikat! Silakan mulai scan produk (Langkah 3).` 
      });
      speakVoice('Semua anak keranjang lengkap. Silakan scan produk.');
      setTimeout(() => {
        sortProductRef.current?.focus();
      }, 100);
    }
  };

  const handleBaselineSortScanProduct = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (sortSaveBusy.current) return;
    const barcode = sortProductInput.trim();
    if (!barcode) return;
    setSortLastAssignedSlot(null);
    if (!sortSlots.length || !allBasketsBound) {
      setSortNotification({type:'error',message:!sortSlots.length ? 'Scan barcode tugas keranjang induk terlebih dahulu!' : 'Harap lengkapi nomor keranjang dahulu.'});
      playBuzzer(false);
      sortProductRef.current?.focus();
      return;
    }

    const matchedSkuId = findSkuId(barcode).trim().toUpperCase();
    let targetSlotIndex = -1;
    let targetItemIndex = -1;
    for (let sIdx = 0; sIdx < sortSlots.length; sIdx++) {
      const slot = sortSlots[sIdx];
      if (slot.isComplete) continue;
      const itemIdx = slot.order.items.findIndex(it => {
        const skuClean = it.skuId.trim().toUpperCase();
        const currentCount = slot.itemsDecomposed[it.id] || 0;
        return (skuClean === matchedSkuId || skuClean === barcode.toUpperCase()) && currentCount < it.qty;
      });
      if (itemIdx !== -1) {
        targetSlotIndex = sIdx;
        targetItemIndex = itemIdx;
        break;
      }
    }
    setSortProductInput('');
    if (targetSlotIndex === -1 || targetItemIndex === -1) {
      setSortNotification({type:'error',message:`Barang "${barcode}" tidak diperlukan di keranjang ini atau sudah penuh!`});
      playBuzzer(false);
      speakVoice('Barang tidak cocok atau keranjang sudah penuh');
    } else {
      const target = sortSlots[targetSlotIndex];
      const item = target.order.items[targetItemIndex];
      const counts = {...target.itemsDecomposed, [item.id]: (target.itemsDecomposed[item.id] || 0) + 1};
      const updatedSlots = sortSlots.map((slot, index) => index === targetSlotIndex
        ? {...slot, itemsDecomposed:counts, isComplete:slot.order.items.every(line => (counts[line.id] || 0) >= line.qty)}
        : slot);
      setSortSlots(updatedSlots);
      setSortLastAssignedSlot(target.slotNumber);
      setSortSelectedSlotNumber(target.slotNumber);

      const masterBasket = sortActiveMasterBasket || target.order.basketNumber || sortTaskInput.trim() || 'GB-01';
      saveSortSessionToStorage(masterBasket, sortPackerPrefix, updatedSlots);

      setSortNotification({type:'success',message:updatedSlots.every(slot => slot.isComplete)
        ? `Seluruh ${updatedSlots.length} keranjang lengkap. Silakan klik "Selesaikan sortir".`
        : `Masukkan 1x ${item.skuName} ke Keranjang ${target.basketCode} (Slot #${target.slotNumber} - ${target.order.customerName})`});
      playBuzzer(true);
      speakVoice(`Masukkan ke keranjang ${target.basketCode}`);
    }
    sortProductRef.current?.focus();
  };

  const handleSortScanProduct = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (sortSaveBusy.current) return;
    const barcode = sortProductInput.trim();
    const selectedSlot = sortSlots.find(s => s.slotNumber === sortSelectedSlotNumber);
    if (!SERVER_SCAN_ENABLED || !sortSlots.length || (!resolveSortingTarget && !selectedSlot) || !allBasketsBound || !barcode) {
      setSortNotification({type:'error',message:SERVER_SCAN_ENABLED ? 'Pilih basket dan masukkan barcode.' : scanServerUnavailable});
      return;
    }
    sortSaveBusy.current = true; setSavingSort(true); setSortStarted(true);
    try {
      if (resolveSortingTarget && Array.from(sortControllers.current.values()).some(controller => controller.hasPending())) {
        throw new Error('Ada request belum terkonfirmasi. Pulihkan sesi terlebih dahulu.');
      }
      const target = resolveSortingTarget
        ? await resolveSortingTarget(barcode, sortSlots.map(slot => ({reference:slot.order.referenceNumber, basket:slot.basketCode})))
        : undefined;
      const slot = resolveSortingTarget
        ? sortSlots.find(s => s.order.referenceNumber === target)
        : selectedSlot;
      if (!slot) throw new Error('Basket tujuan tidak ditemukan. Periksa tugas sortir.');
      await persistSortingTask();
      const controller = await sortingController(slot.order.referenceNumber);
      const progress = await controller.scan(slot.basketCode, barcode);
      applySortingProgress(slot, progress);
      if (resolveSortingTarget) setSortSelectedSlotNumber(slot.slotNumber);
      setSortProductInput(''); setSortLastAssignedSlot(slot.slotNumber);
      setSortServerReady(true);
      setSortNotification({type:'success',message:`Scan dikonfirmasi server untuk keranjang ${progress.basket}.`});
      playBuzzer(true); speakVoice(`Masukkan ke keranjang ${progress.basket}`);
    } catch (error) {
      setSortProductInput('');
      setSortLastAssignedSlot(null);
      setSortServerReady(false);
      setSortNotification({type:'error',message:error instanceof Error ? error.message : 'Scan belum terkonfirmasi.'});
      playBuzzer(false);
    } finally { sortSaveBusy.current = false; setSavingSort(false); }
  };

  const handleRecoverSorting = async () => {
    if (sortSaveBusy.current || !SERVER_SCAN_ENABLED) return;
    sortSaveBusy.current = true; setSavingSort(true); setSortStarted(true);
    try {
      await persistSortingTask();
      for (const slot of sortSlots) {
        const controller = await sortingController(slot.order.referenceNumber);
        const progress = await controller.open(slot.basketCode);
        applySortingProgress(slot, controller.hasPending() ? await controller.retry() : progress);
      }
      setSortServerReady(true);
      setSortNotification({type:'success',message:'Progres sortir telah dipulihkan dari server.'});
    } catch (error) {
      setSortServerReady(false);
      setSortNotification({type:'error',message:error instanceof Error ? error.message : 'Pemulihan sortir gagal.'});
    } finally { sortSaveBusy.current = false; setSavingSort(false); }
  };

  const handleBaselineEndSorting = async () => {
    if (sortSaveBusy.current || !sortSlots.length) return;
    if (!allBasketsBound || sortSlots.some(slot => !slot.isComplete)) {
      setSortNotification({type:'error',message:'Lengkapi semua keranjang dan scan barang sebelum menyelesaikan sortir.'});
      return;
    }
    if (!onCompleteSorting) {
      setSortNotification({type:'error',message:'Penyimpanan sortir belum tersedia. Muat ulang WMS.'});
      return;
    }
    sortSaveBusy.current = true;
    setSavingSort(true);
    try {
      const tasks = sortSlots.map(slot => ({referenceNumber:slot.order.referenceNumber,masterBasket:slot.order.basketNumber || sortActiveMasterBasket || '',basketCode:slot.basketCode,items:slot.order.items,counts:slot.itemsDecomposed}));
      if (!await onCompleteSorting(tasks)) {
        setSortNotification({type:'error',message:'Sortir belum tersimpan. Hasil scan tetap tersedia; periksa pesan kesalahan sebelum mengulang.'});
        return;
      }
      setSortNotification({type:'success',message:`Sortir ${sortSlots.length} keranjang berhasil disimpan. Lanjut ke pengemasan.`});
      playBuzzer(true);
      speakVoice('Sortir selesai. Lanjut ke pengemasan.');
      clearSortSessionFromStorage(sortActiveMasterBasket);
      switchScreen('delivery');
      setSortSlots([]);
      setSortLastAssignedSlot(null);
    } catch (error) {
      setSortNotification({type:'error',message:error instanceof Error ? error.message : 'Sortir belum tersimpan.'});
    } finally {
      sortSaveBusy.current = false;
      setSavingSort(false);
    }
  };

  const handleEndSorting = async () => {
    if (sortSaveBusy.current || !SERVER_SCAN_ENABLED || !sortServerReady || !sortSlots.length || !allBasketsBound) return;
    sortSaveBusy.current = true; setSavingSort(true); setSortStarted(true);
    try {
      for (const slot of sortSlots) {
        const controller = await sortingController(slot.order.referenceNumber);
        let progress = await controller.open(slot.basketCode);
        if (controller.hasPending()) throw new Error('Ada request belum terkonfirmasi. Pulihkan sesi terlebih dahulu.');
        applySortingProgress(slot, progress);
        if (progress.state === 'open') progress = await controller.finish(slot.basketCode);
        if (progress.state !== 'finished' || !progress.current) throw new Error('Sortir belum dikonfirmasi server atau order telah berubah.');
        applySortingProgress(slot, progress);
      }
      setSortNotification({type:'success',message:'Seluruh sortir dikonfirmasi server.'});
      const {branch, actor} = await sortingIdentity();
      const key = sortingTaskKey(branch, actor);
      await sortingLock(key, async () => {
        const expected = JSON.stringify(sortSlots.map(slot => ({ reference: slot.order.referenceNumber, basket: slot.basketCode })));
        if (localStorage.getItem(key) !== expected) throw new Error('Tugas sortir tersimpan berubah; periksa sebelum menghapus penanda.');
        localStorage.removeItem(key);
      });
      setSortStarted(false); setSortSlots([]);
      clearSortSessionFromStorage(sortActiveMasterBasket);
      setSortServerReady(false);
      onSortingSessionReleased?.();
    } catch (error) {
      setSortServerReady(false);
      setSortNotification({type:'error',message:error instanceof Error ? error.message : 'Sortir belum dikonfirmasi.'});
    } finally { sortSaveBusy.current = false; setSavingSort(false); }
  };

  // =========================================================================
  // SCREEN 3: M DELIVERY (PACKING STATION, WEIGHING & AUTO-PRINT)
  // =========================================================================
  const [deliveryBasketInput, setDeliveryBasketInput] = useState<string>('');
  const deliveryBasketInputRef = useRef<HTMLInputElement>(null);
  const [deliveryActiveRef, setDeliveryActiveRef] = useState<string | null>(null);
  const [deliveryWeight, setDeliveryWeight] = useState<string>('');
  const deliveryWeightInputRef = useRef<HTMLInputElement>(null);
  const lastWeightFocusTimeRef = useRef<number>(0);
  const [deliveryProductInput, setDeliveryProductInput] = useState<string>('');
  const deliveryProductRef = useRef<HTMLInputElement>(null);
  const [receiptOrder, setReceiptOrder] = useState<ShippingOrderData | null>(null);
  const lastReceiptStorageKey = `wms_last_packed_receipt_${getActiveBranch()}_${(currentUser?.username || 'default').toLowerCase()}`;
  const [lastPackedReceipt, setLastPackedReceipt] = useState<ShippingOrderData | null>(() => {
    try {
      const saved = localStorage.getItem(lastReceiptStorageKey);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      const saved = localStorage.getItem(lastReceiptStorageKey);
      setLastPackedReceipt(saved ? JSON.parse(saved) : null);
    } catch {
      setLastPackedReceipt(null);
    }
  }, [lastReceiptStorageKey]);

  const handlePrintAgain = () => {
    if (!lastPackedReceipt) {
      setDeliveryNotification({ type: 'info', message: 'Belum ada order yang diselesaikan untuk dicetak ulang.' });
      playBuzzer(false);
      return;
    }
    setReceiptOrder(lastPackedReceipt);
    playBuzzer(true);
    speakVoice('Mencetak ulang resi terakhir.');
  };
  const [autoPrintReceipt, setAutoPrintReceipt] = useState<boolean>(true);
  const [deliveryScannedCounts, setDeliveryScannedCounts] = useState<{ [itemId: string]: number }>({});
  const [deliveryNotification, setDeliveryNotification] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [deliveryTask, setDeliveryTask] = useState<{branch:string; actor:string; reference:string; basket:string} | null>(null);
  const [deliveryReady, setDeliveryReady] = useState(false);
  const [deliveryFinished, setDeliveryFinished] = useState(false);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const deliveryBusyRef = useRef(false);
  const deliveryControllers = useRef(new Map<string, ReturnType<typeof createScanServerSession>>());

  const deliveryActiveOrder = useMemo(() => {
    if (!deliveryActiveRef) return null;
    return pendingOrders.find(ord => ord.referenceNumber === deliveryActiveRef) || null;
  }, [pendingOrders, deliveryActiveRef]);

  const deliveryTaskKey = (branch: string, actor: string) => `wms-packing-task-v1:${JSON.stringify([branch, actor])}`;
  const deliveryController = async (task: NonNullable<typeof deliveryTask>) => {
    const identity = await sortingIdentity();
    if (identity.branch !== task.branch || identity.actor !== task.actor) throw new Error('Operator atau cabang berubah; buka ulang sesi.');
    const key = JSON.stringify([task.branch, task.actor, task.reference]);
    let controller = deliveryControllers.current.get(key);
    if (!controller) {
      controller = createScanServerSession(serverScanRpc, localStorage, () => crypto.randomUUID(),
        task.branch, task.actor, task.reference, 'packing', sortingLock);
      deliveryControllers.current.set(key, controller);
    }
    return controller;
  };
  const applyDeliveryProgress = (task: NonNullable<typeof deliveryTask>, progress: ScanProgress) => {
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
    setDeliveryScannedCounts(Object.fromEntries(progress.counts.map(line => [line.documentId, line.scanned])));
    setDeliveryFinished(false);
    setDeliveryReady(progress.state === 'open');
  };
  const verifyDeliveryCompletion = async (task: NonNullable<typeof deliveryTask>, progress: ScanProgress) => {
    if (progress.state !== 'finished' || !progress.current || !progress.finishRequest) throw new Error('Penyelesaian packing belum dikonfirmasi server.');
    await deliveryController(task);
    const receipt = await serverScanRpc.receipt(task.branch, task.reference);
    if (receipt.source !== 'packing' || receipt.operationId !== progress.finishRequest) throw new Error('Bukti resi tidak cocok dengan penyelesaian packing.');
    setDeliveryReady(false);
    setDeliveryFinished(true);
    const finishedOrder = pendingOrders.find(candidate => candidate.referenceNumber === task.reference) || deliveryActiveOrder;
    if (finishedOrder) {
      const orderToPrint: ShippingOrderData = {
        referenceNumber: finishedOrder.referenceNumber,
        orderNumber: finishedOrder.orderNumber,
        orderId: finishedOrder.orderId || getStoredOrderId(finishedOrder.items[0]) || finishedOrder.referenceNumber,
        noPo: finishedOrder.noPo,
        customerName: finishedOrder.customerName,
        customerPhone: finishedOrder.customerPhone,
        customerAddress: finishedOrder.customerAddress,
        courier: (finishedOrder.items[0] as any)?.courier || (finishedOrder as any)?.courier || 'J&T Express',
        trackingNumber: (finishedOrder.items[0] as any)?.trackingNumber || (finishedOrder as any)?.trackingNumber,
        timestamp: finishedOrder.timestamp,
        branchId: getActiveBranch(),
        weight: deliveryWeight ? `${deliveryWeight} g` : undefined,
        items: finishedOrder.items.map(it => ({
          id: it.id,
          skuId: it.skuId,
          skuName: it.skuName || it.skuId,
          location: it.location,
          expiredDate: it.expiredDate,
          qty: it.qty
        })),
        totalQty: finishedOrder.totalQty,
        packerName: currentUser?.fullName || 'Packer Staff',
        pickerName: finishedOrder.pickingBy || finishedOrder.pickedBy || 'Picker Staff'
      };
      setLastPackedReceipt(orderToPrint);
      try {
        localStorage.setItem(lastReceiptStorageKey, JSON.stringify(orderToPrint));
      } catch {
        // ignore
      }
      if (autoPrintReceipt) {
        setReceiptOrder(orderToPrint);
      }
    }
    setDeliveryNotification({
      type: 'success',
      message: `Packing ${task.reference} dikonfirmasi server.${autoPrintReceipt ? ' Mencetak resi pengiriman...' : ''}`
    });
  };
  const recoverDeliveryTask = async (task: NonNullable<typeof deliveryTask>) => {
    const controller = await deliveryController(task);
    let progress = await controller.open(task.basket);
    if (controller.hasPending()) progress = await controller.retry();
    applyDeliveryProgress(task, progress);
    if (progress.state === 'finished') await verifyDeliveryCompletion(task, progress);
    else if (progress.state !== 'open') throw new Error('Sesi packing tidak aktif.');
    else setDeliveryNotification({type:'info',message:'Progres packing dipulihkan dari server.'});
  };
  useEffect(() => {
    if (!SERVER_SCAN_ENABLED || !currentUser) return;
    let active = true;
    let acquired = false;
    (async () => {
      try {
        const {branch, actor} = await sortingIdentity();
        const raw = localStorage.getItem(deliveryTaskKey(branch, actor));
        if (!raw || !active) return;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Data pemulihan packing tidak valid.');
        const entry = value as Record<string, unknown>;
        if (typeof entry.reference !== 'string' || !entry.reference || typeof entry.basket !== 'string' || !entry.basket) {
          throw new Error('Data pemulihan packing tidak valid.');
        }
        const task = {branch, actor, reference:entry.reference, basket:entry.basket};
        if (!active || deliveryBusyRef.current) return;
        acquired = true; deliveryBusyRef.current = true; setDeliveryBusy(true);
        setDeliveryTask(task); setDeliveryActiveRef(task.reference);
        await recoverDeliveryTask(task);
      } catch (error) {
        if (active) { setDeliveryReady(false); setDeliveryNotification({type:'error',message:error instanceof Error ? error.message : 'Pemulihan packing gagal.'}); }
      } finally {
        if (acquired) deliveryBusyRef.current = false;
        if (active && acquired) setDeliveryBusy(false);
      }
    })();
    return () => { active = false; };
  }, [currentUser?.username]);

  const handleCancelDelivery = () => {
    setDeliveryActiveRef(null);
    setDeliveryReady(false);
    setDeliveryScannedCounts({});
    setDeliveryWeight('');
    setDeliveryNotification({ type: 'info', message: 'Sesi keranjang pengemasan telah dikosongkan. Silakan pindai keranjang sortir yang baru.' });
    setDeliveryBasketInput('');
    if (SERVER_SCAN_ENABLED && deliveryTask) {
      sortingIdentity().then(({ branch, actor }) => {
        const key = deliveryTaskKey(branch, actor);
        localStorage.removeItem(key);
      }).catch(() => {});
      setDeliveryTask(null);
    }
    setTimeout(() => {
      deliveryBasketInputRef.current?.focus();
    }, 100);
  };

  const handleLoadDeliveryBasket = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (deliveryBusyRef.current) return;
    const query = deliveryBasketInput.trim().toUpperCase();
    if (!query) return;

    // 1. CEK KERANJANG INDUK YANG SEDANG AKTIF DI SESI PICKING ATAU SORTIR LOKAL
    const activeSortMaster = (sortActiveMasterBasket || '').trim().toUpperCase();
    const activePickMaster = (distBoundBasket || '').trim().toUpperCase();
    if ((activeSortMaster && query === activeSortMaster) || (activePickMaster && query === activePickMaster)) {
      setDeliveryNotification({
        type: 'error',
        message: `❌ DITOLAK: "${query}" adalah KERANJANG INDUK yang diikat oleh Picker. Keranjang induk tidak boleh dimuat di pengemasan (Packing). Silakan lakukan sortir di Meja Sortir (Tahap 2) terlebih dahulu!`
      });
      playBuzzer(false);
      speakVoice(`Keranjang induk ${query} tidak boleh dimuat di pengemasan.`);
      setDeliveryBasketInput('');
      return;
    }

    // 2. CEK APAKAH QUERY ADALAH KERANJANG INDUK BATCH DENGAN LEBIH DARI 1 PESANAN PENDING
    const ordersWithThisBasket = pendingOrders.filter(ord => (ord.basketNumber || '').trim().toUpperCase() === query);
    if (ordersWithThisBasket.length > 1) {
      const pickerName = ordersWithThisBasket.find(o => o.pickingBy || o.pickedBy)?.pickingBy ||
                         ordersWithThisBasket.find(o => o.pickingBy || o.pickedBy)?.pickedBy || 'Picker';
      setDeliveryNotification({
        type: 'error',
        message: `❌ DITOLAK: Keranjang "${query}" adalah KERANJANG INDUK yang diikat oleh Picker (${pickerName}) untuk ${ordersWithThisBasket.length} pesanan. Keranjang induk tidak boleh dimuat di pengemasan. Silakan bawa ke Meja Sortir (Tahap 2) terlebih dahulu!`
      });
      playBuzzer(false);
      speakVoice(`Keranjang induk ${query} berisi ${ordersWithThisBasket.length} pesanan. Bawa ke meja sortir terlebih dahulu.`);
      setDeliveryBasketInput('');
      return;
    }

    // 3. CARI ORDER YANG COCOK
    let matchedOrder = ordersWithThisBasket[0];
    if (!matchedOrder) {
      matchedOrder = pendingOrders.find(ord => 
        ord.referenceNumber.toUpperCase() === query ||
        ord.orderId?.toUpperCase() === query ||
        (ord.orderNumber && ord.orderNumber.toUpperCase() === query)
      );
    }

    if (!matchedOrder) {
      const blockedMatch = (orderHistory || []).find(it => 
        it.status === 'Pending' && 
        (requireExplicitOnlineType ? resolveOrderType(it) !== 'ONLINE' : resolveOrderType(it) === 'B2B') &&
        (it.referenceNumber?.toUpperCase() === query || 
         it.orderNumber?.toUpperCase() === query || 
         it.noPo?.toUpperCase() === query ||
         it.basketNumber?.toUpperCase() === query)
      );
      if (blockedMatch) {
        const blockedType = resolveOrderType(blockedMatch);
        setDeliveryNotification({
          type: 'error',
          message:
            blockedType === 'B2B'
              ? `Order "${blockedMatch.orderNumber || blockedMatch.referenceNumber}" bertipe B2B. Silakan proses di menu Outbound B2B!`
              : `Order "${blockedMatch.orderNumber || blockedMatch.referenceNumber}" berstatus UNASSIGNED. Klasifikasikan sebagai ONLINE terlebih dahulu sebelum memproses!`
        });
        playBuzzer(false);
        speakVoice(blockedType === 'B2B' ? 'Order B2B. Buka menu Outbound B2B.' : 'Order belum diklasifikasikan.');
        return;
      }
      setDeliveryNotification({ type: 'error', message: `Order atau keranjang "${query}" tidak ditemukan di antrean pending.` });
      playBuzzer(false);
      return;
    }

    // 4. CEK APAKAH ORDER SUDAH SELESAI DIPICK
    if (!matchedOrder.isPicked) {
      const boundBasket = (matchedOrder.masterBasketNumber || matchedOrder.basketNumber || '').trim();
      const basketInfo = boundBasket ? ` (Keranjang Induk: ${boundBasket})` : '';
      setDeliveryNotification({
        type: 'error',
        message: `❌ PESANAN BELUM SELESAI DIPICK: Order "${matchedOrder.referenceNumber}"${basketInfo} belum selesai diambil oleh Picker.`
      });
      playBuzzer(false);
      speakVoice(`Order belum selesai dipick.`);
      setDeliveryBasketInput('');
      return;
    }

    // 5. CEK APAKAH ORDER BELUM DISORTIR (MASIH MENGGUNAKAN KERANJANG INDUK PICKER)
    const isOrderSorted = Boolean(
      matchedOrder.isSorted &&
      matchedOrder.items.length > 0 &&
      matchedOrder.items.every(it => Boolean(it.sortedAt?.trim()) && Boolean(it.sortedBy?.trim()))
    );

    if (!isOrderSorted) {
      const pickerName = matchedOrder.pickingBy || matchedOrder.pickedBy || 'Picker';
      const basketLabel = matchedOrder.basketNumber ? `Keranjang "${matchedOrder.basketNumber}"` : 'Pesanan ini';
      setDeliveryNotification({
        type: 'error',
        message: `❌ DITOLAK: ${basketLabel} adalah Keranjang Induk yang diikat oleh Picker (${pickerName}). Pesanan (${matchedOrder.referenceNumber}) belum disortir ke keranjang pesanan (A1, A2, dst.). Silakan selesaikan proses sortir di Meja Sortir (Tahap 2) terlebih dahulu!`
      });
      playBuzzer(false);
      speakVoice(`Keranjang ${matchedOrder.basketNumber || query} belum disortir. Bawa ke meja sortir terlebih dahulu.`);
      setDeliveryBasketInput('');
      return;
    }

    if (!SERVER_SCAN_ENABLED) {
      setDeliveryActiveRef(matchedOrder.referenceNumber);
      const initCounts: { [itemId: string]: number } = {};
      matchedOrder.items.forEach(it => { initCounts[it.id] = 0; });
      setDeliveryScannedCounts(initCounts);
      setDeliveryReady(true);
      setDeliveryFinished(false);
      setDeliveryWeight('');
      setDeliveryBasketInput('');
      setDeliveryNotification({ type: 'success', message: `✓ Keranjang "${matchedOrder.basketNumber || query}" (Order ${matchedOrder.referenceNumber}) siap dipack. Silakan scan SKU.` });
      playBuzzer(true);
      speakVoice(`Keranjang ${matchedOrder.basketNumber || query} siap dipacking.`);
      setTimeout(() => {
        deliveryProductRef.current?.focus();
      }, 100);
      return;
    }

    if (deliveryTask && !deliveryFinished) { setDeliveryNotification({type:'error',message:'Pulihkan atau selesaikan sesi packing sebelumnya.'}); return; }
    if (!matchedOrder.basketNumber?.trim()) {
      setDeliveryNotification({type:'error',message:'Order pending atau keranjang sortir tidak ditemukan.'}); return;
    }
    deliveryBusyRef.current = true; setDeliveryBusy(true); setDeliveryReady(false);
    try {
      const {branch, actor} = await sortingIdentity();
      const task = {branch, actor, reference:matchedOrder.referenceNumber, basket:matchedOrder.basketNumber.trim()};
      const key = deliveryTaskKey(branch, actor);
      await sortingLock(key, async () => {
        const existing = localStorage.getItem(key);
        const previous = deliveryTask && JSON.stringify({reference:deliveryTask.reference,basket:deliveryTask.basket});
        if (existing && !(deliveryFinished && existing === previous)) throw new Error('Sesi packing tersimpan belum dipulihkan.');
        localStorage.setItem(key, JSON.stringify({reference:task.reference,basket:task.basket}));
      });
      setDeliveryTask(task); setDeliveryActiveRef(task.reference); setDeliveryFinished(false);
      await recoverDeliveryTask(task);
      setDeliveryBasketInput('');
      setTimeout(() => {
        deliveryProductRef.current?.focus();
      }, 100);
    } catch (error) {
      setDeliveryReady(false); setDeliveryNotification({type:'error',message:error instanceof Error ? error.message : 'Sesi packing gagal.'});
    } finally { deliveryBusyRef.current = false; setDeliveryBusy(false); }
  };

  const executeCompleteDelivery = async (
    targetOrder: NonNullable<typeof deliveryActiveOrder>,
    countsToVerify: { [itemId: string]: number }
  ) => {
    if (deliveryBusyRef.current) return;
    deliveryBusyRef.current = true;
    setDeliveryBusy(true);
    try {
      const updatedItems = targetOrder.items.map(it => ({
        ...it,
        status: 'Completed' as const,
        scanned: true,
        packedBy: currentUser?.fullName || 'Packer Staff',
        packedAt: new Date().toISOString()
      }));

      const finishedRef = targetOrder.referenceNumber;
      const orderToPrint: ShippingOrderData = {
        referenceNumber: targetOrder.referenceNumber,
        orderNumber: targetOrder.orderNumber,
        orderId: targetOrder.orderId || getStoredOrderId(targetOrder.items[0]) || targetOrder.referenceNumber,
        noPo: targetOrder.noPo,
        customerName: targetOrder.customerName,
        customerPhone: targetOrder.customerPhone,
        customerAddress: targetOrder.customerAddress,
        courier: (targetOrder.items[0] as any)?.courier || (targetOrder as any)?.courier || 'J&T Express',
        trackingNumber: (targetOrder.items[0] as any)?.trackingNumber || (targetOrder as any)?.trackingNumber,
        timestamp: targetOrder.timestamp,
        branchId: getActiveBranch(),
        weight: deliveryWeight ? `${deliveryWeight} g` : undefined,
        items: targetOrder.items.map(it => ({
          id: it.id,
          skuId: it.skuId,
          skuName: it.skuName || it.skuId,
          location: it.location,
          expiredDate: it.expiredDate,
          qty: it.qty
        })),
        totalQty: targetOrder.totalQty,
        packerName: currentUser?.fullName || 'Packer Staff',
        pickerName: targetOrder.pickingBy || targetOrder.pickedBy || 'Picker Staff'
      };

      let success = false;
      if (onEditMultipleOrdersBatch) {
        success = await onEditMultipleOrdersBatch([{ refNum: targetOrder.referenceNumber, updatedItems, isPicking: false }]);
      } else if (onEditOrderHistoryBatch) {
        success = await onEditOrderHistoryBatch(targetOrder.referenceNumber, updatedItems, false);
      }

      if (success) {
        setLastPackedReceipt(orderToPrint);
        try {
          localStorage.setItem(lastReceiptStorageKey, JSON.stringify(orderToPrint));
        } catch {
          // ignore
        }
        setDeliveryNotification({ 
          type: 'success', 
          message: `✓ Packing selesai! Order ${finishedRef} status Selesai.${autoPrintReceipt ? ' Mencetak resi pengiriman...' : ''}` 
        });
        playBuzzer(true);
        speakVoice('Packing selesai.');
        setDeliveryActiveRef(null);
        setDeliveryScannedCounts({});
        setDeliveryReady(false);
        setDeliveryFinished(true);

        if (autoPrintReceipt) {
          setReceiptOrder(orderToPrint);
        } else {
          setDeliveryWeight('');
          setTimeout(() => {
            deliveryBasketInputRef.current?.focus();
          }, 100);
        }
      }
    } catch (err: any) {
      setDeliveryNotification({ type: 'error', message: `Gagal menyelesaikan packing: ${err.message || err}` });
    } finally {
      deliveryBusyRef.current = false;
      setDeliveryBusy(false);
    }
  };

  // Otomatis pindah fokus ke kolom berat paket saat seluruh barang 100% lengkap
  useEffect(() => {
    if (
      currentScreen === 'delivery' &&
      deliveryReady &&
      deliveryActiveOrder &&
      !deliveryBusyRef.current &&
      !deliveryFinished &&
      deliveryActiveOrder.items.length > 0 &&
      deliveryActiveOrder.items.every(it => (deliveryScannedCounts[it.id] || 0) >= it.qty)
    ) {
      const timer = setTimeout(() => {
        lastWeightFocusTimeRef.current = Date.now();
        deliveryWeightInputRef.current?.focus();
        deliveryWeightInputRef.current?.select();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [currentScreen, deliveryReady, deliveryActiveOrder, deliveryScannedCounts, deliveryFinished]);

  const handleDeliveryScanProduct = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (deliveryBusyRef.current) return;
    const barcode = deliveryProductInput.trim();
    if (!barcode) return;

    if (!SERVER_SCAN_ENABLED) {
      if (!deliveryActiveOrder || !deliveryReady) {
        setDeliveryNotification({ type: 'error', message: 'Muat nomor keranjang terlebih dahulu sebelum scan SKU.' });
        return;
      }
      const cleanBarcode = barcode.trim().toUpperCase();
      const resolvedSku = findSkuId(cleanBarcode) || cleanBarcode;
      const targetItem = deliveryActiveOrder.items.find(it => {
        const itSku = it.skuId.trim().toUpperCase();
        const itBarcode = getBarcodeForSku(it.skuId).trim().toUpperCase();
        const currentCount = deliveryScannedCounts[it.id] || 0;
        return (itSku === resolvedSku || itBarcode === cleanBarcode || itSku === cleanBarcode) && currentCount < it.qty;
      });

      if (!targetItem) {
        setDeliveryNotification({ type: 'error', message: `Barang "${barcode}" tidak diperlukan di order ini atau sudah lengkap!` });
        playBuzzer(false);
        speakVoice('Salah barang atau sudah lengkap');
        return;
      }

      const nextCounts = { ...deliveryScannedCounts, [targetItem.id]: (deliveryScannedCounts[targetItem.id] || 0) + 1 };
      setDeliveryScannedCounts(nextCounts);
      setDeliveryProductInput('');
      playBuzzer(true);
      speakVoice(`Scan ${targetItem.skuId} berhasil`);

      const allPacked = deliveryActiveOrder.items.every(it => (nextCounts[it.id] || 0) >= it.qty);
      if (allPacked) {
        setDeliveryNotification({ 
          type: 'success', 
          message: '✓ Seluruh barang lengkap (100%)! Silakan masukkan berat paket, lalu tekan Enter untuk cetak resi.' 
        });
        speakVoice('Semua barang lengkap. Masukkan berat paket lalu tekan Enter.');
        setTimeout(() => {
          lastWeightFocusTimeRef.current = Date.now();
          deliveryWeightInputRef.current?.focus();
          deliveryWeightInputRef.current?.select();
        }, 150);
        return;
      } else {
        setDeliveryNotification({ type: 'success', message: `✓ Scan ${targetItem.skuId}: ${nextCounts[targetItem.id]}/${targetItem.qty} pcs.` });
      }
      return;
    }

    if (!deliveryTask || !deliveryReady) {
      setDeliveryNotification({type:'error',message:'Pulihkan sesi packing sebelum scan.'}); return;
    }
    deliveryBusyRef.current = true; setDeliveryBusy(true);
    try {
      const controller = await deliveryController(deliveryTask);
      const progress = await controller.scan(deliveryTask.basket, barcode);
      applyDeliveryProgress(deliveryTask, progress);
      setDeliveryProductInput('');
      setDeliveryNotification({type:'success',message:'Scan dikonfirmasi server.'});
      playBuzzer(true);
    } catch (error) {
      setDeliveryReady(false);
      setDeliveryNotification({type:'error',message:error instanceof Error ? error.message : 'Scan belum terkonfirmasi.'});
      playBuzzer(false);
    } finally { deliveryBusyRef.current = false; setDeliveryBusy(false); }
  };

  const handleRecoverDelivery = async () => {
    if (deliveryBusyRef.current || !SERVER_SCAN_ENABLED || !deliveryTask) return;
    deliveryBusyRef.current = true; setDeliveryBusy(true); setDeliveryReady(false);
    try { await recoverDeliveryTask(deliveryTask); }
    catch (error) { setDeliveryNotification({type:'error',message:error instanceof Error ? error.message : 'Pemulihan packing gagal.'}); }
    finally { deliveryBusyRef.current = false; setDeliveryBusy(false); }
  };

  const handleCompleteDelivery = async () => {
    if (deliveryBusyRef.current) return;

    if (!SERVER_SCAN_ENABLED) {
      if (!deliveryActiveOrder) return;
      const isOrderSorted = Boolean(
        deliveryActiveOrder.isSorted &&
        deliveryActiveOrder.items.length > 0 &&
        deliveryActiveOrder.items.every(it => Boolean(it.sortedAt?.trim()) && Boolean(it.sortedBy?.trim()))
      );
      if (!isOrderSorted) {
        setDeliveryNotification({
          type: 'error',
          message: '❌ GAGAL: Pesanan ini belum melalui Meja Sortir (Tahap 2). Keranjang induk tidak boleh diselesaikan di pengemasan!'
        });
        playBuzzer(false);
        speakVoice('Pesanan belum disortir. Tidak dapat menyelesaikan packing.');
        return;
      }
      const isComplete = deliveryActiveOrder.items.every(it => (deliveryScannedCounts[it.id] || 0) >= it.qty);
      if (!isComplete) {
        setDeliveryNotification({
          type: 'error',
          message: '❌ Barang belum discan 100%! Selesaikan scan seluruh barcode SKU terlebih dahulu.'
        });
        playBuzzer(false);
        speakVoice('Barang belum lengkap. Scan semua barang terlebih dahulu.');
        deliveryProductRef.current?.focus();
        return;
      }

      const weightNum = parseFloat(deliveryWeight);
      if (!deliveryWeight || isNaN(weightNum) || weightNum <= 0) {
        setDeliveryNotification({
          type: 'error',
          message: '⚠️ Silakan isi berat paket yang valid (dalam gram, contoh: 250) lalu tekan Enter untuk cetak resi!'
        });
        playBuzzer(false);
        speakVoice('Masukkan berat paket.');
        lastWeightFocusTimeRef.current = Date.now();
        deliveryWeightInputRef.current?.focus();
        deliveryWeightInputRef.current?.select();
        return;
      }

      return executeCompleteDelivery(deliveryActiveOrder, deliveryScannedCounts);
    }

    if (!deliveryTask || !deliveryReady) return;
    deliveryBusyRef.current = true; setDeliveryBusy(true); setDeliveryReady(false);
    try {
      const controller = await deliveryController(deliveryTask);
      const progress = await controller.finish(deliveryTask.basket);
      applyDeliveryProgress(deliveryTask, progress);
      await verifyDeliveryCompletion(deliveryTask, progress);
    } catch (error) {
      setDeliveryNotification({type:'error',message:error instanceof Error ? error.message : 'Penyelesaian belum dikonfirmasi.'});
    } finally { deliveryBusyRef.current = false; setDeliveryBusy(false); }
  };

  const handleWeightSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    await handleCompleteDelivery();
  };

  // Helper counts for header
  const distTotalNeedPick = useMemo(() => {
    return unpickedOrders.reduce((acc, ord) => acc + ord.totalQty, 0);
  }, [unpickedOrders]);

  const distTotalSkus = useMemo(() => {
    const set = new Set<string>();
    unpickedOrders.forEach(ord => ord.items.forEach(it => set.add(it.skuId)));
    return set.size;
  }, [unpickedOrders]);

  // Otomatis fokus ke kolom input yang tepat saat berpindah menu layar
  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentScreen === 'distribution') {
        distBasketInputRef.current?.focus();
      } else if (currentScreen === 'sorting') {
        if (!sortSlots.length) {
          sortTaskInputRef.current?.focus();
        } else if (sortSlots.some(s => !s.isBasketBound)) {
          sortPackerPrefixRef.current?.focus();
          sortPackerPrefixRef.current?.select();
        } else {
          sortProductRef.current?.focus();
        }
      } else if (currentScreen === 'delivery') {
        if (!deliveryReady && !deliveryActiveRef) {
          deliveryBasketInputRef.current?.focus();
        } else {
          deliveryProductRef.current?.focus();
        }
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [currentScreen]);

  const activeIssueStage: 'Picking' | 'Sortir' | 'Packing' =
    currentScreen === 'distribution' ? 'Picking' : currentScreen === 'sorting' ? 'Sortir' : 'Packing';

  const activeIssueReferences: string[] = useMemo(() => {
    if (currentScreen === 'distribution') {
      return distActiveBatchOrders.map(o => o.referenceNumber);
    }
    if (currentScreen === 'sorting') {
      return sortSlots.map(s => s.order.referenceNumber);
    }
    return deliveryActiveOrder ? [deliveryActiveOrder.referenceNumber] : [];
  }, [currentScreen, distActiveBatchOrders, sortSlots, deliveryActiveOrder]);

  const handleReportOrderIssue = async (
    reference: string,
    report: Exclude<OrderIssueReportInput, { resolveBy: string }>
  ) => {
    if (!onUpdateOrderSession) {
      throw new Error('Fungsi simpan kendala order belum tersedia.');
    }
    const saved = await onUpdateOrderSession(reference, { issueReport: report });
    if (!saved) {
      throw new Error('Laporan kendala gagal disimpan. Periksa koneksi dan muat ulang order.');
    }
    const noticeMsg = `Kendala order ${reference} (${report.type}) tercatat ke Laporan Exception Supervisor.`;
    if (currentScreen === 'distribution') setDistNotification({ type: 'info', message: noticeMsg });
    else if (currentScreen === 'sorting') setSortNotification({ type: 'info', message: noticeMsg });
    else setDeliveryNotification({ type: 'info', message: noticeMsg });
  };

  return (
    <div
      className={`wms-picking-flow space-y-4 font-sans text-slate-800 bg-[#F4F6F9] ${
        operatorFocusMode
          ? 'fixed inset-0 z-[70] overflow-y-auto p-4 sm:p-6 rounded-none border-0 shadow-none wms-focus-mode'
          : 'p-3 sm:p-5 rounded-2xl border border-slate-300 shadow-xl'
      }`}
    >
      {/* 1. MABANG TOP BREADCRUMB & UTILITY BAR */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
        <div className="wms-stage-breadcrumb flex items-center gap-2 text-sm text-slate-600 font-medium">
          <button 
            onClick={onClose}
            className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-500 hover:text-slate-800 transition-colors"
            title="Tutup & Kembali ke Tampilan Standar"
          >
            <Layers className="w-4 h-4 text-emerald-600" />
          </button>
          <span className="font-semibold text-slate-700">Tahap saat ini:</span>
          <span className="font-bold text-sky-600 cursor-pointer">M</span>
          <span>&gt;</span>
          <span className="font-bold text-slate-900">
            {currentScreen === 'distribution' && 'Pengambilan (Picking)'}
            {currentScreen === 'sorting' && 'Sortir'}
            {currentScreen === 'delivery' && 'Pengemasan (Packing)'}
          </span>
        </div>

        {/* SCREEN BUTTONS BERDASARKAN ROLE:
            - Picker: hanya 1. Pengambilan (Picking)
            - Packer: hanya 2. Sortir & 3. Pengemasan (Packing)
            - Admin/Super Admin: ketiganya */}
        <div className="wms-stage-controls">
        <div className="wms-stage-tabs" role="group" aria-label="Tahap picking dan packing">
          {(!isPackerRole) && (
            <button
              onClick={() => switchScreen('distribution')}
              aria-current={currentScreen === 'distribution' ? 'step' : undefined}
              aria-label="1. Pengambilan (Picking)"
              className={`wms-stage-tab px-3 py-1.5 text-xs font-bold rounded-lg transition-all border flex items-center gap-1.5 cursor-pointer shrink-0 ${
                currentScreen === 'distribution'
                  ? 'bg-sky-600 text-white border-sky-700 shadow-sm'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Package className="w-3.5 h-3.5" />
              <span>1. Picking</span>
              {unpickedOrders.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-amber-400 text-slate-950 rounded-full text-[10px] font-black">
                  {unpickedOrders.length}
                </span>
              )}
            </button>
          )}

          {(!isPickerRole) && (
            <button
              onClick={() => switchScreen('sorting')}
              aria-current={currentScreen === 'sorting' ? 'step' : undefined}
              aria-label="2. Sortir"
              className={`wms-stage-tab px-3 py-1.5 text-xs font-bold rounded-lg transition-all border flex items-center gap-1.5 cursor-pointer shrink-0 ${
                currentScreen === 'sorting'
                  ? 'bg-sky-600 text-white border-sky-700 shadow-sm'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>2. Sortir</span>
              {pendingOrders.filter(o => o.isPicked && !o.isSorted).length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-amber-500 text-white rounded-full text-[10px] font-black" title={`${pendingOrders.filter(o => o.isPicked && !o.isSorted).length} order menunggu disortir`}>
                  {pendingOrders.filter(o => o.isPicked && !o.isSorted).length}
                </span>
              )}
            </button>
          )}

          {(!isPickerRole) && (
            <button
              onClick={() => switchScreen('delivery')}
              aria-current={currentScreen === 'delivery' ? 'step' : undefined}
              aria-label="3. Pengemasan (Packing)"
              className={`wms-stage-tab px-3 py-1.5 text-xs font-bold rounded-lg transition-all border flex items-center gap-1.5 cursor-pointer shrink-0 ${
                currentScreen === 'delivery'
                  ? 'bg-sky-600 text-white border-sky-700 shadow-sm'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Scan className="w-3.5 h-3.5" />
              <span>3. Packing</span>
              {pendingOrders.filter(o => o.isPicked && o.isSorted).length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-emerald-500 text-white rounded-full text-[10px] font-black" title={`${pendingOrders.filter(o => o.isPicked && o.isSorted).length} order selesai disortir, siap dipacking`}>
                  {pendingOrders.filter(o => o.isPicked && o.isSorted).length}
                </span>
              )}
            </button>
          )}

        </div>
        <div className="wms-stage-utilities">
          {/* Voice Broadcast Toggle */}
          <button
            onClick={() => {
              setIsVoiceEnabled(!isVoiceEnabled);
              speakVoice(isVoiceEnabled ? 'Suara dinonaktifkan' : 'Suara diaktifkan');
            }}
            className={`p-1.5 text-xs font-bold rounded-lg transition-all border cursor-pointer shrink-0 ml-1 ${
              isVoiceEnabled
                ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                : 'bg-slate-100 text-slate-400 border-slate-300'
            }`}
            title={isVoiceEnabled ? 'Suara Panduan Aktif' : 'Suara Panduan Nonaktif'}
          >
            {isVoiceEnabled ? <Volume2 className="w-4 h-4 text-emerald-600" /> : <VolumeX className="w-4 h-4 text-slate-400" />}
          </button>

          {/* Admin Monitor & Koreksi Keranjang Induk */}
          {isAdminRole && (
            <button
              type="button"
              onClick={() => setIsMasterBasketMonitorOpen(true)}
              className="px-2.5 py-1.5 text-xs font-bold bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-800 border border-indigo-300 rounded-lg flex items-center gap-1.5 shrink-0 cursor-pointer"
              title="Monitor & Koreksi Keranjang Induk"
            >
              <Layers className="w-3.5 h-3.5 text-indigo-600" />
              <span className="hidden md:inline">Monitor Keranjang</span>
              {activeMasterBasketCount > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-indigo-600 text-white font-bold leading-none">
                  {activeMasterBasketCount}
                </span>
              )}
            </button>
          )}

          {/* Basket Label Generator Shortcut */}
          <button
            onClick={() => setIsBasketLabelModalOpen(true)}
            className="px-2.5 py-1.5 text-xs font-bold bg-amber-500/10 hover:bg-amber-500/20 text-amber-800 border border-amber-300 rounded-lg flex items-center gap-1 shrink-0"
            title="Cetak Label Keranjang 4x6"
          >
            <Printer className="w-3.5 h-3.5 text-amber-600" />
            <span className="hidden md:inline">Cetak Label Basket (4x6)</span>
          </button>

          {/* Lapor Kendala Lapangan (Opsi A - aman tanpa memotong stok paksa) */}
          {onUpdateOrderSession && (
            <button
              type="button"
              disabled={activeIssueReferences.length === 0}
              onClick={() => setIssueModalOpen(true)}
              className="px-2.5 py-1.5 text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 text-rose-800 border border-rose-300 rounded-lg flex items-center gap-1 shrink-0 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
              title="Laporkan kendala stok kurang, barang rusak, atau salah barcode ke Supervisor"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
              <span className="hidden md:inline">Lapor Kendala</span>
            </button>
          )}

          {/* Mode Fokus Operator (Sembunyikan Chrome & Perbesar Input Scan) */}
          <button
            type="button"
            onClick={toggleOperatorFocusMode}
            className={`px-2.5 py-1.5 text-xs font-bold rounded-lg flex items-center gap-1.5 shrink-0 cursor-pointer border transition-colors ${
              operatorFocusMode
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700 shadow-sm'
                : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300 shadow-xs'
            }`}
            title={operatorFocusMode ? 'Keluar Mode Fokus Operator (Esc)' : 'Aktifkan Mode Fokus Operator (Layar Penuh Tanpa Distraksi)'}
          >
            {operatorFocusMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5 text-emerald-600" />}
            <span className="hidden sm:inline">{operatorFocusMode ? 'Keluar Fokus (Esc)' : 'Mode Fokus'}</span>
          </button>

          {/* Toggle Lebarkan Meja (Sembunyikan / Tampilkan Sidebar) */}
          {!operatorFocusMode && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('wms-toggle-sidebar'))}
              className="px-2.5 py-1.5 text-xs font-bold bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded-lg flex items-center gap-1.5 shrink-0 cursor-pointer shadow-xs transition-colors"
              title="Lebarkan Meja Kerja (Sembunyikan / Tampilkan Sidebar Navigasi)"
            >
              <PanelLeftClose className="w-3.5 h-3.5 text-sky-600" />
              <span className="hidden sm:inline">Lebarkan Meja</span>
            </button>
          )}
        </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* SCREEN 1: M DISTRIBUTION UI                                               */}
      {/* ========================================================================= */}
      {currentScreen === 'distribution' && (
        <div className="space-y-3">

          {/* Action & Filter Bar */}
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-slate-700 font-medium cursor-pointer select-none">
              <input
                type="checkbox"
                checked={distPrioritize}
                onChange={e => setDistPrioritize(e.target.checked)}
                className="w-4 h-4 text-sky-600 rounded border-slate-300 focus:ring-sky-500"
              />
              <span>Prioritaskan pengiriman</span>
            </label>

            {/* Courier dropdown */}
            <div className="flex items-center text-xs border border-slate-300 rounded-md overflow-hidden bg-white">
              <span className="px-2.5 py-1.5 bg-slate-100 text-slate-600 border-r border-slate-300">Ekspedisi</span>
              <select
                value={distShipVia}
                onChange={e => setDistShipVia(e.target.value)}
                className="px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white outline-none cursor-pointer"
              >
                <option value="ALL">Semua Ekspedisi ({unpickedOrders.length} item)</option>
                <option value="J&T Express">J&T Express</option>
                <option value="Shopee Xpress">Shopee Xpress</option>
                <option value="SiCepat">SiCepat</option>
                <option value="JNE">JNE</option>
                <option value="Ninja Xpress">Ninja Xpress</option>
              </select>
            </div>

            {/* Get Task Button */}
            <button
              onClick={() => handleGetTask()}
              className="px-4 py-1.5 text-xs font-bold text-white bg-[#1890FF] hover:bg-sky-600 rounded-md flex items-center gap-1.5 shadow-sm transition-all active:scale-95 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Ambil tugas</span>
            </button>

            {/* Scan / Input Kode produk */}
            <form onSubmit={handleDistScanProduct} className="wms-scan-field flex items-center text-xs border border-slate-300 rounded-md overflow-hidden bg-white">
              <span className="px-2.5 py-1.5 bg-slate-100 text-slate-600 border-r border-slate-300">Kode produk</span>
              <input
                type="text"
                placeholder="Pindai barcode produk..."
                value={distProductInput}
                onChange={e => setDistProductInput(e.target.value)}
                className="px-2.5 py-1.5 text-xs outline-none w-40 sm:w-48 text-slate-800"
              />
            </form>

            {/* Bind basket input - Isi manual sesuai kode keranjang fisik masing-masing */}
            <form 
              onSubmit={handleBindBasket} 
              className={`flex items-center text-xs border rounded-md overflow-hidden bg-white transition-all ${
                typedBasketConflict
                  ? 'border-rose-500 ring-2 ring-rose-300 shadow-md'
                  : distActiveBatchOrders.length > 0 && !distBoundBasket 
                  ? 'border-amber-500 ring-2 ring-amber-300 shadow-md animate-pulse' 
                  : 'border-slate-300'
              }`}
            >
              <span className={`px-2.5 py-1.5 font-bold border-r ${
                typedBasketConflict
                  ? 'bg-rose-100 text-rose-900 border-rose-300'
                  : distActiveBatchOrders.length > 0 && !distBoundBasket 
                  ? 'bg-amber-100 text-amber-900 border-amber-300' 
                  : 'bg-slate-100 text-slate-600 border-slate-300'
              }`}>
                Kode Keranjang
              </span>
              <input
                ref={distBasketInputRef}
                type="text"
                placeholder={distActiveBatchOrders.length > 0 && !distBoundBasket ? "Ketik/scan kode keranjang..." : "Kode keranjang..."}
                value={distBasketInput}
                onChange={e => setDistBasketInput(e.target.value)}
                className="px-2.5 py-1.5 text-xs outline-none w-36 sm:w-44 text-slate-900 font-bold font-mono focus:ring-1 focus:ring-amber-500"
              />
              <button
                type="submit"
                disabled={isBindingBasket || Boolean(typedBasketConflict)}
                className={`px-3 py-1.5 font-black border-l cursor-pointer transition-all ${
                  typedBasketConflict
                    ? 'bg-rose-600 text-white border-rose-700 cursor-not-allowed'
                    : distActiveBatchOrders.length > 0 && !distBoundBasket
                    ? 'bg-amber-500 hover:bg-amber-600 text-slate-950 border-amber-400'
                    : 'bg-sky-50 text-sky-700 hover:bg-sky-100 border-slate-300'
                }`}
              >
                {isBindingBasket ? 'Menyimpan…' : typedBasketConflict ? 'Sedang Dipakai' : 'Ikat'}
              </button>
            </form>

            {/* Warning badge jika keranjang yang diketik sedang aktif dipakai */}
            {typedBasketConflict && (
              <div className="wms-inline-danger-banner flex items-center gap-1.5 px-2.5 py-1 bg-rose-50 border border-rose-300 rounded-md text-[11px] font-bold text-rose-700 animate-pulse">
                <span>⚠️ Keranjang "{typedBasketConflict.basket}" sedang aktif dipakai ({typedBasketConflict.count} Order {typedBasketConflict.isPicked ? 'di Sortir/Packing' : 'di Picking'}). Gunakan keranjang lain!</span>
              </div>
            )}

            {/* Notification alert (DIPERBESAR JIKA ERROR KARENA TANPA SPEAKER) */}
            {distNotification && (
              distNotification.type === 'error' ? (
                <div
                  role="alert"
                  className="wms-scan-error-alert w-full bg-rose-600 bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white border-4 border-rose-950 rounded-xl p-3.5 sm:p-4 shadow-2xl animate-bounce flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="wms-scan-error-badge w-10 h-10 rounded-full bg-white text-rose-600 flex items-center justify-center font-black text-xl shrink-0 shadow-lg ring-4 ring-rose-300">
                      ✕
                    </div>
                    <div>
                      <div className="wms-scan-error-title text-[11px] font-black uppercase tracking-wider text-rose-100 flex items-center gap-1.5">
                        <span className="wms-scan-error-dot w-2 h-2 rounded-full bg-white animate-ping"></span>
                        PERINGATAN SALAH SCAN PICKING (CEK VISUAL):
                      </div>
                      <div className="wms-scan-error-message text-sm sm:text-base md:text-lg font-black text-white leading-tight drop-shadow-sm mt-0.5">
                        {distNotification.message}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDistNotification(null)}
                    className="wms-scan-error-close px-3 py-1.5 bg-black/40 hover:bg-black/60 text-white font-bold rounded-lg text-xs cursor-pointer shrink-0 transition-colors border border-white/20"
                    title="Tutup Peringatan"
                  >
                    TUTUP (✕)
                  </button>
                </div>
              ) : (
                <div
                  className={`wms-scan-status-banner w-full text-xs sm:text-sm font-bold px-3.5 py-2.5 rounded-lg flex items-center justify-between shadow-sm ${
                    distNotification.type === 'success'
                      ? 'is-success bg-emerald-500 text-white border-2 border-emerald-600'
                      : 'is-info bg-blue-600 text-white border-2 border-blue-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">{distNotification.type === 'success' ? '✓' : 'ℹ'}</span>
                    <span>{distNotification.message}</span>
                  </div>
                  <button type="button" onClick={() => setDistNotification(null)} className="text-white hover:text-slate-200 cursor-pointer p-1">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )
            )}
          </div>

          {/* Currently Counter & Bound Basket Header */}
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-base sm:text-lg font-black text-slate-800">
                Baris lokasi: <span className="text-sky-600">{distActiveBatchOrders.length > 0 ? (distHideCompleted && distTotalPickedQty < distTotalConsolidatedQty ? distDisplayItems.length : distConsolidatedItems.length) : distTotalSkus}</span> · Belum diambil: <span className="text-sky-600">{distActiveBatchOrders.length > 0 ? (distTotalConsolidatedQty - distTotalPickedQty) : distTotalNeedPick}</span> pcs
              </span>

              {distActiveBatchOrders.length > 0 && (
                <span className="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs font-bold">
                  Batch: {distActiveBatchOrders.length} nomor order
                </span>
              )}

              {/* Toggle Sembunyikan Item Lengkap */}
              {distActiveBatchOrders.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-slate-700 font-bold bg-amber-50 border border-amber-200 px-2 py-1 rounded-md cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={distHideCompleted}
                    onChange={e => setDistHideCompleted(e.target.checked)}
                    className="w-3.5 h-3.5 text-amber-600 rounded border-amber-300"
                  />
                  <span>Hilangkan dari daftar jika sudah lengkap</span>
                </label>
              )}

              <label className="hidden sm:flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={distDisplayImages}
                  onChange={e => setDistDisplayImages(e.target.checked)}
                  className="w-3.5 h-3.5 text-sky-600 rounded border-slate-300"
                />
                <span>Tampilkan gambar produk</span>
              </label>
            </div>

            {/* Master Basket Indicator */}
            <div className={`flex items-center gap-2 border px-3 py-1 rounded-lg transition-all ${
              distBoundBasket 
                ? 'bg-emerald-50 border-emerald-300' 
                : distActiveBatchOrders.length > 0 
                ? 'bg-amber-50 border-amber-300' 
                : 'bg-slate-50 border-slate-200'
            }`}>
              <Box className={`w-5 h-5 ${distBoundBasket ? 'text-emerald-600' : 'text-amber-600'}`} />
              <span className="text-xs font-bold text-slate-700">Keranjang Induk:</span>
              <span className={`text-sm sm:text-base font-black font-mono ${distBoundBasket ? 'text-emerald-700' : 'text-amber-700'}`}>
                {distBoundBasket || (distActiveBatchOrders.length > 0 ? '(Wajib Diikat)' : '--')}
              </span>
            </div>
          </div>

          {/* Table or Empty State */}
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            {distActiveBatchOrders.length === 0 ? (
              <div className="py-16 text-center text-slate-400 space-y-2">
                <div className="w-14 h-14 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                  <Box className="w-8 h-8" />
                </div>
                <p className="text-sm font-bold text-slate-500">Belum ada tugas pengambilan</p>
                <p className="text-xs text-slate-400 font-mono">Ambil tugas untuk memuat maksimal 20 order.</p>
                <button
                  onClick={() => handleGetTask()}
                  className="mt-3 px-4 py-2 text-xs font-bold bg-sky-500 hover:bg-sky-600 text-white rounded-lg shadow-sm"
                >
                  Ambil Tugas Picking Global (Maks 20 Order)
                </button>
              </div>
            ) : (
              <div>
                <div className="p-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-slate-700">
                      Tugas Picking Global: <span className="font-mono text-sky-700">{distActiveBatchOrders.length} Order Digabung</span>
                    </span>
                    <span className="text-xs text-slate-500 font-medium">
                      ({distActiveBatchOrders.map(o => o.referenceNumber).slice(0, 3).join(', ')}{distActiveBatchOrders.length > 3 ? ` +${distActiveBatchOrders.length - 3} lainnya` : ''})
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-emerald-700">
                      Progress: {distTotalPickedQty} / {distTotalConsolidatedQty} pcs
                    </span>

                    {distHideCompleted && distConsolidatedItems.length - distDisplayItems.length > 0 && distTotalPickedQty < distTotalConsolidatedQty && (
                      <span className="px-2 py-0.5 text-[11px] font-bold bg-emerald-100 text-emerald-800 rounded-md border border-emerald-300">
                        ✓ {distConsolidatedItems.length - distDisplayItems.length} SKU selesai (disembunyikan)
                      </span>
                    )}

                    {distTotalPickedQty >= distTotalConsolidatedQty && distTotalConsolidatedQty > 0 ? (
                      <div className="flex items-center gap-2">
                        <span className="px-2.5 py-1 text-xs font-black bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-md flex items-center gap-1.5">
                          <span>✓ Semua {distTotalConsolidatedQty} Pcs Lengkap</span>
                        </span>
                        {isPickerRole ? (
                          <button
                            type="button"
                            onClick={handleStartNextBatch}
                            className="px-4 py-1.5 text-xs font-black bg-emerald-600 hover:bg-emerald-700 text-white rounded-md shadow-md flex items-center gap-1.5 cursor-pointer active:scale-95 transition-all"
                            title="Selesaikan dan ambil 20 order batch berikutnya"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>+ Lanjut Pengambilan Berikutnya</span>
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => switchScreen('sorting')}
                              className="px-3.5 py-1.5 text-xs font-black bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white rounded-md shadow-md flex items-center gap-1.5 cursor-pointer active:scale-95 transition-all"
                              title="Bawa keranjang induk ke meja sortir untuk disortir ke 20 basket"
                            >
                              <span>🚀 Beralih ke Sortir &gt;</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleStartNextBatch}
                              className="px-3 py-1.5 text-xs font-bold bg-slate-800 hover:bg-slate-700 text-white rounded-md shadow-sm cursor-pointer"
                              title="Selesaikan dan ambil 20 order batch berikutnya"
                            >
                              + Ambil Batch Baru
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                        {/* TOMBOL LANGSUNG AMBIL SEMUA (TIDAK PERLU KLIK SATU-SATU) */}
                        <button
                          type="button"
                          onClick={handlePickAllCurrentBatch}
                          className="px-3.5 py-1.5 text-xs font-black rounded-md flex items-center gap-1.5 shadow-sm transition-all cursor-pointer active:scale-95 bg-amber-500 hover:bg-amber-600 text-slate-950 ring-2 ring-amber-300 animate-pulse"
                          title="Ambil seluruh barang batch sekaligus tanpa klik satu-satu"
                        >
                          <span>⚡ LANGSUNG AMBIL SEMUA</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleManualCompletePick}
                          className="px-3 py-1.5 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-md shadow-sm cursor-pointer"
                        >
                          ✔ Selesaikan & Ikat Induk
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Banner Notifikasi Selesai di Atas Tabel */}
                {distTotalPickedQty >= distTotalConsolidatedQty && distTotalConsolidatedQty > 0 && (
                  <div className="mx-3 mt-3 p-3 bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-sky-500/10 border-2 border-emerald-500/40 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-3 text-emerald-900 shadow-sm">
                    <div className="flex items-center gap-2.5">
                      <span className="w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-base shrink-0 shadow-sm">
                        ✓
                      </span>
                      <div>
                        <div className="text-xs font-extrabold text-emerald-950">
                          Batch Selesai! Keranjang Induk <span className="font-mono bg-emerald-200 px-1.5 py-0.5 rounded font-black text-emerald-950">{distBoundBasket || 'GB-01'}</span> Berisi {distTotalConsolidatedQty} Pcs ({distConsolidatedItems.length} baris lokasi).
                        </div>
                        <div className="text-[11px] text-emerald-800">
                          Tabel rute di bawah tetap disimpan untuk pengecekan fisik. Silakan bawa keranjang ke meja sortir atau klik tombol di samping.
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                      {isPickerRole ? (
                        <button
                          type="button"
                          onClick={handleStartNextBatch}
                          className="flex-1 sm:flex-none px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs rounded-lg shadow-md cursor-pointer flex items-center justify-center gap-1.5 transition-all active:scale-95"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>+ Lanjut Pengambilan Berikutnya (Batch Baru)</span>
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => switchScreen('sorting')}
                            className="flex-1 sm:flex-none px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs rounded-lg shadow-md cursor-pointer flex items-center justify-center gap-1.5 transition-all active:scale-95"
                          >
                            <span>Lanjut ke 2. Sortir</span>
                            <ArrowRight className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={handleStartNextBatch}
                            className="flex-1 sm:flex-none px-3.5 py-2 bg-white hover:bg-slate-50 text-slate-800 border border-slate-300 font-bold text-xs rounded-lg shadow-xs cursor-pointer flex items-center justify-center gap-1"
                          >
                            <RefreshCw className="w-3.5 h-3.5 text-sky-600" />
                            <span>Batch Baru</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* TAMPILAN KHUSUS MOBILE: KARTU ERGONOMIS UNTUK PICKER DI LORONG GUDANG (md:hidden) */}
                <div className="block md:hidden p-3 space-y-3 bg-slate-100">
                  {/* Tombol Ambil Semua Mengambang / Cepat di Mobile */}
                  {distTotalPickedQty < distTotalConsolidatedQty && (
                    <button
                      type="button"
                      onClick={handlePickAllCurrentBatch}
                      className="w-full py-3 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-slate-950 font-black text-sm rounded-xl shadow-lg flex items-center justify-center gap-2 ring-2 ring-amber-300 active:scale-98 cursor-pointer"
                    >
                      <span>⚡ LANGSUNG AMBIL SEMUA ({distTotalConsolidatedQty - distTotalPickedQty} pcs lagi)</span>
                    </button>
                  )}

                  {distDisplayItems.map((grp, idx) => {
                    const key = pickingLotKey(grp);
                    const picked = distPickedCounts[key] || 0;
                    const isDone = picked >= grp.totalQty;
                    const barcode = getBarcodeForSku(grp.skuId);

                    return (
                      <div
                        key={`mob-${grp.skuId}`}
                        className={`rounded-xl border p-3.5 shadow-sm transition-all ${
                          isDone 
                            ? 'bg-emerald-50/80 border-emerald-300 ring-2 ring-emerald-200' 
                            : 'bg-white border-slate-300 active:scale-99'
                        }`}
                      >
                        {/* Header Kartu: Urutan Rute & Lokasi Rak Besar */}
                        <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-slate-200">
                          <div className="flex items-center gap-1.5">
                            <span className="px-2.5 py-1 bg-sky-600 text-white font-black text-xs rounded-lg font-mono shadow-xs">
                              Rute #{idx + 1}
                            </span>
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                              isDone ? 'bg-emerald-200 text-emerald-900' : 'bg-amber-100 text-amber-900'
                            }`}>
                              {isDone ? '✓ SELESAI' : 'MENUNGGU PICK'}
                            </span>
                          </div>

                          {/* Lokasi Rak Besar & Jelas untuk Picker */}
                          <div className="px-3 py-1 bg-amber-300 border-2 border-amber-500 text-slate-950 font-black font-mono text-sm rounded-lg shadow-sm">
                            📍 {(grp.warehouseId || 'WH-CENTRAL')+' · '+grp.location}
                          </div>
                        </div>

                        {/* Info Produk */}
                        <div className="flex gap-3 mb-3">
                          <div className="w-14 h-14 shrink-0 rounded-lg bg-slate-100 border border-slate-200 flex flex-col items-center justify-center text-slate-500 font-mono text-[10px] uppercase font-bold">
                            <span className="text-[9px] text-sky-600 font-extrabold">#{idx + 1}</span>
                            <span>{grp.skuId.slice(0, 3)}</span>
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="font-bold text-slate-900 text-sm leading-tight line-clamp-2">
                              {grp.skuName}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1 font-mono text-xs">
                              <span className="inline-flex items-center gap-1 font-black text-slate-700">
                                <span>{grp.skuId}</span>
                                <button
                                  type="button"
                                  onClick={(e) => handleCopyText(grp.skuId, `pick-mob-${grp.skuId}`, e)}
                                  title="Salin SKU ID"
                                  aria-label={`Salin SKU ${grp.skuId}`}
                                  className="p-0.5 hover:bg-slate-200 text-slate-400 hover:text-slate-700 rounded transition-colors cursor-pointer inline-flex items-center justify-center"
                                >
                                  {copiedKey === `pick-mob-${grp.skuId}` ? (
                                    <Check className="w-3 h-3 text-emerald-600" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </span>
                              {barcode && (
                                <span className="text-slate-500 text-[11px] bg-slate-100 px-1.5 py-0.5 rounded">
                                  {barcode}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              Tersedia di rak: <span className="font-bold text-slate-700">{stock.filter(item => pickingLotKey(item) === key && isStockPickable(item)).reduce((total, item) => total + Number(item.qty || 0), 0)} pcs</span>
                              {grp.expiredDate && ` • Exp: ${grp.expiredDate}`}
                            </div>
                          </div>
                        </div>

                        {/* Baris Hitungan & Tombol Ambil (+ Ambil 1) Ramah Jempol */}
                        <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 flex items-center justify-between gap-3">
                          <div>
                            <span className="text-[11px] text-slate-500 block">Jumlah Diambil:</span>
                            <div className="font-mono text-lg font-black">
                              <span className={isDone ? 'text-emerald-600' : 'text-amber-600'}>
                                {picked}
                              </span>
                              <span className="text-slate-400 text-sm"> / {grp.totalQty} pcs</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            {/* Tombol Ambil Semua Barang SKU Ini Langsung */}
                            {!isDone && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (!distBoundBasket) {
                                    setDistNotification({ type: 'error', message: 'Harap ikat nomor keranjang distribusi induk terlebih dahulu!' });
                                    playBuzzer(false);
                                    speakVoice('Harap ikat keranjang induk dahulu');
                                    return;
                                  }
                                  const nextCounts = { ...distPickedCounts, [key]: grp.totalQty };
                                  setDistPickedCounts(nextCounts);
                                  playBuzzer(true);
                                  speakVoice(`Semua ${grp.skuName.split(' ')[0]} diambil`);

                                  const allDone = distConsolidatedItems.length > 0 && distConsolidatedItems.every(g => {
                                    const k = pickingLotKey(g);
                                    return (nextCounts[k] || 0) >= g.totalQty;
                                  });
                                  if (allDone) {
                                    finalizeBatchPicking(distBoundBasket, distActiveBatchOrders);
                                  }
                                }}
                                className="px-3.5 py-2.5 rounded-xl font-black text-xs bg-amber-500 hover:bg-amber-600 text-slate-950 transition-all shadow-sm cursor-pointer active:scale-95 flex items-center gap-1"
                                title="Langsung ambil seluruh pcs barang ini"
                              >
                                ⚡ Ambil Semua ({grp.totalQty} pcs)
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                if (!distBoundBasket) {
                                  setDistNotification({ type: 'error', message: 'Harap ikat nomor keranjang distribusi induk terlebih dahulu!' });
                                  playBuzzer(false);
                                  speakVoice('Harap ikat keranjang induk dahulu');
                                  return;
                                }
                                const currentVal = distPickedCounts[key] || 0;
                                if (currentVal < grp.totalQty) {
                                  const nextVal = currentVal + 1;
                                  const nextCounts = { ...distPickedCounts, [key]: nextVal };
                                  setDistPickedCounts(nextCounts);
                                  playBuzzer(true);
                                  speakVoice(`Satu ${grp.skuName.split(' ')[0]}`);

                                  const allDone = distConsolidatedItems.length > 0 && distConsolidatedItems.every(g => {
                                    const k = pickingLotKey(g);
                                    return (nextCounts[k] || 0) >= g.totalQty;
                                  });
                                  if (allDone) {
                                    finalizeBatchPicking(distBoundBasket, distActiveBatchOrders);
                                  }
                                }
                              }}
                              disabled={isDone}
                              className={`px-3 py-2.5 rounded-xl font-bold text-xs transition-all shadow-sm flex items-center gap-1 cursor-pointer active:scale-95 ${
                                isDone
                                  ? 'bg-emerald-600 text-white cursor-default opacity-90'
                                  : 'bg-sky-600 hover:bg-sky-700 text-white active:bg-sky-800'
                              }`}
                            >
                              {isDone ? (
                                <span>✓ Lengkap</span>
                              ) : (
                                <span>+1x</span>
                              )}
                            </button>
                          </div>
                        </div>

                        {/* Indikator Order Terkait */}
                        <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between">
                          <span>Untuk {grp.orderRefs.length} order pesanan</span>
                          <span className="font-mono text-[10px] text-slate-400">
                            {grp.orderRefs.slice(0, 2).join(', ')}{grp.orderRefs.length > 2 ? '...' : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* TAMPILAN DESKTOP: TABEL LENGKAP MABANG (hidden md:block) */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-100 text-slate-600 font-bold border-b border-slate-200">
                        <th className="p-3 w-16 text-center">Gambar</th>
                        <th className="p-3">SKU / Kode asal / Lokasi / Nama</th>
                        <th className="p-3 text-center">Sudah / Belum diambil</th>
                        <th className="p-3 text-center">Stok gudang</th>
                        <th className="p-3 text-center">Tindakan</th>
                        <th className="p-3 text-center">Alokasi Order</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {distDisplayItems.map((grp, idx) => {
                        const key = pickingLotKey(grp);
                        const picked = distPickedCounts[key] || 0;
                        const isDone = picked >= grp.totalQty;
                        const barcode = getBarcodeForSku(grp.skuId);

                        return (
                          <tr key={grp.skuId} className={isDone ? 'bg-emerald-50/50' : 'hover:bg-slate-50'}>
                            <td className="p-3 text-center">
                              <div className="w-10 h-10 mx-auto rounded-lg bg-slate-100 border border-slate-200 flex flex-col items-center justify-center text-slate-500 font-mono text-[9px] uppercase font-bold">
                                <span className="text-[8px] text-sky-600 font-extrabold">#{idx + 1}</span>
                                <span>{grp.skuId.slice(0, 3)}</span>
                              </div>
                            </td>
                            <td className="p-3 space-y-1">
                              <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span className="px-1.5 py-0.5 bg-sky-100 text-sky-800 rounded text-[10px] font-black font-mono">
                                  Rute #{idx + 1}
                                </span>
                                <span className="inline-flex items-center gap-1 font-mono">
                                  <span>{grp.skuId}</span>
                                  <button
                                    type="button"
                                    onClick={(e) => handleCopyText(grp.skuId, `pick-desk-${grp.skuId}`, e)}
                                    title="Salin SKU ID"
                                    aria-label={`Salin SKU ${grp.skuId}`}
                                    className="p-0.5 hover:bg-slate-200 text-slate-400 hover:text-slate-700 rounded transition-colors cursor-pointer inline-flex items-center justify-center"
                                  >
                                    {copiedKey === `pick-desk-${grp.skuId}` ? (
                                      <Check className="w-3 h-3 text-emerald-600" />
                                    ) : (
                                      <Copy className="w-3 h-3" />
                                    )}
                                  </button>
                                </span>
                                {barcode && (
                                  <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-mono">
                                    Barcode: {barcode}
                                  </span>
                                )}
                              </div>
                              <div className="text-slate-600 font-medium">{grp.skuName}</div>
                              <div className="flex items-center gap-2 text-[11px] text-slate-500">
                                <span className="px-2.5 py-1 bg-amber-100/80 text-amber-900 border border-amber-300 rounded font-black font-mono shadow-xs">
                                  📍 Lokasi Rute: {(grp.warehouseId || 'WH-CENTRAL')+' · '+grp.location}
                                </span>
                                <span>Exp: {grp.expiredDate || '-'}</span>
                              </div>
                            </td>
                            <td className="p-3 text-center">
                              <div className="text-sm font-black">
                                <span className={isDone ? 'text-emerald-600 font-black text-base' : 'text-amber-600'}>
                                  {picked}
                                </span>
                                <span className="text-slate-400"> / {grp.totalQty}</span>
                              </div>
                            </td>
                            <td className="p-3 text-center font-mono font-bold text-slate-700">
                              {stock.filter(item => pickingLotKey(item) === key && isStockPickable(item)).reduce((total, item) => total + Number(item.qty || 0), 0)} pcs
                            </td>
                            <td className="p-3 text-center">
                              <div className="flex items-center justify-center gap-1.5">
                                {/* Tombol Ambil Semua SKU ini */}
                                {!isDone && (
                                  <button
                                    onClick={() => {
                                      if (!distBoundBasket) {
                                        setDistNotification({ type: 'error', message: 'Harap ikat nomor keranjang distribusi induk terlebih dahulu!' });
                                        playBuzzer(false);
                                        speakVoice('Harap ikat keranjang induk dahulu');
                                        return;
                                      }
                                      const nextCounts = { ...distPickedCounts, [key]: grp.totalQty };
                                      setDistPickedCounts(nextCounts);
                                      playBuzzer(true);
                                      speakVoice(`Semua ${grp.skuName.split(' ')[0]} diambil`);

                                      const allDone = distConsolidatedItems.length > 0 && distConsolidatedItems.every(g => {
                                        const k = pickingLotKey(g);
                                        return (nextCounts[k] || 0) >= g.totalQty;
                                      });
                                      if (allDone) {
                                        finalizeBatchPicking(distBoundBasket, distActiveBatchOrders);
                                      }
                                    }}
                                    className="px-2.5 py-1 rounded text-xs font-black bg-amber-500 hover:bg-amber-600 text-slate-950 cursor-pointer shadow-xs active:scale-95 transition-all"
                                    title="Langsung ambil seluruh pcs barang ini"
                                  >
                                    ⚡ Ambil Semua ({grp.totalQty})
                                  </button>
                                )}

                                <button
                                  onClick={() => {
                                    if (!distBoundBasket) {
                                      setDistNotification({ type: 'error', message: 'Harap ikat nomor keranjang distribusi induk terlebih dahulu!' });
                                      playBuzzer(false);
                                      speakVoice('Harap ikat keranjang induk dahulu');
                                      return;
                                    }
                                    const currentVal = distPickedCounts[key] || 0;
                                    if (currentVal < grp.totalQty) {
                                      const nextVal = currentVal + 1;
                                      const nextCounts = { ...distPickedCounts, [key]: nextVal };
                                      setDistPickedCounts(nextCounts);
                                      playBuzzer(true);
                                      speakVoice(`Satu ${grp.skuName.split(' ')[0]}`);

                                      const allDone = distConsolidatedItems.length > 0 && distConsolidatedItems.every(g => {
                                        const k = pickingLotKey(g);
                                        return (nextCounts[k] || 0) >= g.totalQty;
                                      });
                                      if (allDone) {
                                        finalizeBatchPicking(distBoundBasket, distActiveBatchOrders);
                                      }
                                    }
                                  }}
                                  disabled={isDone}
                                  className={`px-2.5 py-1 rounded text-xs font-bold transition-all ${
                                    isDone
                                      ? 'bg-emerald-100 text-emerald-700 cursor-default'
                                      : 'bg-sky-500 hover:bg-sky-600 text-white cursor-pointer active:scale-95'
                                  }`}
                                >
                                  {isDone ? '✓ Lengkap' : '+ Ambil 1'}
                                </button>
                              </div>
                            </td>
                            <td className="p-3 text-center text-slate-500 text-[11px]">
                              <span className="font-semibold text-sky-700">{grp.orderRefs.length} Order</span>
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
        </div>
      )}

      {/* ========================================================================= */}
      {/* SCREEN 2: M SORTING UI (PECAH 1 KERANJANG INDUK MENJADI 20 BASKET ORDER)  */}
      {/* ========================================================================= */}
      {currentScreen === 'sorting' && (() => {
        const boundCount = sortSlots.filter(s => s.isBasketBound).length;
        const completedCount = sortSlots.filter(s => s.isComplete).length;
        const totalBatchQty = sortSlots.reduce((sum, s) => sum + s.order.totalQty, 0);
        const totalBatchScanned = sortSlots.reduce(
          (sum, s) => sum + Object.values(s.itemsDecomposed).reduce((a, b) => a + b, 0),
          0
        );
        const allSlotsComplete = sortSlots.length > 0 && sortSlots.every(s => s.isComplete);
        const selectedSlot = sortSlots.find(s => s.slotNumber === (sortSelectedSlotNumber || 1)) || sortSlots[0] || null;
        const lastAssignedSlotObj = sortLastAssignedSlot
          ? sortSlots.find(s => s.slotNumber === sortLastAssignedSlot) || null
          : null;
        const showAssignedBanner = Boolean(lastAssignedSlotObj);
        const pickerDisplay = sortSlots[0]?.order.pickedBy || sortSlots[0]?.order.pickingBy || '-';
        const heroSlotObj = showAssignedBanner
          ? lastAssignedSlotObj
          : sortLastScannedSku
          ? sortSlots.find(s => s.slotNumber === sortLastScannedSku.slotNumber) || null
          : null;
        const heroSlotDecomp = heroSlotObj
          ? Object.values(heroSlotObj.itemsDecomposed).reduce((a, b) => a + b, 0)
          : 0;

        return (
        <div className="space-y-2.5">
          {DEV_BASELINE_SORTING ? <div role="status" className="p-2.5 bg-amber-100 text-amber-900 font-bold text-xs rounded border border-amber-300">Mode sortir baseline untuk pengujian development lokal. Scan belum divalidasi server; jangan gunakan untuk operasional.</div> :
            SERVER_SCAN_ENABLED && !sortServerReady && <div role="alert" className="p-2.5 bg-amber-100 text-amber-900 font-bold text-xs rounded border border-amber-300">{scanServerUnavailable}</div>}

          {/* Green Tips Strip (Mabang WMS style - ringkas 1 baris) */}
          <div className="wms-info-panel bg-[#E7F6E7] border border-[#BDE5BD] text-[#2F6F2F] text-xs px-3 py-2 rounded-md leading-snug shadow-xs">
            <span className="font-bold">Tips! </span>
            <span>1. Scan keranjang induk (contoh: GB-01) untuk memuat batch order &rarr; </span>
            <span>2. Pastikan 20 anak keranjang terikat (isi Kode Packer bila memakai awalan otomatis) &rarr; </span>
            <span className="text-[#D32F2F] font-bold">{useBaselineSort ? '3. Scan barcode SKU; sistem menentukan basket tujuan otomatis.' : resolveSortingTarget ? '3. Scan barcode SKU; server menentukan basket tujuan otomatis.' : '3. Pilih basket tujuan, lalu scan barcode produk untuk divalidasi server.'}</span>
          </div>

          {/* Top Action Toolbar + Picker/Induk Info + Hero Status Container */}
          <div className="bg-white rounded-md border border-slate-300 shadow-xs overflow-hidden">
            {/* Toolbar Row */}
            <div className="p-2.5 border-b border-slate-200 flex flex-wrap items-center gap-2 bg-[#FAFAFA]">
              {/* 1. Muat Induk */}
              <form onSubmit={useBaselineSort ? handleBaselineLoadSortTask : handleLoadSortTask} className="flex items-center text-xs border border-slate-300 rounded overflow-hidden bg-white">
                <span className="px-2 py-1.5 bg-slate-100 text-slate-700 border-r border-slate-300 font-bold whitespace-nowrap">1. Muat Induk</span>
                <input
                  ref={sortTaskInputRef}
                  type="text"
                  placeholder="Pindai keranjang induk (contoh GB-01)..."
                  value={sortTaskInput}
                  onChange={e => setSortTaskInput(e.target.value)}
                  className="px-2 py-1.5 text-xs outline-none w-40 sm:w-48 text-slate-800 focus:ring-1 focus:ring-sky-500"
                />
                <button type="submit" className="px-2.5 py-1.5 bg-sky-50 text-sky-700 font-bold border-l border-slate-300 hover:bg-sky-100 whitespace-nowrap cursor-pointer">
                  Muat Order
                </button>
              </form>

              {/* 2. Kode Packer */}
              <div className="flex items-center text-xs border border-indigo-300 bg-indigo-50/40 rounded overflow-hidden">
                <span className="px-2 py-1.5 bg-indigo-600 text-white font-bold shrink-0 whitespace-nowrap">
                  2. Kode Packer
                </span>
                <input
                  ref={sortPackerPrefixRef}
                  type="text"
                  placeholder="Kosong (Manual)"
                  value={sortPackerPrefix}
                  onChange={e => setSortPackerPrefix(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const applied = sortPackerPrefix.trim() ? handleApplyPackerPrefix() : true;
                      if (applied) {
                        setTimeout(() => {
                          sortProductRef.current?.focus();
                          sortProductRef.current?.select();
                        }, 100);
                      }
                    }
                  }}
                  className="px-2 py-1.5 text-xs font-black font-mono w-24 text-center uppercase bg-white outline-none text-indigo-950 focus:ring-1 focus:ring-indigo-500 placeholder:text-slate-400 placeholder:font-normal"
                />
                {sortPackerPrefix.trim() ? (
                  <button
                    type="button"
                    onClick={() => handleApplyPackerPrefix()}
                    className="px-2 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold cursor-pointer shrink-0 transition-colors whitespace-nowrap"
                    title={`Terapkan kode ${sortPackerPrefix}1 s/d ${sortPackerPrefix}${sortSlots.length || 20} ke semua slot`}
                  >
                    Setel ({sortPackerPrefix}1-{sortPackerPrefix}{sortSlots.length || 20})
                  </button>
                ) : null}
              </div>

              {/* 3. Scan Produk */}
              <form onSubmit={useBaselineSort ? handleBaselineSortScanProduct : handleSortScanProduct} className={`wms-scan-field flex items-center text-xs border rounded overflow-hidden bg-white ${
                allBasketsBound
                  ? 'border-emerald-500 ring-2 ring-emerald-200'
                  : 'border-slate-300'
              }`}>
                <span className={`px-2 py-1.5 font-bold text-white whitespace-nowrap ${allBasketsBound ? 'bg-emerald-600' : 'bg-slate-500'}`}>
                  3. Scan Produk
                </span>
                <input
                  type="text"
                  placeholder="Tembak barcode SKU untuk sortir..."
                  ref={sortProductRef}
                  value={sortProductInput}
                  onChange={e => setSortProductInput(e.target.value)}
                  disabled={savingSort || sortSlots.length === 0}
                  className="px-2.5 py-1.5 text-xs outline-none w-44 sm:w-52 text-slate-800 focus:ring-1 focus:ring-emerald-500"
                />
              </form>

              {/* Selesaikan sortir */}
              <button
                onClick={useBaselineSort ? handleBaselineEndSorting : handleEndSorting}
                disabled={useBaselineSort
                  ? savingSort || sortSlots.length === 0 || !allBasketsBound || sortSlots.some(s=>!s.isComplete)
                  : !SERVER_SCAN_ENABLED || !sortServerReady || savingSort || sortSlots.length === 0 || !allBasketsBound || sortSlots.some(s=>!s.isComplete)}
                className={`px-3 py-1.5 text-xs font-bold rounded flex items-center gap-1.5 shadow-xs transition-all cursor-pointer whitespace-nowrap ${
                  sortSlots.length > 0 && allBasketsBound && allSlotsComplete
                    ? 'bg-[#52C41A] hover:bg-emerald-600 text-white ring-2 ring-emerald-300'
                    : sortSlots.length > 0 && allBasketsBound
                    ? 'bg-[#52C41A]/80 hover:bg-emerald-600 text-white'
                    : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                }`}
              >
                <Check className="w-3.5 h-3.5" />
                <span>{savingSort ? 'Menyimpan sortir…' : 'Selesaikan sortir'}</span>
              </button>

              {!useBaselineSort && (
                <button
                  type="button"
                  onClick={handleRecoverSorting}
                  disabled={!SERVER_SCAN_ENABLED || savingSort || sortSlots.length === 0}
                  className="px-2.5 py-1.5 text-xs font-bold rounded bg-[#1890FF] hover:bg-sky-600 text-white disabled:bg-slate-300 cursor-pointer whitespace-nowrap"
                >
                  Pulihkan sesi
                </button>
              )}

              {sortSlots.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Apakah Anda yakin ingin mereset sesi sortir untuk keranjang induk "${sortActiveMasterBasket || 'ini'}"?\n\nSeluruh barang yang telah discan akan dikembalikan ke 0 untuk batch ini.`)) {
                      clearSortSessionFromStorage(sortActiveMasterBasket);
                      const resetSlots = sortSlots.map(s => {
                        const initialDecomp: { [itemId: string]: number } = {};
                        s.order.items.forEach(it => { initialDecomp[it.id] = 0; });
                        return {
                          ...s,
                          itemsDecomposed: initialDecomp,
                          isComplete: false
                        };
                      });
                      setSortSlots(resetSlots);
                      setSortLastAssignedSlot(null);
                      setSortLastScannedSku(null);
                      if (sortActiveMasterBasket) {
                        saveSortSessionToStorage(sortActiveMasterBasket, sortPackerPrefix, resetSlots);
                      }
                      setSortNotification({ type: 'info', message: 'Sesi sortir berhasil di-reset kembali ke 0.' });
                    }
                  }}
                  disabled={savingSort}
                  className="px-2.5 py-1.5 text-xs font-bold rounded bg-rose-50 text-rose-700 border border-rose-300 hover:bg-rose-100 transition-colors cursor-pointer whitespace-nowrap"
                  title="Mulai ulang sortir keranjang induk ini dari 0"
                >
                  Mulai Ulang (Reset 0)
                </button>
              )}

              {/* Mabang Right Info Readout: Picker & Induk */}
              <div className="ml-auto flex items-center gap-2 text-xs">
                {sortActiveMasterBasket && (
                  <span className="px-2 py-0.5 bg-sky-100 text-sky-800 border border-sky-200 rounded font-mono font-bold">
                    Induk: {sortActiveMasterBasket}
                  </span>
                )}
                <span className="text-slate-500 font-medium">Picker:</span>
                <span className="font-bold text-[#1890FF]">{pickerDisplay}</span>
              </div>
            </div>

            {/* Mabang 3-Column Hero Status Strip: Basket | SKU / Barcode | Tersortir / Total */}
            <div className="bg-[#F2F4F7]">
              <div className="grid grid-cols-3 text-center text-[11px] font-semibold text-slate-600 border-b border-slate-200 bg-[#E8ECEF] py-1">
                <span>Basket</span>
                <span>SKU / Barcode</span>
                <span>Tersortir / Total</span>
              </div>

              {allSlotsComplete ? (
                <div className="py-3.5 px-4 text-center bg-[#EDF8EE]">
                  <span className="block text-xl sm:text-2xl font-black text-[#00897B] tracking-tight">
                    Sortir Batch Selesai — Klik &ldquo;Selesaikan sortir&rdquo;
                  </span>
                  <span className="block text-xs font-semibold text-emerald-700 mt-0.5">
                    {completedCount}/{sortSlots.length} Keranjang Lengkap &middot; Total {totalBatchScanned}/{totalBatchQty} pcs
                  </span>
                </div>
              ) : sortSlots.length > 0 && (showAssignedBanner || sortLastScannedSku) ? (
                <div className="grid grid-cols-3 items-center text-center py-2.5 px-3 bg-white">
                  <div className="flex flex-col items-center justify-center min-w-0">
                    <span className="text-3xl sm:text-4xl font-black font-mono text-[#00897B] leading-none truncate max-w-full">
                      {showAssignedBanner ? lastAssignedSlotObj?.basketCode : sortLastScannedSku?.basketCode}
                    </span>
                    {showAssignedBanner && lastAssignedSlotObj && (
                      <span className="mt-1 px-2 py-0.5 bg-amber-300 text-slate-950 rounded text-[11px] font-black">
                        Masukkan ke Keranjang: {lastAssignedSlotObj.basketCode}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-col items-center justify-center px-2 min-w-0">
                    <span className="text-sm sm:text-base font-black font-mono text-slate-900 truncate max-w-full">
                      {sortLastScannedSku?.skuId || '-'}
                    </span>
                    {sortLastScannedSku?.barcode && (
                      <span className="text-xs font-mono text-slate-600 truncate max-w-full">
                        {sortLastScannedSku.barcode}
                      </span>
                    )}
                    {sortLastScannedSku?.skuName && (
                      <span className="text-[11px] text-slate-500 truncate max-w-full" title={sortLastScannedSku.skuName}>
                        {sortLastScannedSku.skuName}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-col items-center justify-center min-w-0">
                    <span className="text-3xl sm:text-4xl font-black font-mono text-[#00897B] leading-none tabular-nums">
                      {sortLastScannedSku ? `${sortLastScannedSku.itemScanned}/${sortLastScannedSku.itemRequired}` : '0/0'}
                    </span>
                    {heroSlotObj && (
                      <span className="text-[11px] font-mono text-slate-500 mt-1">
                        Total keranjang: {heroSlotDecomp}/{heroSlotObj.order.totalQty} pcs
                      </span>
                    )}
                  </div>
                </div>
              ) : sortSlots.length > 0 ? (
                <div className="px-4 py-2.5 flex items-center gap-3 bg-[#E9ECEF] text-slate-700 text-xs">
                  <div className="w-6 h-6 rounded-full border border-slate-400 flex items-center justify-center text-slate-500 shrink-0 font-bold">
                    {allBasketsBound ? '✓' : '!'}
                  </div>
                  <div>
                    <div className="font-bold text-slate-800">
                      {allBasketsBound ? 'Siap Sortir' : `Menunggu Pengikatan Keranjang (${boundCount}/${sortSlots.length})`}
                    </div>
                    <div className="text-[11px] text-slate-600">
                      {allBasketsBound
                        ? 'Semua anak keranjang sudah terikat — silakan tembak barcode SKU pada kolom Scan Produk.'
                        : 'Isi/scan seluruh kode anak keranjang atau ketik Kode Packer sebelum memulai scan produk.'}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 items-center text-center py-2.5 px-3 text-xs text-slate-400">
                  <span className="font-mono font-bold">&mdash;</span>
                  <span>Belum ada keranjang induk dimuat</span>
                  <span className="font-mono font-bold">0/0</span>
                </div>
              )}
            </div>
          </div>

          {/* Notification alert (DIPERBESAR KHUSUSNYA JIKA ERROR / SALAH SCAN KARENA TANPA SPEAKER) */}
          {sortNotification && (
            sortNotification.type === 'error' ? (
              <div
                role="alert"
                className="wms-scan-error-alert w-full bg-rose-600 bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white border-4 border-rose-950 rounded-xl p-3.5 sm:p-4 shadow-xl flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3">
                  <div className="wms-scan-error-badge w-10 h-10 rounded-full bg-white text-rose-600 flex items-center justify-center font-black text-xl shrink-0 shadow-lg ring-4 ring-rose-300">
                    ✕
                  </div>
                  <div>
                    <div className="wms-scan-error-title text-[11px] font-black uppercase tracking-wider text-rose-100 flex items-center gap-1.5">
                      <span className="wms-scan-error-dot w-2 h-2 rounded-full bg-white animate-ping"></span>
                      PERINGATAN SALAH SCAN PRODUK (CEK VISUAL):
                    </div>
                    <div className="wms-scan-error-message text-sm sm:text-base md:text-lg font-black text-white leading-tight drop-shadow-sm mt-0.5">
                      {sortNotification.message}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSortNotification(null)}
                  className="wms-scan-error-close px-3 py-1.5 bg-black/40 hover:bg-black/60 text-white font-bold rounded-lg text-xs cursor-pointer shrink-0 transition-colors border border-white/20"
                  title="Tutup Peringatan"
                >
                  TUTUP (✕)
                </button>
              </div>
            ) : (
              <div
                className={`wms-scan-status-banner w-full text-xs sm:text-sm font-bold px-3.5 py-2.5 rounded-lg flex items-center justify-between shadow-xs ${
                  sortNotification.type === 'success'
                    ? 'is-success bg-emerald-500 text-white border border-emerald-600'
                    : 'is-info bg-blue-600 text-white border border-blue-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">{sortNotification.type === 'success' ? '✓' : 'ℹ'}</span>
                  <span>{sortNotification.message}</span>
                </div>
                <button type="button" onClick={() => setSortNotification(null)} className="text-white hover:text-slate-200 cursor-pointer p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )
          )}

          {/* Main Mabang Split Area: Left 4x5 Task list Grid + Right Dual-Mode Panel */}
          <div className="bg-white rounded-md border border-slate-300 shadow-xs overflow-hidden">
            {sortSlots.length === 0 ? (
              <div className="py-14 text-center text-slate-400 space-y-2">
                <div className="w-14 h-14 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                  <Layers className="w-8 h-8" />
                </div>
                <p className="text-sm font-bold text-slate-500">Keranjang Induk Belum Dimuat !</p>
                <p className="text-xs text-slate-400 font-mono">Scan barcode keranjang induk di atas untuk memecah ke 20 basket </p>
                <button
                  onClick={() => DEV_BASELINE_SORTING ? handleBaselineLoadSortTask() : handleLoadSortTask()}
                  disabled={!sortTaskInput.trim()}
                  className="mt-3 px-4 py-2 text-xs font-bold bg-sky-500 hover:bg-sky-600 text-white rounded-lg shadow-xs cursor-pointer disabled:bg-slate-300"
                >
                  Muat keranjang induk yang dipindai
                </button>
              </div>
            ) : (
              <div className="p-2.5 space-y-2.5">
                {/* Banner Input Manual Anak Keranjang jika ada yang belum terikat */}
                {!allBasketsBound && (
                  <div className="bg-amber-50 border-2 border-amber-400 p-2.5 rounded-lg flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded bg-amber-500 text-white font-black flex items-center justify-center text-xs shrink-0">
                        #{sortTargetSlotForBind || nextUnboundSlot?.slotNumber || 1}
                      </div>
                      <div>
                        <div className="text-xs font-black text-amber-950 flex items-center gap-1.5 flex-wrap">
                          <span>Wajib Isi Manual Kode Anak Keranjang untuk Slot #{sortTargetSlotForBind || nextUnboundSlot?.slotNumber || 1}</span>
                          <span className="text-[10px] bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded font-mono font-bold">
                            {boundCount} / {sortSlots.length} Terikat
                          </span>
                        </div>
                        <p className="text-[11px] text-amber-800">
                          Pindai barcode atau ketik kode anak keranjang fisik yang nantinya dimuat di menu Packing.
                        </p>
                      </div>
                    </div>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleBindSlotBasket(sortTargetSlotForBind || nextUnboundSlot?.slotNumber || 1);
                      }}
                      className="flex items-center gap-1.5 ml-auto"
                    >
                      <input
                        ref={sortBasketInputRef}
                        type="text"
                        placeholder={`Kode anak keranjang Slot #${sortTargetSlotForBind || nextUnboundSlot?.slotNumber || 1}...`}
                        value={sortBasketInputManual}
                        onChange={(e) => setSortBasketInputManual(e.target.value.toUpperCase())}
                        className="px-2.5 py-1.5 text-xs font-black font-mono bg-white border-2 border-amber-400 rounded outline-none text-slate-900 w-48 sm:w-60 focus:ring-2 focus:ring-amber-500 placeholder:text-slate-400 placeholder:font-normal"
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-black rounded text-xs cursor-pointer transition-colors shrink-0"
                      >
                        Ikat Slot #{sortTargetSlotForBind || nextUnboundSlot?.slotNumber || 1}
                      </button>
                    </form>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
                  {/* PANEL KIRI (8/12): Mabang Task list 4 Kolom x 5 Baris */}
                  <div className="lg:col-span-8 space-y-2">
                    {/* Header Task list + Contoh Warna Status + Mode Kompak */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5 border-b border-slate-200 text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1 font-bold text-slate-800">
                          <Layers className="w-3.5 h-3.5 text-slate-600" />
                          <span>Task list</span>
                        </span>
                        <span className="text-[11px] font-mono font-bold text-slate-600">
                          ({completedCount}/{sortSlots.length} Lengkap &middot; {totalBatchScanned}/{totalBatchQty} pcs)
                        </span>
                        <span className="text-[11px] font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded">
                          Terpilih: {selectedSlot?.basketCode || `Slot #${sortSelectedSlotNumber || 1} (Belum Diikat)`}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 text-[11px] flex-wrap">
                        <span className="text-slate-500">Contoh:</span>
                        <span className="px-2 py-0.5 rounded bg-[#D9363E] text-white font-semibold">Belum Diikat / Error</span>
                        <span className="px-2 py-0.5 rounded bg-[#F5F7FA] border border-slate-300 text-slate-700 font-semibold">Menunggu sortir</span>
                        <span className="px-2 py-0.5 rounded bg-[#B7EB34] border border-[#8CCB1E] text-slate-900 font-semibold">Sortir lengkap</span>
                        <button
                          type="button"
                          onClick={toggleSortCompactMode}
                          className={`ml-1 px-2 py-0.5 text-[11px] font-bold rounded border transition-all cursor-pointer flex items-center gap-1 ${
                            sortCompactMode
                              ? 'bg-indigo-600 text-white border-indigo-500'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                          }`}
                          title="Mode Kompak untuk Layar Tablet / PDA Handheld agar 20 keranjang muat lebih rapat"
                        >
                          <Minimize2 className="w-3 h-3" />
                          <span>{sortCompactMode ? 'Kompak: ON' : 'Kompak: OFF'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Grid 4 Kolom x 5 Baris (20 Basket Fit Cleanly) */}
                    <div className={`grid grid-cols-2 sm:grid-cols-4 ${sortCompactMode ? 'gap-1.5' : 'gap-2'}`}>
                      {sortSlots.map(slot => {
                        const isAssigned = sortLastAssignedSlot === slot.slotNumber;
                        const isSelected = (sortSelectedSlotNumber || 1) === slot.slotNumber;
                        const totalItems = slot.order.totalQty;
                        const currentDecomp = Object.values(slot.itemsDecomposed).reduce((a, b) => a + b, 0);

                        return (
                          <div
                            key={slot.slotNumber}
                            onClick={() => {
                              setSortSelectedSlotNumber(slot.slotNumber);
                              setSortTargetSlotForBind(slot.slotNumber);
                              setSortRightPanelMode('slot');
                              if (clearSortingIndicatorOnSelection) setSortLastAssignedSlot(null);
                            }}
                            className={`rounded border transition-all cursor-pointer select-none text-left flex flex-col justify-between ${
                              sortCompactMode ? 'p-1.5' : 'p-2'
                            } ${
                              !slot.isBasketBound
                                ? 'bg-[#FFF1F0] border-[#D9363E] text-rose-950 hover:bg-rose-50'
                                : slot.isComplete
                                ? 'bg-[#B7EB34] border-[#8CCB1E] text-slate-900 hover:brightness-95'
                                : isAssigned
                                ? 'bg-emerald-50 border-emerald-600 ring-2 ring-emerald-400 text-slate-900'
                                : 'bg-[#F5F7FA] border-slate-300 text-slate-800 hover:bg-white hover:border-sky-400'
                            } ${isSelected ? 'ring-2 ring-indigo-600 ring-offset-1 z-10' : ''}`}
                          >
                            {/* Baris 1: Basket code + qty */}
                            <div className="flex items-center justify-between gap-1">
                              <div className="flex items-baseline gap-1 min-w-0">
                                <span className={`text-[10px] shrink-0 ${slot.isComplete ? 'text-slate-700' : 'text-slate-500'}`}>
                                  Basket:
                                </span>
                                <div className={`font-black font-mono leading-tight truncate ${
                                  sortCompactMode ? 'text-xs' : 'text-sm'
                                } ${
                                  !slot.isBasketBound
                                    ? 'text-[#D9363E]'
                                    : slot.isComplete
                                    ? 'text-slate-900'
                                    : isAssigned
                                    ? 'text-emerald-700'
                                    : 'text-slate-900'
                                }`}>
                                  {slot.isBasketBound && slot.basketCode ? slot.basketCode : `Slot #${slot.slotNumber}`}
                                </div>
                              </div>
                              <span className={`text-[10px] font-mono font-bold px-1 py-0.5 rounded shrink-0 ${
                                slot.isComplete
                                  ? 'bg-black/10 text-slate-900'
                                  : !slot.isBasketBound
                                  ? 'bg-rose-100 text-rose-700'
                                  : 'bg-slate-200/80 text-slate-700'
                              }`}>
                                {currentDecomp}/{totalItems} pcs
                              </span>
                            </div>

                            {/* Baris 2: Order */}
                            <div className={`flex items-baseline gap-1 text-[10px] leading-tight truncate ${sortCompactMode ? 'mt-0.5' : 'mt-1'}`}>
                              <span className={`shrink-0 ${slot.isComplete ? 'text-slate-700' : 'text-slate-500'}`}>Order:</span>
                              <span className="font-mono font-semibold truncate" title={slot.order.referenceNumber}>
                                {slot.order.orderNumber || slot.order.referenceNumber}
                              </span>
                            </div>

                            {/* Baris 3: Batch / Pelanggan */}
                            <div className="flex items-baseline gap-1 text-[10px] leading-tight truncate mt-0.5">
                              <span className={`shrink-0 ${slot.isComplete ? 'text-slate-700' : 'text-slate-500'}`}>
                                {slot.order.batchNumber ? 'Batch:' : 'Cust:'}
                              </span>
                              <span className="truncate font-medium" title={`${slot.order.batchNumber || ''} ${slot.order.customerName || ''}`.trim()}>
                                {slot.order.batchNumber || slot.order.customerName}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* PANEL KANAN (4/12): Mabang Light Dual-Mode Panel (SKU Ter-scan vs Isi Basket Terpilih) */}
                  <div className="lg:col-span-4 bg-white border border-slate-200 rounded-md overflow-hidden sticky top-20 shadow-xs text-slate-800">
                    {/* Mode Switcher Tabs */}
                    <div className="grid grid-cols-2 border-b border-slate-200 bg-[#F5F7FA] text-xs font-bold">
                      <button
                        type="button"
                        onClick={() => setSortRightPanelMode('sku')}
                        className={`py-2 px-2 text-center border-b-2 transition-colors cursor-pointer ${
                          sortRightPanelMode === 'sku'
                            ? 'bg-white text-sky-700 border-sky-600'
                            : 'text-slate-500 border-transparent hover:text-slate-700'
                        }`}
                      >
                        SKU Ter-scan
                      </button>
                      <button
                        type="button"
                        onClick={() => setSortRightPanelMode('slot')}
                        className={`py-2 px-2 text-center border-b-2 transition-colors cursor-pointer truncate ${
                          sortRightPanelMode === 'slot'
                            ? 'bg-white text-sky-700 border-sky-600'
                            : 'text-slate-500 border-transparent hover:text-slate-700'
                        }`}
                      >
                        Isi Basket ({selectedSlot?.isBasketBound && selectedSlot.basketCode ? selectedSlot.basketCode : `#${selectedSlot?.slotNumber || 1}`})
                      </button>
                    </div>

                    {sortRightPanelMode === 'sku' ? (() => {
                      const targetSkuKey = sortLastScannedSku ? sortLastScannedSku.skuId.trim().toUpperCase() : '';
                      const matchingRows = sortLastScannedSku
                        ? sortSlots
                            .map(slot => {
                              const itemsForSku = slot.order.items.filter(
                                it => it.skuId.trim().toUpperCase() === targetSkuKey
                              );
                              if (itemsForSku.length === 0) return null;
                              const required = itemsForSku.reduce((sum, it) => sum + it.qty, 0);
                              const scanned = itemsForSku.reduce((sum, it) => sum + (slot.itemsDecomposed[it.id] || 0), 0);
                              return {
                                slot,
                                required,
                                scanned,
                                isDone: scanned >= required
                              };
                            })
                            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
                        : [];

                      return (
                        <div>
                          {/* Top SKU Preview Box (Mabang Photo 1 & 2 right top card) */}
                          <div className="p-3 border-b border-slate-200 flex flex-col items-center text-center bg-white">
                            {sortLastScannedSku ? (
                              <>
                                <div className="w-16 h-16 rounded-md bg-teal-50 border border-teal-200 flex flex-col items-center justify-center text-teal-700">
                                  <Package className="w-7 h-7" />
                                  <span className="text-[9px] font-bold uppercase tracking-wider mt-0.5">SKU</span>
                                </div>
                                <div className="text-xs font-mono font-black text-slate-900 mt-1.5 break-all">
                                  {sortLastScannedSku.skuId}
                                </div>
                                {sortLastScannedSku.barcode && (
                                  <div className="text-[11px] font-mono text-slate-500">
                                    {sortLastScannedSku.barcode}
                                  </div>
                                )}
                                <div className="text-[11px] font-medium text-slate-700 mt-0.5 line-clamp-2 max-w-full" title={sortLastScannedSku.skuName}>
                                  {sortLastScannedSku.skuName}
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="w-16 h-16 rounded-md bg-slate-100 border border-dashed border-slate-300 flex items-center justify-center text-slate-300">
                                  <Scan className="w-7 h-7" />
                                </div>
                                <div className="text-[11px] font-medium text-slate-400 mt-1.5">
                                  Siap Scan Barcode SKU
                                </div>
                              </>
                            )}
                          </div>

                          {/* 3-Column Table Header: Basket | Tersortir / Total | Status */}
                          <div className="grid grid-cols-12 text-[11px] font-bold text-slate-600 bg-[#F5F7FA] border-b border-slate-200 px-3 py-1.5">
                            <div className="col-span-4 text-left">Basket</div>
                            <div className="col-span-4 text-center">Tersortir / Total</div>
                            <div className="col-span-4 text-right">Status</div>
                          </div>

                          {!sortLastScannedSku ? (
                            <div className="py-10 px-4 text-center text-slate-400">
                              <div className="w-9 h-9 mx-auto rounded-full border border-slate-300 flex items-center justify-center text-slate-400 mb-2">
                                <Package className="w-4 h-4" />
                              </div>
                              <div className="text-sm font-semibold text-slate-500">Initialize!</div>
                              <div className="text-[11px] text-slate-400 mt-0.5">Belum ada produk discan pada batch ini</div>
                            </div>
                          ) : matchingRows.length === 0 ? (
                            <div className="py-8 px-4 text-center text-xs text-slate-400">
                              Tidak ada slot lain yang menunggu SKU ini.
                            </div>
                          ) : (
                            <div className="divide-y divide-slate-100 max-h-[340px] overflow-y-auto">
                              {matchingRows.map(entry => {
                                const isCurrentTarget = sortLastScannedSku.slotNumber === entry.slot.slotNumber;
                                return (
                                  <div
                                    key={entry.slot.slotNumber}
                                    className={`grid grid-cols-12 items-center px-3 py-2 text-xs ${
                                      isCurrentTarget ? 'bg-emerald-50/70' : 'bg-white'
                                    }`}
                                  >
                                    <div className="col-span-4 text-left">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSortSelectedSlotNumber(entry.slot.slotNumber);
                                          setSortTargetSlotForBind(entry.slot.slotNumber);
                                          setSortRightPanelMode('slot');
                                          if (clearSortingIndicatorOnSelection) setSortLastAssignedSlot(null);
                                        }}
                                        className="font-mono font-black text-sm text-[#1890FF] hover:underline cursor-pointer"
                                        title="Klik untuk melihat detail keranjang ini"
                                      >
                                        {entry.slot.isBasketBound && entry.slot.basketCode
                                          ? entry.slot.basketCode
                                          : `Slot #${entry.slot.slotNumber}`}
                                      </button>
                                    </div>
                                    <div className="col-span-4 text-center font-mono font-bold text-sm text-sky-700 tabular-nums">
                                      {entry.scanned}/{entry.required}
                                    </div>
                                    <div className="col-span-4 text-right">
                                      {entry.isDone ? (
                                        <span className="inline-block px-2 py-0.5 rounded bg-[#52C41A] text-white text-[10px] font-bold">
                                          OK
                                        </span>
                                      ) : (
                                        <span className="inline-block px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-bold">
                                          Kurang {entry.required - entry.scanned}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })() : (() => {
                      const activeSlot = selectedSlot;
                      if (!activeSlot) return null;

                      const totalItems = activeSlot.order.totalQty;
                      const currentDecomp = Object.values(activeSlot.itemsDecomposed).reduce((a, b) => a + b, 0);
                      const remainingPcs = totalItems - currentDecomp;

                      return (
                        <div className="p-3 space-y-3 bg-white">
                          {/* Header Panel Kanan: Keranjang Terpilih */}
                          <div className="border-b border-slate-200 pb-2.5 flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded text-[10px] font-mono font-bold">
                                  Slot #{activeSlot.slotNumber}
                                </span>
                                <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                                  activeSlot.isComplete
                                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                    : !activeSlot.isBasketBound
                                    ? 'bg-rose-100 text-rose-700 border border-rose-300'
                                    : 'bg-amber-100 text-amber-800 border border-amber-300'
                                }`}>
                                  {activeSlot.isComplete ? '✓ Lengkap / Siap Packing' : !activeSlot.isBasketBound ? '⚠ Wajib Input' : `Kurang ${remainingPcs} pcs`}
                                </span>
                              </div>
                              <h3 className="text-base sm:text-lg font-black font-mono text-slate-900 mt-1 flex items-baseline gap-1.5 flex-wrap">
                                <span>Anak Keranjang:</span>
                                <span className={activeSlot.isBasketBound && activeSlot.basketCode ? 'text-[#00897B] text-xl font-black' : 'text-amber-600 text-xs font-bold'}>
                                  {activeSlot.isBasketBound && activeSlot.basketCode ? activeSlot.basketCode : '(Belum Diisi)'}
                                </span>
                              </h3>

                              {/* Form Input / Edit Anak Keranjang untuk Slot ini */}
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleBindSlotBasket(activeSlot.slotNumber);
                                }}
                                className="flex items-center gap-1.5 mt-2"
                              >
                                <input
                                  type="text"
                                  placeholder={`Kode anak keranjang Slot #${activeSlot.slotNumber}...`}
                                  value={sortTargetSlotForBind === activeSlot.slotNumber ? sortBasketInputManual : ''}
                                  onFocus={() => setSortTargetSlotForBind(activeSlot.slotNumber)}
                                  onChange={(e) => {
                                    setSortTargetSlotForBind(activeSlot.slotNumber);
                                    setSortBasketInputManual(e.target.value.toUpperCase());
                                  }}
                                  className="px-2 py-1 text-xs bg-slate-50 border border-slate-300 rounded text-slate-900 font-mono font-bold flex-1 min-w-0 focus:ring-1 focus:ring-sky-500 placeholder:text-slate-400"
                                />
                                <button
                                  type="submit"
                                  className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-bold cursor-pointer shrink-0 transition-colors"
                                >
                                  {activeSlot.isBasketBound ? 'Ubah' : 'Ikat'}
                                </button>
                              </form>
                            </div>

                            <div className="text-right shrink-0">
                              <span className="text-[10px] text-slate-500 block uppercase font-bold">Total</span>
                              <div className="font-mono text-base font-black text-slate-900 tabular-nums">
                                <span className={activeSlot.isComplete ? 'text-emerald-600' : 'text-amber-600'}>
                                  {currentDecomp}
                                </span>
                                <span className="text-slate-400 text-xs"> / {totalItems} pcs</span>
                              </div>
                            </div>
                          </div>

                          {/* Info Pelanggan & Order */}
                          <div className="bg-slate-50 border border-slate-200 rounded p-2 text-xs space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-500 text-[11px]">Pelanggan:</span>
                              <span className="font-bold text-slate-900 truncate max-w-[180px]">{activeSlot.order.customerName}</span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-500 text-[11px]">No. Order / Ref:</span>
                              <span className="font-mono text-sky-700 font-semibold text-[11px] truncate max-w-[180px]">{activeSlot.order.referenceNumber}</span>
                            </div>
                            {activeSlot.order.courier && (
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500 text-[11px]">Ekspedisi:</span>
                                <span className="font-semibold text-slate-700 text-[11px]">{activeSlot.order.courier}</span>
                              </div>
                            )}
                          </div>

                          {/* Daftar Deskripsi Isi Produk per Basket */}
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                              <span className="flex items-center gap-1.5">
                                <Package className="w-3.5 h-3.5 text-sky-600" />
                                <span>Isi Produk ({new Set(activeSlot.order.items.map(i=>i.skuId)).size} SKU &middot; {activeSlot.order.items.length} baris)</span>
                              </span>
                            </div>

                            <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-0.5 scrollbar-thin">
                              {activeSlot.order.items.map((it, idx) => {
                                const scanned = activeSlot.itemsDecomposed[it.id] || 0;
                                const isItemDone = scanned >= it.qty;
                                const barcode = getBarcodeForSku(it.skuId);

                                return (
                                  <div
                                    key={it.id || idx}
                                    className={`p-2 rounded border text-xs transition-all ${
                                      isItemDone
                                        ? 'bg-emerald-50 border-emerald-300 text-slate-800'
                                        : 'bg-white border-slate-200 text-slate-700'
                                    }`}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1 flex-wrap">
                                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-sky-50 text-sky-800 border border-sky-200 rounded font-mono font-bold text-[11px]">
                                            <span>{it.skuId}</span>
                                            <button
                                              type="button"
                                              onClick={(e) => handleCopyText(it.skuId, `sort-${activeSlot.slotNumber}-${it.id || idx}`, e)}
                                              title="Salin SKU ID"
                                              aria-label={`Salin SKU ${it.skuId}`}
                                              className="p-0.5 hover:bg-sky-200/60 text-sky-700 rounded transition-colors cursor-pointer inline-flex items-center justify-center"
                                            >
                                              {copiedKey === `sort-${activeSlot.slotNumber}-${it.id || idx}` ? (
                                                <Check className="w-3 h-3 text-emerald-600" />
                                              ) : (
                                                <Copy className="w-3 h-3 text-sky-600" />
                                              )}
                                            </button>
                                          </span>
                                          {barcode && (
                                            <span className="text-[10px] text-slate-500 font-mono">
                                              ({barcode})
                                            </span>
                                          )}
                                        </div>
                                        <p className="text-[11px] font-semibold text-slate-900 mt-1 leading-snug line-clamp-2 hover:line-clamp-none break-words" title={it.skuName}>
                                          {it.skuName}
                                        </p>
                                        {it.location && (
                                          <div className="text-[10px] text-amber-700 mt-0.5 font-mono">
                                            Rak: {it.location} {it.expiredDate ? `• Exp: ${it.expiredDate}` : ''}
                                          </div>
                                        )}
                                      </div>

                                      <div className="text-right shrink-0">
                                        <div className={`font-mono text-xs font-black px-1.5 py-0.5 rounded border ${
                                          isItemDone
                                            ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                            : 'bg-amber-50 text-amber-800 border-amber-300'
                                        }`}>
                                          {scanned}/{it.qty} <span className="text-[9px] font-normal">pcs</span>
                                        </div>
                                        <div className="text-[10px] mt-0.5 font-bold">
                                          {isItemDone ? (
                                            <span className="text-emerald-700">✓ Lengkap</span>
                                          ) : (
                                            <span className="text-amber-700">Kurang {it.qty - scanned}</span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          {/* Guarded Disabled Manual Validation Info */}
                          <div className="pt-2 border-t border-slate-200">
                            <button
                              type="button"
                              disabled
                              title="Validasi manual dinonaktifkan."
                              className="w-full py-1.5 text-[11px] font-bold rounded bg-slate-100 text-slate-400 border border-slate-200 flex items-center justify-center gap-1.5 cursor-not-allowed"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>{activeSlot.isComplete ? 'Keranjang Ini Sudah Lengkap' : 'Wajib Scan Barcode (Manual Dinonaktifkan)'}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* ========================================================================= */}
      {/* SCREEN 3: M DELIVERY UI (PACKER STATION, WEIGHING & AUTO-PRINT)           */}
      {/* ========================================================================= */}
      {currentScreen === 'delivery' && (
        <div className="space-y-3">
          {SERVER_SCAN_ENABLED && <div role="alert" className="p-3 bg-amber-100 text-amber-900 font-bold">{scanServerUnavailable} Hitungan di layar belum tercatat di server.</div>}
          {/* Green Tips Box (Exact Mabang) */}
          <div className="wms-info-panel bg-[#E7F6E7] border border-[#BDE5BD] text-[#2F6F2F] text-xs p-3 rounded-lg leading-relaxed shadow-sm">
            <span className="font-bold">Tips! </span>
            <span>1. Pindai nomor tugas atau keranjang untuk menampilkan barang yang akan dikemas. &nbsp;&nbsp;</span>
            <span>2. Bawa keranjang yang sudah selesai disortir, lalu pindai kode keranjangnya. &nbsp;&nbsp;</span>
            <span>3. Verifikasi semua barang sebelum menyelesaikan pengemasan. Cetak otomatis hanya aktif jika Anda memilihnya.</span>
          </div>

          {/* Action & Scan Bar */}
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex flex-wrap items-center gap-3">
            {/* Courier dropdown */}
            <div className="flex items-center text-xs border border-slate-300 rounded-md overflow-hidden bg-white">
              <span className="px-2.5 py-1.5 bg-slate-100 text-slate-600 border-r border-slate-300">Ekspedisi</span>
              <span className="px-2.5 py-1.5 text-slate-700 font-bold">
                {deliveryActiveOrder?.courier || 'Semua Ekspedisi'}
              </span>
            </div>

            {/* Shop dropdown */}
            <div className="flex items-center text-xs border border-slate-300 rounded-md overflow-hidden bg-white">
              <span className="px-2.5 py-1.5 bg-slate-100 text-slate-600 border-r border-slate-300">Toko</span>
              <span className="px-2.5 py-1.5 text-slate-700 font-bold">
                {deliveryActiveOrder?.shopName || 'Toko Online'}
              </span>
            </div>

            {/* Pindai kode keranjang form */}
            <form onSubmit={handleLoadDeliveryBasket} className="flex items-center text-xs border border-slate-300 rounded-md overflow-hidden bg-white">
              <span className="px-2.5 py-1.5 bg-slate-100 text-slate-600 border-r border-slate-300 font-bold">Pindai kode keranjang</span>
              <input
                ref={deliveryBasketInputRef}
                type="text"
                placeholder="Pindai / ketik nomor keranjang (contoh B-01)..."
                value={deliveryBasketInput}
                onChange={e => setDeliveryBasketInput(e.target.value)}
                className="px-2.5 py-1.5 text-xs outline-none w-48 sm:w-60 text-slate-800 focus:ring-1 focus:ring-sky-500 font-mono font-bold"
              />
              <button type="submit" className="px-2.5 py-1.5 bg-sky-50 text-sky-700 font-bold border-l border-slate-300 hover:bg-sky-100">
                Cari
              </button>
            </form>

            {/* Weight Input (g) */}
            <form onSubmit={handleWeightSubmit} className="flex items-center text-xs border border-slate-300 rounded-md overflow-hidden bg-white focus-within:ring-2 focus-within:ring-amber-500 focus-within:border-amber-500 shadow-xs">
              <span className="px-2.5 py-1.5 bg-slate-100 text-slate-700 font-bold border-r border-slate-300 select-none">Berat paket</span>
              <input
                ref={deliveryWeightInputRef}
                type="number"
                min="1"
                step="any"
                placeholder="0"
                value={deliveryWeight}
                disabled={deliveryBusy || !deliveryReady}
                onChange={e => setDeliveryWeight(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    // Cegah enter sisa/bocor dari scanner barcode saat baru saja fokus (< 350ms)
                    if (Date.now() - lastWeightFocusTimeRef.current < 350) {
                      return;
                    }
                    handleWeightSubmit();
                  }
                }}
                className="px-2 py-1.5 text-xs outline-none w-20 text-slate-800 text-center font-bold font-mono focus:bg-amber-50"
              />
              <button 
                type="submit" 
                title="Simpan berat & cetak resi (Enter)" 
                disabled={deliveryBusy || !deliveryReady}
                className="px-2.5 py-1.5 bg-sky-500 hover:bg-sky-600 text-white font-bold select-none cursor-pointer transition-colors"
              >
                /g
              </button>
            </form>

            {/* Scan Product Barcode Inspection */}
            <form onSubmit={handleDeliveryScanProduct} className="wms-scan-field flex items-center text-xs border border-emerald-400 rounded-md overflow-hidden bg-white shadow-sm ring-1 ring-emerald-200">
              <span className="px-2.5 py-1.5 bg-emerald-500 text-white font-bold">Pindai SKU</span>
              <input
                ref={deliveryProductRef}
                type="text"
                placeholder="Tembak barcode produk..."
                value={deliveryProductInput}
                disabled={deliveryBusy || !deliveryReady}
                onChange={e => setDeliveryProductInput(e.target.value)}
                className="px-2.5 py-1.5 text-xs outline-none w-40 sm:w-48 text-slate-800 focus:ring-1 focus:ring-emerald-500 font-mono font-bold"
              />
            </form>

            {/* Action buttons & Auto-Print Toggle */}
            <div className="flex flex-wrap items-center gap-2.5 ml-auto">
              <button
                type="button"
                onClick={handlePrintAgain}
                disabled={!lastPackedReceipt}
                className={`px-3 py-1.5 text-xs font-bold rounded-md border flex items-center gap-1.5 shadow-xs transition-all cursor-pointer ${
                  lastPackedReceipt
                    ? 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100 active:scale-95'
                    : 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed opacity-60'
                }`}
                title={lastPackedReceipt ? `Cetak ulang resi pesanan terakhir (${lastPackedReceipt.orderId || lastPackedReceipt.referenceNumber})` : 'Belum ada order yang diselesaikan'}
              >
                <Printer className="w-3.5 h-3.5 text-amber-600" />
                <span>Print Again</span>
                {lastPackedReceipt && (
                  <span className="max-w-[80px] truncate text-[10px] font-mono font-normal opacity-75 hidden md:inline">
                    ({lastPackedReceipt.orderId || lastPackedReceipt.referenceNumber})
                  </span>
                )}
              </button>
              <label className="flex items-center gap-1.5 text-xs font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 px-2.5 py-1.5 rounded-md cursor-pointer select-none transition-colors">
                <input
                  type="checkbox"
                  checked={autoPrintReceipt}
                  onChange={e => setAutoPrintReceipt(e.target.checked)}
                  className="w-3.5 h-3.5 text-emerald-600 rounded cursor-pointer accent-emerald-600"
                />
                <Printer className="w-3.5 h-3.5 text-emerald-600" />
                <span>Auto-Cetak Resi</span>
              </label>
              {SERVER_SCAN_ENABLED && (
                <button type="button" onClick={handleRecoverDelivery}
                  disabled={!deliveryTask || deliveryBusy}
                  className="px-3 py-1.5 text-xs font-bold rounded-md border border-slate-300 disabled:opacity-50">
                  Pulihkan sesi packing
                </button>
              )}
              {deliveryActiveOrder && (
                <button
                  type="button"
                  onClick={handleCancelDelivery}
                  className="px-3 py-1.5 text-xs font-bold rounded-md border border-slate-300 bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer flex items-center gap-1.5 shadow-xs"
                  title="Batalkan atau ganti keranjang yang sedang dibuka"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Ganti Keranjang</span>
                </button>
              )}
              <button
                onClick={() => handleCompleteDelivery()}
                disabled={deliveryBusy || !deliveryReady || !deliveryActiveOrder || !deliveryActiveOrder.isSorted}
                className={`px-4 py-1.5 text-xs font-bold rounded-md flex items-center gap-1.5 shadow-sm transition-all cursor-pointer ${
                  deliveryActiveOrder && deliveryActiveOrder.isSorted
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white active:scale-95'
                    : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                }`}
              >
                <Printer className="w-3.5 h-3.5" />
                <span>Selesai Packing</span>
              </button>
            </div>

            {/* Notification alert (DIPERBESAR JIKA ERROR KARENA TANPA SPEAKER) */}
            {deliveryNotification && (
              deliveryNotification.type === 'error' ? (
                <div
                  role="alert"
                  className="wms-scan-error-alert w-full bg-rose-600 bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white border-4 border-rose-950 rounded-xl p-3.5 sm:p-4 shadow-2xl animate-bounce flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="wms-scan-error-badge w-10 h-10 rounded-full bg-white text-rose-600 flex items-center justify-center font-black text-xl shrink-0 shadow-lg ring-4 ring-rose-300">
                      ✕
                    </div>
                    <div>
                      <div className="wms-scan-error-title text-[11px] font-black uppercase tracking-wider text-rose-100 flex items-center gap-1.5">
                        <span className="wms-scan-error-dot w-2 h-2 rounded-full bg-white animate-ping"></span>
                        PERINGATAN SALAH SCAN PACKING (CEK VISUAL):
                      </div>
                      <div className="wms-scan-error-message text-sm sm:text-base md:text-lg font-black text-white leading-tight drop-shadow-sm mt-0.5">
                        {deliveryNotification.message}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDeliveryNotification(null)}
                    className="wms-scan-error-close px-3 py-1.5 bg-black/40 hover:bg-black/60 text-white font-bold rounded-lg text-xs cursor-pointer shrink-0 transition-colors border border-white/20"
                    title="Tutup Peringatan"
                  >
                    TUTUP (✕)
                  </button>
                </div>
              ) : (
                <div
                  className={`wms-scan-status-banner w-full text-xs sm:text-sm font-bold px-3.5 py-2.5 rounded-lg flex items-center justify-between shadow-sm ${
                    deliveryNotification.type === 'success'
                      ? 'is-success bg-emerald-500 text-white border-2 border-emerald-600'
                      : 'is-info bg-blue-600 text-white border-2 border-blue-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">{deliveryNotification.type === 'success' ? '✓' : 'ℹ'}</span>
                    <span>{deliveryNotification.message}</span>
                  </div>
                  <button type="button" onClick={() => setDeliveryNotification(null)} className="text-white hover:text-slate-200 cursor-pointer p-1">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )
            )}
          </div>

          {/* Summary Bar */}
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm text-slate-700 font-semibold">
            <div className="flex flex-wrap items-center gap-4">
              <span>Baris barang: <b className="text-sky-600">{deliveryActiveOrder ? deliveryActiveOrder.items.length : 0}</b> baris;</span>
              <span>Jumlah total: <b className="text-sky-600">{deliveryActiveOrder ? deliveryActiveOrder.totalQty : 0}</b> pcs;</span>
              <span>Keranjang sortir: <b className={`font-mono ${deliveryActiveOrder?.isSorted ? 'text-emerald-600' : 'text-rose-600 font-black'}`}>{deliveryActiveOrder?.basketNumber || '--'}{deliveryActiveOrder && !deliveryActiveOrder.isSorted ? ' ⚠ (KERANJANG INDUK / BELUM DISORTIR)' : ''}</b> ;</span>
              <span>Picker: <b className="text-slate-900">{deliveryActiveOrder?.pickingBy || deliveryActiveOrder?.pickedBy || '--'}</b> ;</span>
              <span>Toko: <b className="text-slate-900">{deliveryActiveOrder?.shopName || '--'}</b> ;</span>
            </div>
          </div>

          {/* Warning Banner if keranjang induk is loaded */}
          {deliveryActiveOrder && !deliveryActiveOrder.isSorted && (
            <div role="alert" className="wms-inline-danger-banner bg-rose-50 border-2 border-rose-400 p-3.5 rounded-lg flex items-center justify-between gap-3 text-rose-900 animate-pulse">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
                <div className="text-xs sm:text-sm">
                  <strong>PERINGATAN: Keranjang "{deliveryActiveOrder.basketNumber}" adalah Keranjang Induk Picker!</strong>
                  <p className="text-xs text-rose-700 mt-0.5">Pesanan ini belum melalui Meja Sortir (Tahap 2). Silakan keluarkan keranjang ini dan bawa ke Meja Sortir terlebih dahulu.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancelDelivery}
                className="wms-inline-danger-btn px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-md text-xs cursor-pointer shrink-0 transition-colors"
              >
                Keluarkan Keranjang
              </button>
            </div>
          )}

          {/* Red Bold Order Note (Exact Mabang Catatan order:) */}
          <div className="bg-rose-50 border border-rose-200 p-3 rounded-lg flex items-start gap-2">
            <span className="text-[#D32F2F] font-black text-sm shrink-0">Catatan order:</span>
            <span className="text-[#D32F2F] font-bold text-xs sm:text-sm">
              {deliveryActiveOrder?.notes || 'Tidak ada catatan khusus dari pembeli (Kemasan standar).'}
            </span>
          </div>

          {/* Table of delivery items */}
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            {!deliveryActiveOrder ? (
              <div className="py-16 text-center text-slate-400 space-y-2">
                <div className="w-14 h-14 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                  <Package className="w-8 h-8" />
                </div>
                <p className="text-sm font-bold text-slate-500">Menunggu keranjang untuk dikemas</p>
                <p className="text-xs text-slate-400 font-mono">Pindai kode keranjang untuk memulai pemeriksaan </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 font-bold border-b border-slate-200">
                      <th className="p-3 w-14 text-center">Gambar</th>
                      <th className="p-3">SKU / Kode asal / Lokasi / Nama</th>
                      <th className="p-3 text-center">SKU platform / Varian / Jumlah</th>
                      <th className="p-3 text-center">Sudah / Belum diperiksa</th>
                      <th className="p-3 text-center">Tindakan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {deliveryActiveOrder.items.map(item => {
                      const inspected = deliveryScannedCounts[item.id] || 0;
                      const isComplete = inspected >= item.qty;
                      const barcode = getBarcodeForSku(item.skuId);

                      return (
                        <tr key={item.id} className={isComplete ? 'bg-emerald-50/50' : 'hover:bg-slate-50'}>
                          <td className="p-3 text-center">
                            <div className="w-9 h-9 mx-auto rounded bg-slate-100 border border-slate-200 flex items-center justify-center text-[9px] font-bold text-slate-400 uppercase">
                              {item.skuId.slice(0, 3)}
                            </div>
                          </td>
                          <td className="p-3 space-y-0.5">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 font-mono">
                                <span>{item.skuId}</span>
                                <button
                                  type="button"
                                  onClick={(e) => handleCopyText(item.skuId, `pack-${item.id}`, e)}
                                  title="Salin SKU ID"
                                  aria-label={`Salin SKU ${item.skuId}`}
                                  className="p-1 hover:bg-slate-200 text-slate-400 hover:text-slate-700 rounded transition-colors cursor-pointer inline-flex items-center justify-center"
                                >
                                  {copiedKey === `pack-${item.id}` ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </span>
                              {barcode && (
                                <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-mono">
                                  {barcode}
                                </span>
                              )}
                            </div>
                            <div className="text-slate-600 font-medium">{item.skuName}</div>
                            <div className="text-[11px] text-amber-700 font-bold">
                              Bin: {item.location} • Exp: {item.expiredDate || '-'}
                            </div>
                          </td>
                          <td className="p-3 text-center font-bold text-slate-800">
                            <div>Standar</div>
                            <div className="text-sky-700 font-mono text-sm">{item.qty} pcs</div>
                          </td>
                          <td className="p-3 text-center">
                            <div className="text-sm font-black">
                              <span className={isComplete ? 'text-emerald-600' : 'text-amber-600'}>
                                {inspected}
                              </span>
                              <span className="text-slate-400"> / {item.qty}</span>
                            </div>
                            <div className="text-[10px] font-bold mt-0.5">
                              {isComplete ? (
                                <span className="wms-status-success text-emerald-700">✓ Sudah Diperiksa</span>
                              ) : (
                                <span className="text-amber-600">Menunggu pemindaian</span>
                              )}
                            </div>
                          </td>
                          <td className="p-3 text-center">
                            <button
                              type="button"
                              disabled={isComplete}
                              onClick={() => {
                                if (isComplete || !deliveryActiveOrder || deliveryBusyRef.current) return;
                                const nextCounts = { ...deliveryScannedCounts, [item.id]: (deliveryScannedCounts[item.id] || 0) + 1 };
                                setDeliveryScannedCounts(nextCounts);
                                playBuzzer(true);
                                speakVoice(`Validasi ${item.skuId}`);
                                const allPacked = deliveryActiveOrder.items.every(it => (nextCounts[it.id] || 0) >= it.qty);
                                if (allPacked) {
                                  setDeliveryNotification({ 
                                    type: 'success', 
                                    message: '✓ Seluruh barang lengkap (100%)! Silakan masukkan berat paket, lalu tekan Enter untuk cetak resi.' 
                                  });
                                  speakVoice('Semua barang lengkap. Masukkan berat paket lalu tekan Enter.');
                                  setTimeout(() => {
                                    lastWeightFocusTimeRef.current = Date.now();
                                    deliveryWeightInputRef.current?.focus();
                                    deliveryWeightInputRef.current?.select();
                                  }, 150);
                                } else {
                                  setDeliveryNotification({ type: 'success', message: `✓ Validasi ${item.skuId}: ${nextCounts[item.id]}/${item.qty} pcs.` });
                                }
                              }}
                              className={`px-2.5 py-1 rounded text-xs font-bold transition-all cursor-pointer ${
                                isComplete
                                  ? 'bg-emerald-100 text-emerald-700 cursor-default'
                                  : 'bg-emerald-600 hover:bg-emerald-700 text-white active:scale-95'
                              }`}
                            >
                              {isComplete ? '✓ Valid' : '+1 Validasi'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Two-Column Informasi order Box (Exact Mabang) */}
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 space-y-3">
            <h3 className="text-xs font-bold text-slate-700 border-b border-slate-200 pb-2">
              Informasi order
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left Box: Cyan/Sky Tinted */}
              <div className="bg-[#EBF7FC] border border-[#C5E9F7] p-4 rounded-lg space-y-2 text-xs">
                <div>
                  <span className="font-extrabold text-[#006699] text-base block">
                    Toko: {deliveryActiveOrder?.shopName || 'Toko Online'}
                  </span>
                </div>
                <div>
                  <span className="font-black text-[#006699] text-sm block">
                    Bahan kemasan: Polymailer Plastik Tebal / Bubble Wrap 3 Lapis
                  </span>
                </div>
                <div className="pt-1 text-[#004466]">
                  <span className="font-bold">Nomor order: </span>
                  <span className="font-mono font-bold">{deliveryActiveOrder?.referenceNumber || '--'}</span>
                </div>
                <div className="text-[#004466]">
                  <span className="font-bold">Platform / Resi : </span>
                  <span className="font-mono font-bold">{deliveryActiveOrder?.orderId || '--'}</span>
                </div>
              </div>

              {/* Right Box: Green Tinted */}
              <div className="bg-[#EBF7EB] border border-[#C7ECC7] p-4 rounded-lg space-y-1.5 text-xs text-[#1E5C1E]">
                <div>
                  <span className="font-bold">Nama: </span>
                  <span className="font-extrabold text-sm">{deliveryActiveOrder?.customerName || '--'}</span>
                </div>
                <div>
                  <span className="font-bold">Alamat: </span>
                  <span>{deliveryActiveOrder?.customerAddress || '--'}</span>
                </div>
                <div>
                  <span className="font-bold">Telepon: </span>
                  <span className="font-mono">{deliveryActiveOrder?.customerPhone || '--'}</span>
                </div>
                <div>
                  <span className="font-bold">Kota / Wilayah: </span>
                  <span>--</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isBasketLabelModalOpen && (
        <BasketLabelGeneratorModal
          isOpen={isBasketLabelModalOpen}
          onClose={() => setIsBasketLabelModalOpen(false)}
          activeBasketsFromOrders={pendingOrders.map(o => o.basketNumber).filter(Boolean) as string[]}
        />
      )}

      {isAdminRole && isMasterBasketMonitorOpen && (
        <MasterBasketMonitorModal
          isOpen={isMasterBasketMonitorOpen}
          onClose={() => setIsMasterBasketMonitorOpen(false)}
          orderHistory={orderHistory}
          onUpdateOrderSession={onUpdateOrderSession}
          onAfterRenameMasterBasket={(refs, newBasketCode) => {
            const refSet = new Set(refs);
            setDistActiveBatchOrders(prev => {
              const hasAny = prev.some(o => refSet.has(o.referenceNumber));
              const allMoved = hasAny && prev.every(o => refSet.has(o.referenceNumber));
              if (allMoved) {
                setDistBoundBasket(newBasketCode);
              }
              return prev.map(o =>
                refSet.has(o.referenceNumber)
                  ? { ...o, basketNumber: newBasketCode, masterBasketNumber: newBasketCode }
                  : o
              );
            });
            if (!sortStarted) {
              setSortSlots(prev => {
                if (prev.length === 0) return prev;
                const hasAny = prev.some(slot => refSet.has(slot.order.referenceNumber));
                if (!hasAny) return prev;
                const allMoved = prev.every(slot => refSet.has(slot.order.referenceNumber));
                if (allMoved) {
                  setSortActiveMasterBasket(newBasketCode);
                  setSortTaskInput(newBasketCode);
                  return prev.map(slot => ({
                    ...slot,
                    order: {
                      ...slot.order,
                      basketNumber: newBasketCode,
                      masterBasketNumber: newBasketCode,
                    },
                  }));
                }
                return prev.filter(slot => !refSet.has(slot.order.referenceNumber));
              });
            }
          }}
          onSelectBasketForSortir={(basketCode) => {
            setIsMasterBasketMonitorOpen(false);
            switchScreen('sorting');
            if (sortSaveBusy.current || sortStarted) {
              setSortNotification({
                type: 'error',
                message: `Selesaikan sesi sortir aktif terlebih dahulu sebelum membuka keranjang "${basketCode}".`,
              });
              return;
            }
            void handleLoadSortTask(null, basketCode);
          }}
        />
      )}

      {receiptOrder && (
        <ShippingReceiptModal
          isOpen={true}
          onClose={() => {
            setReceiptOrder(null);
            setDeliveryWeight('');
            setTimeout(() => {
              deliveryBasketInputRef.current?.focus();
            }, 100);
          }}
          order={receiptOrder}
          currentUser={currentUser}
          autoPrint={autoPrintReceipt}
        />
      )}

      <OrderIssueModal
        open={issueModalOpen}
        references={activeIssueReferences}
        stage={activeIssueStage}
        reporterName={currentUser?.fullName || currentUser?.username || 'Operator'}
        onClose={() => setIssueModalOpen(false)}
        onSubmit={handleReportOrderIssue}
      />
    </div>
  );
}
