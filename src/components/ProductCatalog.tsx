import React, { useState, useMemo, useRef } from 'react';
import { CatalogItem, StockItem } from '../types';
import { calculatePackQuantities, formatNumber, getProductPackSizes } from '../utils/calculations';
import { getProductBrand, getBarcodeForSku, BARCODE_MAP } from '../data/barcodeMap';
import { useLanguage } from '../i18n/LanguageContext';
import { getActiveBranch } from '../supabase';
import {
  extractCatalogRowsFromAoA,
  isPlaceholderSkuName,
  normalizeSkuKey,
  parseCatalogSheetRows,
  planCrossBranchCatalogMerge,
  type ParsedCatalogSheetRow
} from '../utils/catalogSync';
import {
  computeBundleAvailablePacks,
  isBundleCatalogItem,
  normalizeBundleComponents
} from '../utils/bundleExplode';
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
  ArrowLeftRight,
  Building2,
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
  onBatchDeleteCatalogItems?: (skuIds: string[]) => Promise<{ success: boolean; deletedCount: number; errorMessage?: string }>;
  onBatchImportCatalog: (
    items: Omit<CatalogItem, 'id'>[],
    mode: 'merge' | 'replace'
  ) => Promise<{ success: boolean; catalogSavedCount: number; stockSyncedCount: number; stockSyncError?: string }>;
  onSyncStockToCatalog: () => Promise<{
    addedCount: number;
    updatedCatalogCount: number;
    syncedStockCount: number;
    stockSyncError?: string;
  }>;
  onFetchAccessibleBranches?: () => Promise<Array<{ id: string; name: string }>>;
  onFetchBranchCatalog?: (branchId: string) => Promise<CatalogItem[]>;
}

