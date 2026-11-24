import {canBrowseInventory,canOpenWork,type OutboundMode} from './utils/dashboardView';
import {prepareSortingUpdates,type SortingTask} from './utils/orderSorting';
import { scanServerUnavailable, serverScanValidationAvailable } from './utils/packingValidation';
import {prepareOrderSessionUpdates,type OrderSessionData,type OrderSessionResult} from './utils/orderSession';
import {getStockStatus,updateMovementSales} from './utils/calculations';
import AppShell from './components/AppShell';
import {prepareOutboundCreation,prepareOrderEdits} from './utils/outboundTransactions';
import {prepareOrderCompletion,type OrderCompletion} from './utils/orderCompletion';
import {buildStockWritePlan, MAX_STOCK_WRITE_OPERATIONS, queueStockWritePlan} from './utils/stockWritePlan';
import {getStockForcePushSafetyError, runStockForcePushIfSafe, type StockForcePushSnapshot} from './utils/stockForcePushSafety';
import { setActiveBranch, getActiveBranch, DEV_BASELINE_SORTING } from './supabase';
import { loginEmail, displayAccountId } from './accountId';
import { applyUiTheme, nextUiTheme, readUiTheme, UI_THEME_KEY, type UiTheme } from './utils/uiTheme';
import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { StockItem, OutboundItem, DccLog, UserAccount, PhysicalAuditItem, CatalogItem, ReturnItem, BatchRecord, Warehouse, InterWarehouseTransfer, BranchOperationType, ChannelOperationType } from './types';
import { collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch, getDocs, handleSupabaseError, OperationType, processReturnQc, fetchAccessibleBranches, fetchBranchCatalog, fetchBranchOperationType, type QuerySnapshot } from './supabase';
import { supabase, isSupabaseConfigured } from './supabase';
import { branchSupportsOperation } from './utils/orderType';
import { UnassignedOrdersBanner } from './components/UnassignedOrdersBanner';
import type { MabangScreen } from './components/MabangWmsOutbound';
import { calculatePackQuantities, getExpiredStatus, formatNumber, getProductPackSizes, deduplicateAndMergeStock, updateDynamicCatalogRegistry, normalizeDateToDmy, getCanonicalStockId, findStockIndex, isZoneOrUrbanLocation, getLockedStockSummary, isNoExpiryDate } from './utils/calculations';
import { buildCatalogLookupMap, getCatalogItemName, isPlaceholderSkuName, normalizeSkuKey, planCatalogStockBidirectionalSync, resolvePreferredSkuName } from './utils/catalogSync';
import { BARCODE_MAP, findSkuId, getBarcodeForSku, updateDynamicBarcodeRegistry, getProductBrand } from './data/barcodeMap';
import { ensureCentralWarehouse, DEFAULT_CENTRAL_WAREHOUSE } from './utils/warehouseRouting';
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
  ShoppingBag,
  Globe
} from 'lucide-react';
import { useLanguage } from './i18n/LanguageContext';
import { motion, AnimatePresence } from 'motion/react';
import { db } from './supabase';
import { normalizeStockBatch } from './utils/stockNormalization';
import { initialStockSyncState, stockSyncFailed, stockSyncStarted, stockSyncSucceeded, type StockSyncState } from './utils/stockSyncSafety';
import { StaleReadError } from './utils/readRequestSafety';

// Operational screens are loaded only when opened. This keeps the login and
// dashboard shell small without changing transaction or permission logic.
const WarehouseOverview = React.lazy(() => import('./components/WarehouseOverview'));
const SubWarehouseManager = React.lazy(() => import('./components/SubWarehouseManager'));
const Dashboard = React.lazy(() => import('./components/Dashboard'));
const InventoryList = React.lazy(() => import('./components/InventoryList'));
const BulkOutbound = React.lazy(() => import('./components/BulkOutbound'));
const BatchDashboard = React.lazy(() => import('./components/BatchDashboard'));
const AnalyticsDashboard = React.lazy(() => import('./components/AnalyticsDashboard'));
const BasketLabelGeneratorModal = React.lazy(() => import('./components/BasketLabelGeneratorModal'));
const MabangWmsOutbound = React.lazy(() => import('./components/MabangWmsOutbound'));
const OutboundManager = React.lazy(() => import('./components/OutboundManager'));
const CekFisik = React.lazy(() => import('./components/CekFisik'));
const LocationTransferManager = React.lazy(() => import('./components/LocationTransferManager'));
const UserManagement = React.lazy(() => import('./components/UserManagement'));
const ProductCatalog = React.lazy(() => import('./components/ProductCatalog'));
const MarketplaceIntegration = React.lazy(() => import('./components/MarketplaceIntegration'));
const GoogleWorkspaceSync = React.lazy(() => import('./components/GoogleWorkspaceSync'));
const ReturnManager = React.lazy(() => import('./components/ReturnManager'));
const InboundManager = React.lazy(() => import('./components/InboundManager'));
const CrossDevice = React.lazy(() => import('./components/CrossDevice'));
const WarehouseMap = React.lazy(() => import('./components/WarehouseMap'));
const StockOpnamePerLocation = React.lazy(() => import('./components/StockOpnamePerLocation'));
const ThermalLabelPrinter = React.lazy(() => import('./components/ThermalLabelPrinter'));
const AuditTrail = React.lazy(() => import('./components/AuditTrail'));
const InventoryReconciliation = React.lazy(() => import('./components/InventoryReconciliation'));
const PickerHub = React.lazy(() => import('./components/PickerHub'));

