import type {SortingTask} from '../utils/orderSorting';
import type {OrderSessionData,OrderSessionResult} from '../utils/orderSession';
import { scanServerUnavailable } from '../utils/packingValidation';
import { DEV_BASELINE_SORTING, getActiveBranch, SERVER_SCAN_ENABLED, serverScanRpc, supabase } from '../supabase';
import { createScanServerSession, createSortingServerSession } from '../utils/sortingServerSession';
import type { ScanProgress } from '../utils/serverScanRpc';
import { normalizeDateToDmy, isStockPickable } from '../utils/calculations';
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
  Info
} from 'lucide-react';
import { findSkuId, getBarcodeForSku, BARCODE_MAP } from '../data/barcodeMap';
import BasketLabelGeneratorModal from './BasketLabelGeneratorModal';
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
  onClose
}: MabangWmsOutboundProps) {
  // Screen sub-navigation: Picker starts at 'distribution', Packer starts at 'sorting'
  const isPickerRole = currentUser?.role === 'Picker';
  const isPackerRole = currentUser?.role === 'Packer';
  const [currentScreen, setCurrentScreen] = useState<MabangScreen>(() => {
    if (isPackerRole) return 'sorting';
    return 'distribution';
  });

  // Ensure role stays on allowed screens if role changes
  useEffect(() => {
    if (isPickerRole && currentScreen !== 'distribution') {
      setCurrentScreen('distribution');
    } else if (isPackerRole && currentScreen === 'distribution') {
      setCurrentScreen('sorting');
    }
  }, [currentUser?.role]);

  // Voice Broadcast State
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [lastSpokenText, setLastSpokenText] = useState<string>('');

  // Shipping Receipt Print Modal State
  const [isBasketLabelModalOpen, setIsBasketLabelModalOpen] = useState(false);

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
      timestamp: string;
      items: OutboundItem[];
      totalQty: number;
      isPicked: boolean;
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
            timestamp: item.timestamp,
            items: [],
            totalQty: 0,
            isPicked: true,
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

  // Available unpicked orders for M Distribution
  // Otomatis mengecualikan order yang sudah berstatus isPicked maupun yang sudah diselesaikan pada batch lokal
  const unpickedOrders = useMemo(() => {
    return pendingOrders.filter(ord => !ord.isPicked && !distCompletedBatchRefs.includes(ord.referenceNumber));
  }, [pendingOrders, distCompletedBatchRefs]);

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
    const candidateOrders = pendingOrders.filter(ord => {
      if (ord.isPicked || combinedExcludedRefs.has(ord.referenceNumber)) return false;
      if (distShipVia === 'ALL') return true;
      return ord.courier?.toLowerCase() === distShipVia.toLowerCase();
    });

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
    basketBindingBusy.current = true; setIsBindingBasket(true);
    try {
      const result = await onUpdateOrderSession(distActiveBatchOrders.map(o => o.referenceNumber), {basketNumber:cleanBasket,pickingBy:currentUser?.fullName || 'Picker Staff',pickingStartedAt:new Date().toISOString()});
      if (!result) throw new Error('Server belum mengonfirmasi. Periksa data terbaru sebelum mengulang.');
      setDistActiveBatchOrders(prev => prev.map(order => ({...order,basketNumber:cleanBasket,items:result.orders.filter(o => o.referenceNumber === order.referenceNumber)})));
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

    // 1. Simpan perubahan ke orderHistory & potong stok untuk semua order di batch ini secara atomic
    const batchUpdates = ordersToFinalize.map(ord => ({
      refNum: ord.referenceNumber,
      updatedItems: ord.items.map(it => ({
        ...it,
        picked: true,
        pickedBy: currentUser?.fullName || 'Picker Staff',
        basketNumber: cleanBasket
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

    const currentPrefix = sortPackerPrefix.trim().toUpperCase() || 'A';
    const newSlots: SortBasketSlot[] = ordersToFinalize.slice(0, 20).map((ord, idx) => {
      const slotNum = idx + 1;
      const initialDecomp: { [itemId: string]: number } = {};
      ord.items.forEach(it => {
        initialDecomp[it.id] = 0;
      });

      return {
        slotNumber: slotNum,
        basketCode: `${currentPrefix}${slotNum}`,
        isBasketBound: true,
        order: {
          ...ord,
          basketNumber: cleanBasket,
          isPicked: true
        },
        itemsDecomposed: initialDecomp,
        isComplete: false
      };
    });

    setSortSlots(newSlots);
    setSortSelectedSlotNumber(1);
    setSortTargetSlotForBind(1);
    setSortBasketInputManual('');
    setSortNotification({ 
      type: 'success', 
      message: `✓ Batch Selesai! Keranjang Induk "${cleanBasket}" (${newSlots.length} pesanan) berhasil dimuat ke meja Sortir (${currentPrefix}1 s/d ${currentPrefix}${newSlots.length}).` 
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
      setCurrentScreen('distribution');
      playBuzzer(true);
      speakVoice(`Semua barang keranjang ${cleanBasket} selesai diambil. Silakan ambil tugas berikutnya.`);
      setTimeout(() => {
        distBasketInputRef.current?.focus();
      }, 100);
    } else {
      setCurrentScreen('sorting');
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
  const [bigBasketDisplay, setBigBasketDisplay] = useState(false);
  const [bigBasketResult, setBigBasketResult] = useState<{type:'success'|'error'; basket?:string} | null>(null);
  const [sortActiveMasterBasket, setSortActiveMasterBasket] = useState<string | null>(null);
  const [sortPackerPrefix, setSortPackerPrefix] = useState<string>('A'); // default prefix misal A, RR, B, PACKER-1
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

  useEffect(() => {
    if ((DEV_BASELINE_SORTING || (resolveSortingTarget && SERVER_SCAN_ENABLED)) && currentScreen === 'sorting' && !savingSort &&
        sortSlots.length > 0 && sortSlots.every(slot => slot.isBasketBound && slot.basketCode.trim())) {
      sortProductRef.current?.focus();
    }
  }, [resolveSortingTarget, currentScreen, savingSort, sortSlots]);

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
    setSortSlots(previous => previous.map(current => current.order.referenceNumber === slot.order.referenceNumber
      ? { ...current, basketCode: progress.basket, itemsDecomposed: counts,
          isComplete: progress.current && progress.counts.every(line => line.scanned === line.required) }
      : current));
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
  const handleApplyPackerPrefix = (prefixToUse?: string) => {
    if (sortStarted || sortSaveBusy.current) { setSortNotification({type:'error',message:'Keranjang tidak dapat diubah setelah sesi server dimulai.'}); return; }
    if (sortSlots.length === 0) {
      setSortNotification({ type: 'error', message: 'Muat tugas sortir terlebih dahulu sebelum mengatur keranjang packer!' });
      playBuzzer(false);
      return;
    }

    const cleanPrefix = (prefixToUse || sortPackerPrefix).trim().toUpperCase();
    if (!cleanPrefix) {
      setSortNotification({ type: 'error', message: 'Kode Packer tidak boleh kosong (misal: A, RR, P1)!' });
      playBuzzer(false);
      return;
    }

    const updated = sortSlots.map(s => ({
      ...s,
      basketCode: `${cleanPrefix}${s.slotNumber}`,
      isBasketBound: true
    }));

    setSortSlots(updated);
    setSortLastAssignedSlot(null);
    setBigBasketResult(null);
    setSortPackerPrefix(cleanPrefix);
    setSortNotification({ 
      type: 'success', 
      message: `✓ Berhasil mengatur keranjang Packer "${cleanPrefix}": ${updated[0].basketCode} s/d ${updated[updated.length - 1].basketCode}!` 
    });
    playBuzzer(true);
    speakVoice(`Keranjang packer ${cleanPrefix} dari satu sampai ${updated.length} terpasang.`);
    setTimeout(() => {
      sortProductRef.current?.focus();
    }, 100);
  };

  // Load task / master basket for sorting
  const handleLoadSortTask = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (sortSaveBusy.current || sortStarted) { setSortNotification({type:'error',message:'Selesaikan atau pulihkan sesi sortir sebelum memuat tugas lain.'}); return; }
    const query = sortTaskInput.trim().toUpperCase();
    if (!query) return;

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

    // Hanya muat keranjang atau nomor order yang benar-benar cocok.
    let matchingOrders = eligibleOrders.filter(ord =>
      ord.basketNumber?.toUpperCase() === query
    );

    if (matchingOrders.length === 0) {
      const singleMatch = eligibleOrders.find(ord =>
        ord.referenceNumber.toUpperCase() === query || 
        ord.orderId?.toUpperCase() === query
      );
      if (singleMatch) {
        matchingOrders = [singleMatch];
      }
    }


    if (matchingOrders.length > 0) {
      const ordersToDecompose = matchingOrders.slice(0, 20);
      const masterBasketName = query || ordersToDecompose[0].basketNumber || 'GB-01';
      setSortActiveMasterBasket(masterBasketName);

      // Inisialisasi 20 Slot Keranjang Sortir
      // Otomatis terapkan prefix packer saat ini (misal A1 s/d A20 atau RR1 s/d RR20)
      const currentPrefix = sortPackerPrefix.trim().toUpperCase() || 'A';
      const newSlots: SortBasketSlot[] = ordersToDecompose.map((ord, idx) => {
        const slotNum = idx + 1;
        const initialDecomp: { [itemId: string]: number } = {};
        ord.items.forEach(it => {
          initialDecomp[it.id] = 0;
        });

        return {
          slotNumber: slotNum,
          basketCode: `${currentPrefix}${slotNum}`, // misal A1, A2... atau RR1, RR2...
          isBasketBound: true, // langsung terikat otomatis dengan kode packer
          order: ord,
          itemsDecomposed: initialDecomp,
          isComplete: false
        };
      });

      setSortSlots(newSlots);
      setSortSelectedSlotNumber(1);
      if (clearSortingIndicatorOnSelection) setSortLastAssignedSlot(null);
      setBigBasketResult(null);
      setSortTargetSlotForBind(1);
      setSortBasketInputManual('');
      setSortNotification({ 
        type: 'success', 
        message: `Order berhasil dimuat (${newSlots.length} pesanan). Keranjang Packer "${currentPrefix}": ${newSlots[0].basketCode} s/d ${newSlots[newSlots.length - 1].basketCode} siap digunakan!` 
      });
      playBuzzer(true);
      speakVoice(`Order dimuat. Keranjang packer ${currentPrefix} siap.`);
      setTimeout(() => {
        sortPackerPrefixRef.current?.focus();
        sortPackerPrefixRef.current?.select();
      }, 100);
    } else {
      setSortNotification({ type: 'error', message: `Tidak ada pesanan aktif yang siap disortir untuk "${query}"!` });
      playBuzzer(false);
      speakVoice('Keranjang tidak ditemukan');
    }
  };

  const handleBaselineLoadSortTask = (e?: React.FormEvent) => {
    setSortLastAssignedSlot(null);
    setBigBasketResult(null);
    return handleLoadSortTask(e);
  };

  // Handler input / scan basket manual untuk slot tertentu (opsional jika ada basket pengganti)
  const handleBindSlotBasket = (slotNum: number, basketVal?: string) => {
    if (sortStarted || sortSaveBusy.current) { setSortNotification({type:'error',message:'Keranjang tidak dapat diubah setelah sesi server dimulai.'}); return; }
    const code = (basketVal !== undefined ? basketVal : sortBasketInputManual).trim().toUpperCase();
    if (!code) {
      setSortNotification({ type: 'error', message: 'Kode keranjang tidak boleh kosong!' });
      playBuzzer(false);
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
    setBigBasketResult(null);
    setSortBasketInputManual('');
    playBuzzer(true);
    speakVoice(`Slot ${slotNum} diubah ke keranjang ${code}`);

    const nextUnbound = updated.find(s => !s.isBasketBound);
    if (nextUnbound) {
      setSortTargetSlotForBind(nextUnbound.slotNumber);
      setSortNotification({ 
        type: 'success', 
        message: `✓ Slot #${slotNum} diikat ke keranjang "${code}". Selanjutnya Slot #${nextUnbound.slotNumber}.` 
      });
    } else {
      setSortNotification({ 
        type: 'success', 
        message: `✓ Semua ${updated.length} keranjang packer valid!` 
      });
    }
  };

  const handleBaselineSortScanProduct = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (sortSaveBusy.current) return;
    const barcode = sortProductInput.trim();
    if (!barcode) return;
    setSortLastAssignedSlot(null);
    setBigBasketResult(null);
    if (!sortSlots.length || !allBasketsBound) {
      setSortNotification({type:'error',message:!sortSlots.length ? 'Scan barcode tugas keranjang induk terlebih dahulu!' : 'Harap lengkapi nomor keranjang dahulu.'});
      playBuzzer(false);
      sortProductRef.current?.focus();
      return;
    }

    const matchedSkuId = findSkuId(barcode);
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
      setBigBasketResult({type:'error'});
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
      setBigBasketResult({type:'success',basket:target.basketCode});
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
    sortSaveBusy.current = true; setSavingSort(true); setSortStarted(true); setBigBasketResult(null);
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
      setBigBasketResult({type:'success',basket:progress.basket});
      setSortServerReady(true);
      setSortNotification({type:'success',message:`Scan dikonfirmasi server untuk keranjang ${progress.basket}.`});
      playBuzzer(true); speakVoice(`Masukkan ke keranjang ${progress.basket}`);
    } catch (error) {
      setSortProductInput('');
      setSortLastAssignedSlot(null);
      setBigBasketResult({type:'error'});
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
      setCurrentScreen('delivery');
      setSortSlots([]);
      setSortLastAssignedSlot(null);
      setBigBasketResult(null);
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
      setSortServerReady(false);
      setBigBasketResult(null);
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
  const [deliveryProductInput, setDeliveryProductInput] = useState<string>('');
  const deliveryProductRef = useRef<HTMLInputElement>(null);
  const [receiptOrder, setReceiptOrder] = useState<ShippingOrderData | null>(null);
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
    if (finishedOrder && autoPrintReceipt) {
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
      setReceiptOrder(orderToPrint);
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

  const handleLoadDeliveryBasket = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (deliveryBusyRef.current) return;
    const query = deliveryBasketInput.trim().toUpperCase();
    if (!query) return;

    if (!SERVER_SCAN_ENABLED) {
      const matchedOrder = pendingOrders.find(ord => 
        ord.basketNumber?.toUpperCase() === query ||
        ord.referenceNumber.toUpperCase() === query ||
        ord.orderId?.toUpperCase() === query ||
        (ord.orderNumber && ord.orderNumber.toUpperCase() === query)
      );
      if (!matchedOrder) {
        setDeliveryNotification({ type: 'error', message: `Order atau keranjang "${query}" tidak ditemukan di antrean pending.` });
        playBuzzer(false);
        return;
      }
      setDeliveryActiveRef(matchedOrder.referenceNumber);
      const initCounts: { [itemId: string]: number } = {};
      matchedOrder.items.forEach(it => { initCounts[it.id] = 0; });
      setDeliveryScannedCounts(initCounts);
      setDeliveryReady(true);
      setDeliveryFinished(false);
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
    const matchedOrder = pendingOrders.find(ord => 
      ord.basketNumber?.toUpperCase() === query ||
      ord.referenceNumber.toUpperCase() === query ||
      ord.orderId?.toUpperCase() === query
    );
    if (!matchedOrder || !matchedOrder.basketNumber?.trim()) {
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

  // Auto-complete & print receipt whenever all items are 100% validated
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
        executeCompleteDelivery(deliveryActiveOrder, deliveryScannedCounts);
      }, 250);
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
        setDeliveryNotification({ type: 'success', message: '✓ Seluruh barang lengkap (100%)! Menyelesaikan packing dan mencetak resi...' });
        speakVoice('Semua barang lengkap. Menyelesaikan packing.');
        await executeCompleteDelivery(deliveryActiveOrder, nextCounts);
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
      if (progress.counts.every(line => line.scanned >= line.required)) {
        speakVoice('Semua barang lengkap. Menyelesaikan packing.');
        const finishProgress = await controller.finish(deliveryTask.basket);
        applyDeliveryProgress(deliveryTask, finishProgress);
        await verifyDeliveryCompletion(deliveryTask, finishProgress);
      }
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
      const isComplete = deliveryActiveOrder.items.every(it => (deliveryScannedCounts[it.id] || 0) >= it.qty);
      if (!isComplete) {
        if (!window.confirm('Perhatian: Masih ada barang yang belum discan 100%. Apakah Anda yakin ingin menyelesaikan packing sekarang?')) {
          return;
        }
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

  return (
    <div className="wms-picking-flow space-y-4 font-sans text-slate-800 bg-[#F4F6F9] p-3 sm:p-5 rounded-2xl border border-slate-300 shadow-xl">
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
              onClick={() => setCurrentScreen('distribution')}
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
              onClick={() => setCurrentScreen('sorting')}
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
            </button>
          )}

          {(!isPickerRole) && (
            <button
              onClick={() => setCurrentScreen('delivery')}
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
              {pendingOrders.filter(o => o.isPicked).length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-emerald-500 text-white rounded-full text-[10px] font-black">
                  {pendingOrders.filter(o => o.isPicked).length}
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

          {/* Basket Label Generator Shortcut */}
          <button
            onClick={() => setIsBasketLabelModalOpen(true)}
            className="px-2.5 py-1.5 text-xs font-bold bg-amber-500/10 hover:bg-amber-500/20 text-amber-800 border border-amber-300 rounded-lg flex items-center gap-1 shrink-0"
            title="Cetak Label Keranjang 4x6"
          >
            <Printer className="w-3.5 h-3.5 text-amber-600" />
            <span className="hidden md:inline">Cetak Label Basket (4x6)</span>
          </button>
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
                distActiveBatchOrders.length > 0 && !distBoundBasket 
                  ? 'border-amber-500 ring-2 ring-amber-300 shadow-md animate-pulse' 
                  : 'border-slate-300'
              }`}
            >
              <span className={`px-2.5 py-1.5 font-bold border-r ${
                distActiveBatchOrders.length > 0 && !distBoundBasket 
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
                disabled={isBindingBasket}
                className={`px-3 py-1.5 font-black border-l cursor-pointer transition-all ${
                  distActiveBatchOrders.length > 0 && !distBoundBasket
                    ? 'bg-amber-500 hover:bg-amber-600 text-slate-950 border-amber-400'
                    : 'bg-sky-50 text-sky-700 hover:bg-sky-100 border-slate-300'
                }`}
              >
                {isBindingBasket ? 'Menyimpan…' : 'Ikat'}
              </button>
            </form>

            {/* Notification alert (DIPERBESAR JIKA ERROR KARENA TANPA SPEAKER) */}
            {distNotification && (
              distNotification.type === 'error' ? (
                <div className="w-full bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white border-4 border-rose-950 rounded-xl p-3.5 sm:p-4 shadow-2xl animate-bounce flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-white text-rose-600 flex items-center justify-center font-black text-xl shrink-0 shadow-lg ring-4 ring-rose-300">
                      ✕
                    </div>
                    <div>
                      <div className="text-[11px] font-black uppercase tracking-wider text-rose-100 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-white animate-ping"></span>
                        PERINGATAN SALAH SCAN PICKING (CEK VISUAL):
                      </div>
                      <div className="text-sm sm:text-base md:text-lg font-black text-white leading-tight drop-shadow-sm mt-0.5">
                        {distNotification.message}
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={() => setDistNotification(null)} 
                    className="px-3 py-1.5 bg-black/40 hover:bg-black/60 text-white font-bold rounded-lg text-xs cursor-pointer shrink-0 transition-colors border border-white/20"
                    title="Tutup Peringatan"
                  >
                    TUTUP (✕)
                  </button>
                </div>
              ) : (
                <div className={`w-full text-xs sm:text-sm font-bold px-3.5 py-2.5 rounded-lg flex items-center justify-between shadow-sm ${
                  distNotification.type === 'success' 
                    ? 'bg-emerald-500 text-white border-2 border-emerald-600' 
                    : 'bg-blue-600 text-white border-2 border-blue-700'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className="text-base">{distNotification.type === 'success' ? '✓' : 'ℹ'}</span>
                    <span>{distNotification.message}</span>
                  </div>
                  <button onClick={() => setDistNotification(null)} className="text-white hover:text-slate-200 cursor-pointer p-1">
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
                              onClick={() => setCurrentScreen('sorting')}
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
                            onClick={() => setCurrentScreen('sorting')}
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
                              <span className="font-black text-slate-700">{grp.skuId}</span>
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
                                <span>{grp.skuId}</span>
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
      {currentScreen === 'sorting' && (
        <div className="space-y-3">
          {DEV_BASELINE_SORTING ? <div role="status" className="p-3 bg-amber-100 text-amber-900 font-bold">Mode sortir baseline untuk pengujian development lokal. Scan belum divalidasi server; jangan gunakan untuk operasional.</div> :
            SERVER_SCAN_ENABLED && !sortServerReady && <div role="alert" className="p-3 bg-amber-100 text-amber-900 font-bold">{scanServerUnavailable}</div>}
          {/* Green Tips Box (Exact Mabang) */}
          <div className="wms-info-panel bg-[#E7F6E7] border border-[#BDE5BD] text-[#2F6F2F] text-xs p-3 rounded-lg leading-relaxed shadow-sm">
            <span className="font-bold">Tips Sortir 20 Keranjang! </span>
            <span>1. Scan nomor keranjang induk (contoh: GB-01) untuk memuat batch pesanan. &nbsp;&nbsp;</span>
            <span>2. Sistem otomatis memecah pesanan ke dalam 20 basket (B-01 s/d B-20). &nbsp;&nbsp;</span>
            <span className="text-[#D32F2F] font-bold">{useBaselineSort ? '3. Scan barcode; sistem menentukan basket tujuan otomatis.' : resolveSortingTarget ? '3. Scan barcode; server menentukan basket tujuan.' : '3. Pilih basket tujuan, lalu scan barcode produk untuk divalidasi server.'}</span>
          </div>

          {/* Action & Scan Bar */}
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex flex-wrap items-center gap-3">
            {/* 1. Muat Induk */}
            <form onSubmit={useBaselineSort ? handleBaselineLoadSortTask : handleLoadSortTask} className="flex items-center text-xs border border-slate-300 rounded-md overflow-hidden bg-white">
              <span className="px-2.5 py-1.5 bg-slate-100 text-slate-600 border-r border-slate-300 font-bold">1. Muat Induk</span>
              <input
                ref={sortTaskInputRef}
                type="text"
                placeholder="Pindai keranjang induk (contoh GB-01)..."
                value={sortTaskInput}
                onChange={e => setSortTaskInput(e.target.value)}
                className="px-2.5 py-1.5 text-xs outline-none w-44 sm:w-52 text-slate-800 focus:ring-1 focus:ring-sky-500"
              />
              <button type="submit" className="px-2.5 py-1.5 bg-sky-50 text-sky-700 font-bold border-l border-slate-300 hover:bg-sky-100">
                Muat Order
              </button>
            </form>

            {/* 2. KONTROL KODE KERANJANG PACKER (misal A -> A1-A20, RR -> RR1-RR20) */}
            <div className="flex items-center text-xs border-2 border-indigo-400 bg-indigo-50/60 rounded-md overflow-hidden shadow-sm">
              <span className="px-2.5 py-1.5 bg-indigo-600 text-white font-black">
                2. Kode Packer
              </span>
              <input
                ref={sortPackerPrefixRef}
                type="text"
                placeholder="contoh A atau RR"
                value={sortPackerPrefix}
                onChange={e => setSortPackerPrefix(e.target.value.toUpperCase())}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleApplyPackerPrefix();
                  }
                }}
                className="px-2 py-1.5 text-xs font-black font-mono w-20 text-center uppercase bg-white outline-none text-indigo-950 focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={() => handleApplyPackerPrefix()}
                className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold cursor-pointer"
                title={`Terapkan kode ${sortPackerPrefix}1 s/d ${sortPackerPrefix}20 ke semua slot`}
              >
                Setel ({sortPackerPrefix || 'A'}1-{sortPackerPrefix || 'A'}20)
              </button>
            </div>

            {/* Scan Product Form (Aktif jika seluruh keranjang sudah diikat) */}
            <form onSubmit={useBaselineSort ? handleBaselineSortScanProduct : handleSortScanProduct} className={`wms-scan-field flex items-center text-xs border rounded-md overflow-hidden bg-white ${
              allBasketsBound 
                ? 'border-emerald-400 ring-2 ring-emerald-200' 
                : 'border-slate-300 opacity-60'
            }`}>
              <span className={`px-2.5 py-1.5 font-bold text-white ${allBasketsBound ? 'bg-emerald-600' : 'bg-slate-400'}`}>
                3. Scan Produk
              </span>
              <input
                type="text"
                placeholder={allBasketsBound ? "Tembak barcode SKU untuk sortir..." : "Wajib input basket dulu..."}
                ref={sortProductRef}
                value={sortProductInput}
                onChange={e => setSortProductInput(e.target.value)}
                disabled={savingSort || !allBasketsBound}
                className="px-2.5 py-1.5 text-xs outline-none w-48 sm:w-56 text-slate-800"
              />
            </form>

            {/* Selesaikan sortir Button */}
            <button
              onClick={useBaselineSort ? handleBaselineEndSorting : handleEndSorting}
              disabled={useBaselineSort
                ? savingSort || sortSlots.length === 0 || !allBasketsBound || sortSlots.some(s=>!s.isComplete)
                : !SERVER_SCAN_ENABLED || !sortServerReady || savingSort || sortSlots.length === 0 || !allBasketsBound || sortSlots.some(s=>!s.isComplete)}
              className={`px-4 py-1.5 text-xs font-bold rounded-md flex items-center gap-1.5 shadow-sm transition-all cursor-pointer ${
                sortSlots.length > 0 && allBasketsBound
                  ? 'bg-[#52C41A] hover:bg-emerald-600 text-white'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }`}
            >
              <Check className="w-3.5 h-3.5" />
              <span>{savingSort?'Menyimpan sortir…':'Selesaikan sortir'}</span>
            </button>
            {!useBaselineSort && <button type="button" onClick={handleRecoverSorting}
              disabled={!SERVER_SCAN_ENABLED || savingSort || sortSlots.length === 0}
              className="px-3 py-1.5 text-xs font-bold rounded-md bg-sky-700 text-white disabled:bg-slate-300">
              Pulihkan sesi
            </button>}
            <button type="button" onClick={() => { setBigBasketDisplay(value => !value); if (useBaselineSort && allBasketsBound) sortProductRef.current?.focus(); }}
              aria-pressed={bigBasketDisplay}
              className="px-3 py-1.5 text-xs font-bold rounded-md bg-slate-700 text-white">
              BIG BASKET {bigBasketDisplay ? 'ON' : 'OFF'}
            </button>

            {/* Last Assigned Indicator */}
            {sortLastAssignedSlot && (
              <div className="animate-pulse bg-amber-400 text-slate-950 px-3 py-1 rounded-md text-xs font-black ml-auto">
                👉 Masukkan ke Keranjang: {sortSlots.find(s => s.slotNumber === sortLastAssignedSlot)?.basketCode}
              </div>
            )}

            {bigBasketDisplay && bigBasketResult && (
              <div role="status" aria-live="polite"
                className={`w-full rounded-xl p-6 text-center font-black text-white ${bigBasketResult.type === 'success' ? 'bg-green-700' : 'bg-red-700'}`}>
                <div className="text-xl">{bigBasketResult.type === 'success' ? 'MASUKKAN KE KERANJANG' : 'SCAN GAGAL / BELUM TERKONFIRMASI'}</div>
                <div className="text-6xl sm:text-8xl break-all">{bigBasketResult.type === 'success' ? bigBasketResult.basket : '✕'}</div>
              </div>
            )}

            {/* Notification alert (DIPERBESAR KHUSUSNYA JIKA ERROR / SALAH SCAN KARENA TANPA SPEAKER) */}
            {sortNotification && (
              sortNotification.type === 'error' ? (
                <div className="w-full bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white border-4 border-rose-950 rounded-xl p-3.5 sm:p-4 shadow-2xl animate-bounce flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-white text-rose-600 flex items-center justify-center font-black text-xl shrink-0 shadow-lg ring-4 ring-rose-300">
                      ✕
                    </div>
                    <div>
                      <div className="text-[11px] font-black uppercase tracking-wider text-rose-100 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-white animate-ping"></span>
                        PERINGATAN SALAH SCAN PRODUK (CEK VISUAL):
                      </div>
                      <div className="text-sm sm:text-base md:text-lg font-black text-white leading-tight drop-shadow-sm mt-0.5">
                        {sortNotification.message}
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={() => setSortNotification(null)} 
                    className="px-3 py-1.5 bg-black/40 hover:bg-black/60 text-white font-bold rounded-lg text-xs cursor-pointer shrink-0 transition-colors border border-white/20"
                    title="Tutup Peringatan"
                  >
                    TUTUP (✕)
                  </button>
                </div>
              ) : (
                <div className={`w-full text-xs sm:text-sm font-bold px-3.5 py-2.5 rounded-lg flex items-center justify-between shadow-sm ${
                  sortNotification.type === 'success' 
                    ? 'bg-emerald-500 text-white border-2 border-emerald-600' 
                    : 'bg-blue-600 text-white border-2 border-blue-700'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className="text-base">{sortNotification.type === 'success' ? '✓' : 'ℹ'}</span>
                    <span>{sortNotification.message}</span>
                  </div>
                  <button onClick={() => setSortNotification(null)} className="text-white hover:text-slate-200 cursor-pointer p-1">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )
            )}
          </div>

          {/* Visual Matrix: 20 Basket Slots Grid */}
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between text-xs font-bold text-slate-700 border-b border-slate-200 pb-2">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-sky-600" />
                <span>Matriks Sortir: 20 Slot Keranjang Pesanan ({sortSlots.filter(s => s.isComplete).length} / {sortSlots.length || 20} Lengkap)</span>
                {sortActiveMasterBasket && (
                  <span className="px-2 py-0.5 bg-sky-100 text-sky-800 rounded font-mono font-bold">
                    Induk: {sortActiveMasterBasket}
                  </span>
                )}
                {!allBasketsBound && sortSlots.length > 0 && (
                  <span className="px-2 py-0.5 bg-amber-100 text-amber-900 border border-amber-300 rounded font-bold text-[11px] animate-pulse">
                    ⚠ Wajib Input Basket ({sortSlots.filter(s => s.isBasketBound).length} / {sortSlots.length} Terikat)
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-amber-100 border border-amber-300 inline-block"></span>
                  <span>Menunggu sortir</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-[#52C41A] inline-block"></span>
                  <span>Sortir lengkap</span>
                </span>
              </div>
            </div>

            {sortSlots.length === 0 ? (
              <div className="py-16 text-center text-slate-400 space-y-2">
                <div className="w-14 h-14 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                  <Layers className="w-8 h-8" />
                </div>
                <p className="text-sm font-bold text-slate-500">Keranjang Induk Belum Dimuat !</p>
                <p className="text-xs text-slate-400 font-mono">Scan barcode keranjang induk di atas untuk memecah ke 20 basket </p>
                <button
                  onClick={() => DEV_BASELINE_SORTING ? handleBaselineLoadSortTask() : handleLoadSortTask()}
                  disabled={!sortTaskInput.trim()}
                  className="mt-3 px-4 py-2 text-xs font-bold bg-sky-500 hover:bg-sky-600 text-white rounded-lg shadow-sm"
                >
                  Muat keranjang induk yang dipindai
                </button>
              </div>
            ) : (
              /* DUAL PANEL LAYOUT: KIRI KOTAK BASKET RINGKAS (HURUF BESAR) + KANAN DESKRIPSI ISI PRODUK */
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                
                {/* 1. PANEL KIRI: 20 KOTAK BASKET KECIL / COMPACT DENGAN HURUF/KODE BESAR (8 Kolom) */}
                <div className="lg:col-span-7 xl:col-span-8 space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-slate-500 px-1 font-medium">
                    <span>💡 Klik kotak basket untuk melihat rincian isi produk di panel kanan:</span>
                    <span className="font-bold text-sky-600">Terpilih: {sortSlots.find(s => s.slotNumber === (sortSelectedSlotNumber || 1))?.basketCode || `Slot #${sortSelectedSlotNumber || 1}`}</span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2.5">
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
                            if (clearSortingIndicatorOnSelection) setSortLastAssignedSlot(null);
                          }}
                          className={`p-2.5 rounded-xl border-2 transition-all cursor-pointer select-none text-center relative flex flex-col justify-between ${
                            isSelected
                              ? 'border-indigo-600 bg-indigo-50/80 shadow-md ring-2 ring-indigo-400/50 scale-[1.02] z-10'
                              : isAssigned
                              ? 'border-sky-500 bg-sky-50 shadow-md ring-2 ring-sky-300 animate-pulse'
                              : slot.isComplete
                              ? 'border-emerald-500 bg-emerald-50/90 hover:bg-emerald-100/80'
                              : !slot.isBasketBound
                              ? 'border-amber-400 bg-amber-50/60 hover:bg-amber-100/60'
                              : 'border-slate-300 bg-white hover:border-sky-400 hover:bg-slate-50 shadow-xs'
                          }`}
                        >
                          {/* Top badge baris kecil */}
                          <div className="flex items-center justify-between text-[10px] leading-none mb-1">
                            <span className="font-bold text-slate-500 font-mono">#{slot.slotNumber}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${
                              slot.isComplete
                                ? 'bg-emerald-600 text-white'
                                : slot.isBasketBound
                                ? 'bg-amber-200 text-amber-950'
                                : 'bg-rose-100 text-rose-700'
                            }`}>
                              {slot.isComplete ? '✓ Selesai' : slot.isBasketBound ? `${currentDecomp}/${totalItems}` : 'Belum'}
                            </span>
                          </div>

                          {/* KODE KERANJANG BESAR (HURUF DIPERBESAR SESUAI PERMINTAAN) */}
                          <div className="py-1">
                            <div className={`text-2xl sm:text-3xl font-black font-mono tracking-tight leading-none ${
                              slot.isComplete
                                ? 'text-emerald-700'
                                : isSelected
                                ? 'text-indigo-900'
                                : isAssigned
                                ? 'text-sky-700'
                                : 'text-slate-900'
                            }`}>
                              {slot.basketCode || `B-${String(slot.slotNumber).padStart(2, '0')}`}
                            </div>
                            <div className="text-[10px] font-bold text-slate-600 mt-1 truncate" title={slot.order.customerName}>
                              {slot.order.customerName}
                            </div>
                          </div>

                          {/* Bottom compact status bar */}
                          <div className="pt-1.5 border-t border-slate-200/80 flex items-center justify-between text-[10px] font-mono leading-none">
                            <span className="text-slate-500 text-[9px]">{new Set(slot.order.items.map(i=>i.skuId)).size} SKU unik · {slot.order.items.length} baris</span>
                            <span className={`font-black ${slot.isComplete ? 'text-emerald-700' : 'text-amber-700'}`}>
                              {currentDecomp}/{totalItems} pcs
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 2. PANEL KANAN: DESKRIPSI ISI PRODUK PER BASKET (Sticky & Responsif) (4 Kolom / 5 Kolom) */}
                <div className="lg:col-span-5 xl:col-span-4 bg-slate-900 text-white rounded-xl border border-slate-800 p-4 shadow-xl sticky top-20">
                  {(() => {
                    const activeSlot = sortSlots.find(s => s.slotNumber === (sortSelectedSlotNumber || 1)) || sortSlots[0];
                    if (!activeSlot) return null;

                    const totalItems = activeSlot.order.totalQty;
                    const currentDecomp = Object.values(activeSlot.itemsDecomposed).reduce((a, b) => a + b, 0);
                    const remainingPcs = totalItems - currentDecomp;

                    return (
                      <div className="space-y-3.5">
                        {/* Header Panel Kanan: Keranjang Terpilih */}
                        <div className="border-b border-slate-800 pb-3 flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-400 border border-indigo-500/40 rounded text-[10px] font-mono font-bold">
                                Slot #{activeSlot.slotNumber}
                              </span>
                              <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                                activeSlot.isComplete 
                                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                                  : 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse'
                              }`}>
                                {activeSlot.isComplete ? '✓ Lengkap / Siap Packing' : `Kurang ${remainingPcs} pcs`}
                              </span>
                            </div>
                            <h3 className="text-2xl font-black font-mono text-white mt-1 flex items-baseline gap-2">
                              <span>Keranjang:</span>
                              <span className="text-sky-400 text-3xl font-extrabold">{activeSlot.basketCode}</span>
                            </h3>
                          </div>

                          <div className="text-right">
                            <span className="text-[10px] text-slate-400 block uppercase font-bold">Total Kuantitas</span>
                            <div className="font-mono text-lg font-black text-white">
                              <span className={activeSlot.isComplete ? 'text-emerald-400' : 'text-amber-400'}>
                                {currentDecomp}
                              </span>
                              <span className="text-slate-500 text-sm"> / {totalItems} pcs</span>
                            </div>
                          </div>
                        </div>

                        {/* Info Pelanggan & Order */}
                        <div className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-2.5 text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-slate-400 text-[11px]">Pelanggan:</span>
                            <span className="font-bold text-white truncate max-w-[200px]">{activeSlot.order.customerName}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-slate-400 text-[11px]">No. Order / Ref:</span>
                            <span className="font-mono text-sky-400 text-[11px] truncate max-w-[200px]">{activeSlot.order.referenceNumber}</span>
                          </div>
                          {activeSlot.order.courier && (
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400 text-[11px]">Ekspedisi:</span>
                              <span className="font-semibold text-slate-300 text-[11px]">{activeSlot.order.courier}</span>
                            </div>
                          )}
                        </div>

                        {/* DAFTAR DESKRIPSI ISI PRODUK PER BASKET */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs font-bold text-slate-300 px-0.5">
                            <span className="flex items-center gap-1.5">
                              <Package className="w-3.5 h-3.5 text-sky-400" />
                              <span>Deskripsi Isi Produk ({new Set(activeSlot.order.items.map(i=>i.skuId)).size} SKU unik · {activeSlot.order.items.length} baris):</span>
                            </span>
                            <span className="text-[10px] text-slate-500 font-mono">Pindai barcode</span>
                          </div>

                          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin">
                            {activeSlot.order.items.map((it, idx) => {
                              const scanned = activeSlot.itemsDecomposed[it.id] || 0;
                              const isItemDone = scanned >= it.qty;
                              const barcode = getBarcodeForSku(it.skuId);

                              return (
                                <div
                                  key={it.id || idx}
                                  className={`p-2.5 rounded-xl border transition-all ${
                                    isItemDone
                                      ? 'bg-emerald-950/40 border-emerald-500/40 text-slate-200'
                                      : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:border-slate-700'
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="px-1.5 py-0.5 bg-sky-500/20 text-sky-300 border border-sky-500/30 rounded font-mono font-bold text-xs">
                                          {it.skuId}
                                        </span>
                                        {barcode && (
                                          <span className="text-[10px] text-slate-400 font-mono">
                                            ({barcode})
                                          </span>
                                        )}
                                      </div>
                                      <p className="text-xs font-semibold text-white mt-1 leading-snug break-words">
                                        {it.skuName}
                                      </p>
                                      {it.location && (
                                        <div className="text-[10px] text-amber-400 mt-1 font-mono">
                                          Rak: {it.location} {it.expiredDate ? `• Exp: ${it.expiredDate}` : ''}
                                        </div>
                                      )}
                                    </div>

                                    {/* Kolom Kuantitas Per SKU */}
                                    <div className="text-right shrink-0">
                                      <div className={`font-mono text-sm font-black px-2 py-1 rounded-md ${
                                        isItemDone
                                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                      }`}>
                                        {scanned} / {it.qty} <span className="text-[9px] font-normal">pcs</span>
                                      </div>
                                      <div className="text-[9px] mt-1 font-bold">
                                        {isItemDone ? (
                                          <span className="text-emerald-400">✓ Lengkap</span>
                                        ) : (
                                          <span className="text-amber-400">Kurang {it.qty - scanned}</span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Quick Manual Put 1x Button (Memudahkan jika tanpa scanner barcode) */}
                        <div className="pt-2 border-t border-slate-800">
                          <button
                            type="button"
                            disabled
                            title="Validasi manual dinonaktifkan."
                            className={`w-full py-2 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                              activeSlot.isComplete
                                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm active:scale-98'
                            }`}
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>{activeSlot.isComplete ? 'Keranjang Ini Sudah Lengkap' : '+ Masukkan 1 Pcs ke Keranjang Ini'}</span>
                          </button>
                        </div>

                      </div>
                    );
                  })()}
                </div>

              </div>
            )}
          </div>
        </div>
      )}

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
            <div className="flex items-center text-xs border border-slate-300 rounded-md overflow-hidden bg-white">
              <span className="px-2.5 py-1.5 bg-slate-100 text-slate-600 border-r border-slate-300">Berat paket</span>
              <input
                type="number"
                placeholder="0"
                value={deliveryWeight}
                onChange={e => setDeliveryWeight(e.target.value)}
                className="px-2 py-1.5 text-xs outline-none w-20 text-slate-800 text-center font-bold"
              />
              <span className="px-2.5 py-1.5 bg-sky-500 text-white font-bold">/g</span>
            </div>

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
              <button
                onClick={() => handleCompleteDelivery()}
                disabled={deliveryBusy || !deliveryReady || !deliveryActiveOrder}
                className={`px-4 py-1.5 text-xs font-bold rounded-md flex items-center gap-1.5 shadow-sm transition-all cursor-pointer ${
                  deliveryActiveOrder
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
                <div className="w-full bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white border-4 border-rose-950 rounded-xl p-3.5 sm:p-4 shadow-2xl animate-bounce flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-white text-rose-600 flex items-center justify-center font-black text-xl shrink-0 shadow-lg ring-4 ring-rose-300">
                      ✕
                    </div>
                    <div>
                      <div className="text-[11px] font-black uppercase tracking-wider text-rose-100 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-white animate-ping"></span>
                        PERINGATAN SALAH SCAN PACKING (CEK VISUAL):
                      </div>
                      <div className="text-sm sm:text-base md:text-lg font-black text-white leading-tight drop-shadow-sm mt-0.5">
                        {deliveryNotification.message}
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={() => setDeliveryNotification(null)} 
                    className="px-3 py-1.5 bg-black/40 hover:bg-black/60 text-white font-bold rounded-lg text-xs cursor-pointer shrink-0 transition-colors border border-white/20"
                    title="Tutup Peringatan"
                  >
                    TUTUP (✕)
                  </button>
                </div>
              ) : (
                <div className={`w-full text-xs sm:text-sm font-bold px-3.5 py-2.5 rounded-lg flex items-center justify-between shadow-sm ${
                  deliveryNotification.type === 'success' 
                    ? 'bg-emerald-500 text-white border-2 border-emerald-600' 
                    : 'bg-blue-600 text-white border-2 border-blue-700'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className="text-base">{deliveryNotification.type === 'success' ? '✓' : 'ℹ'}</span>
                    <span>{deliveryNotification.message}</span>
                  </div>
                  <button onClick={() => setDeliveryNotification(null)} className="text-white hover:text-slate-200 cursor-pointer p-1">
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
              <span>Keranjang sortir: <b className="text-emerald-600 font-mono">{deliveryActiveOrder?.basketNumber || '--'}</b> ;</span>
              <span>Picker: <b className="text-slate-900">{deliveryActiveOrder?.pickedBy || '--'}</b> ;</span>
              <span>Toko: <b className="text-slate-900">{deliveryActiveOrder?.shopName || '--'}</b> ;</span>
            </div>
          </div>

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
                              <span>{item.skuId}</span>
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
                              onClick={async () => {
                                if (isComplete || !deliveryActiveOrder || deliveryBusyRef.current) return;
                                const nextCounts = { ...deliveryScannedCounts, [item.id]: (deliveryScannedCounts[item.id] || 0) + 1 };
                                setDeliveryScannedCounts(nextCounts);
                                playBuzzer(true);
                                speakVoice(`Validasi ${item.skuId}`);
                                const allPacked = deliveryActiveOrder.items.every(it => (nextCounts[it.id] || 0) >= it.qty);
                                if (allPacked) {
                                  setDeliveryNotification({ type: 'success', message: '✓ Seluruh barang lengkap (100%)! Menyelesaikan packing dan mencetak resi...' });
                                  speakVoice('Semua barang lengkap. Menyelesaikan packing.');
                                  await executeCompleteDelivery(deliveryActiveOrder, nextCounts);
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

      {receiptOrder && (
        <ShippingReceiptModal
          isOpen={true}
          onClose={() => {
            setReceiptOrder(null);
            setTimeout(() => {
              deliveryBasketInputRef.current?.focus();
            }, 100);
          }}
          order={receiptOrder}
          currentUser={currentUser}
          autoPrint={autoPrintReceipt}
        />
      )}
    </div>
  );
}
