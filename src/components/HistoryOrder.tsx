import {createPortal} from 'react-dom';
import ShippingReceiptModal,{type ShippingOrderData} from './ShippingReceiptModal';
import {getOrderStageHistory} from '../utils/orderStageHistory';
import {resolveItemBasketCodes} from '../utils/masterBasketTracker';
import {
  buildGroupedHistory,
  buildOrderAddressMap,
  buildOrderHistoryExportRows,
  buildOrderPhoneMap,
  getOrderHistoryExportColWidths,
  resolveOrderCustomerAddress,
  type HistoryOrderGroup
} from '../utils/historyOrderHelpers';
import { useLanguage } from '../i18n/LanguageContext';
import React, { useState, useMemo, useEffect, useDeferredValue } from 'react';
import { OutboundItem } from '../types';
import { formatNumber, formatToWibString, normalizeDateToDmy } from '../utils/calculations';
import * as XLSX from 'xlsx';
import { 
  Printer,
  Search, 
  Calendar, 
  FileText, 
  ShoppingBag, 
  User, 
  MapPin,
  Tag, 
  Layers, 
  FileSpreadsheet,
  Edit,
  Trash2,
  X,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Minimize2,
  Maximize2,
  List,
  Copy,
  Check,
  Camera
} from 'lucide-react';

const HISTORY_PAGE_SIZES = { batch: 25, order: 50, flat: 100 } as const;

interface HistoryOrderProps {
  orderHistory: OutboundItem[];
  currentUser: { username: string; role: string; fullName: string } | null;
  onEditOrderHistory?: (updatedItem: OutboundItem, oldItem: OutboundItem) => Promise<boolean>;
  onDeleteOrderHistory?: (item: OutboundItem) => boolean;
  onDeleteMultipleOrders?: (items: OutboundItem[]) => boolean;
  onClearAllOrderHistory?: () => Promise<boolean> | void;
}

