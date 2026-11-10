import React, { useState, useMemo, useEffect } from 'react';
import { 
  ClipboardCheck, 
  Truck, 
  Building2, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  AlertTriangle, 
  Search, 
  Filter, 
  Plus, 
  Download, 
  Printer, 
  ArrowUpDown, 
  ChevronRight, 
  Eye, 
  Edit3, 
  Trash2, 
  RotateCcw, 
  Check, 
  Send, 
  FileText, 
  ExternalLink,
  ShieldAlert,
  Layers,
  Sparkles,
  Calendar,
  User,
  PackageCheck,
  ShoppingBag,
  FileSpreadsheet
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { BatchRecord, BatchShippingStatus, CentralWmsStatus, OutboundItem, UserAccount } from '../types';
import { formatNumber } from '../utils/calculations';

interface BatchDashboardProps {
  batches: BatchRecord[];
  orderHistory: OutboundItem[];
  currentUser: UserAccount | null;
  onSaveBatch: (batch: BatchRecord) => void;
  onDeleteBatch: (batchId: string) => void;
  onBatchUpdateStatus: (batchIds: string[], updates: Partial<BatchRecord>) => void;
  onSyncBatchesFromOrders?: () => void;
}

export default function BatchDashboard({
  batches,
  orderHistory,
  currentUser,
  onSaveBatch,
  onDeleteBatch,
  onBatchUpdateStatus,
  onSyncBatchesFromOrders
}: BatchDashboardProps) {
  // Search & Filter state
  const [searchTerm, setSearchTerm] = useState('');
  const [shippingFilter, setShippingFilter] = useState<'ALL' | BatchShippingStatus>('ALL');
  const [wmsFilter, setWmsFilter] = useState<'ALL' | CentralWmsStatus>('ALL');
  const [dateRangeFilter, setDateRangeFilter] = useState<'ALL' | 'TODAY' | 'WEEK' | 'MONTH'>('ALL');
  const [activeTab, setActiveTab] = useState<'ALL' | 'ACTION_NEEDED' | 'NOT_SHIPPED' | 'NOT_DEDUCTED' | 'COMPLETED'>('ALL');

  // Selected orders for bulk actions
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);

  // Modals state
  const [detailModalBatch, setDetailModalBatch] = useState<BatchRecord | null>(null);
  const [statusEditModal, setStatusEditModal] = useState<{
    isOpen: boolean;
    batch: BatchRecord | null;
    targetType: 'SHIPPING' | 'WMS' | 'BOTH';
  }>({ isOpen: false, batch: null, targetType: 'SHIPPING' });

  // New order modal state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newOrderNumber, setNewOrderNumber] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newDestination, setNewDestination] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [selectedOrderRefForNewBatch, setSelectedOrderRefForNewBatch] = useState('');

  // Status Edit Form State
  const [editShippingStatus, setEditShippingStatus] = useState<BatchShippingStatus>('BELUM_TERKIRIM');
  const [editCourierName, setEditCourierName] = useState('');
  const [editTrackingNumber, setEditTrackingNumber] = useState('');
  const [editDriverName, setEditDriverName] = useState('');
  const [editVehiclePlate, setEditVehiclePlate] = useState('');

  const [editWmsStatus, setEditWmsStatus] = useState<CentralWmsStatus>('BELUM_TERPOTONG');
  const [editWmsDocNumber, setEditWmsDocNumber] = useState('');
  const [editWmsNotes, setEditWmsNotes] = useState('');

  // Toast / notification feedback
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Pre-fill form when opening status modal
  useEffect(() => {
    if (statusEditModal.isOpen && statusEditModal.batch) {
      const b = statusEditModal.batch;
      setEditShippingStatus(b.shippingStatus || 'BELUM_TERKIRIM');
      setEditCourierName(b.courierName || '');
      setEditTrackingNumber(b.trackingNumber || '');
      setEditDriverName(b.driverName || '');
      setEditVehiclePlate(b.vehiclePlate || '');

      setEditWmsStatus(b.centralWmsStatus || 'BELUM_TERPOTONG');
      setEditWmsDocNumber(b.centralWmsDocNumber || '');
      setEditWmsNotes(b.centralWmsNotes || '');
    }
  }, [statusEditModal]);

  // Aggregate KPI Statistics
  const stats = useMemo(() => {
    const total = batches.length;
    const shippedCount = batches.filter(b => b.shippingStatus === 'SUDAH_TERKIRIM').length;
    const inTransitCount = batches.filter(b => b.shippingStatus === 'DALAM_PENGIRIMAN').length;
    const notShippedCount = batches.filter(b => b.shippingStatus === 'BELUM_TERKIRIM').length;

    const wmsDeductedCount = batches.filter(b => b.centralWmsStatus === 'SUDAH_TERPOTONG').length;
    const wmsNotDeductedCount = batches.filter(b => b.centralWmsStatus === 'BELUM_TERPOTONG').length;

    const totalPcs = batches.reduce((sum, b) => sum + (b.totalPcs || 0), 0);
    const shippedPcs = batches
      .filter(b => b.shippingStatus === 'SUDAH_TERKIRIM')
      .reduce((sum, b) => sum + (b.totalPcs || 0), 0);

    // Urgent discrepancy: Shipped from warehouse but NOT YET deducted in Central WMS
    const urgentDiscrepancyCount = batches.filter(
      b => b.shippingStatus === 'SUDAH_TERKIRIM' && b.centralWmsStatus === 'BELUM_TERPOTONG'
    ).length;

    const completedCount = batches.filter(
      b => b.shippingStatus === 'SUDAH_TERKIRIM' && b.centralWmsStatus === 'SUDAH_TERPOTONG'
    ).length;

    return {
      total,
      shippedCount,
      inTransitCount,
      notShippedCount,
      wmsDeductedCount,
      wmsNotDeductedCount,
      totalPcs,
      shippedPcs,
      urgentDiscrepancyCount,
      completedCount,
      shippingRate: total > 0 ? Math.round((shippedCount / total) * 100) : 0,
      wmsDeductRate: total > 0 ? Math.round((wmsDeductedCount / total) * 100) : 0
    };
  }, [batches]);

  // Filtered Orders List
  const filteredBatches = useMemo(() => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    return batches.filter(batch => {
      const ordNum = batch.orderNumber || batch.batchNumber || '';

      // 1. Text Search matching
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase().trim();
        const normQ = q.replace(/[\s_-]+/g, '');

        const matchText = 
          ordNum.toLowerCase().includes(q) ||
          (batch.id && batch.id.toLowerCase().includes(q)) ||
          (batch.customerName && batch.customerName.toLowerCase().includes(q)) ||
          (batch.destination && batch.destination.toLowerCase().includes(q)) ||
          (batch.notes && batch.notes.toLowerCase().includes(q)) ||
          (batch.courierName && batch.courierName.toLowerCase().includes(q)) ||
          (batch.trackingNumber && batch.trackingNumber.toLowerCase().includes(q)) ||
          (batch.centralWmsDocNumber && batch.centralWmsDocNumber.toLowerCase().includes(q)) ||
          (batch.sourceReference && batch.sourceReference.toLowerCase().includes(q)) ||
          (batch.items && batch.items.some(i => i.skuId.toLowerCase().includes(q) || i.skuName.toLowerCase().includes(q)));

        // Status string matching from text search input:
        const matchShippingStatus = 
          ((normQ.includes('sudahterkirim') || normQ === 'terkirim') && batch.shippingStatus === 'SUDAH_TERKIRIM') ||
          ((normQ.includes('belumterkirim') || normQ === 'belumkirim') && batch.shippingStatus === 'BELUM_TERKIRIM') ||
          ((normQ.includes('dalampengiriman') || normQ === 'transit') && batch.shippingStatus === 'DALAM_PENGIRIMAN');

        const matchWmsStatus = 
          ((normQ.includes('sudahterpotong') || normQ === 'terpotong' || normQ === 'potong') && batch.centralWmsStatus === 'SUDAH_TERPOTONG') ||
          ((normQ.includes('belumterpotong') || normQ === 'belumpotong') && batch.centralWmsStatus === 'BELUM_TERPOTONG');

        if (!matchText && !matchShippingStatus && !matchWmsStatus) return false;
      }

      // 2. Tab Filter
      if (activeTab === 'ACTION_NEEDED') {
        const isCompleted = batch.shippingStatus === 'SUDAH_TERKIRIM' && batch.centralWmsStatus === 'SUDAH_TERPOTONG';
        if (isCompleted) return false;
      } else if (activeTab === 'NOT_SHIPPED') {
        if (batch.shippingStatus === 'SUDAH_TERKIRIM') return false;
      } else if (activeTab === 'NOT_DEDUCTED') {
        if (batch.centralWmsStatus === 'SUDAH_TERPOTONG') return false;
      } else if (activeTab === 'COMPLETED') {
        if (batch.shippingStatus !== 'SUDAH_TERKIRIM' || batch.centralWmsStatus !== 'SUDAH_TERPOTONG') return false;
      }

      // 3. Dropdown Shipping Filter
      if (shippingFilter !== 'ALL' && batch.shippingStatus !== shippingFilter) {
        return false;
      }

      // 4. Dropdown Central WMS Filter
      if (wmsFilter !== 'ALL' && batch.centralWmsStatus !== wmsFilter) {
        return false;
      }

      // 5. Date Range Filter
      if (dateRangeFilter !== 'ALL' && batch.createdAt) {
        const bDate = new Date(batch.createdAt);
        if (dateRangeFilter === 'TODAY') {
          if (batch.createdAt.slice(0, 10) !== todayStr) return false;
        } else if (dateRangeFilter === 'WEEK') {
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(now.getDate() - 7);
          if (bDate < sevenDaysAgo) return false;
        } else if (dateRangeFilter === 'MONTH') {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(now.getDate() - 30);
          if (bDate < thirtyDaysAgo) return false;
        }
      }

      return true;
    });
  }, [batches, searchTerm, activeTab, shippingFilter, wmsFilter, dateRangeFilter]);

  // Handle Quick Toggle Shipping Status
  const handleToggleShipping = (batch: BatchRecord, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const ordNum = batch.orderNumber || batch.batchNumber;
    const newStatus: BatchShippingStatus = 
      batch.shippingStatus === 'SUDAH_TERKIRIM' ? 'BELUM_TERKIRIM' : 'SUDAH_TERKIRIM';
    
    const updated: BatchRecord = {
      ...batch,
      shippingStatus: newStatus,
      shippedAt: newStatus === 'SUDAH_TERKIRIM' ? new Date().toISOString() : undefined,
      shippedBy: newStatus === 'SUDAH_TERKIRIM' ? (currentUser?.fullName || currentUser?.username || 'Operator') : undefined,
      updatedAt: new Date().toISOString()
    };

    onSaveBatch(updated);
    showToast(`Order ${ordNum}: Status pengiriman diubah ke "${newStatus === 'SUDAH_TERKIRIM' ? 'Sudah Terkirim' : 'Belum Terkirim'}".`);
  };

  // Handle Quick Toggle Central WMS Status
  const handleToggleWms = (batch: BatchRecord, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const ordNum = batch.orderNumber || batch.batchNumber;
    const newStatus: CentralWmsStatus = 
      batch.centralWmsStatus === 'SUDAH_TERPOTONG' ? 'BELUM_TERPOTONG' : 'SUDAH_TERPOTONG';
    
    const updated: BatchRecord = {
      ...batch,
      centralWmsStatus: newStatus,
      centralWmsDeductedAt: newStatus === 'SUDAH_TERPOTONG' ? new Date().toISOString() : undefined,
      centralWmsDeductedBy: newStatus === 'SUDAH_TERPOTONG' ? (currentUser?.fullName || currentUser?.username || 'Operator') : undefined,
      updatedAt: new Date().toISOString()
    };

    onSaveBatch(updated);
    showToast(`Order ${ordNum}: Status WMS Pusat diubah ke "${newStatus === 'SUDAH_TERPOTONG' ? 'Sudah Terpotong' : 'Belum Terpotong'}".`);
  };

  // Save Modal Form Updates
  const handleSaveModalForm = () => {
    if (!statusEditModal.batch) return;
    const current = statusEditModal.batch;
    const ordNum = current.orderNumber || current.batchNumber;
    const nowIso = new Date().toISOString();
    const userName = currentUser?.fullName || currentUser?.username || 'Operator';

    const updated: BatchRecord = {
      ...current,
      shippingStatus: editShippingStatus,
      shippedAt: editShippingStatus === 'SUDAH_TERKIRIM' ? (current.shippedAt || nowIso) : undefined,
      shippedBy: editShippingStatus === 'SUDAH_TERKIRIM' ? (current.shippedBy || userName) : undefined,
      courierName: editCourierName.trim() || undefined,
      trackingNumber: editTrackingNumber.trim() || undefined,
      driverName: editDriverName.trim() || undefined,
      vehiclePlate: editVehiclePlate.trim() || undefined,

      centralWmsStatus: editWmsStatus,
      centralWmsDeductedAt: editWmsStatus === 'SUDAH_TERPOTONG' ? (current.centralWmsDeductedAt || nowIso) : undefined,
      centralWmsDeductedBy: editWmsStatus === 'SUDAH_TERPOTONG' ? (current.centralWmsDeductedBy || userName) : undefined,
      centralWmsDocNumber: editWmsDocNumber.trim() || undefined,
      centralWmsNotes: editWmsNotes.trim() || undefined,
      updatedAt: nowIso
    };

    onSaveBatch(updated);
    setStatusEditModal({ isOpen: false, batch: null, targetType: 'SHIPPING' });
    showToast(`Perubahan status Order ${ordNum} berhasil disimpan.`);
  };

  // Bulk Actions
  const handleBulkMarkShipped = () => {
    if (selectedBatchIds.length === 0) return;
    const nowIso = new Date().toISOString();
    const userName = currentUser?.fullName || currentUser?.username || 'Operator';

    onBatchUpdateStatus(selectedBatchIds, {
      shippingStatus: 'SUDAH_TERKIRIM',
      shippedAt: nowIso,
      shippedBy: userName,
      updatedAt: nowIso
    });

    showToast(`✓ ${selectedBatchIds.length} order ditandai sebagai: SUDAH TERKIRIM.`);
    setSelectedBatchIds([]);
  };

  const handleBulkMarkWmsDeducted = () => {
    if (selectedBatchIds.length === 0) return;
    const nowIso = new Date().toISOString();
    const userName = currentUser?.fullName || currentUser?.username || 'Operator';

    onBatchUpdateStatus(selectedBatchIds, {
      centralWmsStatus: 'SUDAH_TERPOTONG',
      centralWmsDeductedAt: nowIso,
      centralWmsDeductedBy: userName,
      updatedAt: nowIso
    });

    showToast(`✓ ${selectedBatchIds.length} order ditandai sebagai: SUDAH TERPOTONG DI WMS PUSAT.`);
    setSelectedBatchIds([]);
  };

  // Create Order Manually or from Outbound Reference
  const handleCreateOrder = () => {
    const oNumber = newOrderNumber.trim();
    if (!oNumber) {
      alert('Harap masukkan nomor order.');
      return;
    }

    const nowIso = new Date().toISOString();
    let orderItems: any[] = [];
    let calcTotalPcs = 0;
    let customer = newCustomerName.trim() || 'Internal Warehouse';

    if (selectedOrderRefForNewBatch) {
      const matchedOrders = orderHistory.filter(
        o => o.referenceNumber === selectedOrderRefForNewBatch || o.orderNumber === selectedOrderRefForNewBatch
      );
      if (matchedOrders.length > 0) {
        orderItems = matchedOrders.map(o => ({
          skuId: o.skuId,
          skuName: o.skuName,
          qty: o.qty,
          location: o.location,
          expiredDate: o.expiredDate,
          orderNumber: o.orderNumber || oNumber,
          referenceNumber: o.referenceNumber
        }));
        calcTotalPcs = matchedOrders.reduce((sum, o) => sum + o.qty, 0);
        if (matchedOrders[0].customerName) customer = matchedOrders[0].customerName;
      }
    }

    const newRecord: BatchRecord = {
      id: `ORD-${Date.now()}-${oNumber.replace(/[^a-zA-Z0-9_-]/g, '')}`,
      batchNumber: oNumber,
      orderNumber: oNumber,
      createdAt: nowIso,
      updatedAt: nowIso,
      shippingStatus: 'BELUM_TERKIRIM',
      centralWmsStatus: 'BELUM_TERPOTONG',
      customerName: customer,
      destination: newDestination.trim() || undefined,
      notes: newNotes.trim() || undefined,
      totalSkus: orderItems.length > 0 ? new Set(orderItems.map(i => i.skuId)).size : 1,
      totalPcs: calcTotalPcs > 0 ? calcTotalPcs : 0,
      sourceReference: selectedOrderRefForNewBatch || undefined,
      createdBy: currentUser?.fullName || currentUser?.username || 'Operator',
      items: orderItems
    };

    onSaveBatch(newRecord);
    setIsCreateModalOpen(false);
    setNewOrderNumber('');
    setNewCustomerName('');
    setNewDestination('');
    setNewNotes('');
    setSelectedOrderRefForNewBatch('');
    showToast(`Order ${oNumber} berhasil ditambahkan!`);
  };

  // Export to CSV
  const handleExportCsv = () => {
    if (filteredBatches.length === 0) {
      alert('Tidak ada data order untuk diexport.');
      return;
    }

    const headers = [
      'Nomor Order',
      'Tanggal Dibuat',
      'Customer / Tujuan',
      'Total SKU',
      'Total Qty (Pcs)',
      'Status Pengiriman',
      'Waktu Kirim',
      'Petugas Kirim',
      'Ekspedisi / Kurir',
      'No Resi / Surat Jalan',
      'Status Stok WMS Pusat',
      'Waktu Potong WMS Pusat',
      'No Dokumen WMS Pusat',
      'Catatan'
    ];

    const rows = filteredBatches.map(b => {
      const ordNum = b.orderNumber || b.batchNumber || '';
      return [
        `"${ordNum}"`,
        `"${b.createdAt ? b.createdAt.slice(0, 10) : ''}"`,
        `"${b.customerName || b.destination || ''}"`,
        b.totalSkus || 0,
        b.totalPcs || 0,
        `"${b.shippingStatus === 'SUDAH_TERKIRIM' ? 'Sudah Terkirim' : b.shippingStatus === 'DALAM_PENGIRIMAN' ? 'Dalam Pengiriman' : 'Belum Terkirim'}"`,
        `"${b.shippedAt || '-'}"`,
        `"${b.shippedBy || '-'}"`,
        `"${b.courierName || '-'}"`,
        `"${b.trackingNumber || '-'}"`,
        `"${b.centralWmsStatus === 'SUDAH_TERPOTONG' ? 'Sudah Terpotong' : 'Belum Terpotong'}"`,
        `"${b.centralWmsDeductedAt || '-'}"`,
        `"${b.centralWmsDocNumber || '-'}"`,
        `"${b.notes || ''}"`
      ];
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Laporan_Order_Number_WMS_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('✓ Laporan order berhasil didownload dalam format CSV.');
  };

  // Print Order Waybill / Delivery Proof
  const handlePrintOrder = (order: BatchRecord) => {
    const ordNum = order.orderNumber || order.batchNumber;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Gagal membuka jendela cetak. Pastikan pop-up diizinkan.');
      return;
    }

    const itemsRows = (order.items || []).map((it, idx) => `
      <tr>
        <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">${idx + 1}</td>
        <td style="border: 1px solid #cbd5e1; padding: 6px; font-weight: bold;">${it.skuId}</td>
        <td style="border: 1px solid #cbd5e1; padding: 6px;">${it.skuName}</td>
        <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">${it.location || '-'}</td>
        <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">${it.expiredDate || '-'}</td>
        <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: right; font-weight: bold;">${formatNumber(it.qty)}</td>
      </tr>
    `).join('');

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Surat Jalan & Tanda Terima Order: ${ordNum}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 24px; color: #0f172a; font-size: 12px; }
          .header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px; }
          .title { font-size: 18px; font-weight: 900; text-transform: uppercase; margin: 0; }
          .subtitle { font-size: 11px; color: #64748b; margin-top: 4px; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
          .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; }
          .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 10px; }
          .badge-green { background: #dcfce7; color: #15803d; }
          .badge-red { background: #fee2e2; color: #b91c1c; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th { background: #f1f5f9; border: 1px solid #cbd5e1; padding: 6px; font-size: 11px; text-align: left; }
          .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-top: 36px; text-align: center; }
          .sig-box { border-top: 1px solid #94a3b8; padding-top: 6px; font-size: 11px; margin-top: 48px; }
        </style>
      </head>
      <body>
        <div class="header">
          <div style="float: right; text-align: right;">
            <span style="font-size: 14px; font-weight: 800;">TRUEBLUE WMS</span><br>
            <span style="color: #64748b; font-size: 10px;">Cetak: ${new Date().toLocaleString('id-ID')}</span>
          </div>
          <h1 class="title">SURAT JALAN & TANDA TERIMA ORDER</h1>
          <div class="subtitle">SISTEM KONTROL PENGIRIMAN & POTONG STOK WMS PUSAT</div>
        </div>

        <div class="grid">
          <div class="card">
            <strong>Nomor Order:</strong> <span style="font-size: 14px; font-weight: bold; color: #0f172a;">${ordNum}</span><br>
            <strong>Customer / Tujuan:</strong> ${order.customerName || '-'} / ${order.destination || '-'}<br>
            <strong>Tanggal Dibuat:</strong> ${order.createdAt ? new Date(order.createdAt).toLocaleString('id-ID') : '-'}<br>
            <strong>Dibuat Oleh:</strong> ${order.createdBy || '-'}
          </div>
          <div class="card">
            <strong>Status Pengiriman:</strong> 
            <span class="badge ${order.shippingStatus === 'SUDAH_TERKIRIM' ? 'badge-green' : 'badge-red'}">
              ${order.shippingStatus === 'SUDAH_TERKIRIM' ? 'SUDAH TERKIRIM' : 'BELUM TERKIRIM'}
            </span><br>
            <strong>Ekspedisi / Resi:</strong> ${order.courierName || '-'} | ${order.trackingNumber || '-'}<br>
            <strong>Status Potong WMS Pusat:</strong> 
            <span class="badge ${order.centralWmsStatus === 'SUDAH_TERPOTONG' ? 'badge-green' : 'badge-red'}">
              ${order.centralWmsStatus === 'SUDAH_TERPOTONG' ? 'SUDAH TERPOTONG DI PUSAT' : 'BELUM TERPOTONG DI PUSAT'}
            </span><br>
            <strong>No. Dokumen WMS Pusat:</strong> ${order.centralWmsDocNumber || '-'}
          </div>
        </div>

        <div style="margin-top: 12px;">
          <strong>Rincian Item SKU Dalam Order (Total: ${formatNumber(order.totalPcs)} Pcs):</strong>
          <table>
            <thead>
              <tr>
                <th style="width: 30px; text-align: center;">No</th>
                <th style="width: 110px;">SKU ID</th>
                <th>Nama Produk</th>
                <th style="width: 80px; text-align: center;">Lokasi</th>
                <th style="width: 90px; text-align: center;">Expired Date</th>
                <th style="width: 70px; text-align: right;">Qty (Pcs)</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRows || '<tr><td colspan="6" style="text-align: center; padding: 12px; color: #64748b;">Tidak ada rincian item.</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="signatures">
          <div>
            <div>Petugas Gudang / Packer</div>
            <div class="sig-box">( ${order.createdBy || '........................'} )</div>
          </div>
          <div>
            <div>Supir / Kurir Ekspedisi</div>
            <div class="sig-box">( ${order.driverName || '........................'} )</div>
          </div>
          <div>
            <div>Admin WMS Pusat</div>
            <div class="sig-box">( ${order.centralWmsDeductedBy || '........................'} )</div>
          </div>
        </div>

        <script>
          window.onload = function() { window.print(); }
        </script>
      </body>
      </html>
    `);
    printWindow.document.close();
  };

  // Distinct outbound references available for creating new order
  const availableOutboundReferences = useMemo(() => {
    const refs = new Set<string>();
    orderHistory.forEach(o => {
      if (o.referenceNumber) refs.add(o.referenceNumber);
      if (o.orderNumber) refs.add(o.orderNumber);
    });
    return Array.from(refs);
  }, [orderHistory]);

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="fixed top-20 right-6 z-50 bg-emerald-500 text-slate-950 font-black text-xs px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-2 border border-emerald-300"
          >
            <CheckCircle2 className="w-5 h-5 text-slate-950 shrink-0" />
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-indigo-950/40 p-6 rounded-3xl border border-slate-800 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 shrink-0 shadow-lg shadow-indigo-500/10">
                <ClipboardCheck className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <h1 className="text-xl md:text-2xl font-black text-white tracking-tight uppercase flex items-center gap-2.5">
                  Dashboard Order Number & Kontrol Distribusi
                </h1>
                <p className="text-slate-400 text-xs mt-0.5">
                  Pantau setiap nomor order secara real-time: tanda pengiriman barang & tanda pemotongan stok dari WMS pusat.
                </p>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2.5">
            {onSyncBatchesFromOrders && (
              <button
                onClick={onSyncBatchesFromOrders}
                className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white text-xs font-bold rounded-xl border border-slate-700 transition-all flex items-center gap-2 cursor-pointer shadow-md"
                title="Sinkronkan nomor order dari data outbound"
              >
                <RotateCcw className="w-4 h-4 text-indigo-400" />
                <span>Sinkronkan Order Outbound</span>
              </button>
            )}

            <button
              onClick={handleExportCsv}
              className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white text-xs font-bold rounded-xl border border-slate-700 transition-all flex items-center gap-2 cursor-pointer shadow-md"
              title="Download data order ke CSV"
            >
              <Download className="w-4 h-4 text-emerald-400" />
              <span>Export CSV</span>
            </button>

            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="px-4 py-2.5 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 text-white text-xs font-black rounded-xl transition-all flex items-center gap-2 shadow-lg shadow-indigo-500/25 cursor-pointer border border-indigo-400/30"
            >
              <Plus className="w-4 h-4" />
              <span>Tambah Order Baru</span>
            </button>
          </div>
        </div>

        {/* Warning Banner if Discrepancy Found */}
        {stats.urgentDiscrepancyCount > 0 && (
          <div className="mt-5 p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 animate-pulse" />
              <div className="text-xs text-amber-200">
                <span className="font-black text-amber-400 uppercase mr-1.5">Perhatian:</span>
                Terdapat <strong>{stats.urgentDiscrepancyCount} Order</strong> yang statusnya sudah <strong>Terkirim</strong> tetapi stoknya <strong>Belum Terpotong di WMS Pusat</strong>!
              </div>
            </div>
            <button
              onClick={() => {
                setActiveTab('NOT_DEDUCTED');
                setShippingFilter('SUDAH_TERKIRIM');
                setWmsFilter('BELUM_TERPOTONG');
              }}
              className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-black rounded-lg transition-all shrink-0 cursor-pointer"
            >
              Lihat Order Terkait
            </button>
          </div>
        )}
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Order */}
        <div className="bg-slate-900/70 border border-slate-800 p-5 rounded-2xl relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Total Order</span>
            <div className="w-8 h-8 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400">
              <ShoppingBag className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-black text-white">{formatNumber(stats.total)}</span>
            <span className="text-xs text-slate-400 font-bold">Order</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span>Total Volume:</span>
            <span className="font-extrabold text-slate-200">{formatNumber(stats.totalPcs)} Pcs</span>
          </div>
        </div>

        {/* Card 2: Status Pengiriman Barang */}
        <div className="bg-slate-900/70 border border-slate-800 p-5 rounded-2xl relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Status Pengiriman Order</span>
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-400">
              <Truck className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-black text-emerald-400">{formatNumber(stats.shippedCount)}</span>
              <span className="text-xs font-bold text-slate-400">Terkirim</span>
            </div>
            <span className="text-slate-600">/</span>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-black text-rose-400">{formatNumber(stats.notShippedCount)}</span>
              <span className="text-[10px] font-bold text-slate-400">Belum</span>
            </div>
          </div>
          {/* Progress bar */}
          <div className="mt-2.5">
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden flex">
              <div 
                className="bg-emerald-500 h-full rounded-full transition-all duration-500" 
                style={{ width: `${stats.shippingRate}%` }}
              ></div>
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-slate-400">
              <span>{stats.shippingRate}% Selesai Kirim</span>
              <span>{formatNumber(stats.shippedPcs)} Pcs Terkirim</span>
            </div>
          </div>
        </div>

        {/* Card 3: Potong Stok WMS Pusat */}
        <div className="bg-slate-900/70 border border-slate-800 p-5 rounded-2xl relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Potong Stok WMS Pusat</span>
            <div className="w-8 h-8 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400">
              <Building2 className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-black text-indigo-400">{formatNumber(stats.wmsDeductedCount)}</span>
              <span className="text-xs font-bold text-slate-400">Terpotong</span>
            </div>
            <span className="text-slate-600">/</span>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-black text-amber-400">{formatNumber(stats.wmsNotDeductedCount)}</span>
              <span className="text-[10px] font-bold text-slate-400">Pending</span>
            </div>
          </div>
          {/* Progress bar */}
          <div className="mt-2.5">
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden flex">
              <div 
                className="bg-indigo-500 h-full rounded-full transition-all duration-500" 
                style={{ width: `${stats.wmsDeductRate}%` }}
              ></div>
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-slate-400">
              <span>{stats.wmsDeductRate}% Sudah Dipotong Pusat</span>
              <span>{stats.wmsNotDeductedCount} Order Menunggu</span>
            </div>
          </div>
        </div>

        {/* Card 4: Status Selesai Penuh */}
        <div className="bg-slate-900/70 border border-slate-800 p-5 rounded-2xl relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Order Selesai 100%</span>
            <div className="w-8 h-8 rounded-xl bg-teal-500/10 flex items-center justify-center text-teal-400">
              <PackageCheck className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-black text-teal-400">
              {formatNumber(stats.completedCount)}
            </span>
            <span className="text-xs text-slate-400 font-bold">dari {stats.total} Order</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            Kriteria: Barang telah terkirim <strong>DAN</strong> stok sudah terpotong di pusat.
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="bg-[#11141B] border border-slate-850 rounded-3xl p-6 shadow-2xl">
        {/* Navigation Tabs Filter */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { setActiveTab('ALL'); setShippingFilter('ALL'); setWmsFilter('ALL'); }}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer ${
                activeTab === 'ALL'
                  ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/20'
                  : 'bg-slate-850 text-slate-400 hover:text-slate-200'
              }`}
            >
              Semua Order ({stats.total})
            </button>
            <button
              onClick={() => setActiveTab('ACTION_NEEDED')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'ACTION_NEEDED'
                  ? 'bg-amber-500 text-slate-950 font-black shadow-md'
                  : 'bg-slate-850 text-amber-400/90 hover:bg-slate-800'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Perlu Tindakan ({stats.total - stats.completedCount})</span>
            </button>
            <button
              onClick={() => setActiveTab('NOT_SHIPPED')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'NOT_SHIPPED'
                  ? 'bg-rose-500 text-white shadow-md shadow-rose-500/20'
                  : 'bg-slate-850 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Truck className="w-3.5 h-3.5" />
              <span>Belum Terkirim ({stats.notShippedCount})</span>
            </button>
            <button
              onClick={() => setActiveTab('NOT_DEDUCTED')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'NOT_DEDUCTED'
                  ? 'bg-amber-500 text-slate-950 font-black shadow-md shadow-amber-500/20'
                  : 'bg-slate-850 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>Belum Terpotong WMS Pusat ({stats.wmsNotDeductedCount})</span>
            </button>
            <button
              onClick={() => setActiveTab('COMPLETED')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'COMPLETED'
                  ? 'bg-emerald-500 text-slate-950 font-black shadow-md shadow-emerald-500/20'
                  : 'bg-slate-850 text-slate-400 hover:text-slate-200'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Selesai Lengkap ({stats.completedCount})</span>
            </button>
          </div>

          {/* Quick Bulk Actions Toolbar when orders selected */}
          {selectedBatchIds.length > 0 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-2 bg-slate-900 border border-slate-750 px-3 py-1.5 rounded-xl"
            >
              <span className="text-[11px] font-bold text-indigo-400 mr-1">
                {selectedBatchIds.length} Order Terpilih:
              </span>
              <button
                onClick={handleBulkMarkShipped}
                className="px-2.5 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 rounded-lg text-[10px] font-bold cursor-pointer transition-all"
              >
                Tandai Terkirim
              </button>
              <button
                onClick={handleBulkMarkWmsDeducted}
                className="px-2.5 py-1 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 rounded-lg text-[10px] font-bold cursor-pointer transition-all"
              >
                Tandai Terpotong Pusat
              </button>
              <button
                onClick={() => setSelectedBatchIds([])}
                className="text-slate-400 hover:text-white text-[10px] ml-1 underline cursor-pointer"
              >
                Batal
              </button>
            </motion.div>
          )}
        </div>

        {/* Search & Filter Toolbar */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 mt-4">
          {/* Search Box */}
          <div className="md:col-span-5 relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Cari Nomor Order, No. Pesanan / Resi, Customer, SKU..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-900/90 border border-slate-800 rounded-xl pl-10 pr-9 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-all font-sans"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs p-1"
                title="Hapus pencarian"
              >
                ✕
              </button>
            )}
          </div>

          {/* Filter Status Pengiriman */}
          <div className="md:col-span-3">
            <select
              value={shippingFilter}
              onChange={(e) => setShippingFilter(e.target.value as any)}
              className={`w-full bg-slate-900 border rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:border-indigo-500 cursor-pointer font-bold transition-all ${
                shippingFilter === 'SUDAH_TERKIRIM'
                  ? 'border-emerald-500/50 text-emerald-400 bg-emerald-500/5'
                  : shippingFilter === 'BELUM_TERKIRIM'
                  ? 'border-rose-500/50 text-rose-400 bg-rose-500/5'
                  : 'border-slate-800 text-slate-300'
              }`}
            >
              <option value="ALL">📦 Pengiriman: Semua Status</option>
              <option value="SUDAH_TERKIRIM">🟢 SUDAH_TERKIRIM ({stats.shippedCount})</option>
              <option value="BELUM_TERKIRIM">🔴 BELUM_TERKIRIM ({stats.notShippedCount})</option>
              <option value="DALAM_PENGIRIMAN">🟡 DALAM_PENGIRIMAN ({stats.inTransitCount})</option>
            </select>
          </div>

          {/* Filter Status WMS Pusat */}
          <div className="md:col-span-2">
            <select
              value={wmsFilter}
              onChange={(e) => setWmsFilter(e.target.value as any)}
              className={`w-full bg-slate-900 border rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:border-indigo-500 cursor-pointer font-bold transition-all ${
                wmsFilter === 'SUDAH_TERPOTONG'
                  ? 'border-indigo-500/50 text-indigo-400 bg-indigo-500/5'
                  : wmsFilter === 'BELUM_TERPOTONG'
                  ? 'border-amber-500/50 text-amber-400 bg-amber-500/5'
                  : 'border-slate-800 text-slate-300'
              }`}
            >
              <option value="ALL">🏢 Status WMS: Semua</option>
              <option value="SUDAH_TERPOTONG">🟢 SUDAH_TERPOTONG ({stats.wmsDeductedCount})</option>
              <option value="BELUM_TERPOTONG">🔴 BELUM_TERPOTONG ({stats.wmsNotDeductedCount})</option>
            </select>
          </div>

          {/* Filter Tanggal */}
          <div className="md:col-span-2">
            <select
              value={dateRangeFilter}
              onChange={(e) => setDateRangeFilter(e.target.value as any)}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              <option value="ALL">📅 Semua Tanggal</option>
              <option value="TODAY">Hari Ini</option>
              <option value="WEEK">7 Hari Terakhir</option>
              <option value="MONTH">30 Hari Terakhir</option>
            </select>
          </div>
        </div>

        {/* Quick Filter Status Buttons Bar (Pills & Chips) */}
        <div className="mt-3.5 pt-3 border-t border-slate-800/80 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Filter Pengiriman Buttons */}
            <div className="flex items-center gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-xl">
              <span className="text-[10px] font-black uppercase text-slate-400 px-2 flex items-center gap-1.5 shrink-0">
                <Truck className="w-3.5 h-3.5 text-indigo-400" />
                <span>Pengiriman:</span>
              </span>
              <button
                type="button"
                onClick={() => setShippingFilter('ALL')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                  shippingFilter === 'ALL'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-850'
                }`}
              >
                Semua
              </button>
              <button
                type="button"
                onClick={() => setShippingFilter(shippingFilter === 'SUDAH_TERKIRIM' ? 'ALL' : 'SUDAH_TERKIRIM')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-all cursor-pointer flex items-center gap-1.5 border ${
                  shippingFilter === 'SUDAH_TERKIRIM'
                    ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-md shadow-emerald-500/20'
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                }`}
                title="Filter hanya order dengan status SUDAH_TERKIRIM"
              >
                <CheckCircle2 className="w-3 h-3" />
                <span>SUDAH_TERKIRIM</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-black ${
                  shippingFilter === 'SUDAH_TERKIRIM' ? 'bg-slate-950/40 text-slate-950' : 'bg-emerald-500/20 text-emerald-300'
                }`}>
                  {stats.shippedCount}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setShippingFilter(shippingFilter === 'BELUM_TERKIRIM' ? 'ALL' : 'BELUM_TERKIRIM')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-all cursor-pointer flex items-center gap-1.5 border ${
                  shippingFilter === 'BELUM_TERKIRIM'
                    ? 'bg-rose-500 text-white border-rose-400 shadow-md shadow-rose-500/20'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/20 hover:bg-rose-500/20'
                }`}
                title="Filter hanya order dengan status BELUM_TERKIRIM"
              >
                <XCircle className="w-3 h-3" />
                <span>BELUM_TERKIRIM</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-black ${
                  shippingFilter === 'BELUM_TERKIRIM' ? 'bg-white/30 text-white' : 'bg-rose-500/20 text-rose-300'
                }`}>
                  {stats.notShippedCount}
                </span>
              </button>
            </div>

            {/* Filter WMS Buttons */}
            <div className="flex items-center gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-xl">
              <span className="text-[10px] font-black uppercase text-slate-400 px-2 flex items-center gap-1.5 shrink-0">
                <Building2 className="w-3.5 h-3.5 text-indigo-400" />
                <span>Status WMS:</span>
              </span>
              <button
                type="button"
                onClick={() => setWmsFilter('ALL')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                  wmsFilter === 'ALL'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-850'
                }`}
              >
                Semua
              </button>
              <button
                type="button"
                onClick={() => setWmsFilter(wmsFilter === 'SUDAH_TERPOTONG' ? 'ALL' : 'SUDAH_TERPOTONG')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-all cursor-pointer flex items-center gap-1.5 border ${
                  wmsFilter === 'SUDAH_TERPOTONG'
                    ? 'bg-indigo-500 text-white border-indigo-400 shadow-md shadow-indigo-500/20'
                    : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20 hover:bg-indigo-500/20'
                }`}
                title="Filter hanya order dengan status SUDAH_TERPOTONG"
              >
                <CheckCircle2 className="w-3 h-3" />
                <span>SUDAH_TERPOTONG</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-black ${
                  wmsFilter === 'SUDAH_TERPOTONG' ? 'bg-white/30 text-white' : 'bg-indigo-500/20 text-indigo-300'
                }`}>
                  {stats.wmsDeductedCount}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setWmsFilter(wmsFilter === 'BELUM_TERPOTONG' ? 'ALL' : 'BELUM_TERPOTONG')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-all cursor-pointer flex items-center gap-1.5 border ${
                  wmsFilter === 'BELUM_TERPOTONG'
                    ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-md shadow-amber-500/20'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20'
                }`}
                title="Filter hanya order dengan status BELUM_TERPOTONG"
              >
                <Clock className="w-3 h-3" />
                <span>BELUM_TERPOTONG</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-black ${
                  wmsFilter === 'BELUM_TERPOTONG' ? 'bg-slate-950/40 text-slate-950' : 'bg-amber-500/20 text-amber-300'
                }`}>
                  {stats.wmsNotDeductedCount}
                </span>
              </button>
            </div>
          </div>

          {/* Result Count and Reset Button */}
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-slate-400">
              Menampilkan <strong className="text-white font-mono">{filteredBatches.length}</strong> dari {batches.length} order
            </span>
            {(shippingFilter !== 'ALL' || wmsFilter !== 'ALL' || searchTerm.trim() || dateRangeFilter !== 'ALL') && (
              <button
                type="button"
                onClick={() => {
                  setShippingFilter('ALL');
                  setWmsFilter('ALL');
                  setSearchTerm('');
                  setDateRangeFilter('ALL');
                }}
                className="text-[10px] font-bold text-slate-400 hover:text-white flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-750 transition-all cursor-pointer shrink-0 border border-slate-700"
                title="Reset semua filter ke kondisi awal"
              >
                <RotateCcw className="w-3 h-3 text-indigo-400" />
                <span>Reset Filter</span>
              </button>
            )}
          </div>
        </div>

        {/* Active Filter Tags Bar */}
        {(shippingFilter !== 'ALL' || wmsFilter !== 'ALL' || searchTerm.trim()) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase">Filter Aktif:</span>
            {shippingFilter !== 'ALL' && (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-[10px] font-black border ${
                shippingFilter === 'SUDAH_TERKIRIM'
                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                  : 'bg-rose-500/15 text-rose-400 border-rose-500/30'
              }`}>
                <span>Pengiriman: {shippingFilter}</span>
                <button
                  type="button"
                  onClick={() => setShippingFilter('ALL')}
                  className="hover:text-white cursor-pointer ml-0.5"
                  title="Hapus filter pengiriman"
                >
                  ✕
                </button>
              </span>
            )}
            {wmsFilter !== 'ALL' && (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-[10px] font-black border ${
                wmsFilter === 'SUDAH_TERPOTONG'
                  ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30'
                  : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
              }`}>
                <span>WMS: {wmsFilter}</span>
                <button
                  type="button"
                  onClick={() => setWmsFilter('ALL')}
                  className="hover:text-white cursor-pointer ml-0.5"
                  title="Hapus filter WMS"
                >
                  ✕
                </button>
              </span>
            )}
            {searchTerm.trim() && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                <span>Cari: "{searchTerm}"</span>
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  className="hover:text-white cursor-pointer ml-0.5"
                  title="Hapus kata kunci pencarian"
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        )}

        {/* Orders Table */}
        <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/40">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-900/90 text-[10px] font-black uppercase tracking-wider text-slate-400 border-b border-slate-800">
                <th className="p-3.5 text-center w-10">
                  <input
                    type="checkbox"
                    checked={filteredBatches.length > 0 && selectedBatchIds.length === filteredBatches.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedBatchIds(filteredBatches.map(b => b.id));
                      } else {
                        setSelectedBatchIds([]);
                      }
                    }}
                    className="rounded border-slate-700 bg-slate-800 text-indigo-500 focus:ring-0 cursor-pointer"
                  />
                </th>
                <th className="p-3.5">Nomor Order & Info</th>
                <th className="p-3.5">Customer / Tujuan</th>
                <th className="p-3.5 text-center">Volume</th>
                <th className="p-3.5">
                  <div className="flex items-center gap-1.5">
                    <Truck className="w-3.5 h-3.5 text-slate-400" />
                    <span>Tanda: Sudah Terkirim?</span>
                  </div>
                </th>
                <th className="p-3.5">
                  <div className="flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-slate-400" />
                    <span>Tanda: Potong Stok WMS Pusat?</span>
                  </div>
                </th>
                <th className="p-3.5 text-right pr-4">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850 text-xs">
              {filteredBatches.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-10 text-center">
                    <div className="max-w-xs mx-auto space-y-2">
                      <div className="w-12 h-12 rounded-2xl bg-slate-850 flex items-center justify-center mx-auto text-slate-500">
                        <ShoppingBag className="w-6 h-6" />
                      </div>
                      <p className="text-sm font-bold text-slate-300">Tidak ada nomor order yang sesuai.</p>
                      <p className="text-xs text-slate-500">
                        Coba ubah kata kunci pencarian, filter status pengiriman/WMS, atau buat order baru.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredBatches.map((order) => {
                  const isSelected = selectedBatchIds.includes(order.id);
                  const isShipped = order.shippingStatus === 'SUDAH_TERKIRIM';
                  const isWmsDeducted = order.centralWmsStatus === 'SUDAH_TERPOTONG';
                  const ordNum = order.orderNumber || order.batchNumber;

                  return (
                    <tr 
                      key={order.id}
                      className={`hover:bg-slate-900/60 transition-colors ${
                        isSelected ? 'bg-indigo-950/20' : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="p-3.5 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedBatchIds(prev => [...prev, order.id]);
                            } else {
                              setSelectedBatchIds(prev => prev.filter(id => id !== order.id));
                            }
                          }}
                          className="rounded border-slate-700 bg-slate-800 text-indigo-500 focus:ring-0 cursor-pointer"
                        />
                      </td>

                      {/* Nomor Order & Info */}
                      <td className="p-3.5">
                        <div className="flex items-start gap-2.5">
                          <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 border ${
                            isShipped && isWmsDeducted 
                              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                              : isShipped 
                              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                              : 'bg-slate-800 border-slate-700 text-slate-400'
                          }`}>
                            <ShoppingBag className="w-4 h-4" />
                          </div>
                          <div>
                            <span className="font-black text-white text-sm tracking-wide font-mono block">
                              {ordNum}
                            </span>
                            <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                              <span>{order.createdAt ? new Date(order.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}</span>
                              {order.createdBy && (
                                <>
                                  <span>•</span>
                                  <span>Oleh: {order.createdBy}</span>
                                </>
                              )}
                            </div>
                            {order.sourceReference && (
                              <span className="inline-block mt-1 text-[9px] font-mono text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded">
                                Ref: {order.sourceReference}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Customer / Tujuan */}
                      <td className="p-3.5">
                        <div className="space-y-0.5">
                          <span className="font-bold text-slate-200 block text-xs">
                            {order.customerName || 'Tujuan Umum'}
                          </span>
                          {order.destination && (
                            <span className="text-[10px] text-slate-400 block truncate max-w-[180px]">
                              📍 {order.destination}
                            </span>
                          )}
                          {order.notes && (
                            <span className="text-[10px] text-slate-450 italic block truncate max-w-[180px]">
                              "{order.notes}"
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Volume */}
                      <td className="p-3.5 text-center">
                        <div>
                          <span className="text-sm font-black text-white">
                            {formatNumber(order.totalPcs)}
                          </span>
                          <span className="text-[10px] text-slate-400 block">
                            Pcs ({order.totalSkus} SKU)
                          </span>
                        </div>
                      </td>

                      {/* TANDA: STATUS PENGIRIMAN */}
                      <td className="p-3.5">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            {/* Interactive Badge Toggle */}
                            <button
                              onClick={(e) => handleToggleShipping(order, e)}
                              title="Klik untuk mengubah tanda status pengiriman secara cepat"
                              className={`px-3 py-1.5 rounded-xl font-black text-[11px] flex items-center gap-1.5 transition-all cursor-pointer border shadow-sm ${
                                isShipped
                                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/30'
                                  : order.shippingStatus === 'DALAM_PENGIRIMAN'
                                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                                  : 'bg-rose-500/15 text-rose-400 border-rose-500/30 hover:bg-rose-500/25'
                              }`}
                            >
                              {isShipped ? (
                                <>
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                  <span>SUDAH TERKIRIM</span>
                                </>
                              ) : order.shippingStatus === 'DALAM_PENGIRIMAN' ? (
                                <>
                                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                                  <span>DALAM PENGIRIMAN</span>
                                </>
                              ) : (
                                <>
                                  <XCircle className="w-3.5 h-3.5 text-rose-400" />
                                  <span>BELUM TERKIRIM</span>
                                </>
                              )}
                            </button>

                            {/* Edit detail button */}
                            <button
                              onClick={() => setStatusEditModal({ isOpen: true, batch: order, targetType: 'SHIPPING' })}
                              className="p-1.5 bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-white rounded-lg transition-all"
                              title="Detail Ekspedisi / No Resi"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {/* Extra metadata */}
                          {order.courierName && (
                            <div className="text-[10px] text-slate-400 font-sans flex items-center gap-1">
                              <span>🚚 {order.courierName}</span>
                              {order.trackingNumber && <span className="font-mono text-indigo-300">({order.trackingNumber})</span>}
                            </div>
                          )}
                          {order.shippedAt && (
                            <div className="text-[9px] text-slate-450">
                              Waktu: {new Date(order.shippedAt).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* TANDA: STATUS POTONG STOK WMS PUSAT */}
                      <td className="p-3.5">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            {/* Interactive Badge Toggle */}
                            <button
                              onClick={(e) => handleToggleWms(order, e)}
                              title="Klik untuk mengubah tanda status pemotongan stok WMS pusat"
                              className={`px-3 py-1.5 rounded-xl font-black text-[11px] flex items-center gap-1.5 transition-all cursor-pointer border shadow-sm ${
                                isWmsDeducted
                                  ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40 hover:bg-indigo-500/30'
                                  : 'bg-rose-500/15 text-rose-400 border-rose-500/30 hover:bg-rose-500/25'
                              }`}
                            >
                              {isWmsDeducted ? (
                                <>
                                  <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400" />
                                  <span>TERPOTONG DI PUSAT</span>
                                </>
                              ) : (
                                <>
                                  <XCircle className="w-3.5 h-3.5 text-rose-400" />
                                  <span>BELUM TERPOTONG</span>
                                </>
                              )}
                            </button>

                            {/* Edit detail button */}
                            <button
                              onClick={() => setStatusEditModal({ isOpen: true, batch: order, targetType: 'WMS' })}
                              className="p-1.5 bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-white rounded-lg transition-all"
                              title="Detail No Dokumen WMS Pusat"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {/* Extra metadata */}
                          {order.centralWmsDocNumber && (
                            <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                              <span>Doc: {order.centralWmsDocNumber}</span>
                            </div>
                          )}
                          {order.centralWmsDeductedAt && (
                            <div className="text-[9px] text-slate-450">
                              Sync: {new Date(order.centralWmsDeductedAt).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="p-3.5 text-right pr-4">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => setDetailModalBatch(order)}
                            className="p-1.5 bg-slate-855 hover:bg-slate-800 text-slate-300 hover:text-white rounded-lg transition-all"
                            title="Lihat Daftar SKU dalam Order"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handlePrintOrder(order)}
                            className="p-1.5 bg-slate-855 hover:bg-slate-800 text-indigo-400 hover:text-indigo-300 rounded-lg transition-all"
                            title="Cetak Tanda Terima / Surat Jalan Order"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`Hapus data order ${ordNum}?`)) {
                                onDeleteBatch(order.id);
                                showToast(`Order ${ordNum} berhasil dihapus.`);
                              }
                            }}
                            className="p-1.5 bg-slate-855 hover:bg-rose-950 text-slate-500 hover:text-rose-400 rounded-lg transition-all"
                            title="Hapus Order"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
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
      </div>

      {/* MODAL 1: Detail Order & Rincian SKU */}
      <AnimatePresence>
        {detailModalBatch && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-[#11141B] border border-slate-800 rounded-3xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
            >
              {/* Modal Header */}
              <div className="p-6 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black uppercase text-indigo-400 tracking-wider">Rincian Order</span>
                    <span className="bg-slate-800 text-slate-300 font-mono text-xs px-2 py-0.5 rounded-md">
                      {detailModalBatch.orderNumber || detailModalBatch.batchNumber}
                    </span>
                  </div>
                  <h3 className="text-lg font-black text-white mt-1">
                    {detailModalBatch.customerName || 'Customer Umum'}
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handlePrintOrder(detailModalBatch)}
                    className="p-2 bg-slate-800 hover:bg-slate-750 text-indigo-400 rounded-xl transition-all"
                    title="Cetak Surat Jalan"
                  >
                    <Printer className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setDetailModalBatch(null)}
                    className="p-2 bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-white rounded-xl transition-all"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Status Badges in Modal */}
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-950/40 border-b border-slate-850">
                {/* Shipping box */}
                <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Status Pengiriman</span>
                    <span className={`text-[10px] font-black px-2.5 py-1 rounded-full border ${
                      detailModalBatch.shippingStatus === 'SUDAH_TERKIRIM'
                        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                        : detailModalBatch.shippingStatus === 'DALAM_PENGIRIMAN'
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                        : 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                    }`}>
                      {detailModalBatch.shippingStatus === 'SUDAH_TERKIRIM' ? 'SUDAH TERKIRIM' : detailModalBatch.shippingStatus === 'DALAM_PENGIRIMAN' ? 'DALAM PENGIRIMAN' : 'BELUM TERKIRIM'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-300 space-y-1 pt-1">
                    <div>Ekspedisi: <strong>{detailModalBatch.courierName || '-'}</strong></div>
                    <div>No. Resi/DO: <strong className="font-mono">{detailModalBatch.trackingNumber || '-'}</strong></div>
                    <div>Supir / Armada: <strong>{detailModalBatch.driverName || '-'} {detailModalBatch.vehiclePlate ? `(${detailModalBatch.vehiclePlate})` : ''}</strong></div>
                  </div>
                </div>

                {/* Central WMS box */}
                <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Potong Stok WMS Pusat</span>
                    <span className={`text-[10px] font-black px-2.5 py-1 rounded-full border ${
                      detailModalBatch.centralWmsStatus === 'SUDAH_TERPOTONG'
                        ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
                        : 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                    }`}>
                      {detailModalBatch.centralWmsStatus === 'SUDAH_TERPOTONG' ? 'TERPOTONG DI PUSAT' : 'BELUM TERPOTONG'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-300 space-y-1 pt-1">
                    <div>No. Dokumen Pusat: <strong className="font-mono">{detailModalBatch.centralWmsDocNumber || '-'}</strong></div>
                    <div>Waktu Sinkronisasi: <strong>{detailModalBatch.centralWmsDeductedAt ? new Date(detailModalBatch.centralWmsDeductedAt).toLocaleString('id-ID') : '-'}</strong></div>
                    <div>Petugas: <strong>{detailModalBatch.centralWmsDeductedBy || '-'}</strong></div>
                  </div>
                </div>
              </div>

              {/* SKU Items Table */}
              <div className="p-6 overflow-y-auto flex-1">
                <h4 className="text-xs font-black uppercase text-slate-400 tracking-wider mb-3 flex items-center justify-between">
                  <span>Daftar SKU Dalam Order ({detailModalBatch.items?.length || 0} Item)</span>
                  <span className="text-white font-mono">{formatNumber(detailModalBatch.totalPcs)} Total Pcs</span>
                </h4>

                <div className="rounded-xl border border-slate-800 overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-900 text-[10px] font-black text-slate-400 uppercase">
                        <th className="p-2.5 pl-3">SKU ID</th>
                        <th className="p-2.5">Nama Produk</th>
                        <th className="p-2.5 text-center">Lokasi</th>
                        <th className="p-2.5 text-center">Expired Date</th>
                        <th className="p-2.5 text-right pr-3">Qty (Pcs)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-850">
                      {(!detailModalBatch.items || detailModalBatch.items.length === 0) ? (
                        <tr>
                          <td colSpan={5} className="p-6 text-center text-slate-500">
                            Tidak ada rincian baris SKU spesifik yang tercatat.
                          </td>
                        </tr>
                      ) : (
                        detailModalBatch.items.map((item, i) => (
                          <tr key={i} className="hover:bg-slate-900/40">
                            <td className="p-2.5 pl-3 font-mono font-bold text-indigo-400">{item.skuId}</td>
                            <td className="p-2.5 text-slate-200">{item.skuName}</td>
                            <td className="p-2.5 text-center font-mono text-slate-400">{item.location || '-'}</td>
                            <td className="p-2.5 text-center font-mono text-slate-400">{item.expiredDate || '-'}</td>
                            <td className="p-2.5 pr-3 text-right font-black text-white">{formatNumber(item.qty)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="p-4 bg-slate-900/80 border-t border-slate-800 flex justify-end">
                <button
                  onClick={() => setDetailModalBatch(null)}
                  className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-xl transition-all cursor-pointer"
                >
                  Tutup
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL 2: Edit Detail Status Pengiriman & WMS Pusat */}
      <AnimatePresence>
        {statusEditModal.isOpen && statusEditModal.batch && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-[#11141B] border border-slate-800 rounded-3xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col"
            >
              {/* Header */}
              <div className="p-6 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="text-base font-black text-white flex items-center gap-2">
                    <Edit3 className="w-4 h-4 text-indigo-400" />
                    <span>Update Status & Dokumen Order</span>
                  </h3>
                  <p className="text-xs text-slate-400 font-mono mt-0.5">
                    Order: {statusEditModal.batch.orderNumber || statusEditModal.batch.batchNumber}
                  </p>
                </div>
                <button
                  onClick={() => setStatusEditModal({ isOpen: false, batch: null, targetType: 'SHIPPING' })}
                  className="p-1.5 bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-white rounded-xl transition-all"
                >
                  ✕
                </button>
              </div>

              {/* Body */}
              <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
                {/* 1. SEKSI PENGIRIMAN */}
                <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-emerald-400">
                    <Truck className="w-4 h-4" />
                    <span>1. Tanda & Status Pengiriman Barang</span>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Status Pengiriman</label>
                    <select
                      value={editShippingStatus}
                      onChange={(e) => setEditShippingStatus(e.target.value as any)}
                      className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="BELUM_TERKIRIM">🔴 BELUM TERKIRIM</option>
                      <option value="DALAM_PENGIRIMAN">🟡 DALAM PENGIRIMAN</option>
                      <option value="SUDAH_TERKIRIM">🟢 SUDAH TERKIRIM</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-400 mb-1">Ekspedisi / Kurir</label>
                      <input
                        type="text"
                        placeholder="Contoh: J&T Cargo, SiCepat, Internal"
                        value={editCourierName}
                        onChange={(e) => setEditCourierName(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-400 mb-1">No. Resi / Surat Jalan / DO</label>
                      <input
                        type="text"
                        placeholder="No. Resi pelacakan"
                        value={editTrackingNumber}
                        onChange={(e) => setEditTrackingNumber(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-400 mb-1">Nama Supir / Driver</label>
                      <input
                        type="text"
                        placeholder="Nama personil pengirim"
                        value={editDriverName}
                        onChange={(e) => setEditDriverName(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-400 mb-1">No. Plat Kendaraan</label>
                      <input
                        type="text"
                        placeholder="Contoh: B 1234 WMS"
                        value={editVehiclePlate}
                        onChange={(e) => setEditVehiclePlate(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>
                </div>

                {/* 2. SEKSI POTONG STOK WMS PUSAT */}
                <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-indigo-400">
                    <Building2 className="w-4 h-4" />
                    <span>2. Tanda & Pemotongan Stok WMS Pusat</span>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Status Potong Stok di WMS Pusat</label>
                    <select
                      value={editWmsStatus}
                      onChange={(e) => setEditWmsStatus(e.target.value as any)}
                      className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="BELUM_TERPOTONG">🔴 BELUM TERPOTONG DI WMS PUSAT</option>
                      <option value="SUDAH_TERPOTONG">🟢 SUDAH TERPOTONG DI WMS PUSAT</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">
                      Nomor Dokumen / SAP / No Transaksi WMS Pusat
                    </label>
                    <input
                      type="text"
                      placeholder="Contoh: SAP-GI-20261009-881 atau WMS-CUT-001"
                      value={editWmsDocNumber}
                      onChange={(e) => setEditWmsDocNumber(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-400 mb-1">Catatan Sinkronisasi WMS Pusat</label>
                    <input
                      type="text"
                      placeholder="Catatan verifikasi tim admin pusat..."
                      value={editWmsNotes}
                      onChange={(e) => setEditWmsNotes(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="p-4 bg-slate-900/80 border-t border-slate-800 flex justify-end gap-2.5">
                <button
                  onClick={() => setStatusEditModal({ isOpen: false, batch: null, targetType: 'SHIPPING' })}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-bold rounded-xl transition-all cursor-pointer"
                >
                  Batal
                </button>
                <button
                  onClick={handleSaveModalForm}
                  className="px-5 py-2 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-black rounded-xl transition-all cursor-pointer shadow-lg shadow-indigo-500/20"
                >
                  Simpan Perubahan
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL 3: Buat / Registrasi Order Baru */}
      <AnimatePresence>
        {isCreateModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-[#11141B] border border-slate-800 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="p-6 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="text-base font-black text-white flex items-center gap-2">
                    <ShoppingBag className="w-5 h-5 text-indigo-400" />
                    <span>Registrasi Nomor Order Baru</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Tambahkan nomor order baru untuk mulai melacak pengiriman dan pemotongan stok WMS pusat.
                  </p>
                </div>
                <button
                  onClick={() => setIsCreateModalOpen(false)}
                  className="p-1.5 bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-white rounded-xl transition-all"
                >
                  ✕
                </button>
              </div>

              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    Nomor Order / No. Pesanan <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="Contoh: ORD-20261009-001 atau SO-20261009-082"
                    value={newOrderNumber}
                    onChange={(e) => setNewOrderNumber(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    Pilih Dari Referensi Outbound (Opsional)
                  </label>
                  <select
                    value={selectedOrderRefForNewBatch}
                    onChange={(e) => {
                      const ref = e.target.value;
                      setSelectedOrderRefForNewBatch(ref);
                      if (ref && !newOrderNumber) {
                        setNewOrderNumber(ref);
                      }
                    }}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">-- Buat Order Baru Bebas / Mandiri --</option>
                    {availableOutboundReferences.map(ref => (
                      <option key={ref} value={ref}>{ref}</option>
                    ))}
                  </select>
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    Jika dipilih, seluruh item SKU dari referensi outbound tersebut akan otomatis dimasukkan ke dalam order ini.
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1">Nama Customer</label>
                    <input
                      type="text"
                      placeholder="Contoh: Tokopedia / Shopee / Retailer"
                      value={newCustomerName}
                      onChange={(e) => setNewCustomerName(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1">Tujuan / Alamat Kirim</label>
                    <input
                      type="text"
                      placeholder="Contoh: Jakarta Barat, Hub DC"
                      value={newDestination}
                      onChange={(e) => setNewDestination(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">Catatan Tambahan</label>
                  <textarea
                    rows={2}
                    placeholder="Instruksi packing, nomor PO, dsb..."
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="p-4 bg-slate-900/80 border-t border-slate-800 flex justify-end gap-2.5">
                <button
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-bold rounded-xl transition-all cursor-pointer"
                >
                  Batal
                </button>
                <button
                  onClick={handleCreateOrder}
                  className="px-5 py-2 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-black rounded-xl transition-all cursor-pointer shadow-lg shadow-indigo-500/20"
                >
                  Simpan & Daftarkan Order
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
