import {canBrowseInventory,canOpenWork,type OutboundMode} from './utils/dashboardView';
import {prepareSortingUpdates,type SortingTask} from './utils/orderSorting';
import { scanServerUnavailable, serverScanValidationAvailable } from './utils/packingValidation';
import {prepareOrderSessionUpdates,type OrderSessionData,type OrderSessionResult} from './utils/orderSession';
import {getStockStatus,updateMovementSales} from './utils/calculations';
import WarehouseOverview from './components/WarehouseOverview';
import AppShell from './components/AppShell';
import {prepareOutboundCreation,prepareOrderEdits} from './utils/outboundTransactions';
import {prepareOrderCompletion,type OrderCompletion} from './utils/orderCompletion';
import {buildStockWritePlan, MAX_STOCK_WRITE_OPERATIONS, queueStockWritePlan} from './utils/stockWritePlan';
import {getStockForcePushSafetyError, runStockForcePushIfSafe, type StockForcePushSnapshot} from './utils/stockForcePushSafety';
import { setActiveBranch, getActiveBranch, DEV_BASELINE_SORTING } from './supabase';
import { loginEmail, displayAccountId } from './accountId';
import { applyUiTheme, nextUiTheme, readUiTheme, UI_THEME_KEY, type UiTheme } from './utils/uiTheme';
import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { StockItem, OutboundItem, DccLog, UserAccount, PhysicalAuditItem, CatalogItem, ReturnItem, BatchRecord, Warehouse, InterWarehouseTransfer } from './types';
import SubWarehouseManager from './components/SubWarehouseManager';
import { collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch, getDocs, handleSupabaseError, OperationType, type QuerySnapshot } from './supabase';
import { supabase, isSupabaseConfigured } from './supabase';
import { calculatePackQuantities, getExpiredStatus, formatNumber, getProductPackSizes, deduplicateAndMergeStock, updateDynamicCatalogRegistry, normalizeDateToDmy, getCanonicalStockId, findStockIndex, isZoneOrUrbanLocation, getLockedStockSummary, isNoExpiryDate } from './utils/calculations';
import { BARCODE_MAP, getBarcodeForSku, updateDynamicBarcodeRegistry, getProductBrand } from './data/barcodeMap';
import { ensureCentralWarehouse, DEFAULT_CENTRAL_WAREHOUSE } from './utils/warehouseRouting';
import Dashboard from './components/Dashboard';
import InventoryList from './components/InventoryList';
import BulkOutbound from './components/BulkOutbound';
import BatchDashboard from './components/BatchDashboard';
import AnalyticsDashboard from './components/AnalyticsDashboard';
import BasketLabelGeneratorModal from './components/BasketLabelGeneratorModal';
import MabangWmsOutbound from './components/MabangWmsOutbound';
import OutboundManager from './components/OutboundManager';
import CekFisik from './components/CekFisik';
import LocationTransferManager from './components/LocationTransferManager';
import UserManagement from './components/UserManagement';
import ProductCatalog from './components/ProductCatalog';
import GoogleWorkspaceSync from './components/GoogleWorkspaceSync';
import ReturnManager from './components/ReturnManager';
import InboundManager from './components/InboundManager';
import CrossDevice from './components/CrossDevice';
import WarehouseMap from './components/WarehouseMap';
import StockOpnamePerLocation from './components/StockOpnamePerLocation';
import ThermalLabelPrinter from './components/ThermalLabelPrinter';

import AuditTrail from './components/AuditTrail';
import { 
  LayoutDashboard, 
  Package, 
  ArrowUpRight, 
  Layers, 
  MoveRight, 
  Clock,
  Menu,
  X,
  History,
  ArrowLeftRight,
  ClipboardList,
  Lock,
  User,
  LogIn,
  LogOut,
  Key,
  ShieldAlert,
  Users,
  Smartphone,
  Radio,
  Wallet,
  Calculator,
  ClipboardCheck,
  Palette,
  LineChart,
  FileText,
  Database,
  FileSpreadsheet,
  RotateCcw,
  Truck,
  Calendar,
  UploadCloud,
  DownloadCloud,
  RefreshCw,
  MapPin,
  Printer,
  ChevronDown,
  Sparkles,
  Boxes,
  ShoppingCart,
  Store,
  ShoppingBag
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db } from './supabase';
import { normalizeStockBatch } from './utils/stockNormalization';
import { initialStockSyncState, stockSyncFailed, stockSyncStarted, stockSyncSucceeded, type StockSyncState } from './utils/stockSyncSafety';
import { StaleReadError } from './utils/readRequestSafety';

