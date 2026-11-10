import { localScopeKey } from '../utils/localScope';
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { StockItem, PhysicalAuditItem, UserAccount } from '../types';
import { 
  calculatePackQuantities, 
  calculateTotalFromPacks, 
  formatNumber,
  getCanonicalStockId,
  isZoneOrUrbanLocation
} from '../utils/calculations';
import * as XLSX from 'xlsx';
import BarcodeScannerModal from './BarcodeScannerModal';
import StockOpnamePerLocation from './StockOpnamePerLocation';
import { getBarcodeForSku } from '../data/barcodeMap';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer, 
  Cell, 
  PieChart as RechartsPieChart, 
  Pie, 
  Legend, 
  ComposedChart, 
  Area 
} from 'recharts';
import { 
  DCC_SCHEDULE, 
  getDccScheduleByDay, 
  getCurrentDayName, 
  DccDay, 
  generateBalancedDccSchedule, 
  ALL_WAREHOUSE_SKUS 
} from '../data/dccSchedule';
import { 
  MapPin, 
  Search, 
  Plus, 
  Minus, 
  Calculator, 
  CheckCircle2, 
  AlertTriangle, 
  FileSpreadsheet, 
  ArrowLeft,
  Calendar,
  Clock,
  CalendarDays,
  Zap,
  History,
  Trash2,
  Database,
  Barcode,
  Download,
  Upload,
  BookOpen,
  ShieldCheck,
  X,
  Sparkles,
  Filter,
  Info,
  CheckSquare,
  Boxes,
  TrendingUp,
  FileText,
  ClipboardCheck,
  PieChart,
  BarChart3,
  Layers,
  ArrowUpRight,
  RefreshCw,
  RotateCcw,
  Grid,
  List,
  Check,
  Shuffle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight
} from 'lucide-react';

// Helper to create visual ASCII horizontal bar charts inside Excel cells
export function generateInCellBarChart(percent: number, width = 12): string {
  const normalized = Math.max(0, Math.min(100, isNaN(percent) ? 0 : percent));
  const filledCount = Math.round((normalized / 100) * width);
  const emptyCount = width - filledCount;
  const filledStr = '█'.repeat(filledCount);
  const emptyStr = '░'.repeat(emptyCount);
  return `${filledStr}${emptyStr} ${normalized.toFixed(1)}%`;
}

// Helper to categorize locations into rack groups for charts
export function getZoneGroupForLocation(locationName: string): string {
  if (!locationName) return 'Lainnya';
  const loc = locationName.toUpperCase().trim();
  if (loc.startsWith('E')) return 'Rak E';
  if (loc.startsWith('F')) return 'Rak F';
  if (loc.startsWith('D')) return 'Rak D';
  if (loc.startsWith('C') || loc.includes('RACK C')) return 'Rak C';
  if (loc.startsWith('B') || loc.includes('RACK B')) return 'Rak B';
  if (loc.includes('DISPLAY')) return 'Display';
  if (loc.includes('ZONE') || loc.includes('URBAN') || loc.includes('STAGE') || loc.includes('STAGING')) return 'Zone 1 & Urban';
  return 'Gudang Utama';
}

export interface CycleCountLocationEntry {
  warehouseId?: string;
  id: string;
  location: string;
  expiredDate: string;
  systemQty: number;
  ctnInput: number;
  innerInput: number;
  looseInput: number;
  physicalQty: number;
}

export interface CycleCountSkuItem {
  skuId: string;
  skuName: string;
  qtyCtnSize: number;
  qtyInnerSize: number;
  totalSystemQty: number;
  locations: CycleCountLocationEntry[];
  notes: string;
}

// Backward compatibility alias
export type CycleCountItem = CycleCountSkuItem;

interface CekFisikProps {
  stock: StockItem[];
  audits: PhysicalAuditItem[];
  saveAuditsState: (newAudits: PhysicalAuditItem[]) => void;
  currentUser: UserAccount | null;
  mode?: 'dcc' | 'daily-cycle-count';
  onAdjustStockCount: (
    skuId: string,
    location: string,
    expiredDate: string,
    newQty: number,
    operatorName: string,
    notes: string,
    id?: string
  ) => boolean;
  onAdjustStockCountBatch?: (
    adjustments: {
      skuId: string;
      location: string;
      expiredDate: string;
      newQty: number;
      operatorName: string;
      notes: string;
      id?: string;
      warehouseId?: string;
      expectedQty?: number;
    }[], audits?: PhysicalAuditItem[]
  ) => Promise<boolean>;
}

// Re-export shared helper to check if a location belongs to Zone 1 or Urban Storage
export { isZoneOrUrbanLocation } from '../utils/calculations';


// Parse warehouse location rank according to route specification:
// 1. E1 -> E11 (Ascending)
// 2. F11 -> F1 (Descending)
// 3. D11 -> D6/D1 (Descending)
// 4. Rack C
// 5. Rack B
// 6. Rack Display
// 7. Zone 1 & Urban (at the end)
export function parseLocationRank(locStr: string) {
  const norm = (locStr || '').trim().toUpperCase();

  // Group 7: ZONE 1 & URBAN & STAGING (at the very end)
  if (
    norm.includes('ZONE') ||
    norm.includes('URBAN') ||
    norm.includes('STAGING') ||
    norm.includes('STAGE')
  ) {
    return { group: 7, aisle: 0, sub: norm, sortAsc: true };
  }

  // Group 6: RACK DISPLAY / DISPLAY
  if (norm.includes('DISPLAY')) {
    return { group: 6, aisle: 0, sub: norm, sortAsc: true };
  }

  // Group 0: E Racks (E1 -> E11 Ascending)
  const eMatch = norm.match(/^E(\d+)(.*)$/);
  if (eMatch) {
    return { group: 0, aisle: parseInt(eMatch[1], 10), sub: eMatch[2], sortAsc: true };
  }

  // Group 1: F Racks (F11 -> F1 Descending)
  const fMatch = norm.match(/^F(\d+)(.*)$/);
  if (fMatch) {
    return { group: 1, aisle: parseInt(fMatch[1], 10), sub: fMatch[2], sortAsc: false };
  }

  // Group 2: D Racks (D11 -> D1 Descending)
  const dMatch = norm.match(/^D(\d+)(.*)$/);
  if (dMatch) {
    return { group: 2, aisle: parseInt(dMatch[1], 10), sub: dMatch[2], sortAsc: false };
  }

  // Group 3: C Racks
  const cMatch = norm.match(/^C(\d+)(.*)$/);
  if (cMatch) {
    return { group: 3, aisle: parseInt(cMatch[1], 10), sub: cMatch[2], sortAsc: true };
  }
  if (norm.includes('C-') || norm.includes('RACK C')) {
    return { group: 3, aisle: 0, sub: norm, sortAsc: true };
  }

  // Group 4: B Racks
  const bMatch = norm.match(/^B(\d+)(.*)$/);
  if (bMatch) {
    return { group: 4, aisle: parseInt(bMatch[1], 10), sub: bMatch[2], sortAsc: true };
  }
  if (norm.includes('B-') || norm.includes('RACK B')) {
    return { group: 4, aisle: 0, sub: norm, sortAsc: true };
  }

  // Group 5: A Racks / Other Racks
  const aMatch = norm.match(/^A(\d+)(.*)$/);
  if (aMatch) {
    return { group: 5, aisle: parseInt(aMatch[1], 10), sub: aMatch[2], sortAsc: true };
  }

  // Fallback (Group 7)
  return { group: 7, aisle: 0, sub: norm, sortAsc: true };
}

export function compareWarehouseLocations(locA: string, locB: string): number {
  const pA = parseLocationRank(locA);
  const pB = parseLocationRank(locB);

  if (pA.group !== pB.group) {
    return pA.group - pB.group;
  }

  if (pA.aisle !== pB.aisle) {
    if (pA.sortAsc === false) {
      return pB.aisle - pA.aisle;
    } else {
      return pA.aisle - pB.aisle;
    }
  }

  return pA.sub.localeCompare(pB.sub, undefined, { numeric: true });
}