export default function ProductCatalog({
  catalog,
  stock,
  userRole,
  onAddCatalogItem,
  onUpdateCatalogItem,
  onDeleteCatalogItem,
  onBatchDeleteCatalogItems,
  onBatchImportCatalog,
  onSyncStockToCatalog,
  onFetchAccessibleBranches,
  onFetchBranchCatalog
}: ProductCatalogProps) {
  const { t, language } = useLanguage();
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'ALL' | 'IN_STOCK' | 'NO_STOCK' | 'PLACEHOLDER' | 'BUNDLES'>('ALL');

  // Modal states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'add' | 'edit'>('add');
  const [editingSkuId, setEditingSkuId] = useState('');

  // Master Bundling Modal states
  const [isBundleModalOpen, setIsBundleModalOpen] = useState(false);
  const [bundleModalMode, setBundleModalMode] = useState<'add' | 'edit'>('add');
  const [bundleEditingSkuId, setBundleEditingSkuId] = useState('');
  const [bundleSkuIdInput, setBundleSkuIdInput] = useState('');
  const [bundleSkuNameInput, setBundleSkuNameInput] = useState('');
  const [bundleBrandInput, setBundleBrandInput] = useState('');
  const [bundleBarcodeInput, setBundleBarcodeInput] = useState('');
  const [bundleRows, setBundleRows] = useState<Array<{ skuId: string; qty: string }>>([
    { skuId: '', qty: '1' },
    { skuId: '', qty: '1' }
  ]);
  const [bundleFormError, setBundleFormError] = useState('');
  const [isSavingBundle, setIsSavingBundle] = useState(false);

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

  // Cross-branch sync modal states
  const [isCrossBranchModalOpen, setIsCrossBranchModalOpen] = useState(false);
  const [accessibleBranches, setAccessibleBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedSourceBranch, setSelectedSourceBranch] = useState('');
  const [sourceBranchCatalog, setSourceBranchCatalog] = useState<CatalogItem[]>([]);
  const [isLoadingCrossBranch, setIsLoadingCrossBranch] = useState(false);
  const [crossBranchError, setCrossBranchError] = useState('');
  const [crossBranchMode, setCrossBranchMode] = useState<'fill_placeholders' | 'overwrite_all'>('fill_placeholders');
  const [crossBranchIncludeNew, setCrossBranchIncludeNew] = useState(false);
  const [isApplyingCrossBranch, setIsApplyingCrossBranch] = useState(false);

  // File parse error / preview state
  const [parsedImportRows, setParsedImportRows] = useState<ParsedCatalogSheetRow[]>([]);
  const [selectedSkuKeys, setSelectedSkuKeys] = useState<string[]>([]);
  const [isDeletingCatalog, setIsDeletingCatalog] = useState(false);

  const [catalogConfirmModal, setCatalogConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    warningType?: 'danger' | 'warning' | 'info' | 'success';
    confirmText?: string;
    showCancel?: boolean;
    onConfirm?: () => void;
  } | null>(null);

  const isAdmin =
    userRole !== 'Packer' &&
    userRole !== 'Picker' &&
    userRole !== 'Viewer' &&
    userRole !== 'Shipping';

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

  // Bundle availability map (Bundle SKU -> max available packs based on component stock)
  const bundleAvailabilityMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof computeBundleAvailablePacks>>();
    catalog.forEach(item => {
      if (!isBundleCatalogItem(item)) return;
      const key = normalizeSkuKey(item.skuId);
      if (key) {
        map.set(key, computeBundleAvailablePacks(item, stock, [], undefined, catalog));
      }
    });
    return map;
  }, [catalog, stock]);

  // Non-bundle SKU options for component picker autocomplete
  const componentCatalogOptions = useMemo(() => {
    const map = new Map<string, { skuId: string; skuName: string; stockQty: number }>();
    catalog.forEach(item => {
      if (isBundleCatalogItem(item)) return;
      const key = normalizeSkuKey(item.skuId);
      if (!key) return;
      map.set(key, {
        skuId: key,
        skuName: item.skuName || key,
        stockQty: stockSummaryMap.get(key)?.totalQtyPcs || 0
      });
    });
    stock.forEach(s => {
      const key = normalizeSkuKey(s.skuId);
      if (!key || map.has(key)) return;
      map.set(key, {
        skuId: key,
        skuName: s.skuName || key,
        stockQty: stockSummaryMap.get(key)?.totalQtyPcs || 0
      });
    });
    return Array.from(map.values()).sort((a, b) => a.skuId.localeCompare(b.skuId));
  }, [catalog, stock, stockSummaryMap]);

  // Filtered Catalog
  const filteredCatalog = useMemo(() => {
    return catalog.filter(item => {
      const term = searchTerm.toLowerCase();
      const normSku = (item.skuId || '').toUpperCase();
      const itemBrand = getProductBrand(item.skuId, item.skuName, item.brand);
      const itemBarcode = getBarcodeForSku(item.skuId, item.barcode);
      const isBundle = isBundleCatalogItem(item);
      const componentMatch = isBundle && (item.bundleComponents || []).some(c =>
        c.skuId.toLowerCase().includes(term) || (c.skuName || '').toLowerCase().includes(term)
      );

      const matchesSearch = (
        normSku.toLowerCase().includes(term) ||
        (item.skuName || '').toLowerCase().includes(term) ||
        (itemBrand || '').toLowerCase().includes(term) ||
        (itemBarcode || '').toLowerCase().includes(term) ||
        componentMatch
      );

      if (!matchesSearch) return false;

      if (activeTab === 'BUNDLES') return isBundle;

      const stockData = stockSummaryMap.get(normSku);
      const bundleAvail = isBundle ? bundleAvailabilityMap.get(normSku) : undefined;
      const hasStock = isBundle
        ? Boolean(bundleAvail && bundleAvail.maxPacks > 0)
        : Boolean(stockData && stockData.totalQtyPcs > 0);

      if (activeTab === 'IN_STOCK') return hasStock;
      if (activeTab === 'NO_STOCK') return !hasStock;
      if (activeTab === 'PLACEHOLDER') return !isBundle && isPlaceholderSkuName(item.skuId, item.skuName);

      return true;
    });
  }, [catalog, searchTerm, activeTab, stockSummaryMap, bundleAvailabilityMap]);

  const displayedCatalog = filteredCatalog;

  const activeSelectedSkuSet = useMemo(() => {
    const validKeys = new Set(catalog.map((item) => normalizeSkuKey(item.skuId)));
    return new Set(selectedSkuKeys.filter((key) => validKeys.has(key)));
  }, [catalog, selectedSkuKeys]);

  const visibleSelectedCount = useMemo(
    () =>
      displayedCatalog.filter((item) => activeSelectedSkuSet.has(normalizeSkuKey(item.skuId))).length,
    [displayedCatalog, activeSelectedSkuSet]
  );

  const allVisibleSelected =
    displayedCatalog.length > 0 && visibleSelectedCount === displayedCatalog.length;

  const toggleSelectSku = (skuId: string) => {
    const key = normalizeSkuKey(skuId);
    if (!key) return;
    setSelectedSkuKeys((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    );
  };

  const toggleSelectAllVisible = () => {
    const visibleKeys = displayedCatalog.map((item) => normalizeSkuKey(item.skuId)).filter(Boolean);
    if (visibleKeys.length === 0) return;
    const visibleSet = new Set(visibleKeys);
    setSelectedSkuKeys((prev) => {
      const prevSet = new Set(prev);
      const everyVisibleAlreadySelected = visibleKeys.every((key) => prevSet.has(key));
      if (everyVisibleAlreadySelected) {
        return prev.filter((key) => !visibleSet.has(key));
      }
      const next = new Set(prev);
      visibleKeys.forEach((key) => next.add(key));
      return Array.from(next);
    });
  };

  // Catalog Statistics
  const stats = useMemo(() => {
    let skusWithStock = 0;
    let totalStockVolumePcs = 0;
    let placeholderCount = 0;
    let bundleCount = 0;

    catalog.forEach(item => {
      const normSku = item.skuId.toUpperCase();
      const isBundle = isBundleCatalogItem(item);
      if (isBundle) {
        bundleCount += 1;
        const avail = bundleAvailabilityMap.get(normSku);
        if (avail && avail.maxPacks > 0) {
          skusWithStock += 1;
        }
        return;
      }
      if (isPlaceholderSkuName(item.skuId, item.skuName)) {
        placeholderCount += 1;
      }
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
      unmappedStockCount: unmappedStockSkus.length,
      placeholderCount,
      bundleCount
    };
  }, [catalog, stockSummaryMap, bundleAvailabilityMap, unmappedStockSkus]);

  const crossBranchPlan = useMemo(() => {
    if (!selectedSourceBranch || sourceBranchCatalog.length === 0) return null;
    return planCrossBranchCatalogMerge(
      catalog,
      sourceBranchCatalog,
      {
        mode: crossBranchMode,
        includeNewSkus: crossBranchIncludeNew
      },
      getProductPackSizes,
      getProductBrand,
      getBarcodeForSku
    );
  }, [catalog, sourceBranchCatalog, selectedSourceBranch, crossBranchMode, crossBranchIncludeNew]);

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

  const handleOpenAddBundleModal = () => {
    if (!isAdmin) return;
    setBundleModalMode('add');
    setBundleEditingSkuId('');
    setBundleSkuIdInput('');
    setBundleSkuNameInput('');
    setBundleBrandInput('');
    setBundleBarcodeInput('');
    setBundleRows([
      { skuId: '', qty: '1' },
      { skuId: '', qty: '1' }
    ]);
    setBundleFormError('');
    setIsBundleModalOpen(true);
  };

  const handleOpenEditBundleModal = (item: CatalogItem) => {
    if (!isAdmin) return;
    setBundleModalMode('edit');
    setBundleEditingSkuId(item.skuId);
    setBundleSkuIdInput(item.skuId);
    setBundleSkuNameInput(item.skuName);
    setBundleBrandInput(getProductBrand(item.skuId, item.skuName, item.brand));
    setBundleBarcodeInput(item.barcode && item.barcode !== '-' ? item.barcode : '');
    setBundleRows(
      (item.bundleComponents || []).length > 0
        ? (item.bundleComponents || []).map(c => ({ skuId: c.skuId, qty: String(c.qty) }))
        : [{ skuId: '', qty: '1' }]
    );
    setBundleFormError('');
    setIsBundleModalOpen(true);
  };

  const handleBundleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBundleFormError('');
    setSuccessMsg('');

    const trimmedSkuId = bundleSkuIdInput.trim().toUpperCase();
    const trimmedSkuName = bundleSkuNameInput.trim();
    const trimmedBrand = getProductBrand(trimmedSkuId, trimmedSkuName, bundleBrandInput.trim());
    const rawBarcode = bundleBarcodeInput.trim();
    const trimmedBarcode = rawBarcode && rawBarcode !== '-' ? rawBarcode : '-';

    if (!trimmedSkuId) {
      setBundleFormError('Kode SKU Bundling tidak boleh kosong.');
      return;
    }
    if (!trimmedSkuName) {
      setBundleFormError('Nama Paket Bundling tidak boleh kosong.');
      return;
    }

    const validation = normalizeBundleComponents(
      bundleRows.map(r => ({
        skuId: r.skuId,
        qty: parseInt(r.qty, 10)
      })),
      trimmedSkuId,
      catalog
    );

    if (!validation.ok) {
      setBundleFormError(validation.error || 'Komponen bundling tidak valid.');
      return;
    }

    setIsSavingBundle(true);
    try {
      if (bundleModalMode === 'add') {
        const exists = catalog.some(item => normalizeSkuKey(item.skuId) === trimmedSkuId);
        if (exists) {
          setBundleFormError(`SKU "${trimmedSkuId}" sudah terdaftar dalam katalog.`);
          return;
        }
        const ok = await onAddCatalogItem({
          skuId: trimmedSkuId,
          skuName: trimmedSkuName,
          brand: trimmedBrand,
          barcode: trimmedBarcode,
          qtyCtnSize: 1,
          qtyInnerSize: 1,
          isBundle: true,
          bundleComponents: validation.components
        });
        if (ok) {
          setSuccessMsg(`Master Bundling "${trimmedSkuId}" (${validation.components.length} SKU komponen) berhasil disimpan.`);
          setIsBundleModalOpen(false);
        } else {
          setBundleFormError('Gagal menyimpan Master Bundling. Silakan coba lagi.');
        }
      } else {
        const ok = await onUpdateCatalogItem(bundleEditingSkuId, {
          skuName: trimmedSkuName,
          brand: trimmedBrand,
          barcode: trimmedBarcode,
          qtyCtnSize: 1,
          qtyInnerSize: 1,
          isBundle: true,
          bundleComponents: validation.components
        });
        if (ok) {
          setSuccessMsg(`Master Bundling "${trimmedSkuId}" berhasil diperbarui (${validation.components.length} SKU komponen).`);
          setIsBundleModalOpen(false);
        } else {
          setBundleFormError('Gagal memperbarui Master Bundling. Silakan coba lagi.');
        }
      }
    } finally {
      setIsSavingBundle(false);
    }
  };

  const handleOpenEditModal = (item: CatalogItem) => {
    if (!isAdmin) return;
    if (isBundleCatalogItem(item)) {
      handleOpenEditBundleModal(item);
      return;
    }
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

  const executeCatalogDelete = async (skuIds: string[], successMessage: string) => {
    if (!isAdmin || skuIds.length === 0 || isDeletingCatalog) return;
    setCatalogConfirmModal(null);
    setIsDeletingCatalog(true);
    setSuccessMsg('');
    try {
      let ok = false;
      let errMsg = '';
      if (onBatchDeleteCatalogItems) {
        const res = await onBatchDeleteCatalogItems(skuIds);
        ok = res.success;
        errMsg = res.errorMessage || '';
      } else {
        ok = true;
        for (const skuId of skuIds) {
          const deleted = await onDeleteCatalogItem(skuId);
          if (!deleted) {
            ok = false;
            errMsg = `Gagal menghapus SKU "${skuId}" dari katalog.`;
            break;
          }
        }
      }

      if (ok) {
        const removed = new Set(skuIds.map((id) => normalizeSkuKey(id)));
        setSelectedSkuKeys((prev) => prev.filter((key) => !removed.has(key)));
        setSuccessMsg(successMessage);
      } else {
        setCatalogConfirmModal({
          isOpen: true,
          title: 'Gagal Menghapus Data Katalog',
          message: errMsg || 'Terjadi kesalahan saat menghapus item katalog dari server.',
          warningType: 'danger',
          confirmText: 'Tutup',
          showCancel: false,
          onConfirm: () => setCatalogConfirmModal(null),
        });
      }
    } finally {
      setIsDeletingCatalog(false);
    }
  };

  const handleDeleteItem = (item: CatalogItem) => {
    if (!isAdmin || isDeletingCatalog) return;
    setCatalogConfirmModal({
      isOpen: true,
      title: `Hapus SKU "${item.skuId}"?`,
      message: `Apakah Anda yakin ingin menghapus SKU "${item.skuId}" (${item.skuName}) dari master katalog?\n\nTindakan ini tidak akan menghapus stok fisik atau riwayat order yang ada di sistem.`,
      warningType: 'danger',
      confirmText: 'Ya, Hapus SKU',
      showCancel: true,
      onConfirm: () => {
        void executeCatalogDelete(
          [item.skuId],
          `SKU "${item.skuId}" berhasil dihapus dari katalog.`
        );
      },
    });
  };

  const handleDeleteSelected = () => {
    const targetKeys = Array.from(activeSelectedSkuSet);
    if (!isAdmin || targetKeys.length === 0 || isDeletingCatalog) return;
    setCatalogConfirmModal({
      isOpen: true,
      title: `Hapus ${formatNumber(targetKeys.length)} SKU Terpilih?`,
      message: `Anda akan menghapus ${formatNumber(targetKeys.length)} item dari master katalog produk.\n\nStok fisik gudang dan riwayat transaksi tidak akan terhapus.`,
      warningType: 'danger',
      confirmText: `Ya, Hapus Terpilih (${targetKeys.length})`,
      showCancel: true,
      onConfirm: () => {
        void executeCatalogDelete(
          targetKeys,
          `${formatNumber(targetKeys.length)} SKU berhasil dihapus dari katalog.`
        );
      },
    });
  };

  const handleDeleteAllCatalog = () => {
    if (!isAdmin || catalog.length === 0 || isDeletingCatalog) return;
    const allSkuIds = catalog.map((item) => item.skuId).filter(Boolean);
    setCatalogConfirmModal({
      isOpen: true,
      title: `Hapus Seluruh Data Katalog (${formatNumber(allSkuIds.length)} SKU)?`,
      message: `PERINGATAN: Anda akan MENGOSONGKAN seluruh ${formatNumber(allSkuIds.length)} item master katalog produk di cabang ini.\n\nStok fisik di gudang dan riwayat order TIDAK akan terhapus, dan katalog dapat diimpor ulang kapan saja.`,
      warningType: 'danger',
      confirmText: `Ya, Hapus Semua (${allSkuIds.length})`,
      showCancel: true,
      onConfirm: () => {
        void executeCatalogDelete(
          allSkuIds,
          `Seluruh ${formatNumber(allSkuIds.length)} data katalog berhasil dihapus.`
        );
      },
    });
  };

  // Bidirectional Sync between Stock & Catalog
  const handleSyncStock = async () => {
    setIsSyncingStock(true);
    setSuccessMsg('');
    const res = await onSyncStockToCatalog();
    setIsSyncingStock(false);
    const changes: string[] = [];
    if (res.addedCount > 0) changes.push(`${res.addedCount} SKU baru ditambahkan ke katalog`);
    if (res.updatedCatalogCount > 0) changes.push(`${res.updatedCatalogCount} nama default katalog diperbarui dari stok`);
    if (res.syncedStockCount > 0) changes.push(`${res.syncedStockCount} baris stok disinkronkan ke nama & ukuran katalog`);
    if (res.stockSyncError) {
      setCatalogConfirmModal({
        isOpen: true,
        title: 'Sinkronisasi Stok Sebagian Gagal',
        message: `${changes.length ? `${changes.join(', ')}.\n\n` : ''}${res.stockSyncError}`,
        warningType: 'warning',
        confirmText: 'OK',
        showCancel: false,
        onConfirm: () => setCatalogConfirmModal(null)
      });
      return;
    }
    if (changes.length > 0) {
      setSuccessMsg(`Sinkronisasi selesai: ${changes.join(', ')}.`);
    } else {
      setSuccessMsg('Katalog dan stok gudang sudah selaras.');
    }
  };

  const loadSourceBranchCatalog = async (branchId: string) => {
    if (!branchId || !onFetchBranchCatalog) return;
    setSelectedSourceBranch(branchId);
    setCrossBranchError('');
    setIsLoadingCrossBranch(true);
    try {
      const remoteCatalog = await onFetchBranchCatalog(branchId);
      setSourceBranchCatalog(remoteCatalog);
      if (remoteCatalog.length === 0) {
        setCrossBranchError(`Cabang "${branchId}" belum memiliki data di Katalog Produk.`);
      }
    } catch (err: any) {
      setSourceBranchCatalog([]);
      setCrossBranchError(err?.message || `Gagal membaca katalog cabang ${branchId}.`);
    } finally {
      setIsLoadingCrossBranch(false);
    }
  };

  const handleOpenCrossBranchModal = async () => {
    if (!isAdmin || !onFetchAccessibleBranches || !onFetchBranchCatalog) return;
    setIsCrossBranchModalOpen(true);
    setCrossBranchError('');
    setSourceBranchCatalog([]);
    setSelectedSourceBranch('');
    setCrossBranchMode('fill_placeholders');
    setCrossBranchIncludeNew(false);
    setIsLoadingCrossBranch(true);
    try {
      const activeBranch = getActiveBranch();
      const branches = await onFetchAccessibleBranches();
      const otherBranches = branches.filter(b => b.id !== activeBranch);
      setAccessibleBranches(otherBranches);
      if (otherBranches.length > 0) {
        await loadSourceBranchCatalog(otherBranches[0].id);
      } else {
        setIsLoadingCrossBranch(false);
      }
    } catch (err: any) {
      setCrossBranchError(err?.message || 'Gagal memuat daftar cabang.');
      setIsLoadingCrossBranch(false);
    }
  };

  const handleApplyCrossBranchSync = async () => {
    if (!crossBranchPlan || crossBranchPlan.itemsToImport.length === 0) return;
    setIsApplyingCrossBranch(true);
    const result = await onBatchImportCatalog(crossBranchPlan.itemsToImport, 'merge');
    setIsApplyingCrossBranch(false);
    if (result.success) {
      setIsCrossBranchModalOpen(false);
      setSuccessMsg(
        `Berhasil menyalin ${crossBranchPlan.itemsToImport.length} nama barang dari cabang ${selectedSourceBranch} (${result.stockSyncedCount} baris stok ikut tersinkron).`
      );
      if (result.stockSyncError) {
        setCatalogConfirmModal({
          isOpen: true,
          title: 'Katalog Tersinkron, Stok Perlu Sync Ulang',
          message: `Katalog berhasil diperbarui dari cabang ${selectedSourceBranch}, tetapi sinkronisasi ke stok gagal:\n${result.stockSyncError}`,
          warningType: 'warning',
          confirmText: 'OK',
          showCancel: false,
          onConfirm: () => setCatalogConfirmModal(null)
        });
      }
    } else {
      setCrossBranchError('Gagal menyimpan hasil sinkronisasi lintas cabang. Coba lagi.');
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
  const parseRawSheetData = (rawRows: Record<string, unknown>[]) => {
    const parsed = parseCatalogSheetRows(
      rawRows,
      catalog,
      getProductPackSizes,
      getProductBrand,
      getBarcodeForSku
    );
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
        const rawAoA = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: '' });
        const normalizedRows = extractCatalogRowsFromAoA(rawAoA);
        parseRawSheetData(normalizedRows);
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

    const lines = importText.split(/\r?\n/);
    const rawAoA: string[][] = [];

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const parts = trimmed.includes('\t')
        ? trimmed.split('\t')
        : trimmed.includes(';')
          ? trimmed.split(';')
          : trimmed.split(',');
      rawAoA.push(parts.map(cell => cell.trim()));
    });

    const normalizedRows = extractCatalogRowsFromAoA(rawAoA);
    parseRawSheetData(normalizedRows);
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

    const result = await onBatchImportCatalog(itemsToImport, importMode);
    setIsProcessingImport(false);

    if (result.success) {
      const stockSummary = result.stockSyncedCount > 0
        ? ` ${result.stockSyncedCount} baris stok ikut tersinkron.`
        : ' Brand, Barcode & stok terhubung otomatis.';
      setSuccessMsg(
        `Berhasil meng-import ${result.catalogSavedCount} SKU ke katalog master barang!${stockSummary}`
      );
      setIsImportModalOpen(false);
      setParsedImportRows([]);
      setImportText('');

      if (result.stockSyncError) {
        setCatalogConfirmModal({
          isOpen: true,
          title: 'Import Katalog Tersimpan, Sinkron Stok Perlu Dicek',
          message: `✓ ${result.catalogSavedCount} SKU tersimpan ke katalog master barang, namun sinkronisasi ke tabel stok mengalami kendala:\n${result.stockSyncError}`,
          warningType: 'warning',
          confirmText: 'OK',
          showCancel: false,
          onConfirm: () => setCatalogConfirmModal(null)
        });
      } else {
        setCatalogConfirmModal({
          isOpen: true,
          title: 'Import Katalog Berhasil!',
          message: `✓ Berhasil meng-import ${result.catalogSavedCount} SKU ke katalog master barang!\n${stockSummary.trim()}`,
          warningType: 'success',
          confirmText: 'OK, SELESAI',
          showCancel: false,
          onConfirm: () => setCatalogConfirmModal(null)
        });
      }
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
                {t('catalog.title')}
              </h1>
              <span className="text-[10px] font-mono bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <Link className="w-3 h-3" /> System Connected
              </span>
            </div>
            <p className="text-xs text-slate-400 max-w-2xl">
              {t('catalog.subtitle')}
            </p>
          </div>

          {/* Top Action Buttons */}
          <div className="flex items-center flex-wrap gap-2.5 shrink-0 self-start lg:self-center">
            {isAdmin && (
              <button
                onClick={handleSyncStock}
                disabled={isSyncingStock}
                className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/40 text-amber-300 disabled:opacity-50 active:scale-95 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md"
                title="Sinkronkan 2 arah antara Katalog Produk dan Stok Gudang (lengkapi SKU & samakan nama asli)"
              >
                <ArrowLeftRight className={`w-4 h-4 text-amber-400 ${isSyncingStock ? 'animate-pulse' : ''}`} />
                <span>{isSyncingStock ? 'Menyinkronkan...' : 'Sync Katalog ↔ Stok'}</span>
              </button>
            )}

            {isAdmin && onFetchAccessibleBranches && onFetchBranchCatalog && (
              <button
                onClick={handleOpenCrossBranchModal}
                className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/40 text-sky-300 active:scale-95 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md"
                title="Salin nama barang asli dari katalog cabang lain (misal dari CENTER ke JKT)"
              >
                <Building2 className="w-4 h-4 text-sky-400" />
                <span>Sync Cabang Lain</span>
              </button>
            )}

            {/* Export Excel Button */}
            <button
              onClick={handleExportCatalog}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 active:scale-95 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md"
              title="Export Katalog ke file Excel (.xlsx) beserta Brand & Barcode"
            >
              <Download className="w-4 h-4 text-emerald-400" />
              <span>{t('catalog.exportExcel')}</span>
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
                title="Import data katalog dari file Excel / teks (termasuk export Mabang ERP)"
              >
                <Upload className="w-4 h-4 text-indigo-400" />
                <span>{t('catalog.importExcel')}</span>
              </button>
            )}

            {/* Delete All Catalog Button */}
            {isAdmin && catalog.length > 0 && (
              <button
                id="btn-delete-all-catalog"
                onClick={handleDeleteAllCatalog}
                disabled={isDeletingCatalog}
                className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-rose-600/15 hover:bg-rose-600/25 border border-rose-500/40 text-rose-300 disabled:opacity-50 active:scale-95 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md"
                title={language === 'en' ? 'Clear all catalog data' : 'Hapus seluruh data katalog produk'}
              >
                <Trash2 className="w-4 h-4 text-rose-400" />
                <span>{isDeletingCatalog ? (language === 'en' ? 'Deleting...' : 'Menghapus...') : (language === 'en' ? 'Delete Catalog' : 'Hapus Katalog')}</span>
              </button>
            )}

            {/* Add New Bundle Button */}
            {isAdmin && (
              <button
                id="btn-add-bundle-item"
                onClick={handleOpenAddBundleModal}
                className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/40 text-violet-200 active:scale-95 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md"
                title="Buat SKU Bundling (paket virtual berisi beberapa SKU komponen)"
              >
                <Layers className="w-4 h-4 text-violet-400" />
                <span>{language === 'en' ? 'Add Bundle' : 'Tambah Bundling'}</span>
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
                <span>{t('catalog.addSku')}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Connected Stock Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[#11141B] border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between space-y-2 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider font-mono">{t('catalog.totalSkus')}</span>
            <Database className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <div className="text-xl font-black text-white font-mono">{formatNumber(stats.totalCatalogSkus)}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{t('catalog.registeredMaster')}</div>
          </div>
        </div>

        <div className="bg-[#11141B] border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between space-y-2 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider font-mono">{language === 'en' ? 'Linked to Stock' : 'Terhubung Stok'}</span>
            <Link className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <div className="text-xl font-black text-emerald-400 font-mono">
              {formatNumber(stats.skusWithStock)} <span className="text-xs text-slate-500 font-normal">/ {stats.totalCatalogSkus} SKU</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">{language === 'en' ? 'Active in warehouse stock' : 'Aktif di stok gudang'}</div>
          </div>
        </div>

        <div className="bg-[#11141B] border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between space-y-2 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider font-mono">{language === 'en' ? 'Total Stock Volume' : 'Total Volume Stok'}</span>
            <Boxes className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <div className="text-xl font-black text-cyan-400 font-mono">{formatNumber(stats.totalStockVolumePcs)} <span className="text-xs text-slate-500 font-normal">Pcs</span></div>
            <div className="text-[10px] text-slate-500 mt-0.5">{language === 'en' ? 'Total linked pcs' : 'Total pcs terhubung'}</div>
          </div>
        </div>

        <div className="bg-[#11141B] border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between space-y-2 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider font-mono">{language === 'en' ? 'Uncatalogued Stock' : 'Stok Belum Di Katalog'}</span>
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
                <span>{language === 'en' ? 'Register automatically' : 'Daftarkan otomatis'}</span>
              </button>
            ) : (
              <div className="text-[10px] text-slate-500 mt-0.5">{language === 'en' ? 'All stock registered' : 'Semua stok terdaftar'}</div>
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

      {/* Placeholder Name Alert Banner */}
      {stats.placeholderCount > 0 && (
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3.5 text-xs text-amber-200">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <div className="font-bold text-amber-300">
                {formatNumber(stats.placeholderCount)} SKU masih menggunakan nama default sistem (contoh: &quot;&lt;SKU&gt; Product&quot;)
              </div>
              <div className="text-[11px] text-amber-200/80 mt-0.5">
                Lengkapi nama asli lewat <span className="font-bold">Sync Cabang Lain</span> (salin dari cabang pusat), <span className="font-bold">Import Excel</span> (file Mabang ERP / template tanpa mengubah Qty CTN &amp; Inner), atau <span className="font-bold">Sync Katalog ↔ Stok</span>.
              </div>
            </div>
          </div>
          <div className="flex items-center flex-wrap gap-2 shrink-0">
            <button
              onClick={() => setActiveTab('PLACEHOLDER')}
              className="px-2.5 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 font-bold rounded-lg text-[11px] transition-all cursor-pointer"
            >
              Lihat {formatNumber(stats.placeholderCount)} SKU
            </button>
            {isAdmin && onFetchAccessibleBranches && onFetchBranchCatalog && (
              <button
                onClick={handleOpenCrossBranchModal}
                className="px-2.5 py-1.5 bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-sky-200 font-bold rounded-lg text-[11px] transition-all cursor-pointer"
              >
                Sync Cabang Lain
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => {
                  setParsedImportRows([]);
                  setImportText('');
                  setIsImportModalOpen(true);
                }}
                className="px-2.5 py-1.5 bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/40 text-indigo-200 font-bold rounded-lg text-[11px] transition-all cursor-pointer"
              >
                Import Excel
              </button>
            )}
          </div>
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
              placeholder={t('catalog.searchPlaceholder')}
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
              {t('catalog.tabAll')} ({catalog.length})
            </button>
            <button
              onClick={() => setActiveTab('IN_STOCK')}
              className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
                activeTab === 'IN_STOCK'
                  ? 'bg-emerald-500 text-slate-950 font-black shadow-md shadow-emerald-500/20'
                  : 'bg-[#161B25] text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('catalog.tabInStock')} ({stats.skusWithStock})
            </button>
            <button
              onClick={() => setActiveTab('NO_STOCK')}
              className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
                activeTab === 'NO_STOCK'
                  ? 'bg-slate-700 text-slate-100 font-bold shadow-md'
                  : 'bg-[#161B25] text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('catalog.tabNoStock')} ({catalog.length - stats.skusWithStock})
            </button>
            <button
              onClick={() => setActiveTab('BUNDLES')}
              className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === 'BUNDLES'
                  ? 'bg-violet-500 text-white font-black shadow-md shadow-violet-500/20'
                  : 'bg-[#161B25] text-violet-300 hover:text-violet-200 border border-violet-500/25'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>{language === 'en' ? 'Bundles' : 'Master Bundling'} ({stats.bundleCount})</span>
            </button>
            {(stats.placeholderCount > 0 || activeTab === 'PLACEHOLDER') && (
              <button
                onClick={() => setActiveTab('PLACEHOLDER')}
                className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
                  activeTab === 'PLACEHOLDER'
                    ? 'bg-amber-500 text-slate-950 font-black shadow-md shadow-amber-500/20'
                    : 'bg-[#161B25] text-amber-400 hover:text-amber-300 border border-amber-500/25'
                }`}
              >
                Nama Default ({stats.placeholderCount})
              </button>
            )}
          </div>
        </div>

        {/* Selected Rows Action Bar */}
        {isAdmin && activeSelectedSkuSet.size > 0 && (
          <div className="px-4 py-2.5 bg-rose-950/30 border-b border-rose-500/30 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-rose-200 font-semibold">
              <Trash2 className="w-4 h-4 text-rose-400" />
              <span>
                {language === 'en'
                  ? `${formatNumber(activeSelectedSkuSet.size)} catalog item(s) selected`
                  : `${formatNumber(activeSelectedSkuSet.size)} item katalog dipilih`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedSkuKeys([])}
                disabled={isDeletingCatalog}
                className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-[11px] font-semibold text-slate-300 cursor-pointer disabled:opacity-50"
              >
                {language === 'en' ? 'Clear Selection' : 'Batal Pilih'}
              </button>
              <button
                type="button"
                onClick={handleDeleteSelected}
                disabled={isDeletingCatalog}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-[11px] font-extrabold text-white cursor-pointer shadow-md shadow-rose-600/20 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>
                  {isDeletingCatalog
                    ? (language === 'en' ? 'Deleting...' : 'Menghapus...')
                    : (language === 'en'
                        ? `Delete Selected (${activeSelectedSkuSet.size})`
                        : `Hapus Terpilih (${activeSelectedSkuSet.size})`)}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Catalog Table */}
        <div 
          className="overflow-x-auto max-h-[680px] overflow-y-auto relative scroll-smooth border-b border-slate-850"
        >
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-20 bg-[#11141B]">
              <tr className="bg-slate-950/80 backdrop-blur-md text-[10px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-850 shadow-sm">
                {isAdmin && (
                  <th className="py-3 px-3 w-10 text-center">
                    <input
                      type="checkbox"
                      aria-label="Pilih semua SKU yang tampil"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisible}
                      className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-900 text-rose-500 focus:ring-rose-500 cursor-pointer accent-rose-500"
                    />
                  </th>
                )}
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
                  <td colSpan={isAdmin ? 10 : 8} className="py-12 text-center text-slate-500">
                    <Package className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                    Tidak ada SKU yang cocok dengan pencarian / filter Anda.
                  </td>
                </tr>
              ) : (
                <>
                  {displayedCatalog.map((item) => {
                  const normSku = normalizeSkuKey(item.skuId);
                  const isRowSelected = activeSelectedSkuSet.has(normSku);
                  const isBundle = isBundleCatalogItem(item);
                  const bundleAvail = isBundle ? bundleAvailabilityMap.get(normSku) : undefined;
                  const itemBrand = getProductBrand(item.skuId, item.skuName, item.brand);
                  const itemBarcode = getBarcodeForSku(item.skuId, item.barcode);
                  const stockData = stockSummaryMap.get(normSku);
                  const totalQtyPcs = stockData ? stockData.totalQtyPcs : 0;
                  const locationsList = stockData ? stockData.locationsList : [];
                  const splits = calculatePackQuantities(totalQtyPcs, item.qtyCtnSize, item.qtyInnerSize);

                  return (
                    <tr key={item.skuId} className={`transition-colors ${isRowSelected ? 'bg-rose-500/5 hover:bg-rose-500/10' : isBundle ? 'bg-violet-950/10 hover:bg-violet-950/20' : 'hover:bg-slate-800/20'}`}>
                      {isAdmin && (
                        <td className="py-3.5 px-3 text-center">
                          <input
                            type="checkbox"
                            aria-label={`Pilih SKU ${item.skuId}`}
                            checked={isRowSelected}
                            onChange={() => toggleSelectSku(item.skuId)}
                            className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-900 text-rose-500 focus:ring-rose-500 cursor-pointer accent-rose-500"
                          />
                        </td>
                      )}
                      <td className="py-3.5 px-4 font-mono font-black text-indigo-400 select-all">
                        <div className="flex flex-col gap-1">
                          <span>{item.skuId}</span>
                          {isBundle && (
                            <span className="inline-flex items-center gap-1 w-fit px-1.5 py-0.5 rounded bg-violet-500/20 border border-violet-500/40 text-[9px] font-extrabold text-violet-300 uppercase">
                              <Layers className="w-2.5 h-2.5" />
                              Bundling · {item.bundleComponents?.length || 0} SKU
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 font-semibold text-slate-200">
                        <div className="flex items-center flex-wrap gap-2">
                          <span>{item.skuName}</span>
                          {!isBundle && isPlaceholderSkuName(item.skuId, item.skuName) && (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[9px] font-bold text-amber-300"
                              title="Nama barang masih default sistem, belum diisi nama produk asli"
                            >
                              Nama Default
                            </span>
                          )}
                        </div>
                        {isBundle && item.bundleComponents && item.bundleComponents.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {item.bundleComponents.map(comp => (
                              <span
                                key={comp.skuId}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900 border border-violet-500/30 text-[10px] font-mono text-slate-300"
                                title={comp.skuName || comp.skuId}
                              >
                                <strong className="text-violet-300">{comp.qty}×</strong>
                                <span>{comp.skuId}</span>
                              </span>
                            ))}
                          </div>
                        )}
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
                        {isBundle ? (
                          <div className="space-y-0.5">
                            <span className={`font-mono font-black text-xs ${(bundleAvail?.maxPacks || 0) > 0 ? 'text-violet-300' : 'text-rose-400'}`}>
                              Maks. {formatNumber(bundleAvail?.maxPacks || 0)} Paket
                            </span>
                            {bundleAvail?.limitingSku && (
                              <div className="text-[10px] text-slate-400 font-mono">
                                Batas: {bundleAvail.limitingSku}
                              </div>
                            )}
                          </div>
                        ) : totalQtyPcs > 0 ? (
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
                        {isBundle ? (
                          <span className="inline-block text-[10px] font-bold bg-violet-950/60 border border-violet-500/30 text-violet-300 px-2 py-0.5 rounded-md font-mono">
                            Virtual BOM
                          </span>
                        ) : locationsList.length > 0 ? (
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

      {/* Master Bundling Add/Edit Modal */}
      {isBundleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-xl bg-[#11141B] rounded-2xl border border-violet-500/40 shadow-2xl overflow-hidden relative max-h-[90vh] flex flex-col">
            <button
              type="button"
              onClick={() => setIsBundleModalOpen(false)}
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="p-5 border-b border-slate-850 bg-violet-950/20">
              <h2 className="text-sm font-black text-slate-100 tracking-tight flex items-center gap-2">
                <Layers className="w-4.5 h-4.5 text-violet-400" />
                {bundleModalMode === 'add' ? 'Tambah Master Bundling (Virtual BOM)' : `Edit Bundling: ${bundleEditingSkuId}`}
              </h2>
              <p className="text-[11px] text-slate-400 mt-1">
                Saat SKU Bundling diinput atau di-import pada Order B2B / Online, sistem otomatis memecahnya menjadi SKU komponen dan memotong stok fisik masing-masing komponen saat picking.
              </p>
            </div>

            <form onSubmit={handleBundleFormSubmit} className="p-5 space-y-4 overflow-y-auto">
              {bundleFormError && (
                <div className="flex items-center gap-2 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs p-2.5 rounded-lg">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                  <span>{bundleFormError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">
                    SKU Bundling
                  </label>
                  <input
                    type="text"
                    required
                    disabled={bundleModalMode === 'edit'}
                    placeholder="e.g. BUNDLE-HEMAT-3"
                    value={bundleSkuIdInput}
                    onChange={(e) => setBundleSkuIdInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 uppercase font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">
                    Nama Paket Bundling
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Paket Glowing 3in1"
                    value={bundleSkuNameInput}
                    onChange={(e) => setBundleSkuNameInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">
                    Brand / Merk (Opsional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. TRUEBLUE"
                    value={bundleBrandInput}
                    onChange={(e) => setBundleBrandInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">
                    Barcode Paket (Opsional)
                  </label>
                  <input
                    type="text"
                    placeholder="Opsional, jika ada barcode paket"
                    value={bundleBarcodeInput}
                    onChange={(e) => setBundleBarcodeInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-850 rounded-xl text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
                  />
                </div>
              </div>

              {/* Components List */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-bold text-violet-300 uppercase tracking-wider">
                    Komponen SKU Penyusun (Qty per 1 Paket)
                  </label>
                  <button
                    type="button"
                    onClick={() => setBundleRows(prev => [...prev, { skuId: '', qty: '1' }])}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/40 text-[11px] font-bold text-violet-200 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    Tambah Komponen
                  </button>
                </div>

                <datalist id="wms-bundle-component-skus">
                  {componentCatalogOptions.map(opt => (
                    <option key={opt.skuId} value={opt.skuId}>
                      {opt.skuName} (Stok: {opt.stockQty} pcs)
                    </option>
                  ))}
                </datalist>

                <div className="space-y-2">
                  {bundleRows.map((row, idx) => {
                    const normComp = normalizeSkuKey(row.skuId);
                    const matchedOpt = componentCatalogOptions.find(o => o.skuId === normComp);
                    return (
                      <div key={idx} className="flex items-center gap-2 bg-[#161B25] border border-slate-800 rounded-xl p-2">
                        <span className="text-[10px] font-mono text-slate-500 w-5 text-center">{idx + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <input
                            type="text"
                            list="wms-bundle-component-skus"
                            required
                            placeholder="Ketik atau pilih SKU komponen..."
                            value={row.skuId}
                            onChange={(e) => {
                              const val = e.target.value;
                              setBundleRows(prev => prev.map((r, i) => (i === idx ? { ...r, skuId: val } : r)));
                            }}
                            className="w-full px-2.5 py-1.5 text-xs bg-[#11141B] border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500 font-mono uppercase"
                          />
                          {matchedOpt && (
                            <div className="text-[10px] text-slate-400 truncate mt-0.5 px-1">
                              {matchedOpt.skuName} · <span className="text-emerald-400 font-mono">Stok: {formatNumber(matchedOpt.stockQty)} pcs</span>
                            </div>
                          )}
                        </div>
                        <div className="w-20 shrink-0">
                          <input
                            type="number"
                            min={1}
                            required
                            aria-label={`Qty komponen ${idx + 1}`}
                            value={row.qty}
                            onChange={(e) => {
                              const val = e.target.value;
                              setBundleRows(prev => prev.map((r, i) => (i === idx ? { ...r, qty: val } : r)));
                            }}
                            className="w-full px-2 py-1.5 text-xs text-center bg-[#11141B] border border-slate-800 rounded-lg text-violet-300 font-mono font-bold focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                          <div className="text-[9px] text-slate-500 text-center mt-0.5">pcs/paket</div>
                        </div>
                        <button
                          type="button"
                          disabled={bundleRows.length <= 1}
                          onClick={() => setBundleRows(prev => prev.filter((_, i) => i !== idx))}
                          className="p-1.5 text-slate-500 hover:text-rose-400 disabled:opacity-30 rounded-lg cursor-pointer"
                          title="Hapus baris komponen"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-850">
                <button
                  type="button"
                  onClick={() => setIsBundleModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white bg-slate-800/60 hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSavingBundle}
                  className="px-4 py-2 text-xs font-black text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-xl transition-colors cursor-pointer shadow-lg shadow-violet-600/20"
                >
                  {isSavingBundle ? 'Menyimpan...' : bundleModalMode === 'add' ? 'Simpan Master Bundling' : 'Perbarui Bundling'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
                Upload file Excel (.xlsx, .xls, .csv) termasuk export Mabang ERP (<span className="font-mono text-indigo-300">Inventory SKU Number</span> / <span className="font-mono text-indigo-300">English Name</span>) atau salin data dari spreadsheet. Jika kolom Qty CTN / Inner dikosongkan saat update, ukuran CTN &amp; Inner yang sudah ada di katalog tetap dipertahankan otomatis.
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

      {/* CROSS-BRANCH CATALOG SYNC MODAL */}
      {isCrossBranchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-3xl bg-[#11141B] rounded-2xl border border-slate-800 shadow-2xl overflow-hidden my-8 relative">
            <button
              onClick={() => setIsCrossBranchModalOpen(false)}
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors cursor-pointer z-10"
            >
              <X className="w-4.5 h-4.5" />
            </button>

            <div className="p-5 border-b border-slate-850 bg-slate-900/40">
              <div className="flex items-center gap-2.5">
                <Building2 className="w-5 h-5 text-sky-400" />
                <h2 className="text-base font-black text-slate-100 tracking-tight">
                  Sinkronisasi Nama Barang Lintas Cabang
                </h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Salin nama produk asli dari katalog cabang lain ke cabang <span className="font-mono font-bold text-sky-300">{getActiveBranch()}</span>. Ukuran Qty CTN &amp; Inner yang sudah ada di cabang ini tetap dipertahankan.
              </p>
            </div>

            <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
              {accessibleBranches.length === 0 && !isLoadingCrossBranch ? (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-xs text-amber-200 space-y-1.5">
                  <div className="font-bold text-amber-300">Akun ini belum memiliki akses baca ke cabang lain</div>
                  <p className="text-amber-200/80">
                    Anda tetap dapat melengkapi nama barang menggunakan tombol <span className="font-bold">Import Excel</span> (mendukung file export Mabang ERP) atau <span className="font-bold">Sync Katalog ↔ Stok</span>.
                  </p>
                </div>
              ) : (
                <>
                  {/* Source branch selector & options */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="bg-[#161B25] border border-slate-800 rounded-xl p-3 space-y-1.5">
                      <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono">
                        Cabang Sumber Nama Barang
                      </label>
                      <select
                        value={selectedSourceBranch}
                        onChange={(e) => loadSourceBranchCatalog(e.target.value)}
                        disabled={isLoadingCrossBranch || isApplyingCrossBranch}
                        className="w-full px-3 py-2 text-xs bg-[#0A0C10] border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                      >
                        {accessibleBranches.map(b => (
                          <option key={b.id} value={b.id}>
                            {b.id} — {b.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="bg-[#161B25] border border-slate-800 rounded-xl p-3 space-y-2">
                      <label className="block text-[10px] font-bold text-slate-400 uppercase font-mono">
                        Mode Penyalinan Nama
                      </label>
                      <div className="space-y-1.5 text-xs">
                        <label className="flex items-center gap-2 cursor-pointer text-slate-200">
                          <input
                            type="radio"
                            name="crossBranchSyncMode"
                            checked={crossBranchMode === 'fill_placeholders'}
                            onChange={() => setCrossBranchMode('fill_placeholders')}
                            className="accent-sky-500"
                          />
                          <span>Isi hanya nama default (&lt;SKU&gt; Product) — Aman</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                          <input
                            type="radio"
                            name="crossBranchSyncMode"
                            checked={crossBranchMode === 'overwrite_all'}
                            onChange={() => setCrossBranchMode('overwrite_all')}
                            className="accent-amber-500"
                          />
                          <span>Timpa semua nama SKU yang berbeda</span>
                        </label>
                      </div>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-slate-300 bg-[#161B25] border border-slate-800 rounded-xl px-3.5 py-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={crossBranchIncludeNew}
                      onChange={(e) => setCrossBranchIncludeNew(e.target.checked)}
                      className="accent-sky-500 rounded"
                    />
                    <span>Sertakan juga SKU baru dari cabang <span className="font-mono font-bold text-sky-300">{selectedSourceBranch || '-'}</span> yang belum terdaftar di cabang ini</span>
                  </label>

                  {isLoadingCrossBranch && (
                    <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
                      <RefreshCw className="w-4 h-4 animate-spin text-sky-400" />
                      <span>Memuat katalog cabang {selectedSourceBranch}...</span>
                    </div>
                  )}

                  {!isLoadingCrossBranch && crossBranchError && (
                    <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3.5 text-xs text-rose-300">
                      {crossBranchError}
                    </div>
                  )}

                  {!isLoadingCrossBranch && !crossBranchError && crossBranchPlan && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-3 font-mono">
                          <span className="text-sky-400 font-bold">
                            {crossBranchPlan.itemsToImport.length} SKU akan diperbarui
                          </span>
                          <span className="text-slate-400">
                            {crossBranchPlan.unchangedCount} sudah selaras/dilewati
                          </span>
                        </div>
                        {crossBranchPlan.skippedPlaceholderSourceCount > 0 && (
                          <span className="text-[11px] text-amber-300">
                            {crossBranchPlan.skippedPlaceholderSourceCount} SKU sumber bernama default dilewati
                          </span>
                        )}
                      </div>

                      {crossBranchPlan.previewRows.length === 0 ? (
                        <div className="bg-[#161B25] border border-slate-800 rounded-xl p-4 text-xs text-slate-400 text-center">
                          Tidak ada perbedaan nama yang perlu disalin dari cabang {selectedSourceBranch}.
                        </div>
                      ) : (
                        <div className="max-h-60 overflow-y-auto border border-slate-800 rounded-xl bg-[#161B25]">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-slate-900/90 text-[10px] font-bold text-slate-400 uppercase sticky top-0">
                              <tr>
                                <th className="p-2.5">SKU ID</th>
                                <th className="p-2.5">Nama Saat Ini ({getActiveBranch()})</th>
                                <th className="p-2.5">Nama Baru ({selectedSourceBranch})</th>
                                <th className="p-2.5 text-center">Aksi</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {crossBranchPlan.previewRows.slice(0, 60).map((row) => (
                                <tr key={row.skuId} className="hover:bg-slate-800/30">
                                  <td className="p-2 font-mono font-bold text-indigo-400">{row.skuId}</td>
                                  <td className="p-2 text-slate-400">{row.currentName}</td>
                                  <td className="p-2 text-emerald-300 font-semibold">{row.nextName}</td>
                                  <td className="p-2 text-center">
                                    <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full border ${
                                      row.action === 'UPDATE_PLACEHOLDER'
                                        ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                                        : row.action === 'NEW'
                                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                          : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                    }`}>
                                      {row.action === 'UPDATE_PLACEHOLDER' ? 'ISI DEFAULT' : row.action === 'NEW' ? '+ BARU' : 'TIMPA'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {crossBranchPlan.previewRows.length > 60 && (
                            <div className="p-2 text-center text-[11px] text-slate-400 border-t border-slate-800">
                              Menampilkan 60 dari {crossBranchPlan.previewRows.length} perubahan...
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="p-4 border-t border-slate-850 bg-slate-900/40 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setIsCrossBranchModalOpen(false)}
                className="px-4 py-2 text-xs font-bold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors cursor-pointer"
              >
                Tutup
              </button>
              <button
                type="button"
                disabled={
                  isLoadingCrossBranch ||
                  isApplyingCrossBranch ||
                  !crossBranchPlan ||
                  crossBranchPlan.itemsToImport.length === 0
                }
                onClick={handleApplyCrossBranchSync}
                className="px-5 py-2 bg-sky-500 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 text-xs font-bold text-white rounded-xl transition-all cursor-pointer shadow-lg shadow-sky-500/15 flex items-center gap-2"
              >
                {isApplyingCrossBranch ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Menyimpan &amp; Sinkron Stok...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Terapkan Sinkronisasi ({crossBranchPlan?.itemsToImport.length || 0} SKU)</span>
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