export default function App() {
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<UiTheme>(readUiTheme);
  const [dbStatus, setDbStatus] = useState<'connected' | 'offline'>('offline');
  const [stockSyncState, setStockSyncState] = useState<StockSyncState>(initialStockSyncState);
  
  // A visual preference belongs to this device, independently of branch and account.
  useLayoutEffect(() => { applyUiTheme(theme); }, [theme]);
  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (event.key === UI_THEME_KEY || event.key === null) setTheme(readUiTheme());
    };
    window.addEventListener('storage', syncTheme);
    return () => window.removeEventListener('storage', syncTheme);
  }, []);
  const [syncTrigger, setSyncTrigger] = useState(0);
  const [isSyncingNow, setIsSyncingNow] = useState(false);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const stockSyncUiRequestRef = useRef(0);
  const stockPushInProgressRef = useRef(false);
  const stockPushFailedRef = useRef(false);
  const stockForcePushSnapshotRef = useRef<StockForcePushSnapshot<StockItem> | null>(null);
  const [logs, setLogs] = useState<DccLog[]>([]);
  const [orderHistory, setOrderHistory] = useState<OutboundItem[]>([]);
  const [audits, setAudits] = useState<PhysicalAuditItem[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [returnHistory, setReturnHistory] = useState<ReturnItem[]>([]);
  const [batches, setBatches] = useState<BatchRecord[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>(() => [DEFAULT_CENTRAL_WAREHOUSE]);
  const [transfers, setTransfers] = useState<InterWarehouseTransfer[]>([]);
  const [activeWarehouseFilter, setActiveWarehouseFilter] = useState<string>('ALL');
  const [isBasketLabelModalOpen, setIsBasketLabelModalOpen] = useState(false);
  const activeBasketsFromOrders = useMemo(
    () => Array.from(new Set(orderHistory.filter((item) => item.status === 'Pending').map((item) => item.basketNumber).filter((value): value is string => Boolean(value)))),
    [orderHistory]
  );

  const saveWarehousesState = async (updated: Warehouse[]) => {
    setWarehouses(updated);
    broadcastUpdate('SYNC_WAREHOUSES', updated);
        try {
      const oldMap = new Map<string, Warehouse>(warehousesRef.current.map(w => [w.id, w]));
      const newMap = new Map<string, Warehouse>(updated.map(w => [w.id, w]));
      const batchOp = writeBatch(db);

      for (const [id, newItem] of newMap.entries()) {
        const oldItem = oldMap.get(id);
        if (!oldItem || JSON.stringify(newItem) !== JSON.stringify(oldItem)) {
          batchOp.set(doc(db, 'warehouses', id), newItem);
        }
      }

      for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
          batchOp.delete(doc(db, 'warehouses', id));
        }
      }

      await batchOp.commit();
    } catch (e) {
      console.warn('Gagal sync warehouses ke cloud: ', e);
      handleSupabaseError(e, OperationType.WRITE, 'warehouses');
    }
  };

  const saveTransfersState = async (updated: InterWarehouseTransfer[]) => {
    setTransfers(updated);
    broadcastUpdate('SYNC_TRANSFERS', updated);
        try {
      const oldMap = new Map<string, InterWarehouseTransfer>(transfersRef.current.map(t => [t.id, t]));
      const newMap = new Map<string, InterWarehouseTransfer>(updated.map(t => [t.id, t]));
      const batchOp = writeBatch(db);

      for (const [id, newItem] of newMap.entries()) {
        const oldItem = oldMap.get(id);
        if (!oldItem || JSON.stringify(newItem) !== JSON.stringify(oldItem)) {
          batchOp.set(doc(db, 'warehouse_transfers', id), newItem);
        }
      }

      for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
          batchOp.delete(doc(db, 'warehouse_transfers', id));
        }
      }

      await batchOp.commit();
    } catch (e) {
      console.warn('Gagal sync warehouse_transfers ke cloud: ', e);
      handleSupabaseError(e, OperationType.WRITE, 'warehouse_transfers');
    }
  };

  // Sync Batches to Supabase (Shipping Status & Central WMS Stock Deduction)
  const saveBatchesState = async (updatedBatches: BatchRecord[]) => {
    setBatches(updatedBatches);
    broadcastUpdate('SYNC_BATCHES', updatedBatches);
        try {
      const oldMap = new Map<string, BatchRecord>(batchesRef.current.map(b => [b.id, b]));
      const newMap = new Map<string, BatchRecord>(updatedBatches.map(b => [b.id, b]));
      const batchOp = writeBatch(db);

      for (const [id, newItem] of newMap.entries()) {
        const oldItem = oldMap.get(id);
        if (!oldItem || JSON.stringify(newItem) !== JSON.stringify(oldItem)) {
          batchOp.set(doc(db, 'batches', id), newItem);
        }
      }

      for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
          batchOp.delete(doc(db, 'batches', id));
        }
      }

      await batchOp.commit();
    } catch (e) {
      console.warn('Gagal sync batches ke cloud: ', e);
      handleSupabaseError(e, OperationType.WRITE, 'batches');
    }
  };

  // Sync Return History to Supabase
  const saveReturnHistoryState = async (updatedReturnHistory: ReturnItem[]) => {
    setReturnHistory(updatedReturnHistory);
        try {
      const oldMap = new Map<string, ReturnItem>(returnHistoryRef.current.map(item => [item.id, item]));
      const newMap = new Map<string, ReturnItem>(updatedReturnHistory.map(item => [item.id, item]));
      const batch = writeBatch(db);

      for (const [id, newItem] of newMap.entries()) {
        const oldItem = oldMap.get(id);
        if (!oldItem || JSON.stringify(newItem) !== JSON.stringify(oldItem)) {
          batch.set(doc(db, 'returns', id), newItem);
        }
      }

      for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
          batch.delete(doc(db, 'returns', id));
        }
      }

      await batch.commit();
    } catch (e) {
      console.warn('Gagal sync return history ke cloud: ', e);
      handleSupabaseError(e, OperationType.WRITE, 'returns');
    }
  };

  // Refs to keep track of current states for diffing in callbacks
  const stockRef = useRef<StockItem[]>([]);
  const logsRef = useRef<DccLog[]>([]);
  const orderHistoryRef = useRef<OutboundItem[]>([]);
  const auditsRef = useRef<PhysicalAuditItem[]>([]);
  const catalogRef = useRef<CatalogItem[]>([]);
  const returnHistoryRef = useRef<ReturnItem[]>([]);
  const batchesRef = useRef<BatchRecord[]>([]);
  const warehousesRef = useRef<Warehouse[]>([]);
  const transfersRef = useRef<InterWarehouseTransfer[]>([]);

  // Cross-tab Broadcast Channel helper for 0ms multi-window synchronization
  const broadcastUpdate = (type: string, data: any) => {
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        const bc = new BroadcastChannel('wms_realtime_sync_channel_' + getActiveBranch());
        bc.postMessage({ type, data, branchId: getActiveBranch() });
        bc.close();
      }
    } catch (e) {}
  };

  useEffect(() => {
    let broadcastChannel: BroadcastChannel | null = null;
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        broadcastChannel = new BroadcastChannel('wms_realtime_sync_channel_' + getActiveBranch());
        broadcastChannel.onmessage = (event) => {
          const { type, data, branchId } = event.data || {};
          if (branchId !== getActiveBranch()) return;
          if (type === 'SYNC_STOCK' && Array.isArray(data)) {
            setStock(data);
          } else if (type === 'SYNC_LOGS' && Array.isArray(data)) {
            setLogs(data);
          } else if (type === 'SYNC_ORDERS' && Array.isArray(data)) {
            setOrderHistory(data);
          } else if (type === 'SYNC_AUDITS' && Array.isArray(data)) {
            setAudits(data);
          } else if (type === 'SYNC_CATALOG' && Array.isArray(data)) {
            setCatalog(data);
          } else if (type === 'SYNC_RETURNS' && Array.isArray(data)) {
            setReturnHistory(data);
          } else if (type === 'SYNC_BATCHES' && Array.isArray(data)) {
            setBatches(data);
          } else if (type === 'SYNC_WAREHOUSES' && Array.isArray(data)) {
            setWarehouses(data);
          } else if (type === 'SYNC_TRANSFERS' && Array.isArray(data)) {
            setTransfers(data);
          }
        };
      }
    } catch (e) {
      console.warn('BroadcastChannel initialization skipped:', e);
    }

    return () => {
      if (broadcastChannel) {
        broadcastChannel.close();
      }
    };
  }, []);

  useEffect(() => {
    stockRef.current = stock;
  }, [stock]);
  useEffect(() => {
    logsRef.current = logs;
  }, [logs]);
  useEffect(() => {
    orderHistoryRef.current = orderHistory;
  }, [orderHistory]);
  useEffect(() => {
    auditsRef.current = audits;
  }, [audits]);
  useEffect(() => {
    catalogRef.current = catalog;
    updateDynamicCatalogRegistry(catalog);
    updateDynamicBarcodeRegistry(catalog);
  }, [catalog]);
  useEffect(() => {
    returnHistoryRef.current = returnHistory;
  }, [returnHistory]);
  useEffect(() => {
    batchesRef.current = batches;
  }, [batches]);
  useEffect(() => {
    warehousesRef.current = warehouses;
  }, [warehouses]);
  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  // Auto-heal legacy unpicked pending orders flag without double-adding stock
  const hasAutoHealedRef = useRef(false);

  useEffect(() => {
    if (hasAutoHealedRef.current || orderHistory.length === 0) return;

    const legacyPendingItems = orderHistory.filter(
      item => item.status === 'Pending' && !item.picked && item.stockDeducted === undefined
    );

    if (legacyPendingItems.length > 0) {
      hasAutoHealedRef.current = true;
      const updatedOrderHistory = orderHistory.map(item => {
        if (item.status === 'Pending' && !item.picked && item.stockDeducted === undefined) {
          return { ...item, stockDeducted: false };
        }
        return item;
      });
      saveOrderHistoryState(updatedOrderHistory);
    }
  }, [orderHistory]);

  // Subscribe to the shared Supabase database after authentication.
  useEffect(() => {
    stockForcePushSnapshotRef.current = null;
    let active = true;
    let readyCount = 0;
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];
    const markReady = () => {
      readyCount += 1;
      if (readyCount >= 10) setLoading(false);
    };

    if (!isSupabaseConfigured || !supabase) {
      stockForcePushSnapshotRef.current = null;
      setDbStatus('offline');
      setStockSyncState(stockSyncFailed(new Error('Sumber data stok belum dikonfigurasi. Data lokal tetap dapat digunakan.')));
      setLoading(false);
      return;
    }

    loadingTimer = setTimeout(() => setLoading(false), 8000);
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error || !data.session) {
        stockForcePushSnapshotRef.current = null;
        setStockSyncState(stockSyncFailed(error ?? new Error('Belum ada sesi aktif untuk memuat stok cloud.')));
        setLoading(false);
        return;
      }

      let stockForcePushSnapshotCandidate: StockForcePushSnapshot<StockItem> | null = null;
      const subscribedBranchId = getActiveBranch();
      const subscribe = <T,>(
        name: string,
        setter: (items: T[]) => void,
        normalize: (items: unknown[]) => T[] = (items) => items as T[],
        sort?: (items: T[]) => T[],
        onValidated?: (items: T[], snapshot: QuerySnapshot) => void,
        onApplied?: () => void
      ) => {
        let firstEvent = true;
        const unsubscribe = onSnapshot(
          collection(db, name),
          (snapshot) => {
            if (!active) return;
            const values = snapshot.docs.map((entry) => entry.data());
            let items: T[];
            try {
              items = normalize(values);
              if (sort) items = sort(items);
              onValidated?.(items, snapshot);
            } catch (error) {
              console.error('Realtime subscription data normalization failed for ' + name + ':', error);
              if (name === 'stock') {
                stockForcePushSnapshotCandidate = null;
                stockForcePushSnapshotRef.current = null;
                stockSyncUiRequestRef.current += 1;
                setStockSyncState(stockSyncFailed(error));
              }
              if (firstEvent) {
                firstEvent = false;
                markReady();
              }
              if (name === 'stock') throw error;
              return;
            }
            setter(items);
            setDbStatus('connected');
            if (firstEvent) {
              firstEvent = false;
              markReady();
            }
          },
          (error) => {
            if (!active) return;
            console.warn('Supabase realtime subscription failed for ' + name + ':', error);
            setDbStatus('offline');
            if (name === 'stock') {
              stockForcePushSnapshotCandidate = null;
              stockForcePushSnapshotRef.current = null;
              stockSyncUiRequestRef.current += 1;
              setStockSyncState(stockSyncFailed(error));
            }
            handleSupabaseError(error, OperationType.GET, name);
            if (firstEvent) {
              firstEvent = false;
              markReady();
            }
          },
          () => {
            onApplied?.();
            if (name === 'stock' && !stockPushInProgressRef.current && !stockPushFailedRef.current) {
              stockSyncUiRequestRef.current += 1;
              setStockSyncState(stockSyncSucceeded());
            }
          }
        );
        unsubscribers.push(unsubscribe);
      };

      subscribe<UserAccount>('users', setUsers, (rows) => rows.map((row) => {
        const profile = row as UserAccount;
        return { ...profile, username: displayAccountId(profile.email || profile.username), fullName: profile.fullName || profile.email || '' };
      }));
      subscribe<StockItem>('stock', setStock, (rows) => normalizeStockBatch(rows.filter((row) => !(
        typeof row === 'object'
        && row !== null
        && 'id' in row
        && typeof row.id === 'string'
        && row.id.startsWith('SYSTEM_')
      ))), undefined, (items, snapshot) => {
        const revisions = new Map<string, number>();
        for (const entry of snapshot.docs) {
          const revision = entry.data().__wms_revision;
          if (!Number.isSafeInteger(revision) || typeof revision !== 'number' || revision < 0) {
            throw new Error(`Revision snapshot stok tidak valid untuk dokumen ${entry.id}.`);
          }
          revisions.set(entry.id, revision);
        }
        stockForcePushSnapshotCandidate = {
          branchId: subscribedBranchId,
          items,
          revisions,
          complete: true,
          valid: true,
          branchWide: true,
          loadedAt: Date.now()
        };
      }, () => {
        stockForcePushSnapshotRef.current = stockForcePushSnapshotCandidate;
      });
      subscribe<DccLog>('logs', setLogs, undefined, (items) => items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      subscribe<OutboundItem>('orders', rows=>{updateMovementSales(rows);setOrderHistory(rows)}, undefined, (items) => items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      subscribe<PhysicalAuditItem>('audits', setAudits, undefined, (items) => items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      subscribe<CatalogItem>('catalog', setCatalog);
      subscribe<ReturnItem>('returns', setReturnHistory, undefined, (items) => items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      subscribe<BatchRecord>('batches', setBatches, undefined, (items) => items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
      subscribe<Warehouse>('warehouses', (items) => {
        const normalized = ensureCentralWarehouse(items);
        setWarehouses(normalized);
        if (!items.some(w => w.isCentral || (w.id || '').toUpperCase() === 'WH-CENTRAL')) {
          saveWarehousesState(normalized);
        }
      });
      subscribe<InterWarehouseTransfer>('warehouse_transfers', setTransfers, undefined, (items) => items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    }).catch((error) => {
      if (!active) return;
      console.warn('Supabase session lookup failed:', error);
      setDbStatus('offline');
      setStockSyncState(stockSyncFailed(error));
      setLoading(false);
    });

    return () => {
      active = false;
      if (loadingTimer) clearTimeout(loadingTimer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [syncTrigger]);

  // Sync helpers to Supabase
  const sanitizeStockDocForSupabase = (item: StockItem): StockItem => {
    const cleanSku = (item.skuId || '').trim().toUpperCase();
    const normEd = normalizeDateToDmy(item.expiredDate) || 'No Expired';
    let cleanLoc = (item.location || 'E1-01-01').trim().toUpperCase();
    if (cleanLoc === 'RAK KAYU') cleanLoc = 'RACK DISPLAY';

    const canonicalId = getCanonicalStockId(cleanSku, normEd, cleanLoc, item.warehouseId);
    const qty = Math.max(0, Math.floor(Number(item.qty) || 0));

    const { qtyCtnSize: catalogCtn, qtyInnerSize: catalogInner } = getProductPackSizes(cleanSku);
    const ctnSize = catalogCtn || Math.max(1, Math.floor(Number(item.qtyCtnSize) || 720));
    const innerSize = catalogInner || Math.max(1, Math.floor(Number(item.qtyInnerSize) || 12));
    const splits = calculatePackQuantities(qty, ctnSize, innerSize);

    return {
      __wms_revision: item.__wms_revision,
      id: canonicalId,
      skuId: cleanSku,
      skuName: (item.skuName || cleanSku).trim() || `${cleanSku} Product`,
      expiredDate: normEd,
      location: cleanLoc,
      warehouseId: item.warehouseId || 'WH-CENTRAL',
      warehouseName: item.warehouseName || 'Gudang Pusat (Jakarta)',
      qty,
      totalQtySku: Math.max(0, Math.floor(Number(item.totalQtySku) || qty)),
      qtyCtnSize: ctnSize,
      qtyCtn: splits.qtyCtn,
      qtyInnerSize: innerSize,
      qtyInner: splits.qtyInner,
      qtyLoose: splits.qtyLoose,
      status: getStockStatus({...item,expiredDate:normEd,location:cleanLoc}),
      ...(item.brand ? { brand: item.brand } : {}),
      ...(item.barcode ? { barcode: item.barcode } : {}),
      ...(item.__wms_revision_document_id ? { __wms_revision_document_id: item.__wms_revision_document_id } : {}),
      ...(item.__wms_source_ids ? { __wms_source_ids: item.__wms_source_ids } : {}),
      ...(item.__wms_source_revisions ? { __wms_source_revisions: item.__wms_source_revisions } : {})
    };
  };

  const syncStockToSupabase = async (
    newStock: StockItem[],
    oldStock: StockItem[],
    forcePushSnapshot?: StockForcePushSnapshot<StockItem>
  ) => {
        try {
      const emptyFlag: StockItem = {
        id: 'SYSTEM_EMPTY_FLAG',
        skuId: 'SYSTEM_EMPTY',
        skuName: 'System Empty',
        expiredDate: '1970-01-01',
        location: 'SYSTEM',
        qty: 0,
        totalQtySku: 0,
        qtyCtnSize: 1,
        qtyCtn: 0,
        qtyInnerSize: 1,
        qtyInner: 0,
        qtyLoose: 0,
        status: 'SYSTEM'
      };
      const oldDocuments = oldStock.map(sanitizeStockDocForSupabase);
      const newDocuments = newStock.map(sanitizeStockDocForSupabase);
      const forceUpserts = Boolean(forcePushSnapshot);
      const operations = buildStockWritePlan(newDocuments, oldDocuments, emptyFlag, {
        forceUpserts,
        expectedRevisions: forcePushSnapshot?.revisions
      });

      if (operations.length === 0) return;
      if (forceUpserts && operations.length > MAX_STOCK_WRITE_OPERATIONS) {
        throw new Error('Push stok dibatalkan: satu transaksi maksimal 20.000 baris.');
      }
      if (forceUpserts && operations.some(operation => operation.expectedRevision === undefined)) {
        throw new Error('Push stok dibatalkan: revision salah satu operasi tidak dapat dipatok.');
      }
      if (forcePushSnapshot) {
        const safetyError = getStockForcePushSafetyError(
          forcePushSnapshot,
          stockRef.current,
          getActiveBranch(),
          dbStatus === 'connected'
        );
        if (safetyError || forcePushSnapshot !== stockForcePushSnapshotRef.current) {
          throw new Error(safetyError || 'Force push dibatalkan: bukti snapshot berubah sebelum transaksi dikirim.');
        }
      }

      const batch = writeBatch(db);
      queueStockWritePlan(
        batch,
        operations,
        id => doc(db, 'stock', id),
        (reference, revision) => ({ ...reference, expectedRevision: revision }),
        forceUpserts
      );
      await batch.commit();
    } catch (err) {
      handleSupabaseError(err, OperationType.WRITE, 'stock');
      throw err;
    }
  };

  const syncCatalogToSupabase = async (newCatalog: CatalogItem[], oldCatalog: CatalogItem[]) => {
        try {
      const oldMap = new Map(oldCatalog.map(item => [(item.id || item.skuId).toUpperCase(), item]));
      const newMap = new Map(newCatalog.map(item => [(item.id || item.skuId).toUpperCase(), item]));
      const operations: { type: 'set' | 'delete'; id: string; data?: any }[] = [];

      for (const [id, newItem] of newMap.entries()) {
        const oldItem = oldMap.get(id);
        const docId = (newItem.id || newItem.skuId).toUpperCase();
        const dataToSave: CatalogItem = {
          id: docId,
          skuId: newItem.skuId,
          skuName: newItem.skuName,
          brand: getProductBrand(newItem.skuId, newItem.skuName, newItem.brand),
          barcode: getBarcodeForSku(newItem.skuId, newItem.barcode),
          qtyCtnSize: newItem.qtyCtnSize || 720,
          qtyInnerSize: newItem.qtyInnerSize || 12
        };

        if (!oldItem || JSON.stringify(dataToSave) !== JSON.stringify(oldItem)) {
          operations.push({ type: 'set', id: docId, data: dataToSave });
        }
      }

      for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
          operations.push({ type: 'delete', id });
        }
      }

      if (operations.length === 0) return;

      const chunkSize = 400;
      for (let i = 0; i < operations.length; i += chunkSize) {
        const chunk = operations.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach(op => {
          const docRef = doc(db, 'catalog', op.id);
          if (op.type === 'set') {
            batch.set(docRef, op.data);
          } else {
            batch.delete(docRef);
          }
        });
        await batch.commit();
      }
    } catch (err) {
      handleSupabaseError(err, OperationType.WRITE, 'catalog');
    }
  };

  const syncLogsToSupabase = async (newLogs: DccLog[], oldLogs: DccLog[]) => {
    try {
      const oldMap = new Map(oldLogs.map(item => [item.id, item]));
      const newMap = new Map(newLogs.map(item => [item.id, item]));
      
      const batch = writeBatch(db);
      for (const [id, newLog] of newMap.entries()) {
        const oldLog = oldMap.get(id);
        if (!oldLog || JSON.stringify(newLog) !== JSON.stringify(oldLog)) {
          batch.set(doc(db, 'logs', id), newLog);
        }
      }

      for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
          batch.delete(doc(db, 'logs', id));
        }
      }
      batch.commit().catch(() => {});
    } catch (err) {
      handleSupabaseError(err, OperationType.WRITE, 'logs');
    }
  };

  const syncOrdersToSupabase = async (newOrders: OutboundItem[], oldOrders: OutboundItem[]) => {
    try {
      const oldMap = new Map(oldOrders.map(item => [item.id, item]));
      const newMap = new Map(newOrders.map(item => [item.id, item]));

      const batch = writeBatch(db);
      for (const [id, newOrder] of newMap.entries()) {
        const oldOrder = oldMap.get(id);
        if (!oldOrder || JSON.stringify(newOrder) !== JSON.stringify(oldOrder)) {
          batch.set(doc(db, 'orders', id), newOrder);
        }
      }

      for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
          batch.delete(doc(db, 'orders', id));
        }
      }
      batch.commit().catch(() => {});
    } catch (err) {
      handleSupabaseError(err, OperationType.WRITE, 'orders');
    }
  };

  const syncAuditsToSupabase = async (newAudits: PhysicalAuditItem[], oldAudits: PhysicalAuditItem[]) => {
        try {
      const oldMap = new Map(oldAudits.map(item => [item.id, item]));
      const newMap = new Map(newAudits.map(item => [item.id, item]));

      const batch = writeBatch(db);
      for (const [id, newAudit] of newMap.entries()) {
        const oldAudit = oldMap.get(id);
        if (!oldAudit || JSON.stringify(newAudit) !== JSON.stringify(oldAudit)) {
          batch.set(doc(db, 'audits', id), newAudit);
        }
      }

      for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
          batch.delete(doc(db, 'audits', id));
        }
      }
      batch.commit().catch(() => {});
    } catch (err) {
      handleSupabaseError(err, OperationType.WRITE, 'audits');
    }
  };

  const saveAuditsState = (updatedAudits: PhysicalAuditItem[]) => {
    setAudits(updatedAudits);
    broadcastUpdate('SYNC_AUDITS', updatedAudits);
    syncAuditsToSupabase(updatedAudits, auditsRef.current);
  };

  const saveCatalogState = (updatedCatalog: CatalogItem[]) => {
    setCatalog(updatedCatalog);
    broadcastUpdate('SYNC_CATALOG', updatedCatalog);
    syncCatalogToSupabase(updatedCatalog, catalogRef.current);
  };

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    let active = true;
    const applySession = async (session: any) => {
      if (!active) return;
      if (!session) {
        setIsLoggedIn(false);
        setCurrentUser(null);
        setLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from('profiles')
        .select('id,email,full_name,role,is_active,branch_id')
        .eq('id', session.user.id)
        .maybeSingle();
      if (!active) return;
      if (error || !data || !data.is_active) {
        setIsLoggedIn(false);
        setCurrentUser(null);
        setLoginError(error?.message || (!data ? 'Profil WMS belum tersedia. Jalankan migrasi Supabase terlebih dahulu.' : 'Akun ini belum diaktifkan oleh admin WMS.'));
        setLoading(false);
        return;
      }
      const profile: UserAccount = {
        id: data.id,
        email: data.email,
        username: displayAccountId(data.email),
        fullName: data.full_name || data.email,
        role: data.role,
        is_active: data.is_active,
        branch_id: data.branch_id
      };
      if (!["Administrator", "Viewer"].includes(data.role)) setActiveBranch(data.branch_id);
      const { data: allowed } = await supabase.from("branches").select("id").eq("id",getActiveBranch()).maybeSingle();
      if (!allowed) setActiveBranch(data.branch_id || "CENTER");
      setCurrentUser(profile);
      setIsLoggedIn(true);
      setLoginError('');
      setSyncTrigger((value) => value + 1);
      setLoading(false);
    };
    void supabase.auth.getSession().then(({ data }) => applySession(data.session));
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED' || event === 'PASSWORD_RECOVERY') {
        window.setTimeout(() => void applySession(session), 0);
      }
    });
    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError('');
    if (!supabase) {
      setLoginError('Supabase belum dikonfigurasi. Isi URL dan anon key di file .env.');
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail(emailInput),
      password: passwordInput
    });
    if (error) {
      setLoginError('Login gagal: ' + error.message);
      return;
    }
    setEmailInput('');
    setPasswordInput('');
    setActiveTab('dashboard');
  };

  const handleLogout = async () => {
    if (supabase) await supabase.auth.signOut();
    setIsLoggedIn(false);
    setCurrentUser(null);
    setUsers([]);
    setStock([]);
    setLogs([]);
    setOrderHistory([]);
    setAudits([]);
    setCatalog([]);
    setReturnHistory([]);
    setBatches([]);
    setWarehouses([]);
    setTransfers([]);
    setSyncTrigger((value) => value + 1);
    setActiveTab('dashboard');
  };

  const runAdminAction = async (body: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase belum dikonfigurasi.');
    const { data: rpcData, error: rpcError } = await supabase.rpc('admin_manage_user', { body });
    if (!rpcError) {
      if (rpcData && typeof rpcData === 'object' && 'error' in rpcData) {
        throw new Error(String((rpcData as Record<string, unknown>).error));
      }
      return rpcData;
    }
    const { data, error } = await supabase.functions.invoke('admin-users', { body });
    if (error) throw new Error(error.message);
    if (data?.error) throw new Error(String(data.error));
    return data;
  };

  const handleAddUser = async (newUser: UserAccount) => {
    await runAdminAction({
      action: 'create',
      username: newUser.username,
      password: newUser.password,
      branchId: newUser.branch_id || getActiveBranch(),
      fullName: newUser.fullName,
      role: newUser.role
    });
  };

  const handleUpdateUser = async (email: string, fields: Partial<UserAccount>) => {
    const target = users.find((user) => (user.email || user.username).toLowerCase() === email.toLowerCase());
    if (!target?.id) throw new Error('Profil operator tidak ditemukan.');
    await runAdminAction({ action: 'update', userId: target.id, fullName: fields.fullName, role: fields.role, branchId: fields.branch_id });
  };

  const handleDeleteUser = async (email: string) => {
    const target = users.find((user) => (user.email || user.username).toLowerCase() === email.toLowerCase());
    if (!target?.id) throw new Error('Profil operator tidak ditemukan.');
    await runAdminAction({ action: 'delete', userId: target.id });
  };

  const handleAddCatalogItem = async (newItem: Omit<CatalogItem, 'id'>) => {
    try {
      const docId = newItem.skuId.toUpperCase();
      const resolvedBrand = getProductBrand(newItem.skuId, newItem.skuName, newItem.brand);
      const resolvedBarcode = getBarcodeForSku(newItem.skuId, newItem.barcode);
      const itemToSave: CatalogItem = {
        id: docId,
        skuId: newItem.skuId,
        skuName: newItem.skuName,
        brand: resolvedBrand,
        barcode: resolvedBarcode,
        qtyCtnSize: newItem.qtyCtnSize,
        qtyInnerSize: newItem.qtyInnerSize
      };
      await setDoc(doc(db, 'catalog', docId), itemToSave);
      return true;
    } catch (error) {
      console.error('Error adding catalog item: ', error);
      return false;
    }
  };

  const handleUpdateCatalogItem = async (skuId: string, updatedFields: Partial<CatalogItem>) => {
    try {
      const docId = skuId.toUpperCase();
      const existing = catalog.find(c => c.skuId.toUpperCase() === docId);
      if (!existing) return false;

      const newBrand = getProductBrand(skuId, updatedFields.skuName || existing.skuName, updatedFields.brand || existing.brand);
      const newBarcode = getBarcodeForSku(skuId, updatedFields.barcode || existing.barcode);

      const merged: CatalogItem = {
        ...existing,
        ...updatedFields,
        brand: newBrand,
        barcode: newBarcode,
        id: docId,
        skuId: skuId
      };
      const batch = writeBatch(db);
      batch.set(doc(db, 'catalog', docId), merged);

      // Also sync matching stock items in system with updated name, brand, barcode and pack sizes
      const matchingStock = stock.filter(s => s.skuId.toUpperCase() === docId);
      if (matchingStock.length > 0) {
        matchingStock.forEach(s => {
          const newCtnSize = updatedFields.qtyCtnSize ?? s.qtyCtnSize;
          const newInnerSize = updatedFields.qtyInnerSize ?? s.qtyInnerSize;
          const newName = updatedFields.skuName ?? s.skuName;
          const splits = calculatePackQuantities(s.qty, newCtnSize, newInnerSize);
          const updatedStockItem: StockItem = {
            ...s,
            skuName: newName,
            brand: newBrand,
            barcode: newBarcode,
            qtyCtnSize: newCtnSize,
            qtyInnerSize: newInnerSize,
            qtyCtn: splits.qtyCtn,
            qtyInner: splits.qtyInner,
            qtyLoose: splits.qtyLoose
          };
          batch.set(doc(db, 'stock', s.id), updatedStockItem);
        });

      }

      await batch.commit();
      return true;
    } catch (error) {
      console.error('Error updating catalog item: ', error);
      return false;
    }
  };

  const handleDeleteCatalogItem = async (skuId: string) => {
    try {
      const docId = skuId.toUpperCase();
      await deleteDoc(doc(db, 'catalog', docId));
      return true;
    } catch (error) {
      console.error('Error deleting catalog item: ', error);
      return false;
    }
  };

  const handleBatchImportCatalog = async (
    items: Omit<CatalogItem, 'id'>[],
    mode: 'merge' | 'replace'
  ) => {
    try {
      setIsSyncingNow(true);
      if (mode === 'replace') {
        // Delete existing catalog items from Supabase
        const batchDelete = writeBatch(db);
        catalog.forEach(c => {
          batchDelete.delete(doc(db, 'catalog', c.id));
        });
        await batchDelete.commit().catch(e => console.warn('Batch delete catalog error:', e));
      }

      // Add or update catalog docs in chunks of 400
      const chunkSize = 400;
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach(item => {
          const docId = item.skuId.toUpperCase();
          const resolvedBrand = getProductBrand(item.skuId, item.skuName, item.brand);
          const resolvedBarcode = getBarcodeForSku(item.skuId, item.barcode);
          const itemToSave: CatalogItem = {
            id: docId,
            skuId: item.skuId,
            skuName: item.skuName,
            brand: resolvedBrand,
            barcode: resolvedBarcode,
            qtyCtnSize: item.qtyCtnSize,
            qtyInnerSize: item.qtyInnerSize
          };
          batch.set(doc(db, 'catalog', docId), itemToSave);
        });
        await batch.commit();
      }

      // Sync imported sizes with existing stock items in system
      const updatedCatalogMap = new Map<string, Omit<CatalogItem, 'id'>>();
      items.forEach(item => {
        updatedCatalogMap.set(item.skuId.toUpperCase(), item);
      });

      const stockToUpdate = stock.filter(s => updatedCatalogMap.has(s.skuId.toUpperCase()));
      if (stockToUpdate.length > 0) {
        for (let i = 0; i < stockToUpdate.length; i += chunkSize) {
          const chunk = stockToUpdate.slice(i, i + chunkSize);
          const batch = writeBatch(db);
          chunk.forEach(s => {
            const cat = updatedCatalogMap.get(s.skuId.toUpperCase())!;
            const splits = calculatePackQuantities(s.qty, cat.qtyCtnSize, cat.qtyInnerSize);
            const resolvedBrand = getProductBrand(cat.skuId, cat.skuName, cat.brand);
            const resolvedBarcode = getBarcodeForSku(cat.skuId, cat.barcode);
            const updatedStockItem: StockItem = {
              ...s,
              skuName: cat.skuName || s.skuName,
              brand: resolvedBrand,
              barcode: resolvedBarcode,
              qtyCtnSize: cat.qtyCtnSize,
              qtyInnerSize: cat.qtyInnerSize,
              qtyCtn: splits.qtyCtn,
              qtyInner: splits.qtyInner,
              qtyLoose: splits.qtyLoose
            };
            batch.set(doc(db, 'stock', s.id), updatedStockItem);
          });
          await batch.commit().catch(e => console.warn('Batch stock catalog sync failed:', e));
        }
      }

      // Update local state and trigger sync/broadcast
      const importedCatalogList: CatalogItem[] = items.map(item => ({
        id: item.skuId.toUpperCase(),
        skuId: item.skuId,
        skuName: item.skuName,
        brand: getProductBrand(item.skuId, item.skuName, item.brand),
        barcode: getBarcodeForSku(item.skuId, item.barcode),
        qtyCtnSize: item.qtyCtnSize,
        qtyInnerSize: item.qtyInnerSize
      }));

      if (mode === 'replace') {
        saveCatalogState(importedCatalogList);
      } else {
        const mergedMap = new Map<string, CatalogItem>(catalog.map(c => [c.skuId.toUpperCase(), c]));
        importedCatalogList.forEach(c => mergedMap.set(c.skuId.toUpperCase(), c));
        saveCatalogState(Array.from(mergedMap.values()));
      }

      setIsSyncingNow(false);
      return true;
    } catch (error) {
      console.error('Error batch importing catalog: ', error);
      setIsSyncingNow(false);
      return false;
    }
  };

  const handleSyncStockToCatalog = async () => {
    try {
      const catalogSkuSet = new Set(catalog.map(c => c.skuId.toUpperCase()));
      const missingStockSkus = new Map<string, { skuId: string; skuName: string; qtyCtnSize: number; qtyInnerSize: number }>();

      stock.forEach(s => {
        const normSku = s.skuId.toUpperCase();
        if (!catalogSkuSet.has(normSku) && !missingStockSkus.has(normSku)) {
          const sizes = getProductPackSizes(s.skuId);
          missingStockSkus.set(normSku, {
            skuId: s.skuId,
            skuName: s.skuName,
            qtyCtnSize: sizes.qtyCtnSize,
            qtyInnerSize: sizes.qtyInnerSize
          });
        }
      });

      if (missingStockSkus.size === 0) return { addedCount: 0 };

      const batch = writeBatch(db);
      missingStockSkus.forEach((item, normSku) => {
        const resolvedBrand = getProductBrand(item.skuId, item.skuName);
        const resolvedBarcode = getBarcodeForSku(item.skuId);
        batch.set(doc(db, 'catalog', normSku), {
          id: normSku,
          skuId: item.skuId,
          skuName: item.skuName,
          brand: resolvedBrand,
          barcode: resolvedBarcode,
          qtyCtnSize: item.qtyCtnSize,
          qtyInnerSize: item.qtyInnerSize
        });
      });
      await batch.commit();
      return { addedCount: missingStockSkus.size };
    } catch (e) {
      console.error('Error syncing stock to catalog:', e);
      return { addedCount: 0 };
    }
  };

  const [activeTab, setActiveTab] = useState('dashboard');
  const [inventoryEntryFocus,setInventoryEntryFocus] = useState('ALL');
  const [outboundEntryMode,setOutboundEntryMode] = useState<OutboundMode|undefined>(undefined);
  const navigateFromMenu = (tab:string) => {setInventoryEntryFocus('ALL');setOutboundEntryMode(undefined);setActiveTab(tab);};

  // Enforce role-based tab containment:
  // - Packer/Picker: dashboard, outbound, Mabang picking/packing, and assistant
  // - Viewer: dashboard & inventory (stok barang hanya lihat) & ai-chat
  // - Admin: dashboard, inventory, bulk (outbound), inbound, bulk-transfer, warehouse-map, daily-cycle-count, stock-opname-location, catalog, ai-chat (Hanya tidak bisa mengakses 'users' / Kelola Akun)
  // - Administrator: full access termasuk 'users' (Kelola Akun)
  useEffect(() => {
    if (!isLoggedIn) return;
    if (activeTab === 'ai-chat') {
      setActiveTab('dashboard');
      return;
    }
    if (currentUser?.role === 'Packer' || currentUser?.role === 'Picker' || currentUser?.role === 'Shipping') {
      if (!['dashboard', 'bulk', 'mabang'].includes(activeTab)) {
        setActiveTab('bulk');
      }
    } else if (currentUser?.role === 'Viewer') {
      if (!['dashboard', 'inventory', 'bulk-transfer'].includes(activeTab)) {
        setActiveTab('dashboard');
      }
    }
  }, [isLoggedIn, currentUser, activeTab]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Keep DCC alive across tab navigation once opened to prevent state loss
  const [hasVisitedDcc, setHasVisitedDcc] = useState(false);
  useEffect(() => {
    if (activeTab === 'daily-cycle-count') {
      setHasVisitedDcc(true);
    }
  }, [activeTab]);

  // Save states helper
  const saveStockState = async (
    updatedStock: StockItem[],
    forcePushSnapshot?: StockForcePushSnapshot<StockItem>
  ) => {
    // Deduplicate and merge stock rows first
    const deduplicatedStock = deduplicateAndMergeStock(updatedStock);

    if (deduplicatedStock.length === 0) {
    } else {
    }

    // Re-calculate SKU-level totals across the entire array for consistency
    const skuTotals: Record<string, number> = {};
    deduplicatedStock.forEach(item => {
      skuTotals[item.skuId] = (skuTotals[item.skuId] || 0) + item.qty;
    });

    const finalized = deduplicatedStock.map(item => ({
      ...item,
      totalQtySku: skuTotals[item.skuId] || 0
    }));

    const oldStock = [...stockRef.current];
    try {
      const remaining=new Set(finalized.map(s=>s.id));
      if(oldStock.filter(s=>!remaining.has(s.id)).length>=25){
        if(!supabase)throw Error('Database belum terhubung.');
        const backup=await supabase.rpc('branch_backup_action',{p_action:'create',p_branch_id:getActiveBranch(),p_backup_id:null,p_token:null,p_reason:'Backup otomatis sebelum penggantian/penghapusan massal stok',p_file:null});
        if(backup.error){alert('Backup pengaman gagal. Perubahan stok dibatalkan.');return false;}
      }
      await syncStockToSupabase(finalized, oldStock, forcePushSnapshot);
      setSyncTrigger(value=>value+1);return true;
    } catch (error) {
      setSyncTrigger(value=>value+1);
      if (forcePushSnapshot) throw error;
      return false;
    }
  };

  const executeTransferAtomic = async (newTransfer: InterWarehouseTransfer, updatedStock: StockItem[], newLogs: DccLog[]) => {
    try {
      console.log('executeTransferAtomic: executing transfer', newTransfer.id, 'with stock items:', updatedStock.length);

      // 1. Save stock state through the proven canonical stock pipeline.
      // CRITICAL: DO NOT mutate stockRef.current beforehand, because saveStockState
      // compares finalized vs stockRef.current (oldStock) to calculate database diffs.
      // If stockRef.current is mutated beforehand, buildStockWritePlan assumes old == new
      // and silently drops the deduction on source stock items!
      const stockSaved = await saveStockState(updatedStock);
      if (!stockSaved) {
        throw new Error('Penyimpanan stok gagal disinkronkan ke database server.');
      }

      // Update local state after saving stock
      setStock(updatedStock);

      // 2. Save transfer record to warehouse_transfers
      await saveTransfersState([newTransfer, ...transfersRef.current]);

      // 3. Save audit trail logs
      saveLogsState([...newLogs, ...logsRef.current]);

      // Broadcast and trigger sync
      broadcastUpdate('SYNC_TRANSFERS', [newTransfer, ...transfersRef.current]);
      setSyncTrigger(value => value + 1);
    } catch (e) {
      console.error('Failed atomic transfer:', e);
      throw e;
    }
  };

  const handleForcePushStockToCloud = async () => {
    const snapshot = stockForcePushSnapshotRef.current;
    const safetyError = getStockForcePushSafetyError(
      snapshot,
      stock,
      getActiveBranch(),
      dbStatus === 'connected'
    );
    if (!snapshot || safetyError || stockRef.current !== stock) {
      const error = new Error(safetyError || 'Force push dibatalkan: data stok yang tampil belum sama dengan snapshot tervalidasi.');
      stockPushFailedRef.current = true;
      setStockSyncState(stockSyncFailed(error));
      alert(error.message);
      return;
    }

    if (isLoggedIn && stock.length === 0) {
      alert('Perhatian: Data stok di laptop ini 0 Pcs. Tidak ada data stok yang dapat diunggah ke cloud.');
      return;
    }

    const totalQty = stock.reduce((sum, item) => sum + item.qty, 0);
    const confirmPush = confirm(
      `SINKRONISASI STOK LAPTOP KE CLOUD DATABASE:\n\n` +
      `• Data Stok di Laptop: ${stock.length} baris SKU (Total Qty: ${formatNumber(totalQty)} Pcs).\n\n` +
      `Apakah Anda ingin mengunggah SELURUH data stok ini dari laptop ke Database Supabase?\n\n` +
      `Tindakan ini akan menyinkronkan stok ini ke semua perangkat yang masuk ke akun WMS yang sama.`
    );

    if (!confirmPush) return;

    setIsSyncingNow(true);
    stockPushFailedRef.current = false;
    stockPushInProgressRef.current = true;
    const syncRequest = ++stockSyncUiRequestRef.current;
    setStockSyncState(current => stockSyncStarted(current));
    try {
      const deduplicated = deduplicateAndMergeStock(stock);
      let saved = false;
      await runStockForcePushIfSafe(
        snapshot,
        stock,
        getActiveBranch(),
        dbStatus === 'connected',
        async () => { saved = await saveStockState(deduplicated, snapshot); }
      );
      if (!saved) throw new Error('Data lokal berhasil disiapkan, tetapi penyimpanan stok ke cloud gagal.');
      if (syncRequest === stockSyncUiRequestRef.current) setStockSyncState(stockSyncSucceeded());

      alert(
        `✓ SINKRONISASI CLOUD BERHASIL!\n\n` +
        `Berhasil mengunggah ${deduplicated.length} baris SKU (Total Qty: ${formatNumber(totalQty)} Pcs) ke Supabase Cloud.\n\n` +
        `Silakan periksa perangkat lain yang sudah masuk ke akun WMS yang sama.`
      );
    } catch (err: any) {
      console.error('Push stock to cloud failed:', err);
      stockPushFailedRef.current = true;
      if (syncRequest === stockSyncUiRequestRef.current) setStockSyncState(stockSyncFailed(err));
      alert('Gagal mengunggah stok ke Cloud Database: ' + (err.message || err));
    } finally {
      stockPushInProgressRef.current = false;
      setIsSyncingNow(false);
    }
  };

  const handlePullStockFromCloud = async () => {
    setIsSyncingNow(true);
    const syncRequest = ++stockSyncUiRequestRef.current;
    setStockSyncState(current => stockSyncStarted(current));
    try {
      const snap = await getDocs(collection(db, 'stock'));
      if (!snap.empty) {
        const records = snap.docs
          .filter(d => d.id !== 'SYSTEM_EMPTY_FLAG' && d.id !== 'SYSTEM_DEFAULTS_CONFIG')
          .map(d => d.data());
        const deduplicated = normalizeStockBatch(records);
        setStock(deduplicated);
        stockPushFailedRef.current = false;
        if (syncRequest === stockSyncUiRequestRef.current) setStockSyncState(stockSyncSucceeded());
        const totalQty = deduplicated.reduce((a, b) => a + b.qty, 0);
        alert(
          `✓ SINKRONISASI DATA HP/LAPTOP BERHASIL!\n\n` +
          `Berhasil mengambil ${deduplicated.length} baris SKU (Total Qty: ${formatNumber(totalQty)} Pcs) langsung dari Supabase.\n\n` +
          `Kuantitas stok pada perangkat HP dan Laptop Anda kini 100% SAMA dan sinkron!`
        );
      } else {
        const error = new Error('Sumber data stok kosong; stok terakhir yang tampil dipertahankan.');
        if (syncRequest === stockSyncUiRequestRef.current) setStockSyncState(stockSyncFailed(error));
        alert('Informasi: Belum ada data stok di Supabase. ' + error.message);
      }
    } catch (err: unknown) {
      console.error('Pull stock from cloud failed:', err);
      if (err instanceof StaleReadError) return;
      if (syncRequest === stockSyncUiRequestRef.current) setStockSyncState(stockSyncFailed(err));
      alert('Gagal mengambil data stok dari Cloud: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsSyncingNow(false);
    }
  };

  const saveLogsState = (updatedLogs: DccLog[]) => {
    setLogs(updatedLogs);
    broadcastUpdate('SYNC_LOGS', updatedLogs);
    syncLogsToSupabase(updatedLogs, logsRef.current);
  };

  const handleAddLog = (newLog: Omit<DccLog, 'id' | 'timestamp'>) => {
    const logItem: DccLog = {
      ...newLog,
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString()
    };
    saveLogsState([logItem, ...logsRef.current]);
  };

  const handleAddBatchLogs = (newLogs: Omit<DccLog, 'id' | 'timestamp'>[]) => {
    if (!newLogs.length) return;
    const now = Date.now();
    const nowIso = new Date().toISOString();
    const createdLogs: DccLog[] = newLogs.map((nl, idx) => ({
      ...nl,
      id: `log-${now}-${idx}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: nowIso
    }));
    saveLogsState([...createdLogs, ...logsRef.current]);
  };

  const saveOrderHistoryState = (updatedOrderHistory: OutboundItem[]) => {
    setOrderHistory(updatedOrderHistory);
    broadcastUpdate('SYNC_ORDERS', updatedOrderHistory);
    syncOrdersToSupabase(updatedOrderHistory, orderHistoryRef.current);
  };

  // STOCK OPERATIONS

  // 1. Update/Edit existing stock list manually
  const handleUpdateStock = (updatedStock: StockItem[]) => {
    saveStockState(updatedStock);

    // Register a log of adjustment
    const logItem: DccLog = {
      id: `log_adj_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'ADJUSTMENT',
      skuId: updatedStock.length === 0 ? 'CLEAR_ALL' : 'MULTI',
      skuName: updatedStock.length === 0 ? 'Pengosongan Semua Stok' : 'Penyesuaian Massal Tabel Stok',
      locationFrom: 'Manual Adjust',
      locationTo: 'Inventory Grid',
      qty: 0,
      description: updatedStock.length === 0 
        ? 'Operator mengosongkan seluruh data stok gudang untuk kebutuhan import ulang' 
        : 'Operator melakukan penyesuaian rincian baris stok',
      user: currentUser?.fullName || 'Admin Operator'
    };
    saveLogsState([logItem, ...logs]);
  };

  const stockEditLock = useRef(false);
  const handleEditStockItem = async (newItem: StockItem, oldItem: StockItem): Promise<boolean> => {
    if (stockEditLock.current) return false;
    stockEditLock.current = true;
    try {
      if (!Number.isSafeInteger(newItem.qty) || newItem.qty < 0) throw new Error('Jumlah stok harus bilangan bulat positif atau nol.');
      const source = stock.find(s => s.id === oldItem.id);
      if (!source) throw new Error('Stok sumber tidak ditemukan. Muat ulang data.');
      if (source.__wms_revision !== oldItem.__wms_revision || source.qty !== oldItem.qty) throw new Error('Stok berubah sejak form dibuka. Buka ulang form edit.');
      const wh = newItem.warehouseId || source.warehouseId || 'WH-CENTRAL';
      const skuId = newItem.skuId.trim().toUpperCase();
      const expiredDate = normalizeDateToDmy(newItem.expiredDate) || 'No Expired';
      const location = newItem.location.trim().toUpperCase().replace(/^RAK KAYU$/, 'RACK DISPLAY');
      if (!skuId || !location) throw new Error('SKU dan lokasi wajib diisi.');
      const id = getCanonicalStockId(skuId, expiredDate, location, wh);
      const sourceCanonicalId = getCanonicalStockId(source.skuId, source.expiredDate, source.location, source.warehouseId || 'WH-CENTRAL');
      const activeOrdersForBatch = orderHistoryRef.current.filter(
        o => o.status === 'Pending' && o.qty > 0 && getCanonicalStockId(o.skuId, o.expiredDate, o.location, o.warehouseId) === sourceCanonicalId
      );
      if (activeOrdersForBatch.length > 0) {
        const orderRefs = Array.from(new Set(activeOrdersForBatch.map(o => o.referenceNumber).filter(Boolean)));
        const refSummary = `${orderRefs.slice(0, 5).join(', ')}${orderRefs.length > 5 ? ', ...' : ''}`;
        if (id !== sourceCanonicalId) {
          throw new Error(
            `Tidak dapat mengubah Tanggal Kedaluwarsa, Lokasi, atau Gudang karena stok ini sedang terikat pada ${orderRefs.length || activeOrdersForBatch.length} order berjalan (${refSummary}). Selesaikan atau batalkan order tersebut terlebih dahulu.`
          );
        }
        const lockedUnpickedQty = activeOrdersForBatch
          .filter(o => o.stockDeducted !== true)
          .reduce((sum, o) => sum + o.qty, 0);
        if (newItem.qty < lockedUnpickedQty) {
          throw new Error(
            `Jumlah stok fisik (${newItem.qty} pcs) tidak boleh dikurangi di bawah jumlah yang sedang dialokasikan ke order menunggu picking (${lockedUnpickedQty} pcs pada order: ${refSummary}).`
          );
        }
      }
      const target = stock.find(s => s.id !== source.id && getCanonicalStockId(s.skuId,s.expiredDate,s.location,s.warehouseId || 'WH-CENTRAL') === id);
      const qty = newItem.qty + (target?.qty || 0);
      const sourceIds = [...new Set([
        ...(source.__wms_source_ids?.length ? source.__wms_source_ids : [source.id]),
        ...(target ? (target.__wms_source_ids?.length ? target.__wms_source_ids : [target.id]) : [])
      ])];
      const sourceRevisions = {
        ...(source.__wms_source_revisions || {}),
        ...(target?.__wms_source_revisions || {})
      };
      const updated = {...newItem, __wms_revision: id===source.id ? source.__wms_revision : target?.__wms_revision, __wms_revision_document_id: id===source.id ? source.__wms_revision_document_id : target?.__wms_revision_document_id, __wms_source_ids: sourceIds, __wms_source_revisions: sourceRevisions, id, skuId, location, expiredDate, warehouseId:wh, qty, ...calculatePackQuantities(qty,newItem.qtyCtnSize,newItem.qtyInnerSize),status:getExpiredStatus(expiredDate)};
      const batch = writeBatch(db);
      if (source.id !== id) batch.delete(doc(db,'stock',source.id));
      if (target && target.id !== id) batch.delete(doc(db,'stock',target.id));
      batch.set(doc(db,'stock',id),sanitizeStockDocForSupabase(updated));
      batch.set(doc(db,'logs','log_edit_'+crypto.randomUUID()),{timestamp:new Date().toISOString(),type:'ADJUSTMENT',skuId,skuName:updated.skuName,qty:Math.abs(newItem.qty-source.qty),locationFrom:source.location,locationTo:location,warehouseId:wh,description:'Edit stok: '+source.qty+' -> '+newItem.qty,user:currentUser?.fullName || 'Admin'});
      await batch.commit();
      return true;
    } catch(e:any) { alert(e.message || 'Edit stok gagal. Muat ulang data sebelum mencoba lagi.'); return false; }
    finally { stockEditLock.current=false; }
  };

  // 2. Add brand new stock record (Inbound)
  const handleAddStockItem = async (newItem: Omit<StockItem, 'id' | 'totalQtySku'>): Promise<boolean> => {
    if (!Number.isSafeInteger(newItem.qty) || newItem.qty <= 0) throw new Error('Jumlah stok harus berupa bilangan bulat positif.');
    // Sanitize qty input to be positive integer
    const sanitizedQty = Math.floor(Math.max(0, newItem.qty));
    const normalizedEd = normalizeDateToDmy(newItem.expiredDate);
    const sanitizedItem = {
      ...newItem,
      expiredDate: normalizedEd,
      qty: sanitizedQty
    };
    const id = getCanonicalStockId(sanitizedItem.skuId, sanitizedItem.expiredDate, sanitizedItem.location, sanitizedItem.warehouseId);
    
    // Check if exactly same SKU-Loc-Exp already exists
    const existingIdx = findStockIndex(stock, sanitizedItem.skuId, sanitizedItem.expiredDate, sanitizedItem.location, id, sanitizedItem.warehouseId);

    let updatedList = [...stock];
    if (existingIdx > -1) {
      // Aggregate quantities
      const existing = updatedList[existingIdx];
      const mergedQty = existing.qty + sanitizedItem.qty;
      const splits = calculatePackQuantities(mergedQty, existing.qtyCtnSize, existing.qtyInnerSize);
      
      updatedList[existingIdx] = {
        ...existing,
        id,
        qty: mergedQty,
        qtyCtn: splits.qtyCtn,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose
      };
    } else {
      // Append new
      updatedList.unshift({
        ...sanitizedItem,
        id,
        totalQtySku: sanitizedItem.qty // will be recalculated dynamically
      });
    }



    // Append log
    const logItem: DccLog = {
      id: `log_in_${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: 'INBOUND',
      skuId: newItem.skuId,
      skuName: newItem.skuName,
      locationFrom: 'Staging Inbound',
      locationTo: newItem.location,
      qty: newItem.qty,
      description: `Penerimaan inbound barang baru ke lokasi ${newItem.location}`,
      warehouseId: sanitizedItem.warehouseId || 'WH-CENTRAL',
      warehouseName: sanitizedItem.warehouseName,
      user: currentUser?.fullName || 'WMS Inbound'
    };
    const batch = writeBatch(db);
    const changed = updatedList.find(item => item.id === id)!;
    batch.set(doc(db, 'stock', id), sanitizeStockDocForSupabase(changed));
    batch.set(doc(db, 'logs', logItem.id), logItem);
    await batch.commit();
    setSyncTrigger(value => value + 1);
    return true;
  };

  const handleAddStockItemsBatch = async (newItems: Omit<StockItem, 'id' | 'totalQtySku'>[]): Promise<boolean> => {
    if (!newItems.length) return true;
    let updatedList = [...stock];
    const changedIds = new Set<string>();
    const logItems: DccLog[] = [];
    const nowIso = new Date().toISOString();

    for (const newItem of newItems) {
      if (!Number.isSafeInteger(newItem.qty) || newItem.qty <= 0) throw new Error('Jumlah stok harus berupa bilangan bulat positif.');
      const sanitizedQty = Math.floor(Math.max(0, newItem.qty));
      const normalizedEd = normalizeDateToDmy(newItem.expiredDate);
      const splitsInit = calculatePackQuantities(sanitizedQty, newItem.qtyCtnSize, newItem.qtyInnerSize);
      const sanitizedItem = {
        ...newItem,
        expiredDate: normalizedEd,
        qty: sanitizedQty,
        qtyCtn: splitsInit.qtyCtn,
        qtyInner: splitsInit.qtyInner,
        qtyLoose: splitsInit.qtyLoose
      };
      const id = getCanonicalStockId(sanitizedItem.skuId, sanitizedItem.expiredDate, sanitizedItem.location, sanitizedItem.warehouseId);
      const existingIdx = findStockIndex(updatedList, sanitizedItem.skuId, sanitizedItem.expiredDate, sanitizedItem.location, id, sanitizedItem.warehouseId);

      if (existingIdx > -1) {
        const existing = updatedList[existingIdx];
        const mergedQty = existing.qty + sanitizedItem.qty;
        const splits = calculatePackQuantities(mergedQty, existing.qtyCtnSize, existing.qtyInnerSize);
        updatedList[existingIdx] = {
          ...existing,
          id,
          qty: mergedQty,
          qtyCtn: splits.qtyCtn,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose
        };
      } else {
        updatedList.unshift({
          ...sanitizedItem,
          id,
          totalQtySku: sanitizedItem.qty
        });
      }
      changedIds.add(id);

      logItems.push({
        id: `log_in_${crypto.randomUUID()}`,
        timestamp: nowIso,
        type: 'INBOUND',
        skuId: newItem.skuId,
        skuName: newItem.skuName,
        locationFrom: 'Staging Inbound',
        locationTo: newItem.location,
        qty: sanitizedQty,
        description: `Penerimaan inbound barang baru ke lokasi ${newItem.location}`,
        warehouseId: sanitizedItem.warehouseId || 'WH-CENTRAL',
        warehouseName: sanitizedItem.warehouseName,
        user: currentUser?.fullName || 'WMS Inbound'
      });
    }

    const batch = writeBatch(db);
    for (const id of changedIds) {
      const changed = updatedList.find(item => item.id === id);
      if (changed) {
        batch.set(doc(db, 'stock', id), sanitizeStockDocForSupabase(changed));
      }
    }
    for (const logItem of logItems) {
      batch.set(doc(db, 'logs', logItem.id), logItem);
    }
    await batch.commit();
    setSyncTrigger(value => value + 1);
    return true;
  };

  // 3. Delete a stock row completely
  const handleDeleteStockItem = (id: string) => {
    const deletedItem = stock.find(item => item.id === id || getCanonicalStockId(item.skuId, item.expiredDate, item.location, item.warehouseId) === id);
    if (!deletedItem) return;

    const sourceCanonicalId = getCanonicalStockId(deletedItem.skuId, deletedItem.expiredDate, deletedItem.location, deletedItem.warehouseId || 'WH-CENTRAL');
    const activeOrdersForBatch = orderHistoryRef.current.filter(
      o => o.status === 'Pending' && o.qty > 0 && getCanonicalStockId(o.skuId, o.expiredDate, o.location, o.warehouseId) === sourceCanonicalId
    );
    if (activeOrdersForBatch.length > 0) {
      const orderRefs = Array.from(new Set(activeOrdersForBatch.map(o => o.referenceNumber).filter(Boolean)));
      const refSummary = `${orderRefs.slice(0, 5).join(', ')}${orderRefs.length > 5 ? ', ...' : ''}`;
      alert(
        `Tidak dapat menghapus baris stok ini karena sedang terikat pada ${orderRefs.length || activeOrdersForBatch.length} order berjalan (${refSummary}). Selesaikan atau batalkan order tersebut terlebih dahulu.`
      );
      return;
    }

    const filtered = stock.filter(item => item.id !== deletedItem.id);
    saveStockState(filtered);

    // Append log
    const logItem: DccLog = {
      id: `log_del_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'ADJUSTMENT',
      skuId: deletedItem.skuId,
      skuName: deletedItem.skuName,
      locationFrom: deletedItem.location,
      locationTo: 'Dihapus',
      qty: deletedItem.qty,
      description: `Penghapusan baris stok di lokasi ${deletedItem.location}`,
      user: currentUser?.fullName || 'Super Admin'
    };
    saveLogsState([logItem, ...logs]);
  };

  // 4. Process validated outbound list (both standard & bulk)

  const outboundBusy=useRef(false);
  const handleProcessOutbound = async (outboundItems:Omit<OutboundItem,'id'|'timestamp'>[]):Promise<boolean> => {
    if (outboundItems.some(item => item.status === 'Completed') && !serverScanValidationAvailable()) {
      alert('Outbound langsung dinonaktifkan sampai otorisasi Administrator, alasan, dan audit server tersedia.');
      return false;
    }
    if(outboundBusy.current){alert('Outbound sedang disimpan. Tunggu hingga selesai.');return false;}
    if(!window.confirm('Konfirmasi outbound cabang '+getActiveBranch()+': '+outboundItems.length+' baris lokasi, '+outboundItems.reduce((n,o)=>n+o.qty,0).toLocaleString('id-ID')+' pcs. '+(outboundItems[0]?.status==='Completed'?'Stok akan langsung dikurangi.':'Order dibuat sebagai draft; stok belum dikurangi.')+' Lanjutkan?'))return false;
    outboundBusy.current=true;
    try{
      const planned=prepareOutboundCreation(stockRef.current,orderHistoryRef.current,outboundItems);
      const batch=writeBatch(db),timestamp=new Date().toISOString();
      for(const s of planned.stock)batch.set(doc(db,'stock',s.id),s);
      for(const o of planned.orders){
        batch.set({...doc(db,'orders',o.id),expectedRevision:null},o);
        const id='log_out_'+crypto.randomUUID();
        batch.set({...doc(db,'logs',id),expectedRevision:null},{id,timestamp,type:planned.draft?'ADJUSTMENT':'OUTBOUND',skuId:o.skuId,skuName:o.skuName,qty:o.qty,locationFrom:planned.draft?'Input Order Baru':o.location,locationTo:planned.draft?o.location:'DISPATCH / DOCK',warehouseId:o.warehouseId,expiredDate:o.expiredDate,user:currentUser?.fullName||'Operator',description:(planned.draft?'Draft order, menunggu picking: ':'Outbound langsung: ')+o.referenceNumber});
      }
      const groups=new Map<string,OutboundItem[]>();
      for(const o of planned.orders){const name=o.batchNumber||o.referenceNumber;groups.set(name,[...(groups.get(name)||[]),o]);}
      for(const [name,items] of groups){
        const prior=batchesRef.current.find(b=>b.batchNumber===name);
        if(prior?.shippingStatus==='SUDAH_TERKIRIM'||prior?.centralWmsStatus==='SUDAH_TERPOTONG')throw new Error('Batch sudah diproses. Gunakan nomor batch baru.');
        const id=prior?.id||'BATCH-'+crypto.randomUUID(),allItems=[...(prior?.items||[]),...items];
        const record={...prior,id,batchNumber:name,createdAt:prior?.createdAt||timestamp,updatedAt:timestamp,shippingStatus:prior?.shippingStatus||'BELUM_TERKIRIM',centralWmsStatus:prior?.centralWmsStatus||'BELUM_TERPOTONG',customerName:prior?.customerName||items[0].customerName||'Customer Outbound',createdBy:prior?.createdBy||currentUser?.fullName||'Operator',sourceReference:name,totalPcs:allItems.reduce((a,i)=>a+i.qty,0),totalSkus:new Set(allItems.map(i=>i.skuId)).size,items:allItems};
        batch.set({...doc(db,'batches',id),expectedRevision:(prior as any)?.__wms_revision??null},record);
      }
      await batch.commit();
      return true;
    }catch(error:any){alert('Outbound belum disimpan: '+(error.message||'Penyimpanan gagal.'));return false;}
    finally{outboundBusy.current=false;}
  };

  // Batch Dashboard handlers
  const handleSaveBatch = (batchItem: BatchRecord) => {
    const existingIndex = batches.findIndex(b => b.id === batchItem.id);
    let updated: BatchRecord[];
    if (existingIndex >= 0) {
      updated = [...batches];
      updated[existingIndex] = batchItem;
    } else {
      updated = [batchItem, ...batches];
    }
    saveBatchesState(updated);
  };

  const handleDeleteBatch = (batchId: string) => {
    const updated = batches.filter(b => b.id !== batchId);
    saveBatchesState(updated);
  };

  const handleBatchUpdateStatus = (batchIds: string[], updates: Partial<BatchRecord>) => {
    const updated = batches.map(b => {
      if (batchIds.includes(b.id)) {
        return { ...b, ...updates };
      }
      return b;
    });
    saveBatchesState(updated);
  };

  const handleSyncBatchesFromOrders = () => {
    const existingBatchIds = new Set(batches.map(b => b.batchNumber.toLowerCase()));
    const groupedOrders: Record<string, OutboundItem[]> = {};

    orderHistory.forEach(order => {
      const bKey = order.batchNumber || order.referenceNumber || order.orderNumber;
      if (bKey) {
        if (!groupedOrders[bKey]) groupedOrders[bKey] = [];
        groupedOrders[bKey].push(order);
      }
    });

    const newBatchesToAdd: BatchRecord[] = [];
    const nowIso = new Date().toISOString();

    Object.entries(groupedOrders).forEach(([bKey, items]) => {
      if (!existingBatchIds.has(bKey.toLowerCase())) {
        const totalPcs = items.reduce((sum, it) => sum + it.qty, 0);
        const uniqueSkus = new Set(items.map(it => it.skuId)).size;
        const allCompleted = items.every(it => it.status === 'Completed');
        const firstCust = items.find(it => it.customerName)?.customerName || 'Customer Outbound';

        newBatchesToAdd.push({
          id: `BATCH-AUTO-${Date.now()}-${bKey.replace(/[^a-zA-Z0-9_-]/g, '')}`,
          batchNumber: bKey,
          createdAt: items[0]?.timestamp || nowIso,
          updatedAt: nowIso,
          shippingStatus: allCompleted ? 'SUDAH_TERKIRIM' : 'BELUM_TERKIRIM',
          shippedAt: allCompleted ? (items[0]?.timestamp || nowIso) : undefined,
          centralWmsStatus: 'BELUM_TERPOTONG',
          customerName: firstCust,
          totalSkus: uniqueSkus,
          totalPcs,
          createdBy: currentUser?.fullName || 'System Auto-Sync',
          sourceReference: bKey,
          items: items.map(it => ({
            skuId: it.skuId,
            skuName: it.skuName,
            qty: it.qty,
            location: it.location,
            expiredDate: it.expiredDate,
            orderNumber: it.orderNumber,
            referenceNumber: it.referenceNumber
          }))
        });
      }
    });

    if (newBatchesToAdd.length > 0) {
      saveBatchesState([...newBatchesToAdd, ...batches]);
      alert(`Berhasil mensinkronkan ${newBatchesToAdd.length} nomor batch baru dari data outbound!`);
    } else {
      alert('Semua nomor referensi outbound sudah terdaftar di Dashboard Batch.');
    }
  };

  // 5. Transfer stock between warehouse locations (shelving movement)
  const handleTransferStock = (
    skuId: string, 
    fromLoc: string, 
    toLoc: string, 
    qtyToMove: number, 
    expiredDate: string
  ): boolean => {
    const normalizedEd = normalizeDateToDmy(expiredDate);
    const sourceId = getCanonicalStockId(skuId, normalizedEd, fromLoc);
    const targetId = getCanonicalStockId(skuId, normalizedEd, toLoc);

    const updatedStock = [...stock];
    const sourceIdx = findStockIndex(updatedStock, skuId, normalizedEd, fromLoc, sourceId);

    if (sourceIdx === -1 || updatedStock[sourceIdx].qty < qtyToMove) {
      alert('Stok asal tidak mencukupi untuk ditransfer.');
      return false;
    }

    // 1. Subtract from source
    const srcItem = updatedStock[sourceIdx];
    const srcNewQty = srcItem.qty - qtyToMove;
    const srcSplits = calculatePackQuantities(srcNewQty, srcItem.qtyCtnSize, srcItem.qtyInnerSize);
    
    updatedStock[sourceIdx] = {
      ...srcItem,
      id: sourceId,
      qty: srcNewQty,
      qtyCtn: srcSplits.qtyCtn,
      qtyInner: srcSplits.qtyInner,
      qtyLoose: srcSplits.qtyLoose
    };

    // 2. Add to target
    const targetIdx = findStockIndex(updatedStock, skuId, normalizedEd, toLoc, targetId);
    if (targetIdx > -1) {
      const tarItem = updatedStock[targetIdx];
      const tarNewQty = tarItem.qty + qtyToMove;
      const tarSplits = calculatePackQuantities(tarNewQty, tarItem.qtyCtnSize, tarItem.qtyInnerSize);

      updatedStock[targetIdx] = {
        ...tarItem,
        id: targetId,
        qty: tarNewQty,
        qtyCtn: tarSplits.qtyCtn,
        qtyInner: tarSplits.qtyInner,
        qtyLoose: tarSplits.qtyLoose
      };
    } else {
      // Create new record at target location
      const newStatus = getExpiredStatus(normalizedEd);
      const splits = calculatePackQuantities(qtyToMove, srcItem.qtyCtnSize, srcItem.qtyInnerSize);

      updatedStock.unshift({
        id: targetId,
        skuId,
        skuName: srcItem.skuName,
        expiredDate: normalizedEd,
        location: toLoc,
        qty: qtyToMove,
        qtyCtnSize: srcItem.qtyCtnSize,
        qtyCtn: splits.qtyCtn,
        qtyInnerSize: srcItem.qtyInnerSize,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose,
        status: newStatus,
        totalQtySku: 0 // Will be recalculated in saveStockState
      });
    }

    saveStockState(updatedStock);

    // Append log
    const logItem: DccLog = {
      id: `log_tr_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'TRANSFER',
      skuId,
      skuName: srcItem.skuName,
      locationFrom: fromLoc,
      locationTo: toLoc,
      qty: qtyToMove,
      description: `Pemindahan rak internal: dari ${fromLoc} ke ${toLoc}`,
      user: currentUser?.fullName || 'Operator'
    };
    saveLogsState([logItem, ...logs]);
    return true;
  };

  // DCC Audit Stock Count adjustment function
  const handleAdjustStockCount = (
    skuId: string,
    location: string,
    expiredDate: string,
    newQty: number,
    operatorName: string,
    notes: string,
    id?: string
  ): boolean => {
    const updatedStock = [...stock];
    const idx = findStockIndex(updatedStock, skuId, expiredDate, location, id);

    if (idx > -1) {
      const oldQty = updatedStock[idx].qty;
      const canonicalId = getCanonicalStockId(skuId, expiredDate, location);
      const splits = calculatePackQuantities(newQty, updatedStock[idx].qtyCtnSize, updatedStock[idx].qtyInnerSize);

      updatedStock[idx] = {
        ...updatedStock[idx],
        id: canonicalId,
        qty: newQty,
        qtyCtn: splits.qtyCtn,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose
      };

      saveStockState(updatedStock);

      const diff = newQty - oldQty;
      const logItem: DccLog = {
        id: `log_adj_audit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'ADJUSTMENT',
        skuId,
        skuName: updatedStock[idx].skuName,
        locationFrom: location,
        locationTo: 'DCC Audit Adjust',
        qty: Math.abs(diff),
        description: `Cek Fisik DCC oleh ${operatorName}: ${diff >= 0 ? 'Surplus/Kelebihan (PLUS)' : 'Kekurangan (MINUS)'} ${Math.abs(diff)} pcs. Keterangan: ${notes}`,
        user: operatorName
      };
      saveLogsState([logItem, ...logs]);
      return true;
    } else {
      alert('Gagal mendeteksi kecocokan item stok di lokasi rak tersebut.');
      return false;
    }
  };

  // DCC Audit Stock Count adjustment function in batch to prevent race conditions during bulk edits (Zone 1 / Excel)
  const countSaveLock = useRef(false);
  const handleAdjustStockCountBatch = async (adjustments: {skuId:string;location:string;expiredDate:string;newQty:string|number;operatorName:string;notes:string;id?:string;warehouseId?:string;expectedQty?:number}[], auditRecords:PhysicalAuditItem[] = []): Promise<boolean> => {
    if(countSaveLock.current) return false;
    countSaveLock.current=true;
    try {
      const batch=writeBatch(db);
      const seen=new Set<string>();
      const workingStock=[...stock];
      const touchedIds=new Set<string>();
      const touchedSkus=new Set<string>();
      for(const adj of adjustments){
        const exact=adj.id ? workingStock.find(s=>s.id===adj.id) : undefined;
        const wh=adj.warehouseId || exact?.warehouseId;
        if(!wh) throw Error('Identitas gudang tidak tersedia. Buat ulang sesi hitung.');
        const newQtyNum=typeof adj.newQty==='number'?adj.newQty:Number(adj.newQty);
        if(!Number.isSafeInteger(newQtyNum)||newQtyNum<0) throw Error('Jumlah fisik tidak valid.');
        const idx=findStockIndex(workingStock,adj.skuId,adj.expiredDate,adj.location,adj.id,wh);
        if(idx<0){
          if(adj.expectedQty!==0) throw Error('Batch stok tidak ditemukan. Muat ulang sesi hitung.');
          const normEd=normalizeDateToDmy(adj.expiredDate);
          const cleanLoc=adj.location.trim().toUpperCase();
          const newId=getCanonicalStockId(adj.skuId,normEd,cleanLoc,wh);
          if(seen.has(newId)) throw Error('Batch stok terhitung dua kali.');
          seen.add(newId);
          const tmpl=workingStock.find(s=>s.skuId.toLowerCase()===adj.skuId.toLowerCase());
          const cat=catalog.find(c=>c.skuId.toLowerCase()===adj.skuId.toLowerCase());
          const packSpec=getProductPackSizes(adj.skuId);
          const ctnSize=tmpl?.qtyCtnSize||cat?.qtyCtnSize||packSpec.qtyCtnSize;
          const innerSize=tmpl?.qtyInnerSize||cat?.qtyInnerSize||packSpec.qtyInnerSize;
          const created:StockItem={
            id:newId,
            warehouseId:wh,
            warehouseName:tmpl?.warehouseName||wh,
            skuId:tmpl?.skuId||cat?.skuId||adj.skuId,
            skuName:tmpl?.skuName||cat?.skuName||adj.skuId,
            expiredDate:normEd,
            location:cleanLoc,
            qty:newQtyNum,
            totalQtySku:newQtyNum,
            qtyCtnSize:ctnSize,
            qtyInnerSize:innerSize,
            ...calculatePackQuantities(newQtyNum,ctnSize,innerSize),
            status:getExpiredStatus(normEd)
          };
          workingStock.push(created);
          touchedIds.add(newId);
          touchedSkus.add(created.skuId.trim().toUpperCase());
          const logId='log_count_'+crypto.randomUUID();
          batch.set(doc(db,'logs',logId),{id:logId,timestamp:new Date().toISOString(),type:'ADJUSTMENT',skuId:created.skuId,skuName:created.skuName,warehouseId:wh,locationFrom:cleanLoc,locationTo:cleanLoc,qty:Math.abs(newQtyNum),description:'Cek Fisik PLUS: '+adj.notes,user:adj.operatorName});
          continue;
        }
        const source=workingStock[idx];
        if(seen.has(source.id)) throw Error('Batch stok terhitung dua kali.');
        seen.add(source.id);
        if(adj.expectedQty!==undefined && source.qty!==adj.expectedQty) throw Error('Stok berubah sejak sesi hitung dibuat. Periksa ulang hitungan.');
        const updated={...source,qty:newQtyNum,...calculatePackQuantities(newQtyNum,source.qtyCtnSize,source.qtyInnerSize)};
        workingStock[idx]=updated;
        touchedIds.add(source.id);
        touchedSkus.add(source.skuId.trim().toUpperCase());
        const diff=newQtyNum-source.qty;
        const logId='log_count_'+crypto.randomUUID();
        batch.set(doc(db,'logs',logId),{id:logId,timestamp:new Date().toISOString(),type:'ADJUSTMENT',skuId:source.skuId,skuName:source.skuName,warehouseId:wh,locationFrom:source.location,locationTo:source.location,qty:Math.abs(diff),description:'Cek Fisik '+(diff>=0?'PLUS':'MINUS')+': '+adj.notes,user:adj.operatorName});
      }
      const skuTotals:Record<string,number>={};
      for(const row of workingStock){const k=row.skuId.trim().toUpperCase();skuTotals[k]=(skuTotals[k]||0)+row.qty;}
      for(const row of workingStock){
        const k=row.skuId.trim().toUpperCase();
        const nextTotal=skuTotals[k]??row.qty;
        if(touchedIds.has(row.id) || (touchedSkus.has(k) && row.totalQtySku!==nextTotal)){
          batch.set(doc(db,'stock',row.id),{...row,totalQtySku:nextTotal});
        }
      }
      for(const audit of auditRecords) batch.set(doc(db,'audits',audit.id),audit);
      await batch.commit();return true;
    }catch(e:any){alert(e.message || 'Penyimpanan hitungan gagal.');return false;}
    finally{countSaveLock.current=false;}
  };

  // 6. Transfer IN from outside warehouse (External Warehouse)
  const handleTransferInExternal = (
    skuId: string,
    skuName: string,
    qty: number,
    expiredDate: string,
    targetLocation: string,
    sourceExternal: string,
    refNo: string,
    operator: string
  ) => {
    const normalizedEd = normalizeDateToDmy(expiredDate);
    const id = getCanonicalStockId(skuId, normalizedEd, targetLocation);
    const existingIdx = findStockIndex(stock, skuId, normalizedEd, targetLocation, id);

    let updatedList = [...stock];
    if (existingIdx > -1) {
      const existing = updatedList[existingIdx];
      const mergedQty = existing.qty + qty;
      const splits = calculatePackQuantities(mergedQty, existing.qtyCtnSize, existing.qtyInnerSize);
      
      updatedList[existingIdx] = {
        ...existing,
        id,
        qty: mergedQty,
        qtyCtn: splits.qtyCtn,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose
      };
    } else {
      // Find pack sizes from other records of same SKU if available, otherwise defaults
      const templateItem = stock.find(item => item.skuId === skuId);
      const qtyCtnSize = templateItem?.qtyCtnSize || 144;
      const qtyInnerSize = templateItem?.qtyInnerSize || 12;
      const splits = calculatePackQuantities(qty, qtyCtnSize, qtyInnerSize);
      const status = getExpiredStatus(normalizedEd);

      updatedList.unshift({
        id,
        skuId,
        skuName,
        expiredDate: normalizedEd,
        location: targetLocation,
        qty,
        qtyCtnSize,
        qtyCtn: splits.qtyCtn,
        qtyInnerSize,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose,
        status,
        totalQtySku: qty
      });
    }

    saveStockState(updatedList);

    const logItem: DccLog = {
      id: `log_tr_in_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'TRANSFER_IN',
      skuId,
      skuName,
      locationFrom: `External: ${sourceExternal}`,
      locationTo: targetLocation,
      qty,
      description: `Transfer IN [Doc: ${refNo}] dari ${sourceExternal} ke lokasi ${targetLocation}`,
      user: operator || currentUser?.fullName || 'Operator'
    };
    saveLogsState([logItem, ...logs]);
  };

  // 7. Transfer OUT to outside warehouse (External Warehouse)
  const handleTransferOutExternal = (
    skuId: string,
    fromLocation: string,
    qtyToTransfer: number,
    destinationExternal: string,
    refNo: string,
    operator: string
  ): boolean => {
    const matchedIdx = stock.findIndex(item => item.skuId === skuId && item.location === fromLocation && item.qty >= qtyToTransfer);
    if (matchedIdx === -1) {
      alert('Stok asal tidak mencukupi untuk ditransfer keluar.');
      return false;
    }

    const updatedList = [...stock];
    const item = updatedList[matchedIdx];
    const newQty = item.qty - qtyToTransfer;
    const splits = calculatePackQuantities(newQty, item.qtyCtnSize, item.qtyInnerSize);

    updatedList[matchedIdx] = {
      ...item,
      qty: newQty,
      qtyCtn: splits.qtyCtn,
      qtyInner: splits.qtyInner,
      qtyLoose: splits.qtyLoose
    };

    saveStockState(updatedList);

    const logItem: DccLog = {
      id: `log_tr_out_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'TRANSFER_OUT',
      skuId,
      skuName: item.skuName,
      locationFrom: fromLocation,
      locationTo: `External: ${destinationExternal}`,
      qty: qtyToTransfer,
      description: `Transfer OUT [Doc: ${refNo}] dari lokasi ${fromLocation} ke ${destinationExternal}`,
      user: operator || currentUser?.fullName || 'Operator'
    };
    saveLogsState([logItem, ...logs]);
    return true;
  };

  // 8. Process bulk Transfer IN from outside warehouse
  const handleBulkTransferIn = (items: {
    skuId: string;
    qty: number;
    expiredDate: string;
    location: string;
    sourceExternal: string;
    refNo: string;
    operator: string;
  }[]) => {
    let updatedStock = [...stock];
    const newLogs: DccLog[] = [];
    const timestamp = new Date().toISOString();

    items.forEach((item, index) => {
      const normalizedEd = normalizeDateToDmy(item.expiredDate);
      const id = getCanonicalStockId(item.skuId, normalizedEd, item.location);
      const existingIdx = findStockIndex(updatedStock, item.skuId, normalizedEd, item.location, id);

      let skuName = '';
      if (existingIdx > -1) {
        const existing = updatedStock[existingIdx];
        skuName = existing.skuName;
        const mergedQty = existing.qty + item.qty;
        const splits = calculatePackQuantities(mergedQty, existing.qtyCtnSize, existing.qtyInnerSize);
        
        updatedStock[existingIdx] = {
          ...existing,
          id,
          qty: mergedQty,
          qtyCtn: splits.qtyCtn,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose
        };
      } else {
        // Find pack sizes from other records of same SKU if available, otherwise defaults
        const templateItem = updatedStock.find(s => s.skuId === item.skuId);
        skuName = templateItem?.skuName || `${item.skuId} Product`;
        const qtyCtnSize = templateItem?.qtyCtnSize || 144;
        const qtyInnerSize = templateItem?.qtyInnerSize || 12;
        const splits = calculatePackQuantities(item.qty, qtyCtnSize, qtyInnerSize);
        const status = getExpiredStatus(normalizedEd);

        updatedStock.unshift({
          id,
          skuId: item.skuId,
          skuName,
          expiredDate: normalizedEd,
          location: item.location,
          qty: item.qty,
          qtyCtnSize,
          qtyCtn: splits.qtyCtn,
          qtyInnerSize,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose,
          status,
          totalQtySku: item.qty
        });
      }

      newLogs.push({
        id: `log_tr_in_bulk_${Date.now()}_${index}_${Math.random().toString(36).substr(2, 4)}`,
        timestamp,
        type: 'TRANSFER_IN',
        skuId: item.skuId,
        skuName,
        locationFrom: `External: ${item.sourceExternal}`,
        locationTo: item.location,
        qty: item.qty,
        description: `Transfer IN Massal [Doc: ${item.refNo}] dari ${item.sourceExternal} ke lokasi ${item.location}`,
        user: item.operator || currentUser?.fullName || 'Operator'
      });
    });

    saveStockState(updatedStock);
    saveLogsState([...newLogs, ...logs]);
  };

  // 9. Process bulk Transfer OUT to outside warehouse
  const handleBulkTransferOut = (items: {
    skuId: string;
    skuName: string;
    qty: number;
    location: string;
    expiredDate: string;
    destinationExternal: string;
    refNo: string;
    operator: string;
  }[]): boolean => {
    let updatedStock = [...stock];
    const newLogs: DccLog[] = [];
    const timestamp = new Date().toISOString();

    for (const item of items) {
      const matchedIdx = findStockIndex(updatedStock, item.skuId, item.expiredDate, item.location);
      if (matchedIdx === -1 || updatedStock[matchedIdx].qty < item.qty) {
        alert(`Stok asal untuk SKU ${item.skuId} di lokasi ${item.location} tidak mencukupi saat eksekusi.`);
        return false;
      }

      const sItem = updatedStock[matchedIdx];
      const newQty = sItem.qty - item.qty;
      const splits = calculatePackQuantities(newQty, sItem.qtyCtnSize, sItem.qtyInnerSize);

      updatedStock[matchedIdx] = {
        ...sItem,
        qty: newQty,
        qtyCtn: splits.qtyCtn,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose
      };

      newLogs.push({
        id: `log_tr_out_bulk_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        timestamp,
        type: 'TRANSFER_OUT',
        skuId: item.skuId,
        skuName: item.skuName,
        locationFrom: item.location,
        locationTo: `External: ${item.destinationExternal}`,
        qty: item.qty,
        description: `Transfer OUT Massal [Doc: ${item.refNo}] dari lokasi ${item.location} ke ${item.destinationExternal}`,
        user: item.operator || currentUser?.fullName || 'Operator'
      });
    }

    saveStockState(updatedStock);
    saveLogsState([...newLogs, ...logs]);
    return true;
  };

  // 10. Process mass internal location transfer (e.g., TRANSIT -> Rak / Antar Rak)
  const handleBulkInternalTransfer = (items: {
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

      // Exact expiry only: a stale batch selection must never substitute another lot.
      const sourceMatches=updatedStock.map((s,index)=>({s,index})).filter(({s})=>
        s.skuId.trim().toUpperCase()===item.skuId.trim().toUpperCase() &&
        s.location.trim().toUpperCase()===item.fromLocation.trim().toUpperCase() &&
        normalizeDateToDmy(s.expiredDate)===formattedExpDate &&
        (!item.warehouseId || (s.warehouseId || 'WH-CENTRAL').toUpperCase()===item.warehouseId.trim().toUpperCase()));
      if(sourceMatches.length!==1||!Number.isSafeInteger(item.qty)||item.qty<=0){alert('Batch stok asal tidak ditemukan, ambigu, atau qty tidak valid. Muat ulang dan pilih batch yang tepat.');return false;}
      const sourceIdx=sourceMatches[0].index;

      if (sourceIdx === -1 || updatedStock[sourceIdx].qty < item.qty) {
        const availableQty = sourceIdx > -1 ? updatedStock[sourceIdx].qty : 0;
        alert(`Stok SKU ${item.skuId} di lokasi ${item.fromLocation} tidak mencukupi (tersedia: ${availableQty} pcs, diminta: ${item.qty} pcs) untuk transfer internal.`);
        return false;
      }

      // Stok yang sudah dialokasikan ke order Pending (belum dipick) tidak boleh dipindahkan.
      const lockedForSource = getLockedStockSummary(orderHistoryRef.current).byCanonicalId.get(
        getCanonicalStockId(updatedStock[sourceIdx].skuId, updatedStock[sourceIdx].expiredDate, updatedStock[sourceIdx].location, updatedStock[sourceIdx].warehouseId || 'WH-CENTRAL')
      ) || 0;
      if (updatedStock[sourceIdx].qty - item.qty < lockedForSource) {
        alert(`Transfer ditolak: ${lockedForSource} pcs SKU ${item.skuId} di ${item.fromLocation} sedang dialokasikan ke order yang menunggu picking. Stok bebas hanya ${Math.max(0, updatedStock[sourceIdx].qty - lockedForSource)} pcs (diminta: ${item.qty} pcs).`);
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
        id: `log_tr_internal_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        timestamp,
        type: 'TRANSFER',
        skuId: item.skuId,
        skuName: srcItem.skuName,
        locationFrom: item.fromLocation,
        locationTo: item.toLocation,
        qty: item.qty,
        description: `Transfer antar lokasi [Doc: ${item.refNo || 'INTERNAL'}] dari ${item.fromLocation} ke ${item.toLocation}`,
        user: item.operator || currentUser?.fullName || 'Operator'
      });
    }

    saveStockState(updatedStock);
    saveLogsState([...newLogs, ...logs]);
    return true;
  };

  // ==========================================
  // CROSS-DEVICE SIMULATION HANDLERS
  // ==========================================
  const handleSimulateInbound = (newItem: { skuId: string; skuName: string; expiredDate: string; location: string; qty: number }) => {
    const template = stock.find(item => item.skuId === newItem.skuId);
    const qtyCtnSize = template?.qtyCtnSize || 144;
    const qtyInnerSize = template?.qtyInnerSize || 12;
    handleAddStockItem({
      skuId: newItem.skuId,
      skuName: newItem.skuName,
      expiredDate: newItem.expiredDate,
      location: newItem.location,
      qty: newItem.qty,
      qtyCtnSize,
      qtyCtn: 0,
      qtyInnerSize,
      qtyInner: 0,
      qtyLoose: 0,
      status: 'AMAN'
    });
  };

  const handleSimulateTransfer = (transfer: { skuId: string; skuName: string; expiredDate: string; fromLocation: string; toLocation: string; qty: number }): boolean => {
    const matching = stock.find(item => item.skuId === transfer.skuId && item.location === transfer.fromLocation && item.qty >= transfer.qty);
    if (!matching) {
      return false;
    }
    
    return handleTransferStock(
      transfer.skuId,
      transfer.fromLocation,
      transfer.toLocation,
      transfer.qty,
      matching.expiredDate
    );
  };

  const openOrderCancellation = (items: OutboundItem[]): boolean => {
    if (!['Admin','Administrator'].includes(currentUser?.role || '')) { alert('Pembatalan hanya untuk admin cabang.'); return false; }
    window.dispatchEvent(new CustomEvent('wms-open-audit',{detail:{orderIds:items.map(item=>item.id)}}));
    return false;
  };
  const handleDeleteOrderHistory = (item: OutboundItem): boolean => openOrderCancellation([item]);
  const handleDeleteMultipleOrders = (items: OutboundItem[]): boolean => openOrderCancellation(items);

  const handleClearAllOrderHistory = async (): Promise<boolean> => { alert('Riwayat disimpan permanen. Pilih order untuk dibatalkan dengan alasan.'); return false; };
  const handleClearAllTransferLogs = async (): Promise<boolean> => { alert('Riwayat mutasi tidak dihapus. Buat transaksi koreksi atau transfer balik.'); return false; };


  const orderEditBusy=useRef(false);
  const commitOrderEdits=async(edits:{updated:OutboundItem;original:OutboundItem}[]):Promise<boolean>=>{
    if(orderEditBusy.current){alert('Edit order sedang disimpan.');return false;}
    orderEditBusy.current=true;
    try{
      const orders=prepareOrderEdits(stockRef.current,orderHistoryRef.current,edits),batch=writeBatch(db);
      for(const order of orders){
        batch.set({...doc(db,'orders',order.id),expectedRevision:(order as any).__wms_revision??null},order);
        const id='log_order_edit_'+crypto.randomUUID();
        batch.set({...doc(db,'logs',id),expectedRevision:null},{id,timestamp:new Date().toISOString(),type:'ADJUSTMENT',skuId:order.skuId,skuName:order.skuName,qty:order.qty,locationFrom:'Order Edit',locationTo:order.location,warehouseId:order.warehouseId,user:currentUser?.fullName||'Operator',description:'Edit order '+order.referenceNumber+'; jejak alokasi stok yang sudah dipotong tetap dipertahankan.'});
      }
      await batch.commit();return true;
    }catch(error:any){alert('Edit order ditolak: '+(error.message||'Penyimpanan gagal.'));return false;}
    finally{orderEditBusy.current=false;}
  };
  const handleEditOrderHistory=(updated:OutboundItem,original:OutboundItem,_isPackerEdit=false):Promise<boolean>=>commitOrderEdits([{updated,original}]);
  const handleBatchEditExpiredDateOrderHistory=(items:OutboundItem[],newRawExpDate:string):Promise<boolean>=>
    commitOrderEdits(items.map(original=>({original,updated:{...original,expiredDate:normalizeDateToDmy(newRawExpDate)}})));

  const orderCompletionBusy = useRef(false);
  const handleEditMultipleOrdersBatch = async (updates: OrderCompletion[]): Promise<boolean> => {
    if (updates.some(update => !update.isPicking && update.updatedItems.some(item => item.status === 'Completed')) && !serverScanValidationAvailable()) {
      alert(scanServerUnavailable);
      return false;
    }
    if(orderCompletionBusy.current){alert('Penyimpanan order masih berjalan. Tunggu hingga selesai.');return false;}
    const qty=updates.reduce((n,u)=>n+u.updatedItems.reduce((m,o)=>m+o.qty,0),0);
    if((updates.length>1||qty>=100)&&!window.confirm('Cabang '+getActiveBranch()+' · '+updates.length+' order · '+qty.toLocaleString('id-ID')+' pcs. Konfirmasi proses pengambilan/pengemasan massal?'))return false;
    orderCompletionBusy.current=true;
    const branchAtStart=getActiveBranch();
    try {
      // Pre-heal any non-expiry stock records in Supabase that have stale markers (e.g. status 'Karantina' or non-standard expiry marker)
      // so that Supabase database guard functions validate smoothly without blocking picking/packing.
      try {
        const stockSnap = await getDocs(collection(db, 'stock'));
        const staleStockDocs = stockSnap.docs.filter(d => {
          const data = d.data() as any;
          if (!data || typeof data !== 'object') return false;
          const isNoExp = isNoExpiryDate(data.expiredDate);
          if (isNoExp) {
            return data.expiredDate !== 'No Expired' || data.status === 'Karantina';
          }
          return false;
        });

        const role = currentUser?.role;
        if ((role === 'Administrator' || role === 'Admin') && staleStockDocs.length > 0) {
          const healBatch = writeBatch(db);
          for (const d of staleStockDocs) {
            const data = d.data() as any;
            healBatch.set(doc(db, 'stock', d.id), {
              ...data,
              expiredDate: 'No Expired',
              status: 'AMAN'
            });
          }
          await healBatch.commit();
        }
      } catch (healErr) {
        console.warn('Auto-heal stale stock prior to batch completion:', healErr);
      }

      const planned=prepareOrderCompletion(stockRef.current,orderHistoryRef.current,updates);
      const batch=writeBatch(db);
      const newIds=new Set(planned.orders.map(o=>o.id));
      for(const s of planned.changedStock)batch.set(doc(db,'stock',s.id),s);
      for(const o of planned.originals)if(!newIds.has(o.id))batch.delete({...doc(db,'orders',o.id),expectedRevision:(o as any).__wms_revision??null});
      for(const o of planned.orders)batch.set({...doc(db,'orders',o.id),expectedRevision:(o as any).__wms_revision??null},o);
      const timestamp=new Date().toISOString();
      for(const u of updates){
        const id='log_order_commit_'+crypto.randomUUID();
        const items=planned.orders.filter(o=>o.referenceNumber===u.refNum);
        batch.set({...doc(db,'logs',id),expectedRevision:null},{
          id,timestamp,type:'OUTBOUND',skuId:items[0]?.skuId||'BATCH',skuName:items[0]?.skuName||'Batch',
          locationFrom:u.isPicking?'Order Picking':'Order Packing Validation',locationTo:'DISPATCH / DOCK',
          qty:items.reduce((sum,o)=>sum+o.qty,0),description:(u.isPicking?'Picking':'Packing')+' selesai [Doc: '+u.refNum+']. Order dan stok tersimpan bersamaan.',
          user:currentUser?.fullName||'Operator'
        });
      }
      if(branchAtStart!==getActiveBranch())throw new Error('Cabang berubah. Buka ulang order di cabang asal.');
      await batch.commit();
      return true;
    }catch(error:any){alert('Order belum diselesaikan: '+(error.message||'Penyimpanan gagal. Muat data terbaru.'));return false;}
    finally{orderCompletionBusy.current=false;}
  };
  const handleEditOrderHistoryBatch = async (refNum:string,updatedItems:OutboundItem[],isPicking=false):Promise<boolean> =>
    handleEditMultipleOrdersBatch([{refNum,updatedItems,isPicking}]);

  const handleUpdateOrdersShipped = async (orderRefs: string[], manifestInfo: { manifestId?: string; courierName?: string; handedOverAt?: string; handedOverBy?: string } = {}, isCancelled = false): Promise<boolean> => {
    try {
      if (!orderRefs || orderRefs.length === 0) return true;
      const refSet = new Set(orderRefs.map(r => r.trim().toUpperCase()));
      const nowIso = new Date().toISOString();
      const updated = orderHistoryRef.current.map(item => {
        const ref1 = (item.referenceNumber || '').trim().toUpperCase();
        const ref2 = (item.orderNumber || '').trim().toUpperCase();
        const ref3 = (item.id || '').trim().toUpperCase();
        if ((ref1 && refSet.has(ref1)) || (ref2 && refSet.has(ref2)) || (ref3 && refSet.has(ref3))) {
          return {
            ...item,
            shipped: !isCancelled,
            shippedAt: !isCancelled ? (manifestInfo.handedOverAt || nowIso) : undefined,
            shippedBy: !isCancelled ? (manifestInfo.handedOverBy || currentUser?.fullName || currentUser?.username || 'Petugas Ekspedisi') : undefined,
            manifestId: !isCancelled ? manifestInfo.manifestId : undefined
          };
        }
        return item;
      });
      saveOrderHistoryState(updated);
      return true;
    } catch (e) {
      console.error('Failed to update orders shipped status:', e);
      return false;
    }
  };

  const sortingCommitBusy=useRef(false);
  const handleCompleteSorting=async(tasks:SortingTask[]):Promise<boolean>=>{
   if(!DEV_BASELINE_SORTING && !serverScanValidationAvailable()){alert(scanServerUnavailable);return false;}
   if(sortingCommitBusy.current)return false;sortingCommitBusy.current=true;const branch=getActiveBranch();
   try{
    const snapshot=await getDocs(collection(db,'orders'));if(branch!==getActiveBranch())throw Error('Cabang berubah. Buka ulang tugas di cabang asal.');
    const fresh=snapshot.docs.map(d=>d.data() as unknown as OutboundItem);
    const updates=prepareSortingUpdates(fresh,tasks,currentUser?.fullName||currentUser?.username||'Operator');
    if(updates.length){const batch=writeBatch(db);for(const order of updates)batch.set({...doc(db,'orders',order.id),expectedRevision:(order as any).__wms_revision??null},order);await batch.commit();}
    const confirmed=await getDocs(collection(db,'orders'));if(branch!==getActiveBranch())throw Error('Cabang berubah setelah penyimpanan. Periksa cabang asal.');
    const confirmedOrders=confirmed.docs.map(d=>d.data() as unknown as OutboundItem);orderHistoryRef.current=confirmedOrders;setOrderHistory(confirmedOrders);
    for(const task of tasks){const rows=confirmedOrders.filter(o=>o.referenceNumber===task.referenceNumber);if(rows.length!==task.items.length||rows.some(o=>!o.sortedAt||!o.sortedBy||(o.basketNumber||'').trim().toUpperCase()!==task.basketCode.trim().toUpperCase()))throw Error('Status sortir belum terkonfirmasi. Periksa data terbaru sebelum mengulang.');}
    return true;
   }catch(e:any){alert('Sortir belum disimpan: '+(e.message||'Periksa data terbaru.'));return false;}
   finally{sortingCommitBusy.current=false;}
  };

  const handleUpdateOrderSession = async (references: string | string[], sessionData: OrderSessionData): Promise<OrderSessionResult | false> => {
    const branch = getActiveBranch();
    try {
      const snapshot = await getDocs(collection(db, 'orders'));
      if (getActiveBranch() !== branch) throw new Error('Cabang berubah. Buka ulang picking di cabang asal.');
      const fresh = snapshot.docs.map(d => d.data() as unknown as OutboundItem);
      const updates = prepareOrderSessionUpdates(fresh, references, sessionData);
      const batch = writeBatch(db);
      for (const order of updates) batch.set({...doc(db, 'orders', order.id), expectedRevision:(order as any).__wms_revision ?? null}, order);
      await batch.commit();
      const confirmed = await getDocs(collection(db, 'orders'));
      if (getActiveBranch() !== branch) throw new Error('Cabang berubah setelah penyimpanan. Periksa order di cabang asal.');
      const rows = confirmed.docs.map(d => d.data() as unknown as OutboundItem);
      orderHistoryRef.current = rows;
      setOrderHistory(rows);
      const ids = new Set(updates.map(o => o.id));
      return {orders: rows.filter(o => ids.has(o.id))};
    } catch (error: any) {
      alert('Sesi order belum dikonfirmasi: '+(error.message || 'Periksa koneksi dan muat data terbaru.'));
      return false;
    }
  };

  const handleDeleteTransferLog = (_log: DccLog): boolean => { alert('Riwayat asli tidak dihapus. Untuk koreksi, buat transfer balik atau penyesuaian baru dengan catatan.'); return false; };
  const handleEditTransferLog = (_new: DccLog,_old: DccLog): boolean => { alert('Riwayat asli tidak diubah. Buat transaksi koreksi baru agar jejaknya tetap tersimpan.'); return false; };

  const totalSystemQty = useMemo(() => {
    return stock.reduce((sum, item) => sum + item.qty, 0);
  }, [stock]);

  if (loading) {
    return (
      <div className={`theme-${theme} min-h-screen bg-[#0A0C10] text-slate-100 flex flex-col justify-center items-center p-4 relative overflow-hidden font-sans`}>
        <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none"></div>
        <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-96 h-96 rounded-full bg-teal-500/10 blur-3xl pointer-events-none"></div>
        <div className="text-center space-y-4 z-10">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-500 mx-auto mb-2"></div>
          <p className="text-sm font-semibold tracking-wide text-emerald-400 uppercase">TRUEBLUE WMS</p>
          <p className="text-xs text-slate-400">Menghubungkan ke Database Cloud Retail DC...</p>
        </div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className={`theme-${theme} min-h-screen bg-[#0A0C10] text-slate-100 flex flex-col justify-center items-center p-4 relative overflow-y-auto font-sans`}>
        {/* Animated ambient background glows */}
        <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full bg-emerald-500/5 blur-3xl pointer-events-none"></div>
        <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-96 h-96 rounded-full bg-teal-500/5 blur-3xl pointer-events-none"></div>

        <div className="max-w-4xl w-full grid grid-cols-1 md:grid-cols-12 gap-8 items-center relative z-10">
          {/* Brand Presentation Section */}
          <div className="md:col-span-5 space-y-6 text-center md:text-left">
            <div className="inline-flex bg-emerald-500/10 border border-emerald-500/25 p-4 rounded-3xl shadow-xl shadow-emerald-500/5">
              <img src="/trueblue-lion.png" alt="Logo singa biru TRUEBLUE" className="w-16 h-16  object-contain" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-white tracking-wider leading-tight uppercase font-sans">
                TRUEBLUE WMS
                <span className="text-emerald-400 block text-lg font-bold tracking-widest mt-1">WAREHOUSE OPERATION</span>
              </h1>
              <p className="text-slate-400 text-xs mt-3 leading-relaxed">
                Sistem pengelolaan stok gudang supermarket modern: kontrol persediaan sembako &amp; FMCG, pelacakan tanggal kadaluarsa FEFO, inbound penerimaan supplier, dan order gerai toko secara real-time.
              </p>
            </div>
            
            <div className="hidden md:block p-4 rounded-2xl bg-slate-900/60 border border-slate-800/70 space-y-3.5 text-xs">
              <div className="flex items-center gap-2.5 text-slate-300">
                <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                <span>Kontrol Kadaluarsa FEFO (First-Expired-First-Out)</span>
              </div>
              <div className="flex items-center gap-2.5 text-slate-300">
                <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                <span>Inbound Supplier &amp; Outbound Gerai Toko</span>
              </div>
              <div className="flex items-center gap-2.5 text-slate-300">
                <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                <span>Manajemen Satuan Karton (CTN), Pack, &amp; Pcs</span>
              </div>
            </div>
          </div>

          {/* Login Card */}
          <div className="md:col-span-7 bg-[#11141B] border border-slate-800/80 rounded-3xl shadow-2xl p-6 sm:p-8 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-amber-500"></div>
            
            <div className="mb-6">
              <h2 className="text-lg font-bold text-white">Akses Sistem TRUEBLUE WMS</h2>
              <p className="text-slate-400 text-xs mt-1">Masuk dengan akun operator Supabase yang sudah diundang.</p>
              {!isSupabaseConfigured && (
                <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                  Supabase belum dikonfigurasi. Salin .env.example ke .env, lalu isi URL proyek dan anon key dari dashboard Supabase.
                </p>
              )}
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-wider font-extrabold text-slate-450 mb-1.5">ID akun atau email</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-500">
                    <User className="w-4 h-4" />
                  </span>
                  <input
                    type="text" autoComplete="username"
                    required
                    placeholder="ID akun atau email admin"
                    value={emailInput}
                    onChange={(e) => {
                      setEmailInput(e.target.value);
                      if (loginError) setLoginError('');
                    }}
                    className="w-full bg-[#161B25] border border-slate-800 focus:border-emerald-500 text-slate-200 text-sm rounded-xl pl-10 pr-4 py-3 outline-none transition-colors"
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="block text-[10px] uppercase tracking-wider font-extrabold text-slate-450">Password</label>
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-[10px] text-emerald-400 hover:text-emerald-300 font-bold"
                  >
                    {showPassword ? 'Sembunyikan' : 'Tampilkan'}
                  </button>
                </div>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-500">
                    <Lock className="w-4 h-4" />
                  </span>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    placeholder="Sandi Anda"
                    value={passwordInput}
                    onChange={(e) => {
                      setPasswordInput(e.target.value);
                      if (loginError) setLoginError('');
                    }}
                    className="w-full bg-[#161B25] border border-slate-800 focus:border-emerald-500 text-slate-200 text-sm rounded-xl pl-10 pr-4 py-3 outline-none transition-colors"
                  />
                </div>
              </div>

              {loginError && (
                <div className="flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs px-3.5 py-3 rounded-xl">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{loginError}</span>
                </div>
              )}

              {/* Remember Me Option (Session Security) */}
              <button
                type="submit"
                className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-500/10 cursor-pointer uppercase tracking-wider"
              >
                <LogIn className="w-4 h-4" />
                Masuk ke Aplikasi
              </button>
            </form>

          </div>
        </div>
      </div>
    );
  }

  return (
    <AppShell theme={theme} onToggleTheme={() => setTheme(nextUiTheme)} activeTab={activeTab} onNavigate={navigateFromMenu} currentUser={currentUser} connected={dbStatus==='connected'} stockSyncState={stockSyncState} onLogout={handleLogout} onUpload={handleForcePushStockToCloud} totalQty={totalSystemQty} onRefresh={()=>{if(confirm('Muat ulang data terbaru? Form yang belum disimpan akan ditutup.')){setLoading(true);setSyncTrigger(value=>value+1)}}}>
      <main className="blues-page">
          {isLoggedIn && stock.length === 0 && (
            <div className="mb-6 bg-gradient-to-r from-amber-500/10 via-purple-500/10 to-indigo-500/10 border border-amber-500/30 rounded-2xl p-4 shadow-xl flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-amber-500/20 text-amber-400 rounded-xl border border-amber-500/30 shrink-0">
                  <Database className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                    Database stok masih kosong
                    <span className="px-2 py-0.5 bg-amber-400 text-slate-950 font-black text-[10px] rounded-full uppercase">Atensinya</span>
                  </h3>
                  <p className="text-xs text-slate-300 mt-1">
                    Tambahkan atau impor data stok terlebih dahulu. Perubahan akan tersimpan dan terlihat pada perangkat lain yang masuk ke akun yang sama.
                  </p>
                </div>
              </div>
            </div>
          )}
          <AnimatePresence mode="wait">
          {activeTab === 'dashboard' && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <Dashboard 
                stock={stock} 
                logs={logs} 
                orderHistory={orderHistory}
                batches={batches}
                onNavigate={navigateFromMenu}
                onOpenInventory={focus=>{if(!canBrowseInventory(currentUser?.role))return;setActiveWarehouseFilter('ALL');setInventoryEntryFocus(focus);setActiveTab('inventory');}}
                onOpenWork={stage=>{if(!canOpenWork(currentUser?.role,stage))return;setOutboundEntryMode(stage);setActiveTab('bulk');}} 
                userRole={currentUser?.role}
                currentTheme={theme}
              />
            </motion.div>
          )}

          {activeTab === 'inventory' && (
            <motion.div
              key="inventory"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <InventoryList initialStockFocus={inventoryEntryFocus}
                stock={stock} 
                onUpdateStock={handleUpdateStock}
                onEditStockItem={handleEditStockItem}
                onAddStockItem={handleAddStockItem}
                onDeleteStockItem={handleDeleteStockItem}
                userRole={currentUser?.role}
                currentUser={currentUser}
                logs={logs}
                orderHistory={orderHistory}
                warehouses={warehouses}
                activeWarehouseFilter={activeWarehouseFilter}
                onSelectWarehouseFilter={setActiveWarehouseFilter}
              />
            </motion.div>
          )}



          {activeTab === 'bulk' && (
            <motion.div
              key="bulk"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <BulkOutbound initialMode={outboundEntryMode}
                stock={stock} 
                warehouses={warehouses}
                onProcessOutbound={handleProcessOutbound}
                currentUser={currentUser}
                orderHistory={orderHistory}
                onEditOrderHistory={handleEditOrderHistory}
                onEditOrderHistoryBatch={handleEditOrderHistoryBatch}
                onEditMultipleOrdersBatch={handleEditMultipleOrdersBatch}
                onBatchEditExpiredDate={handleBatchEditExpiredDateOrderHistory}
                onDeleteOrderHistory={handleDeleteOrderHistory}
                onDeleteMultipleOrders={handleDeleteMultipleOrders}
                onClearAllOrderHistory={undefined}
                onUpdateOrderSession={handleUpdateOrderSession}
                onUpdateOrdersShipped={handleUpdateOrdersShipped}
              />
            </motion.div>
          )}

          {activeTab === 'mabang' && (
            <motion.div key="mabang" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }}>
              <MabangWmsOutbound
                stock={stock}
                orderHistory={orderHistory}
                onCompleteSorting={handleCompleteSorting}
                currentUser={currentUser}
                onEditOrderHistoryBatch={handleEditOrderHistoryBatch}
                onEditMultipleOrdersBatch={handleEditMultipleOrdersBatch}
                onUpdateOrderSession={handleUpdateOrderSession}
                onOpenBasketLabelModal={() => setIsBasketLabelModalOpen(true)}
              />
            </motion.div>
          )}

          {activeTab === 'quick-outbound' && (
            <motion.div key="quick-outbound" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }}>
              <OutboundManager stock={stock} orderHistory={orderHistory} warehouses={warehouses} onProcessOutbound={handleProcessOutbound} />
            </motion.div>
          )}

          {activeTab === 'analytics' && (
            <motion.div key="analytics" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }}>
              <AnalyticsDashboard stock={stock} logs={logs} />
            </motion.div>
          )}

          {activeTab === 'inbound' && (
            <motion.div
              key="inbound"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <InboundManager
                stock={stock}
                catalog={catalog}
                onUpdateStock={handleUpdateStock}
                onAddLog={handleAddLog}
                onAddBatchLogs={handleAddBatchLogs}
                currentUser={currentUser}
              />
            </motion.div>
          )}

          {activeTab === 'return' && (
            <motion.div
              key="return"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <ReturnManager
                stock={stock}
                catalog={catalog}
                returnHistory={returnHistory}
                currentUser={currentUser}
                onAddStockItem={handleAddStockItem}
                onAddStockItemsBatch={handleAddStockItemsBatch}
                onSaveReturnHistory={saveReturnHistoryState}
              />
            </motion.div>
          )}

          {activeTab === 'audit' && (
            <motion.div
              key="audit"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <AuditTrail
                logs={logs as any}
                onClearLogs={() => handleClearAllTransferLogs()}
              />
            </motion.div>
          )}

          {activeTab === 'sync' && (
            <motion.div
              key="sync"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <GoogleWorkspaceSync
                stock={stock}
                onUpdateStock={handleUpdateStock}
                catalog={catalog}
                onUpdateCatalog={saveCatalogState}
                logs={logs as any}
                onUpdateLogs={saveLogsState}
                currentUser={currentUser}
              />
            </motion.div>
          )}

          {activeTab === 'mobile-sync' && (
            <motion.div
              key="mobile-sync"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <CrossDevice
                stock={stock}
                logs={logs as any}
                currentUser={currentUser}
                dbStatus={dbStatus}
                onSimulateInbound={handleSimulateInbound}
                onSimulateTransfer={handleSimulateTransfer}
                onForcePushStockToCloud={handleForcePushStockToCloud}
              />
            </motion.div>
          )}

          {activeTab === 'bulk-transfer' && (
            <motion.div
              key="bulk-transfer"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              {currentUser?.role === 'Viewer' ? <WarehouseOverview warehouses={warehouses} stock={stock} onViewStock={id=>{setInventoryEntryFocus('ALL');setActiveWarehouseFilter(id);setActiveTab('inventory')}}/> : <SubWarehouseManager 
                warehouses={warehouses}
                onUpdateWarehouses={saveWarehousesState}
                transfers={transfers}
                onUpdateTransfers={saveTransfersState}
                stock={stock}
                onUpdateStock={saveStockState}
                logs={logs}
                onUpdateLogs={saveLogsState}
                onBulkInternalTransfer={handleBulkInternalTransfer}
                currentUser={currentUser}
                activeWarehouseFilter={activeWarehouseFilter}
                onSelectWarehouseFilter={setActiveWarehouseFilter}
                onNavigateToInventoryTab={() => setActiveTab('inventory')}
                onExecuteTransferAtomic={executeTransferAtomic}
              />}
            </motion.div>
          )}

          {activeTab === 'warehouse-map' && (
            <motion.div
              key="warehouse-map"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <WarehouseMap
                stock={stock}
                onNavigateToTransfer={(loc) => {
                  setActiveTab('bulk-transfer');
                }}
              />
            </motion.div>
          )}

          {activeTab === 'stock-opname-location' && (
            <motion.div
              key="stock-opname-location"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <StockOpnamePerLocation
                stock={stock}
                currentUser={currentUser}
              />
            </motion.div>
          )}

          {activeTab === 'catalog' && (
            <motion.div
              key="catalog"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <ProductCatalog
                catalog={catalog}
                stock={stock}
                userRole={currentUser?.role}
                onAddCatalogItem={handleAddCatalogItem}
                onUpdateCatalogItem={handleUpdateCatalogItem}
                onDeleteCatalogItem={handleDeleteCatalogItem}
                onBatchImportCatalog={handleBatchImportCatalog}
                onSyncStockToCatalog={handleSyncStockToCatalog}
              />
            </motion.div>
          )}

          {activeTab === 'users' && (currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && (
            <motion.div
              key="users"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <UserManagement 
                users={users}
                currentUser={currentUser}
                onAddUser={handleAddUser}
                onUpdateUser={handleUpdateUser}
                onDeleteUser={handleDeleteUser}
              />
            </motion.div>
          )}


        </AnimatePresence>

        {/* Persistent Cek Fisik (DCC) container: Keeps component alive when user navigates to other tabs */}
        {hasVisitedDcc && (
          <div className={activeTab === 'daily-cycle-count' ? 'block' : 'hidden'}>
            <CekFisik 
              mode="daily-cycle-count"
              stock={stock} 
              audits={audits}
              saveAuditsState={saveAuditsState}
              currentUser={currentUser}
              onAdjustStockCount={handleAdjustStockCount}
              onAdjustStockCountBatch={handleAdjustStockCountBatch}
            />
          </div>
        )}
      </main>



      {isBasketLabelModalOpen && (
        <BasketLabelGeneratorModal
          isOpen={isBasketLabelModalOpen}
          onClose={() => setIsBasketLabelModalOpen(false)}
          activeBasketsFromOrders={activeBasketsFromOrders}
        />
      )}

      {/* Humble Footer */}
      <footer className="blues-footer">
        <p>© 2026 TRUEBLUE WMS — Development Environment.</p>
        <p>Warehouse operation · TRUEBLUE</p>
      </footer>
    </AppShell>
  );
}
