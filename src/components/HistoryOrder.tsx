import {createPortal} from 'react-dom';
import ShippingReceiptModal,{type ShippingOrderData} from './ShippingReceiptModal';
import {getOrderStageHistory} from '../utils/orderStageHistory';
import React, { useState, useMemo, useEffect } from 'react';
import { OutboundItem } from '../types';
import { formatNumber, formatToWibString, normalizeDateToDmy, isZoneOrUrbanLocation } from '../utils/calculations';
import * as XLSX from 'xlsx';
import { 
  Printer,
  Search, 
  Calendar, 
  FileText, 
  ShoppingBag, 
  User, 
  Tag, 
  Layers, 
  FileSpreadsheet,
  Edit,
  Trash2,
  X,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  List
} from 'lucide-react';

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
  const [receiptOrder,setReceiptOrder]=useState<ShippingOrderData|null>(null);
  const getBatchKey = (item: OutboundItem) =>
    item.batchNumber?.trim() || item.referenceNumber?.trim() || item.orderNumber?.trim() || 'TANPA-BATCH';

  const openReceiptForItems = (items: OutboundItem[], batchLabel?: string) => {
    const activeItems = items.filter(i => i.status !== 'Cancelled');
    const sourceItems = activeItems.length > 0 ? activeItems : items;
    if (sourceItems.length === 0) return;
    const first = sourceItems[0];
    setReceiptOrder({
      referenceNumber: first.referenceNumber || batchLabel || '-',
      orderNumber: first.orderNumber,
      noPo: first.noPo,
      customerName: first.customerName,
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
      packerName: first.packedBy,
      pickerName: first.pickedBy,
      inputByName: first.createdBy
    });
  };

  const printReceipt = (item: OutboundItem) => {
    const bKey = getBatchKey(item);
    const sameBatchItems = orderHistory.filter(
      o => getBatchKey(o) === bKey && (o.referenceNumber === item.referenceNumber || !!item.batchNumber)
    );
    openReceiptForItems(sameBatchItems.length > 0 ? sameBatchItems : [item], bKey);
  };

  const [viewMode, setViewMode] = useState<'batch' | 'flat'>('batch');
  const [collapsedBatches, setCollapsedBatches] = useState<Record<string, boolean>>({});
  const [showCancelled,setShowCancelled]=useState(false);
  const cancelledCount=orderHistory.filter(item=>item.status==='Cancelled').length;
  const [searchTerm, setSearchTerm] = useState('');
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

  // Edit item states
  const [editingItem, setEditingItem] = useState<OutboundItem | null>(null);
  const [editBatchNumber, setEditBatchNumber] = useState('');
  const [editCustomerName, setEditCustomerName] = useState('');
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
    if(item.status==='Cancelled'||item.shipped)return;
    setConfirmDialog({
      isOpen: true,
      title: 'Batalkan Order',
      message: `Apakah Anda yakin ingin membatalkan order ini?\n\nSKU: ${item.skuId}\nCustomer: ${item.customerName || '-'}\nQty: ${formatNumber(item.qty)} Pcs\n\nRiwayat tetap disimpan. Stok hanya dikembalikan jika sebelumnya sudah dipotong dan barang belum dikirim.`,
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
    const itemsToDelete = filteredHistory.filter(item => selectedIds.includes(item.id)&&item.status!=='Cancelled'&&!item.shipped);
    if (itemsToDelete.length === 0) return;

    setConfirmDialog({
      isOpen: true,
      title: 'Batalkan Order Terpilih',
      message: `Apakah Anda yakin ingin membatalkan ${itemsToDelete.length} order terpilih?\n\nAnda akan diminta mengisi alasan. Order yang sudah dikirim tidak dapat dibatalkan.`,
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

  // List unique customers for filtering
  const uniqueCustomers = useMemo(() => {
    const customers = new Set<string>();
    orderHistory.forEach(item => {
      if (item.customerName) {
        customers.add(item.customerName);
      }
    });
    return Array.from(customers);
  }, [orderHistory]);

  // List unique batch numbers for filtering
  const uniqueBatches = useMemo(() => {
    const batches = new Set<string>();
    orderHistory.forEach(item => {
      const bKey = getBatchKey(item);
      if (bKey) batches.add(bKey);
    });
    return Array.from(batches);
  }, [orderHistory]);

  // Handle Sort
  const toggleSort = (field: 'timestamp' | 'qty') => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  // Filter and Search
  const filteredHistory = useMemo(() => {
    let result = orderHistory.filter(item => (showCancelled || statusFilter === 'Cancelled') || item.status !== 'Cancelled');

    // Filter by status
    if (statusFilter !== 'ALL') {
      result = result.filter(item => item.status === statusFilter);
    }

    // Filter by batch number
    if (batchFilter !== 'ALL') {
      result = result.filter(item => getBatchKey(item) === batchFilter);
    }

    // Filter by customer
    if (customerFilter !== 'ALL') {
      result = result.filter(item => item.customerName === customerFilter);
    }

    // Filter by date range
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      result = result.filter(item => new Date(item.timestamp) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      result = result.filter(item => new Date(item.timestamp) <= end);
    }

    // Search filter
    if (searchTerm.trim() !== '') {
      const term = searchTerm.toLowerCase();
      result = result.filter(item => 
        item.skuId.toLowerCase().includes(term) ||
        item.skuName.toLowerCase().includes(term) ||
        getBatchKey(item).toLowerCase().includes(term) ||
        (item.batchNumber && item.batchNumber.toLowerCase().includes(term)) ||
        (item.orderNumber && item.orderNumber.toLowerCase().includes(term)) ||
        (item.noPo && item.noPo.toLowerCase().includes(term)) ||
        (item.customerName && item.customerName.toLowerCase().includes(term)) ||
        item.referenceNumber.toLowerCase().includes(term) ||
        [item.createdBy,item.pickedBy,item.sortedBy,item.packedBy].some(name=>name?.toLowerCase().includes(term))
      );
    }

    // Sort
    result.sort((a, b) => {
      let valA = sortBy === 'timestamp' ? new Date(a.timestamp).getTime() : a.qty;
      let valB = sortBy === 'timestamp' ? new Date(b.timestamp).getTime() : b.qty;

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [orderHistory, searchTerm, customerFilter, batchFilter, statusFilter, sortBy, sortOrder, startDate, endDate, showCancelled]);

  const groupedByBatch = useMemo(() => {
    const map = new Map<string, OutboundItem[]>();
    filteredHistory.forEach(item => {
      const bKey = getBatchKey(item);
      const list = map.get(bKey) || [];
      list.push(item);
      map.set(bKey, list);
    });

    const groups = Array.from(map.entries()).map(([batchKey, items]) => {
      const latestTimestamp = items.reduce((latest, it) => {
        return new Date(it.timestamp).getTime() > new Date(latest).getTime() ? it.timestamp : latest;
      }, items[0].timestamp);
      const totalQty = items.filter(i => i.status !== 'Cancelled').reduce((sum, it) => sum + it.qty, 0);
      const rawTotalQty = items.reduce((sum, it) => sum + it.qty, 0);
      const uniqueSkuCount = new Set(items.map(i => i.skuId)).size;
      const refs = Array.from(new Set(items.map(i => i.referenceNumber).filter(Boolean)));
      const orderNumbers = Array.from(new Set(items.map(i => i.orderNumber).filter(Boolean))) as string[];
      const poNumbers = Array.from(new Set(items.map(i => i.noPo).filter(Boolean))) as string[];
      const customers = Array.from(new Set(items.map(i => i.customerName).filter(Boolean))) as string[];

      const allCancelled = items.every(i => i.status === 'Cancelled');
      const allCompleted = items.filter(i => i.status !== 'Cancelled').every(i => i.status === 'Completed');
      const hasPending = items.some(i => i.status === 'Pending');
      const groupStatus: 'Completed' | 'Pending' | 'Cancelled' = allCancelled
        ? 'Cancelled'
        : hasPending
        ? 'Pending'
        : allCompleted
        ? 'Completed'
        : 'Pending';

      const createdBy = Array.from(new Set(items.map(i => i.createdBy).filter(Boolean))).join(', ');
      const pickedBy = Array.from(new Set(items.map(i => i.pickedBy).filter(Boolean))).join(', ');
      const sortedBy = Array.from(new Set(items.map(i => i.sortedBy).filter(Boolean))).join(', ');
      const packedBy = Array.from(new Set(items.map(i => i.packedBy).filter(Boolean))).join(', ');

      return {
        batchKey,
        items,
        latestTimestamp,
        totalQty: totalQty || rawTotalQty,
        uniqueSkuCount,
        refs,
        orderNumbers,
        poNumbers,
        customers,
        groupStatus,
        createdBy,
        pickedBy,
        sortedBy,
        packedBy
      };
    });

    groups.sort((a, b) => {
      const valA = sortBy === 'timestamp' ? new Date(a.latestTimestamp).getTime() : a.totalQty;
      const valB = sortBy === 'timestamp' ? new Date(b.latestTimestamp).getTime() : b.totalQty;
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return groups;
  }, [filteredHistory, sortBy, sortOrder]);

  const handleToggleSelectBatch = (batchItems: OutboundItem[]) => {
    const batchIds = batchItems.map(i => i.id);
    const allSelectedInBatch = batchIds.length > 0 && batchIds.every(id => selectedIds.includes(id));
    if (allSelectedInBatch) {
      setSelectedIds(prev => prev.filter(id => !batchIds.includes(id)));
    } else {
      setSelectedIds(prev => Array.from(new Set([...prev, ...batchIds])));
    }
  };

  const handleCancelBatch = (batchKey: string, batchItems: OutboundItem[]) => {
    const cancellable = batchItems.filter(i => i.status !== 'Cancelled' && !i.shipped);
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

  useEffect(()=>{const visible=new Set(filteredHistory.map(item=>item.id));setSelectedIds(prev=>{const next=prev.filter(id=>visible.has(id));return next.length===prev.length?prev:next})},[filteredHistory]);
  const cancellableSelected=filteredHistory.filter(item=>selectedIds.includes(item.id)&&item.status!=='Cancelled'&&!item.shipped);
  // Handle Select / Deselect individual row
  const handleToggleSelectRow = (id: string) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  // Handle Select / Deselect all filtered rows
  const handleToggleSelectAll = () => {
    const allFilteredIds = filteredHistory.map(item => item.id);
    const areAllInSelected = allFilteredIds.length > 0 && allFilteredIds.every(id => selectedIds.includes(id));

    if (areAllInSelected) {
      // Remove all filtered ids from selection
      setSelectedIds(prev => prev.filter(id => !allFilteredIds.includes(id)));
    } else {
      // Add all filtered ids to selection
      setSelectedIds(prev => {
        const union = new Set([...prev, ...allFilteredIds]);
        return Array.from(union);
      });
    }
  };

  const isAllSelected = filteredHistory.length > 0 && filteredHistory.every(item => selectedIds.includes(item.id));
  const isSomeSelected = filteredHistory.length > 0 && filteredHistory.some(item => selectedIds.includes(item.id)) && !isAllSelected;

  // Export to Excel .xlsx
  const handleExportExcel = () => {
    const itemsToExport = selectedIds.length > 0 
      ? filteredHistory.filter(item => selectedIds.includes(item.id)) 
      : filteredHistory;

    if (itemsToExport.length === 0) {
      alert('Tidak ada data yang dipilih atau terdeteksi untuk diekspor.');
      return;
    }

    try {
      const exportData = itemsToExport.map(item => {
        const row: any = {
          'Waktu Keluar': formatToWibString(item.timestamp),
          'Batch Number': getBatchKey(item),
          'No Referensi': item.referenceNumber || '-',
          'Order Number': item.orderNumber || '-',
          'No PO': item.noPo || '-',
          'Customer Name': item.customerName || '-',
          'SKU ID': item.skuId,
          'Nama Barang': item.skuName,
          'Expired': item.expiredDate,
          'Lokasi Rak': item.location,
          'Qty (Pcs)': item.qty,
          'Status': item.status,
          'Petugas Input': item.createdBy || 'Belum tercatat',
          'Petugas Picking': item.pickedBy || 'Belum tercatat',
          'Petugas Sortir': item.sortedBy || 'Belum tercatat',
          'Petugas Packing / Validasi': item.packedBy || 'Belum tercatat',
          ...Object.fromEntries(getOrderStageHistory(item).map(row => ['Waktu '+row.stage+' (WIB)',row.timeLabel]))
        };

        if (includeDescription) {
          row['Deskripsi / Dokumen'] = item.referenceNumber || item.notes || '-';
        }

        return row;
      });

      const worksheet = XLSX.utils.json_to_sheet(exportData);
      
      const colWidths = [
        { wch: 18 }, // Waktu Keluar
        { wch: 22 }, // Batch Number
        { wch: 22 }, // No Referensi
        { wch: 15 }, // Order Number
        { wch: 15 }, // No PO
        { wch: 25 }, // Customer Name
        { wch: 15 }, // SKU ID
        { wch: 30 }, // Nama Barang
        { wch: 12 }, // Expired
        { wch: 12 }, // Lokasi Rak
        { wch: 10 }, // Qty (Pcs)
        { wch: 12 }, // Status
        { wch: 24 }, { wch: 24 }, { wch: 24 }, { wch: 24 },
        { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 28 }
      ];
      if (includeDescription) {
        colWidths.push({ wch: 25 }); // Deskripsi / Dokumen
      }
      worksheet['!cols'] = colWidths;

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Riwayat Order');
      
      const timestamp = new Date().toISOString().substring(0, 10);
      XLSX.writeFile(workbook, `Hasil_Ekspor_Order_${timestamp}.xlsx`);
    } catch (error) {
      console.error(error);
      alert('Gagal mengekspor data ke Excel.');
    }
  };

  return (
    <div className="space-y-6" id="history-order-view">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#11141B] rounded-2xl p-6 border border-slate-800/60 shadow-md">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-white flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-emerald-400" />
            Riwayat Order (Barang Keluar)
          </h2>
          <p className="text-slate-400 mt-1 text-xs md:text-sm">
            Pantau riwayat transaksi outbound dikelompokkan per <strong className="text-emerald-400">Batch Number</strong> atau per baris rincian SKU.
          </p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          {/* View Mode Toggle: Per Batch vs Flat Table */}
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
              Per Batch ({groupedByBatch.length})
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
              Tabel Baris ({filteredHistory.length})
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-300 font-bold bg-[#161B25] hover:bg-[#1f2635] px-3.5 py-2.5 rounded-xl border border-slate-800 cursor-pointer select-none transition-colors">
            <input 
              type="checkbox"
              checked={includeDescription}
              onChange={(e) => setIncludeDescription(e.target.checked)}
              className="w-4 h-4 rounded border-slate-800 bg-[#11141B] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
            />
            Sertakan Kolom Deskripsi/Dokumen
          </label>
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Ekspor Excel (.xlsx) {selectedIds.length > 0 && `(${selectedIds.length} Terpilih)`}
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
              Hapus Semua Riwayat
            </button>
          )}
          {cancellableSelected.length > 0 && ['Administrator','Admin'].includes(currentUser?.role||'') && (
            <button
              onClick={handleDeleteSelected}
              className="flex items-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
              Batalkan ({cancellableSelected.length}) Terpilih
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
          <span>Tampilkan yang dibatalkan ({cancelledCount} baris)</span>
        </label>

        {viewMode === 'batch' && groupedByBatch.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleToggleSelectAll}
              className="px-3 py-2 rounded-xl border border-slate-800 bg-[#11141B] hover:bg-[#161B25] text-xs font-bold text-slate-300 transition-colors cursor-pointer"
            >
              {isAllSelected ? 'Batal Pilih Semua' : `Pilih Semua (${filteredHistory.length} Baris)`}
            </button>
            <button
              type="button"
              onClick={() => {
                const anyCollapsed = groupedByBatch.some(g => collapsedBatches[g.batchKey]);
                if (anyCollapsed) {
                  setCollapsedBatches({});
                } else {
                  const next: Record<string, boolean> = {};
                  groupedByBatch.forEach(g => {
                    next[g.batchKey] = true;
                  });
                  setCollapsedBatches(next);
                }
              }}
              className="px-3 py-2 rounded-xl border border-slate-800 bg-[#11141B] hover:bg-[#161B25] text-xs font-bold text-emerald-400 transition-colors cursor-pointer flex items-center gap-1.5"
            >
              {groupedByBatch.some(g => collapsedBatches[g.batchKey]) ? (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  Buka Semua Batch
                </>
              ) : (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Ringkas Semua Batch
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Control Panel */}
      <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {/* Search */}
          <div className="relative lg:col-span-2">
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Cari Batch / SKU / Order / Petugas</label>
            <div className="relative">
              <input
                type="text"
                placeholder="Cari Batch Number, SKU, Order, PO, Customer, Petugas..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none placeholder:text-slate-500"
              />
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
            </div>
          </div>

          {/* Batch Filter */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Filter Batch Number</label>
            <select
              value={batchFilter}
              onChange={(e) => setBatchFilter(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer font-mono"
            >
              <option value="ALL">Semua Batch ({uniqueBatches.length})</option>
              {uniqueBatches.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          {/* Customer Filter */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Filter Customer</label>
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer"
            >
              <option value="ALL">Semua Customer ({uniqueCustomers.length})</option>
              {uniqueCustomers.map(cust => (
                <option key={cust} value={cust}>{cust}</option>
              ))}
            </select>
          </div>

          {/* Date Filter: Start Date */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Tanggal Mulai</label>
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
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Tanggal Selesai</label>
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
                {st === 'ALL' ? 'Semua Status' : st === 'Cancelled' ? 'Dibatalkan' : st}
              </button>
            ))}

            {(searchTerm || customerFilter !== 'ALL' || batchFilter !== 'ALL' || statusFilter !== 'ALL' || startDate || endDate) && (
              <button
                onClick={() => {
                  setSearchTerm('');
                  setCustomerFilter('ALL');
                  setBatchFilter('ALL');
                  setStatusFilter('ALL');
                  setStartDate('');
                  setEndDate('');
                }}
                className="text-[11px] font-bold text-emerald-400 hover:text-emerald-350 cursor-pointer flex items-center gap-1.5 ml-2"
              >
                Reset Filter & Tanggal
              </button>
            )}
          </div>

          {/* Sort Controls */}
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Urutkan:</span>
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
            groupedByBatch.map(group => {
              const isCollapsed = !!collapsedBatches[group.batchKey];
              const batchIds = group.items.map(i => i.id);
              const allBatchSelected = batchIds.length > 0 && batchIds.every(id => selectedIds.includes(id));
              const someBatchSelected = batchIds.length > 0 && batchIds.some(id => selectedIds.includes(id)) && !allBatchSelected;
              const cancellableInBatch = group.items.filter(i => i.status !== 'Cancelled' && !i.shipped);

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
                          <span className="inline-flex items-center gap-1.5 font-mono text-sm font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-3 py-1 rounded-lg">
                            <Layers className="w-4 h-4 shrink-0" />
                            BATCH: {group.batchKey}
                          </span>

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

                        {/* Metadata Pills: Ref, Order No, PO, Customer */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-xs text-slate-300">
                          {group.customers.length > 0 && (
                            <span className="flex items-center gap-1 font-bold text-slate-200">
                              <User className="w-3.5 h-3.5 text-sky-400" />
                              {group.customers.join(', ')}
                            </span>
                          )}
                          {group.orderNumbers.length > 0 && (
                            <span className="flex items-center gap-1 font-mono text-slate-300">
                              <FileText className="w-3.5 h-3.5 text-emerald-400" />
                              Order: <strong>{group.orderNumbers.join(', ')}</strong>
                            </span>
                          )}
                          {group.poNumbers.length > 0 && (
                            <span className="flex items-center gap-1 font-mono text-slate-300">
                              <Tag className="w-3.5 h-3.5 text-amber-400" />
                              PO: <strong>{group.poNumbers.join(', ')}</strong>
                            </span>
                          )}
                          {group.refs.some(r => r !== group.batchKey) && (
                            <span className="text-[11px] font-mono text-slate-400">
                              Ref: {group.refs.join(', ')}
                            </span>
                          )}
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
                            setCollapsedBatches(prev => ({
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
                  <div className="bg-[#161B25] px-5 py-2 border-b border-slate-800/50 flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px]">
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

                  {/* Batch Items Table */}
                  {!isCollapsed && (
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
                          {group.items.map(item => (
                            <tr
                              key={item.id}
                              className={`hover:bg-slate-800/20 transition-colors ${
                                selectedIds.includes(item.id) ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : ''
                              }`}
                            >
                              <td className="py-2.5 px-4 text-center">
                                <input
                                  type="checkbox"
                                  checked={selectedIds.includes(item.id)}
                                  onChange={() => handleToggleSelectRow(item.id)}
                                  className="w-4 h-4 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                                />
                              </td>
                              <td className="py-2.5 px-4">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded text-[11px]">
                                    {item.skuId}
                                  </span>
                                  <span className="font-medium text-slate-200">{item.skuName}</span>
                                </div>
                                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                                  Ref: {item.referenceNumber}
                                  {item.orderNumber ? ` • Order: ${item.orderNumber}` : ''}
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
                                item.status !== 'Cancelled' &&
                                !item.shipped ? (
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
                                    {item.status === 'Cancelled' ? 'Dibatalkan' : item.shipped ? 'Sudah dikirim' : 'Hanya lihat'}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Footer info counts for Batch View */}
          <div className="bg-[#151922] px-5 py-3.5 rounded-xl border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-400 font-medium">
            <div>
              Menampilkan <span className="text-white font-bold">{groupedByBatch.length} Batch</span> (<span className="text-white font-bold">{filteredHistory.length}</span> baris alokasi SKU)
            </div>
            <div>
              Total Volume Keluar (Completed):{' '}
              <span className="text-rose-400 font-bold">
                {formatNumber(filteredHistory.filter(i => i.status === 'Completed').reduce((sum, i) => sum + i.qty, 0))} Pcs
              </span>
            </div>
          </div>
        </div>
      ) : (
        /* VIEW MODE 2: FLAT TABLE */
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
                  <th className="py-3 px-4">Batch Number</th>
                  <th className="py-3 px-4">Order / No PO</th>
                  <th className="py-3 px-4">Customer Name</th>
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
                  filteredHistory.map((item) => (
                    <tr 
                      key={item.id} 
                      className={`hover:bg-slate-800/20 transition-colors ${selectedIds.includes(item.id) ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : ''}`}
                    >
                      <td className="py-3 px-4 text-center">
                        <input 
                          type="checkbox"
                          checked={selectedIds.includes(item.id)}
                          onChange={() => handleToggleSelectRow(item.id)}
                          className="w-4 h-4 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                        />
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-slate-400 font-mono">
                        {formatToWibString(item.timestamp)}
                      </td>
                      <td className="py-3 px-4 font-mono font-bold">
                        <span className="inline-flex items-center gap-1 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded text-[11px]">
                          <Layers className="w-3 h-3" />
                          {getBatchKey(item)}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-200 space-y-0.5">
                        {item.orderNumber ? (
                          <span className="flex items-center gap-1 font-bold">
                            <FileText className="w-3.5 h-3.5 text-emerald-400" />
                            {item.orderNumber}
                          </span>
                        ) : (
                          <span className="text-slate-500 font-normal italic block">Order: -</span>
                        )}
                        {item.noPo && (
                          <span className="flex items-center gap-1 text-[11px] text-slate-300">
                            <Tag className="w-3 h-3 text-amber-400" />
                            PO: {item.noPo}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-semibold text-slate-200">
                        {item.customerName ? (
                          <span className="flex items-center gap-1">
                            <User className="w-3.5 h-3.5 text-sky-400" />
                            {item.customerName}
                          </span>
                        ) : (
                          <span className="text-slate-500 font-normal italic">N/A</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div>
                          <span className="font-mono font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded text-[11px] mr-1.5">
                            {item.skuId}
                          </span>
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
                        {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && item.status!=='Cancelled'&&!item.shipped ? (
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
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">{item.status==='Cancelled'?'Dibatalkan':item.shipped?'Sudah dikirim':'Hanya lihat'}</span>
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
              Menampilkan <span className="text-white font-bold">{filteredHistory.length}</span> baris riwayat order dalam <span className="text-white font-bold">{groupedByBatch.length}</span> Batch
            </div>
            <div>
              Total Volume Keluar: <span className="text-rose-400 font-bold">{formatNumber(filteredHistory.filter(i=>i.status==='Completed').reduce((sum, i) => sum + i.qty, 0))} Pcs</span>
            </div>
          </div>
        </div>
      )}

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
              <div>
                <span className="text-[10px] font-bold text-emerald-400 uppercase bg-emerald-500/10 px-2 py-0.5 rounded font-mono">
                  {editingItem.skuId}
                </span>
                <span className="text-xs font-semibold text-slate-300 ml-2">{editingItem.skuName}</span>
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
    </div>
  );
}