export default function HistoryOrder({ 
  orderHistory, 
  currentUser,
  onEditOrderHistory,
  onDeleteOrderHistory,
  onDeleteMultipleOrders,
  onClearAllOrderHistory
}: HistoryOrderProps) {
  const { t, language } = useLanguage();
  const [receiptOrder,setReceiptOrder]=useState<ShippingOrderData|null>(null);
  const getBatchKey = (item: OutboundItem) =>
    item.batchNumber?.trim() || item.referenceNumber?.trim() || item.orderNumber?.trim() || 'TANPA-BATCH';

  const openReceiptForItems = (items: OutboundItem[], batchLabel?: string) => {
    const activeItems = items.filter(i => i.status !== 'Cancelled');
    const sourceItems = activeItems.length > 0 ? activeItems : items;
    if (sourceItems.length === 0) return;
    const first = sourceItems[0];
    const pickField = (getter: (i: OutboundItem) => string | undefined) =>
      sourceItems.find(i => getter(i)?.trim()) ? getter(sourceItems.find(i => getter(i)?.trim())!)?.trim() : undefined;

    setReceiptOrder({
      referenceNumber: first.referenceNumber || batchLabel || '-',
      orderNumber: pickField(i => i.orderNumber) || first.orderNumber,
      orderId: pickField(i => i.orderNumber) || first.referenceNumber || batchLabel,
      noPo: pickField(i => i.noPo) || first.noPo,
      customerName: pickField(i => i.customerName) || first.customerName,
      customerAddress: pickField(i => i.customerAddress),
      customerPhone: pickField(i => i.customerPhone),
      batchNumber: batchLabel || getBatchKey(first),
      timestamp: first.completedAt || first.pickedAt || first.timestamp,
      items: sourceItems.map(i => ({
        id: i.id,
        skuId: i.skuId,
        skuName: i.skuName,
        location: i.location,
        expiredDate: i.expiredDate,
        qty: i.qty
      })),
      totalQty: sourceItems.reduce((sum, i) => sum + i.qty, 0),
      packerName: pickField(i => i.packedBy) || first.packedBy,
      pickerName: pickField(i => i.pickedBy) || first.pickedBy,
      inputByName: pickField(i => i.createdBy) || first.createdBy
    });
  };

  const printReceipt = (item: OutboundItem) => {
    const bKey = getBatchKey(item);
    const sameBatchItems = orderHistory.filter(
      o => getBatchKey(o) === bKey && (o.referenceNumber === item.referenceNumber || !!item.batchNumber)
    );
    openReceiptForItems(sameBatchItems.length > 0 ? sameBatchItems : [item], bKey);
  };

  const [viewMode, setViewMode] = useState<'batch' | 'order' | 'flat'>('batch');
  const [expandedBatches, setExpandedBatches] = useState<Record<string, boolean>>({});
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>({});
  const orderAddressMap = useMemo(() => buildOrderAddressMap(orderHistory), [orderHistory]);
  const orderPhoneMap = useMemo(() => buildOrderPhoneMap(orderHistory), [orderHistory]);
  const resolveCustomerAddress = (item: OutboundItem) => resolveOrderCustomerAddress(item, orderAddressMap);
  const [showCancelled,setShowCancelled]=useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [currentPage, setCurrentPage] = useState(1);
  const [customPageSize, setCustomPageSize] = useState<number | null>(null);
  const pageSize = customPageSize ?? HISTORY_PAGE_SIZES[viewMode];

  // Batch query state (Pencarian massal banyak nomor sekaligus)
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [batchRawInput, setBatchRawInput] = useState('');
  const [batchTargetField, setBatchTargetField] = useState<'all' | 'order' | 'sku' | 'po_batch'>('all');
  const [batchMatchMode, setBatchMatchMode] = useState<'exact' | 'contains'>('exact');
  const [activeBatchKeywords, setActiveBatchKeywords] = useState<string[]>([]);

  const parseBatchKeywords = (raw: string): string[] => {
    if (!raw) return [];
    const tokens = raw
      .split(/[\r\n,;\t]+/)
      .map(k => k.trim())
      .filter(k => k.length > 0);
    return Array.from(new Set(tokens));
  };
  const detectedKeywords = useMemo(() => parseBatchKeywords(batchRawInput), [batchRawInput]);
  const [customerFilter, setCustomerFilter] = useState('ALL');
  const [batchFilter, setBatchFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'Completed' | 'Pending' | 'Cancelled'>('ALL');
  const [sortBy, setSortBy] = useState<'timestamp' | 'qty'>('timestamp');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  
  // Date filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  
  // Selected rows state for custom row export selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  
  // Optional columns to export
  const [includeDescription, setIncludeDescription] = useState(true);

  // State & handler for copy to clipboard
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopyText = async (text: string, key: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (!text || text === 'TANPA-BATCH') return;
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
      }, 1800);
    } catch (err) {
      console.error('Failed to copy: ', err);
    }
  };

  // Edit item states
  const [editingItem, setEditingItem] = useState<OutboundItem | null>(null);
  const [editBatchNumber, setEditBatchNumber] = useState('');
  const [editCustomerName, setEditCustomerName] = useState('');
  const [editCustomerAddress, setEditCustomerAddress] = useState('');
  const [editOrderNumber, setEditOrderNumber] = useState('');
  const [editNoPo, setEditNoPo] = useState('');
  const [editQty, setEditQty] = useState(0);
  const [editLocation, setEditLocation] = useState('');
  const [editExpiredDate, setEditExpiredDate] = useState('');

  // Custom Confirmation Dialog State
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    type: 'danger' | 'warning' | 'info';
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    type: 'danger'
  });

  const handleStartEdit = (item: OutboundItem) => {
    setEditingItem(item);
    setEditBatchNumber(item.batchNumber || item.referenceNumber || '');
    setEditCustomerName(item.customerName || '');
    setEditCustomerAddress(resolveCustomerAddress(item));
    setEditOrderNumber(item.orderNumber || '');
    setEditNoPo(item.noPo || '');
    setEditQty(item.qty);
    setEditLocation(item.location || '');
    setEditExpiredDate(item.expiredDate || '');
  };

  const handleSaveEdit = async () => {
    if (!editingItem) return;
    if (editQty <= 0) {
      alert('Kuantitas harus lebih besar dari 0.');
      return;
    }
    if (!editLocation.trim()) {
      alert('Lokasi rak tidak boleh kosong.');
      return;
    }

    const updatedItem: OutboundItem = {
      ...editingItem,
      batchNumber: editBatchNumber.trim() || editingItem.batchNumber,
      customerName: editCustomerName.trim() || undefined,
      customerAddress: editCustomerAddress.trim() || undefined,
      orderNumber: editOrderNumber.trim() || undefined,
      noPo: editNoPo.trim() || undefined,
      qty: editQty,
      location: editLocation.trim(),
      expiredDate: normalizeDateToDmy(editExpiredDate.trim())
    };

    if (onEditOrderHistory) {
      const success = await onEditOrderHistory(updatedItem, editingItem);
      if (success) {
        setEditingItem(null);
      }
    }
  };

  const handleDelete = (item: OutboundItem) => {
    if(item.status==='Cancelled')return;
    setConfirmDialog({
      isOpen: true,
      title: 'Batalkan Order',
      message: `Apakah Anda yakin ingin membatalkan order ini?\n\nSKU: ${item.skuId}\nCustomer: ${item.customerName || '-'}\nQty: ${formatNumber(item.qty)} Pcs\n\nRiwayat tetap disimpan. Stok akan dikembalikan jika sebelumnya sudah dipotong.`,
      type: 'danger',
      onConfirm: () => {
        if (onDeleteOrderHistory) {
          onDeleteOrderHistory(item);
        }
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
      }
    });
  };

  const handleDeleteSelected = () => {
    const selectedSet = new Set(selectedIds);
    const itemsToDelete = filteredHistory.filter(item => selectedSet.has(item.id) && item.status !== 'Cancelled');
    if (itemsToDelete.length === 0) return;

    setConfirmDialog({
      isOpen: true,
      title: 'Batalkan Order Terpilih',
      message: `Apakah Anda yakin ingin membatalkan ${itemsToDelete.length} order terpilih?\n\nAnda akan diminta mengisi alasan pembatalan.`,
      type: 'danger',
      onConfirm: () => {
        if (onDeleteMultipleOrders) {
          const success = onDeleteMultipleOrders(itemsToDelete);
          if (success) {
            setSelectedIds([]);
          }
        } else if (onDeleteOrderHistory) {
          let successCount = 0;
          itemsToDelete.forEach(item => {
            if (onDeleteOrderHistory(item)) {
              successCount++;
            }
          });
          if (successCount > 0) {
            setSelectedIds([]);
          }
        }
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
      }
    });
  };

  // Pre-index orderHistory in a single pass so typing, date filtering, sorting & dropdown options stay O(N)
  const { indexedHistory, uniqueCustomers, uniqueBatches, cancelledCount } = useMemo(() => {
    const customers = new Set<string>();
    const batches = new Set<string>();
    let cancelled = 0;

    const indexed = orderHistory.map(item => {
      if (item.status === 'Cancelled') cancelled++;
      const bKey = getBatchKey(item);
      if (bKey) batches.add(bKey);
      if (item.customerName) customers.add(item.customerName);

      const addr = resolveOrderCustomerAddress(item, orderAddressMap);
      const skuLower = item.skuId.toLowerCase();
      const skuNameLower = item.skuName.toLowerCase();
      const batchKeyLower = bKey.toLowerCase();
      const batchLower = item.batchNumber ? item.batchNumber.toLowerCase() : '';
      const orderLower = item.orderNumber ? item.orderNumber.toLowerCase() : '';
      const noPoLower = item.noPo ? item.noPo.toLowerCase() : '';
      const customerLower = item.customerName ? item.customerName.toLowerCase() : '';
      const addrLower = addr ? addr.toLowerCase() : '';
      const refLower = item.referenceNumber.toLowerCase();
      const basketLower = item.basketNumber ? item.basketNumber.toLowerCase() : '';
      const masterLower = item.masterBasketNumber ? item.masterBasketNumber.toLowerCase() : '';

      const searchFields = [
        skuLower,
        skuNameLower,
        batchKeyLower,
        batchLower,
        orderLower,
        noPoLower,
        customerLower,
        addrLower,
        refLower,
        basketLower,
        masterLower,
        item.createdBy?.toLowerCase() || '',
        item.pickedBy?.toLowerCase() || '',
        item.sortedBy?.toLowerCase() || '',
        item.packedBy?.toLowerCase() || ''
      ];

      const batchHaystack = [
        skuLower,
        skuNameLower,
        batchKeyLower,
        batchLower,
        orderLower,
        refLower,
        noPoLower,
        customerLower,
        basketLower,
        masterLower,
        addrLower
      ].join(' ');

      return {
        item,
        tsMs: Date.parse(item.timestamp),
        batchKey: bKey,
        skuLower,
        skuNameLower,
        batchKeyLower,
        batchLower,
        orderLower,
        noPoLower,
        customerLower,
        refLower,
        basketLower,
        masterLower,
        searchHaystack: searchFields.filter(Boolean).join('\u0001'),
        batchHaystack
      };
    });

    return {
      indexedHistory: indexed,
      uniqueCustomers: Array.from(customers),
      uniqueBatches: Array.from(batches),
      cancelledCount: cancelled
    };
  }, [orderHistory, orderAddressMap]);

  const batchSelectOptions = useMemo(
    () => uniqueBatches.map(b => <option key={b} value={b}>{b}</option>),
    [uniqueBatches]
  );
  const customerSelectOptions = useMemo(
    () => uniqueCustomers.map(cust => <option key={cust} value={cust}>{cust}</option>),
    [uniqueCustomers]
  );

  // Handle Sort
  const toggleSort = (field: 'timestamp' | 'qty') => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  // Filter and Search using deferred term & pre-parsed timestamps
  const filteredHistory = useMemo(() => {
    const startMs = startDate ? (() => { const d = new Date(startDate); d.setHours(0, 0, 0, 0); return d.getTime(); })() : null;
    const endMs = endDate ? (() => { const d = new Date(endDate); d.setHours(23, 59, 59, 999); return d.getTime(); })() : null;
    const term = deferredSearchTerm.trim().toLowerCase();
    const hasBatchQuery = activeBatchKeywords.length > 0;
    const keywordSet = hasBatchQuery && batchMatchMode === 'exact'
      ? new Set(activeBatchKeywords.map(k => k.toLowerCase()))
      : null;
    const lowerKeywords = hasBatchQuery && batchMatchMode !== 'exact'
      ? activeBatchKeywords.map(k => k.toLowerCase())
      : null;

    const matched: typeof indexedHistory = [];
    for (let i = 0; i < indexedHistory.length; i++) {
      const entry = indexedHistory[i];
      const item = entry.item;

      if (!showCancelled && statusFilter !== 'Cancelled' && item.status === 'Cancelled') continue;
      if (statusFilter !== 'ALL' && item.status !== statusFilter) continue;
      if (batchFilter !== 'ALL' && entry.batchKey !== batchFilter) continue;
      if (customerFilter !== 'ALL' && item.customerName !== customerFilter) continue;
      if (startMs !== null && !(entry.tsMs >= startMs)) continue;
      if (endMs !== null && !(entry.tsMs <= endMs)) continue;

      if (term !== '' && !entry.searchHaystack.includes(term)) continue;

      if (keywordSet) {
        let hit = false;
        if (batchTargetField === 'sku') {
          hit = keywordSet.has(entry.skuLower);
        } else if (batchTargetField === 'order') {
          hit = Boolean((entry.orderLower && keywordSet.has(entry.orderLower)) || (entry.refLower && keywordSet.has(entry.refLower)));
        } else if (batchTargetField === 'po_batch') {
          hit = Boolean((entry.batchLower && keywordSet.has(entry.batchLower)) || (entry.noPoLower && keywordSet.has(entry.noPoLower)) || keywordSet.has(entry.batchKeyLower));
        } else {
          hit =
            keywordSet.has(entry.skuLower) ||
            keywordSet.has(entry.skuNameLower) ||
            keywordSet.has(entry.batchKeyLower) ||
            Boolean(entry.batchLower && keywordSet.has(entry.batchLower)) ||
            Boolean(entry.orderLower && keywordSet.has(entry.orderLower)) ||
            Boolean(entry.refLower && keywordSet.has(entry.refLower)) ||
            Boolean(entry.noPoLower && keywordSet.has(entry.noPoLower)) ||
            Boolean(entry.customerLower && keywordSet.has(entry.customerLower)) ||
            Boolean(entry.basketLower && keywordSet.has(entry.basketLower)) ||
            Boolean(entry.masterLower && keywordSet.has(entry.masterLower));
        }
        if (!hit) continue;
      } else if (lowerKeywords) {
        let hit = false;
        if (batchTargetField === 'sku') {
          hit = lowerKeywords.some(k => entry.skuLower.includes(k));
        } else if (batchTargetField === 'order') {
          hit = lowerKeywords.some(k => entry.orderLower.includes(k) || entry.refLower.includes(k));
        } else if (batchTargetField === 'po_batch') {
          hit = lowerKeywords.some(k => entry.batchLower.includes(k) || entry.batchKeyLower.includes(k) || entry.noPoLower.includes(k));
        } else {
          hit = lowerKeywords.some(k => entry.batchHaystack.includes(k));
        }
        if (!hit) continue;
      }

      matched.push(entry);
    }

    matched.sort((a, b) => {
      const valA = sortBy === 'timestamp' ? a.tsMs : a.item.qty;
      const valB = sortBy === 'timestamp' ? b.tsMs : b.item.qty;
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return matched.map(entry => entry.item);
  }, [indexedHistory, deferredSearchTerm, customerFilter, batchFilter, statusFilter, sortBy, sortOrder, startDate, endDate, showCancelled, activeBatchKeywords, batchTargetField, batchMatchMode]);

  const { groupedByBatch, groupedByOrder } = useMemo(
    () => buildGroupedHistory(filteredHistory, orderAddressMap, sortBy, sortOrder),
    [filteredHistory, orderAddressMap, sortBy, sortOrder]
  );

  // Reset pagination whenever filters, sorting, viewMode or pageSize change
  useEffect(() => {
    setCurrentPage(1);
  }, [viewMode, pageSize, deferredSearchTerm, customerFilter, batchFilter, statusFilter, sortBy, sortOrder, startDate, endDate, showCancelled, activeBatchKeywords, batchTargetField, batchMatchMode]);

  const activeTotalCount =
    viewMode === 'batch'
      ? groupedByBatch.length
      : viewMode === 'order'
      ? groupedByOrder.length
      : filteredHistory.length;
  const totalPages = Math.max(1, Math.ceil(activeTotalCount / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStartIdx = (safePage - 1) * pageSize;
  const pageEndIdx = Math.min(activeTotalCount, pageStartIdx + pageSize);

  const paginatedBatches = useMemo(
    () => groupedByBatch.slice(pageStartIdx, pageEndIdx),
    [groupedByBatch, pageStartIdx, pageEndIdx]
  );
  const paginatedOrders = useMemo(
    () => groupedByOrder.slice(pageStartIdx, pageEndIdx),
    [groupedByOrder, pageStartIdx, pageEndIdx]
  );
  const paginatedFlatItems = useMemo(
    () => filteredHistory.slice(pageStartIdx, pageEndIdx),
    [filteredHistory, pageStartIdx, pageEndIdx]
  );

  const allOrderCollapseKeys = useMemo(
    () =>
      viewMode === 'order'
        ? paginatedOrders.map(o => o.collapseKey)
        : paginatedBatches.flatMap(g => g.orderGroups.map(o => o.collapseKey)),
    [viewMode, paginatedBatches, paginatedOrders]
  );

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const completedVolumeQty = useMemo(
    () => filteredHistory.reduce((sum, i) => (i.status === 'Completed' ? sum + i.qty : sum), 0),
    [filteredHistory]
  );

  const handleToggleCollapseOrderKeys = (keys: string[], parentBatchKeys?: string[]) => {
    if (keys.length === 0) return;
    const anyCollapsed = keys.some(k => !expandedOrders[k]);
    setExpandedOrders(prev => {
      const next = { ...prev };
      for (const k of keys) {
        if (anyCollapsed) {
          next[k] = true;
        } else {
          delete next[k];
        }
      }
      return next;
    });
    if (anyCollapsed && parentBatchKeys && parentBatchKeys.length > 0) {
      setExpandedBatches(prev => {
        const next = { ...prev };
        for (const bKey of parentBatchKeys) {
          next[bKey] = true;
        }
        return next;
      });
    }
  };

  const handleToggleSelectBatch = (batchItems: OutboundItem[]) => {
    const batchIds = batchItems.map(i => i.id);
    const allSelectedInBatch = batchIds.length > 0 && batchIds.every(id => selectedIdSet.has(id));
    if (allSelectedInBatch) {
      const removeSet = new Set(batchIds);
      setSelectedIds(prev => prev.filter(id => !removeSet.has(id)));
    } else {
      setSelectedIds(prev => Array.from(new Set([...prev, ...batchIds])));
    }
  };

  const handleCancelBatch = (batchKey: string, batchItems: OutboundItem[]) => {
    const cancellable = batchItems.filter(i => i.status !== 'Cancelled');
    if (cancellable.length === 0) return;
    setConfirmDialog({
      isOpen: true,
      title: `Batalkan Batch ${batchKey}`,
      message: `Apakah Anda yakin ingin membatalkan seluruh order aktif (${cancellable.length} baris SKU) dalam Batch "${batchKey}"?\n\nAnda akan diminta mengisi alasan pembatalan.`,
      type: 'danger',
      onConfirm: () => {
        if (onDeleteMultipleOrders) {
          onDeleteMultipleOrders(cancellable);
        } else if (onDeleteOrderHistory) {
          cancellable.forEach(item => onDeleteOrderHistory(item));
        }
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
      }
    });
  };

  useEffect(() => {
    if (selectedIds.length === 0) return;
    const visible = new Set(filteredHistory.map(item => item.id));
    setSelectedIds(prev => {
      const next = prev.filter(id => visible.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [filteredHistory, selectedIds.length]);

  const cancellableSelected = useMemo(
    () => filteredHistory.filter(item => selectedIdSet.has(item.id) && item.status !== 'Cancelled'),
    [filteredHistory, selectedIdSet]
  );

  // Handle Select / Deselect individual row
  const handleToggleSelectRow = (id: string) => {
    setSelectedIds(prev => 
      selectedIdSet.has(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  // Handle Select / Deselect all filtered rows
  const handleToggleSelectAll = () => {
    const allFilteredIds = filteredHistory.map(item => item.id);
    const areAllInSelected = allFilteredIds.length > 0 && allFilteredIds.every(id => selectedIdSet.has(id));

    if (areAllInSelected) {
      const removeSet = new Set(allFilteredIds);
      setSelectedIds(prev => prev.filter(id => !removeSet.has(id)));
    } else {
      setSelectedIds(prev => {
        const union = new Set([...prev, ...allFilteredIds]);
        return Array.from(union);
      });
    }
  };

  const { isAllSelected, isSomeSelected } = useMemo(() => {
    if (filteredHistory.length === 0 || selectedIdSet.size === 0) {
      return { isAllSelected: false, isSomeSelected: false };
    }
    let hitCount = 0;
    for (let i = 0; i < filteredHistory.length; i++) {
      if (selectedIdSet.has(filteredHistory[i].id)) hitCount++;
    }
    const all = hitCount === filteredHistory.length;
    return { isAllSelected: all, isSomeSelected: hitCount > 0 && !all };
  }, [filteredHistory, selectedIdSet]);

  // Export to Excel .xlsx
  const handleExportExcel = () => {
    const itemsToExport = selectedIdSet.size > 0 
      ? filteredHistory.filter(item => selectedIdSet.has(item.id)) 
      : filteredHistory;

    if (itemsToExport.length === 0) {
      alert('Tidak ada data yang dipilih atau terdeteksi untuk diekspor.');
      return;
    }

    try {
      const exportData = buildOrderHistoryExportRows(itemsToExport, orderAddressMap, {
        includeDescription,
        phoneMap: orderPhoneMap
      });

      const worksheet = XLSX.utils.json_to_sheet(exportData);
      worksheet['!cols'] = getOrderHistoryExportColWidths(includeDescription);

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Riwayat Order');
      
      const timestamp = new Date().toISOString().substring(0, 10);
      XLSX.writeFile(workbook, `Hasil_Ekspor_Order_${timestamp}.xlsx`);
    } catch (error) {
      console.error(error);
      alert('Gagal mengekspor data ke Excel.');
    }
  };

  const renderOrderItemsTable = (items: OutboundItem[]) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-[#11141B] text-slate-400 uppercase font-bold text-[10px] border-b border-slate-800/60">
            <th className="py-2.5 px-4 text-center w-10"></th>
            <th className="py-2.5 px-4">SKU / Nama Barang</th>
            <th className="py-2.5 px-4 text-center">Lokasi Rak</th>
            <th className="py-2.5 px-4 text-center">Expired</th>
            <th className="py-2.5 px-4 text-right">Qty (Pcs)</th>
            <th className="py-2.5 px-4 text-center">Status</th>
            <th className="py-2.5 px-4 min-w-[260px]">Petugas & Waktu Proses (WIB)</th>
            <th className="py-2.5 px-4 text-center w-24">Aksi</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50 text-slate-300 text-xs">
          {items.map(item => (
            <tr
              key={item.id}
              className={`hover:bg-slate-800/20 transition-colors ${
                selectedIdSet.has(item.id) ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : ''
              }`}
            >
              <td className="py-2.5 px-4 text-center">
                <input
                  type="checkbox"
                  checked={selectedIdSet.has(item.id)}
                  onChange={() => handleToggleSelectRow(item.id)}
                  className="w-4 h-4 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                />
              </td>
              <td className="py-2.5 px-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={(e) => handleCopyText(item.skuId, `sku-${item.id}`, e)}
                    className="inline-flex items-center gap-1 font-mono font-bold text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 hover:border-emerald-500/40 px-1.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer group active:scale-95"
                    title="Klik untuk salin SKU ID"
                    aria-label={`Salin SKU ID ${item.skuId}`}
                  >
                    <span>{item.skuId}</span>
                    {copiedKey === `sku-${item.id}` ? (
                      <span className="inline-flex items-center text-[10px] text-emerald-300 font-sans font-semibold">
                        <Check className="w-3 h-3 text-emerald-300 mr-0.5" />
                        Tersalin!
                      </span>
                    ) : (
                      <Copy className="w-3 h-3 text-emerald-500/60 group-hover:text-emerald-300 transition-colors" />
                    )}
                  </button>
                  <span className="font-medium text-slate-200">{item.skuName}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono flex flex-wrap items-center gap-1">
                  <span>Ref: {item.referenceNumber}</span>
                  {item.orderNumber && (
                    <>
                      <span>•</span>
                      <button
                        type="button"
                        onClick={(e) => handleCopyText(item.orderNumber!, `order-sub-${item.id}`, e)}
                        className="inline-flex items-center gap-1 text-slate-300 hover:text-emerald-300 transition-colors cursor-pointer active:scale-95 px-1 py-0.5 rounded hover:bg-emerald-500/10"
                        title="Klik untuk salin No Order"
                        aria-label={`Salin No Order ${item.orderNumber}`}
                      >
                        <span>Order: <strong>{item.orderNumber}</strong></span>
                        {copiedKey === `order-sub-${item.id}` ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-2.5 h-2.5 text-slate-500 hover:text-emerald-300" />
                        )}
                      </button>
                    </>
                  )}
                  {item.noPo ? ` • PO: ${item.noPo}` : ''}
                </div>
              </td>
              <td className="py-2.5 px-4 text-center font-mono font-bold text-slate-200">
                {item.location}
              </td>
              <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono text-slate-300">
                {item.expiredDate}
              </td>
              <td className="py-2.5 px-4 text-right font-bold text-rose-400 font-mono">
                {formatNumber(item.qty)}
              </td>
              <td className="py-2.5 px-4 text-center">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ${
                    item.status === 'Cancelled'
                      ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      : item.status === 'Pending'
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse'
                      : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  }`}
                >
                  {item.status === 'Cancelled' ? 'Dibatalkan' : item.status}
                </span>
              </td>
              <td className="py-2.5 px-4 align-top min-w-[260px]">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                  {getOrderStageHistory(item).map(({ stage, name, processedAt, timeLabel }) => (
                    <React.Fragment key={stage}>
                      <dt className="font-semibold text-slate-400">{stage}:</dt>
                      <dd className="font-bold text-slate-200 break-words">
                        <span>{name}</span>
                        {timeLabel !== 'Belum tercatat' && (
                          <time dateTime={processedAt} className="ml-1.5 font-normal text-slate-400 text-[10px] tabular-nums">
                            ({timeLabel})
                          </time>
                        )}
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
              </td>
              <td className="py-2.5 px-4 text-center whitespace-nowrap">
                {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') &&
                item.status !== 'Cancelled' ? (
                  <>
                    <button
                      onClick={() => handleStartEdit(item)}
                      className="p-1 text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 rounded transition-colors mr-1.5 cursor-pointer inline-flex items-center"
                      title="Edit Baris"
                    >
                      <Edit className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(item)}
                      className="p-1 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-colors cursor-pointer inline-flex items-center"
                      title="Batalkan Baris Order"
                      aria-label="Batalkan order"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                    {item.status === 'Cancelled' ? 'Dibatalkan' : 'Hanya lihat'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const renderBasketBadges = (masterBaskets: string[], sortBaskets: string[]) => (
    <>
      {masterBaskets.length > 0 && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300 font-mono text-[10px] font-bold">
          Induk: <strong>{masterBaskets.join(', ')}</strong>
        </span>
      )}
      {sortBaskets.length > 0 && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-violet-500/10 border border-violet-500/30 text-violet-300 font-mono text-[10px] font-bold">
          Sortir: <strong>{sortBaskets.join(', ')}</strong>
        </span>
      )}
    </>
  );

  const renderOrderCard = (orderGroup: HistoryOrderGroup, options?: { showBatchBadge?: boolean }) => {
    const isOrderCollapsed = !expandedOrders[orderGroup.collapseKey];
    const orderIds = orderGroup.items.map(i => i.id);
    const allOrderSelected = orderIds.length > 0 && orderIds.every(id => selectedIdSet.has(id));
    const someOrderSelected = orderIds.length > 0 && orderIds.some(id => selectedIdSet.has(id)) && !allOrderSelected;

    return (
      <div
        key={orderGroup.collapseKey}
        className="rounded-xl border border-slate-800/80 bg-[#11141B] overflow-hidden shadow-sm"
      >
        <div className="bg-[#161B25]/90 px-4 py-3 border-b border-slate-800/60 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-start sm:items-center gap-3 min-w-0">
            <input
              type="checkbox"
              checked={allOrderSelected}
              ref={el => {
                if (el) el.indeterminate = someOrderSelected;
              }}
              onChange={() => handleToggleSelectBatch(orderGroup.items)}
              className="w-4 h-4 mt-1 sm:mt-0 rounded border-slate-700 bg-[#11141B] text-emerald-500 focus:ring-emerald-500 cursor-pointer shrink-0"
              title={`Pilih semua item di Order ${orderGroup.displayOrderLabel}`}
            />

            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => handleCopyText(orderGroup.displayOrderLabel, `order-card-${orderGroup.collapseKey}`, e)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-[#11141B] hover:bg-emerald-500/15 border border-slate-700/70 hover:border-emerald-500/40 text-slate-100 hover:text-emerald-300 font-mono text-xs font-extrabold transition-all cursor-pointer group active:scale-95"
                  title="Klik untuk salin No Order"
                  aria-label={`Salin No Order ${orderGroup.displayOrderLabel}`}
                >
                  <FileText className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>{orderGroup.orderNumber ? `No Order: ${orderGroup.orderNumber}` : `Ref: ${orderGroup.displayOrderLabel}`}</span>
                  {copiedKey === `order-card-${orderGroup.collapseKey}` ? (
                    <span className="inline-flex items-center text-[10px] text-emerald-300 font-sans font-semibold">
                      <Check className="w-3 h-3 text-emerald-300 mr-0.5" />
                      Tersalin!
                    </span>
                  ) : (
                    <Copy className="w-3 h-3 text-slate-400 group-hover:text-emerald-300 transition-colors" />
                  )}
                </button>

                {options?.showBatchBadge && (
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                    <Layers className="w-3 h-3 shrink-0" />
                    Batch: {orderGroup.batchKey}
                  </span>
                )}

                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ${
                    orderGroup.orderStatus === 'Cancelled'
                      ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      : orderGroup.orderStatus === 'Pending'
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  }`}
                >
                  {orderGroup.orderStatus === 'Cancelled' ? 'Dibatalkan' : orderGroup.orderStatus}
                </span>

                <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-slate-500" />
                  {formatToWibString(orderGroup.latestTimestamp)}
                </span>

                {orderGroup.poNumbers.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-300">
                    <Tag className="w-3 h-3 text-amber-400" />
                    PO: <strong>{orderGroup.poNumbers.join(', ')}</strong>
                  </span>
                )}
                {renderBasketBadges(orderGroup.masterBaskets, orderGroup.sortBaskets)}
              </div>

              {(orderGroup.customers.length > 0 || orderGroup.customerAddress) && (
                <div className="flex flex-wrap items-start gap-x-4 gap-y-1 text-xs">
                  {orderGroup.customers.length > 0 && (
                    <span className="inline-flex items-center gap-1 font-bold text-slate-200">
                      <User className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span>{orderGroup.customers.join(', ')}</span>
                    </span>
                  )}
                  {orderGroup.customerAddress && (
                    <span className="inline-flex items-start gap-1 text-slate-300 break-words">
                      <MapPin className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <span className="whitespace-pre-line">{orderGroup.customerAddress}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between lg:justify-end gap-2.5 shrink-0">
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <span className="px-2 py-1 rounded bg-[#11141B] border border-slate-800 text-slate-300 font-bold">
                {orderGroup.uniqueSkuCount} SKU ({orderGroup.items.length} baris)
              </span>
              <span className="px-2 py-1 rounded bg-[#11141B] border border-slate-800 text-rose-400 font-extrabold">
                {formatNumber(orderGroup.totalQty)} Pcs
              </span>
            </div>

            {orderGroup.orderStatus !== 'Cancelled' && (
              <button
                type="button"
                onClick={() => openReceiptForItems(orderGroup.items, orderGroup.batchKey)}
                className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 px-2.5 py-1 text-[11px] font-bold text-indigo-400 transition-colors cursor-pointer"
                title={`Print resi untuk order ${orderGroup.displayOrderLabel}`}
              >
                <Printer className="w-3.5 h-3.5" />
                Print Resi Order
              </button>
            )}

            <button
              type="button"
              onClick={() =>
                setExpandedOrders(prev => ({
                  ...prev,
                  [orderGroup.collapseKey]: !prev[orderGroup.collapseKey]
                }))
              }
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold transition-colors cursor-pointer ${
                isOrderCollapsed
                  ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/35 text-emerald-300'
                  : 'bg-[#11141B] hover:bg-slate-800 border-slate-700/70 text-slate-300'
              }`}
              title={isOrderCollapsed ? 'Tampilkan rincian order' : 'Sembunyikan rincian order'}
              aria-expanded={!isOrderCollapsed}
            >
              {isOrderCollapsed ? (
                <>
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span>{t('order.maximizeOrder')}</span>
                </>
              ) : (
                <>
                  <Minimize2 className="w-3.5 h-3.5" />
                  <span>{t('order.minimizeOrder')}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {!isOrderCollapsed && renderOrderItemsTable(orderGroup.items)}
      </div>
    );
  };

  const renderPaginationBar = (placement: 'top' | 'bottom') => {
    if (activeTotalCount === 0) return null;
    const unitLabel = viewMode === 'batch' ? 'Batch' : viewMode === 'order' ? 'Order' : 'Baris';
    const pageOptions = Array.from(new Set([25, 50, 100, 200, 500, pageSize])).sort((a, b) => a - b);

    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-[#151922] px-4 py-2.5 text-xs text-slate-300 ${
          placement === 'top' ? 'shadow-sm' : 'mt-3'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span>
            Menampilkan{' '}
            <strong className="text-white font-mono">
              {formatNumber(pageStartIdx + 1)}–{formatNumber(pageEndIdx)}
            </strong>{' '}
            dari <strong className="text-white font-mono">{formatNumber(activeTotalCount)}</strong> {unitLabel}
          </span>
          {searchTerm !== deferredSearchTerm && (
            <span className="text-[11px] font-semibold text-emerald-400">Menyaring...</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
            <span>Per halaman:</span>
            <select
              aria-label={`Jumlah ${unitLabel} per halaman (${placement})`}
              value={pageSize}
              onChange={(e) => {
                const nextSize = Number(e.target.value);
                if (Number.isFinite(nextSize) && nextSize > 0) {
                  setCustomPageSize(nextSize);
                  setCurrentPage(1);
                }
              }}
              className="rounded-lg border border-slate-700 bg-[#11141B] px-2 py-1 text-xs font-bold text-slate-200 outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
            >
              {pageOptions.map(opt => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          {totalPages > 1 && (
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCurrentPage(1)}
                disabled={safePage <= 1}
                className="rounded-lg border border-slate-700/80 bg-[#11141B] px-2 py-1 text-[11px] font-bold text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                title="Halaman pertama"
              >
                «
              </button>
              <button
                type="button"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="inline-flex items-center gap-0.5 rounded-lg border border-slate-700/80 bg-[#11141B] px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                title="Halaman sebelumnya"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Sebelumnya</span>
              </button>
              <span className="px-2 font-mono text-[11px] font-bold text-slate-200">
                Hal {safePage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="inline-flex items-center gap-0.5 rounded-lg border border-slate-700/80 bg-[#11141B] px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                title="Halaman berikutnya"
              >
                <span>Berikutnya</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setCurrentPage(totalPages)}
                disabled={safePage >= totalPages}
                className="rounded-lg border border-slate-700/80 bg-[#11141B] px-2 py-1 text-[11px] font-bold text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                title="Halaman terakhir"
              >
                »
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6" id="history-order-view">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#11141B] rounded-2xl p-6 border border-slate-800/60 shadow-md">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-white flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-emerald-400" />
            {t('order.historyTitle')}
          </h2>
          <p className="text-slate-400 mt-1 text-xs md:text-sm">
            {t('order.historySubtitle')}
          </p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          {/* View Mode Toggle: Per Batch vs Per Order vs Flat Table */}
          <div className="flex items-center bg-[#161B25] p-1 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => setViewMode('batch')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                viewMode === 'batch'
                  ? 'bg-emerald-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              {t('order.viewPerBatch')} ({groupedByBatch.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode('order')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                viewMode === 'order'
                  ? 'bg-emerald-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              {t('order.viewPerOrder')} ({groupedByOrder.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode('flat')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                viewMode === 'flat'
                  ? 'bg-emerald-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              {t('order.viewFlatTable')} ({filteredHistory.length})
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-300 font-bold bg-[#161B25] hover:bg-[#1f2635] px-3.5 py-2.5 rounded-xl border border-slate-800 cursor-pointer select-none transition-colors">
            <input 
              type="checkbox"
              checked={includeDescription}
              onChange={(e) => setIncludeDescription(e.target.checked)}
              className="w-4 h-4 rounded border-slate-800 bg-[#11141B] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
            />
            {t('order.includeDocCol')}
          </label>
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4" />
            {t('order.exportExcel')} {selectedIds.length > 0 && `(${selectedIds.length} Terpilih)`}
          </button>
          {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && orderHistory.length > 0 && selectedIds.length === 0 && !!onClearAllOrderHistory && (
            <button
              onClick={() => {
                if (onClearAllOrderHistory) {
                  onClearAllOrderHistory();
                }
              }}
              className="flex items-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
              {t('order.clearAll')}
            </button>
          )}
          {cancellableSelected.length > 0 && ['Administrator','Admin'].includes(currentUser?.role||'') && (
            <button
              onClick={handleDeleteSelected}
              className="flex items-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
              {t('order.cancelSelected')} ({cancellableSelected.length})
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2.5 rounded-xl border border-slate-800/60 bg-[#11141B] px-4 py-2.5 text-xs font-bold text-slate-300 shadow-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={e => setShowCancelled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
          />
          <span>{t('order.showCancelled')} ({cancelledCount} baris)</span>
        </label>

        {(viewMode === 'batch' || viewMode === 'order') &&
          (viewMode === 'batch' ? groupedByBatch.length > 0 : groupedByOrder.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleToggleSelectAll}
              className="px-3 py-2 rounded-xl border border-slate-800 bg-[#11141B] hover:bg-[#161B25] text-xs font-bold text-slate-300 transition-colors cursor-pointer"
            >
              {isAllSelected ? t('order.deselectAll') : `${t('order.selectAll')} (${filteredHistory.length} Baris)`}
            </button>
            {viewMode === 'batch' && (
              <button
                type="button"
                onClick={() => {
                  const anyCollapsed = paginatedBatches.some(g => !expandedBatches[g.batchKey]);
                  if (anyCollapsed) {
                    const next: Record<string, boolean> = { ...expandedBatches };
                    paginatedBatches.forEach(g => {
                      next[g.batchKey] = true;
                    });
                    setExpandedBatches(next);
                  } else {
                    const next = { ...expandedBatches };
                    paginatedBatches.forEach(g => {
                      delete next[g.batchKey];
                    });
                    setExpandedBatches(next);
                  }
                }}
                className="px-3 py-2 rounded-xl border border-slate-800 bg-[#11141B] hover:bg-[#161B25] text-xs font-bold text-emerald-400 transition-colors cursor-pointer flex items-center gap-1.5"
              >
                {paginatedBatches.some(g => !expandedBatches[g.batchKey]) ? (
                  <>
                    <ChevronDown className="w-3.5 h-3.5" />
                    {t('order.expandAll')}
                  </>
                ) : (
                  <>
                    <ChevronUp className="w-3.5 h-3.5" />
                    {t('order.collapseAll')}
                  </>
                )}
              </button>
            )}
            {allOrderCollapseKeys.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  handleToggleCollapseOrderKeys(
                    allOrderCollapseKeys,
                    viewMode === 'batch' ? paginatedBatches.map(g => g.batchKey) : undefined
                  )
                }
                className="px-3 py-2 rounded-xl border border-slate-800 bg-[#11141B] hover:bg-[#161B25] text-xs font-bold text-sky-400 transition-colors cursor-pointer flex items-center gap-1.5"
              >
                {allOrderCollapseKeys.some(k => !expandedOrders[k]) ? (
                  <>
                    <Maximize2 className="w-3.5 h-3.5" />
                    {t('order.expandAllOrders')}
                  </>
                ) : (
                  <>
                    <Minimize2 className="w-3.5 h-3.5" />
                    {t('order.collapseAllOrders')}
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Control Panel */}
      <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {/* Search */}
          <div className="relative lg:col-span-2">
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-[10px] font-bold text-slate-400 uppercase">{t('order.searchBatchSku')}</label>
              <button
                type="button"
                onClick={() => {
                  if (activeBatchKeywords.length > 0 && !batchRawInput) {
                    setBatchRawInput(activeBatchKeywords.join('\n'));
                  }
                  setIsBatchModalOpen(true);
                }}
                className="text-[10px] text-blue-400 hover:text-blue-300 font-bold flex items-center gap-1 transition-colors cursor-pointer"
                title="Buka Batch Query (Pencarian massal banyak nomor sekaligus)"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>{t('order.batchQuery')}</span>
              </button>
            </div>
            <div className="relative flex items-center">
              <input
                type="text"
                placeholder={t('order.searchBatchPlaceholder')}
                title="Ketik pencarian atau Double-Click untuk membuka Batch Query (Pencarian Massal)"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onDoubleClick={() => {
                  if (activeBatchKeywords.length > 0 && !batchRawInput) {
                    setBatchRawInput(activeBatchKeywords.join('\n'));
                  }
                  setIsBatchModalOpen(true);
                }}
                className="w-full pl-9 pr-20 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none placeholder:text-slate-500"
              />
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5 pointer-events-none" />
              <button
                type="button"
                onClick={() => {
                  if (activeBatchKeywords.length > 0 && !batchRawInput) {
                    setBatchRawInput(activeBatchKeywords.join('\n'));
                  }
                  setIsBatchModalOpen(true);
                }}
                title="Double-Click kolom atau klik tombol ini untuk membuka Batch Query"
                className="absolute right-1.5 top-1.5 px-2 py-1 bg-blue-600/80 hover:bg-blue-600 text-white rounded text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer shadow-sm"
              >
                <Camera className="w-3 h-3" />
                <span>Batch</span>
              </button>
            </div>
          </div>

          {/* Batch Filter */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">{t('order.filterBatch')}</label>
            <select
              value={batchFilter}
              onChange={(e) => setBatchFilter(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer font-mono"
            >
              <option value="ALL">{t('order.allBatches')} ({uniqueBatches.length})</option>
              {batchSelectOptions}
            </select>
          </div>

          {/* Customer Filter */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">{t('order.filterCustomer')}</label>
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer"
            >
              <option value="ALL">{t('order.allCustomers')} ({uniqueCustomers.length})</option>
              {customerSelectOptions}
            </select>
          </div>

          {/* Date Filter: Start Date */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">{t('order.startDate')}</label>
            <div className="relative">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer"
              />
              <Calendar className="w-4 h-4 text-emerald-400 absolute left-3 top-2.5" />
            </div>
          </div>

          {/* Date Filter: End Date */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">{t('order.endDate')}</label>
            <div className="relative">
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer"
              />
              <Calendar className="w-4 h-4 text-emerald-400 absolute left-3 top-2.5" />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between pt-2 border-t border-slate-800/40 gap-2">
          {/* Status quick pills & Reset Filters button */}
          <div className="flex flex-wrap items-center gap-2">
            {(['ALL', 'Completed', 'Pending', 'Cancelled'] as const).map(st => (
              <button
                key={st}
                type="button"
                onClick={() => {
                  setStatusFilter(st);
                  if (st === 'Cancelled') setShowCancelled(true);
                }}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                  statusFilter === st
                    ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                    : 'bg-[#161B25] text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                {st === 'ALL' ? t('order.statusAll') : st === 'Completed' ? t('order.statusCompleted') : st === 'Pending' ? t('order.statusPending') : t('order.statusCancelled')}
              </button>
            ))}

            {(searchTerm || customerFilter !== 'ALL' || batchFilter !== 'ALL' || statusFilter !== 'ALL' || startDate || endDate || activeBatchKeywords.length > 0) && (
              <button
                onClick={() => {
                  setSearchTerm('');
                  setCustomerFilter('ALL');
                  setBatchFilter('ALL');
                  setStatusFilter('ALL');
                  setStartDate('');
                  setEndDate('');
                  setActiveBatchKeywords([]);
                  setBatchRawInput('');
                }}
                className="text-[11px] font-bold text-emerald-400 hover:text-emerald-350 cursor-pointer flex items-center gap-1.5 ml-2"
              >
                {t('order.resetFilters')}
              </button>
            )}
          </div>

          {/* Sort Controls */}
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase">{t('order.sortBy')}</span>
            <div className="flex gap-2">
              <button
                onClick={() => toggleSort('timestamp')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${sortBy === 'timestamp' ? 'bg-slate-800 border-emerald-500/20 text-emerald-400' : 'bg-[#161B25] border-slate-800 text-slate-400 hover:text-white'}`}
              >
                <Calendar className="w-3.5 h-3.5" />
                Waktu {sortBy === 'timestamp' && (sortOrder === 'asc' ? '▲' : '▼')}
              </button>
              <button
                onClick={() => toggleSort('qty')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${sortBy === 'qty' ? 'bg-slate-800 border-emerald-500/20 text-emerald-400' : 'bg-[#161B25] border-slate-800 text-slate-400 hover:text-white'}`}
              >
                <Layers className="w-3.5 h-3.5" />
                Qty {sortBy === 'qty' && (sortOrder === 'asc' ? '▲' : '▼')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Active Batch Query Banner */}
      {activeBatchKeywords.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-blue-950/40 border border-blue-500/40 rounded-xl text-xs text-blue-200 shadow-md">
          <div className="flex items-center gap-2.5">
            <span className="px-2.5 py-1 bg-blue-500/20 border border-blue-500/30 text-blue-300 rounded-md font-bold text-[11px] flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5" />
              Batch Query Aktif
            </span>
            <span className="text-slate-200">
              Menyaring berdasarkan <strong className="text-white font-mono">{activeBatchKeywords.length}</strong> kata kunci (Target: <strong className="text-white">{batchTargetField === 'all' ? 'Semua Kolom' : batchTargetField === 'order' ? 'Nomor Order / Ref' : batchTargetField === 'sku' ? 'SKU ID' : 'PO / Batch'}</strong>, Mode: <strong className="text-white">{batchMatchMode === 'exact' ? 'Exact Match' : 'Contains'}</strong>)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setBatchRawInput(activeBatchKeywords.join('\n'));
                setIsBatchModalOpen(true);
              }}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-lg text-xs transition-colors cursor-pointer"
            >
              Ubah Query
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveBatchKeywords([]);
                setBatchRawInput('');
              }}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-lg text-xs transition-colors cursor-pointer"
            >
              Hapus Filter Batch
            </button>
          </div>
        </div>
      )}

      {renderPaginationBar('top')}

      {/* VIEW MODE 1: GROUPED PER BATCH NUMBER */}
      {viewMode === 'batch' ? (
        <div className="space-y-4">
          {groupedByBatch.length === 0 ? (
            <div className="bg-[#11141B] rounded-xl border border-slate-800/60 py-14 text-center text-slate-500 font-medium shadow-xl">
              <ShoppingBag className="w-8 h-8 mx-auto mb-2 text-slate-600 stroke-1" />
              {!showCancelled && cancelledCount > 0
                ? 'Tidak ada riwayat batch aktif yang cocok. Aktifkan “Tampilkan yang dibatalkan” untuk melihat riwayat pembatalan.'
                : 'Belum ada riwayat batch transaksi order yang cocok atau diproses.'}
            </div>
          ) : (
            paginatedBatches.map(group => {
              const isCollapsed = !expandedBatches[group.batchKey];
              const batchIds = group.items.map(i => i.id);
              const allBatchSelected = batchIds.length > 0 && batchIds.every(id => selectedIdSet.has(id));
              const someBatchSelected = batchIds.length > 0 && batchIds.some(id => selectedIdSet.has(id)) && !allBatchSelected;
              const cancellableInBatch = group.items.filter(i => i.status !== 'Cancelled');
              const leadOrder = group.orderNumbers[0];
              const primaryLabel = leadOrder || group.refs[0] || group.batchKey;
              const primaryPrefix = leadOrder ? 'Order' : 'Ref';

              return (
                <div
                  key={group.batchKey}
                  className="bg-[#11141B] rounded-xl border border-slate-800/75 overflow-hidden shadow-lg transition-all"
                >
                  {/* Batch Card Header */}
                  <div className="bg-[#151922] px-5 py-4 border-b border-slate-800/70 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex items-start sm:items-center gap-3.5 flex-wrap">
                      <input
                        type="checkbox"
                        checked={allBatchSelected}
                        ref={el => {
                          if (el) el.indeterminate = someBatchSelected;
                        }}
                        onChange={() => handleToggleSelectBatch(group.items)}
                        className="w-4 h-4 mt-1 sm:mt-0 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                        title={`Pilih semua item di Batch ${group.batchKey}`}
                      />

                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="inline-flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1.5 font-mono text-sm font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-3 py-1 rounded-lg">
                              <FileText className="w-4 h-4 shrink-0" />
                              {primaryPrefix}: {primaryLabel}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => handleCopyText(primaryLabel, `order-lead-${group.batchKey}`, e)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[#161B25] hover:bg-emerald-500/15 border border-slate-700/60 hover:border-emerald-500/40 text-slate-300 hover:text-emerald-400 text-xs font-semibold transition-all cursor-pointer shadow-sm active:scale-95"
                              title={leadOrder ? 'Klik untuk salin No Order' : 'Salin Referensi'}
                              aria-label={leadOrder ? `Salin No Order ${primaryLabel}` : `Salin Referensi ${primaryLabel}`}
                            >
                              {copiedKey === `order-lead-${group.batchKey}` ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                  <span className="text-[11px] text-emerald-400 font-bold">Tersalin!</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  <span className="text-[11px]">Salin</span>
                                </>
                              )}
                            </button>
                            {group.orderNumbers.length > 1 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedBatches(prev => ({
                                    ...prev,
                                    [group.batchKey]: !prev[group.batchKey]
                                  }))
                                }
                                className="inline-flex items-center px-2 py-1 rounded-lg bg-[#161B25] hover:bg-slate-800 border border-slate-700/70 text-[11px] font-bold text-sky-300 transition-colors cursor-pointer"
                                title={`Lihat semua ${group.orderNumbers.length} No Order di batch ini`}
                              >
                                +{group.orderNumbers.length - 1} order
                              </button>
                            )}
                          </div>

                          <span
                            className={`px-2.5 py-0.5 rounded-md text-[10px] font-extrabold uppercase ${
                              group.groupStatus === 'Cancelled'
                                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                : group.groupStatus === 'Pending'
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse'
                                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            }`}
                          >
                            {group.groupStatus === 'Cancelled' ? 'Dibatalkan' : group.groupStatus}
                          </span>

                          <span className="text-xs font-mono text-slate-400 flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-slate-500" />
                            {formatToWibString(group.latestTimestamp)}
                          </span>
                        </div>

                        {/* Metadata Pills: Batch, Ref, PO, Customer */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-xs text-slate-300">
                          {group.customers.length > 0 && (
                            <span className="flex items-center gap-1 font-bold text-slate-200">
                              <User className="w-3.5 h-3.5 text-sky-400" />
                              {group.customers.join(', ')}
                            </span>
                          )}
                          {group.customerAddresses.length === 1 && (
                            <span className="flex items-start gap-1 text-slate-300 break-words">
                              <MapPin className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                              <span className="whitespace-pre-line">{group.customerAddresses[0]}</span>
                            </span>
                          )}
                          {group.customerAddresses.length > 1 && (
                            <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-300">
                              <MapPin className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              {group.customerAddresses.length} {language === 'en' ? 'customer addresses' : 'alamat customer'}
                            </span>
                          )}
                          <div className="inline-flex items-center gap-1.5 font-mono text-slate-300">
                            <span className="flex items-center gap-1">
                              <Layers className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              BATCH:{' '}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => handleCopyText(group.batchKey, `batch-${group.batchKey}`, e)}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#161B25] hover:bg-emerald-500/15 border border-slate-700/60 hover:border-emerald-500/40 text-slate-200 hover:text-emerald-300 text-xs font-bold transition-all cursor-pointer group active:scale-95"
                              title="Salin Batch Number"
                              aria-label={`Salin Batch Number ${group.batchKey}`}
                            >
                              <strong>{group.batchKey}</strong>
                              {copiedKey === `batch-${group.batchKey}` ? (
                                <span className="inline-flex items-center text-[10px] text-emerald-300 font-sans font-semibold">
                                  <Check className="w-3 h-3 text-emerald-300 mr-0.5" />
                                  Tersalin!
                                </span>
                              ) : (
                                <Copy className="w-3 h-3 text-slate-400 group-hover:text-emerald-300 transition-colors" />
                              )}
                            </button>
                          </div>
                          {group.poNumbers.length > 0 && (
                            <span className="flex items-center gap-1 font-mono text-slate-300">
                              <Tag className="w-3.5 h-3.5 text-amber-400" />
                              PO: <strong>{group.poNumbers.join(', ')}</strong>
                            </span>
                          )}
                          {group.refs.some(r => r !== group.batchKey && r !== primaryLabel) && (
                            <span className="text-[11px] font-mono text-slate-400">
                              Ref: {group.refs.filter(r => r !== primaryLabel).join(', ')}
                            </span>
                          )}
                          {renderBasketBadges(group.masterBaskets, group.sortBaskets)}
                        </div>
                      </div>
                    </div>

                    {/* Right Side Summary Metrics & Batch Actions */}
                    <div className="flex flex-wrap items-center justify-between lg:justify-end gap-3">
                      <div className="flex items-center gap-2">
                        <div className="bg-[#11141B] border border-slate-800 px-3 py-1.5 rounded-lg text-center">
                          <span className="block text-[9px] font-bold text-slate-400 uppercase">Total SKU</span>
                          <span className="font-mono text-xs font-black text-slate-200">
                            {group.uniqueSkuCount} SKU <span className="text-[10px] font-normal text-slate-400">({group.items.length} rak)</span>
                          </span>
                        </div>
                        <div className="bg-[#11141B] border border-slate-800 px-3 py-1.5 rounded-lg text-center">
                          <span className="block text-[9px] font-bold text-slate-400 uppercase">Total Keluar</span>
                          <span className="font-mono text-xs font-black text-rose-400">
                            {formatNumber(group.totalQty)} Pcs
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {group.groupStatus !== 'Cancelled' && (
                          <button
                            type="button"
                            onClick={() => openReceiptForItems(group.items, group.batchKey)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 px-3 py-1.5 text-xs font-bold text-indigo-400 transition-colors cursor-pointer"
                            title={`Cetak resi untuk seluruh item di Batch ${group.batchKey}`}
                          >
                            <Printer className="w-3.5 h-3.5" />
                            Print Resi Batch
                          </button>
                        )}

                        {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') &&
                          cancellableInBatch.length > 0 && (
                            <button
                              type="button"
                              onClick={() => handleCancelBatch(group.batchKey, group.items)}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 px-2.5 py-1.5 text-xs font-bold text-rose-400 transition-colors cursor-pointer"
                              title={`Batalkan seluruh item di Batch ${group.batchKey}`}
                            >
                              <X className="w-3.5 h-3.5" />
                              Batalkan Batch
                            </button>
                          )}

                        <button
                          type="button"
                          onClick={() =>
                            setExpandedBatches(prev => ({
                              ...prev,
                              [group.batchKey]: !prev[group.batchKey]
                            }))
                          }
                          className="p-1.5 rounded-lg bg-[#161B25] hover:bg-slate-800 text-slate-300 border border-slate-800 transition-colors cursor-pointer"
                          title={isCollapsed ? 'Tampilkan rincian SKU' : 'Sembunyikan rincian SKU'}
                        >
                          {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Batch Operators Summary Strip */}
                  <div className="bg-[#161B25] px-5 py-2 border-b border-slate-800/50 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                      <span className="text-slate-400">
                        Input: <strong className="text-slate-200">{group.createdBy || 'Belum tercatat'}</strong>
                      </span>
                      <span className="text-slate-400">
                        Picking: <strong className="text-slate-200">{group.pickedBy || 'Belum tercatat'}</strong>
                      </span>
                      <span className="text-slate-400">
                        Sortir: <strong className="text-slate-200">{group.sortedBy || 'Belum tercatat'}</strong>
                      </span>
                      <span className="text-slate-400">
                        Packing: <strong className="text-slate-200">{group.packedBy || 'Belum tercatat'}</strong>
                      </span>
                    </div>

                    {!isCollapsed && group.orderGroups.length > 0 && (() => {
                      const batchOrderKeys = group.orderGroups.map(o => o.collapseKey);
                      const anyBatchOrderCollapsed = batchOrderKeys.some(k => !expandedOrders[k]);
                      return (
                        <button
                          type="button"
                          onClick={() => handleToggleCollapseOrderKeys(batchOrderKeys)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-700/70 bg-[#11141B] hover:bg-slate-800 text-[11px] font-bold text-sky-400 transition-colors cursor-pointer"
                          title={anyBatchOrderCollapsed ? 'Maximize semua order dalam batch ini' : 'Minimize semua order dalam batch ini'}
                        >
                          {anyBatchOrderCollapsed ? (
                            <>
                              <Maximize2 className="w-3 h-3" />
                              <span>{t('order.maximizeOrder')} ({group.orderGroups.length} Order)</span>
                            </>
                          ) : (
                            <>
                              <Minimize2 className="w-3 h-3" />
                              <span>{t('order.minimizeOrder')} ({group.orderGroups.length} Order)</span>
                            </>
                          )}
                        </button>
                      );
                    })()}
                  </div>

                  {/* Batch Items Grouped per No Order */}
                  {!isCollapsed && (
                    <div className="p-3 sm:p-4 space-y-3 bg-[#0E121A]/60">
                      {group.orderGroups.map(orderGroup => renderOrderCard(orderGroup))}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Footer info counts for Batch View */}
          <div className="bg-[#151922] px-5 py-3.5 rounded-xl border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-400 font-medium">
            <div>
              Menampilkan <span className="text-white font-bold">{paginatedBatches.length} / {groupedByBatch.length} Batch</span> · <span className="text-white font-bold">{groupedByOrder.length} Order</span> (<span className="text-white font-bold">{filteredHistory.length}</span> baris alokasi SKU)
            </div>
            <div>
              Total Volume Keluar (Completed):{' '}
              <span className="text-rose-400 font-bold">
                {formatNumber(completedVolumeQty)} Pcs
              </span>
            </div>
          </div>
          {renderPaginationBar('bottom')}
        </div>
      ) : viewMode === 'order' ? (
        /* VIEW MODE 2: GROUPED PER ORDER NUMBER */
        <div className="space-y-3">
          {groupedByOrder.length === 0 ? (
            <div className="bg-[#11141B] rounded-xl border border-slate-800/60 py-14 text-center text-slate-500 font-medium shadow-xl">
              <ShoppingBag className="w-8 h-8 mx-auto mb-2 text-slate-600 stroke-1" />
              {!showCancelled && cancelledCount > 0
                ? 'Tidak ada riwayat order aktif yang cocok. Aktifkan “Tampilkan yang dibatalkan” untuk melihat riwayat pembatalan.'
                : 'Belum ada riwayat transaksi order yang cocok atau diproses.'}
            </div>
          ) : (
            paginatedOrders.map(orderGroup => renderOrderCard(orderGroup, { showBatchBadge: true }))
          )}

          {/* Footer info counts for Order View */}
          <div className="bg-[#151922] px-5 py-3.5 rounded-xl border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-400 font-medium">
            <div>
              Menampilkan <span className="text-white font-bold">{paginatedOrders.length} / {groupedByOrder.length} Order</span> (<span className="text-white font-bold">{filteredHistory.length}</span> baris alokasi SKU)
            </div>
            <div>
              Total Volume Keluar (Completed):{' '}
              <span className="text-rose-400 font-bold">
                {formatNumber(completedVolumeQty)} Pcs
              </span>
            </div>
          </div>
          {renderPaginationBar('bottom')}
        </div>
      ) : (
        /* VIEW MODE 3: FLAT TABLE */
        <div className="bg-[#11141B] rounded-xl border border-slate-800/60 overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#151922] text-slate-400 uppercase font-bold text-[10px] border-b border-slate-800/80">
                  <th className="py-3 px-4 text-center w-12">
                    <input 
                      type="checkbox"
                      checked={isAllSelected}
                      ref={el => {
                        if (el) {
                          el.indeterminate = isSomeSelected;
                        }
                      }}
                      onChange={handleToggleSelectAll}
                      className="w-4 h-4 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                    />
                  </th>
                  <th className="py-3 px-4">Waktu Keluar</th>
                  <th className="py-3 px-4">Order / No PO</th>
                  <th className="py-3 px-4">Batch Number</th>
                  <th className="py-3 px-4">{t('order.customerName')} / {t('order.customerAddress')}</th>
                  <th className="py-3 px-4">SKU / Nama Barang</th>
                  <th className="py-3 px-4 text-center">Expired</th>
                  <th className="py-3 px-4 text-center">Lokasi Rak</th>
                  <th className="py-3 px-4 text-right">Qty (Pcs)</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 min-w-[280px]">Petugas & Waktu Proses (WIB)</th>
                  <th className="py-3 px-4 text-center w-28">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50 text-slate-300 text-xs">
                {filteredHistory.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-12 text-center text-slate-500 font-medium">
                      <ShoppingBag className="w-8 h-8 mx-auto mb-2 text-slate-600 stroke-1" />
                      {!showCancelled&&cancelledCount>0?'Tidak ada riwayat aktif yang cocok. Aktifkan “Tampilkan yang dibatalkan” untuk melihat riwayat pembatalan.':'Belum ada riwayat transaksi order yang cocok atau diproses.'}
                    </td>
                  </tr>
                ) : (
                  paginatedFlatItems.map((item) => (
                    <tr 
                      key={item.id} 
                      className={`hover:bg-slate-800/20 transition-colors ${selectedIdSet.has(item.id) ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : ''}`}
                    >
                      <td className="py-3 px-4 text-center">
                        <input 
                          type="checkbox"
                          checked={selectedIdSet.has(item.id)}
                          onChange={() => handleToggleSelectRow(item.id)}
                          className="w-4 h-4 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                        />
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-slate-400 font-mono">
                        {formatToWibString(item.timestamp)}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-200 space-y-0.5">
                        {item.orderNumber ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={(e) => handleCopyText(item.orderNumber!, `order-flat-${item.id}`, e)}
                              className="inline-flex items-center gap-1 font-bold text-slate-200 hover:text-emerald-300 bg-transparent hover:bg-emerald-500/10 px-1 py-0.5 rounded transition-colors cursor-pointer group active:scale-95"
                              title="Klik untuk salin No Order"
                              aria-label={`Salin No Order ${item.orderNumber}`}
                            >
                              <FileText className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              <span>{item.orderNumber}</span>
                              {copiedKey === `order-flat-${item.id}` ? (
                                <span className="inline-flex items-center text-[10px] text-emerald-300 font-sans font-semibold ml-1">
                                  <Check className="w-3 h-3 text-emerald-300 mr-0.5" />
                                  Tersalin!
                                </span>
                              ) : (
                                <Copy className="w-3 h-3 text-slate-500 group-hover:text-emerald-300 transition-colors ml-0.5" />
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-slate-500 font-normal italic block">Order: -</span>
                        )}
                        {item.noPo && (
                          <span className="flex items-center gap-1 text-[11px] text-slate-300">
                            <Tag className="w-3 h-3 text-amber-400" />
                            PO: {item.noPo}
                          </span>
                        )}
                        {(() => {
                          const { masterBasket, sortBasket } = resolveItemBasketCodes(item);
                          if (!masterBasket && !sortBasket) return null;
                          return (
                            <div className="flex flex-wrap items-center gap-1 mt-0.5">
                              {renderBasketBadges(masterBasket ? [masterBasket] : [], sortBasket ? [sortBasket] : [])}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-3 px-4 font-mono font-bold">
                        <div className="inline-flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded text-[11px]">
                            <Layers className="w-3 h-3" />
                            {getBatchKey(item)}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => handleCopyText(getBatchKey(item), `batch-flat-${item.id}`, e)}
                            className="p-1 rounded bg-[#161B25] hover:bg-emerald-500/15 border border-slate-700/60 hover:border-emerald-500/30 text-slate-400 hover:text-emerald-300 transition-colors cursor-pointer active:scale-95"
                            title="Salin Batch Number"
                            aria-label={`Salin Batch Number ${getBatchKey(item)}`}
                          >
                            {copiedKey === `batch-flat-${item.id}` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="py-3 px-4 font-semibold text-slate-200 max-w-xs">
                        {item.customerName ? (
                          <span className="flex items-center gap-1">
                            <User className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                            <span>{item.customerName}</span>
                          </span>
                        ) : (
                          <span className="text-slate-500 font-normal italic">N/A</span>
                        )}
                        {resolveCustomerAddress(item) && (
                          <div className="flex items-start gap-1 mt-1 text-[11px] font-normal text-slate-300 leading-snug break-words">
                            <MapPin className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                            <span className="whitespace-pre-line">{resolveCustomerAddress(item)}</span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => handleCopyText(item.skuId, `sku-flat-${item.id}`, e)}
                            className="inline-flex items-center gap-1 font-mono font-bold text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 hover:border-emerald-500/40 px-1.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer group active:scale-95"
                            title="Klik untuk salin SKU ID"
                            aria-label={`Salin SKU ID ${item.skuId}`}
                          >
                            <span>{item.skuId}</span>
                            {copiedKey === `sku-flat-${item.id}` ? (
                              <span className="inline-flex items-center text-[10px] text-emerald-300 font-sans font-semibold">
                                <Check className="w-3 h-3 text-emerald-300 mr-0.5" />
                                Tersalin!
                              </span>
                            ) : (
                              <Copy className="w-3 h-3 text-emerald-500/60 group-hover:text-emerald-300 transition-colors" />
                            )}
                          </button>
                          <span className="font-medium text-slate-300">{item.skuName}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1">
                          Ref Doc: {item.referenceNumber}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-center whitespace-nowrap font-mono">
                        {item.expiredDate}
                      </td>
                      <td className="py-3 px-4 text-center font-mono font-bold text-slate-200">
                        {item.location}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-rose-400 font-mono">
                        {formatNumber(item.qty)}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ${
                          item.status === 'Cancelled' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : item.status === 'Pending'
                            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse'
                            : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        }`}>
                          {item.status==='Cancelled'?'Dibatalkan':item.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 align-top min-w-[280px]">
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                          {getOrderStageHistory(item).map(({stage,name,processedAt,timeLabel})=>(
                            <React.Fragment key={stage}>
                              <dt className="font-semibold text-slate-400">{stage}:</dt>
                              <dd className="font-bold text-slate-200 break-words">
                                <span>{name}</span>
                                {timeLabel==='Belum tercatat' ? (
                                  <span className="block font-normal text-slate-500 text-[10px]">Waktu belum tercatat</span>
                                ) : (
                                  <time dateTime={processedAt} className="block font-normal text-slate-400 text-[10px] tabular-nums">{timeLabel}</time>
                                )}
                              </dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      </td>
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {item.status!=='Cancelled' && (
                          <button
                            type="button"
                            aria-label={'Print ulang resi '+(item.orderNumber||item.referenceNumber)}
                            title="Print ulang resi seluruh barang dalam order ini"
                            onClick={()=>printReceipt(item)}
                            className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 px-2.5 py-1 text-xs font-bold text-indigo-400 mr-2 cursor-pointer transition-colors"
                          >
                            <Printer size={14}/>Print Resi
                          </button>
                        )}
                        {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && item.status!=='Cancelled' ? (
                          <>
                            <button
                              onClick={() => handleStartEdit(item)}
                              className="p-1 text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 rounded transition-colors mr-2 cursor-pointer inline-flex items-center"
                              title="Edit"
                            >
                              <Edit className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(item)}
                              className="p-1 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-colors cursor-pointer inline-flex items-center"
                              title="Batalkan order" aria-label="Batalkan order"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </>
                        ) : (
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">{item.status==='Cancelled'?'Dibatalkan':'Hanya lihat'}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          
          {/* Footer info counts */}
          <div className="bg-[#151922] px-4 py-3 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-400 font-medium">
            <div>
              Menampilkan <span className="text-white font-bold">{paginatedFlatItems.length} / {filteredHistory.length}</span> baris riwayat order dalam <span className="text-white font-bold">{groupedByBatch.length}</span> Batch
            </div>
            <div>
              Total Volume Keluar: <span className="text-rose-400 font-bold">{formatNumber(completedVolumeQty)} Pcs</span>
            </div>
          </div>
        </div>
      )}

      {viewMode === 'flat' && renderPaginationBar('bottom')}

      {receiptOrder&&createPortal(<div className="theme-citrus fixed inset-0 z-[210]"><ShippingReceiptModal isOpen={true} onClose={()=>setReceiptOrder(null)} order={receiptOrder} currentUser={currentUser} autoPrint={false}/></div>,document.body)}
      {/* Edit Modal Dialog */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-[#0E121A] border border-slate-800/80 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-850 bg-[#121722]">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <Edit className="w-4 h-4 text-emerald-400" />
                Edit Riwayat Transaksi Order (Barang Keluar)
              </h3>
              <button 
                onClick={() => setEditingItem(null)}
                className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => handleCopyText(editingItem.skuId, `sku-edit-${editingItem.id}`, e)}
                  className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 uppercase bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 px-2 py-0.5 rounded font-mono transition cursor-pointer active:scale-95"
                  title="Salin SKU ID"
                  aria-label={`Salin SKU ID ${editingItem.skuId}`}
                >
                  <span>{editingItem.skuId}</span>
                  {copiedKey === `sku-edit-${editingItem.id}` ? (
                    <span className="inline-flex items-center text-[9px] text-emerald-300 font-sans font-semibold">
                      <Check className="w-3 h-3 text-emerald-300 mr-0.5" />
                      Tersalin!
                    </span>
                  ) : (
                    <Copy className="w-3 h-3 text-emerald-500/70" />
                  )}
                </button>
                <span className="text-xs font-semibold text-slate-300">{editingItem.skuName}</span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-emerald-400 uppercase mb-1">Batch Number</label>
                  <input
                    type="text"
                    value={editBatchNumber}
                    onChange={(e) => setEditBatchNumber(e.target.value)}
                    placeholder="Contoh: BATCH-01"
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-emerald-500/30 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Order Number</label>
                  <input
                    type="text"
                    value={editOrderNumber}
                    onChange={(e) => setEditOrderNumber(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">No PO</label>
                  <input
                    type="text"
                    value={editNoPo}
                    onChange={(e) => setEditNoPo(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Customer Name</label>
                <input
                  type="text"
                  value={editCustomerName}
                  onChange={(e) => setEditCustomerName(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">{t('order.customerAddress')}</label>
                <textarea
                  rows={2}
                  value={editCustomerAddress}
                  onChange={(e) => setEditCustomerAddress(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none"
                  placeholder="Alamat tujuan pelanggan (opsional)"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Lokasi Rak</label>
                  <input
                    type="text"
                    value={editLocation}
                    onChange={(e) => setEditLocation(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none font-mono uppercase"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Expired Date</label>
                  <input
                    type="text"
                    value={editExpiredDate}
                    onChange={(e) => setEditExpiredDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none font-mono"
                    placeholder="YYYY-MM-DD"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Qty (Pcs)</label>
                  <input
                    type="number"
                    value={editQty}
                    onChange={(e) => setEditQty(Math.max(0, parseInt(e.target.value) || 0))}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 bg-[#121722] border-t border-slate-850">
              <button
                onClick={() => setEditingItem(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
              >
                Simpan Perubahan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirmation Modal Dialog */}
      {confirmDialog.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-sm">
          <div className="w-full max-w-md bg-[#0E121A] border border-slate-800/80 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Body */}
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl ${
                  confirmDialog.type === 'danger' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                }`}>
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <h3 className="text-sm font-black text-slate-100">{confirmDialog.title}</h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-line bg-[#131722] p-4 rounded-xl border border-slate-800/50">
                {confirmDialog.message}
              </p>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 bg-[#121722] border-t border-slate-850">
              <button
                onClick={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                onClick={confirmDialog.onConfirm}
                className={`px-4 py-2 text-white font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer ${
                  confirmDialog.type === 'danger' ? 'bg-rose-600 hover:bg-rose-500 shadow-rose-900/15' : 'bg-amber-600 hover:bg-amber-500 shadow-amber-900/15'
                }`}
              >
                Lanjut pembatalan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Query (Pencarian Massal) Modal Dialog */}
      {isBatchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-xl bg-[#0E121A] border border-slate-800/80 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 bg-[#121722] border-b border-slate-850">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-lg">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-100">{t('order.batchModalTitle')}</h3>
                  <p className="text-[11px] text-slate-400">{t('order.batchModalSubtitle')}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsBatchModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Target Kolom</label>
                  <select
                    value={batchTargetField}
                    onChange={(e) => setBatchTargetField(e.target.value as any)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none cursor-pointer"
                  >
                    <option value="all">Semua Kolom (Order, Ref, SKU, PO, Batch)</option>
                    <option value="order">Nomor Order / No. Ref Saja</option>
                    <option value="sku">SKU ID Saja</option>
                    <option value="po_batch">No. PO & Batch Saja</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Metode Pencocokan</label>
                  <select
                    value={batchMatchMode}
                    onChange={(e) => setBatchMatchMode(e.target.value as any)}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none cursor-pointer"
                  >
                    <option value="exact">Pencocokan Persis (Exact Match - Disarankan)</option>
                    <option value="contains">Mengandung Teks (Contains)</option>
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase">
                    Daftar Nomor / Kata Kunci
                  </label>
                  <span className="text-[10px] font-mono text-blue-400 font-bold">
                    {detectedKeywords.length} kata kunci terdeteksi
                  </span>
                </div>
                <textarea
                  rows={8}
                  value={batchRawInput}
                  onChange={(e) => setBatchRawInput(e.target.value)}
                  placeholder={`Tempel daftar nomor di sini (dari Excel / Sheets / Notepad)...
Contoh:
ORD-20261111-001
ORD-20261111-002
1007-05
(Pemisah baris baru, koma, titik koma, atau tab otomatis dipisahkan)`}
                  className="w-full px-3 py-2 text-xs font-mono bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none placeholder:text-slate-600 leading-relaxed"
                />
              </div>

              {detectedKeywords.length > 0 && (
                <div className="bg-[#131722] p-3 rounded-xl border border-slate-800/60 space-y-1.5">
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">
                    Preview Kata Kunci ({detectedKeywords.length > 8 ? `8 dari ${detectedKeywords.length}` : detectedKeywords.length}):
                  </span>
                  <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
                    {detectedKeywords.slice(0, 8).map((kw, i) => (
                      <span key={i} className="px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 text-blue-300 font-mono text-[10px] rounded">
                        {kw}
                      </span>
                    ))}
                    {detectedKeywords.length > 8 && (
                      <span className="px-2 py-0.5 text-slate-500 text-[10px]">
                        +{detectedKeywords.length - 8} lainnya...
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-6 py-4 bg-[#121722] border-t border-slate-850">
              <button
                type="button"
                onClick={() => setBatchRawInput('')}
                className="px-3 py-2 text-slate-400 hover:text-rose-400 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                {t('order.batchModalClear')}
              </button>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsBatchModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 font-bold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  {t('action.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const kws = parseBatchKeywords(batchRawInput);
                    setActiveBatchKeywords(kws);
                    setIsBatchModalOpen(false);
                  }}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer disabled:opacity-50"
                >
                  {language === 'en' ? `Apply Query (${detectedKeywords.length})` : `Terapkan Pencarian (${detectedKeywords.length})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