export default function App() {
  const { t, language, setLanguage } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<UiTheme>(readUiTheme);
  const [dbStatus, setDbStatus] = useState<'connected' | 'offline'>('offline');
  const [stockSyncState, setStockSyncState] = useState<StockSyncState>(initialStockSyncState);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Render publishes hashed JS bundles, but an already-open tab can keep the
  // old application in memory. Check index.html periodically and offer a
  // normal reload when a newer bundle is deployed; no hard refresh is needed.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let active = true;
    const checkForUpdate = async () => {
      try {
        const response = await fetch(`/index.html?wms-version=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (!response.ok) return;
        const html = await response.text();
        const match = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i);
        const current = document.querySelector<HTMLScriptElement>('script[type="module"]')?.getAttribute('src');
        if (active && match?.[1] && current && new URL(match[1], location.href).pathname !== new URL(current, location.href).pathname) {
          setUpdateAvailable(true);
        }
      } catch {
        // A temporary network failure must not interrupt warehouse work.
      }
    };
    void checkForUpdate();
    const timer = window.setInterval(checkForUpdate, 5 * 60 * 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  
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
    const oldWarehouses = [...warehousesRef.current];
    setWarehouses(updated);
    broadcastUpdate('SYNC_WAREHOUSES', updated);
    try {
      const oldMap = new Map<string, Warehouse>(oldWarehouses.map(w => [w.id, w]));
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
      setSyncTrigger(value => value + 1);
      handleSupabaseError(e, OperationType.WRITE, 'warehouses');
    }
  };

  const saveTransfersState = async (updated: InterWarehouseTransfer[]) => {
    const oldTransfers = [...transfersRef.current];
    setTransfers(updated);
    broadcastUpdate('SYNC_TRANSFERS', updated);
    try {
      const oldMap = new Map<string, InterWarehouseTransfer>(oldTransfers.map(t => [t.id, t]));
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
      setSyncTrigger(value => value + 1);
      handleSupabaseError(e, OperationType.WRITE, 'warehouse_transfers');
    }
  };

  // Sync Batches to Supabase (Shipping Status & Central WMS Stock Deduction)
  const saveBatchesState = async (updatedBatches: BatchRecord[]) => {
    const oldBatches = [...batchesRef.current];
    setBatches(updatedBatches);
    broadcastUpdate('SYNC_BATCHES', updatedBatches);
    try {
      const oldMap = new Map<string, BatchRecord>(oldBatches.map(b => [b.id, b]));
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
      setSyncTrigger(value => value + 1);
      handleSupabaseError(e, OperationType.WRITE, 'batches');
    }
  };

  // Sync Return History to Supabase
  const saveReturnHistoryState = async (updatedReturnHistory: ReturnItem[]) => {
    const oldReturns = [...returnHistoryRef.current];
    setReturnHistory(updatedReturnHistory);
    try {
      const oldMap = new Map<string, ReturnItem>(oldReturns.map(item => [item.id, item]));
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
      setSyncTrigger(value => value + 1);
      handleSupabaseError(e, OperationType.WRITE, 'returns');
    }
  };

  const handleProcessReturnQc = async (caseId:string,decision:'ACCEPT'|'QUARANTINE'|'REJECT',notes:string):Promise<boolean> => {
    try {
      await processReturnQc(getActiveBranch(),caseId,decision,notes);
      setSyncTrigger(value=>value+1);
      return true;
    } catch (error:any) {
      alert(error?.message || 'Keputusan QC return gagal disimpan. Muat ulang data lalu coba lagi.');
      return false;
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
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  useEffect(() => {
    stockForcePushSnapshotRef.current = null;
    let active = true;
    let readyCount = 0;
    const lightweightOperator = currentUser?.role === 'Packer' || currentUser?.role === 'Picker';
    const isShippingOnly = currentUser?.role === 'Shipping';
    const expectedSubscriptions = isShippingOnly ? 2 : lightweightOperator ? 5 : 10;
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];
    const markReady = () => {
      readyCount += 1;
      if (readyCount >= expectedSubscriptions) setLoading(false);
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
      void fetchBranchOperationType(subscribedBranchId).then((op) => {
        if (active) setBranchOperationType(op);
      });
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

      if (!isShippingOnly) {
        subscribe<UserAccount>('users', setUsers, (rows) => rows.map((row) => {
          const profile = row as UserAccount;
          const cleanFullName = (profile.fullName || profile.email || '').replace(/\s*\[SHIPPING\]/gi, '').trim();
          return { 
            ...profile, 
            username: displayAccountId(profile.email || profile.username), 
            fullName: cleanFullName || profile.email || '' 
          };
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
      }
      subscribe<OutboundItem>('orders', rows=>{updateMovementSales(rows);setOrderHistory(rows)}, undefined, (items) => items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      if (!isShippingOnly) {
        subscribe<CatalogItem>('catalog', setCatalog);
      }
      subscribe<Warehouse>('warehouses', (items) => {
        const normalized = ensureCentralWarehouse(items);
        setWarehouses(normalized);
        if (!isShippingOnly && !items.some(w => w.isCentral || (w.id || '').toUpperCase() === 'WH-CENTRAL')) {
          saveWarehousesState(normalized);
        }
      });
      if (!lightweightOperator && !isShippingOnly) {
        subscribe<DccLog>('logs', setLogs, undefined, (items) => items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
        subscribe<PhysicalAuditItem>('audits', setAudits, undefined, (items) => items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
        subscribe<ReturnItem>('returns', setReturnHistory, undefined, (items) => items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
        subscribe<BatchRecord>('batches', setBatches, undefined, (items) => items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
        subscribe<InterWarehouseTransfer>('warehouse_transfers', setTransfers, undefined, (items) => items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
      }
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
  }, [syncTrigger, currentUser?.role]);

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
    const catalogMatch = catalogRef.current.find(c => normalizeSkuKey(c.skuId || c.sku) === cleanSku);
    const resolvedSkuName = cleanSku === 'SYSTEM_EMPTY'
      ? (item.skuName || 'System Empty')
      : resolvePreferredSkuName(cleanSku, item.skuName, getCatalogItemName(catalogMatch));

    return {
      __wms_revision: item.__wms_revision,
      id: canonicalId,
      skuId: cleanSku,
      skuName: resolvedSkuName,
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
      await batch.commit();
    } catch (err) {
      setSyncTrigger(value => value + 1);
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
      await batch.commit();
    } catch (err) {
      setSyncTrigger(value => value + 1);
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
      await batch.commit();
    } catch (err) {
      setSyncTrigger(value => value + 1);
      handleSupabaseError(err, OperationType.WRITE, 'audits');
    }
  };

  const saveAuditsState = (updatedAudits: PhysicalAuditItem[]) => {
    const oldAudits = [...auditsRef.current];
    setAudits(updatedAudits);
    broadcastUpdate('SYNC_AUDITS', updatedAudits);
    void syncAuditsToSupabase(updatedAudits, oldAudits);
  };

  const saveCatalogState = (updatedCatalog: CatalogItem[]) => {
    const oldCatalog = [...catalogRef.current];
    setCatalog(updatedCatalog);
    broadcastUpdate('SYNC_CATALOG', updatedCatalog);
    void syncCatalogToSupabase(updatedCatalog, oldCatalog);
  };

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
      const cleanFullName = (data.full_name || data.email || '').replace(/\s*\[SHIPPING\]/gi, '').trim();
      const profile: UserAccount = {
        id: data.id,
        email: data.email,
        username: displayAccountId(data.email),
        fullName: cleanFullName || data.email,
        role: data.role,
        is_active: data.is_active,
        branch_id: data.branch_id
      };
      if (!["Administrator", "Viewer"].includes(data.role)) setActiveBranch(data.branch_id);
      const { data: allowed } = await supabase.from("branches").select("id").eq("id",getActiveBranch()).maybeSingle();
      if (!allowed) setActiveBranch(data.branch_id || "CENTER");
      const branchOp = await fetchBranchOperationType(getActiveBranch());
      setBranchOperationType(branchOp);
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
    try {
      (window as any).__googleAccessToken = null;
      localStorage.removeItem('blues_google_access_token');
      localStorage.removeItem('blues_google_user_email');
    } catch {}
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

    let staleCreateRpcNotice = '';
    if (body.action !== 'invite') {
      const { data: rpcData, error: rpcError } = await supabase.rpc('admin_manage_user', { body });
      const rpcObjError =
        rpcData && typeof rpcData === 'object' && 'error' in rpcData ? String((rpcData as any).error) : '';
      if (!rpcError && !rpcObjError) {
        return rpcData;
      }
      if (rpcObjError && !/Edge Function admin-users diperlukan/i.test(rpcObjError)) {
        throw new Error(rpcObjError);
      }
      staleCreateRpcNotice = rpcObjError || (rpcError?.code !== 'PGRST202' ? rpcError?.message || '' : '');
    }

    const { data, error } = await supabase.functions.invoke('admin-users', { body });
    if (!error && !data?.error) return data;

    let edgeDetail = data?.error ? String(data.error) : '';
    if (error) {
      edgeDetail = error.message;
      try {
        if ('context' in error && (error as any).context) {
          const res = (error as any).context as Response;
          const cloned = res.clone ? res.clone() : res;
          const json = await cloned.json();
          if (json?.error) edgeDetail = String(json.error);
          else if (json?.message) edgeDetail = String(json.message);
          else if (typeof json === 'string') edgeDetail = json;
        }
      } catch {
        try {
          const res = (error as any).context as Response;
          const text = await res.text();
          if (text) edgeDetail = text;
        } catch {}
      }
    }

    if (/requested function was not found|not_found|failed to send a request to the edge function|404/i.test(edgeDetail)) {
      throw new Error(
        staleCreateRpcNotice
          ? 'Pembuatan akun gagal: fungsi SQL `admin_manage_user` perlu diperbarui di Supabase SQL Editor (jalankan `supabase/migrations/20261123000000_admin_create_user_rpc.sql`) atau deploy Edge Function `admin-users`.'
          : 'Layanan pembuatan akun belum aktif di Supabase. Jalankan migrasi SQL `20261123000000_admin_create_user_rpc.sql` di Supabase SQL Editor.'
      );
    }

    throw new Error(edgeDetail || staleCreateRpcNotice || 'Operasi akun gagal.');
  };

  const handleAddUser = async (newUser: UserAccount) => {
    const branchToUse = (newUser.branch_id || getActiveBranch() || 'CENTER').trim();
    const finalFullName = (newUser.fullName || newUser.username).trim();

    await runAdminAction({
      action: 'create',
      username: newUser.username,
      password: newUser.password,
      branchId: branchToUse,
      fullName: finalFullName,
      role: newUser.role
    });
  };

  const handleUpdateUser = async (email: string, fields: Partial<UserAccount>) => {
    const target = users.find((user) => (user.email || user.username).toLowerCase() === email.toLowerCase());
    if (!target?.id) throw new Error('Profil operator tidak ditemukan.');
    const finalFullName = fields.fullName !== undefined
      ? fields.fullName.replace(/\s*\[SHIPPING\]/gi, '').trim()
      : undefined;
    await runAdminAction({ 
      action: 'update', 
      userId: target.id, 
      fullName: finalFullName, 
      role: fields.role, 
      branchId: fields.branch_id 
    });
  };

  const handleDeleteUser = async (email: string) => {
    const target = users.find((user) => (user.email || user.username).toLowerCase() === email.toLowerCase());
    if (!target?.id) throw new Error('Profil operator tidak ditemukan.');
    await runAdminAction({ action: 'delete', userId: target.id });
  };

  const applyCatalogLocalState = (nextCatalog: CatalogItem[]) => {
    updateDynamicCatalogRegistry(nextCatalog);
    updateDynamicBarcodeRegistry(nextCatalog);
    catalogRef.current = nextCatalog;
    setCatalog(nextCatalog);
    broadcastUpdate('SYNC_CATALOG', nextCatalog);
  };

  const loadLatestStockForCatalogSync = async (): Promise<StockItem[]> => {
    if (!isSupabaseConfigured || !supabase) return stockRef.current;
    const stockSnapshot = await getDocs(collection(db, 'stock'));
    const rawRecords = stockSnapshot.docs
      .filter(entry => !entry.id.startsWith('SYSTEM_'))
      .map(entry => entry.data());
    return normalizeStockBatch(rawRecords);
  };

  const syncCatalogItemsToStock = async (
    updatedCatalogItems: CatalogItem[],
    fullNextCatalog: CatalogItem[]
  ): Promise<{ syncedCount: number; errorMessage?: string }> => {
    try {
      updateDynamicCatalogRegistry(fullNextCatalog);
      updateDynamicBarcodeRegistry(fullNextCatalog);

      const latestStock = await loadLatestStockForCatalogSync();
      const updatedMap = buildCatalogLookupMap(updatedCatalogItems);
      const stockToUpdate: StockItem[] = [];

      latestStock.forEach(s => {
        const normSku = normalizeSkuKey(s.skuId);
        const cat = updatedMap.get(normSku);
        if (!cat) return;

        const catName = getCatalogItemName(cat);
        const nextSkuName = resolvePreferredSkuName(normSku, catName, s.skuName);
        const nextCtnSize = cat.qtyCtnSize > 0 ? cat.qtyCtnSize : s.qtyCtnSize;
        const nextInnerSize = cat.qtyInnerSize > 0 ? cat.qtyInnerSize : s.qtyInnerSize;
        const nextBrand = getProductBrand(normSku, nextSkuName, cat.brand || s.brand);
        const nextBarcode = getBarcodeForSku(
          normSku,
          cat.barcode && cat.barcode !== '-' ? cat.barcode : s.barcode
        );

        const nameChanged = nextSkuName.trim() !== String(s.skuName ?? '').trim();
        const sizeChanged = nextCtnSize !== s.qtyCtnSize || nextInnerSize !== s.qtyInnerSize;
        const brandChanged = nextBrand !== (s.brand ?? '');
        const barcodeChanged = nextBarcode !== '-' && nextBarcode !== (s.barcode ?? '-');

        if (!nameChanged && !sizeChanged && !brandChanged && !barcodeChanged) return;

        const splits = calculatePackQuantities(s.qty, nextCtnSize, nextInnerSize);
        stockToUpdate.push({
          ...s,
          skuName: nextSkuName,
          brand: nextBrand,
          barcode: nextBarcode,
          qtyCtnSize: nextCtnSize,
          qtyInnerSize: nextInnerSize,
          qtyCtn: splits.qtyCtn,
          qtyInner: splits.qtyInner,
          qtyLoose: splits.qtyLoose,
        });
      });

      const chunkSize = 400;
      for (let i = 0; i < stockToUpdate.length; i += chunkSize) {
        const chunk = stockToUpdate.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach(updatedStockItem => {
          batch.set(doc(db, 'stock', updatedStockItem.id), updatedStockItem);
        });
        await batch.commit();
      }

      return { syncedCount: stockToUpdate.length };
    } catch (err: any) {
      console.warn('Batch stock catalog sync failed:', err);
      return {
        syncedCount: 0,
        errorMessage: err?.message || 'Sinkronisasi ke stok gagal. Muat ulang halaman lalu jalankan Sync Katalog ↔ Stok.'
      };
    }
  };

  const handleAddCatalogItem = async (newItem: Omit<CatalogItem, 'id'>) => {
    try {
      const docId = normalizeSkuKey(newItem.skuId);
      const resolvedBrand = getProductBrand(docId, newItem.skuName, newItem.brand);
      const resolvedBarcode = getBarcodeForSku(docId, newItem.barcode);
      const itemToSave: CatalogItem = {
        id: docId,
        skuId: docId,
        skuName: newItem.skuName.trim(),
        brand: resolvedBrand,
        barcode: resolvedBarcode,
        qtyCtnSize: newItem.qtyCtnSize,
        qtyInnerSize: newItem.qtyInnerSize,
        ...(newItem.isBundle && Array.isArray(newItem.bundleComponents) && newItem.bundleComponents.length > 0
          ? { isBundle: true, bundleComponents: newItem.bundleComponents }
          : {})
      };
      await setDoc(doc(db, 'catalog', docId), itemToSave);
      const nextCatalog = [...catalogRef.current.filter(c => normalizeSkuKey(c.skuId) !== docId), itemToSave];
      applyCatalogLocalState(nextCatalog);
      if (!itemToSave.isBundle) {
        await syncCatalogItemsToStock([itemToSave], nextCatalog);
      }
      return true;
    } catch (error) {
      console.error('Error adding catalog item: ', error);
      return false;
    }
  };

  const handleUpdateCatalogItem = async (skuId: string, updatedFields: Partial<CatalogItem>) => {
    try {
      const docId = normalizeSkuKey(skuId);
      const existing = catalogRef.current.find(c => normalizeSkuKey(c.skuId) === docId);
      if (!existing) return false;

      const nextName = (updatedFields.skuName ?? existing.skuName).trim();
      const newBrand = getProductBrand(docId, nextName, updatedFields.brand ?? existing.brand);
      const newBarcode = getBarcodeForSku(docId, updatedFields.barcode ?? existing.barcode);

      const merged: CatalogItem = {
        ...existing,
        ...updatedFields,
        skuName: nextName,
        brand: newBrand,
        barcode: newBarcode,
        id: docId,
        skuId: docId
      };

      const latestStock = merged.isBundle ? [] : await loadLatestStockForCatalogSync();
      const batch = writeBatch(db);
      batch.set(doc(db, 'catalog', docId), merged);

      // Sync only stock rows whose name, brand, barcode, or pack sizes actually changed
      const matchingStock = latestStock.filter(s => normalizeSkuKey(s.skuId) === docId);
      matchingStock.forEach(s => {
        const newCtnSize = updatedFields.qtyCtnSize ?? s.qtyCtnSize;
        const newInnerSize = updatedFields.qtyInnerSize ?? s.qtyInnerSize;
        const newName = updatedFields.skuName !== undefined ? updatedFields.skuName.trim() : s.skuName;
        const nameChanged = newName !== String(s.skuName ?? '').trim();
        const sizeChanged = newCtnSize !== s.qtyCtnSize || newInnerSize !== s.qtyInnerSize;
        const brandChanged = newBrand !== (s.brand ?? '');
        const barcodeChanged = newBarcode !== '-' && newBarcode !== (s.barcode ?? '-');
        if (!nameChanged && !sizeChanged && !brandChanged && !barcodeChanged) return;

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

      await batch.commit();
      const nextCatalog = catalogRef.current.map(c =>
        normalizeSkuKey(c.skuId) === docId ? merged : c
      );
      applyCatalogLocalState(nextCatalog);
      return true;
    } catch (error) {
      console.error('Error updating catalog item: ', error);
      return false;
    }
  };

  const deleteCatalogItemsByKeys = async (
    skuIds: string[]
  ): Promise<{ success: boolean; deletedCount: number; errorMessage?: string }> => {
    try {
      const targetKeys = new Set(
        skuIds.map((id) => normalizeSkuKey(id)).filter(Boolean)
      );
      if (targetKeys.size === 0) {
        return { success: true, deletedCount: 0 };
      }

      setIsSyncingNow(true);

      let docIdsToDelete: string[] = [];
      const matchedSkuKeys = new Set<string>(targetKeys);

      if (isSupabaseConfigured && supabase) {
        const snapshot = await getDocs(collection(db, 'catalog'));
        const seenDocIds = new Set<string>();
        for (const entry of snapshot.docs) {
          const data = entry.data() as Partial<CatalogItem>;
          const keyById = normalizeSkuKey(entry.id);
          const keyBySku = normalizeSkuKey(data?.skuId || entry.id);
          if (targetKeys.has(keyById) || targetKeys.has(keyBySku)) {
            if (!seenDocIds.has(entry.id)) {
              seenDocIds.add(entry.id);
              docIdsToDelete.push(entry.id);
            }
            matchedSkuKeys.add(keyById);
            matchedSkuKeys.add(keyBySku);
          }
        }
      } else {
        docIdsToDelete = Array.from(
          new Set(
            catalogRef.current
              .filter((c) => targetKeys.has(normalizeSkuKey(c.skuId || c.id)) || targetKeys.has(normalizeSkuKey(c.id)))
              .map((c) => c.id || normalizeSkuKey(c.skuId))
              .filter(Boolean)
          )
        );
        if (docIdsToDelete.length === 0) {
          docIdsToDelete = Array.from(targetKeys);
        }
      }

      const chunkSize = 400;
      for (let i = 0; i < docIdsToDelete.length; i += chunkSize) {
        const chunk = docIdsToDelete.slice(i, i + chunkSize);
        const batchDelete = writeBatch(db);
        chunk.forEach((id) => {
          batchDelete.delete(doc(db, 'catalog', id));
        });
        await batchDelete.commit();
      }

      const nextCatalog = catalogRef.current.filter(
        (c) =>
          !matchedSkuKeys.has(normalizeSkuKey(c.skuId)) &&
          !matchedSkuKeys.has(normalizeSkuKey(c.id))
      );
      applyCatalogLocalState(nextCatalog);
      setIsSyncingNow(false);
      return { success: true, deletedCount: docIdsToDelete.length || targetKeys.size };
    } catch (error) {
      console.error('Error deleting catalog items: ', error);
      setIsSyncingNow(false);
      return {
        success: false,
        deletedCount: 0,
        errorMessage: error instanceof Error ? error.message : 'Gagal menghapus data katalog.',
      };
    }
  };

  const handleDeleteCatalogItem = async (skuId: string) => {
    const res = await deleteCatalogItemsByKeys([skuId]);
    return res.success;
  };

  const handleBatchDeleteCatalogItems = async (skuIds: string[]) => {
    return deleteCatalogItemsByKeys(skuIds);
  };

  const handleBatchImportCatalog = async (
    items: Omit<CatalogItem, 'id'>[],
    mode: 'merge' | 'replace'
  ): Promise<{ success: boolean; catalogSavedCount: number; stockSyncedCount: number; stockSyncError?: string }> => {
    try {
      setIsSyncingNow(true);
      if (isSupabaseConfigured && supabase) {
        await getDocs(collection(db, 'catalog'));
      }

      const dedupedNewMap = new Map<string, CatalogItem>();
      items.forEach(item => {
        const docId = normalizeSkuKey(item.skuId);
        if (!docId) return;
        const cleanName = String(item.skuName || '').trim();
        const resolvedBrand = getProductBrand(docId, cleanName, item.brand);
        const resolvedBarcode = getBarcodeForSku(docId, item.barcode);
        dedupedNewMap.set(docId, {
          id: docId,
          skuId: docId,
          skuName: cleanName,
          brand: resolvedBrand,
          barcode: resolvedBarcode,
          qtyCtnSize: item.qtyCtnSize,
          qtyInnerSize: item.qtyInnerSize
        });
      });

      const importedCatalogList = Array.from(dedupedNewMap.values());
      const currentMap = buildCatalogLookupMap(catalogRef.current);
      const chunkSize = 400;

      if (mode === 'replace') {
        const obsoleteIds = Array.from(currentMap.keys()).filter(id => !dedupedNewMap.has(id));
        for (let i = 0; i < obsoleteIds.length; i += chunkSize) {
          const chunk = obsoleteIds.slice(i, i + chunkSize);
          const batchDelete = writeBatch(db);
          chunk.forEach(id => {
            batchDelete.delete(doc(db, 'catalog', id));
          });
          await batchDelete.commit();
        }
      }

      const itemsToWrite = importedCatalogList.filter(nextItem => {
        if (mode === 'replace') {
          const prev = currentMap.get(nextItem.id);
          return !prev || JSON.stringify(prev) !== JSON.stringify(nextItem);
        }
        const prev = currentMap.get(nextItem.id);
        return (
          !prev ||
          prev.skuName !== nextItem.skuName ||
          (prev.brand || '') !== (nextItem.brand || '') ||
          (prev.barcode || '-') !== (nextItem.barcode || '-') ||
          prev.qtyCtnSize !== nextItem.qtyCtnSize ||
          prev.qtyInnerSize !== nextItem.qtyInnerSize
        );
      });

      for (let i = 0; i < itemsToWrite.length; i += chunkSize) {
        const chunk = itemsToWrite.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach(itemToSave => {
          batch.set(doc(db, 'catalog', itemToSave.id), itemToSave);
        });
        await batch.commit();
      }

      let nextCatalogList: CatalogItem[];
      if (mode === 'replace') {
        nextCatalogList = importedCatalogList;
      } else {
        const mergedMap = new Map<string, CatalogItem>(currentMap);
        importedCatalogList.forEach(c => mergedMap.set(c.id, c));
        nextCatalogList = Array.from(mergedMap.values());
      }

      applyCatalogLocalState(nextCatalogList);

      // Push updated names/sizes to matching stock records with fresh revisions
      const stockSync = await syncCatalogItemsToStock(importedCatalogList, nextCatalogList);

      setIsSyncingNow(false);
      return {
        success: true,
        catalogSavedCount: importedCatalogList.length,
        stockSyncedCount: stockSync.syncedCount,
        stockSyncError: stockSync.errorMessage
      };
    } catch (error) {
      console.error('Error batch importing catalog: ', error);
      setIsSyncingNow(false);
      return {
        success: false,
        catalogSavedCount: 0,
        stockSyncedCount: 0,
      };
    }
  };

  const handleSyncStockToCatalog = async (): Promise<{
    addedCount: number;
    updatedCatalogCount: number;
    syncedStockCount: number;
    stockSyncError?: string;
  }> => {
    try {
      if (isSupabaseConfigured && supabase) {
        await getDocs(collection(db, 'catalog'));
      }
      const latestStock = await loadLatestStockForCatalogSync();
      const plan = planCatalogStockBidirectionalSync(
        catalogRef.current,
        latestStock,
        getProductPackSizes,
        getProductBrand,
        getBarcodeForSku
      );

      const chunkSize = 400;
      for (let i = 0; i < plan.catalogUpserts.length; i += chunkSize) {
        const chunk = plan.catalogUpserts.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach(item => {
          batch.set(doc(db, 'catalog', item.id), item);
        });
        await batch.commit();
      }

      if (plan.catalogUpserts.length > 0) {
        applyCatalogLocalState(plan.mergedCatalog);
      }

      let stockSyncError: string | undefined;
      let syncedStockCount = 0;
      if (plan.stockUpdates.length > 0) {
        try {
          for (let i = 0; i < plan.stockUpdates.length; i += chunkSize) {
            const chunk = plan.stockUpdates.slice(i, i + chunkSize);
            const batch = writeBatch(db);
            chunk.forEach(s => {
              batch.set(doc(db, 'stock', s.id), s);
            });
            await batch.commit();
          }
          syncedStockCount = plan.stockUpdates.length;
        } catch (stockErr: any) {
          console.warn('Stock sync inside bidirectional catalog sync failed:', stockErr);
          stockSyncError = stockErr?.message || 'Sebagian baris stok gagal diperbarui.';
        }
      }

      return {
        addedCount: plan.addedCatalogCount,
        updatedCatalogCount: plan.updatedCatalogCount,
        syncedStockCount,
        stockSyncError
      };
    } catch (e: any) {
      console.error('Error syncing stock to catalog:', e);
      return {
        addedCount: 0,
        updatedCatalogCount: 0,
        syncedStockCount: 0,
        stockSyncError: e?.message || 'Sinkronisasi gagal.'
      };
    }
  };

  const handleSyncImportedNamesToCatalog = async (
    importedRows: Array<{ skuId: string; skuName: string; qtyCtnSize: number; qtyInnerSize: number }>
  ): Promise<void> => {
    try {
      const currentMap = buildCatalogLookupMap(catalogRef.current);
      const upserts = new Map<string, CatalogItem>();

      importedRows.forEach(row => {
        const docId = normalizeSkuKey(row.skuId);
        const cleanName = String(row.skuName || '').trim();
        if (!docId || isPlaceholderSkuName(docId, cleanName)) return;

        const existing = currentMap.get(docId);
        if (!existing) {
          const sizes = getProductPackSizes(docId);
          upserts.set(docId, {
            id: docId,
            skuId: docId,
            skuName: cleanName,
            brand: getProductBrand(docId, cleanName),
            barcode: getBarcodeForSku(docId),
            qtyCtnSize: row.qtyCtnSize || sizes.qtyCtnSize || 720,
            qtyInnerSize: row.qtyInnerSize || sizes.qtyInnerSize || 12,
          });
        } else if (isPlaceholderSkuName(docId, existing.skuName)) {
          upserts.set(docId, {
            ...existing,
            id: docId,
            skuId: existing.skuId || docId,
            skuName: cleanName,
          });
        }
      });

      if (upserts.size === 0) return;
      if (isSupabaseConfigured && supabase) {
        await getDocs(collection(db, 'catalog'));
      }
      const list = Array.from(upserts.values());
      const chunkSize = 400;
      for (let i = 0; i < list.length; i += chunkSize) {
        const batch = writeBatch(db);
        list.slice(i, i + chunkSize).forEach(catItem => {
          batch.set(doc(db, 'catalog', catItem.id), catItem);
        });
        await batch.commit();
      }

      const nextMap = new Map(currentMap);
      list.forEach(catItem => nextMap.set(catItem.id, catItem));
      applyCatalogLocalState(Array.from(nextMap.values()));
    } catch (err) {
      console.warn('Auto sync imported stock names to catalog warning:', err);
    }
  };

  const [branchOperationType, setBranchOperationType] = useState<BranchOperationType>('HYBRID');
  const [mabangScreen, setMabangScreen] = useState<MabangScreen>('distribution');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [inventoryEntryFocus,setInventoryEntryFocus] = useState('ALL');
  const [outboundEntryMode,setOutboundEntryMode] = useState<OutboundMode|undefined>(undefined);

  useEffect(() => {
    const handleBranchConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ branchId?: string; operationType?: BranchOperationType }>).detail;
      if (detail?.operationType && (!detail.branchId || detail.branchId === getActiveBranch())) {
        setBranchOperationType(detail.operationType);
        return;
      }
      void fetchBranchOperationType(getActiveBranch()).then(setBranchOperationType);
    };
    window.addEventListener('wms-branch-config-updated', handleBranchConfigUpdated);
    return () => window.removeEventListener('wms-branch-config-updated', handleBranchConfigUpdated);
  }, []);

  const navigateFromMenu = (tab: string) => {
    const showB2b = branchSupportsOperation(branchOperationType, 'B2B');
    const showOnline = branchSupportsOperation(branchOperationType, 'ONLINE');
    let nextTab = tab;
    if (tab === 'bulk') {
      nextTab = showB2b ? 'b2b-picking' : 'online-picking';
    } else if (tab === 'mabang') {
      nextTab = showOnline ? 'online-picking' : 'b2b-picking';
    } else if (tab === 'orders') {
      nextTab = showB2b ? 'b2b-input' : 'online-input';
    }

    if (nextTab === 'online-picking') {
      setMabangScreen('distribution');
      setOutboundEntryMode(undefined);
    } else if (nextTab === 'online-sorting') {
      setMabangScreen('sorting');
      setOutboundEntryMode(undefined);
    } else if (nextTab === 'online-packing') {
      setMabangScreen('delivery');
      setOutboundEntryMode(undefined);
    } else if (nextTab === 'b2b-input' || nextTab === 'online-input') {
      setOutboundEntryMode('create');
    } else if (nextTab === 'b2b-picking') {
      setOutboundEntryMode('pick');
    } else if (nextTab === 'b2b-packing') {
      setOutboundEntryMode('validate');
    } else if (nextTab === 'b2b-history' || nextTab === 'online-history') {
      setOutboundEntryMode('history');
    } else {
      setOutboundEntryMode(undefined);
    }

    setInventoryEntryFocus('ALL');
    setActiveTab(nextTab);
  };

  // Enforce role-based and branch-operation-type tab containment:
  // - Shipping: dashboard read-only (fitur Shipping Manifest sudah dihapus)
  // - Picker: 'picker-hub', 'b2b-picking' (B2B/HYBRID), 'online-picking' (ONLINE/HYBRID)
  // - Packer: 'b2b-packing' (B2B/HYBRID), 'online-sorting' & 'online-packing' (ONLINE/HYBRID)
  // - Viewer: 'dashboard', 'inventory', 'bulk-transfer'
  // - Admin / Administrator: full menu sesuai jenis operasional cabang
  useEffect(() => {
    if (!isLoggedIn) return;
    const showB2b = branchSupportsOperation(branchOperationType, 'B2B');
    const showOnline = branchSupportsOperation(branchOperationType, 'ONLINE');
    const role = currentUser?.role;

    if (role === 'Picker') {
      const allowedPickerTabs = [
        'picker-hub',
        ...(showB2b ? ['b2b-picking'] : []),
        ...(showOnline ? ['online-picking'] : []),
      ];
      if (!allowedPickerTabs.includes(activeTab)) {
        setActiveTab('picker-hub');
      } else if (activeTab === 'online-picking' && mabangScreen !== 'distribution') {
        setMabangScreen('distribution');
      }
      return;
    }

    if (role === 'Packer') {
      const allowedPackerTabs = [
        ...(showB2b ? ['b2b-packing'] : []),
        ...(showOnline ? ['online-sorting', 'online-packing'] : []),
      ];
      const fallbackPackerTab = allowedPackerTabs[0] || 'b2b-packing';
      if (!allowedPackerTabs.includes(activeTab)) {
        if (fallbackPackerTab === 'online-sorting') setMabangScreen('sorting');
        else if (fallbackPackerTab === 'online-packing') setMabangScreen('delivery');
        setActiveTab(fallbackPackerTab);
      }
      return;
    }

    if (role === 'Shipping') {
      if (activeTab !== 'dashboard') {
        setActiveTab('dashboard');
      }
      return;
    }

    if (role === 'Viewer') {
      if (!['dashboard', 'inventory', 'bulk-transfer'].includes(activeTab)) {
        setActiveTab('dashboard');
      }
      return;
    }

    const b2bTabs = ['b2b-input', 'b2b-picking', 'b2b-packing', 'b2b-history'];
    const onlineTabs = ['online-input', 'online-picking', 'online-sorting', 'online-packing', 'online-history'];
    if ((!showB2b && b2bTabs.includes(activeTab)) || (!showOnline && onlineTabs.includes(activeTab))) {
      setActiveTab('dashboard');
    }
  }, [isLoggedIn, currentUser, activeTab, branchOperationType, mabangScreen]);
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
      const deduplicatedStock = deduplicateAndMergeStock(updatedStock);
      const skuTotals: Record<string, number> = {};
      deduplicatedStock.forEach(item => {
        skuTotals[item.skuId] = (skuTotals[item.skuId] || 0) + item.qty;
      });
      const finalizedStock = deduplicatedStock.map(item => ({
        ...item,
        totalQtySku: skuTotals[item.skuId] || 0
      }));

      const oldStock = [...stockRef.current];
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
      const newDocuments = finalizedStock.map(sanitizeStockDocForSupabase);
      const stockOperations = buildStockWritePlan(newDocuments, oldDocuments, emptyFlag, {
        forceUpserts: false
      });

      // Single atomic batch across stock, warehouse_transfers, and logs
      const batch = writeBatch(db);
      queueStockWritePlan(
        batch,
        stockOperations,
        id => doc(db, 'stock', id),
        (reference, revision) => ({ ...reference, expectedRevision: revision }),
        false
      );
      batch.set(doc(db, 'warehouse_transfers', newTransfer.id), newTransfer);
      for (const log of newLogs) {
        batch.set(doc(db, 'logs', log.id), log);
      }
      await batch.commit();

      const nextTransfers = [newTransfer, ...transfersRef.current];
      const nextLogs = [...newLogs, ...logsRef.current];
      setStock(finalizedStock);
      setTransfers(nextTransfers);
      setLogs(nextLogs);
      broadcastUpdate('SYNC_TRANSFERS', nextTransfers);
      broadcastUpdate('SYNC_LOGS', nextLogs);
      setSyncTrigger(value => value + 1);
    } catch (e) {
      setSyncTrigger(value => value + 1);
      handleSupabaseError(e, OperationType.WRITE, 'warehouse_transfers');
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
    const oldLogs = [...logsRef.current];
    setLogs(updatedLogs);
    broadcastUpdate('SYNC_LOGS', updatedLogs);
    void syncLogsToSupabase(updatedLogs, oldLogs);
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
    const oldOrders = [...orderHistoryRef.current];
    setOrderHistory(updatedOrderHistory);
    broadcastUpdate('SYNC_ORDERS', updatedOrderHistory);
    void syncOrdersToSupabase(updatedOrderHistory, oldOrders);
  };

  // STOCK OPERATIONS

  // 1. Update/Edit existing stock list manually
  const handleUpdateStock = (updatedStock: StockItem[]) => {
    const savePromise = saveStockState(updatedStock);

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
    return savePromise;
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
      const catalogMatch = catalogRef.current.find(c => normalizeSkuKey(c.skuId) === skuId);
      const userEditedName = String(newItem.skuName || '').trim();
      const userExplicitlyChangedName = userEditedName !== String(oldItem.skuName || '').trim();
      const resolvedSkuName = userExplicitlyChangedName && !isPlaceholderSkuName(skuId, userEditedName)
        ? userEditedName
        : resolvePreferredSkuName(skuId, userEditedName, getCatalogItemName(catalogMatch));

      const qty = newItem.qty + (target?.qty || 0);
      const sourceIds = [...new Set([
        ...(source.__wms_source_ids?.length ? source.__wms_source_ids : [source.id]),
        ...(target ? (target.__wms_source_ids?.length ? target.__wms_source_ids : [target.id]) : [])
      ])];
      const sourceRevisions = {
        ...(source.__wms_source_revisions || {}),
        ...(target?.__wms_source_revisions || {})
      };
      const updated = {...newItem, skuName: resolvedSkuName, __wms_revision: id===source.id ? source.__wms_revision : target?.__wms_revision, __wms_revision_document_id: id===source.id ? source.__wms_revision_document_id : target?.__wms_revision_document_id, __wms_source_ids: sourceIds, __wms_source_revisions: sourceRevisions, id, skuId, location, expiredDate, warehouseId:wh, qty, ...calculatePackQuantities(qty,newItem.qtyCtnSize,newItem.qtyInnerSize),status:getExpiredStatus(expiredDate)};
      const batch = writeBatch(db);
      if (source.id !== id) batch.delete(doc(db,'stock',source.id));
      if (target && target.id !== id) batch.delete(doc(db,'stock',target.id));
      batch.set(doc(db,'stock',id),sanitizeStockDocForSupabase(updated));
      batch.set(doc(db,'logs','log_edit_'+crypto.randomUUID()),{timestamp:new Date().toISOString(),type:'ADJUSTMENT',skuId,skuName:resolvedSkuName,qty:Math.abs(newItem.qty-source.qty),locationFrom:source.location,locationTo:location,warehouseId:wh,description:'Edit stok: '+source.qty+' -> '+newItem.qty,user:currentUser?.fullName || 'Admin'});

      let nextCatalogAfterEdit: CatalogItem[] | null = null;
      if (!isPlaceholderSkuName(skuId, resolvedSkuName)) {
        if (
          !catalogMatch ||
          isPlaceholderSkuName(skuId, catalogMatch.skuName) ||
          (userExplicitlyChangedName && resolvedSkuName !== catalogMatch.skuName.trim())
        ) {
          const updatedCatItem: CatalogItem = catalogMatch
            ? { ...catalogMatch, id: skuId, skuId, skuName: resolvedSkuName }
            : {
                id: skuId,
                skuId,
                skuName: resolvedSkuName,
                brand: getProductBrand(skuId, resolvedSkuName, newItem.brand),
                barcode: getBarcodeForSku(skuId, newItem.barcode),
                qtyCtnSize: newItem.qtyCtnSize || getProductPackSizes(skuId).qtyCtnSize,
                qtyInnerSize: newItem.qtyInnerSize || getProductPackSizes(skuId).qtyInnerSize,
              };
          batch.set(doc(db, 'catalog', skuId), updatedCatItem);
          nextCatalogAfterEdit = [
            ...catalogRef.current.filter(c => normalizeSkuKey(c.skuId) !== skuId),
            updatedCatItem
          ];
        }

        const reservedDocIds = new Set<string>([id, source.id, ...(target ? [target.id] : []), ...sourceIds]);
        stock.forEach(sibling => {
          if (normalizeSkuKey(sibling.skuId) !== skuId) return;
          if (String(sibling.skuName || '').trim() === resolvedSkuName) return;
          const siblingDocIds = [
            sibling.id,
            ...(sibling.__wms_source_ids?.length ? sibling.__wms_source_ids : [])
          ];
          if (siblingDocIds.some(docKey => reservedDocIds.has(docKey))) return;
          siblingDocIds.forEach(docKey => reservedDocIds.add(docKey));
          batch.set(doc(db, 'stock', sibling.id), sanitizeStockDocForSupabase({ ...sibling, skuName: resolvedSkuName }));
        });
      }

      await batch.commit();
      if (nextCatalogAfterEdit) {
        applyCatalogLocalState(nextCatalogAfterEdit);
      }
      return true;
    } catch(e:any) { alert(e.message || 'Edit stok gagal. Muat ulang data sebelum mencoba lagi.'); return false; }
    finally { stockEditLock.current=false; }
  };

  // 2. Add brand new stock record (Inbound)
  const handleAddStockItem = async (newItem: Omit<StockItem, 'id' | 'totalQtySku'>): Promise<boolean> => {
    if (!Number.isSafeInteger(newItem.qty) || newItem.qty <= 0) throw new Error('Jumlah stok harus berupa bilangan bulat positif.');
    // Sanitize qty input to be positive integer
    const sanitizedQty = Math.floor(Math.max(0, newItem.qty));
    const cleanSku = normalizeSkuKey(newItem.skuId);
    const catalogMatch = catalogRef.current.find(c => normalizeSkuKey(c.skuId) === cleanSku);
    const resolvedSkuName = resolvePreferredSkuName(cleanSku, newItem.skuName, getCatalogItemName(catalogMatch));
    const normalizedEd = normalizeDateToDmy(newItem.expiredDate);
    const sanitizedItem = {
      ...newItem,
      skuId: cleanSku || newItem.skuId,
      skuName: resolvedSkuName,
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
        skuName: resolvePreferredSkuName(cleanSku, existing.skuName, resolvedSkuName),
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
      skuId: cleanSku || newItem.skuId,
      skuName: resolvedSkuName,
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

    let nextCatalogAfterAdd: CatalogItem[] | null = null;
    if (
      cleanSku &&
      !isPlaceholderSkuName(cleanSku, resolvedSkuName) &&
      (!catalogMatch || isPlaceholderSkuName(cleanSku, catalogMatch.skuName))
    ) {
      const catItem: CatalogItem = catalogMatch
        ? { ...catalogMatch, id: cleanSku, skuId: cleanSku, skuName: resolvedSkuName }
        : {
            id: cleanSku,
            skuId: cleanSku,
            skuName: resolvedSkuName,
            brand: getProductBrand(cleanSku, resolvedSkuName, newItem.brand),
            barcode: getBarcodeForSku(cleanSku, newItem.barcode),
            qtyCtnSize: newItem.qtyCtnSize || getProductPackSizes(cleanSku).qtyCtnSize,
            qtyInnerSize: newItem.qtyInnerSize || getProductPackSizes(cleanSku).qtyInnerSize,
          };
      batch.set(doc(db, 'catalog', cleanSku), catItem);
      nextCatalogAfterAdd = [
        ...catalogRef.current.filter(c => normalizeSkuKey(c.skuId) !== cleanSku),
        catItem
      ];
    }

    await batch.commit();
    if (nextCatalogAfterAdd) {
      applyCatalogLocalState(nextCatalogAfterAdd);
    }
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
      if(!planned.draft && supabase){
        const upserts:any[]=[];
        for(const s of planned.stock)upserts.push({collection_name:'stock',document_id:s.id,expected_revision:(s as any).__wms_revision??null,merge:false,payload:s});
        for(const o of planned.orders){
          upserts.push({collection_name:'orders',document_id:o.id,expected_revision:null,merge:false,payload:o});
          const id='log_out_'+crypto.randomUUID();
          upserts.push({collection_name:'logs',document_id:id,expected_revision:null,merge:false,payload:{id,timestamp,type:'OUTBOUND',skuId:o.skuId,skuName:o.skuName,qty:o.qty,locationFrom:o.location,locationTo:'DISPATCH / DOCK',warehouseId:o.warehouseId,expiredDate:o.expiredDate,user:currentUser?.fullName||'Operator',description:'Outbound langsung: '+o.referenceNumber}});
        }
        for(const [name,items] of groups){
          const prior=batchesRef.current.find(b=>b.batchNumber===name);
          const id=prior?.id||'BATCH-'+crypto.randomUUID(),allItems=[...(prior?.items||[]),...items];
          const record={...prior,id,batchNumber:name,createdAt:prior?.createdAt||timestamp,updatedAt:timestamp,shippingStatus:prior?.shippingStatus||'BELUM_TERKIRIM',centralWmsStatus:prior?.centralWmsStatus||'BELUM_TERPOTONG',customerName:prior?.customerName||items[0].customerName||'Customer Outbound',createdBy:prior?.createdBy||currentUser?.fullName||'Operator',sourceReference:name,totalPcs:allItems.reduce((a,i)=>a+i.qty,0),totalSkus:new Set(allItems.map(i=>i.skuId)).size,items:allItems};
          upserts.push({collection_name:'batches',document_id:id,expected_revision:(prior as any)?.__wms_revision??null,merge:false,payload:record});
        }
        const directRes=await supabase.rpc('direct_outbound_scanned_admin',{
          p_request:crypto.randomUUID(),
          p_branch:getActiveBranch(),
          p_upserts:upserts,
          p_reason:'Outbound langsung terverifikasi melalui menu Quick Outbound'
        });
        if(!directRes.error)return true;
        const errCode=String(directRes.error.code||''),errMsg=String(directRes.error.message||'');
        if(errCode!=='PGRST202'&&!/could not find the function/i.test(errMsg))throw new Error(errMsg||'Penyimpanan outbound langsung ditolak server.');
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

  const completeServerScanPhase = async (
    branch: string,
    reference: string,
    basket: string,
    phase: 'sorting' | 'packing',
    fallbackItems?: Pick<OutboundItem, 'skuId' | 'qty'>[]
  ): Promise<'completed' | 'unavailable'> => {
    if (!supabase) return 'unavailable';
    const cleanBasket = (basket || reference).trim().toUpperCase();
    let sessionData: any = null;
    const statusRes = await supabase.rpc('get_order_scan_status', {
      p_branch: branch,
      p_reference: reference,
      p_phase: phase
    });
    if (statusRes.error) {
      const code = String(statusRes.error.code || '');
      const msg = String(statusRes.error.message || '');
      if (code === 'PGRST202' || /could not find the function/i.test(msg)) {
        return 'unavailable';
      }
      if (!/tidak ditemukan/i.test(msg)) {
        throw new Error(msg || 'Gagal memeriksa status scan server.');
      }
    } else {
      sessionData = statusRes.data;
    }

    if (
      sessionData &&
      sessionData.state === 'finished' &&
      sessionData.current === true &&
      (phase === 'packing' || String(sessionData.basket || '').trim().toUpperCase() === cleanBasket)
    ) {
      return 'completed';
    }

    if (
      sessionData &&
      sessionData.state === 'open' &&
      (sessionData.current !== true || String(sessionData.basket || '').trim().toUpperCase() !== cleanBasket)
    ) {
      const cancelRes = await supabase.rpc('cancel_order_scan', { p_session: sessionData.session });
      if (cancelRes.error) {
        throw new Error(cancelRes.error.message || 'Gagal mereset sesi scan sebelumnya.');
      }
      sessionData = null;
    }

    if (!sessionData || sessionData.state !== 'open') {
      const newSessionId = crypto.randomUUID();
      const startRes = await supabase.rpc('start_order_scan', {
        p_session: newSessionId,
        p_branch: branch,
        p_reference: reference,
        p_phase: phase,
        p_basket: cleanBasket
      });
      if (startRes.error) {
        const code = String(startRes.error.code || '');
        const msg = String(startRes.error.message || '');
        if (code === 'PGRST202' || /could not find the function/i.test(msg)) {
          return 'unavailable';
        }
        throw new Error(`${reference} (${cleanBasket}): ${msg || 'Gagal memulai sesi scan server.'}`);
      }
      sessionData = { session: newSessionId, state: 'open', counts: [] };
    }

    const sessionId = String(sessionData.session);
    const counts = Array.isArray(sessionData.counts) ? sessionData.counts : [];
    const scanCodes: string[] = [];
    if (counts.length > 0) {
      for (const line of counts) {
        const sku = String(line.sku || '').trim();
        const required = Number(line.required || 0);
        const scanned = Number(line.scanned || 0);
        const remaining = Math.max(0, required - scanned);
        for (let i = 0; i < remaining; i++) {
          scanCodes.push(sku);
        }
      }
    } else if (fallbackItems?.length) {
      for (const item of fallbackItems) {
        const sku = String(item.skuId || '').trim();
        const qty = Math.max(0, Number(item.qty || 0));
        for (let i = 0; i < qty; i++) {
          scanCodes.push(sku);
        }
      }
    }

    const scanWorkerCount = Math.min(4, scanCodes.length);
    let scanCursor = 0;
    await Promise.all(
      Array.from({ length: scanWorkerCount }, async () => {
        while (scanCursor < scanCodes.length) {
          const sku = scanCodes[scanCursor++];
          const recRes = await supabase.rpc('record_order_scan', {
            p_session: sessionId,
            p_request: crypto.randomUUID(),
            p_code: sku
          });
          if (recRes.error) {
            throw new Error(`${reference} (${sku}): ${recRes.error.message || 'Gagal mencatat scan ke server.'}`);
          }
        }
      })
    );

    const finRes = await supabase.rpc('finish_order_scan', {
      p_session: sessionId,
      p_request: crypto.randomUUID()
    });
    if (finRes.error) {
      throw new Error(`${reference} (${cleanBasket}): ${finRes.error.message || 'Gagal menyelesaikan sesi scan server.'}`);
    }
    return 'completed';
  };

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
      const packingUpdates=updates.filter(u=>!u.isPicking&&u.updatedItems.some(o=>o.status==='Completed'));
      const serverPackedRefs=new Set<string>();
      let stockAlreadyCommitted=false;

      if(packingUpdates.length>0){
        const packingRefSet=new Set(packingUpdates.map(u=>u.refNum));
        const unpickedOriginals=planned.originals.filter(o=>packingRefSet.has(o.referenceNumber)&&(!o.picked||!o.stockDeducted));
        if(unpickedOriginals.length>0||planned.changedStock.length>0){
          const prepBatch=writeBatch(db);
          for(const s of planned.changedStock)prepBatch.set(doc(db,'stock',s.id),s);
          for(const orig of unpickedOriginals){
            const plannedRow=planned.orders.find(o=>o.id===orig.id);
            prepBatch.set({...doc(db,'orders',orig.id),expectedRevision:(orig as any).__wms_revision??null},{
              ...(plannedRow||orig),
              status:'Pending',
              picked:true,
              stockDeducted:true
            });
          }
          await prepBatch.commit();
          stockAlreadyCommitted=true;
        }

        for(const u of packingUpdates){
          const origRows=orderHistoryRef.current.filter(o=>o.referenceNumber===u.refNum);
          const basket=(origRows[0]?.basketNumber||u.updatedItems[0]?.basketNumber||u.refNum).trim().toUpperCase();
          const alreadySorted=origRows.length>0&&origRows.every(o=>Boolean(o.sortedAt?.trim())&&Boolean(o.sortedBy?.trim())&&(o.basketNumber||'').trim().toUpperCase()===basket);
          if(!alreadySorted){
            await completeServerScanPhase(branchAtStart,u.refNum,basket,'sorting',u.updatedItems);
          }
          let packMode:'completed'|'unavailable';
          try{
            packMode=await completeServerScanPhase(branchAtStart,u.refNum,basket,'packing',u.updatedItems);
          }catch(packErr:any){
            if(/Sortir/i.test(String(packErr?.message||''))){
              await completeServerScanPhase(branchAtStart,u.refNum,basket,'sorting',u.updatedItems);
              packMode=await completeServerScanPhase(branchAtStart,u.refNum,basket,'packing',u.updatedItems);
            }else{
              throw packErr;
            }
          }
          if(packMode==='completed'){
            serverPackedRefs.add(u.refNum);
          }
        }
      }

      const batch=writeBatch(db);
      const newIds=new Set(planned.orders.map(o=>o.id));
      if(!stockAlreadyCommitted){
        for(const s of planned.changedStock)batch.set(doc(db,'stock',s.id),s);
      }
      for(const o of planned.originals)if(!newIds.has(o.id)&&!serverPackedRefs.has(o.referenceNumber))batch.delete({...doc(db,'orders',o.id),expectedRevision:(o as any).__wms_revision??null});
      for(const o of planned.orders)if(!serverPackedRefs.has(o.referenceNumber))batch.set({...doc(db,'orders',o.id),expectedRevision:(o as any).__wms_revision??null},o);
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
      if(serverPackedRefs.size>0){
        const refreshed=await getDocs(collection(db,'orders'));
        if(branchAtStart===getActiveBranch()){
          const rows=refreshed.docs.map(d=>d.data() as unknown as OutboundItem);
          orderHistoryRef.current=rows;
          setOrderHistory(rows);
        }
      }
      return true;
    }catch(error:any){alert('Order belum diselesaikan: '+(error.message||'Penyimpanan gagal. Muat data terbaru.'));return false;}
    finally{orderCompletionBusy.current=false;}
  };
  const handleEditOrderHistoryBatch = async (refNum:string,updatedItems:OutboundItem[],isPicking=false):Promise<boolean> =>
    handleEditMultipleOrdersBatch([{refNum,updatedItems,isPicking}]);

  const generateRpcRequestId = () => (
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        })
  );

  const handleAssignOrderType = async (
    assignments: Array<{ id?: string; referenceNumber?: string; orderType: ChannelOperationType }>
  ): Promise<boolean> => {
    try {
      if (!assignments || assignments.length === 0) return true;
      const byId = new Map<string, ChannelOperationType>();
      const byRef = new Map<string, ChannelOperationType>();
      for (const a of assignments) {
        if (a.id) byId.set(a.id.trim(), a.orderType);
        if (a.referenceNumber) byRef.set(a.referenceNumber.trim().toUpperCase(), a.orderType);
      }

      const nowIso = new Date().toISOString();
      const actorName = currentUser?.fullName || currentUser?.username || 'Admin WMS';
      const updated = orderHistoryRef.current.map((item) => {
        const ref = (item.referenceNumber || item.orderNumber || '').trim().toUpperCase();
        const assigned = byId.get((item.id || '').trim()) || (ref ? byRef.get(ref) : undefined);
        if (!assigned) return item;
        return {
          ...item,
          orderType: assigned,
          orderSource: item.orderSource || 'ADMIN_MANUAL_ASSIGN',
          orderTypeAssignedAt: nowIso,
          orderTypeAssignedBy: actorName,
        };
      });

      if (supabase) {
        const { error } = await supabase.rpc('assign_order_types', {
          p_request_id: generateRpcRequestId(),
          p_branch_id: getActiveBranch(),
          p_assignments: assignments,
        });
        if (!error) {
          setOrderHistory(updated);
          return true;
        }
        if (error.code === 'PGRST202') {
          const batch = writeBatch(db);
          for (const nextItem of updated) {
            const prev = orderHistoryRef.current.find((old) => old.id === nextItem.id);
            if (prev && (prev.orderType !== nextItem.orderType || prev.orderTypeAssignedAt !== nextItem.orderTypeAssignedAt)) {
              batch.set(doc(db, 'orders', nextItem.id), nextItem);
            }
          }
          await batch.commit();
          setOrderHistory(updated);
          return true;
        }
        throw new Error(error.message || 'Gagal mengklasifikasikan jenis order.');
      }

      saveOrderHistoryState(updated);
      return true;
    } catch (e) {
      console.error('Failed to assign order types:', e);
      alert(e instanceof Error ? e.message : 'Gagal mengklasifikasikan jenis order.');
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
    let usedServerScan=false;
    if(tasks.length>0){
      let cursor=0,unavailable=false,completedAny=false;
      const workerCount=Math.min(3,tasks.length);
      await Promise.all(
        Array.from({length:workerCount},async()=>{
          while(!unavailable&&cursor<tasks.length){
            const task=tasks[cursor++];
            const rows=fresh.filter(o=>o.referenceNumber===task.referenceNumber);
            const targetBasket=task.basketCode.trim().toUpperCase();
            const alreadySorted=rows.length===task.items.length&&rows.every(o=>Boolean(o.sortedAt?.trim())&&Boolean(o.sortedBy?.trim())&&(o.basketNumber||'').trim().toUpperCase()===targetBasket);
            if(alreadySorted){completedAny=true;continue;}
            const mode=await completeServerScanPhase(branch,task.referenceNumber,targetBasket,'sorting',rows);
            if(mode==='unavailable'){unavailable=true;break;}
            completedAny=true;
          }
        })
      );
      usedServerScan=!unavailable&&completedAny;
    }
    if(!usedServerScan&&updates.length){const batch=writeBatch(db);for(const order of updates)batch.set({...doc(db,'orders',order.id),expectedRevision:(order as any).__wms_revision??null},order);await batch.commit();}
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
          <p className="text-xs text-slate-400">{t('login.connecting')}</p>
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

        {/* Floating Language Switcher in Top-Right Corner */}
        <div className="absolute top-4 right-4 sm:top-6 sm:right-6 z-30 flex items-center gap-2 bg-[#11141B]/90 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-slate-800 shadow-xl">
          <Globe className="w-4 h-4 text-emerald-400 shrink-0" />
          <div className="flex items-center rounded-xl bg-slate-950 p-0.5 border border-slate-800">
            <button
              type="button"
              onClick={() => setLanguage('id')}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                language === 'id'
                  ? 'bg-emerald-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="Bahasa Indonesia"
            >
              🇮🇩 ID
            </button>
            <button
              type="button"
              onClick={() => setLanguage('en')}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                language === 'en'
                  ? 'bg-emerald-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="English"
            >
              🇬🇧 EN
            </button>
          </div>
        </div>

        <div className="max-w-4xl w-full grid grid-cols-1 md:grid-cols-12 gap-8 items-center relative z-10">
          {/* Brand Presentation Section */}
          <div className="md:col-span-5 space-y-6 text-center md:text-left">
            <div className="inline-flex p-1">
              <img src="/trueblue-wms-logo.png" alt="Logo TRUEBLUE WMS" className="w-40 h-40 sm:w-44 sm:h-44 object-contain drop-shadow-xl" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-white tracking-wider leading-tight uppercase font-sans">
                TRUEBLUE WMS
                <span className="text-emerald-400 block text-lg font-bold tracking-widest mt-1">{t('login.brandTag')}</span>
              </h1>
              <p className="text-slate-400 text-xs mt-3 leading-relaxed">
                {t('login.brandDesc')}
              </p>
            </div>
            
            <div className="hidden md:block p-4 rounded-2xl bg-slate-900/60 border border-slate-800/70 space-y-3.5 text-xs">
              <div className="flex items-center gap-2.5 text-slate-300">
                <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                <span>{t('login.featureFefo')}</span>
              </div>
              <div className="flex items-center gap-2.5 text-slate-300">
                <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                <span>{t('login.featureInboundOutbound')}</span>
              </div>
              <div className="flex items-center gap-2.5 text-slate-300">
                <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                <span>{t('login.featurePackSizes')}</span>
              </div>
            </div>
          </div>

          {/* Login Card */}
          <div className="md:col-span-7 bg-[#11141B] border border-slate-800/80 rounded-3xl shadow-2xl p-6 sm:p-8 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-amber-500"></div>
            
            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <h2 className="text-lg font-bold text-white">{t('login.title')}</h2>
                <p className="text-slate-400 text-xs mt-1">{t('login.subtitle')}</p>
              </div>
              <div className="flex items-center rounded-xl bg-[#161B25] p-1 border border-slate-800 shrink-0">
                <button
                  type="button"
                  onClick={() => setLanguage('id')}
                  className={`px-2.5 py-1 text-[11px] font-extrabold rounded-lg transition-all cursor-pointer ${
                    language === 'id'
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title="Bahasa Indonesia"
                >
                  🇮🇩 ID
                </button>
                <button
                  type="button"
                  onClick={() => setLanguage('en')}
                  className={`px-2.5 py-1 text-[11px] font-extrabold rounded-lg transition-all cursor-pointer ${
                    language === 'en'
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title="English"
                >
                  🇬🇧 EN
                </button>
              </div>
            </div>

            {!isSupabaseConfigured && (
              <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                Supabase belum dikonfigurasi. Salin .env.example ke .env, lalu isi URL proyek dan anon key dari dashboard Supabase.
              </p>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-wider font-extrabold text-slate-450 mb-1.5">{t('login.usernameLabel')}</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-500">
                    <User className="w-4 h-4" />
                  </span>
                  <input
                    type="text" autoComplete="username"
                    required
                    placeholder={t('login.usernamePlaceholder')}
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
                  <label className="block text-[10px] uppercase tracking-wider font-extrabold text-slate-450">{t('login.passwordLabel')}</label>
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-[10px] text-emerald-400 hover:text-emerald-300 font-bold"
                  >
                    {showPassword ? t('login.hidePassword') : t('login.showPassword')}
                  </button>
                </div>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-500">
                    <Lock className="w-4 h-4" />
                  </span>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    placeholder={t('login.passwordPlaceholder')}
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
                {t('login.submitBtn')}
              </button>
            </form>

            <div className="mt-6 pt-4 border-t border-slate-800/80 text-center text-[11px] text-slate-400">
              <p>© 2026 TRUEBLUE WMS · Copyright by <strong className="text-emerald-400 font-bold">KHOERUL AMRI</strong>. All rights reserved.</p>
            </div>
          </div>
        </div>

        {/* Footer login */}
        <footer className="mt-8 text-center text-xs text-slate-500 z-10">
          <p>© 2026 TRUEBLUE WMS — Copyright by KHOERUL AMRI. All rights reserved.</p>
        </footer>
      </div>
    );
  }

  return (
    <AppShell theme={theme} onToggleTheme={() => setTheme(nextUiTheme)} activeTab={activeTab} onNavigate={navigateFromMenu} currentUser={currentUser} connected={dbStatus==='connected'} stockSyncState={stockSyncState} onLogout={handleLogout} onUpload={handleForcePushStockToCloud} totalQty={totalSystemQty} onRefresh={()=>{if(confirm('Muat ulang data terbaru? Form yang belum disimpan akan ditutup.')){setLoading(true);setSyncTrigger(value=>value+1)}}} branchOperationType={branchOperationType} onBranchOperationTypeChange={setBranchOperationType}>
      <main className="blues-page">
          {updateAvailable && (
            <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-sky-400/40 bg-sky-500/15 px-4 py-3 text-sm text-sky-100 shadow-lg">
              <span>Versi WMS terbaru sudah tersedia.</span>
              <button type="button" className="rounded-lg bg-sky-400 px-3 py-1.5 font-bold text-slate-950 hover:bg-sky-300" onClick={() => window.location.reload()}>
                Muat ulang versi terbaru
              </button>
            </div>
          )}
          {isLoggedIn && currentUser?.role !== 'Shipping' && stock.length === 0 && (
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
              <UnassignedOrdersBanner
                orderHistory={orderHistory}
                currentUser={currentUser}
                onAssignOrderType={handleAssignOrderType}
              />
              <Dashboard 
                stock={stock} 
                logs={logs} 
                orderHistory={orderHistory}
                batches={batches}
                returns={returnHistory}
                onNavigate={navigateFromMenu}
                onOpenInventory={focus=>{if(!canBrowseInventory(currentUser?.role))return;setActiveWarehouseFilter('ALL');setInventoryEntryFocus(focus);setActiveTab('inventory');}}
                onOpenWork={stage=>{if(!canOpenWork(currentUser?.role,stage))return;setOutboundEntryMode(stage);setActiveTab(branchSupportsOperation(branchOperationType, 'B2B') ? (stage === 'validate' ? 'b2b-packing' : 'b2b-picking') : 'online-picking');}} 
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
                catalog={catalog}
                onSyncImportedNamesToCatalog={handleSyncImportedNamesToCatalog}
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



          {activeTab === 'picker-hub' && (
            <motion.div
              key="picker-hub"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <PickerHub
                currentUser={currentUser}
                branchOperationType={branchOperationType}
                onSelectMenu={(menuId) => navigateFromMenu(menuId)}
              />
            </motion.div>
          )}

          {(activeTab === 'b2b-input' || activeTab === 'b2b-picking' || activeTab === 'b2b-packing' || activeTab === 'b2b-history' || activeTab === 'online-input' || activeTab === 'online-history' || activeTab === 'orders' || activeTab === 'bulk') && (() => {
            const isOnlineTab = activeTab === 'online-input' || activeTab === 'online-history';
            const channelMode: ChannelOperationType = isOnlineTab
              ? 'ONLINE'
              : (activeTab === 'orders' && !branchSupportsOperation(branchOperationType, 'B2B') ? 'ONLINE' : 'B2B');
            const allowedModes: ('create' | 'pick' | 'validate' | 'history')[] =
              activeTab === 'b2b-input' || activeTab === 'online-input'
                ? ['create']
                : activeTab === 'b2b-picking'
                  ? ['pick']
                  : activeTab === 'b2b-packing'
                    ? ['validate']
                    : activeTab === 'b2b-history' || activeTab === 'online-history'
                      ? ['history']
                      : activeTab === 'orders'
                        ? ['create', 'history']
                        : (currentUser?.role === 'Picker' ? ['pick'] : currentUser?.role === 'Packer' ? ['validate'] : ['pick', 'validate']);
            const initialMode: OutboundMode =
              activeTab === 'b2b-input' || activeTab === 'online-input'
                ? 'create'
                : activeTab === 'b2b-picking'
                  ? 'pick'
                  : activeTab === 'b2b-packing'
                    ? 'validate'
                    : activeTab === 'b2b-history' || activeTab === 'online-history'
                      ? 'history'
                      : activeTab === 'orders'
                        ? (['create', 'history'].includes(outboundEntryMode as any) ? (outboundEntryMode as OutboundMode) : 'create')
                        : (currentUser?.role === 'Picker' ? 'pick' : currentUser?.role === 'Packer' ? 'validate' : (outboundEntryMode === 'validate' ? 'validate' : 'pick'));
            return (
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.15 }}
              >
                <BulkOutbound
                  key={activeTab}
                  channelMode={channelMode}
                  allowedModes={allowedModes}
                  initialMode={initialMode}
                  stock={stock}
                  catalog={catalog}
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
                  onAssignOrderType={handleAssignOrderType}
                />
              </motion.div>
            );
          })()}

          {(activeTab === 'online-picking' || activeTab === 'online-sorting' || activeTab === 'online-packing' || activeTab === 'mabang') && (
            <motion.div key="mabang-online" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }}>
              <MabangWmsOutbound
                stock={stock}
                orderHistory={orderHistory}
                onCompleteSorting={handleCompleteSorting}
                resolveSortingTarget={async (barcode, slots) => {
                  const clean = barcode.trim().toUpperCase();
                  const matchedSku = (findSkuId(clean) || clean).trim().toUpperCase();
                  for (const s of slots) {
                    const rows = orderHistoryRef.current.filter(o => o.referenceNumber === s.reference && o.status === 'Pending');
                    if (rows.some(o => o.skuId.trim().toUpperCase() === matchedSku || o.skuId.trim().toUpperCase() === clean || getBarcodeForSku(o.skuId).trim().toUpperCase() === clean)) {
                      return s.reference;
                    }
                  }
                  return undefined;
                }}
                currentUser={currentUser}
                onEditOrderHistoryBatch={handleEditOrderHistoryBatch}
                onEditMultipleOrdersBatch={handleEditMultipleOrdersBatch}
                onUpdateOrderSession={handleUpdateOrderSession}
                onOpenBasketLabelModal={() => setIsBasketLabelModalOpen(true)}
                requestedScreen={
                  activeTab === 'online-sorting'
                    ? 'sorting'
                    : activeTab === 'online-packing'
                      ? 'delivery'
                      : activeTab === 'online-picking'
                        ? 'distribution'
                        : mabangScreen
                }
                onScreenChange={(screen) => {
                  setMabangScreen(screen);
                  setActiveTab(screen === 'sorting' ? 'online-sorting' : screen === 'delivery' ? 'online-packing' : 'online-picking');
                }}
                requireExplicitOnlineType={true}
              />
            </motion.div>
          )}

          {activeTab === 'quick-outbound' && (
            <motion.div key="quick-outbound" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }}>
              <OutboundManager 
                stock={stock} 
                orderHistory={orderHistory} 
                warehouses={warehouses} 
                onProcessOutbound={handleProcessOutbound}
                currentUser={currentUser}
                branchOperationType={branchOperationType}
              />
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
                warehouses={warehouses}
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
                onSaveReturnHistory={saveReturnHistoryState}
                onProcessQc={handleProcessReturnQc}
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
                onBatchDeleteCatalogItems={handleBatchDeleteCatalogItems}
                onBatchImportCatalog={handleBatchImportCatalog}
                onSyncStockToCatalog={handleSyncStockToCatalog}
                onFetchAccessibleBranches={fetchAccessibleBranches}
                onFetchBranchCatalog={fetchBranchCatalog}
              />
            </motion.div>
          )}

          {activeTab === 'marketplace' && (currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && (
            <motion.div
              key="marketplace"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <React.Suspense fallback={<div className="rounded-2xl border border-slate-800/80 bg-[#11141B] p-6 text-sm text-slate-400">Memuat integrasi marketplace…</div>}>
                <MarketplaceIntegration currentUser={currentUser} catalog={catalog} />
              </React.Suspense>
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

          {activeTab === 'reconciliation' && (currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && (
            <motion.div
              key="reconciliation"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
            >
              <InventoryReconciliation
                stock={stock}
                orderHistory={orderHistory}
                catalog={catalog}
                warehouses={warehouses}
                currentUser={currentUser}
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
        <p>© 2026 TRUEBLUE WMS — Copyright by KHOERUL AMRI. All rights reserved.</p>
        <p>Warehouse operation · TRUEBLUE</p>
      </footer>
    </AppShell>
  );
}