export default function CekFisik({
  stock,
  audits,
  saveAuditsState,
  currentUser,
  mode = 'dcc',
  onAdjustStockCount,
  onAdjustStockCountBatch
}: CekFisikProps) {
  // Main Navigation Sub-Tabs - Persisted to localStorage so returning from other menus stays on same tab
  const [activeMainTab, setActiveMainTab] = useState<'CONSOLE' | 'CYCLE_COUNT' | 'RECONCILIATION' | 'HISTORY' | 'SCHEDULE' | 'CHARTS' | 'OPNAME_LOKASI'>(() => {
    try {
      const savedSubtab = localStorage.getItem('wms_dcc_active_subtab');
      if (savedSubtab && ['CONSOLE', 'CYCLE_COUNT', 'RECONCILIATION', 'HISTORY', 'SCHEDULE', 'CHARTS', 'OPNAME_LOKASI'].includes(savedSubtab)) {
        return savedSubtab as any;
      }
    } catch (e) {}
    return mode === 'daily-cycle-count' ? 'CYCLE_COUNT' : 'CONSOLE';
  });

  useEffect(() => {
    try {
      localStorage.setItem('wms_dcc_active_subtab', activeMainTab);
    } catch (e) {}
  }, [activeMainTab]);

  // Daily Cycle Count States - Persisted to prevent data loss on menu switch or reload
  const [cycleCountTargetQty, setCycleCountTargetQty] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('wms_dcc_target_qty');
      if (saved && !isNaN(Number(saved))) return Number(saved);
    } catch {}
    return 15;
  });

  useEffect(() => {
    try {
      localStorage.setItem('wms_dcc_target_qty', String(cycleCountTargetQty));
    } catch {}
  }, [cycleCountTargetQty]);

  // Active in-progress DCC Batch: restored from localStorage if available
  const [cycleCountBatch, setCycleCountBatch] = useState<CycleCountSkuItem[]>(() => {
    try {
      const saved = localStorage.getItem(localScopeKey('wms_dcc_active_batch',currentUser,true));
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('Failed to parse wms_dcc_active_batch', e);
    }
    return [];
  });

  // Automatically persist cycleCountBatch whenever items or counts change
  useEffect(() => {
    try {
      if (cycleCountBatch && cycleCountBatch.length > 0) {
        localStorage.setItem(localScopeKey('wms_dcc_active_batch',currentUser,true), JSON.stringify(cycleCountBatch));
      } else {
        localStorage.removeItem(localScopeKey('wms_dcc_active_batch',currentUser,true));
      }
    } catch (e) {
      console.warn('Failed to save wms_dcc_active_batch', e);
    }
  }, [cycleCountBatch]);

  const [confirmedDccBatch, setConfirmedDccBatch] = useState<CycleCountSkuItem[]>(() => {
    try {
      const saved = localStorage.getItem(localScopeKey('wms_dcc_confirmed_today',currentUser,true));
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [cycleCountSearchQuery, setCycleCountSearchQuery] = useState('');

  // DCC Schedule States
  const [selectedScheduleDay, setSelectedScheduleDay] = useState<DccDay | 'ALL'>(getCurrentDayName());
  const [scheduleSearchQuery, setScheduleSearchQuery] = useState('');

  // SKU Picker Modal States
  const [isSkuPickerOpen, setIsSkuPickerOpen] = useState(false);
  const [skuPickerSearch, setSkuPickerSearch] = useState('');
  const [selectedSkuIdsForPicker, setSelectedSkuIdsForPicker] = useState<string[]>([]);

  // Match Basis state: 'LOCATION' (Qty Per Rak) vs 'TOTAL_SKU' (Total Qty SKU)
  const [matchBasis, setMatchBasis] = useState<'LOCATION' | 'TOTAL_SKU'>('LOCATION');

  // Navigation & selection states
  const [selectedStockId, setSelectedStockId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [stockFilterTab, setStockFilterTab] = useState<'ALL' | 'NEED_AUDIT' | 'AUTO_ZONE_URBAN' | 'AUDITED' | 'DISCREPANCY'>('ALL');
  const [viewMode, setViewMode] = useState<'TABLE' | 'CARDS'>('TABLE');
  const [isScanModalOpen, setIsScanModalOpen] = useState(false);

  // Hide Audited / Set Match items state (Default: true so matched items vanish from active list)
  const [hideAudited, setHideAudited] = useState<boolean>(true);

  // Pagination states (Default 10 SKUs per page for compact display)
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);
  
  // Modals & Upload states
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false);
  const [uploadResult, setUploadResult] = useState<{
    total: number;
    matched: number;
    plus: number;
    minus: number;
    autoZoneUrban: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Tab for History search
  const [historySearchQuery, setHistorySearchQuery] = useState('');

  // Form States for selected Stock Item
  const [actualQty, setActualQty] = useState<number>(0);
  const [ctnInput, setCtnInput] = useState<number>(0);
  const [innerInput, setInnerInput] = useState<number>(0);
  const [looseInput, setLooseInput] = useState<number>(0);
  const [notes, setNotes] = useState('');

  // Helper to get pack sizes for a SKU
  const getProductPackSizes = (skuId: string): { qtyCtnSize: number; qtyInnerSize: number } => {
    const item = stock.find(s => s.skuId.toLowerCase() === skuId.toLowerCase());
    return {
      qtyCtnSize: item?.qtyCtnSize && item.qtyCtnSize > 0 ? item.qtyCtnSize : 24,
      qtyInnerSize: item?.qtyInnerSize && item.qtyInnerSize > 0 ? item.qtyInnerSize : 1,
    };
  };

  // Helper to get category for a SKU
  const getProductCategory = (skuId: string, skuName: string): string => {
    if (skuId.toLowerCase().includes('fast') || skuName.toLowerCase().includes('fast')) return 'FAST MOVING';
    return 'REGULAR';
  };

  // Helper to compute SKU total quantity across all locations
  const getSkuTotalQty = (skuId: string): number => {
    if (!skuId) return 0;
    return stock
      .filter(item => item.skuId.toLowerCase() === skuId.toLowerCase())
      .reduce((sum, item) => sum + item.qty, 0);
  };

  // Helper to create a complete CycleCountSkuItem with location breakdown
  const createCycleCountSkuItem = (skuId: string): CycleCountSkuItem => {
    // CRITICAL RULE: "dimenu dcc jangan tampilkan jika qty lokasi 0" -> Filter out locations with qty 0
    const matchingStock = stock.filter(s => s.skuId.toLowerCase() === skuId.toLowerCase() && s.qty > 0);
    const { qtyCtnSize, qtyInnerSize } = getProductPackSizes(skuId);
    const skuName = stock.find(s => s.skuId.toLowerCase() === skuId.toLowerCase())?.skuName || skuId;
    const totalSystemQty = matchingStock.reduce((sum, s) => sum + s.qty, 0);

    if (matchingStock.length === 0) {
      return {
        skuId,
        skuName,
        qtyCtnSize,
        qtyInnerSize,
        totalSystemQty: 0,
        locations: [],
        notes: ''
      };
    }

    const locations: CycleCountLocationEntry[] = matchingStock
      .slice()
      .sort((a, b) => compareWarehouseLocations(a.location, b.location))
      .map((s, idx) => {
        const packSplit = calculatePackQuantities(s.qty, qtyCtnSize, qtyInnerSize);
        return {
          id: s.id || `loc_${skuId}_${idx}`,
          warehouseId: s.warehouseId || 'WH-CENTRAL',
          location: s.location || 'GUDANG-UTAMA',
          expiredDate: s.expiredDate || '-',
          systemQty: s.qty,
          ctnInput: packSplit.qtyCtn,
          innerInput: packSplit.qtyInner,
          looseInput: packSplit.qtyLoose,
          physicalQty: s.qty
        };
      });

    return {
      skuId,
      skuName,
      qtyCtnSize,
      qtyInnerSize,
      totalSystemQty,
      locations,
      notes: ''
    };
  };

  // Generates Daily Cycle Count sample batch of SKUs with total system Qty > 0
  const generateDailyCycleCountBatch = (targetCount: number = 15) => {
    const activeSkuMap = new Map<string, string>();
    stock.forEach(item => {
      const totalQty = item.totalQtySku || getSkuTotalQty(item.skuId);
      if (totalQty > 0) {
        if (!activeSkuMap.has(item.skuId)) {
          activeSkuMap.set(item.skuId, item.skuName);
        }
      }
    });

    const availableSkuIds = Array.from(activeSkuMap.keys());

    // Fisher-Yates shuffle
    const shuffled = [...availableSkuIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const sampledSkuIds = shuffled.slice(0, targetCount);
    const newBatch = sampledSkuIds.map(skuId => createCycleCountSkuItem(skuId));

    setCycleCountBatch(newBatch);
  };

  // Auto-generate batch when entering CYCLE_COUNT tab ONLY if completely empty and no session saved
  const hasCheckedSavedBatchRef = useRef(false);
  useEffect(() => {
    if (activeMainTab === 'CYCLE_COUNT' && cycleCountBatch.length === 0 && stock.length > 0) {
      if (!hasCheckedSavedBatchRef.current) {
        hasCheckedSavedBatchRef.current = true;
        try {
          const saved = localStorage.getItem(localScopeKey('wms_dcc_active_batch',currentUser,true));
          if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setCycleCountBatch(parsed);
              return;
            }
          }
        } catch (e) {}
      }

      // Check if user already confirmed items today and finished their session
      try {
        const confirmedToday = localStorage.getItem(localScopeKey('wms_dcc_confirmed_today',currentUser,true));
        if (confirmedToday) {
          const parsed = JSON.parse(confirmedToday);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return; // Don't force a new random batch if they already completed their work
          }
        }
      } catch (e) {}

      generateDailyCycleCountBatch(cycleCountTargetQty);
    }
  }, [activeMainTab, stock]);

  // Current Day Name for DCC Schedule
  const todayDayName = useMemo(() => getCurrentDayName(), []);

  // Dynamic Balanced 5-Day DCC Schedule across all warehouse SKUs (rata per hari)
  const currentDccSchedule = useMemo(() => {
    const stockSkus = Array.from(new Set(stock.map(s => s.skuId.trim()))).filter(Boolean);
    const skusToUse = stockSkus.length > 0 ? stockSkus : ALL_WAREHOUSE_SKUS;
    return generateBalancedDccSchedule(skusToUse);
  }, [stock]);

  // Calculate total scheduled and active SKUs (with stock > 0) per day
  const scheduleCountsByDay = useMemo<Record<DccDay, { totalScheduled: number; activeWithStock: number }>>(() => {
    const counts = {} as Record<DccDay, { totalScheduled: number; activeWithStock: number }>;
    
    currentDccSchedule.forEach(item => {
      const totalScheduled = item.skus.length;
      const activeWithStock = item.skus.filter(skuId => getSkuTotalQty(skuId) > 0).length;
      counts[item.day] = { totalScheduled, activeWithStock };
    });

    return counts;
  }, [currentDccSchedule, stock]);

  // Get active scheduled SKUs (with stock > 0) for selected day and search query
  const scheduledSkuItems = useMemo(() => {
    let skuEntries: { day: DccDay; skuId: string }[] = [];

    if (selectedScheduleDay === 'ALL') {
      currentDccSchedule.forEach(item => {
        item.skus.forEach(skuId => {
          skuEntries.push({ day: item.day, skuId });
        });
      });
    } else {
      const dayData = currentDccSchedule.find(d => d.day === selectedScheduleDay);
      if (dayData) {
        dayData.skus.forEach(skuId => {
          skuEntries.push({ day: dayData.day, skuId });
        });
      }
    }

    // Filter 1: CRITICAL RULE - "jangan tampilkan jika stok 0"
    const activeEntries = skuEntries.filter(entry => getSkuTotalQty(entry.skuId) > 0);

    // Filter 2: Search query
    if (!scheduleSearchQuery.trim()) {
      return activeEntries;
    }

    const q = scheduleSearchQuery.trim().toLowerCase();
    return activeEntries.filter(entry => {
      const matchingStock = stock.filter(s => s.skuId.toLowerCase() === entry.skuId.toLowerCase());
      const skuName = matchingStock[0]?.skuName || '';
      const brand = matchingStock[0]?.brand || '';
      return entry.skuId.toLowerCase().includes(q) || skuName.toLowerCase().includes(q) || brand.toLowerCase().includes(q);
    });
  }, [selectedScheduleDay, scheduleSearchQuery, currentDccSchedule, stock]);

  // Load an entire day's schedule into the Daily Cycle Count batch (filtering out stock 0)
  const loadDccScheduleBatch = (day: DccDay) => {
    const scheduledSkus = getDccScheduleByDay(day, currentDccSchedule);
    const activeSkusWithStock = scheduledSkus.filter(skuId => getSkuTotalQty(skuId) > 0);

    if (activeSkusWithStock.length === 0) {
      alert(`Tidak ada SKU dengan stok > 0 pada jadwal hari ${day}. SKU dengan stok 0 disembunyikan secara otomatis.`);
      return;
    }

    const newBatch = activeSkusWithStock.map(skuId => createCycleCountSkuItem(skuId));
    setCycleCountBatch(newBatch);
    setActiveMainTab('CYCLE_COUNT');
  };

  // Add a single SKU from schedule to current batch
  const handleAddSkuToCycleCountBatch = (skuId: string) => {
    if (cycleCountBatch.some(item => item.skuId.toLowerCase() === skuId.toLowerCase())) {
      alert(`SKU ${skuId} sudah ada di dalam batch session count.`);
      return;
    }
    const newItem = createCycleCountSkuItem(skuId);
    setCycleCountBatch(prev => [newItem, ...prev]);
  };

  // Update Carton/Inner/Loose for a specific location inside an SKU
  const handleUpdateLocationPackInput = (
    skuId: string,
    locIndex: number,
    field: 'ctnInput' | 'innerInput' | 'looseInput',
    val: number
  ) => {
    const safeVal = Math.max(0, isNaN(val) ? 0 : val);
    setCycleCountBatch(prev => prev.map(item => {
      if (item.skuId.toLowerCase() === skuId.toLowerCase()) {
        const updatedLocs = item.locations.map((loc, idx) => {
          if (idx === locIndex) {
            const newCtn = field === 'ctnInput' ? safeVal : loc.ctnInput;
            const newInner = field === 'innerInput' ? safeVal : loc.innerInput;
            const newLoose = field === 'looseInput' ? safeVal : loc.looseInput;
            const newPhysical = calculateTotalFromPacks(newCtn, newInner, newLoose, item.qtyCtnSize, item.qtyInnerSize);
            return {
              ...loc,
              ctnInput: newCtn,
              innerInput: newInner,
              looseInput: newLoose,
              physicalQty: newPhysical
            };
          }
          return loc;
        });
        return { ...item, locations: updatedLocs };
      }
      return item;
    }));
  };

  // Set match for a single location row
  const handleSetLocationMatch = (skuId: string, locIndex: number) => {
    setCycleCountBatch(prev => prev.map(item => {
      if (item.skuId.toLowerCase() === skuId.toLowerCase()) {
        const updatedLocs = item.locations.map((loc, idx) => {
          if (idx === locIndex) {
            const packSplit = calculatePackQuantities(loc.systemQty, item.qtyCtnSize, item.qtyInnerSize);
            return {
              ...loc,
              ctnInput: packSplit.qtyCtn,
              innerInput: packSplit.qtyInner,
              looseInput: packSplit.qtyLoose,
              physicalQty: loc.systemQty
            };
          }
          return loc;
        });
        return { ...item, locations: updatedLocs };
      }
      return item;
    }));
  };

  // Set match for ALL SKUs and ALL locations in current Cycle Count session
  const handleSetAllCycleCountMatch = () => {
    setCycleCountBatch(prev => prev.map(item => {
      const updatedLocs = item.locations.map(loc => {
        const packSplit = calculatePackQuantities(loc.systemQty, item.qtyCtnSize, item.qtyInnerSize);
        return {
          ...loc,
          ctnInput: packSplit.qtyCtn,
          innerInput: packSplit.qtyInner,
          looseInput: packSplit.qtyLoose,
          physicalQty: loc.systemQty
        };
      });
      return { ...item, locations: updatedLocs };
    }));
  };

  // Set match for ALL locations of an SKU
  const handleSetSkuMatch = (skuId: string) => {
    setCycleCountBatch(prev => prev.map(item => {
      if (item.skuId.toLowerCase() === skuId.toLowerCase()) {
        const updatedLocs = item.locations.map(loc => {
          const packSplit = calculatePackQuantities(loc.systemQty, item.qtyCtnSize, item.qtyInnerSize);
          return {
            ...loc,
            ctnInput: packSplit.qtyCtn,
            innerInput: packSplit.qtyInner,
            looseInput: packSplit.qtyLoose,
            physicalQty: loc.systemQty
          };
        });
        return { ...item, locations: updatedLocs };
      }
      return item;
    }));
  };

  // Konfirmasi bahwa SKU itu sudah dihitung -> simpan audit log, update stok jika selisih, lalu hilangkan SKU dari daftar
  const handleConfirmDccSku = async (skuId: string) => {
    const skuItem = cycleCountBatch.find(item => item.skuId.toLowerCase() === skuId.toLowerCase());
    if (!skuItem) return;

    const operatorName = currentUser?.fullName || 'WMS Auditor';
    const newAuditRecords: PhysicalAuditItem[] = [];
    const adjustments: { skuId: string; location: string; expiredDate: string; newQty: number; operatorName: string; notes: string; id?: string; warehouseId?: string; expectedQty?: number }[] = [];

    // Prioritaskan lokasi yang memiliki systemQty > 0 atau physicalQty > 0
    const activeLocations = skuItem.locations.filter(l => l.systemQty > 0 || l.physicalQty > 0);
    const targetLocations = activeLocations.length > 0 ? activeLocations : skuItem.locations;

    targetLocations.forEach((loc, locIdx) => {
      const locDiff = loc.physicalQty - loc.systemQty;
      const locStatus: 'MATCH' | 'PLUS' | 'MINUS' = locDiff === 0 ? 'MATCH' : locDiff > 0 ? 'PLUS' : 'MINUS';

      newAuditRecords.push({
        id: `audit_dcc_confirm_${Date.now()}_${skuId}_${locIdx}`,
        timestamp: new Date().toISOString(),
        skuId: skuItem.skuId,
        skuName: skuItem.skuName,
        location: loc.location,
        expiredDate: loc.expiredDate || '-',
        systemQty: loc.systemQty,
        physicalQty: loc.physicalQty,
        difference: locDiff,
        status: locStatus,
        operator: operatorName,
        notes: `Konfirmasi DCC Hitung Selesai [${loc.ctnInput} CTN, ${loc.innerInput} INNER, ${loc.looseInput} PCS]`
      });

      if (locDiff !== 0) {
        adjustments.push({
          skuId: skuItem.skuId,
          id: loc.id, warehouseId: loc.warehouseId, expectedQty:loc.systemQty,
          location: loc.location,
          expiredDate: loc.expiredDate || '-',
          newQty: loc.physicalQty,
          operatorName,
          notes: `Penyesuaian DCC SKU ${skuItem.skuId} Lokasi ${loc.location}`
        });
      }
    });

    if (!onAdjustStockCountBatch || !await onAdjustStockCountBatch(adjustments,newAuditRecords)) return;

    // Simpan SKU yang terkonfirmasi ke dalam confirmedDccBatch untuk export excel
    setConfirmedDccBatch(prev => {
      const filtered = prev.filter(item => item.skuId.toLowerCase() !== skuId.toLowerCase());
      const updated = [...filtered, skuItem];
      try {
        localStorage.setItem(localScopeKey('wms_dcc_confirmed_today',currentUser,true), JSON.stringify(updated));
      } catch {}
      return updated;
    });

    // Hilangkan SKU dari daftar DCC setelah ada konfirmasi
    setCycleCountBatch(prev => prev.filter(item => item.skuId.toLowerCase() !== skuId.toLowerCase()));
  };

  // Add an extra location line to an SKU during audit session
  const handleAddLocationToSku = (skuId: string) => {
    const locName = prompt('Masukkan nama lokasi rak baru (contoh: RACK-B04, BULK-ZONE1):');
    if (!locName || !locName.trim()) return;
    const cleanLoc = locName.trim().toUpperCase();

    setCycleCountBatch(prev => prev.map(item => {
      if (item.skuId.toLowerCase() === skuId.toLowerCase()) {
        const wh = item.locations[0]?.warehouseId || stock.find(s => s.skuId.toLowerCase() === skuId.toLowerCase())?.warehouseId || 'WH-CENTRAL';
        if (item.locations.some(l => l.location.trim().toUpperCase() === cleanLoc && (l.warehouseId || 'WH-CENTRAL').toUpperCase() === wh.toUpperCase())) {
          alert(`Lokasi ${cleanLoc} sudah ada pada daftar hitung SKU ${item.skuId}.`);
          return item;
        }
        const existingInStock = stock.find(s =>
          s.skuId.toLowerCase() === skuId.toLowerCase() &&
          (s.location || '').trim().toUpperCase() === cleanLoc &&
          (s.warehouseId || 'WH-CENTRAL').toUpperCase() === wh.toUpperCase()
        );
        const normEd = existingInStock?.expiredDate || item.locations[0]?.expiredDate || stock.find(s => s.skuId.toLowerCase() === skuId.toLowerCase())?.expiredDate || 'No Expired';
        const sysQty = existingInStock?.qty || 0;
        const packSplit = calculatePackQuantities(sysQty, item.qtyCtnSize, item.qtyInnerSize);
        const newLoc: CycleCountLocationEntry = {
          id: existingInStock?.id || getCanonicalStockId(item.skuId, normEd, cleanLoc, wh),
          warehouseId: wh,
          location: cleanLoc,
          expiredDate: normEd,
          systemQty: sysQty,
          ctnInput: packSplit.qtyCtn,
          innerInput: packSplit.qtyInner,
          looseInput: packSplit.qtyLoose,
          physicalQty: sysQty
        };
        return { ...item, locations: [...item.locations, newLoc] };
      }
      return item;
    }));
  };

  // Remove SKU from current session batch
  const handleRemoveSkuFromBatch = (skuId: string) => {
    setCycleCountBatch(prev => prev.filter(item => item.skuId.toLowerCase() !== skuId.toLowerCase()));
  };

  // Remove specific location line from SKU
  const handleRemoveLocationFromSku = (skuId: string, locIndex: number) => {
    setCycleCountBatch(prev => prev.map(item => {
      if (item.skuId.toLowerCase() === skuId.toLowerCase()) {
        if (item.locations.length <= 1) return item;
        return {
          ...item,
          locations: item.locations.filter((_, idx) => idx !== locIndex)
        };
      }
      return item;
    }));
  };

  // List of active SKUs with system Qty > 0 for SKU Picker Modal
  const activeStockSkusList = useMemo(() => {
    const map = new Map<string, {
      skuId: string;
      skuName: string;
      totalSystemQty: number;
      locations: string[];
      qtyCtnSize: number;
      qtyInnerSize: number;
    }>();

    stock.forEach(item => {
      const totalQty = item.totalQtySku || getSkuTotalQty(item.skuId);
      if (totalQty > 0) {
        const packSizes = getProductPackSizes(item.skuId);
        if (!map.has(item.skuId)) {
          map.set(item.skuId, {
            skuId: item.skuId,
            skuName: item.skuName,
            totalSystemQty: totalQty,
            locations: [item.location],
            qtyCtnSize: packSizes.qtyCtnSize,
            qtyInnerSize: packSizes.qtyInnerSize
          });
        } else {
          const existing = map.get(item.skuId)!;
          if (!existing.locations.includes(item.location)) {
            existing.locations.push(item.location);
          }
        }
      }
    });

    return Array.from(map.values()).sort((a, b) => a.skuId.localeCompare(b.skuId));
  }, [stock]);

  // Open SKU selection modal
  const handleOpenSkuPicker = () => {
    setSelectedSkuIdsForPicker(cycleCountBatch.map(item => item.skuId));
    setSkuPickerSearch('');
    setIsSkuPickerOpen(true);
  };

  // Toggle SKU selection in modal
  const toggleSkuPickerSelection = (skuId: string) => {
    setSelectedSkuIdsForPicker(prev =>
      prev.includes(skuId) ? prev.filter(id => id !== skuId) : [...prev, skuId]
    );
  };

  const handleSelectAllInPicker = () => {
    setSelectedSkuIdsForPicker(activeStockSkusList.map(s => s.skuId));
  };

  const handleClearAllInPicker = () => {
    setSelectedSkuIdsForPicker([]);
  };

  const handleSelectFastMovingInPicker = () => {
    const fastSkuIds = activeStockSkusList
      .filter(s => getProductCategory(s.skuId, s.skuName) === 'FAST MOVING')
      .map(s => s.skuId);
    setSelectedSkuIdsForPicker(fastSkuIds);
  };

  const handleSelect15RandomInPicker = () => {
    const shuffled = activeStockSkusList.map(s => s.skuId);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setSelectedSkuIdsForPicker(shuffled.slice(0, 15));
  };

  const handleApplySkuPickerSelection = () => {
    const newBatch = selectedSkuIdsForPicker.map(skuId => createCycleCountSkuItem(skuId));
    setCycleCountBatch(newBatch);
    setIsSkuPickerOpen(false);
  };

  // Save Cycle Count session and adjust stock in WMS
  const handleSaveCycleCountSession = async () => {
    if (cycleCountBatch.length === 0) return;

    const operatorName = currentUser?.fullName || 'WMS Auditor';
    const newAuditRecords: PhysicalAuditItem[] = [];
    const adjustments: { skuId: string; location: string; expiredDate: string; newQty: number; operatorName: string; notes: string; id?: string; warehouseId?: string; expectedQty?: number }[] = [];

    cycleCountBatch.forEach((skuItem, skuIdx) => {
      skuItem.locations.forEach((loc, locIdx) => {
        const locDiff = loc.physicalQty - loc.systemQty;
        const locStatus: 'MATCH' | 'PLUS' | 'MINUS' = locDiff === 0 ? 'MATCH' : locDiff > 0 ? 'PLUS' : 'MINUS';

        newAuditRecords.push({
          id: `audit_cc_${Date.now()}_${skuIdx}_${locIdx}`,
          timestamp: new Date().toISOString(),
          skuId: skuItem.skuId,
          skuName: skuItem.skuName,
          location: loc.location,
          expiredDate: loc.expiredDate || '-',
          systemQty: loc.systemQty,
          physicalQty: loc.physicalQty,
          difference: locDiff,
          status: locStatus,
          operator: operatorName,
          notes: `Daily Cycle Count Lokasi ${loc.location} [${loc.ctnInput} CTN, ${loc.innerInput} INNER, ${loc.looseInput} PCS]`
        });

        if (locDiff !== 0) {
          adjustments.push({
            skuId: skuItem.skuId,
            id: loc.id, warehouseId:loc.warehouseId, expectedQty:loc.systemQty,
            location: loc.location,
            expiredDate: loc.expiredDate || '-',
            newQty: loc.physicalQty,
            operatorName,
            notes: `Penyesuaian Daily Cycle Count Lokasi ${loc.location}`
          });
        }
      });
    });

    if (!onAdjustStockCountBatch || !await onAdjustStockCountBatch(adjustments,newAuditRecords)) return;

    // Tambahkan seluruh batch ke confirmedDccBatch untuk export excel
    setConfirmedDccBatch(prev => {
      const existingSkuMap = new Map(prev.map(i => [i.skuId.toLowerCase(), i]));
      cycleCountBatch.forEach(item => {
        existingSkuMap.set(item.skuId.toLowerCase(), item);
      });
      const updated = Array.from(existingSkuMap.values());
      try {
        localStorage.setItem(localScopeKey('wms_dcc_confirmed_today',currentUser,true), JSON.stringify(updated));
      } catch {}
      return updated;
    });
    
    triggerDialog(
      'Daily Cycle Count Berhasil Disimpan',
      `Selesai! Data ${cycleCountBatch.length} SKU (${newAuditRecords.length} Baris Lokasi) Daily Cycle Count telah tersimpan dan disinkronkan ke riwayat audit WMS, dan kuantitas live stok sistem telah diupdate.`,
      undefined,
      'success'
    );
  };

  // Export Daily Cycle Count Report to Excel (Hanya hasil SKU yang sudah dikonfirmasi)
  const exportDailyCycleCountReport = () => {
    // Prioritas: SKU yang sudah dikonfirmasi hitung (confirmedDccBatch)
    const exportBatch = confirmedDccBatch.length > 0 ? confirmedDccBatch : cycleCountBatch;
    
    if (exportBatch.length === 0) {
      triggerDialog(
        'Belum Ada SKU Terkonfirmasi',
        'Belum ada SKU yang dikonfirmasi hitung pada sesi Daily Cycle Count. Silakan hitung fisik barang di rak dan klik tombol "Konfirmasi Dihitung" pada tiap SKU terlebih dahulu.',
        undefined,
        'warning'
      );
      return;
    }

    const isConfirmedOnly = confirmedDccBatch.length > 0;
    const dateStr = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toLocaleTimeString('id-ID');
    const operator = currentUser?.fullName || 'WMS Auditor';

    const totalSkus = exportBatch.length;
    let matchSkuCount = 0;
    let plusSkuCount = 0;
    let minusSkuCount = 0;

    exportBatch.forEach(item => {
      const totPhys = item.locations.reduce((sum, l) => sum + l.physicalQty, 0);
      const diff = totPhys - item.totalSystemQty;
      if (diff === 0) matchSkuCount++;
      else if (diff > 0) plusSkuCount++;
      else minusSkuCount++;
    });

    const accuracyPercent = totalSkus > 0 ? ((matchSkuCount / totalSkus) * 100).toFixed(1) : '0.0';

    const summaryRows = [
      ['========================================================================================================================'],
      ['                  WMS ENTERPRISE - LAPORAN HASIL KONFIRMASI DAILY CYCLE COUNT (DETAIL PER LOKASI & PACK)               '],
      ['========================================================================================================================'],
      ['TANGGAL AUDIT', dateStr, 'WAKTU CETAK', timeStr],
      ['AUDITOR IN-CHARGE', operator, 'METODE COUNT', 'INPUT KARTON, INNER, LOOSE PER LOKASI RAK'],
      ['SKU TERKONFIRMASI', `${totalSkus} Master SKU`, 'STATUS AKURASI', `${accuracyPercent}% MATCH RATE`],
      ['STATUS LAPORAN', isConfirmedOnly ? '✓ HASIL TERKONFIRMASI (FINAL COUNT)' : 'DRAFT HITUNG', '', ''],
      [''],
      ['1. RINGKASAN METRIK KINERJA CYCLE COUNT'],
      ['Metrik Indikator', 'Hasil Realisasi', 'Satuan', 'Evaluasi SOP'],
      ['Total Target SKU Sampling', totalSkus, 'Master SKU', 'Sesuai Target Session'],
      ['Jumlah SKU Match (Sesuai)', matchSkuCount, 'Master SKU', `${accuracyPercent}% Rate`],
      ['Jumlah SKU Surplus (+)', plusSkuCount, 'Master SKU', plusSkuCount === 0 ? '✓ Nil' : '⚠ Perlu Adjustment'],
      ['Jumlah SKU Defisit (-)', minusSkuCount, 'Master SKU', minusSkuCount === 0 ? '✓ Nil' : '⚠ Perlu Adjustment'],
      ['Tingkat Akurasi Cycle Count', `${accuracyPercent}%`, '% Match Rate', parseFloat(accuracyPercent) >= 98 ? '✓ MEMENUHI BENCHMARK' : '⚠ REVIEW PERLU'],
      [''],
      ['2. LEMBAR PERSETUJUAN & MANAJERIAL SIGN-OFF'],
      ['Dibuat Oleh (Auditor):', '', 'Diperiksa Oleh (Supervisor):', '', 'Disetujui Oleh (Manager):'],
      [''],
      ['(___________________________)', '', '(___________________________)', '', '(___________________________)'],
      ['Tanggal:', '', 'Tanggal:', '', 'Tanggal:']
    ];

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [{ wch: 32 }, { wch: 28 }, { wch: 25 }, { wch: 35 }];

    const detailRows: any[] = [];

    exportBatch.forEach((skuItem) => {
      skuItem.locations.forEach((loc) => {
        const diff = loc.physicalQty - loc.systemQty;
        const status = diff === 0 ? 'MATCH' : diff > 0 ? 'SURPLUS (+)' : 'DEFISIT (-)';
        detailRows.push({
          'SKU ID': skuItem.skuId,
          'Nama Barang / Master SKU': skuItem.skuName,
          'Lokasi Rak': loc.location,
          'ED Date': loc.expiredDate,
          'Ctn Size': skuItem.qtyCtnSize,
          'Inner Size': skuItem.qtyInnerSize,
          'Qty Sistem (Pcs)': loc.systemQty,
          'Input CTN': loc.ctnInput,
          'Input INNER': loc.innerInput,
          'Input PCS (Loose)': loc.looseInput,
          'Total Qty Fisik (Pcs)': loc.physicalQty,
          'Selisih (Pcs)': diff,
          'Status Match': status
        });
      });
    });

    detailRows.sort((a, b) => compareWarehouseLocations(a['Lokasi Rak'], b['Lokasi Rak']));
    detailRows.forEach((r, idx) => {
      r['No'] = idx + 1;
    });

    const wsDetail = XLSX.utils.json_to_sheet(detailRows);
    wsDetail['!cols'] = [
      { wch: 6 },
      { wch: 18 },
      { wch: 38 },
      { wch: 18 },
      { wch: 14 },
      { wch: 10 },
      { wch: 10 },
      { wch: 16 },
      { wch: 12 },
      { wch: 12 },
      { wch: 16 },
      { wch: 20 },
      { wch: 14 },
      { wch: 16 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, wsSummary, 'RINGKASAN_CYCLE_COUNT');
    XLSX.utils.book_append_sheet(workbook, wsDetail, 'DETAIL_LOKASI_CYCLE_COUNT');

    XLSX.writeFile(workbook, `Hasil_Konfirmasi_Daily_Cycle_Count_${totalSkus}SKU_${dateStr}.xlsx`);
  };

  // Custom Confirmation Dialog
  const [dialog, setDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm?: () => void;
    type?: 'success' | 'warning' | 'danger' | 'info';
  }>({
    isOpen: false,
    title: '',
    message: '',
  });

  const triggerDialog = (
    title: string,
    message: string,
    onConfirm?: () => void,
    type: 'success' | 'warning' | 'danger' | 'info' = 'warning'
  ) => {
    setDialog({
      isOpen: true,
      title,
      message,
      onConfirm: () => {
        if (onConfirm) onConfirm();
        setDialog(prev => ({ ...prev, isOpen: false }));
      },
      type
    });
  };

  // Reset entire opname progress & history
  const handleResetOpname = () => {
    triggerDialog(
      'Reset Process Stok Opname',
      'Apakah Anda yakin ingin mengulang & mereset seluruh progress stok opname? Seluruh riwayat audit opname akan dikosongkan dan status verifikasi dikembalikan ke kondisi awal.',
      () => {
        saveAuditsState([]);
        setSelectedStockId(null);
        setSearchQuery('');
        setStockFilterTab('ALL');
        setUploadResult(null);
        setActualQty(0);
        setCtnInput(0);
        setInnerInput(0);
        setLooseInput(0);
        setNotes('');
        triggerDialog(
          'Stok Opname Di-Reset',
          'Seluruh progress dan riwayat opname berhasil di-reset ke kondisi awal. Anda dapat memulai ulang proses opname.',
          undefined,
          'success'
        );
      },
      'danger'
    );
  };

  // Find selected stock item details
  const selectedItem = useMemo(() => {
    if (!selectedStockId) return null;
    return stock.find(item => item.id === selectedStockId) || null;
  }, [selectedStockId, stock]);

  // Sync calculator state from quantity
  const syncCalculatorFromQty = (qty: number, ctnSize: number, innerSize: number) => {
    const packs = calculatePackQuantities(qty, ctnSize, innerSize);
    setCtnInput(packs.qtyCtn);
    setInnerInput(packs.qtyInner);
    setLooseInput(packs.qtyLoose);
  };

  // Select an item to audit
  const handleSelectItem = (item: StockItem) => {
    setSelectedStockId(item.id);
    const targetQty = matchBasis === 'TOTAL_SKU' 
      ? (item.totalQtySku || getSkuTotalQty(item.skuId))
      : item.qty;
    setActualQty(targetQty);
    const isAutoZoneUrban = isZoneOrUrbanLocation(item.location);
    setNotes(isAutoZoneUrban ? 'Auto-Count Rule: Zone 1 & Urban Storage' : '');
    syncCalculatorFromQty(targetQty, item.qtyCtnSize, item.qtyInnerSize);
  };

  // Handle direct changes to actualQty
  const handleActualQtyChange = (val: number, ctnSize: number, innerSize: number) => {
    const safeVal = Math.max(0, val);
    setActualQty(safeVal);
    syncCalculatorFromQty(safeVal, ctnSize, innerSize);
  };

  // Handle changes inside field calculator
  const handleCalculatorChange = (
    type: 'ctn' | 'inner' | 'loose',
    val: number,
    ctnSize: number,
    innerSize: number
  ) => {
    const safeVal = Math.max(0, val);
    let nextCtn = ctnInput;
    let nextInner = innerInput;
    let nextLoose = looseInput;

    if (type === 'ctn') {
      nextCtn = safeVal;
      setCtnInput(safeVal);
    } else if (type === 'inner') {
      nextInner = safeVal;
      setInnerInput(safeVal);
    } else {
      nextLoose = safeVal;
      setLooseInput(safeVal);
    }

    const total = calculateTotalFromPacks(nextCtn, nextInner, nextLoose, ctnSize, innerSize);
    setActualQty(total);
  };

  // Quick offset adjustment (-10, -5, +5, +10)
  const handleQuickAdjust = (offset: number, ctnSize: number, innerSize: number) => {
    const nextQty = Math.max(0, actualQty + offset);
    handleActualQtyChange(nextQty, ctnSize, innerSize);
  };

  // Quick 1-click Set Match for a stock item directly from list/card
  const handleQuickSetMatch = (item: StockItem) => {
    const operatorName = currentUser?.fullName || 'WMS Auditor';
    const targetSystemQty = item.qty;

    const newAuditRecord: PhysicalAuditItem = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      skuId: item.skuId,
      skuName: item.skuName,
      location: item.location,
      expiredDate: item.expiredDate,
      systemQty: targetSystemQty,
      physicalQty: targetSystemQty,
      difference: 0,
      status: 'MATCH',
      operator: operatorName,
      notes: `Stok Opname Sesuai (${item.location})`
    };

    saveAuditsState([newAuditRecord, ...audits]);
    triggerDialog(
      'Set Match Berhasil',
      `Item ${item.skuId} (${item.location}) berhasil ditandai MATCH (Sesuai ${formatNumber(targetSystemQty)} pcs) di riwayat audit.`,
      undefined,
      'success'
    );
  };

  // Cancel auditing current item
  const handleCancel = () => {
    setSelectedStockId(null);
  };

  // Save audited stock item
  const handleSaveAudit = () => {
    if (!selectedItem) return;

    const operatorName = currentUser?.fullName || 'WMS Auditor';
    const targetSystemQty = matchBasis === 'TOTAL_SKU'
      ? (selectedItem.totalQtySku || getSkuTotalQty(selectedItem.skuId))
      : selectedItem.qty;
    const diff = actualQty - targetSystemQty;
    const status: 'MATCH' | 'PLUS' | 'MINUS' = diff === 0 ? 'MATCH' : diff > 0 ? 'PLUS' : 'MINUS';

    const saveAction = () => {
      const newAuditRecord: PhysicalAuditItem = {
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        skuId: selectedItem.skuId,
        skuName: selectedItem.skuName,
        location: selectedItem.location,
        expiredDate: selectedItem.expiredDate,
        systemQty: targetSystemQty,
        physicalQty: actualQty,
        difference: diff,
        status,
        operator: operatorName,
        notes: notes || (diff === 0 
          ? `Stok Opname sesuai ${matchBasis === 'TOTAL_SKU' ? 'Total Qty SKU' : 'sistem lokasi'}.` 
          : `Hasil pencatatan stok opname (${matchBasis === 'TOTAL_SKU' ? 'Basis Total SKU' : 'Basis Lokasi'})`)
      };

      saveAuditsState([newAuditRecord, ...audits]);
      
      if (diff !== 0) {
        onAdjustStockCount(
          selectedItem.skuId,
          selectedItem.location,
          selectedItem.expiredDate,
          actualQty,
          operatorName,
          notes || `Stok Opname ${matchBasis === 'TOTAL_SKU' ? 'Basis Total SKU' : 'Basis Lokasi'}`
        );
      }

      setSelectedStockId(null);
    };

    if (diff !== 0) {
      triggerDialog(
        'Konfirmasi Hasil Stok Opname',
        `Terdapat selisih sebesar ${diff > 0 ? '+' : ''}${diff} pcs (dibandingkan ${matchBasis === 'TOTAL_SKU' ? 'Total Qty SKU' : 'Stok Rak'}: ${targetSystemQty} pcs). Apakah Anda yakin ingin menyimpan hasil audit ini? (Data opname & selisih akan dicatat ke riwayat audit, dan kuantitas live stok sistem WMS akan diupdate sesuai hasil audit ini).`,
        saveAction,
        'warning'
      );
    } else {
      saveAction();
    }
  };

  // Export Audit Logs & Executive Summary Report to Excel
  const exportToExcel = () => {
    exportProfessionalStockOpnameReport();
  };

  // ---------------------------------------------------------------------------
  // EXPORT PROFESSIONAL EXECUTIVE STOCK OPNAME REPORT (MULTI-SHEET WORKBOOK)
  // ---------------------------------------------------------------------------
  const exportProfessionalStockOpnameReport = () => {
    const dateStr = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toLocaleTimeString('id-ID');
    const operator = currentUser?.fullName || 'WMS Auditor';

    const activeStock = stock.filter(item => {
      const totalSkuQty = item.totalQtySku || getSkuTotalQty(item.skuId);
      return totalSkuQty > 0;
    });

    const totalLocations = activeStock.length;
    const auditedLocations = stockCounts.audited;
    const progressRakPercent = stockCounts.total > 0 ? ((stockCounts.audited / stockCounts.total) * 100).toFixed(1) : '0.0';

    let totalSystemQtyAll = 0;
    let totalPhysicalQtyAll = 0;

    let matchCount = 0;
    let plusCount = 0;
    let minusCount = 0;
    let pendingCount = 0;

    activeStock.forEach(item => {
      totalSystemQtyAll += item.qty;
      const audit = audits.find(a => a.skuId.toLowerCase() === item.skuId.toLowerCase() && a.location.toLowerCase() === item.location.toLowerCase());
      const isAuto = isZoneOrUrbanLocation(item.location);

      if (audit) {
        if (audit.status === 'MATCH' || audit.difference === 0) {
          totalPhysicalQtyAll += item.qty;
          matchCount++;
        } else if (Math.abs(audit.physicalQty - item.qty) === Math.abs(audit.difference)) {
          totalPhysicalQtyAll += audit.physicalQty;
          if (audit.status === 'PLUS' || audit.difference > 0) plusCount++;
          else if (audit.status === 'MINUS' || audit.difference < 0) minusCount++;
        } else {
          totalPhysicalQtyAll += (item.qty + audit.difference);
          if (audit.status === 'PLUS' || audit.difference > 0) plusCount++;
          else if (audit.status === 'MINUS' || audit.difference < 0) minusCount++;
        }
      } else if (isAuto) {
        totalPhysicalQtyAll += item.qty;
        matchCount++;
      } else {
        totalPhysicalQtyAll += item.qty;
        pendingCount++;
      }
    });

    const netVariance = totalPhysicalQtyAll - totalSystemQtyAll;

    // Check if matching basis is TOTAL_SKU or LOCATION
    const isSkuBasis = matchBasis === 'TOTAL_SKU';

    let displayMatchCount = matchCount;
    let displayPlusCount = plusCount;
    let displayMinusCount = minusCount;
    let displayPendingCount = pendingCount;
    let displayTotalCount = totalLocations;
    let displayCountLabel = 'Jumlah Lokasi Rak';

    if (isSkuBasis) {
      displayMatchCount = stockCounts.matchUniqueSkus;
      displayPlusCount = stockCounts.plusUniqueSkus;
      displayMinusCount = stockCounts.minusUniqueSkus;
      displayPendingCount = stockCounts.pendingUniqueSkus;
      displayTotalCount = stockCounts.totalUniqueSkus;
      displayCountLabel = 'Jumlah Master SKU';
    }

    const displayMatchRatio = displayTotalCount > 0 ? ((displayMatchCount / displayTotalCount) * 100).toFixed(1) : '0.0';
    const displayPlusRatio = displayTotalCount > 0 ? ((displayPlusCount / displayTotalCount) * 100).toFixed(1) : '0.0';
    const displayMinusRatio = displayTotalCount > 0 ? ((displayMinusCount / displayTotalCount) * 100).toFixed(1) : '0.0';
    const displayPendingRatio = displayTotalCount > 0 ? ((displayPendingCount / displayTotalCount) * 100).toFixed(1) : '0.0';

    // SHEET 1: EXECUTIVE_DASHBOARD
    const executiveSummaryRows = [
      ['========================================================================================================================'],
      ['                      WMS ENTERPRISE EXECUTIVE REPORT - HASIL STOK OPNAME GUDANG WITH VISUAL CHARTS                     '],
      ['========================================================================================================================'],
      ['TANGGAL DOKUMEN', dateStr, 'WAKTU CETAK', timeStr, '', ''],
      ['AUDITOR IN-CHARGE', operator, 'VERIFIKASI SISTEM', 'WMS LIVE DATA AUDIT LOGS', '', ''],
      ['BASIS MATCHING', matchBasis === 'TOTAL_SKU' ? 'TOTAL QTY SKU (ALL WAREHOUSE)' : 'QTY RAK LOKASI SPESIFIK', 'STATUS OPNAME', auditedLocations === totalLocations ? '100% COMPLETE' : 'DALAM PROSES', '', ''],
      [''],
      ['1. SUMMARY KPI UTAMA & KINERJA AKURASI STOK OPNAME'],
      ['Indikator Metrik Kinerja (KPI)', 'Nilai Realisasi', 'Satuan', 'Visual Bar Chart Grafik', 'Standar Benchmark SOP', 'Status Evaluasi SOP'],
      ['Total Position Rak In-Scope', totalLocations, 'Lokasi Rak', generateInCellBarChart(100, 15), '100% Total Coverage', auditedLocations === totalLocations ? 'COMPLETE' : 'IN PROGRESS'],
      ['Total Unique Master SKU', stockCounts.totalUniqueSkus, 'Master SKU', generateInCellBarChart(100, 15), '100% Total Coverage', stockCounts.auditedUniqueSkus === stockCounts.totalUniqueSkus ? 'COMPLETE' : 'IN PROGRESS'],
      ['Progres Verifikasi Rak', `${auditedLocations} / ${totalLocations} (${progressRakPercent}%)`, 'Lokasi Rak', generateInCellBarChart(parseFloat(progressRakPercent), 15), 'Target 100% Completion', parseFloat(progressRakPercent) >= 100 ? 'SELESAI' : 'DALAM PROSES'],
      ['Progres Verifikasi Total SKU', `${stockCounts.auditedUniqueSkus} / ${stockCounts.totalUniqueSkus} (${stockCounts.skuProgressRate}%)`, 'Master SKU', generateInCellBarChart(parseFloat(stockCounts.skuProgressRate), 15), 'Target 100% Completion', parseFloat(stockCounts.skuProgressRate) >= 100 ? 'SELESAI' : 'DALAM PROSES'],
      ['Tingkat Akurasi Lokasi Rak', `${stockCounts.accuracyRate}%`, '% Match', generateInCellBarChart(parseFloat(stockCounts.accuracyRate), 15), 'SOP Standard >= 98.0%', parseFloat(stockCounts.accuracyRate) >= 98 ? '✓ MEMENUHI SOP' : '⚠ PERLU REVIEW'],
      ['Tingkat Akurasi Total SKU', `${stockCounts.skuAccuracyRate}%`, '% Match', generateInCellBarChart(parseFloat(stockCounts.skuAccuracyRate), 15), 'SOP Standard >= 98.0%', parseFloat(stockCounts.skuAccuracyRate) >= 98 ? '✓ MEMENUHI SOP' : '⚠ PERLU REVIEW'],
      ['Total Saldo Buku Sistem (WMS)', totalSystemQtyAll, 'Pcs', generateInCellBarChart(100, 15), 'Baseline Database WMS', 'Baseline Synchronized'],
      ['Total Stok Fisik Lapangan', totalPhysicalQtyAll, 'Pcs', generateInCellBarChart(totalSystemQtyAll > 0 ? (totalPhysicalQtyAll / totalSystemQtyAll) * 100 : 100, 15), 'Audited Physical Count', 'Audited'],
      ['Total Net Variansi Selisih Qty', netVariance, 'Pcs', netVariance === 0 ? '░░░░░░░░░░░░░░░ 0.0%' : netVariance > 0 ? `█${'░'.repeat(14)} +${netVariance} pcs` : `█${'░'.repeat(14)} -${Math.abs(netVariance)} pcs`, 'Target Variance = 0 Pcs', netVariance === 0 ? '✓ PERFECT MATCH' : '⚠ VARIANSI DETECTED'],
      ['Total Kelebihan Fisik (Surplus / Plus)', stockCounts.totalPlusQty, 'Pcs', generateInCellBarChart(totalSystemQtyAll > 0 ? (stockCounts.totalPlusQty / totalSystemQtyAll) * 100 : 0, 15), 'Audit Adjustment', stockCounts.totalPlusQty === 0 ? 'Nil' : 'Perlu Adjustment'],
      ['Total Kekurangan Fisik (Defisit / Minus)', stockCounts.totalMinusQty, 'Pcs', generateInCellBarChart(totalSystemQtyAll > 0 ? (stockCounts.totalMinusQty / totalSystemQtyAll) * 100 : 0, 15), 'Audit Adjustment', stockCounts.totalMinusQty === 0 ? 'Nil' : 'Perlu Adjustment'],
      [''],
      [`2. BREAKDOWN STATUS ${isSkuBasis ? 'MASTER SKU' : 'RAK'} HASIL OPNAME (VISUAL CHART BREAKDOWN)`],
      ['Kategori Status Opname', displayCountLabel, 'Selisih Delta (Pcs)', 'Proporsi %', 'Visual Bar Chart Grafik', 'Rekomendasi WMS'],
      ['Sesuai (MATCH)', displayMatchCount, 0, `${displayMatchRatio}%`, generateInCellBarChart(parseFloat(displayMatchRatio), 15), 'Lolos Verifikasi SOP'],
      ['Lebih (SURPLUS / PLUS)', displayPlusCount, `+${stockCounts.totalPlusQty}`, `${displayPlusRatio}%`, generateInCellBarChart(parseFloat(displayPlusRatio), 15), 'Lakukan Re-Count / Adjustment (+)'],
      ['Kurang (DEFISIT / MINUS)', displayMinusCount, `-${stockCounts.totalMinusQty}`, `${displayMinusRatio}%`, generateInCellBarChart(parseFloat(displayMinusRatio), 15), 'Investigasi / Adjustment (-)'],
      ['Belum Di-Audit (PENDING)', displayPendingCount, '-', `${displayPendingRatio}%`, generateInCellBarChart(parseFloat(displayPendingRatio), 15), 'Lanjutkan Verifikasi Rak'],
      [''],
      ['3. BREAKDOWN ATURAN AREA GUDANG (ZONE 1 & URBAN vs REGULAR)'],
      ['Kategori Area Rak', 'Jumlah Rak', 'Auto-Count Status', 'Visual Bar Chart', 'Catatan Aturan SOP WMS'],
      ['Zone 1 & Urban Storage Area', stockCounts.autoZoneUrban, 'AUTO-MATCH ACTIVE', generateInCellBarChart(totalLocations > 0 ? (stockCounts.autoZoneUrban / totalLocations) * 100 : 0, 15), 'Fast-moving storage - Auto Match Rule WMS'],
      ['Regular Storage Racks', stockCounts.needAudit, 'MANUAL AUDIT', generateInCellBarChart(totalLocations > 0 ? (stockCounts.needAudit / totalLocations) * 100 : 0, 15), 'Wajib dihitung fisik secara teliti di lapangan'],
      [''],
      ['4. TABEL SUMBER DOKUMEN & 1-CLICK NATIVE EXCEL CHART DATA RANGE'],
      ['📌 PETUNJUK MEMBUAT GRAFIK EXCEL NATIVE: Blok range tabel data di bawah ini, lalu pilih menu Insert > Chart (Alt + F1) pada MS Excel.'],
      ['Kategori Status Opname', displayCountLabel, 'Total Volume Selisih (Pcs)', 'Persentase Akurasi (%)'],
      ['Sesuai (MATCH)', displayMatchCount, 0, parseFloat(isSkuBasis ? stockCounts.skuAccuracyRate : stockCounts.accuracyRate)],
      ['Lebih (SURPLUS / PLUS)', displayPlusCount, stockCounts.totalPlusQty, parseFloat(displayPlusRatio)],
      ['Kurang (DEFISIT / MINUS)', displayMinusCount, stockCounts.totalMinusQty, parseFloat(displayMinusRatio)],
      ['Belum Audit (PENDING)', displayPendingCount, 0, parseFloat(displayPendingRatio)],
      [''],
      ['5. LEMBAR PERSETUJUAN & EXECUTIVES SIGN-OFF'],
      ['Dibuat Oleh (Auditor WMS):', '', 'Diperiksa Oleh (Warehouse Supervisor):', '', 'Disetujui Oleh (Operations Manager):'],
      [''],
      [''],
      ['(___________________________)', '', '(___________________________)', '', '(___________________________)'],
      ['Tanggal:', '', 'Tanggal:', '', 'Tanggal:'],
      ['========================================================================================================================']
    ];

    const wsSummary = XLSX.utils.aoa_to_sheet(executiveSummaryRows);
    wsSummary['!cols'] = [
      { wch: 38 },
      { wch: 28 },
      { wch: 24 },
      { wch: 28 },
      { wch: 32 },
      { wch: 28 }
    ];

    // SHEET 2: RINGKASAN_AKURASI_SKU
    const skuRows: any[] = [];
    let skuIndex = 1;

    stockCounts.skuAuditSummaryMap.forEach((summary, skuId) => {
      const diff = summary.totalPhysicalQty - summary.totalSystemQty;
      let skuStatus = 'PENDING';
      if (summary.auditedLocations > 0) {
        skuStatus = diff === 0 ? 'MATCH' : diff > 0 ? 'SURPLUS (+)' : 'DEFISIT (-)';
      }

      const accuracyNum = summary.totalSystemQty > 0 
        ? Math.max(0, 100 - (Math.abs(diff) / summary.totalSystemQty * 100))
        : 100;
      const accuracy = accuracyNum.toFixed(1) + '%';

      skuRows.push({
        'No': skuIndex++,
        'SKU ID': skuId,
        'Nama Barang / Master SKU': summary.skuName,
        'Jumlah Lokasi Rak': summary.totalLocations,
        'Rak Di-Audit': summary.auditedLocations,
        'Total Qty Sistem SKU (Pcs)': summary.totalSystemQty,
        'Total Qty Fisik Opname (Pcs)': summary.totalPhysicalQty,
        'Selisih SKU (Pcs)': diff,
        'Status Akurasi SKU': skuStatus,
        'Indikator Akurasi (%)': accuracy,
        'Visual Bar Chart Grafik': generateInCellBarChart(accuracyNum, 12),
        'Catatan Audit SKU': summary.auditedLocations === 0 
          ? 'Belum di-audit' 
          : diff === 0 ? 'Akurasi Total SKU Sempurna' : `Anomali selisih ${diff > 0 ? '+' : ''}${diff} pcs`
      });
    });

    const wsSkuSummary = XLSX.utils.json_to_sheet(skuRows);
    wsSkuSummary['!cols'] = [
      { wch: 6 },
      { wch: 18 },
      { wch: 42 },
      { wch: 18 },
      { wch: 15 },
      { wch: 24 },
      { wch: 25 },
      { wch: 18 },
      { wch: 20 },
      { wch: 20 },
      { wch: 26 },
      { wch: 35 }
    ];

    // SHEET 3: DETAIL_HASIL_AUDIT_LOKASI
    const auditDetailRows = audits.map((a, i) => ({
      'No': i + 1,
      'Waktu Audit': new Date(a.timestamp).toLocaleString('id-ID'),
      'SKU ID': a.skuId,
      'Nama Barang': a.skuName,
      'Lokasi Rak': a.location,
      'Expired Date': a.expiredDate,
      'Stok Sistem (Pcs)': a.systemQty,
      'Stok Fisik Opname (Pcs)': a.physicalQty,
      'Selisih (Pcs)': a.difference,
      'Status Audit': a.status,
      'Auditor / Operator': a.operator,
      'Catatan Opname': a.notes
    }));

    const wsAuditDetail = XLSX.utils.json_to_sheet(auditDetailRows.length > 0 ? auditDetailRows : [
      { 'Info': 'Belum ada data audit yang tersimpan dalam riwayat.' }
    ]);
    wsAuditDetail['!cols'] = [
      { wch: 6 },
      { wch: 20 },
      { wch: 16 },
      { wch: 38 },
      { wch: 16 },
      { wch: 14 },
      { wch: 18 },
      { wch: 20 },
      { wch: 14 },
      { wch: 16 },
      { wch: 22 },
      { wch: 35 }
    ];

    // SHEET 4: DAFTAR_SELISIH_REKONSILIASI
    const discrepancyRows = audits.filter(a => a.difference !== 0).map((a, i) => ({
      'No': i + 1,
      'Waktu Audit': new Date(a.timestamp).toLocaleString('id-ID'),
      'SKU ID': a.skuId,
      'Nama Barang': a.skuName,
      'Lokasi Rak': a.location,
      'Expired Date': a.expiredDate,
      'Stok Sistem (Pcs)': a.systemQty,
      'Stok Fisik Opname (Pcs)': a.physicalQty,
      'Selisih Variansi (Pcs)': a.difference,
      'Tipe Selisih': a.difference > 0 ? 'SURPLUS / PLUS' : 'DEFISIT / MINUS',
      'Auditor': a.operator,
      'Alasan / Catatan Discrepancy': a.notes,
      'Rencana Tindak Lanjut / Action Plan': 'Perlu Otorisasi Adjustment Stock'
    }));

    const wsDiscrepancy = XLSX.utils.json_to_sheet(discrepancyRows.length > 0 ? discrepancyRows : [
      { 'Info': 'Tidak ada selisih stok (100% Match)' }
    ]);
    wsDiscrepancy['!cols'] = [
      { wch: 6 },
      { wch: 20 },
      { wch: 16 },
      { wch: 38 },
      { wch: 16 },
      { wch: 14 },
      { wch: 18 },
      { wch: 20 },
      { wch: 20 },
      { wch: 18 },
      { wch: 22 },
      { wch: 35 },
      { wch: 35 }
    ];

    // Build Workbook
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, wsSummary, 'EXECUTIVE_DASHBOARD');
    XLSX.utils.book_append_sheet(workbook, wsSkuSummary, 'RINGKASAN_AKURASI_SKU');
    XLSX.utils.book_append_sheet(workbook, wsAuditDetail, 'DETAIL_AUDIT_LOKASI');
    XLSX.utils.book_append_sheet(workbook, wsDiscrepancy, 'DAFTAR_SELISIH_REKONSILIASI');

    XLSX.writeFile(workbook, `Report_Executive_Stock_Opname_WMS_${dateStr}.xlsx`);
  };

  // ---------------------------------------------------------------------------
  // GENERATE EXCEL TEMPLATE STOK OPNAME (WITH DASHBOARD & ZONE 1 / URBAN RULES)
  // ---------------------------------------------------------------------------
  const generateOpnameExcelTemplate = () => {
    const dateStr = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toLocaleTimeString('id-ID');
    const operator = currentUser?.fullName || 'WMS Auditor';

    const totalItems = stock.length;
    const uniqueSkus = new Set(stock.map(s => s.skuId)).size;
    let totalSystemQty = 0;
    let totalPhysicalQty = 0;
    let totalZoneUrbanCount = 0;
    let totalRegularCount = 0;
    let zoneUrbanSystemQty = 0;
    let regularSystemQty = 0;

    stock.forEach(item => {
      totalSystemQty += item.qty;
      const isAuto = isZoneOrUrbanLocation(item.location);
      if (isAuto) {
        totalZoneUrbanCount++;
        zoneUrbanSystemQty += item.qty;
        totalPhysicalQty += item.qty; // Auto-counted equal to system
      } else {
        totalRegularCount++;
        regularSystemQty += item.qty;
        totalPhysicalQty += item.qty; // Default template pre-fills equal to system
      }
    });

    // SHEET 1: DASHBOARD_SUMMARY
    const summaryRows = [
      ['================================================================================='],
      ['                 WMS PROFESSIONAL STOCK OPNAME CONTROL DASHBOARD                 '],
      ['================================================================================='],
      ['Tanggal Download', dateStr, 'Waktu', timeStr],
      ['Auditor In-Charge', operator, 'Status Sistem', 'ONLINE LIVE SYNC'],
      [''],
      ['METRIK KINERJA STOK OPNAME (SUMMARY METRICS)'],
      ['Parameter Indicator', 'Nilai / Jumlah', 'Satuan', 'Keterangan SOP WMS'],
      ['Total Posisi Rak In-Scope', totalItems, 'Lokasi Rak', 'Jumlah seluruh baris rak di-audit'],
      ['Total SKU Unik', uniqueSkus, 'SKU Code', 'Jumlah item produk terdaftar'],
      ['Total Saldo Sistem (Buku)', totalSystemQty, 'Pcs', 'Total stok terdaftar pada database WMS'],
      ['Total Est. Stok Fisik (Template)', totalPhysicalQty, 'Pcs', 'Pre-filled sesuai saldo sistem'],
      ['Total Selisih Variansi Qty', 0, 'Pcs', '0 (Seimbang / Balanced Default Template)'],
      [''],
      ['BREAKDOWN METODE VERIFIKASI RAK'],
      ['Kategori Area Rak', 'Jumlah Rak', 'Total Qty Sistem', 'Aturan / SOP Verifikasi Field'],
      ['Zone 1 & Urban Storage Area', totalZoneUrbanCount, zoneUrbanSystemQty, 'AUTO-COUNT MATCH (Aturan Khusus Zone 1 & Urban)'],
      ['Regular Storage Racks', totalRegularCount, regularSystemQty, 'Wajib Diperiksa & Diisi Oleh Auditor Lapangan'],
      [''],
      ['PETUNJUK SANGAT PENTING (SOP WMS):'],
      ['1', 'Field Counting Zone 1 & Urban', 'Kuantitas fisik otomatis dianggap MATCH (terisi sama dengan sistem). Tidak perlu dikoreksi kecuali ada instruksi supervisor.'],
      ['2', 'Field Counting Regular Racks', 'Auditor cukup mengisi/mengoreksi kolom Stok Fisik pada Sheet TEMPLATE_STOK_OPNAME.'],
      ['3', 'Proses Upload Result', 'Setelah selesai mengisi, simpan file ini dan unggah melalui menu Upload Hasil Excel di WMS.'],
      ['=================================================================================']
    ];

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [
      { wch: 32 },
      { wch: 28 },
      { wch: 20 },
      { wch: 55 }
    ];

    // SHEET 2: TEMPLATE_STOK_OPNAME
    const sortedStockForExport = [...stock].sort((a, b) => compareWarehouseLocations(a.location, b.location));
    const opnameRows = sortedStockForExport.map((item, idx) => {
      const isAuto = isZoneOrUrbanLocation(item.location);
      const ruleText = isAuto ? 'AUTO-COUNT (ZONE 1 & URBAN)' : 'REGULAR RACK AUDIT';
      const skuTotal = item.totalQtySku || getSkuTotalQty(item.skuId);
      
      return {
        'No': idx + 1,
        'SKU ID': item.skuId,
        'Nama Barang': item.skuName,
        'Lokasi Rak': item.location,
        'Expired Date': item.expiredDate,
        'Aturan Rule WMS': ruleText,
        'Stok Lokasi Rak (Pcs)': item.qty,
        'Total Stok SKU (Pcs)': skuTotal,
        'Stok Fisik (Opname)': matchBasis === 'TOTAL_SKU' ? skuTotal : item.qty, // Pre-filled baseline based on matchBasis
        'Catatan Opname': isAuto ? 'Auto-Count Zone 1 & Urban Rule' : 'Stok fisik lapangan'
      };
    });

    const wsTemplate = XLSX.utils.json_to_sheet(opnameRows);
    wsTemplate['!cols'] = [
      { wch: 6 },
      { wch: 16 },
      { wch: 40 },
      { wch: 18 },
      { wch: 16 },
      { wch: 28 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 },
      { wch: 35 }
    ];

    // SHEET 3: SOP_RULES_POLICIES
    const sopRows = [
      ['================================================================================='],
      ['                   STANDAR OPERASIONAL PROSEDUR (SOP) STOK OPNAME                '],
      ['================================================================================='],
      ['1. ATURAN VERIFIKASI OTOMATIS (ZONE 1 & URBAN STORAGE AREA)'],
      ['• Dalam file template Excel, nilai "Stok Fisik (Opname)" diisi sama persis dengan "Stok Sistem (Pcs)" secara otomatis.'],
      ['• Sistem WMS mengkategorikan area ZONE 1 dan URBAN sebagai Fast-Moving / High-Turnover Zone.'],
      ['• Verifikasi untuk lokasi ini bersifat Auto-Match kecuali jika auditor menemukan anomali fisik berlebih/kurang.'],
      [''],
      ['2. PROSEDUR HITUNG RAK REGULER (REGULAR RACKS)'],
      ['• Auditor wajib mendatangi fisik lokasi rak tertera di kolom "Lokasi Rak".'],
      ['• Hitung jumlah kemasan (Karton/Ctn, Inner Box, atau Loose Pcs) dan konversikan ke total Pcs.'],
      ['• Jika terdapat selisih, ubah angka di kolom "Stok Fisik (Opname)".'],
      [''],
      ['3. KETENTUAN SELISIH & CATATAN OPNAME'],
      ['• Apabila terjadi selisih (Plus / Surplus atau Minus / Defisit), sertakan alasan singkat di kolom "Catatan Opname".'],
      ['• Contoh alasan valid: Kemasan Sobek, Salah Susun Rak, Inbound Error, Expired, Anomali Fisik.'],
      ['=================================================================================']
    ];

    const wsSop = XLSX.utils.aoa_to_sheet(sopRows);
    wsSop['!cols'] = [{ wch: 100 }];

    // Build Workbook
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, wsSummary, 'SUMMARY_DASHBOARD');
    XLSX.utils.book_append_sheet(workbook, wsTemplate, 'TEMPLATE_STOK_OPNAME');
    XLSX.utils.book_append_sheet(workbook, wsSop, 'SOP_RULES_POLICIES');

    XLSX.writeFile(workbook, `Template_Stock_Opname_WMS_${dateStr}.xlsx`);
  };

  // ---------------------------------------------------------------------------
  // HANDLE UPLOAD EXCEL RESULT & AUTO PROCESS
  // ---------------------------------------------------------------------------
  const processExcelOpnameFile = (file: File) => {
    setIsProcessingUpload(true);
    const reader = new FileReader();

    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        const sheetName = workbook.SheetNames.includes('TEMPLATE_STOK_OPNAME') 
          ? 'TEMPLATE_STOK_OPNAME' 
          : workbook.SheetNames[0];

        const worksheet = workbook.Sheets[sheetName];
        const rawJson: any[] = XLSX.utils.sheet_to_json(worksheet);

        if (!rawJson || rawJson.length === 0) {
          alert('File Excel kosong atau format tidak sesuai template Stok Opname.');
          setIsProcessingUpload(false);
          return;
        }

        const operatorName = currentUser?.fullName || 'WMS Auditor Excel';
        let totalCounted = 0;
        let matchCount = 0;
        let plusCount = 0;
        let minusCount = 0;
        let autoZoneUrbanCount = 0;

        const newAuditRecords: PhysicalAuditItem[] = [];
        const adjustments: {
          skuId: string;
          location: string;
          expiredDate: string;
          newQty: number;
          operatorName: string;
          notes: string;
          id?: string;
        }[] = [];

        rawJson.forEach(row => {
          const skuId = String(row['SKU ID'] || row['skuId'] || row['SKU'] || '').trim();
          const location = String(row['Lokasi Rak'] || row['location'] || row['Lokasi'] || '').trim();
          const rawPhysicalQty = row['Stok Fisik (Opname)'] ?? row['physicalQty'] ?? row['Fisik'] ?? row['Stok Fisik'] ?? row['Total Stok SKU (Pcs)'];
          const notesText = String(row['Catatan Opname'] || row['notes'] || row['Catatan'] || 'Opname Import Excel').trim();

          if (!skuId) return;

          // Find matching stock item by location if provided, else first matching item by SKU
          let matchedStock = location 
            ? stock.find(s => s.skuId.toLowerCase() === skuId.toLowerCase() && s.location.toLowerCase() === location.toLowerCase())
            : stock.find(s => s.skuId.toLowerCase() === skuId.toLowerCase());

          if (!matchedStock) return;

          const systemQty = matchBasis === 'TOTAL_SKU'
            ? (matchedStock.totalQtySku || getSkuTotalQty(matchedStock.skuId))
            : matchedStock.qty;
          const physicalQty = parseInt(String(rawPhysicalQty), 10);
          
          if (isNaN(physicalQty) || physicalQty < 0) return;

          const diff = physicalQty - systemQty;
          const status: 'MATCH' | 'PLUS' | 'MINUS' = diff === 0 ? 'MATCH' : diff > 0 ? 'PLUS' : 'MINUS';

          totalCounted++;
          if (status === 'MATCH') matchCount++;
          if (status === 'PLUS') plusCount++;
          if (status === 'MINUS') minusCount++;

          if (isZoneOrUrbanLocation(matchedStock.location)) {
            autoZoneUrbanCount++;
          }

          adjustments.push({
            skuId: matchedStock.skuId,
            location: matchedStock.location,
            expiredDate: matchedStock.expiredDate,
            newQty: physicalQty,
            operatorName,
            notes: notesText,
            id: matchedStock.id
          });

          newAuditRecords.push({
            id: `audit_excel_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            timestamp: new Date().toISOString(),
            skuId: matchedStock.skuId,
            skuName: matchedStock.skuName,
            location: matchedStock.location,
            expiredDate: matchedStock.expiredDate,
            systemQty,
            physicalQty,
            difference: diff,
            status,
            operator: operatorName,
            notes: notesText
          });
        });

        if (newAuditRecords.length > 0) {
          saveAuditsState([...newAuditRecords, ...audits]);
          setUploadResult({
            total: totalCounted,
            matched: matchCount,
            plus: plusCount,
            minus: minusCount,
            autoZoneUrban: autoZoneUrbanCount
          });
        } else {
          alert('Tidak ada baris stok yang berhasil dicocokkan dengan lokasi dan SKU di sistem WMS.');
        }

      } catch (err) {
        console.error('Error processing Excel upload:', err);
        alert('Terjadi kesalahan format saat membaca file Excel. Pastikan file menggunakan format template yang benar.');
      } finally {
        setIsProcessingUpload(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };

    reader.readAsArrayBuffer(file);
  };

  const handleExcelFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processExcelOpnameFile(file);
    }
    if (e.target) e.target.value = '';
  };

  // 1-Click Auto Verify Zone 1 & Urban Locations
  const handle1ClickAutoVerifyZoneUrban = () => {
    const zoneUrbanItems = stock.filter(i => isZoneOrUrbanLocation(i.location));
    
    if (zoneUrbanItems.length === 0) {
      triggerDialog(
        'Informasi Auto-Verify',
        'Tidak ditemukan item stok yang berlokasi di area Zone 1 atau Urban Storage.',
        undefined,
        'info'
      );
      return;
    }

    triggerDialog(
      'Konfirmasi 1-Click Auto-Verify',
      `Terdapat ${zoneUrbanItems.length} item stok berlokasi di area Zone 1 & Urban. Apakah Anda ingin menandai seluruh item ini sebagai MATCH (Sesuai Sistem) secara otomatis?`,
      () => {
        const operatorName = currentUser?.fullName || 'WMS Auto-Rule System';
        const newAuditRecords: PhysicalAuditItem[] = [];
        const adjustments: {
          skuId: string;
          location: string;
          expiredDate: string;
          newQty: number;
          operatorName: string;
          notes: string;
          id?: string;
        }[] = [];

        zoneUrbanItems.forEach((item, idx) => {
          const targetQty = matchBasis === 'TOTAL_SKU'
            ? (item.totalQtySku || getSkuTotalQty(item.skuId))
            : item.qty;

          adjustments.push({
            skuId: item.skuId,
            location: item.location,
            expiredDate: item.expiredDate,
            newQty: targetQty,
            operatorName,
            notes: 'Auto-Count Rule: Zone 1 & Urban Verified',
            id: item.id
          });

          newAuditRecords.push({
            id: `audit_auto_zu_${Date.now()}_${idx}`,
            timestamp: new Date().toISOString(),
            skuId: item.skuId,
            skuName: item.skuName,
            location: item.location,
            expiredDate: item.expiredDate,
            systemQty: targetQty,
            physicalQty: targetQty,
            difference: 0,
            status: 'MATCH',
            operator: operatorName,
            notes: 'Auto-Counted (Zone 1 & Urban Rule)'
          });
        });

        saveAuditsState([...newAuditRecords, ...audits]);
        triggerDialog(
          'Berhasil Verifikasi',
          `Selesai! ${zoneUrbanItems.length} item di lokasi Zone 1 & Urban berhasil diverifikasi otomatis di riwayat audit (tanpa mengubah kuantitas live stok sistem).`,
          undefined,
          'success'
        );
      },
      'info'
    );
  };

  // Clear single history row
  const handleDeleteHistoryRow = (id: string) => {
    triggerDialog(
      'Hapus Riwayat Opname',
      'Apakah Anda yakin ingin menghapus catatan riwayat stok opname ini dari history?',
      () => {
        saveAuditsState(audits.filter(a => a.id !== id));
      },
      'danger'
    );
  };

  // Clear all history
  const handleClearAllHistory = () => {
    triggerDialog(
      'Kosongkan Semua Riwayat',
      'PERINGATAN! Tindakan ini akan menghapus seluruh riwayat stok opname secara permanen dari database. Apakah Anda yakin?',
      () => {
        saveAuditsState([]);
      },
      'danger'
    );
  };

  // Metrics for Filter tabs & KPI Header
  const stockCounts = useMemo(() => {
    // Exclude stock items where total SKU system quantity is 0
    const activeStock = stock.filter(item => {
      const totalSkuQty = item.totalQtySku || getSkuTotalQty(item.skuId);
      return totalSkuQty > 0;
    });

    const total = activeStock.length;
    const autoZoneUrban = activeStock.filter(i => isZoneOrUrbanLocation(i.location)).length;
    const needAudit = total - autoZoneUrban;
    const audited = activeStock.filter(item => 
      audits.some(a => a.skuId.toLowerCase() === item.skuId.toLowerCase() && a.location.toLowerCase() === item.location.toLowerCase()) || isZoneOrUrbanLocation(item.location)
    ).length;

    // Discrepancies
    const discrepancies = activeStock.filter(item => {
      const audit = audits.find(a => a.skuId === item.skuId && a.location === item.location);
      return audit && audit.difference !== 0;
    }).length;

    // Accuracy Rate % (Location Rak)
    const auditedRecords = audits.length;
    const matchRecords = audits.filter(a => a.status === 'MATCH').length;
    const accuracyRate = auditedRecords > 0 ? ((matchRecords / auditedRecords) * 100).toFixed(1) : '100.0';

    // Total System vs Physical Qty across audits
    let totalPlusQty = 0;
    let totalMinusQty = 0;
    audits.forEach(a => {
      if (a.difference > 0) totalPlusQty += a.difference;
      if (a.difference < 0) totalMinusQty += Math.abs(a.difference);
    });

    // ---------------------------------------------------------------
    // SKU LEVEL ACCURACY & PROGRESS COMPUTATION
    // ---------------------------------------------------------------
    const uniqueSkuIds = Array.from(new Set(activeStock.map(s => s.skuId)));
    const totalUniqueSkus = uniqueSkuIds.length;

    const skuAuditSummaryMap = new Map<string, {
      skuName: string;
      totalSystemQty: number;
      totalPhysicalQty: number;
      totalLocations: number;
      auditedLocations: number;
    }>();

    activeStock.forEach(item => {
      const existing = skuAuditSummaryMap.get(item.skuId) || {
        skuName: item.skuName,
        totalSystemQty: 0,
        totalPhysicalQty: 0,
        totalLocations: 0,
        auditedLocations: 0,
      };

      existing.totalSystemQty += item.qty;
      existing.totalLocations += 1;

      // Find if this item in location is audited
      const audit = audits.find(a => a.skuId.toLowerCase() === item.skuId.toLowerCase() && a.location.toLowerCase() === item.location.toLowerCase());
      if (audit) {
        existing.auditedLocations += 1;
        if (audit.status === 'MATCH' || audit.difference === 0) {
          existing.totalPhysicalQty += item.qty;
        } else if (Math.abs(audit.physicalQty - item.qty) === Math.abs(audit.difference)) {
          existing.totalPhysicalQty += audit.physicalQty;
        } else {
          existing.totalPhysicalQty += item.qty + audit.difference;
        }
      } else {
        // Un-audited locations assume baseline system qty (or Auto-Zone/Urban)
        existing.totalPhysicalQty += item.qty;
        if (isZoneOrUrbanLocation(item.location)) {
          existing.auditedLocations += 1;
        }
      }

      skuAuditSummaryMap.set(item.skuId, existing);
    });

    let auditedUniqueSkus = 0;
    let matchUniqueSkus = 0;
    let plusUniqueSkus = 0;
    let minusUniqueSkus = 0;
    let pendingUniqueSkus = 0;
    let discrepancyUniqueSkus = 0;

    skuAuditSummaryMap.forEach((summary) => {
      const diff = summary.totalPhysicalQty - summary.totalSystemQty;
      if (summary.auditedLocations > 0) {
        auditedUniqueSkus += 1;
        if (diff === 0) {
          matchUniqueSkus += 1;
        } else if (diff > 0) {
          plusUniqueSkus += 1;
          discrepancyUniqueSkus += 1;
        } else {
          minusUniqueSkus += 1;
          discrepancyUniqueSkus += 1;
        }
      } else {
        pendingUniqueSkus += 1;
      }
    });

    const skuProgressRate = totalUniqueSkus > 0 
      ? ((auditedUniqueSkus / totalUniqueSkus) * 100).toFixed(1) 
      : '0.0';

    const skuAccuracyRate = auditedUniqueSkus > 0 
      ? ((matchUniqueSkus / auditedUniqueSkus) * 100).toFixed(1) 
      : '100.0';

    return { 
      total, 
      autoZoneUrban, 
      needAudit, 
      audited, 
      discrepancies, 
      accuracyRate,
      totalPlusQty,
      totalMinusQty,
      // SKU Level Metrics
      totalUniqueSkus,
      auditedUniqueSkus,
      matchUniqueSkus,
      plusUniqueSkus,
      minusUniqueSkus,
      pendingUniqueSkus,
      discrepancyUniqueSkus,
      skuProgressRate,
      skuAccuracyRate,
      skuAuditSummaryMap
    };
  }, [stock, audits]);

  // Items with discrepancy specifically for Reconciliation tab
  const discrepancyItems = useMemo(() => {
    const map = new Map<string, { stockItem: StockItem; auditRecord: PhysicalAuditItem }>();
    audits.forEach(audit => {
      if (audit.difference !== 0) {
        const item = stock.find(s => s.skuId === audit.skuId && s.location === audit.location);
        if (item) {
          map.set(`${audit.skuId}_${audit.location}`, { stockItem: item, auditRecord: audit });
        }
      }
    });
    return Array.from(map.values());
  }, [stock, audits]);

  // ---------------------------------------------------------------------------
  // DATA COMPUTATIONS FOR RECHARTS GRAPHIC DASHBOARD
  // ---------------------------------------------------------------------------
  const zoneChartData = useMemo(() => {
    const zonesMap = new Map<string, {
      zone: string;
      total: number;
      audited: number;
      match: number;
      plus: number;
      minus: number;
      pending: number;
      systemQty: number;
      physicalQty: number;
      accuracyPercent: number;
    }>();

    const orderKeys = ['Rak E', 'Rak F', 'Rak D', 'Rak C', 'Rak B', 'Display', 'Zone 1 & Urban', 'Gudang Utama'];
    orderKeys.forEach(k => {
      zonesMap.set(k, { zone: k, total: 0, audited: 0, match: 0, plus: 0, minus: 0, pending: 0, systemQty: 0, physicalQty: 0, accuracyPercent: 100 });
    });

    stock.forEach(item => {
      const zKey = getZoneGroupForLocation(item.location);
      let curr = zonesMap.get(zKey);
      if (!curr) {
        curr = { zone: zKey, total: 0, audited: 0, match: 0, plus: 0, minus: 0, pending: 0, systemQty: 0, physicalQty: 0, accuracyPercent: 100 };
        zonesMap.set(zKey, curr);
      }
      curr.total += 1;
      curr.systemQty += item.qty;

      const audit = audits.find(a => a.skuId.toLowerCase() === item.skuId.toLowerCase() && a.location.toLowerCase() === item.location.toLowerCase());
      const isAuto = isZoneOrUrbanLocation(item.location);

      if (audit) {
        curr.audited += 1;
        curr.physicalQty += audit.physicalQty;
        if (audit.status === 'MATCH' || audit.difference === 0) curr.match += 1;
        else if (audit.status === 'PLUS' || audit.difference > 0) curr.plus += 1;
        else if (audit.status === 'MINUS' || audit.difference < 0) curr.minus += 1;
      } else if (isAuto) {
        curr.audited += 1;
        curr.match += 1;
        curr.physicalQty += item.qty;
      } else {
        curr.pending += 1;
        curr.physicalQty += item.qty;
      }
    });

    zonesMap.forEach(v => {
      v.accuracyPercent = v.audited > 0 ? parseFloat(((v.match / v.audited) * 100).toFixed(1)) : 100;
    });

    return Array.from(zonesMap.values()).filter(z => z.total > 0);
  }, [stock, audits]);

  const statusPieData = useMemo(() => {
    if (matchBasis === 'TOTAL_SKU') {
      return [
        { name: 'Sesuai (MATCH)', value: stockCounts.matchUniqueSkus, color: '#10B981' },
        { name: 'Surplus (+)', value: stockCounts.plusUniqueSkus, color: '#06B6D4' },
        { name: 'Defisit (-)', value: stockCounts.minusUniqueSkus, color: '#F43F5E' },
        { name: 'Belum Audit (PENDING)', value: stockCounts.pendingUniqueSkus, color: '#64748B' }
      ].filter(d => d.value > 0);
    }

    const activeStock = stock.filter(item => {
      const totalSkuQty = item.totalQtySku || getSkuTotalQty(item.skuId);
      return totalSkuQty > 0;
    });

    let matchCount = 0;
    let plusCount = 0;
    let minusCount = 0;
    let pendingCount = 0;

    activeStock.forEach(item => {
      const audit = audits.find(a => a.skuId.toLowerCase() === item.skuId.toLowerCase() && a.location.toLowerCase() === item.location.toLowerCase());
      const isAuto = isZoneOrUrbanLocation(item.location);

      if (audit) {
        if (audit.status === 'MATCH' || audit.difference === 0) matchCount++;
        else if (audit.status === 'PLUS' || audit.difference > 0) plusCount++;
        else if (audit.status === 'MINUS' || audit.difference < 0) minusCount++;
      } else if (isAuto) {
        matchCount++;
      } else {
        pendingCount++;
      }
    });

    return [
      { name: 'Sesuai (MATCH)', value: matchCount, color: '#10B981' },
      { name: 'Surplus (+)', value: plusCount, color: '#06B6D4' },
      { name: 'Defisit (-)', value: minusCount, color: '#F43F5E' },
      { name: 'Belum Audit (PENDING)', value: pendingCount, color: '#64748B' }
    ].filter(d => d.value > 0);
  }, [stock, audits, matchBasis, stockCounts]);

  const topSkuComparisonData = useMemo(() => {
    const items: { name: string; skuId: string; systemQty: number; physicalQty: number; variance: number }[] = [];
    stockCounts.skuAuditSummaryMap.forEach((summary, skuId) => {
      const varQty = summary.totalPhysicalQty - summary.totalSystemQty;
      items.push({
        name: summary.skuName.length > 22 ? summary.skuName.substring(0, 22) + '...' : summary.skuName,
        skuId,
        systemQty: summary.totalSystemQty,
        physicalQty: summary.totalPhysicalQty,
        variance: varQty
      });
    });
    return items.sort((a, b) => b.systemQty - a.systemQty).slice(0, 8);
  }, [stockCounts]);

  // Filter stock list
  const filteredStock = useMemo(() => {
    // Exclude stock items where total SKU system quantity is 0
    let list = stock.filter(item => {
      const totalSkuQty = item.totalQtySku || getSkuTotalQty(item.skuId);
      return totalSkuQty > 0;
    });

    if (stockFilterTab === 'NEED_AUDIT') {
      list = list.filter(item => !isZoneOrUrbanLocation(item.location));
    } else if (stockFilterTab === 'AUTO_ZONE_URBAN') {
      list = list.filter(item => isZoneOrUrbanLocation(item.location));
    } else if (stockFilterTab === 'AUDITED') {
      list = list.filter(item => 
        audits.some(a => a.skuId === item.skuId && a.location === item.location)
      );
    } else if (stockFilterTab === 'DISCREPANCY') {
      list = list.filter(item => {
        const a = audits.find(audit => audit.skuId === item.skuId && audit.location === item.location);
        return a && a.difference !== 0;
      });
    }

    // Hide Audited / Set Match items if hideAudited is true (unless explicitly viewing AUDITED tab)
    if (hideAudited && stockFilterTab !== 'AUDITED') {
      list = list.filter(item => 
        !audits.some(a => a.skuId === item.skuId && a.location === item.location)
      );
    }

    const q = searchQuery.toLowerCase().trim();
    if (q) {
      list = list.filter(item => {
        const itemBarcode = (getBarcodeForSku(item.skuId) || '').toLowerCase();
        return (
          item.skuId.toLowerCase().includes(q) ||
          item.skuName.toLowerCase().includes(q) ||
          item.location.toLowerCase().includes(q) ||
          itemBarcode.includes(q)
        );
      });
    }

    // Always sort list by warehouse location route:
    // E1->E11 ➔ F11->F1 ➔ D11->D6 ➔ Rack C ➔ Rack B ➔ Rack Display ➔ Zone 1 & Urban
    return [...list].sort((a, b) => compareWarehouseLocations(a.location, b.location));
  }, [stock, stockFilterTab, audits, searchQuery, hideAudited]);

  // Reset page to 1 whenever filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, stockFilterTab, hideAudited]);

  const totalFilteredRows = filteredStock.length;
  const isAllPages = pageSize <= 0;
  const totalPages = isAllPages ? 1 : Math.max(1, Math.ceil(totalFilteredRows / pageSize));
  const validCurrentPage = Math.min(currentPage, totalPages);

  const paginatedStock = useMemo(() => {
    if (isAllPages) return filteredStock;
    const startIndex = (validCurrentPage - 1) * pageSize;
    return filteredStock.slice(startIndex, startIndex + pageSize);
  }, [filteredStock, validCurrentPage, pageSize, isAllPages]);

  const startRowIndex = totalFilteredRows === 0 ? 0 : (isAllPages ? 1 : (validCurrentPage - 1) * pageSize + 1);
  const endRowIndex = isAllPages ? totalFilteredRows : Math.min(validCurrentPage * pageSize, totalFilteredRows);

  // Filter history logs
  const filteredAudits = useMemo(() => {
    const q = historySearchQuery.toLowerCase().trim();
    if (!q) return audits;
    return audits.filter(
      a =>
        a.skuId.toLowerCase().includes(q) ||
        a.skuName.toLowerCase().includes(q) ||
        a.location.toLowerCase().includes(q) ||
        a.operator.toLowerCase().includes(q)
    );
  }, [audits, historySearchQuery]);

  return (
    <div className="space-y-6" id="stock-opname-container">
      
      {mode === 'dcc' && (
        <>
          {/* PROFESSIONAL WMS HEADER SECTION */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-md text-[10px] font-extrabold uppercase tracking-wider font-mono">
              WMS Physical Inventory
            </span>
            <span className="text-slate-500 text-xs font-mono">• Cycle Counting Console</span>
          </div>
          <h2 className="text-2xl font-black text-white tracking-tight flex items-center gap-2.5 mt-1">
            <ClipboardCheck className="w-6 h-6 text-emerald-400 shrink-0" />
            Stock Opname & Audit Rak
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Konsol opname fisik gudang enterprise: verifikasi saldo rak, audit barcode, rekonsiliasi selisih, dan sinkronisasi WMS.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 bg-[#11141B] border border-slate-800 px-3.5 py-2 rounded-xl">
            <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></div>
            <div>
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">
                Auditor In-Charge
              </div>
              <div className="text-xs font-extrabold text-white">
                {currentUser?.fullName || 'WMS User'} <span className="text-slate-500 text-[10px] font-normal">({currentUser?.role || 'Auditor'})</span>
              </div>
            </div>
          </div>

          <button
            onClick={exportProfessionalStockOpnameReport}
            className="px-3.5 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 font-bold text-xs rounded-xl border border-indigo-500/20 transition-all cursor-pointer flex items-center gap-2 shadow-sm"
            title="Ekspor Laporan Dashboard Executive Stock Opname (.xlsx)"
            id="export-executive-report-header-btn"
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span className="hidden sm:inline">Laporan Excel</span>
          </button>

          <button
            onClick={() => setIsScanModalOpen(true)}
            className="px-3.5 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-bold text-xs rounded-xl border border-emerald-500/20 transition-all cursor-pointer flex items-center gap-2"
            title="Scan Barcode / Lokasi Rak"
          >
            <Barcode className="w-4 h-4" />
            <span className="hidden sm:inline">Scan Barcode</span>
          </button>

          <button
            onClick={handleResetOpname}
            className="px-3.5 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 font-bold text-xs rounded-xl border border-rose-500/20 transition-all cursor-pointer flex items-center gap-2 shadow-sm"
            title="Reset & Mulai Ulang Process Stok Opname"
            id="reset-opname-header-btn"
          >
            <RotateCcw className="w-4 h-4" />
            <span className="hidden sm:inline">Reset Opname</span>
          </button>
        </div>
      </div>

      {/* ENTERPRISE KPI DASHBOARD CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3.5">
        
        {/* KPI 1: Inventory Accuracy Rate % (Lokasi Rak) */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg relative overflow-hidden flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Akurasi Lokasi Rak
              </span>
              <div className="text-2xl font-black text-white font-mono mt-1 flex items-baseline gap-1.5">
                {stockCounts.accuracyRate}%
                <span className="text-[10px] font-bold text-emerald-400 font-sans">Accuracy</span>
              </div>
            </div>
            <div className="p-2.5 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
              <ShieldCheck className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-emerald-400 h-1.5 rounded-full transition-all duration-500" 
                style={{ width: `${Math.min(100, Math.max(0, parseFloat(stockCounts.accuracyRate)))}%` }}
              ></div>
            </div>
            <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1 font-medium">
              <span>Target Standard WMS: &ge;98%</span>
              <span className="text-emerald-400 font-bold">
                {parseFloat(stockCounts.accuracyRate) >= 98 ? '✓ Sesuai SOP' : '⚠ Perlu Review'}
              </span>
            </div>
          </div>
        </div>

        {/* KPI 2: Akurasi & Progres Total SKU */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg relative overflow-hidden flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Akurasi Total SKU
              </span>
              <div className="text-2xl font-black text-white font-mono mt-1 flex items-baseline gap-1.5">
                {stockCounts.skuAccuracyRate}%
                <span className="text-[10px] font-bold text-emerald-400 font-sans">Akurasi</span>
              </div>
            </div>
            <div className="p-2.5 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
              <TrendingUp className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-emerald-400 h-1.5 rounded-full transition-all duration-500" 
                style={{ width: `${Math.min(100, Math.max(0, parseFloat(stockCounts.skuAccuracyRate)))}%` }}
              ></div>
            </div>
            <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1 font-medium">
              <span>Audit SKU: {stockCounts.auditedUniqueSkus}/{stockCounts.totalUniqueSkus}</span>
              <span className="text-emerald-400 font-bold">
                {stockCounts.skuProgressRate}% Progres
              </span>
            </div>
          </div>
        </div>

        {/* KPI 3: Total Progress Audit Rak */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg relative overflow-hidden flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Progress Verifikasi
              </span>
              <div className="text-2xl font-black text-white font-mono mt-1">
                {stockCounts.audited} <span className="text-sm font-normal text-slate-500">/ {stockCounts.total} Rak</span>
              </div>
            </div>
            <div className="p-2.5 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20">
              <Boxes className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500" 
                style={{ width: `${stockCounts.total > 0 ? (stockCounts.audited / stockCounts.total) * 100 : 0}%` }}
              ></div>
            </div>
            <div className="flex items-center justify-between text-[10px] font-medium text-slate-400 mt-1">
              <span>Cakupan Opname Rak</span>
              <span className="text-indigo-400 font-bold">
                {stockCounts.total > 0 ? ((stockCounts.audited / stockCounts.total) * 100).toFixed(0) : 0}% Selesai
              </span>
            </div>
          </div>
        </div>

        {/* KPI 3: Status Selisih (Discrepancy) */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg relative overflow-hidden flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Status Selisih (Variansi)
              </span>
              <div className="text-2xl font-black text-white font-mono mt-1 flex items-baseline gap-2">
                {stockCounts.discrepancies} <span className="text-xs font-bold text-slate-400">SKU Selisih</span>
              </div>
            </div>
            <div className={`p-2.5 rounded-xl border ${
              stockCounts.discrepancies > 0 
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}>
              <AlertTriangle className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[10px] font-medium border-t border-slate-800/80 pt-1.5">
            <span className="text-emerald-400 font-mono">Surplus: +{formatNumber(stockCounts.totalPlusQty)}</span>
            <span className="text-rose-400 font-mono">Defisit: -{formatNumber(stockCounts.totalMinusQty)}</span>
          </div>
        </div>

        {/* KPI 4: Zone 1 & Urban Auto Rule */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg relative overflow-hidden flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Rule Zone 1 & Urban
              </span>
              <div className="text-2xl font-black text-emerald-400 font-mono mt-1">
                {stockCounts.autoZoneUrban} <span className="text-xs font-bold text-slate-400">Rak Auto</span>
              </div>
            </div>
            <button
              onClick={handle1ClickAutoVerifyZoneUrban}
              className="p-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-xl border border-emerald-500/20 transition-all cursor-pointer"
              title="Satu klik Auto Verify Zone 1/Urban"
            >
              <Sparkles className="w-5 h-5" />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between text-[10px] text-slate-400 font-medium">
            <span>Aturan Fast-Moving Active</span>
            <button 
              onClick={() => setIsRulesModalOpen(true)}
              className="text-emerald-400 font-bold hover:underline cursor-pointer"
            >
              Cek Rules &rsaquo;
            </button>
          </div>
        </div>

      </div>
        </>
      )}

      {/* STRATEGIC OPERATIONAL SUB-TABS */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        {mode === 'dcc' && (
          <>
            <button
              onClick={() => setActiveMainTab('CONSOLE')}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
                activeMainTab === 'CONSOLE'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-lg shadow-emerald-500/10 font-extrabold'
                  : 'bg-[#11141B] text-slate-400 hover:text-white border-slate-800 hover:bg-slate-800/60'
              }`}
            >
              <ClipboardCheck className="w-4 h-4" />
              <span>Konsol Opname Rak</span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono ${
                activeMainTab === 'CONSOLE' ? 'bg-slate-950/20 text-slate-950 font-black' : 'bg-slate-800 text-slate-300'
              }`}>
                {stockCounts.total}
              </span>
            </button>
            <button
              onClick={() => setActiveMainTab('CHARTS')}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
                activeMainTab === 'CHARTS'
                  ? 'bg-indigo-500 text-white border-indigo-400 shadow-lg shadow-indigo-500/20 font-extrabold'
                  : 'bg-[#11141B] text-slate-400 hover:text-white border-slate-800 hover:bg-slate-800/60'
              }`}
              id="opname-charts-tab-btn"
            >
              <BarChart3 className="w-4 h-4 text-indigo-300" />
              <span>Dashboard & Grafik Analitis</span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono ${
                activeMainTab === 'CHARTS' ? 'bg-indigo-950/60 text-indigo-200 font-bold' : 'bg-slate-800 text-slate-300'
              }`}>
                Live
              </span>
            </button>
            <button
              onClick={() => setActiveMainTab('RECONCILIATION')}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
                activeMainTab === 'RECONCILIATION'
                  ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-lg shadow-amber-500/10 font-extrabold'
                  : 'bg-[#11141B] text-slate-400 hover:text-white border-slate-800 hover:bg-slate-800/60'
              }`}
            >
              <AlertTriangle className="w-4 h-4" />
              <span>Rekonsiliasi Selisih</span>
              {stockCounts.discrepancies > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-rose-500 text-white font-black animate-pulse">
                  {stockCounts.discrepancies}
                </span>
              )}
            </button>
          </>
        )}

        {(mode === 'daily-cycle-count' || mode === 'dcc') && (
          <>
            <button
              onClick={() => setActiveMainTab('CYCLE_COUNT')}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
                activeMainTab === 'CYCLE_COUNT'
                  ? 'bg-purple-600 text-white border-purple-500 shadow-lg shadow-purple-600/10 font-extrabold'
                  : 'bg-[#11141B] text-slate-400 hover:text-white border-slate-800 hover:bg-slate-800/60'
              }`}
              id="daily-cycle-count-tab-btn"
            >
              <Calendar className="w-4 h-4 text-purple-300" />
              <span>Input Daily Cycle Count</span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono ${
                activeMainTab === 'CYCLE_COUNT' ? 'bg-purple-950/40 text-white font-bold' : 'bg-slate-800 text-slate-300'
              }`}>
                {cycleCountBatch.length} SKU
              </span>
            </button>

            <button
              onClick={() => setActiveMainTab('SCHEDULE')}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
                activeMainTab === 'SCHEDULE'
                  ? 'bg-amber-600 text-white border-amber-500 shadow-lg shadow-amber-600/10 font-extrabold'
                  : 'bg-[#11141B] text-slate-400 hover:text-white border-slate-800 hover:bg-slate-800/60'
              }`}
              id="dcc-schedule-tab-btn"
            >
              <Clock className="w-4 h-4 text-amber-300" />
              <span>Jadwal DCC Harian</span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono ${
                activeMainTab === 'SCHEDULE' ? 'bg-amber-950/40 text-white font-bold' : 'bg-slate-800 text-slate-300'
              }`}>
                {scheduleCountsByDay[todayDayName]?.activeWithStock || 0} SKU {todayDayName}
              </span>
            </button>
          </>
        )}

        {/* Sub-tab: Stock Opname per Lokasi */}
        <button
          onClick={() => setActiveMainTab('OPNAME_LOKASI')}
          className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
            activeMainTab === 'OPNAME_LOKASI'
              ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/20 font-extrabold'
              : 'bg-[#11141B] text-slate-400 hover:text-white border-slate-800 hover:bg-slate-800/60'
          }`}
          id="dcc-opname-lokasi-tab-btn"
          title="Stock Opname per Lokasi (Hasil Excel, Tidak Merubah Stok)"
        >
          <MapPin className="w-4 h-4 text-indigo-300" />
          <span>Opname per Lokasi</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono ${
            activeMainTab === 'OPNAME_LOKASI' ? 'bg-indigo-950/50 text-indigo-200 font-bold' : 'bg-indigo-950/40 text-indigo-400 border border-indigo-500/20'
          }`}>
            Excel Report
          </span>
        </button>

        {mode !== 'daily-cycle-count' && (
          <button
            onClick={() => setActiveMainTab('HISTORY')}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
              activeMainTab === 'HISTORY'
                ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-600/10 font-extrabold'
                : 'bg-[#11141B] text-slate-400 hover:text-white border-slate-800 hover:bg-slate-800/60'
            }`}
          >
            <History className="w-4 h-4" />
            <span>Audit Trail & History</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono ${
              activeMainTab === 'HISTORY' ? 'bg-blue-950/40 text-white font-bold' : 'bg-slate-800 text-slate-300'
            }`}>
              {audits.length}
            </span>
          </button>
        )}
      </div>

      {/* CONFIRMATION DIALOG BOX */}
      {dialog.isOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#11141B] border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              {dialog.type === 'danger' ? (
                <div className="p-2 bg-rose-500/10 text-rose-400 rounded-lg shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
              ) : dialog.type === 'success' ? (
                <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg shrink-0">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
              ) : (
                <div className="p-2 bg-amber-500/10 text-amber-400 rounded-lg shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
              )}
              <div>
                <h4 className="font-bold text-sm text-white">{dialog.title}</h4>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">{dialog.message}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 justify-end pt-2 border-t border-slate-800/60">
              <button
                onClick={() => setDialog(prev => ({ ...prev, isOpen: false }))}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition-all cursor-pointer"
                id="dialog-cancel-btn"
              >
                {dialog.type === 'success' || dialog.type === 'info' ? 'Tutup' : 'Batal'}
              </button>
              {dialog.onConfirm && (
                <button
                  onClick={dialog.onConfirm}
                  className={`px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                    dialog.type === 'danger' 
                      ? 'bg-rose-500 hover:bg-rose-400 text-white' 
                      : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                  }`}
                  id="dialog-confirm-btn"
                >
                  Ya, Konfirmasi
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* RULES & POLICY MODAL */}
      {isRulesModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#11141B] border border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <h3 className="font-extrabold text-base text-white">SOP & Panduan Stok Opname WMS</h3>
              </div>
              <button
                onClick={() => setIsRulesModalOpen(false)}
                className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs text-slate-300 leading-relaxed">
              <div className="bg-[#161B25] p-4 rounded-xl border border-slate-800 space-y-2">
                <h4 className="font-bold text-emerald-400 flex items-center gap-1.5 text-xs">
                  <CheckSquare className="w-4 h-4" />
                  1. Aturan Auto-Count Zone 1 & Urban Storage Area
                </h4>
                <p className="text-slate-400">
                  Untuk meningkatkan efisiensi operasional gudang, seluruh barang yang berlokasi di area <span className="text-white font-bold">ZONE 1</span> dan <span className="text-white font-bold">URBAN</span> secara otomatis dianggap <span className="text-emerald-400 font-bold">MATCH (Sesuai Sistem)</span>. Dalam template Excel yang diunduh, jumlah stok fisik untuk lokasi ini otomatis terisi sama dengan stok sistem.
                </p>
              </div>

              <div className="bg-[#161B25] p-4 rounded-xl border border-slate-800 space-y-2">
                <h4 className="font-bold text-indigo-400 flex items-center gap-1.5 text-xs">
                  <FileText className="w-4 h-4" />
                  2. Alur Pelaksanaan Opname Offline via Excel
                </h4>
                <ol className="list-decimal list-inside space-y-1 text-slate-400">
                  <li>Klik tombol <span className="text-white font-semibold">Download Template Excel</span>. File berisi 3 sheet (Summary Dashboard, Template Opname, dan SOP Rules).</li>
                  <li>Buka sheet <span className="text-white font-semibold">TEMPLATE_STOK_OPNAME</span>. Lakukan pemeriksaan pada rak reguler dan perbarui kolom <span className="text-white font-semibold">Stok Fisik (Opname)</span> jika ada selisih.</li>
                  <li>Simpan file Excel, lalu unggah melalui tombol <span className="text-white font-semibold">Upload Hasil Excel</span>.</li>
                  <li>Sistem WMS akan otomatis mengkalkulasi selisih, memperbarui saldo rak, dan merekam audit log.</li>
                </ol>
              </div>

              <div className="bg-[#161B25] p-4 rounded-xl border border-slate-800 space-y-2">
                <h4 className="font-bold text-amber-400 flex items-center gap-1.5 text-xs">
                  <AlertTriangle className="w-4 h-4" />
                  3. Toleransi Selisih & Rekonsiliasi
                </h4>
                <p className="text-slate-400">
                  Selisih &gt; 5 Pcs wajib disertai alasan pada kolom <span className="text-white font-semibold">Catatan Opname</span> dan membutuhkan konfirmasi ulang Supervisor. Setiap transaksi penyesuaian tersimpan di <span className="text-white font-semibold">Riwayat Cek Fisik</span>.
                </p>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-800">
              <button
                onClick={() => setIsRulesModalOpen(false)}
                className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition-all cursor-pointer"
              >
                Saya Mengerti
              </button>
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD RESULT SUMMARY MODAL */}
      {uploadResult && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#11141B] border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-emerald-400 border-b border-slate-800 pb-3">
              <CheckCircle2 className="w-6 h-6" />
              <div>
                <h3 className="font-extrabold text-base text-white">Import Opname Excel Berhasil!</h3>
                <p className="text-xs text-slate-400">Data stok sistem dan audit log berhasil diperbarui.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-[#161B25] p-3 rounded-xl border border-slate-800">
                <div className="text-slate-400 text-[10px]">Total Item Diproses</div>
                <div className="text-lg font-extrabold text-white font-mono">{uploadResult.total}</div>
              </div>
              <div className="bg-[#161B25] p-3 rounded-xl border border-slate-800">
                <div className="text-slate-400 text-[10px]">Sesuai (Match)</div>
                <div className="text-lg font-extrabold text-emerald-400 font-mono">{uploadResult.matched}</div>
              </div>
              <div className="bg-[#161B25] p-3 rounded-xl border border-slate-800">
                <div className="text-slate-400 text-[10px]">Surplus (Plus +)</div>
                <div className="text-lg font-extrabold text-amber-400 font-mono">+{uploadResult.plus}</div>
              </div>
              <div className="bg-[#161B25] p-3 rounded-xl border border-slate-800">
                <div className="text-slate-400 text-[10px]">Defisit (Minus -)</div>
                <div className="text-lg font-extrabold text-rose-400 font-mono">{uploadResult.minus}</div>
              </div>
            </div>

            <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] p-3 rounded-xl flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>{uploadResult.autoZoneUrban} item di lokasi Zone 1/Urban otomatis diproses match.</span>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setUploadResult(null)}
                className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition-all cursor-pointer"
              >
                Selesai & Lihat Stok
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MAIN TAB 1: KONSOL OPNAME RAK (COUNT ENTRY) */}
      {/* ========================================================================= */}
      {activeMainTab === 'CONSOLE' && (
        <div>
          {!selectedItem ? (
            /* STAGE 1: SEARCH & FILTER STOCK ITEM LIST TO AUDIT */
            <div className="space-y-4">
              <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4">
                
                {/* Filter Tabs, View Switcher & Search Header */}
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
                  
                  {/* Filter Chips */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => setStockFilterTab('ALL')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                        stockFilterTab === 'ALL'
                          ? 'bg-emerald-500 text-slate-950'
                          : 'bg-slate-800/80 text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      <span>Semua Stok</span>
                      <span className={`px-1.5 py-0.2 rounded-md text-[10px] font-mono ${
                        stockFilterTab === 'ALL' ? 'bg-slate-950/20 text-slate-950 font-extrabold' : 'bg-slate-900 text-slate-400'
                      }`}>
                        {stockCounts.total}
                      </span>
                    </button>

                    <button
                      onClick={() => setStockFilterTab('NEED_AUDIT')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                        stockFilterTab === 'NEED_AUDIT'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-800/80 text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      <span>Audit Manual (Rak Reguler)</span>
                      <span className={`px-1.5 py-0.2 rounded-md text-[10px] font-mono ${
                        stockFilterTab === 'NEED_AUDIT' ? 'bg-indigo-950/40 text-white' : 'bg-slate-900 text-slate-400'
                      }`}>
                        {stockCounts.needAudit}
                      </span>
                    </button>

                    <button
                      onClick={() => setStockFilterTab('AUTO_ZONE_URBAN')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                        stockFilterTab === 'AUTO_ZONE_URBAN'
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-slate-800/80 text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>Zone 1 & Urban Auto</span>
                      <span className={`px-1.5 py-0.2 rounded-md text-[10px] font-mono ${
                        stockFilterTab === 'AUTO_ZONE_URBAN' ? 'bg-slate-950/20 text-slate-950 font-extrabold' : 'bg-slate-900 text-slate-400'
                      }`}>
                        {stockCounts.autoZoneUrban}
                      </span>
                    </button>

                    <button
                      onClick={() => setStockFilterTab('AUDITED')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                        stockFilterTab === 'AUDITED'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800/80 text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      <span>Sudah Diaudit</span>
                      <span className={`px-1.5 py-0.2 rounded-md text-[10px] font-mono ${
                        stockFilterTab === 'AUDITED' ? 'bg-blue-950/40 text-white' : 'bg-slate-900 text-slate-400'
                      }`}>
                        {stockCounts.audited}
                      </span>
                    </button>

                    <button
                      onClick={() => setStockFilterTab('DISCREPANCY')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                        stockFilterTab === 'DISCREPANCY'
                          ? 'bg-rose-600 text-white'
                          : 'bg-slate-800/80 text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-300" />
                      <span>Terdapat Selisih</span>
                      <span className={`px-1.5 py-0.2 rounded-md text-[10px] font-mono ${
                        stockFilterTab === 'DISCREPANCY' ? 'bg-rose-950/40 text-white font-black' : 'bg-slate-900 text-slate-400'
                      }`}>
                        {stockCounts.discrepancies}
                      </span>
                    </button>
                  </div>

                  {/* Right side: Hide Audited Toggle + Match Basis Switcher + Search + View Switcher */}
                  <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
                    {/* Hide Audited / Set Match Items Toggle */}
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-xl hover:bg-emerald-500/20 transition-all select-none shrink-0" title="Item yang sudah di-Set Match / Audit akan otomatis hilang dari daftar pengerjaan">
                      <input
                        type="checkbox"
                        checked={hideAudited}
                        onChange={(e) => setHideAudited(e.target.checked)}
                        className="w-3.5 h-3.5 rounded accent-emerald-500 cursor-pointer"
                        id="hide-audited-checkbox"
                      />
                      <span>Sembunyikan Sudah Match</span>
                    </label>

                    {/* Match Basis Mode Toggle */}
                    <div className="flex items-center gap-1 bg-[#161B25] p-1 border border-slate-800 rounded-xl shrink-0">
                      <span className="text-[10px] font-extrabold text-slate-400 pl-2 pr-1 uppercase tracking-wider font-mono">
                        Basis Match:
                      </span>
                      <button
                        onClick={() => {
                          setMatchBasis('LOCATION');
                          if (selectedItem) {
                            setActualQty(selectedItem.qty);
                            syncCalculatorFromQty(selectedItem.qty, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize);
                          }
                        }}
                        className={`px-2.5 py-1 text-[10px] font-extrabold rounded-lg transition-all cursor-pointer ${
                          matchBasis === 'LOCATION'
                            ? 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                            : 'text-slate-400 hover:text-white'
                        }`}
                        title="Cocokkan dengan Qty Rak/Lokasi spesifik"
                        id="match-basis-location-btn"
                      >
                        Qty Lokasi Rak
                      </button>
                      <button
                        onClick={() => {
                          setMatchBasis('TOTAL_SKU');
                          if (selectedItem) {
                            const totalSkuQty = selectedItem.totalQtySku || getSkuTotalQty(selectedItem.skuId);
                            setActualQty(totalSkuQty);
                            syncCalculatorFromQty(totalSkuQty, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize);
                          }
                        }}
                        className={`px-2.5 py-1 text-[10px] font-extrabold rounded-lg transition-all cursor-pointer ${
                          matchBasis === 'TOTAL_SKU'
                            ? 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                            : 'text-slate-400 hover:text-white'
                        }`}
                        title="Cocokkan dengan Total Qty SKU di seluruh lokasi gudang"
                        id="match-basis-total-sku-btn"
                      >
                        Total Qty SKU
                      </button>
                    </div>

                    {/* View Switcher */}
                    <div className="flex items-center p-1 bg-[#161B25] border border-slate-800 rounded-xl shrink-0">
                      <button
                        onClick={() => setViewMode('TABLE')}
                        className={`p-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                          viewMode === 'TABLE' ? 'bg-emerald-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
                        }`}
                        title="Tampilan Tabel WMS Dense"
                      >
                        <List className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setViewMode('CARDS')}
                        className={`p-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                          viewMode === 'CARDS' ? 'bg-emerald-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
                        }`}
                        title="Tampilan Kartu Grid"
                      >
                        <Grid className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Search Input Bar */}
                    <div className="relative w-full lg:w-64 flex items-center">
                      <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
                      <input
                        type="text"
                        placeholder="Cari SKU, nama barang, rak..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-10 py-2 bg-[#161B25] border border-slate-800 text-xs text-slate-200 rounded-xl focus:ring-1 focus:ring-emerald-500 outline-none"
                        id="stock-search-input"
                      />
                      <button
                        type="button"
                        onClick={() => setIsScanModalOpen(true)}
                        className="absolute right-2.5 p-1 text-slate-400 hover:text-emerald-400 hover:bg-slate-800 rounded-lg transition-all cursor-pointer"
                        title="Scan Barcode"
                      >
                        <Barcode className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                </div>

                {/* VIEW MODE 1: DENSE TABLE VIEW */}
                {viewMode === 'TABLE' ? (
                  <div className="overflow-x-auto rounded-xl border border-slate-800/80">
                    <table className="w-full text-left text-xs text-slate-300">
                      <thead className="bg-[#161B25] text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                        <tr>
                          <th className="py-3 px-4">Barang (SKU / Nama Produk)</th>
                          <th className="py-3 px-4">Lokasi Rak</th>
                          <th className="py-3 px-4">Rule / Kategori WMS</th>
                          <th className="py-3 px-4 text-right">Stok Buku Sistem</th>
                          <th className="py-3 px-4 text-center">Status Audit</th>
                          <th className="py-3 px-4 text-center w-28">Aksi</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/50">
                        {paginatedStock.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-8 text-center text-slate-500">
                              Tidak ada barang yang cocok dengan kriteria pencarian / filter.
                            </td>
                          </tr>
                        ) : (
                          paginatedStock.map(item => {
                            const isAuto = isZoneOrUrbanLocation(item.location);
                            const audit = audits.find(a => a.skuId === item.skuId && a.location === item.location);
                            
                            return (
                              <tr key={item.id} className="hover:bg-slate-800/20 transition-all">
                                <td className="py-3.5 px-4">
                                  <div className="font-black text-white font-mono">{item.skuId}</div>
                                  <div className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">{item.skuName}</div>
                                </td>
                                <td className="py-3.5 px-4 whitespace-nowrap">
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-800 text-slate-200 font-extrabold rounded-lg text-[10px] border border-slate-700/60 font-mono">
                                    <MapPin className="w-3 h-3 text-emerald-400" />
                                    {item.location}
                                  </span>
                                </td>
                                <td className="py-3.5 px-4 whitespace-nowrap">
                                  {isAuto ? (
                                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-500/10 text-emerald-400 font-bold rounded-lg text-[10px] border border-emerald-500/25">
                                      <ShieldCheck className="w-3.5 h-3.5" />
                                      AUTO ZONE 1 / URBAN
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-indigo-500/10 text-indigo-400 font-bold rounded-lg text-[10px] border border-indigo-500/25">
                                      REGULAR RACK
                                    </span>
                                  )}
                                </td>
                                <td className="py-3.5 px-4 text-right font-mono font-black text-white whitespace-nowrap">
                                  {formatNumber(item.qty)} <span className="text-slate-500 text-[10px]">pcs</span>
                                </td>
                                <td className="py-3.5 px-4 text-center whitespace-nowrap">
                                  {audit ? (
                                    audit.status === 'MATCH' ? (
                                      <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold rounded-full inline-flex items-center gap-1">
                                        <CheckCircle2 className="w-3 h-3" /> MATCH ({audit.physicalQty} pcs)
                                      </span>
                                    ) : audit.status === 'PLUS' ? (
                                      <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[10px] font-bold rounded-full inline-flex items-center gap-1">
                                        <AlertTriangle className="w-3 h-3" /> SURPLUS (+{audit.difference})
                                      </span>
                                    ) : (
                                      <span className="px-2 py-0.5 bg-rose-500/10 border border-rose-500/30 text-rose-400 text-[10px] font-bold rounded-full inline-flex items-center gap-1">
                                        <AlertTriangle className="w-3 h-3" /> DEFISIT ({audit.difference})
                                      </span>
                                    )
                                  ) : (
                                    <span className="px-2 py-0.5 bg-slate-800 text-slate-400 text-[10px] font-semibold rounded-full">
                                      Belum Di-Opname
                                    </span>
                                  )}
                                </td>
                                <td className="py-3.5 px-4 text-center whitespace-nowrap">
                                  <div className="flex items-center justify-center gap-1.5">
                                    <button
                                      onClick={() => handleQuickSetMatch(item)}
                                      className="px-2.5 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-extrabold rounded-lg text-[10px] transition-all cursor-pointer flex items-center gap-1 shrink-0 active:scale-95"
                                      title="Set Qty fisik sesuai sistem (MATCH)"
                                      id={`quick-match-btn-${item.id}`}
                                    >
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      Set Match
                                    </button>
                                    <button
                                      onClick={() => handleSelectItem(item)}
                                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700/80 font-bold rounded-lg text-[10px] transition-all cursor-pointer flex items-center gap-1 shrink-0 active:scale-95"
                                      id={`select-btn-${item.id}`}
                                    >
                                      <Calculator className="w-3.5 h-3.5 text-slate-400" />
                                      Input
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  /* VIEW MODE 2: CARDS GRID VIEW */
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {paginatedStock.length === 0 ? (
                      <div className="col-span-full py-8 text-center text-slate-500 text-xs bg-[#161B25] rounded-xl border border-slate-800">
                        Tidak ada barang yang cocok dengan kriteria pencarian / filter.
                      </div>
                    ) : (
                      paginatedStock.map(item => {
                        const isAuto = isZoneOrUrbanLocation(item.location);
                        const audit = audits.find(a => a.skuId === item.skuId && a.location === item.location);

                        return (
                          <div key={item.id} className="bg-[#161B25] border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3 hover:border-slate-700 transition-all">
                            <div className="space-y-2">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <div className="text-xs font-mono font-black text-white">{item.skuId}</div>
                                  <div className="text-[11px] text-slate-400 font-medium line-clamp-2 mt-0.5">{item.skuName}</div>
                                </div>
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-800 text-slate-200 font-bold rounded-md text-[10px] border border-slate-700 shrink-0 font-mono">
                                  <MapPin className="w-2.5 h-2.5 text-emerald-400" />
                                  {item.location}
                                </span>
                              </div>

                              <div className="flex items-center justify-between text-xs border-t border-slate-800/80 pt-2 font-mono">
                                <span className="text-slate-400">Stok Sistem: <strong className="text-white">{formatNumber(item.qty)} pcs</strong></span>
                                {isAuto ? (
                                  <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 font-bold rounded text-[9px] border border-emerald-500/20 flex items-center gap-1">
                                    <ShieldCheck className="w-3 h-3" /> Auto
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 font-bold rounded text-[9px] border border-indigo-500/20">
                                    Regular
                                  </span>
                                )}
                              </div>

                              {audit && (
                                <div className="text-[11px] font-bold">
                                  {audit.status === 'MATCH' ? (
                                    <span className="text-emerald-400">✓ Audited: MATCH ({audit.physicalQty} pcs)</span>
                                  ) : audit.status === 'PLUS' ? (
                                    <span className="text-amber-400">▲ Audited: SURPLUS (+{audit.difference} pcs)</span>
                                  ) : (
                                    <span className="text-rose-400">▼ Audited: DEFISIT ({audit.difference} pcs)</span>
                                  )}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2 pt-1">
                              <button
                                onClick={() => handleQuickSetMatch(item)}
                                className="w-1/2 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-extrabold rounded-xl text-xs transition-all cursor-pointer flex items-center justify-center gap-1 shadow-md active:scale-95"
                                id={`quick-match-card-btn-${item.id}`}
                                title="Set Match (Sesuai Sistem)"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Set Match
                              </button>
                              <button
                                onClick={() => handleSelectItem(item)}
                                className="w-1/2 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold rounded-xl text-xs transition-all cursor-pointer flex items-center justify-center gap-1.5 shadow-md active:scale-95"
                                id={`select-card-btn-${item.id}`}
                              >
                                <Calculator className="w-3.5 h-3.5" />
                                Input Opname
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {/* PAGINATION FOOTER CONTROLS */}
                <div className="bg-[#161B25] px-4 py-3 border border-slate-800 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 font-medium">Tampilkan:</span>
                      <select
                        value={pageSize}
                        onChange={(e) => {
                          setPageSize(Number(e.target.value));
                          setCurrentPage(1);
                        }}
                        className="bg-[#11141B] border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-emerald-400 font-bold focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer"
                        id="page-size-selector"
                      >
                        <option value={10}>10 SKU (Default)</option>
                        <option value={25}>25 SKU</option>
                        <option value={50}>50 SKU</option>
                        <option value={100}>100 SKU</option>
                        <option value={-1}>Semua Data ({totalFilteredRows})</option>
                      </select>
                    </div>
                    <span className="text-slate-700 hidden sm:inline">|</span>
                    <span className="text-slate-400">
                      Menampilkan <strong className="text-white">{startRowIndex} - {endRowIndex}</strong> dari <strong className="text-emerald-400">{totalFilteredRows}</strong> SKU {hideAudited && stockFilterTab !== 'AUDITED' ? '(Sudah Set Match Disembunyikan)' : ''}
                    </span>
                  </div>

                  {/* Page Navigation Buttons */}
                  {!isAllPages && totalPages > 1 && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setCurrentPage(1)}
                        disabled={validCurrentPage === 1}
                        className="p-1.5 rounded-lg border border-slate-800 bg-[#11141B] text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                        title="Halaman Pertama"
                        id="first-page-btn"
                      >
                        <ChevronsLeft className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                        disabled={validCurrentPage === 1}
                        className="p-1.5 rounded-lg border border-slate-800 bg-[#11141B] text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                        title="Halaman Sebelumnya"
                        id="prev-page-btn"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>

                      <div className="px-3 py-1 font-mono font-bold text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                        Halaman {validCurrentPage} / {totalPages}
                      </div>

                      <button
                        onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                        disabled={validCurrentPage === totalPages}
                        className="p-1.5 rounded-lg border border-slate-800 bg-[#11141B] text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                        title="Halaman Selanjutnya"
                        id="next-page-btn"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setCurrentPage(totalPages)}
                        disabled={validCurrentPage === totalPages}
                        className="p-1.5 rounded-lg border border-slate-800 bg-[#11141B] text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
                        title="Halaman Terakhir"
                        id="last-page-btn"
                      >
                        <ChevronsRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

              </div>
            </div>
          ) : (
            /* STAGE 2: SINGLE ITEM AUDIT FORM (INTERACTIVE PACKAGING CALCULATOR & VARIANCE GAUGE) */
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              
              {/* Left Column: Central Audit Entry Form */}
              <div className="lg:col-span-7 space-y-5">
                
                {/* GENERAL PRODUCT CARD */}
                <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4 relative overflow-hidden">
                  <div className="flex items-center justify-between">
                    <span className="px-2.5 py-0.5 bg-slate-800 text-slate-300 text-[10px] font-extrabold rounded uppercase tracking-wider font-mono border border-slate-700">
                      Target Item Rak
                    </span>
                    <span className="text-xs text-emerald-400 font-mono font-bold">
                      SKU: {selectedItem.skuId}
                    </span>
                  </div>
                  
                  <div>
                    <h3 className="text-lg font-black text-white tracking-tight leading-tight">
                      {selectedItem.skuName}
                    </h3>
                  </div>

                  <div className="flex flex-wrap gap-4 pt-1">
                    <div className="flex items-center gap-1.5 text-xs text-slate-400">
                      <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="font-extrabold text-white font-mono">{selectedItem.location}</span>
                    </div>
                    
                    <div className={`flex items-center gap-1.5 text-xs border-l border-slate-800 pl-4 ${matchBasis === 'LOCATION' ? 'text-emerald-400 font-bold' : 'text-slate-400'}`}>
                      <Database className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      <span>Stok Rak:</span>
                      <span className="font-extrabold text-white font-mono">{formatNumber(selectedItem.qty)} pcs</span>
                    </div>

                    <div className={`flex items-center gap-1.5 text-xs border-l border-slate-800 pl-4 ${matchBasis === 'TOTAL_SKU' ? 'text-emerald-400 font-bold' : 'text-slate-400'}`}>
                      <Boxes className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>Total SKU:</span>
                      <span className="font-extrabold text-white font-mono">{formatNumber(selectedItem.totalQtySku || getSkuTotalQty(selectedItem.skuId))} pcs</span>
                    </div>

                    <div className="flex items-center gap-1.5 text-xs text-slate-400 border-l border-slate-800 pl-4">
                      <Calendar className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      <span className="text-slate-400">ED:</span>
                      <span className="font-mono text-slate-300 font-bold">{selectedItem.expiredDate}</span>
                    </div>
                  </div>

                  {isZoneOrUrbanLocation(selectedItem.location) && (
                    <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-2.5 rounded-xl text-xs flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 shrink-0" />
                      <span>Lokasi <strong>{selectedItem.location}</strong> terdaftar dalam Aturan Auto-Count Zone 1 & Urban.</span>
                    </div>
                  )}
                </div>

                {/* STOK FISIK (AKTUAL) CARD */}
                <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-xs uppercase font-black text-slate-300 tracking-wider flex items-center gap-1.5">
                      <Calculator className="w-4 h-4 text-emerald-400" />
                      <span>Input Stok Fisik Aktual</span>
                    </h4>
                    
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        onClick={() => handleActualQtyChange(selectedItem.qty, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded-lg border transition-all cursor-pointer flex items-center gap-1 ${
                          matchBasis === 'LOCATION'
                            ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                            : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                        }`}
                        title="Set kuantitas fisik sesuai stok rak ini"
                        id="set-location-qty-btn"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Set Rak ({selectedItem.qty} Pcs)
                      </button>

                      <button
                        onClick={() => {
                          const totalSku = selectedItem.totalQtySku || getSkuTotalQty(selectedItem.skuId);
                          handleActualQtyChange(totalSku, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize);
                        }}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded-lg border transition-all cursor-pointer flex items-center gap-1 ${
                          matchBasis === 'TOTAL_SKU'
                            ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                            : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                        }`}
                        title="Set kuantitas fisik sesuai total SKU di seluruh gudang"
                        id="set-total-sku-qty-btn"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Set Total SKU ({selectedItem.totalQtySku || getSkuTotalQty(selectedItem.skuId)} Pcs)
                      </button>

                      <button
                        onClick={() => {
                          const baseline = matchBasis === 'TOTAL_SKU'
                            ? (selectedItem.totalQtySku || getSkuTotalQty(selectedItem.skuId))
                            : selectedItem.qty;
                          handleActualQtyChange(baseline, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize);
                        }}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1"
                        title="Reset input ke baseline awal"
                        id="reset-input-qty-btn"
                      >
                        <RotateCcw className="w-3 h-3 text-slate-400" />
                        Reset Input
                      </button>
                    </div>
                  </div>

                  {/* Central counter selector */}
                  <div className="flex items-center justify-center gap-6 py-4 bg-[#161B25] rounded-2xl border border-slate-800">
                    <button
                      onClick={() => handleActualQtyChange(actualQty - 1, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                      className="w-12 h-12 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 flex items-center justify-center font-bold text-xl transition-all cursor-pointer select-none active:scale-95 shrink-0 shadow"
                      id="actual-qty-minus-btn"
                    >
                      <Minus className="w-5 h-5" />
                    </button>

                    <div className="text-center">
                      <input
                        type="number"
                        value={actualQty}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          handleActualQtyChange(val, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize);
                        }}
                        className="w-40 text-center bg-transparent text-white text-5xl font-black focus:outline-none border-b border-transparent focus:border-slate-700 pb-1 font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        id="actual-qty-input"
                      />
                      <div className="text-[10px] text-slate-400 font-semibold mt-1">
                        Total Pcs Hasil Opname Fisik
                      </div>
                    </div>

                    <button
                      onClick={() => handleActualQtyChange(actualQty + 1, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                      className="w-12 h-12 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 flex items-center justify-center font-bold text-xl transition-all cursor-pointer select-none active:scale-95 shrink-0 shadow"
                      id="actual-qty-plus-btn"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>

                  {/* Quick adjust step buttons */}
                  <div className="grid grid-cols-4 gap-2.5">
                    <button
                      onClick={() => handleQuickAdjust(-10, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                      className="py-2 px-3 bg-[#161B25] hover:bg-slate-800 text-slate-300 font-bold border border-slate-800 rounded-xl text-xs transition-all cursor-pointer text-center"
                    >
                      -10 Pcs
                    </button>
                    <button
                      onClick={() => handleQuickAdjust(-5, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                      className="py-2 px-3 bg-[#161B25] hover:bg-slate-800 text-slate-300 font-bold border border-slate-800 rounded-xl text-xs transition-all cursor-pointer text-center"
                    >
                      -5 Pcs
                    </button>
                    <button
                      onClick={() => handleQuickAdjust(5, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                      className="py-2 px-3 bg-[#161B25] hover:bg-slate-800 text-slate-300 font-bold border border-slate-800 rounded-xl text-xs transition-all cursor-pointer text-center"
                    >
                      +5 Pcs
                    </button>
                    <button
                      onClick={() => handleQuickAdjust(10, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                      className="py-2 px-3 bg-[#161B25] hover:bg-slate-800 text-slate-300 font-bold border border-slate-800 rounded-xl text-xs transition-all cursor-pointer text-center"
                    >
                      +10 Pcs
                    </button>
                  </div>
                </div>

                {/* KALKULATOR UNIT LAPANGAN CARD */}
                <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4">
                  <div className="flex items-center gap-2 border-b border-slate-800/60 pb-2.5">
                    <Boxes className="w-4 h-4 text-indigo-400" />
                    <h4 className="text-xs uppercase font-extrabold text-slate-200 tracking-wider">
                      Hitung Kemasan Lapangan (Pack Calculator)
                    </h4>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    {/* Carton Unit */}
                    <div className="bg-[#161B25] border border-slate-800 rounded-xl p-3 text-center space-y-2">
                      <div className="text-[11px] font-bold text-slate-300">Karton (Ctn)</div>
                      <div className="text-[10px] text-slate-500 font-mono">1 Ctn = {selectedItem.qtyCtnSize} pcs</div>
                      
                      <div className="flex items-center justify-between bg-slate-900 rounded-lg p-1 max-w-[120px] mx-auto">
                        <button
                          onClick={() => handleCalculatorChange('ctn', ctnInput - 1, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                          className="w-7 h-7 rounded bg-[#161B25] hover:bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-xs cursor-pointer select-none"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <input
                          type="number"
                          value={ctnInput}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            handleCalculatorChange('ctn', val, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize);
                          }}
                          className="w-10 text-center bg-transparent text-xs font-bold text-white focus:outline-none font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => handleCalculatorChange('ctn', ctnInput + 1, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                          className="w-7 h-7 rounded bg-[#161B25] hover:bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-xs cursor-pointer select-none"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {/* Inner Box Unit */}
                    <div className="bg-[#161B25] border border-slate-800 rounded-xl p-3 text-center space-y-2">
                      <div className="text-[11px] font-bold text-slate-300">Inner Box</div>
                      <div className="text-[10px] text-slate-500 font-mono">1 Inner = {selectedItem.qtyInnerSize} pcs</div>
                      
                      <div className="flex items-center justify-between bg-slate-900 rounded-lg p-1 max-w-[120px] mx-auto">
                        <button
                          onClick={() => handleCalculatorChange('inner', innerInput - 1, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                          className="w-7 h-7 rounded bg-[#161B25] hover:bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-xs cursor-pointer select-none"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <input
                          type="number"
                          value={innerInput}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            handleCalculatorChange('inner', val, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize);
                          }}
                          className="w-10 text-center bg-transparent text-xs font-bold text-white focus:outline-none font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => handleCalculatorChange('inner', innerInput + 1, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                          className="w-7 h-7 rounded bg-[#161B25] hover:bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-xs cursor-pointer select-none"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {/* Loose Unit */}
                    <div className="bg-[#161B25] border border-slate-800 rounded-xl p-3 text-center space-y-2">
                      <div className="text-[11px] font-bold text-slate-300">Loose (Eceran)</div>
                      <div className="text-[10px] text-slate-500 font-mono">Satuan Pcs</div>
                      
                      <div className="flex items-center justify-between bg-slate-900 rounded-lg p-1 max-w-[120px] mx-auto">
                        <button
                          onClick={() => handleCalculatorChange('loose', looseInput - 1, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                          className="w-7 h-7 rounded bg-[#161B25] hover:bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-xs cursor-pointer select-none"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <input
                          type="number"
                          value={looseInput}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            handleCalculatorChange('loose', val, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize);
                          }}
                          className="w-10 text-center bg-transparent text-xs font-bold text-white focus:outline-none font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => handleCalculatorChange('loose', looseInput + 1, selectedItem.qtyCtnSize, selectedItem.qtyInnerSize)}
                          className="w-7 h-7 rounded bg-[#161B25] hover:bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-xs cursor-pointer select-none"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="bg-emerald-500/5 border border-emerald-500/10 text-emerald-400 text-[11px] rounded-xl p-3 text-center font-mono">
                    Formulasi Hitung: ({ctnInput} &times; {selectedItem.qtyCtnSize}) + ({innerInput} &times; {selectedItem.qtyInnerSize}) + {looseInput} = <span className="font-bold underline">{formatNumber(actualQty)} pcs</span>.
                  </div>
                </div>

                {/* REAL-TIME MATCH/PLUS/MINUS STATUS BANNER */}
                <div>
                  {(() => {
                    const targetBaseline = matchBasis === 'TOTAL_SKU'
                      ? (selectedItem.totalQtySku || getSkuTotalQty(selectedItem.skuId))
                      : selectedItem.qty;
                    const baselineLabel = matchBasis === 'TOTAL_SKU' ? 'Total Qty SKU Gudang' : 'Stok Rak';
                    const diff = actualQty - targetBaseline;

                    if (diff === 0) {
                      return (
                        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4 rounded-2xl flex items-start gap-3">
                          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                          <div>
                            <h5 className="font-black text-xs uppercase tracking-wider">Status: Stok Sesuai (MATCH)</h5>
                            <p className="text-[11px] text-emerald-300/80 mt-0.5">
                              Hasil hitung fisik ({formatNumber(actualQty)} pcs) cocok sempurna dengan {baselineLabel} ({formatNumber(targetBaseline)} pcs). tidak ada selisih.
                            </p>
                          </div>
                        </div>
                      );
                    } else if (diff > 0) {
                      return (
                        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl flex items-start gap-3">
                          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <h5 className="font-black text-xs uppercase tracking-wider">Status: Stok Lebih (SURPLUS / PLUS)</h5>
                            <p className="text-[11px] text-amber-300/80 mt-0.5">
                              Terdapat kelebihan fisik sebesar <span className="font-bold">+{formatNumber(diff)} pcs</span> dibandingkan {baselineLabel} ({formatNumber(targetBaseline)} pcs).
                            </p>
                          </div>
                        </div>
                      );
                    } else {
                      return (
                        <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 p-4 rounded-2xl flex items-start gap-3">
                          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                          <div>
                            <h5 className="font-black text-xs uppercase tracking-wider">Status: Stok Kurang (DEFISIT / MINUS)</h5>
                            <p className="text-[11px] text-rose-300/80 mt-0.5">
                              Terdapat kekurangan fisik sebesar <span className="font-bold">{formatNumber(diff)} pcs</span> dibandingkan {baselineLabel} ({formatNumber(targetBaseline)} pcs).
                            </p>
                          </div>
                        </div>
                      );
                    }
                  })()}
                </div>

              </div>

              {/* Right Column: Audit Notes & Actions */}
              <div className="lg:col-span-5 space-y-5">
                
                {/* KETERANGAN CARD */}
                <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4">
                  <h4 className="text-xs uppercase font-extrabold text-slate-300 tracking-wider flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-emerald-400" />
                    <span>Catatan Audit & Tag Alasan</span>
                  </h4>

                  <div className="space-y-3">
                    <textarea
                      placeholder="Masukkan catatan opname (misal: barang terselip, kardus penyok, beda expired date)..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      className="w-full bg-[#161B25] border border-slate-800 text-slate-200 rounded-xl p-3 text-xs outline-none focus:ring-1 focus:ring-emerald-500 transition-all min-h-[110px] resize-none"
                      id="audit-notes-input"
                    />

                    <div className="space-y-2">
                      <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">
                        Pilihan Tag Alasan Cepat
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          'Auto-Count Zone 1 & Urban',
                          'Kemasan Sobek',
                          'Salah Susun Rak',
                          'Salah Input Inbound',
                          'Barang Kadaluarsa',
                          'Stok Sesuai Sistem'
                        ].map(tag => (
                          <button
                            key={tag}
                            onClick={() => {
                              const separator = notes ? '; ' : '';
                              setNotes(prev => prev.includes(tag) ? prev : prev + separator + tag);
                            }}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700/80 text-slate-300 text-[10px] font-semibold rounded-lg transition-all border border-slate-700/50 cursor-pointer"
                          >
                            + {tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* ACTION FOOTER BUTTONS CARD */}
                <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleCancel}
                      className="w-1/2 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs transition-all flex items-center justify-center gap-2 border border-slate-700/60 cursor-pointer"
                      id="cancel-audit-form-btn"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      Batal
                    </button>
                    <button
                      onClick={handleSaveAudit}
                      className="w-1/2 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold rounded-xl text-xs transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10 cursor-pointer"
                      id="save-audit-form-btn"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Simpan Stok Opname
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 text-center font-medium leading-normal">
                    Menyimpan data opname akan langsung mengupdate saldo rak dan menyimpan log ke history audit.
                  </p>
                </div>

              </div>

            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* MAIN TAB: DASHBOARD & GRAFIK ANALITIS (RECHARTS VISUAL DASHBOARD) */}
      {/* ========================================================================= */}
      {activeMainTab === 'CHARTS' && (
        <div className="space-y-6">
          {/* Header Banner */}
          <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-6 shadow-md space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-lg font-extrabold text-white flex items-center gap-2">
                  <BarChart3 className="w-6 h-6 text-indigo-400" />
                  Dashboard Grafik & Analitis Stok Opname Gudang
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Visualisasi real-time performa akurasi stok, distribusi status rak, dan komparasi stok fisik vs sistem.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={exportProfessionalStockOpnameReport}
                  className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-extrabold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/10 transition-all cursor-pointer"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  <span>Download Excel Report With Charts</span>
                </button>
              </div>
            </div>

            {/* Top KPI Gauge Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
              <div className="bg-[#161B25] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-mono">
                    Akurasi Lokasi Rak
                  </span>
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-2xl font-black text-emerald-400 font-mono mt-2">
                  {stockCounts.accuracyRate}%
                </div>
                <div className="w-full bg-slate-800 h-2 rounded-full mt-3 overflow-hidden">
                  <div 
                    className="bg-emerald-500 h-full rounded-full transition-all duration-500" 
                    style={{ width: `${Math.min(100, parseFloat(stockCounts.accuracyRate))}%` }} 
                  />
                </div>
                <span className="text-[10px] text-slate-400 mt-2 font-medium">Standard SOP Target: ≥98.0%</span>
              </div>

              <div className="bg-[#161B25] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-mono">
                    Akurasi Total Master SKU
                  </span>
                  <CheckSquare className="w-4 h-4 text-cyan-400" />
                </div>
                <div className="text-2xl font-black text-cyan-400 font-mono mt-2">
                  {stockCounts.skuAccuracyRate}%
                </div>
                <div className="w-full bg-slate-800 h-2 rounded-full mt-3 overflow-hidden">
                  <div 
                    className="bg-cyan-500 h-full rounded-full transition-all duration-500" 
                    style={{ width: `${Math.min(100, parseFloat(stockCounts.skuAccuracyRate))}%` }} 
                  />
                </div>
                <span className="text-[10px] text-slate-400 mt-2 font-medium">Across All Warehouse Locations</span>
              </div>

              <div className="bg-[#161B25] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-mono">
                    Progres Verifikasi Rak
                  </span>
                  <ClipboardCheck className="w-4 h-4 text-indigo-400" />
                </div>
                <div className="text-2xl font-black text-indigo-300 font-mono mt-2">
                  {stockCounts.audited} / {stockCounts.total}
                </div>
                <div className="w-full bg-slate-800 h-2 rounded-full mt-3 overflow-hidden">
                  <div 
                    className="bg-indigo-500 h-full rounded-full transition-all duration-500" 
                    style={{ width: `${stockCounts.total > 0 ? (stockCounts.audited / stockCounts.total) * 100 : 0}%` }} 
                  />
                </div>
                <span className="text-[10px] text-slate-400 mt-2 font-medium">
                  {stockCounts.total > 0 ? ((stockCounts.audited / stockCounts.total) * 100).toFixed(1) : 0}% Complete Coverage
                </span>
              </div>

              <div className="bg-[#161B25] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-mono">
                    Variansi Selisih Fisik
                  </span>
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                </div>
                <div className="text-2xl font-black text-amber-400 font-mono mt-2">
                  {stockCounts.discrepancies} <span className="text-xs font-bold text-slate-400">Rak Selisih</span>
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] font-mono">
                  <span className="text-emerald-400 font-bold">+{stockCounts.totalPlusQty} Pcs</span>
                  <span className="text-rose-400 font-bold">-{stockCounts.totalMinusQty} Pcs</span>
                </div>
                <span className="text-[10px] text-slate-400 mt-2 font-medium">Audit Action Needed</span>
              </div>
            </div>
          </div>

          {/* MAIN VISUAL CHARTS GRID */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* CHART 1: BAR CHART BREAKDOWN RAK AREA */}
            <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-sm font-extrabold text-white flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-emerald-400" />
                  <span>Breakdown Status Opname per Area Rak</span>
                </h4>
                <span className="text-[10px] font-mono bg-slate-800 text-slate-300 px-2.5 py-1 rounded-md">
                  Stacked Bars
                </span>
              </div>
              <div className="h-72 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={zoneChartData} margin={{ top: 10, right: 10, left: -15, bottom: 25 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="zone" stroke="#64748b" tick={{ fontSize: 11 }} angle={-20} textAnchor="end" />
                    <YAxis stroke="#64748b" tick={{ fontSize: 11 }} />
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px', color: '#fff' }} 
                    />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                    <Bar dataKey="match" name="Sesuai (Match)" stackId="a" fill="#10B981" />
                    <Bar dataKey="plus" name="Surplus (+)" stackId="a" fill="#06B6D4" />
                    <Bar dataKey="minus" name="Defisit (-)" stackId="a" fill="#F43F5E" />
                    <Bar dataKey="pending" name="Belum Audit" stackId="a" fill="#475569" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* CHART 2: PIE / DONUT CHART STATUS PROPORSI */}
            <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4 flex flex-col justify-between">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-sm font-extrabold text-white flex items-center gap-2">
                  <PieChart className="w-4 h-4 text-cyan-400" />
                  <span>Komposisi Status Hasil Audit Fisik</span>
                </h4>
                <span className="text-[10px] font-mono bg-slate-800 text-slate-300 px-2.5 py-1 rounded-md">
                  Donut Proportion
                </span>
              </div>
              <div className="h-72 w-full flex items-center justify-center pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsPieChart>
                    <Pie
                      data={statusPieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={95}
                      paddingAngle={4}
                      dataKey="value"
                      label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
                    >
                      {statusPieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px', color: '#fff' }} 
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                  </RechartsPieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* CHART 3: DUAL BAR CHART SISTEM VS FISIK (TOP SKU) */}
            <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4 lg:col-span-2">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-sm font-extrabold text-white flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-indigo-400" />
                  <span>Perbandingan Kuantitas Stok Sistem (WMS) vs Stok Fisik Opname (Top 8 Master SKU)</span>
                </h4>
                <span className="text-[10px] font-mono bg-slate-800 text-slate-300 px-2.5 py-1 rounded-md">
                  Volume Comparison
                </span>
              </div>
              <div className="h-80 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topSkuComparisonData} margin={{ top: 15, right: 15, left: -10, bottom: 35 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="name" stroke="#64748b" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" />
                    <YAxis stroke="#64748b" tick={{ fontSize: 11 }} />
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px', color: '#fff' }} 
                    />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '15px' }} />
                    <Bar dataKey="systemQty" name="Stok Sistem (Pcs)" fill="#6366F1" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="physicalQty" name="Stok Fisik Audit (Pcs)" fill="#10B981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* CHART 4: TINGKAT AKURASI % PER AREA RAK */}
            <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-md space-y-4 lg:col-span-2">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-sm font-extrabold text-white flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Persentase Tingkat Akurasi Opname (%) Menurut Area & Zona Rak</span>
                </h4>
                <span className="text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded-md font-bold">
                  Target ≥ 98%
                </span>
              </div>
              <div className="h-72 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={zoneChartData} margin={{ top: 15, right: 15, left: -15, bottom: 25 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="zone" stroke="#64748b" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} stroke="#64748b" tick={{ fontSize: 11 }} unit="%" />
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px', color: '#fff' }} 
                    />
                    <Area type="monotone" dataKey="accuracyPercent" name="Tingkat Akurasi (%)" fill="#047857" stroke="#10B981" fillOpacity={0.3} />
                    <Bar dataKey="accuracyPercent" name="Akurasi Rak (%)" fill="#10B981" barSize={24} radius={[4, 4, 0, 0]}>
                      {zoneChartData.map((entry, index) => (
                        <Cell key={`cell-acc-${index}`} fill={entry.accuracyPercent >= 98 ? '#10B981' : entry.accuracyPercent >= 90 ? '#F59E0B' : '#EF4444'} />
                      ))}
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

          </div>

          {/* EXCEL CHART GENERATION GUIDANCE BANNER */}
          <div className="bg-[#11141B] border border-indigo-500/30 rounded-2xl p-5 shadow-lg space-y-3">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20 mt-0.5">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-white">
                  Petunjuk Laporan Excel Grafik & Visual Bar Chart Auto-Generated
                </h4>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                  Laporan Excel yang didownload dari WMS telah dilengkapi dengan <strong>Visual Bar Chart In-Cell (Horizontal ASCII Bars)</strong> di setiap lembar kerja (misal: <code className="text-emerald-400 bg-slate-900 px-1.5 py-0.5 rounded">██████████░░ 83.3%</code>) sehingga laporan langsung terlihat visual dan rapi tanpa perlu instalasi tambahan.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                  <span className="flex items-center gap-1 text-emerald-400 font-bold">
                    ✓ Multi-Sheet Workbook
                  </span>
                  <span className="flex items-center gap-1 text-cyan-400 font-bold">
                    ✓ Native Excel Chart Data Table included
                  </span>
                  <span className="flex items-center gap-1 text-amber-400 font-bold">
                    ✓ Press Alt + F1 in Excel for Native Chart
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MAIN TAB 2: REKONSILIASI SELISIH (DISCREPANCY RECONCILIATION) */}
      {/* ========================================================================= */}
      {activeMainTab === 'RECONCILIATION' && (
        <div className="space-y-4">
          <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-6 shadow-md space-y-4">
            
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-extrabold text-white flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                  Pusat Rekonsiliasi Selisih Stok (Discrepancy Control)
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Menganalisis item produk yang memiliki variansi selisih kuantitas antara saldo buku WMS dan hasil opname fisik.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-bold rounded-xl font-mono">
                  {discrepancyItems.length} Item Perlu Review
                </span>
              </div>
            </div>

            {discrepancyItems.length === 0 ? (
              <div className="py-12 text-center space-y-3 bg-[#161B25] rounded-xl border border-slate-800">
                <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
                <div className="text-sm font-bold text-white">Tidak Ada Selisih Stok!</div>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Seluruh data stok rak di gudang yang telah di-opname saat ini seimbang (MATCH) dengan saldo buku WMS.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-800/80">
                <table className="w-full text-left text-xs text-slate-300">
                  <thead className="bg-[#161B25] text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                    <tr>
                      <th className="py-3 px-4">Barang (SKU / Nama)</th>
                      <th className="py-3 px-4">Lokasi Rak</th>
                      <th className="py-3 px-4 text-right">Stok Sistem</th>
                      <th className="py-3 px-4 text-right">Fisik Opname</th>
                      <th className="py-3 px-4 text-right">Selisih Delta</th>
                      <th className="py-3 px-4">Alasan / Catatan</th>
                      <th className="py-3 px-4">Auditor</th>
                      <th className="py-3 px-4 text-center">Aksi Quick Edit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {discrepancyItems.map(({ stockItem, auditRecord }) => (
                      <tr key={`recon_${stockItem.id}`} className="hover:bg-slate-800/20 transition-all">
                        <td className="py-3.5 px-4">
                          <div className="font-black text-white font-mono">{stockItem.skuId}</div>
                          <div className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">{stockItem.skuName}</div>
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 text-slate-200 font-extrabold rounded-lg text-[10px] border border-slate-700 font-mono">
                            <MapPin className="w-3 h-3 text-emerald-400" />
                            {stockItem.location}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-slate-400">
                          {formatNumber(auditRecord.systemQty)} pcs
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold text-white">
                          {formatNumber(auditRecord.physicalQty)} pcs
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-black">
                          {auditRecord.difference > 0 ? (
                            <span className="text-amber-400">+{formatNumber(auditRecord.difference)} pcs</span>
                          ) : (
                            <span className="text-rose-400">{formatNumber(auditRecord.difference)} pcs</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-slate-300 max-w-xs truncate" title={auditRecord.notes}>
                          {auditRecord.notes || 'Anomali Fisik'}
                        </td>
                        <td className="py-3.5 px-4 text-slate-400 font-medium">
                          {auditRecord.operator}
                        </td>
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          <button
                            onClick={() => {
                              setActiveMainTab('CONSOLE');
                              handleSelectItem(stockItem);
                            }}
                            className="px-3 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/25 font-bold rounded-lg text-[11px] transition-all cursor-pointer"
                          >
                            Re-Audit Items
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MAIN TAB 3: DAILY CYCLE COUNT (SAMPLING SKU HARIAN PER LOKASI & PACK) */}
      {/* ========================================================================= */}
      {activeMainTab === 'CYCLE_COUNT' && (
        <div className="space-y-6">
          
          {/* DAILY CYCLE COUNT HEADER BANNER */}
          <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-6 shadow-lg space-y-6">
            
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-purple-600/10 text-purple-400 rounded-2xl border border-purple-500/20 shrink-0">
                  <Calendar className="w-7 h-7" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-white flex items-center gap-2">
                    Daily Cycle Count (Detail Per Lokasi & Count Karton/Inner/Loose)
                    <span className="px-2.5 py-0.5 bg-purple-500/10 text-purple-400 text-[10px] font-extrabold rounded-full border border-purple-500/20 font-mono">
                      Pack Basis
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Sesi hitung fisik rutin harian WMS. Pilih SKU yang di-count, lalu input fisik dalam satuan <strong className="text-white">Karton (CTN), Inner, dan Loose (PCS)</strong> per lokasi rak.
                  </p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-[11px] font-bold">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      Sesi Hitung Tersimpan Otomatis (Aman saat geser menu lain)
                    </span>
                    {cycleCountBatch.length > 0 && (
                      <button
                        onClick={() => {
                          if (confirm('Kosongkan sesi DCC aktif saat ini? Semua progres input pada sesi ini akan dibersihkan.')) {
                            setCycleCountBatch([]);
                            try {
                              localStorage.removeItem(localScopeKey('wms_dcc_active_batch',currentUser,true));
                            } catch {}
                          }
                        }}
                        className="px-2.5 py-1 bg-slate-800/80 hover:bg-rose-950/40 hover:text-rose-300 text-slate-400 text-[11px] font-medium rounded-lg transition-all cursor-pointer border border-slate-700/60 flex items-center gap-1"
                        title="Kosongkan batch DCC yang sedang aktif"
                      >
                        <Trash2 className="w-3 h-3 text-rose-400" />
                        <span>Hapus Sesi Aktif</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {/* SKU Picker Modal Button */}
                <button
                  onClick={handleOpenSkuPicker}
                  className="px-3.5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-extrabold text-xs rounded-xl transition-all cursor-pointer flex items-center gap-2 shadow-md shadow-purple-600/20"
                  id="open-sku-picker-btn"
                >
                  <CheckSquare className="w-4 h-4" />
                  Pilih SKU Count (+ Modal)
                  <span className="px-2 py-0.5 bg-white/20 text-white text-[10px] font-mono font-bold rounded-md ml-1">
                    {cycleCountBatch.length} SKU
                  </span>
                </button>

                {/* Target SKU count selector */}
                <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-1 text-xs">
                  <span className="text-slate-400 text-[11px] font-bold px-2 font-mono">Target SKU:</span>
                  {[10, 15, 20, 25].map(num => (
                    <button
                      key={num}
                      onClick={() => {
                        if (cycleCountBatch.length > 0) {
                          if (!confirm(`Ganti target menjadi ${num} SKU dan acak sample baru? Progres hitung yang belum dikonfirmasi akan digantikan.`)) {
                            return;
                          }
                        }
                        setCycleCountTargetQty(num);
                        generateDailyCycleCountBatch(num);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer ${
                        cycleCountTargetQty === num
                          ? 'bg-purple-600 text-white font-black shadow-sm'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {num} SKU
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => {
                    if (cycleCountBatch.length > 0) {
                      if (!confirm('Acak ulang sample SKU? Hitungan yang belum dikonfirmasi pada batch saat ini akan digantikan.')) {
                        return;
                      }
                    }
                    generateDailyCycleCountBatch(cycleCountTargetQty);
                  }}
                  className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-purple-300 font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center gap-2 border border-slate-700/60"
                  title="Generasi / Acak Ulang Sample SKU Hari Ini"
                >
                  <Shuffle className="w-4 h-4 text-purple-400" />
                  Acak {cycleCountTargetQty} SKU
                </button>

                <button
                  onClick={exportDailyCycleCountReport}
                  disabled={confirmedDccBatch.length === 0 && cycleCountBatch.length === 0}
                  className={`px-3.5 py-2.5 font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center gap-2 border disabled:opacity-50 ${
                    confirmedDccBatch.length > 0
                      ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30 border-indigo-400 ring-1 ring-indigo-400/40'
                      : 'bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-400 border-indigo-500/30'
                  }`}
                  id="export-cycle-count-excel-btn"
                  title="Export Excel hasil SKU yang sudah dikonfirmasi hitung"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  <span>
                    Export Excel {confirmedDccBatch.length > 0 ? `(${confirmedDccBatch.length} Terkonfirmasi)` : '(.xlsx)'}
                  </span>
                </button>

                {confirmedDccBatch.length > 0 && (
                  <button
                    onClick={() => {
                      if (confirm('Hapus riwayat SKU terkonfirmasi hari ini untuk memulai batch export baru?')) {
                        setConfirmedDccBatch([]);
                        try {
                          localStorage.removeItem(localScopeKey('wms_dcc_confirmed_today',currentUser,true));
                        } catch {}
                      }
                    }}
                    className="px-2.5 py-2.5 bg-slate-800/80 hover:bg-rose-950/40 hover:text-rose-300 text-slate-400 text-xs rounded-xl transition-all cursor-pointer flex items-center gap-1 border border-slate-700/60"
                    title="Reset riwayat SKU terkonfirmasi hari ini"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span className="text-[11px]">Reset Hasil</span>
                  </button>
                )}

                <button
                  onClick={handleSetAllCycleCountMatch}
                  disabled={cycleCountBatch.length === 0}
                  className="px-3.5 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-extrabold text-xs rounded-xl transition-all cursor-pointer flex items-center gap-2 border border-emerald-500/30 disabled:opacity-50"
                  id="set-all-cycle-count-match-btn"
                  title="Samakan kuantitas seluruh SKU & lokasi di sesi ini dengan Qty sistem"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  Set Match All Batch
                </button>
              </div>
            </div>

            {/* DCC SCHEDULE QUICK LOAD STRIP */}
            <div className="pt-3 border-t border-slate-800/80 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#161B25]/60 p-3.5 rounded-xl border border-slate-800">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="text-xs font-bold text-slate-200">Muat Jadwal DCC Harian:</span>
                <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">(Hanya SKU dengan Stok &gt; 0)</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {currentDccSchedule.map(s => {
                  const activeCount = scheduleCountsByDay[s.day]?.activeWithStock || 0;
                  const isToday = s.day === todayDayName;
                  return (
                    <button
                      key={s.day}
                      onClick={() => loadDccScheduleBatch(s.day)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 border ${
                        isToday 
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 hover:bg-amber-500/30 ring-1 ring-amber-500/30' 
                          : 'bg-[#11141B] text-slate-300 border-slate-800 hover:border-slate-700 hover:text-white'
                      }`}
                      title={`Muat ${activeCount} SKU stok > 0 untuk hari ${s.day}`}
                    >
                      <span>{s.day}</span>
                      {isToday && <span className="text-[9px] bg-amber-400 text-slate-950 font-black px-1.5 py-0.2 rounded font-mono">Hari Ini</span>}
                      <span className="px-1.5 py-0.2 rounded bg-slate-900 text-amber-400 font-mono text-[10px] font-bold">
                        {activeCount}
                      </span>
                    </button>
                  );
                })}
                <button
                  onClick={() => setActiveMainTab('SCHEDULE')}
                  className="px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center gap-1 border border-purple-500/30 ml-1"
                >
                  <CalendarDays className="w-3.5 h-3.5 text-purple-400" />
                  <span>Lihat Detail Jadwal</span>
                </button>
              </div>
            </div>

            {/* KPI METRICS FOR DAILY CYCLE COUNT */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
              <div className="bg-[#161B25] p-4 rounded-xl border border-slate-800 space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                  Sample Target SKU
                </span>
                <div className="text-2xl font-black text-white font-mono flex items-baseline gap-2">
                  {cycleCountBatch.length} <span className="text-xs text-slate-400 font-normal">Master SKU</span>
                </div>
                <div className="text-[10px] text-purple-400 font-medium">
                  Total {cycleCountBatch.reduce((sum, item) => sum + item.locations.length, 0)} Baris Lokasi Rak
                </div>
              </div>

              <div className="bg-[#161B25] p-4 rounded-xl border border-slate-800 space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                  Akurasi Match Total SKU
                </span>
                <div className="text-2xl font-black text-emerald-400 font-mono flex items-baseline gap-2">
                  {cycleCountBatch.length > 0 
                    ? ((cycleCountBatch.filter(i => {
                        const totPhys = i.locations.reduce((sum, l) => sum + l.physicalQty, 0);
                        return totPhys === i.totalSystemQty;
                      }).length / cycleCountBatch.length) * 100).toFixed(1)
                    : '100.0'}%
                </div>
                <div className="text-[10px] text-slate-400 font-medium">
                  {cycleCountBatch.filter(i => {
                    const totPhys = i.locations.reduce((sum, l) => sum + l.physicalQty, 0);
                    return totPhys === i.totalSystemQty;
                  }).length} / {cycleCountBatch.length} SKU Total Match
                </div>
              </div>

              <div className="bg-[#161B25] p-4 rounded-xl border border-slate-800 space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                  Total Surplus (+) Physical
                </span>
                <div className="text-2xl font-black text-amber-400 font-mono">
                  +{formatNumber(cycleCountBatch.reduce((sum, i) => {
                    const totPhys = i.locations.reduce((lSum, l) => lSum + l.physicalQty, 0);
                    return sum + (totPhys > i.totalSystemQty ? (totPhys - i.totalSystemQty) : 0);
                  }, 0))} <span className="text-xs font-normal">pcs</span>
                </div>
                <div className="text-[10px] text-amber-400/80 font-medium">Fisik Lebih Dari Sistem</div>
              </div>

              <div className="bg-[#161B25] p-4 rounded-xl border border-slate-800 space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                  Total Defisit (-) Physical
                </span>
                <div className="text-2xl font-black text-rose-400 font-mono">
                  -{formatNumber(cycleCountBatch.reduce((sum, i) => {
                    const totPhys = i.locations.reduce((lSum, l) => lSum + l.physicalQty, 0);
                    return sum + (totPhys < i.totalSystemQty ? (i.totalSystemQty - totPhys) : 0);
                  }, 0))} <span className="text-xs font-normal">pcs</span>
                </div>
                <div className="text-[10px] text-rose-400/80 font-medium">Fisik Kurang Dari Sistem</div>
              </div>
            </div>

            {/* SEARCH & SKU COUNT CARDS WITH LOCATION PACK BREAKDOWN */}
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="relative max-w-sm w-full">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                  <input
                    type="text"
                    value={cycleCountSearchQuery}
                    onChange={(e) => setCycleCountSearchQuery(e.target.value)}
                    placeholder="Cari SKU ID, nama barang, atau lokasi rak..."
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleOpenSkuPicker}
                    className="px-3 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <List className="w-3.5 h-3.5" />
                    Atur / Tambah SKU Session
                  </button>
                  <div className="text-xs text-slate-400 font-mono">
                    Total <span className="text-white font-bold">{cycleCountBatch.length}</span> SKU Dalam Sesi
                  </div>
                </div>
              </div>

              {cycleCountBatch.length === 0 ? (
                <div className="p-8 text-center bg-[#161B25] border border-slate-800 rounded-2xl space-y-3">
                  <Boxes className="w-10 h-10 text-slate-600 mx-auto" />
                  <p className="text-slate-400 text-xs">Belum ada daftar sampling cycle count untuk sesi ini.</p>
                  <div className="flex justify-center gap-2">
                    <button
                      onClick={handleOpenSkuPicker}
                      className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs rounded-xl cursor-pointer transition-all flex items-center gap-2"
                    >
                      <CheckSquare className="w-4 h-4" />
                      Pilih SKU count manual
                    </button>
                    <button
                      onClick={() => generateDailyCycleCountBatch(cycleCountTargetQty)}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-purple-300 font-bold text-xs rounded-xl cursor-pointer transition-all border border-slate-700"
                    >
                      Acak {cycleCountTargetQty} SKU
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {cycleCountBatch
                    .filter(i => {
                      // Rule: Jangan tampilkan jika stok sistem 0
                      const activeLocs = i.locations.filter(l => l.systemQty > 0);
                      if (activeLocs.length === 0 || i.totalSystemQty <= 0) return false;

                      const q = cycleCountSearchQuery.toLowerCase().trim();
                      if (!q) return true;
                      return (
                        i.skuId.toLowerCase().includes(q) ||
                        i.skuName.toLowerCase().includes(q) ||
                        i.locations.some(l => l.location.toLowerCase().includes(q) && l.systemQty > 0)
                      );
                    })
                    .map((skuItem, skuIdx) => {
                      const visibleLocations = skuItem.locations.filter(l => l.systemQty > 0);
                      if (visibleLocations.length === 0) return null;
                      const totalSkuPhysical = visibleLocations.reduce((sum, l) => sum + l.physicalQty, 0);
                      const totalSkuSystem = visibleLocations.reduce((sum, l) => sum + l.systemQty, 0);
                      const skuDiff = totalSkuPhysical - totalSkuSystem;
                      const isSkuMatch = skuDiff === 0;

                      return (
                        <div
                          key={`cc_card_${skuItem.skuId}`}
                          className="bg-[#161B25] border border-slate-800/90 rounded-2xl p-5 space-y-4 shadow-md transition-all hover:border-purple-500/40"
                        >
                          {/* SKU CARD HEADER */}
                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-800/80 pb-3.5">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-black text-base text-white font-mono bg-purple-500/10 text-purple-300 px-2.5 py-0.5 rounded-lg border border-purple-500/20">
                                  {skuItem.skuId}
                                </span>
                                <h4 className="text-sm font-bold text-white line-clamp-1">{skuItem.skuName}</h4>
                                <span className="px-2 py-0.5 bg-slate-800 text-slate-300 text-[10px] font-extrabold rounded border border-slate-700 font-mono">
                                  1 CTN = {skuItem.qtyCtnSize} PCS | 1 INNER = {skuItem.qtyInnerSize} PCS
                                </span>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-3">
                              {/* SKU System vs Physical Summary */}
                              <div className="flex items-center gap-3 bg-slate-900 px-3 py-1.5 rounded-xl border border-slate-800 text-xs font-mono">
                                <div>
                                  <span className="text-[10px] text-slate-400 block font-sans">SYS TOTAL SKU</span>
                                  <span className="font-extrabold text-slate-200">{formatNumber(totalSkuSystem)} pcs</span>
                                </div>
                                <div className="h-6 w-px bg-slate-800" />
                                <div>
                                  <span className="text-[10px] text-slate-400 block font-sans">PHYS TOTAL SKU</span>
                                  <span className="font-extrabold text-white">{formatNumber(totalSkuPhysical)} pcs</span>
                                </div>
                                <div className="h-6 w-px bg-slate-800" />
                                <div>
                                  <span className="text-[10px] text-slate-400 block font-sans">DELTA SKU</span>
                                  {skuDiff === 0 ? (
                                    <span className="font-extrabold text-emerald-400">0 pcs (MATCH)</span>
                                  ) : skuDiff > 0 ? (
                                    <span className="font-extrabold text-amber-400">+{formatNumber(skuDiff)} pcs</span>
                                  ) : (
                                    <span className="font-extrabold text-rose-400">{formatNumber(skuDiff)} pcs</span>
                                  )}
                                </div>
                              </div>

                              {/* Action buttons */}
                              <button
                                onClick={() => handleConfirmDccSku(skuItem.skuId)}
                                className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl shadow-md shadow-emerald-500/20 transition-all cursor-pointer flex items-center gap-1.5 shrink-0"
                                title="Konfirmasi bahwa SKU ini sudah dihitung (hasil disimpan dan SKU hilang dari daftar)"
                              >
                                <CheckCircle2 className="w-4 h-4 fill-slate-950 text-emerald-400" />
                                <span>Konfirmasi Dihitung</span>
                              </button>

                              <button
                                onClick={() => handleSetSkuMatch(skuItem.skuId)}
                                className="px-2.5 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-lg text-[11px] font-bold transition-all cursor-pointer"
                                title="Samakan semua lokasi fisik SKU ini dengan Qty sistem"
                              >
                                Set Match All
                              </button>

                              <button
                                onClick={() => handleAddLocationToSku(skuItem.skuId)}
                                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-[11px] font-bold transition-all cursor-pointer"
                                title="Tambah baris lokasi rak lain untuk SKU ini"
                              >
                                + Lokasi Lain
                              </button>

                              <button
                                onClick={() => handleRemoveSkuFromBatch(skuItem.skuId)}
                                className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all cursor-pointer"
                                title="Hapus SKU ini dari sesi count"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          {/* PER-LOCATION BREAKDOWN TABLE */}
                          <div className="overflow-x-auto rounded-xl border border-slate-800/80 bg-slate-900/60">
                            <table className="w-full text-left text-xs text-slate-300">
                              <thead className="bg-[#11141B] text-slate-400 font-bold uppercase tracking-wider text-[10px] font-mono border-b border-slate-800">
                                <tr>
                                  <th className="py-2.5 px-4">Lokasi Rak & ED</th>
                                  <th className="py-2.5 px-4 text-right">System Qty (Rak)</th>
                                  <th className="py-2.5 px-4 text-center min-w-[340px]">
                                    Input Fisik (Carton, Inner, Loose)
                                  </th>
                                  <th className="py-2.5 px-4 text-right">Physical Total</th>
                                  <th className="py-2.5 px-4 text-right">Selisih</th>
                                  <th className="py-2.5 px-4 text-center">Status</th>
                                  <th className="py-2.5 px-4 text-center">Aksi</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-800/60">
                                {visibleLocations.map((loc, locIdx) => {
                                  const sysPack = calculatePackQuantities(loc.systemQty, skuItem.qtyCtnSize, skuItem.qtyInnerSize);
                                  const locDiff = loc.physicalQty - loc.systemQty;

                                  return (
                                    <tr key={loc.id || `loc_${locIdx}`} className="hover:bg-slate-800/30 transition-all">
                                      {/* Lokasi & ED */}
                                      <td className="py-3 px-4">
                                        <div className="flex items-center gap-2">
                                          <span className="font-extrabold text-white font-mono bg-slate-800 px-2.5 py-1 rounded-md border border-slate-700 text-xs">
                                            {loc.location}
                                          </span>
                                          <span className="text-[10px] text-slate-400 font-mono">ED: {loc.expiredDate}</span>
                                        </div>
                                      </td>

                                      {/* System Qty in pcs + pack breakdown */}
                                      <td className="py-3 px-4 text-right font-mono">
                                        <div className="font-bold text-slate-200">{formatNumber(loc.systemQty)} pcs</div>
                                        <div className="text-[10px] text-slate-400">
                                          ({sysPack.qtyCtn} CTN, {sysPack.qtyInner} INR, {sysPack.qtyLoose} PCS)
                                        </div>
                                      </td>

                                      {/* Granular Pack Inputs (CTN, INNER, LOOSE) */}
                                      <td className="py-3 px-4">
                                        <div className="flex items-center justify-center gap-2">
                                          {/* Carton Input */}
                                          <div className="flex flex-col items-center bg-[#11141B] p-1.5 rounded-lg border border-slate-700/80">
                                            <span className="text-[9px] font-extrabold text-slate-400 uppercase font-mono mb-1">
                                              Carton (CTN)
                                            </span>
                                            <div className="flex items-center gap-1">
                                              <button
                                                onClick={() => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'ctnInput', loc.ctnInput - 1)}
                                                className="w-5 h-5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded flex items-center justify-center text-xs cursor-pointer"
                                              >
                                                -
                                              </button>
                                              <input
                                                type="number"
                                                min="0"
                                                value={loc.ctnInput}
                                                onChange={(e) => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'ctnInput', parseInt(e.target.value) || 0)}
                                                className="w-14 bg-slate-900 border border-purple-500/40 text-center font-mono font-bold text-white text-xs py-1 rounded outline-none focus:border-purple-400"
                                              />
                                              <button
                                                onClick={() => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'ctnInput', loc.ctnInput + 1)}
                                                className="w-5 h-5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded flex items-center justify-center text-xs cursor-pointer"
                                              >
                                                +
                                              </button>
                                            </div>
                                          </div>

                                          {/* Inner Input */}
                                          <div className="flex flex-col items-center bg-[#11141B] p-1.5 rounded-lg border border-slate-700/80">
                                            <span className="text-[9px] font-extrabold text-slate-400 uppercase font-mono mb-1">
                                              Inner
                                            </span>
                                            <div className="flex items-center gap-1">
                                              <button
                                                onClick={() => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'innerInput', loc.innerInput - 1)}
                                                className="w-5 h-5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded flex items-center justify-center text-xs cursor-pointer"
                                              >
                                                -
                                              </button>
                                              <input
                                                type="number"
                                                min="0"
                                                value={loc.innerInput}
                                                onChange={(e) => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'innerInput', parseInt(e.target.value) || 0)}
                                                className="w-12 bg-slate-900 border border-purple-500/40 text-center font-mono font-bold text-white text-xs py-1 rounded outline-none focus:border-purple-400"
                                              />
                                              <button
                                                onClick={() => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'innerInput', loc.innerInput + 1)}
                                                className="w-5 h-5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded flex items-center justify-center text-xs cursor-pointer"
                                              >
                                                +
                                              </button>
                                            </div>
                                          </div>

                                          {/* Loose (Pcs) Input */}
                                          <div className="flex flex-col items-center bg-[#11141B] p-1.5 rounded-lg border border-slate-700/80">
                                            <span className="text-[9px] font-extrabold text-slate-400 uppercase font-mono mb-1">
                                              Loose (PCS)
                                            </span>
                                            <div className="flex items-center gap-1">
                                              <button
                                                onClick={() => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'looseInput', loc.looseInput - 1)}
                                                className="w-5 h-5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded flex items-center justify-center text-xs cursor-pointer"
                                              >
                                                -
                                              </button>
                                              <input
                                                type="number"
                                                min="0"
                                                value={loc.looseInput}
                                                onChange={(e) => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'looseInput', parseInt(e.target.value) || 0)}
                                                className="w-14 bg-slate-900 border border-purple-500/40 text-center font-mono font-bold text-white text-xs py-1 rounded outline-none focus:border-purple-400"
                                              />
                                              <button
                                                onClick={() => handleUpdateLocationPackInput(skuItem.skuId, locIdx, 'looseInput', loc.looseInput + 1)}
                                                className="w-5 h-5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded flex items-center justify-center text-xs cursor-pointer"
                                              >
                                                +
                                              </button>
                                            </div>
                                          </div>
                                        </div>
                                      </td>

                                      {/* Total Physical Qty in Pcs */}
                                      <td className="py-3 px-4 text-right font-mono font-black text-white">
                                        <div className="text-sm text-purple-300">{formatNumber(loc.physicalQty)} pcs</div>
                                        <div className="text-[10px] text-slate-400">
                                          ({loc.ctnInput} CTN + {loc.innerInput} INR + {loc.looseInput} PCS)
                                        </div>
                                      </td>

                                      {/* Location Delta */}
                                      <td className="py-3 px-4 text-right font-mono font-bold">
                                        {locDiff === 0 ? (
                                          <span className="text-emerald-400">0</span>
                                        ) : locDiff > 0 ? (
                                          <span className="text-amber-400">+{formatNumber(locDiff)}</span>
                                        ) : (
                                          <span className="text-rose-400">{formatNumber(locDiff)}</span>
                                        )}
                                      </td>

                                      {/* Status Pill */}
                                      <td className="py-3 px-4 text-center">
                                        {locDiff === 0 ? (
                                          <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-[9px] font-extrabold rounded-full">
                                            ✓ MATCH
                                          </span>
                                        ) : locDiff > 0 ? (
                                          <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[9px] font-extrabold rounded-full">
                                            ▲ SURPLUS
                                          </span>
                                        ) : (
                                          <span className="px-2 py-0.5 bg-rose-500/10 border border-rose-500/25 text-rose-400 text-[9px] font-extrabold rounded-full">
                                            ▼ DEFISIT
                                          </span>
                                        )}
                                      </td>

                                      {/* Action Buttons */}
                                      <td className="py-3 px-4 text-center">
                                        <div className="flex items-center justify-center gap-1">
                                          <button
                                            onClick={() => handleSetLocationMatch(skuItem.skuId, locIdx)}
                                            className="px-2 py-1 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/25 text-[10px] font-bold rounded transition-all cursor-pointer"
                                            title="Set Qty fisik lokasi ini = Qty sistem"
                                          >
                                            Set Match
                                          </button>
                                          {skuItem.locations.length > 1 && (
                                            <button
                                              onClick={() => handleRemoveLocationFromSku(skuItem.skuId, locIdx)}
                                              className="p-1 text-slate-500 hover:text-rose-400 transition-all cursor-pointer"
                                              title="Hapus baris lokasi ini"
                                            >
                                              <X className="w-3.5 h-3.5" />
                                            </button>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: PILIH SKU MANUAL UNTUK DAILY CYCLE COUNT */}
      {/* ========================================================================= */}
      {isSkuPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-[#11141B] border border-slate-800 rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            
            {/* MODAL HEADER */}
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-[#161B25]">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-purple-500/10 text-purple-400 rounded-xl border border-purple-500/20">
                  <CheckSquare className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-white">
                    Pilih / Filter SKU Untuk Daily Cycle Count
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Pilih SKU yang ingin dihitung hari ini. Sistem akan menyiapkan baris input Karton, Inner, & Loose per lokasi rak.
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsSkuPickerOpen(false)}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* MODAL TOOLBAR & QUICK SELECTION */}
            <div className="p-4 bg-[#11141B] border-b border-slate-800 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                  <input
                    type="text"
                    value={skuPickerSearch}
                    onChange={(e) => setSkuPickerSearch(e.target.value)}
                    placeholder="Cari SKU ID atau nama barang..."
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleSelect15RandomInPicker}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-purple-300 border border-slate-700 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1"
                  >
                    <Shuffle className="w-3.5 h-3.5" />
                    Acak 15 SKU
                  </button>
                  <button
                    onClick={handleSelectFastMovingInPicker}
                    className="px-2.5 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1"
                  >
                    <TrendingUp className="w-3.5 h-3.5" />
                    Fast Moving
                  </button>
                  <button
                    onClick={handleSelectAllInPicker}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-bold transition-all cursor-pointer"
                  >
                    Pilih Semua ({activeStockSkusList.length})
                  </button>
                  <button
                    onClick={handleClearAllInPicker}
                    className="px-2.5 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-lg text-xs font-bold transition-all cursor-pointer"
                  >
                    Kosongkan
                  </button>
                </div>
              </div>
            </div>

            {/* MODAL SKU LIST */}
            <div className="p-4 overflow-y-auto flex-1 space-y-2 divide-y divide-slate-800/50">
              {activeStockSkusList
                .filter(item => {
                  const q = skuPickerSearch.toLowerCase().trim();
                  if (!q) return true;
                  return item.skuId.toLowerCase().includes(q) || item.skuName.toLowerCase().includes(q);
                })
                .map((sku) => {
                  const isSelected = selectedSkuIdsForPicker.includes(sku.skuId);

                  return (
                    <div
                      key={`picker_sku_${sku.skuId}`}
                      onClick={() => toggleSkuPickerSelection(sku.skuId)}
                      className={`p-3 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-3 pt-3 ${
                        isSelected
                          ? 'bg-purple-600/10 border border-purple-500/40'
                          : 'hover:bg-slate-800/40 border border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}} // handled by row onClick
                          className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 border-slate-700 bg-slate-900 cursor-pointer"
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-extrabold text-white font-mono text-xs">{sku.skuId}</span>
                            <span className="text-[10px] text-slate-400 font-mono">
                              (1 CTN = {sku.qtyCtnSize} PCS, 1 INNER = {sku.qtyInnerSize} PCS)
                            </span>
                          </div>
                          <div className="text-xs text-slate-300 font-medium line-clamp-1">{sku.skuName}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            Lokasi: <span className="text-slate-300 font-mono font-bold">{sku.locations.join(', ')}</span>
                          </div>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-xs font-bold text-purple-300 font-mono block">
                          {formatNumber(sku.totalSystemQty)} pcs
                        </span>
                        <span className="text-[10px] text-slate-400 block font-mono">
                          {sku.locations.length} Lokasi Rak
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* MODAL FOOTER */}
            <div className="p-4 bg-[#161B25] border-t border-slate-800 flex items-center justify-between">
              <div className="text-xs text-slate-300 font-mono">
                Terpilih: <span className="font-bold text-purple-400">{selectedSkuIdsForPicker.length} SKU</span> dari {activeStockSkusList.length} SKU
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsSkuPickerOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition-all cursor-pointer"
                >
                  Batal
                </button>
                <button
                  onClick={handleApplySkuPickerSelection}
                  className="px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white font-extrabold text-xs rounded-xl transition-all cursor-pointer shadow-md shadow-purple-600/20"
                >
                  Terapkan Ke Session Count ({selectedSkuIdsForPicker.length} SKU)
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MAIN TAB: JADWAL DCC HARIAN (SENIN - JUMAT) */}
      {/* ========================================================================= */}
      {activeMainTab === 'SCHEDULE' && (
        <div className="space-y-6">
          {/* Header Banner */}
          <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-6 shadow-lg space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-amber-500/10 text-amber-400 rounded-2xl border border-amber-500/20 shrink-0">
                  <Clock className="w-7 h-7" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-white flex items-center gap-2">
                    Jadwal Daily Cycle Count (DCC) Harian
                    <span className="px-2.5 py-0.5 bg-amber-500/10 text-amber-400 text-[10px] font-extrabold rounded-full border border-amber-500/20 font-mono">
                      Senin - Jumat
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Daftar pembagian SKU harian untuk audit rutin WMS. Sesuai ketentuan, <strong className="text-amber-400">SKU dengan stok 0 (kosong) disembunyikan secara otomatis</strong>.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {selectedScheduleDay !== 'ALL' && (
                  <button
                    onClick={() => loadDccScheduleBatch(selectedScheduleDay)}
                    className="px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl transition-all cursor-pointer flex items-center gap-2 shadow-lg shadow-amber-500/20"
                  >
                    <Zap className="w-4 h-4 fill-slate-950" />
                    Muat Jadwal {selectedScheduleDay} ke Session Count ({scheduleCountsByDay[selectedScheduleDay as DccDay]?.activeWithStock || 0} SKU)
                  </button>
                )}
                <button
                  onClick={() => setActiveMainTab('CYCLE_COUNT')}
                  className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center gap-2 border border-slate-700/60"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Kembali ke Session Count
                </button>
              </div>
            </div>

            {/* Day Navigation Filter Pills */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-slate-400 font-mono mr-1">Pilih Hari:</span>
              <button
                onClick={() => setSelectedScheduleDay('ALL')}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
                  selectedScheduleDay === 'ALL'
                    ? 'bg-indigo-600 text-white border-indigo-500 font-extrabold shadow-md'
                    : 'bg-[#161B25] text-slate-400 hover:text-white border-slate-800'
                }`}
              >
                <span>Semua Hari</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-950/40 text-indigo-300 font-bold">
                  {Object.values(scheduleCountsByDay).reduce((sum: number, c: { activeWithStock: number }) => sum + c.activeWithStock, 0)} SKU Active
                </span>
              </button>

              {currentDccSchedule.map(s => {
                const isToday = s.day === todayDayName;
                const activeCount = scheduleCountsByDay[s.day]?.activeWithStock || 0;
                const totalScheduled = scheduleCountsByDay[s.day]?.totalScheduled || 0;
                const isSelected = selectedScheduleDay === s.day;

                return (
                  <button
                    key={s.day}
                    onClick={() => setSelectedScheduleDay(s.day)}
                    className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 border ${
                      isSelected
                        ? 'bg-amber-500 text-slate-950 border-amber-400 font-black shadow-md shadow-amber-500/20'
                        : isToday
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20'
                        : 'bg-[#161B25] text-slate-400 hover:text-white border-slate-800'
                    }`}
                  >
                    <span>{s.day}</span>
                    {isToday && <span className={`text-[9px] font-black px-1.5 py-0.2 rounded ${isSelected ? 'bg-slate-950 text-amber-400' : 'bg-amber-400 text-slate-950'}`}>HARI INI</span>}
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                      isSelected ? 'bg-slate-950/30 text-slate-950' : 'bg-slate-900 text-amber-400'
                    }`}>
                      {activeCount} / {totalScheduled} SKU
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Notice info banner */}
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 text-xs text-amber-300/90 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-amber-400 shrink-0" />
                <span>
                  Hanya menampilkan SKU yang memiliki <strong className="text-white font-bold">Stok &gt; 0</strong> dalam sistem. SKU jadwal dengan stok 0 disembunyikan secara otomatis.
                </span>
              </div>
              <div className="text-[11px] font-mono text-slate-400 shrink-0">
                Menampilkan <strong className="text-white">{scheduledSkuItems.length}</strong> SKU Aktif
              </div>
            </div>
          </div>

          {/* Search and Action Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="relative w-full sm:w-80">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
              <input
                type="text"
                placeholder="Cari SKU ID, Nama Produk, Brand..."
                value={scheduleSearchQuery}
                onChange={(e) => setScheduleSearchQuery(e.target.value)}
                className="w-full bg-[#11141B] border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500 transition-colors"
              />
              {scheduleSearchQuery && (
                <button
                  onClick={() => setScheduleSearchQuery('')}
                  className="absolute right-2.5 top-2.5 text-slate-500 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {selectedScheduleDay !== 'ALL' && (
              <button
                onClick={() => loadDccScheduleBatch(selectedScheduleDay)}
                className="w-full sm:w-auto px-4 py-2 bg-amber-600 hover:bg-amber-500 text-slate-950 font-black text-xs rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 shadow-md"
              >
                <Zap className="w-3.5 h-3.5 fill-slate-950" />
                Muat Semua SKU {selectedScheduleDay} ke Session Count ({scheduledSkuItems.length} SKU)
              </button>
            )}
          </div>

          {/* Table of Scheduled SKUs */}
          <div className="bg-[#11141B] rounded-xl border border-slate-800/80 shadow-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#161B25] border-b border-slate-800 text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                    <th className="py-3 px-4 w-12 text-center">No</th>
                    <th className="py-3 px-4 w-24">Hari</th>
                    <th className="py-3 px-4 font-bold text-slate-200">SKU ID</th>
                    <th className="py-3 px-4">Nama Produk</th>
                    <th className="py-3 px-4">Lokasi Rak Stored</th>
                    <th className="py-3 px-4 text-right">Stok System</th>
                    <th className="py-3 px-4 text-center w-40">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs">
                  {scheduledSkuItems.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-slate-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Calendar className="w-8 h-8 text-slate-600" />
                          <p className="font-bold text-slate-400">Tidak ada SKU jadwal dengan stok &gt; 0 untuk kriteria ini.</p>
                          <p className="text-[11px] text-slate-500">SKU dengan stok 0 otomatis disembunyikan sesuai aturan sistem.</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    scheduledSkuItems.map((item, index) => {
                      const totalStock = getSkuTotalQty(item.skuId);
                      const matchingStock = stock.filter(s => s.skuId.toLowerCase() === item.skuId.toLowerCase());
                      const skuName = matchingStock[0]?.skuName || '-';
                      const isAlreadyInBatch = cycleCountBatch.some(b => b.skuId.toLowerCase() === item.skuId.toLowerCase());

                      return (
                        <tr key={`${item.day}_${item.skuId}_${index}`} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-4 text-center font-mono text-slate-500 text-[11px]">
                            {index + 1}
                          </td>
                          <td className="py-3 px-4 font-mono font-bold">
                            <span className={`px-2 py-0.5 rounded text-[10px] uppercase ${
                              item.day === 'Senin' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' :
                              item.day === 'Selasa' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                              item.day === 'Rabu' ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20' :
                              item.day === 'Kamis' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                              'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                            }`}>
                              {item.day}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-emerald-400">
                            {item.skuId}
                          </td>
                          <td className="py-3 px-4 font-medium text-slate-200">
                            {skuName}
                          </td>
                          <td className="py-3 px-4 text-slate-300 font-mono text-[11px]">
                            {matchingStock.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {matchingStock.map((loc, lIdx) => (
                                  <span key={lIdx} className="px-2 py-0.5 bg-slate-800 border border-slate-700/80 rounded text-[10px] text-slate-300">
                                    <strong className="text-white">{loc.location}</strong>: {loc.qty}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-slate-500">-</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-emerald-400 text-sm">
                            {formatNumber(totalStock)} <span className="text-xs font-normal text-slate-400">pcs</span>
                          </td>
                          <td className="py-3 px-4 text-center">
                            <button
                              onClick={() => handleAddSkuToCycleCountBatch(item.skuId)}
                              disabled={isAlreadyInBatch}
                              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 w-full ${
                                isAlreadyInBatch
                                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50'
                                  : 'bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/30'
                              }`}
                            >
                              {isAlreadyInBatch ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                  <span>Sudah di Batch</span>
                                </>
                              ) : (
                                <>
                                  <Plus className="w-3.5 h-3.5" />
                                  <span>+ Session Count</span>
                                </>
                              )}
                            </button>
                          </td>
                        </tr>
                      );
                    }))
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MAIN TAB 4: AUDIT TRAIL & HISTORY LOGS */}
      {/* ========================================================================= */}
      {activeMainTab === 'HISTORY' && (
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-6 shadow-md space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-bold text-slate-200">Riwayat Transaksi Stok Opname & Audit Log</h3>
            </div>
            
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
                <input
                  type="text"
                  placeholder="Cari riwayat opname..."
                  value={historySearchQuery}
                  onChange={(e) => setHistorySearchQuery(e.target.value)}
                  className="pl-8 pr-3 py-1 bg-[#161B25] border border-slate-800 text-[11px] text-slate-300 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none w-44"
                />
              </div>

              <button
                onClick={exportToExcel}
                disabled={audits.length === 0}
                className="flex items-center gap-1.5 px-3 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-40 disabled:pointer-events-none text-emerald-400 font-bold rounded-lg text-[11px] border border-emerald-500/20 transition-all cursor-pointer"
                id="export-audit-excel-btn"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Ekspor Log (.xlsx)
              </button>

              {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && audits.length > 0 && (
                <button
                  onClick={handleClearAllHistory}
                  className="flex items-center gap-1.5 px-3 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 font-bold rounded-lg text-[11px] border border-rose-500/20 transition-all cursor-pointer"
                  id="clear-audit-history-btn"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Kosongkan
                </button>
              )}
            </div>
          </div>

          {/* Audit list table */}
          <div className="overflow-x-auto rounded-xl border border-slate-800/80">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-[#161B25] text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-2.5 px-4">Waktu</th>
                  <th className="py-2.5 px-4">Barang (SKU / Nama)</th>
                  <th className="py-2.5 px-4">Rak</th>
                  <th className="py-2.5 px-4 text-right">Sistem</th>
                  <th className="py-2.5 px-4 text-right">Fisik</th>
                  <th className="py-2.5 px-4 text-right">Selisih</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Auditor</th>
                  <th className="py-2.5 px-4">Catatan</th>
                  {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && <th className="py-2.5 px-4 text-center w-12">Hapus</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {filteredAudits.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-slate-500">
                      Tidak ada riwayat stok opname yang terekam.
                    </td>
                  </tr>
                ) : (
                  filteredAudits.map((audit) => {
                    const skuTotal = getSkuTotalQty(audit.skuId);
                    const displaySystemQty = skuTotal > 0 ? skuTotal : (audit.systemQty || 0);
                    const displayDiff = audit.physicalQty - displaySystemQty;
                    const displayStatus = displayDiff === 0 ? 'MATCH' : displayDiff > 0 ? 'PLUS' : 'MINUS';

                    return (
                      <tr key={audit.id} className="hover:bg-slate-800/10 text-[11px]">
                        <td className="py-3 px-4 text-slate-500 whitespace-nowrap font-mono">
                          {new Date(audit.timestamp).toLocaleString('id-ID', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-extrabold text-white font-mono">{audit.skuId}</div>
                          <div className="text-[10px] text-slate-400 line-clamp-1 mt-0.5">{audit.skuName}</div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span className="font-bold text-slate-200 bg-slate-800 px-2 py-0.5 rounded border border-slate-700 text-[10px] font-mono">
                            {audit.location}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-slate-300">
                          {formatNumber(displaySystemQty)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-white">
                          {formatNumber(audit.physicalQty)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold">
                          {displayDiff === 0 ? (
                            <span className="text-slate-400">0</span>
                          ) : displayDiff > 0 ? (
                            <span className="text-amber-400">+{formatNumber(displayDiff)}</span>
                          ) : (
                            <span className="text-rose-400">{formatNumber(displayDiff)}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {displayStatus === 'MATCH' ? (
                            <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-[9px] font-extrabold rounded-full">
                              ✓ MATCH
                            </span>
                          ) : displayStatus === 'PLUS' ? (
                            <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[9px] font-extrabold rounded-full">
                              ▲ SURPLUS (PLUS)
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 bg-rose-500/10 border border-rose-500/25 text-rose-400 text-[9px] font-extrabold rounded-full">
                              ▼ DEFISIT (MINUS)
                            </span>
                          )}
                        </td>
                      <td className="py-3 px-4 text-slate-300 font-semibold whitespace-nowrap">
                        {audit.operator}
                      </td>
                      <td className="py-3 px-4 text-slate-400 max-w-xs truncate" title={audit.notes}>
                        {audit.notes}
                      </td>
                      {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && (
                        <td className="py-3 px-4 text-center">
                          <button
                            onClick={() => handleDeleteHistoryRow(audit.id)}
                            className="p-1 text-slate-500 hover:text-rose-400 rounded-md hover:bg-rose-500/10 transition-all cursor-pointer"
                            title="Hapus riwayat"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MAIN TAB 7: STOCK OPNAME PER LOKASI (HASIL EXCEL, NON-DESTRUCTIVE) */}
      {/* ========================================================================= */}
      {activeMainTab === 'OPNAME_LOKASI' && (
        <div className="pt-2">
          <StockOpnamePerLocation
            stock={stock}
            currentUser={currentUser}
          />
        </div>
      )}

      {/* Barcode scanner modal */}
      <BarcodeScannerModal
        isOpen={isScanModalOpen}
        onClose={() => setIsScanModalOpen(false)}
        onScanSuccess={(val) => setSearchQuery(val)}
        stock={stock}
        title="Scan Barcode / Lokasi Stock Opname"
      />
    </div>
  );
}
