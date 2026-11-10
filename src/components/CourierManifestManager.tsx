import React, { useState, useMemo, useEffect, useRef } from 'react';
import { OutboundItem } from '../types';
import { formatToWibString } from '../utils/calculations';
import { supabase, getActiveBranch } from '../supabase';
import * as XLSX from 'xlsx';
import { 
  Truck, 
  Search, 
  Printer, 
  CheckCircle, 
  Barcode, 
  Trash2, 
  FileText, 
  Calendar, 
  Building2, 
  Package, 
  ArrowRight,
  ShieldCheck,
  RotateCcw,
  Download,
  FileSpreadsheet,
  Zap
} from 'lucide-react';

export interface ShippingManifest {
  manifestId: string;
  branchId?: string;
  warehouseId?: string;
  warehouseName?: string;
  senderName?: string;
  courierName: string;
  driverName?: string;
  driverPhone?: string;
  vehiclePlate?: string;
  handedOverBy: string;
  handedOverAt: string;
  totalOrders: number;
  totalQtyPcs: number;
  orderReferences: string[];
  notes?: string;
}

interface CourierManifestManagerProps {
  orderHistory: OutboundItem[];
  currentUser?: { username: string; role: string; fullName: string } | null;
  onUpdateOrdersShipped?: (orderRefs: string[], manifestInfo: Partial<ShippingManifest>, isCancelled?: boolean) => Promise<boolean>;
  warehouses?: { id: string; name: string }[];
  selectedWarehouseId?: string;
  onSelectWarehouseId?: (whId: string) => void;
}

export default function CourierManifestManager({
  orderHistory = [],
  currentUser,
  onUpdateOrdersShipped,
  warehouses = [],
  selectedWarehouseId = 'WH-CENTRAL',
  onSelectWarehouseId
}: CourierManifestManagerProps) {
  // Warehouse context
  const currentWarehouseId = (selectedWarehouseId || 'WH-CENTRAL').toUpperCase();
  const currentWarehouse = warehouses.find(w => w.id.toUpperCase() === currentWarehouseId) || {
    id: currentWarehouseId,
    name: currentWarehouseId === 'WH-CENTRAL' ? 'Gudang Pusat (Central DC)' : currentWarehouseId
  };

  // Filter riwayat manifest: 'CURRENT' (hanya gudang aktif) atau 'ALL' (semua cabang)
  const [manifestHistoryFilter, setManifestHistoryFilter] = useState<'CURRENT' | 'ALL'>('CURRENT');

  // Ekspedisi options
  const COURIER_OPTIONS = [
    'J&T Express',
    'Shopee Xpress (SPX)',
    'SiCepat Ekspres',
    'JNE Express',
    'Ninja Xpress',
    'Anteraja',
    'ID Express',
    'Wahana',
    'TIKI',
    'GoSend / GrabExpress',
    'Lalamove',
    'Armada Internal Toko',
    'Lainnya'
  ];

  const [selectedCourier, setSelectedCourier] = useState<string>('J&T Express');
  const [customCourier, setCustomCourier] = useState<string>('');
  const [driverName, setDriverName] = useState<string>('');
  const [driverPhone, setDriverPhone] = useState<string>('');
  const [vehiclePlate, setVehiclePlate] = useState<string>('');
  const [manifestNotes, setManifestNotes] = useState<string>('');

  // Sender info (Nama Pengirim Cabang)
  const [senderName, setSenderName] = useState<string>('');
  const [senderPhone, setSenderPhone] = useState<string>('');
  const activeBranch = getActiveBranch();

  useEffect(() => {
    let isLive = true;
    (async () => {
      try {
        if (!supabase) return;
        const { data } = await supabase
          .from('branches')
          .select('sender_name, sender_phone')
          .eq('id', activeBranch)
          .maybeSingle();
        if (isLive && data) {
          if (data.sender_name) setSenderName(data.sender_name);
          if (data.sender_phone) setSenderPhone(data.sender_phone);
        }
      } catch (err) {
        console.warn('Gagal memuat nama pengirim cabang', err);
      }
    })();
    return () => { isLive = false; };
  }, [activeBranch]);

  // Scan input resi / order number
  const [scanInput, setScanInput] = useState<string>('');
  const [scanFeedback, setScanFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);

  // 1. Peta seluruh order completed (untuk lookup referensi dokumen cetak & Excel)
  const allCompletedOrdersMap = useMemo(() => {
    const map = new Map<string, {
      referenceNumber: string;
      batchNumber: string;
      orderNumber: string;
      noPo: string;
      customerName: string;
      warehouseId: string;
      totalSku: number;
      totalQty: number;
      completedAt: string;
      items: OutboundItem[];
    }>();

    orderHistory.filter(i => i.status === 'Completed').forEach(item => {
      const ref = item.referenceNumber || item.orderNumber || item.id;
      const whId = (item.warehouseId || 'WH-CENTRAL').toUpperCase();
      if (!map.has(ref)) {
        map.set(ref, {
          referenceNumber: ref,
          batchNumber: item.batchNumber || item.referenceNumber || '-',
          orderNumber: item.orderNumber || '-',
          noPo: item.noPo || '-',
          customerName: item.customerName || 'Customer Umum',
          warehouseId: whId,
          totalSku: 0,
          totalQty: 0,
          completedAt: item.completedAt || item.timestamp,
          items: []
        });
      }
      const entry = map.get(ref)!;
      entry.totalSku += 1;
      entry.totalQty += item.qty;
      entry.items.push(item);
    });

    return map;
  }, [orderHistory]);

  // Antrean scan untuk manifest saat ini
  const [manifestOrderRefs, setManifestOrderRefs] = useState<string[]>([]);
  const deletedManifestIds = useRef<Set<string>>(new Set());
  const [createdManifests, setCreatedManifests] = useState<ShippingManifest[]>(() => {
    try {
      const stored = localStorage.getItem('blues-shipping-manifests');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Sinkronisasi dokumen manifest dari orderHistory agar multi-device dan lintas sesi tetap konsisten
  useEffect(() => {
    const existingIds = new Set(createdManifests.map(m => m.manifestId));
    const reconstructedMap = new Map<string, ShippingManifest>();

    orderHistory.filter(i => i.shipped && i.manifestId).forEach(item => {
      const mId = item.manifestId!;
      if (existingIds.has(mId) || deletedManifestIds.current.has(mId)) return;
      const ref = item.referenceNumber || item.orderNumber || item.id;
      const itemWh = (item.warehouseId || 'WH-CENTRAL').toUpperCase();
      const matchedWh = warehouses.find(w => w.id.toUpperCase() === itemWh);
      if (!reconstructedMap.has(mId)) {
        reconstructedMap.set(mId, {
          manifestId: mId,
          branchId: activeBranch,
          warehouseId: itemWh,
          warehouseName: matchedWh?.name || (itemWh === 'WH-CENTRAL' ? 'Gudang Pusat (Central DC)' : itemWh),
          courierName: item.notes?.match(/\[Kurir:\s*([^\]]+)\]/)?.[1] || 'Ekspedisi Terkonfirmasi',
          handedOverBy: item.shippedBy || 'Petugas WMS',
          handedOverAt: item.shippedAt || item.timestamp,
          totalOrders: 0,
          totalQtyPcs: 0,
          orderReferences: [],
          notes: item.notes
        });
      }
      const entry = reconstructedMap.get(mId)!;
      if (!entry.orderReferences.includes(ref)) {
        entry.orderReferences.push(ref);
        entry.totalOrders += 1;
      }
      entry.totalQtyPcs += item.qty;
    });

    if (reconstructedMap.size > 0) {
      const merged = [...Array.from(reconstructedMap.values()), ...createdManifests];
      setCreatedManifests(merged);
      try {
        localStorage.setItem('blues-shipping-manifests', JSON.stringify(merged));
      } catch {}
    }
  }, [orderHistory, createdManifests, activeBranch, warehouses]);

  // 2. Kumpulan nomor order / ref yang sudah pernah masuk ke dalam dokumen manifest yang tersimpan
  const manifestedRefNumbers = useMemo(() => {
    const set = new Set<string>();
    createdManifests.forEach(m => {
      (m.orderReferences || []).forEach(ref => set.add(ref));
    });
    return set;
  }, [createdManifests]);

  // 3. Order completed yang SIAP DISERAHKAN (belum pernah di-manifest dan belum dikirim) SESUAI GUDANG TERPILIH
  const completedOrders = useMemo(() => {
    return Array.from(allCompletedOrdersMap.values()).filter(o => 
      !manifestedRefNumbers.has(o.referenceNumber) &&
      !o.items.some(i => i.shipped) &&
      (o.warehouseId || 'WH-CENTRAL').toUpperCase() === currentWarehouseId
    );
  }, [allCompletedOrdersMap, manifestedRefNumbers, currentWarehouseId]);

  // 4. Riwayat Dokumen Manifest Terfilter berdasarkan Cabang / Gudang
  const visibleManifests = useMemo(() => {
    return createdManifests.filter(m => {
      if ((m.branchId || 'CENTER') !== activeBranch) return false;
      if (manifestHistoryFilter === 'ALL') return true;
      const mWh = (m.warehouseId || 'WH-CENTRAL').toUpperCase();
      return mWh === currentWarehouseId;
    });
  }, [createdManifests, activeBranch, manifestHistoryFilter, currentWarehouseId]);

  // Modal cetak manifest
  const [printManifest, setPrintManifest] = useState<ShippingManifest | null>(null);

  // Orders dalam antrean manifest saat ini
  const activeManifestOrders = useMemo(() => {
    return completedOrders.filter(o => manifestOrderRefs.includes(o.referenceNumber));
  }, [completedOrders, manifestOrderRefs]);

  const totalScannedPcs = useMemo(() => {
    return activeManifestOrders.reduce((sum, o) => sum + o.totalQty, 0);
  }, [activeManifestOrders]);

  const activeCourierName = selectedCourier === 'Lainnya' ? (customCourier.trim() || 'Ekspedisi Lainnya') : selectedCourier;

  // Cek apakah pengguna saat ini adalah Admin / Administrator
  const isAdmin = ['admin', 'administrator'].includes((currentUser?.role || '').toLowerCase());

  // Orders completed yang belum masuk ke antrean manifest saat ini
  const unselectedOrders = useMemo(() => {
    return completedOrders.filter(o => !manifestOrderRefs.includes(o.referenceNumber));
  }, [completedOrders, manifestOrderRefs]);

  // Fitur Khusus Admin: Masukkan seluruh order completed ke antrean manifest tanpa scan satu per satu
  const handleAdminSelectAll = () => {
    if (unselectedOrders.length === 0) return;
    playScanBeep();
    const allRefs = completedOrders.map(o => o.referenceNumber);
    setManifestOrderRefs(allRefs);
    setScanFeedback({
      type: 'success',
      message: `⚡ [ADMIN] Seluruh ${allRefs.length} order completed (${completedOrders.reduce((s, o) => s + o.totalQty, 0)} Pcs) berhasil dimasukkan ke manifest!`
    });
  };

  // Fitur Khusus Admin: Kirim & Terbitkan Manifest seluruh order completed langsung dalam satu klik
  const handleAdminSendAllDirectly = () => {
    if (completedOrders.length === 0) {
      alert('Tidak ada pesanan berstatus Completed yang siap diserahkan.');
      return;
    }

    const totalOrders = completedOrders.length;
    const totalPcs = completedOrders.reduce((sum, o) => sum + o.totalQty, 0);

    const confirmed = window.confirm(
      `⚡ KONFIRMASI KHUSUS ADMIN:\n\nKirim dan buat dokumen Surat Jalan Manifest untuk SELURUH ${totalOrders} order completed (${totalPcs} Pcs) ke ekspedisi "${activeCourierName}" tanpa perlu scan satu per satu?\n\nSemua order akan otomatis dirangkum ke dalam satu dokumen Manifest serah terima kurir.`
    );
    if (!confirmed) return;

    playScanBeep();
    const manifestId = `MNF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
    const resolvedSender = senderName.trim() || 'PENGIRIM';
    const newManifest: ShippingManifest = {
      manifestId,
      branchId: activeBranch,
      warehouseId: currentWarehouseId,
      warehouseName: currentWarehouse.name,
      senderName: resolvedSender,
      courierName: activeCourierName,
      driverName: driverName.trim() || undefined,
      driverPhone: driverPhone.trim() || undefined,
      vehiclePlate: vehiclePlate.trim().toUpperCase() || undefined,
      handedOverBy: currentUser?.fullName || currentUser?.username || 'Admin WMS',
      handedOverAt: new Date().toISOString(),
      totalOrders,
      totalQtyPcs: totalPcs,
      orderReferences: completedOrders.map(o => o.referenceNumber),
      notes: manifestNotes.trim() ? `${manifestNotes.trim()} [Admin Bulk Handover]` : '[Admin Bulk Handover]'
    };

    const updatedManifests = [newManifest, ...createdManifests];
    setCreatedManifests(updatedManifests);
    try {
      localStorage.setItem('blues-shipping-manifests', JSON.stringify(updatedManifests));
      window.dispatchEvent(new Event('blues-manifests-updated'));
    } catch (e) {
      console.warn('Failed to save manifest locally', e);
    }

    const targetRefs = completedOrders.map(o => o.referenceNumber);
    if (onUpdateOrdersShipped) {
      onUpdateOrdersShipped(targetRefs, newManifest).catch(err => {
        console.error('Gagal sinkron status kirim ke order history:', err);
      });
    }

    setManifestOrderRefs([]);
    setDriverName('');
    setDriverPhone('');
    setVehiclePlate('');
    setManifestNotes('');
    setScanFeedback({
      type: 'success',
      message: `⚡ [ADMIN] Berhasil membuat Manifest ${manifestId} untuk seluruh ${totalOrders} order (${totalPcs} Pcs)!`
    });

    setPrintManifest(newManifest);
  };

  // Batalkan / Hapus dokumen manifest dan kembalikan order ke status Siap Diserahkan
  const handleDeleteManifest = (manifestId: string) => {
    const target = createdManifests.find(m => m.manifestId === manifestId);
    if (!target) return;
    const confirmed = window.confirm(
      `⚠️ BATALKAN MANIFEST:\n\nBatalkan dokumen ${target.manifestId} (${target.courierName} - ${target.totalOrders} Order)?\n\nSeluruh pesanan dalam manifest ini akan dikembalikan ke status 'Siap Diserahkan'.`
    );
    if (!confirmed) return;

    deletedManifestIds.current.add(manifestId);
    const remaining = createdManifests.filter(m => m.manifestId !== manifestId);
    setCreatedManifests(remaining);
    try {
      localStorage.setItem('blues-shipping-manifests', JSON.stringify(remaining));
      window.dispatchEvent(new Event('blues-manifests-updated'));
    } catch (e) {
      console.warn('Failed to update local manifests', e);
    }

    if (onUpdateOrdersShipped && target.orderReferences && target.orderReferences.length > 0) {
      onUpdateOrdersShipped(target.orderReferences, {}, true).catch(err => {
        console.error('Gagal mengembalikan status kirim:', err);
      });
    }

    setScanFeedback({
      type: 'success',
      message: `✓ Manifest ${manifestId} dibatalkan. ${target.totalOrders} order dikembalikan ke status Siap Diserahkan.`
    });
  };

  // Sound effects
  const playScanBeep = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.1);
    } catch {}
  };

  const playScanError = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.25);
    } catch {}
  };

  // Helper untuk proses scan otomatis
  const processBarcodeScan = (rawQuery: string) => {
    const query = rawQuery.trim().toUpperCase();
    if (!query) return;

    // Cari di completedOrders by referenceNumber, orderNumber, noPo, atau batchNumber
    const matched = completedOrders.find(o => 
      o.referenceNumber.toUpperCase() === query ||
      o.orderNumber.toUpperCase() === query ||
      o.noPo.toUpperCase() === query ||
      o.batchNumber.toUpperCase() === query ||
      o.items.some(i => i.id.toUpperCase() === query || i.skuId.toUpperCase() === query)
    );

    if (!matched) {
      playScanError();
      setScanFeedback({
        type: 'error',
        message: `❌ Order / Resi "${query}" tidak ditemukan atau belum berstatus COMPLETED di Packing!`
      });
      setScanInput('');
      return;
    }

    if (manifestOrderRefs.includes(matched.referenceNumber)) {
      playScanError();
      setScanFeedback({
        type: 'error',
        message: `⚠️ Order "${matched.referenceNumber}" (${matched.customerName}) sudah ada di daftar manifest!`
      });
      setScanInput('');
      return;
    }

    playScanBeep();
    setManifestOrderRefs(prev => [matched.referenceNumber, ...prev]);
    setScanFeedback({
      type: 'success',
      message: `✓ Otomatis masuk: ${matched.referenceNumber} (${matched.customerName} - ${matched.totalQty} Pcs)`
    });
    setScanInput('');
  };

  // Handle Scan barcode order / resi submit
  const handleScanSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    processBarcodeScan(scanInput);
  };

  // Otomatis deteksi input scanner barcode (jika scanner mengirimkan panjang barcode >= 5 karakter dan ada jeda / enter)
  const handleInputChange = (val: string) => {
    setScanInput(val);
    const trimmed = val.trim();
    // Jika barcode cocok persis dengan salah satu order completed, langsung proses tanpa perlu tekan tombol
    if (trimmed.length >= 3) {
      const isExactMatch = completedOrders.some(o => 
        o.referenceNumber.toUpperCase() === trimmed.toUpperCase() ||
        o.orderNumber.toUpperCase() === trimmed.toUpperCase() ||
        (o.noPo && o.noPo !== '-' && o.noPo.toUpperCase() === trimmed.toUpperCase()) ||
        (o.batchNumber && o.batchNumber !== '-' && o.batchNumber.toUpperCase() === trimmed.toUpperCase())
      );
      if (isExactMatch) {
        processBarcodeScan(trimmed);
      }
    }
  };

  // Hapus dari antrean scan
  const handleRemoveFromQueue = (ref: string) => {
    setManifestOrderRefs(prev => prev.filter(r => r !== ref));
  };

  // Export Manifest ke Excel
  const handleExportExcel = (manifest: ShippingManifest) => {
    try {
      const exportRows = manifest.orderReferences.map((ref, i) => {
        const matched = allCompletedOrdersMap.get(ref);
        return {
          'No': i + 1,
          'No. Manifest': manifest.manifestId,
          'Gudang / Cabang': manifest.warehouseName || manifest.warehouseId || 'Gudang Pusat',
          'Ekspedisi': manifest.courierName,
          'Driver': manifest.driverName || '-',
          'Plat Nomor': manifest.vehiclePlate || '-',
          'Waktu Serah Terima': formatToWibString(manifest.handedOverAt),
          'No. Order / Ref': ref,
          'Batch Number': matched?.batchNumber || '-',
          'No. PO': matched?.noPo || '-',
          'Customer / Penerima': matched?.customerName || '-',
          'Total SKU': matched?.totalSku || 0,
          'Total Qty (Pcs)': matched?.totalQty || 0,
          'Status Fisik': 'Selesai Packing & Serah Terima',
          'Petugas WMS': manifest.handedOverBy,
          'Catatan': manifest.notes || '-'
        };
      });

      const worksheet = XLSX.utils.json_to_sheet(exportRows);
      worksheet['!cols'] = [
        { wch: 6 },
        { wch: 22 },
        { wch: 18 },
        { wch: 18 },
        { wch: 14 },
        { wch: 20 },
        { wch: 22 },
        { wch: 22 },
        { wch: 16 },
        { wch: 28 },
        { wch: 12 },
        { wch: 16 },
        { wch: 28 },
        { wch: 22 },
        { wch: 25 }
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Surat Jalan Manifest');
      XLSX.writeFile(workbook, `Manifest_${manifest.courierName.replace(/[\s\/]+/g, '_')}_${manifest.manifestId}.xlsx`);
    } catch (err) {
      console.error('Gagal mengekspor manifest ke Excel', err);
      alert('Gagal mengekspor data manifest ke Excel.');
    }
  };
  const handleCreateManifest = () => {
    if (activeManifestOrders.length === 0) {
      alert('Pindai atau masukkan minimal 1 order yang akan diserahkan ke kurir.');
      return;
    }

    const manifestId = `MNF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
    const resolvedSender = senderName.trim() || 'PENGIRIM';
    const newManifest: ShippingManifest = {
      manifestId,
      branchId: activeBranch,
      warehouseId: currentWarehouseId,
      warehouseName: currentWarehouse.name,
      senderName: resolvedSender,
      courierName: activeCourierName,
      driverName: driverName.trim() || undefined,
      driverPhone: driverPhone.trim() || undefined,
      vehiclePlate: vehiclePlate.trim().toUpperCase() || undefined,
      handedOverBy: currentUser?.fullName || currentUser?.username || 'Petugas Ekspedisi',
      handedOverAt: new Date().toISOString(),
      totalOrders: activeManifestOrders.length,
      totalQtyPcs: totalScannedPcs,
      orderReferences: activeManifestOrders.map(o => o.referenceNumber),
      notes: manifestNotes.trim() || undefined
    };

    const updatedManifests = [newManifest, ...createdManifests];
    setCreatedManifests(updatedManifests);
    try {
      localStorage.setItem('blues-shipping-manifests', JSON.stringify(updatedManifests));
      window.dispatchEvent(new Event('blues-manifests-updated'));
    } catch (e) {
      console.warn('Failed to save manifest locally', e);
    }

    const targetRefs = activeManifestOrders.map(o => o.referenceNumber);
    if (onUpdateOrdersShipped) {
      onUpdateOrdersShipped(targetRefs, newManifest).catch(err => {
        console.error('Gagal sinkron status kirim ke order history:', err);
      });
    }

    // Reset antrean
    setManifestOrderRefs([]);
    setDriverName('');
    setDriverPhone('');
    setVehiclePlate('');
    setManifestNotes('');
    setScanFeedback({
      type: 'success',
      message: `✓ Manifest ${manifestId} berhasil dibuat untuk ${newManifest.totalOrders} order!`
    });

    // Otomatis buka jendela cetak
    setPrintManifest(newManifest);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-[#11141B] rounded-2xl p-6 border border-slate-800/80 shadow-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
                <Truck className="w-5 h-5" />
              </div>
              <h2 className="text-xl font-extrabold tracking-tight text-white">
                5. Manifest Serah Terima Ekspedisi / Kurir
              </h2>
            </div>
            <p className="text-slate-400 text-xs md:text-sm mt-1">
              Catat serah terima paket yang telah dipacking kepada pihak kurir/ekspedisi (J&T, SPX, SiCepat, dll) lengkap dengan bukti cetak tanda terima manifest.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {warehouses && warehouses.length > 0 && onSelectWarehouseId && (
              <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5">
                <span className="text-[11px] text-slate-400 font-bold">Gudang:</span>
                <select
                  value={currentWarehouseId}
                  onChange={e => onSelectWarehouseId(e.target.value)}
                  className="bg-transparent text-emerald-400 font-bold text-xs focus:outline-none cursor-pointer"
                >
                  {warehouses.map(w => (
                    <option key={w.id} value={w.id} className="bg-slate-900 text-white">
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <span className="text-xs bg-slate-900 border border-slate-800 text-slate-300 px-3 py-1.5 rounded-lg font-mono">
              Siap Diserahkan ({currentWarehouse.name}): <strong className="text-emerald-400">{completedOrders.length} Order</strong>
            </span>
            <span className="text-xs bg-slate-900 border border-slate-800 text-slate-300 px-3 py-1.5 rounded-lg font-mono">
              Total Manifest: <strong className="text-amber-400">{createdManifests.length}</strong>
            </span>
            {isAdmin && completedOrders.length > 0 && (
              <button
                type="button"
                onClick={handleAdminSendAllDirectly}
                className="px-3.5 py-1.5 bg-gradient-to-r from-amber-500 to-emerald-500 hover:from-amber-400 hover:to-emerald-400 text-slate-950 font-black text-xs rounded-lg shadow-md transition-all flex items-center gap-1.5 cursor-pointer ml-auto sm:ml-0"
                title="Fitur Khusus Admin: Kirim dan terbitkan manifest untuk seluruh order completed sekaligus"
              >
                <Zap className="w-3.5 h-3.5 fill-current" />
                <span>Kirim Semua ({completedOrders.length} Order)</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Grid: Form Serah Terima & Antrean Scan */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Kolom Kiri: Pengaturan Kurir & Scanner */}
        <div className="lg:col-span-5 space-y-5">
          {/* Card Info Kurir */}
          <div className="bg-[#161B25] rounded-2xl p-5 border border-slate-800 shadow-md space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800/80 pb-2">
              <Building2 className="w-4 h-4 text-emerald-400" />
              Informasi Ekspedisi & Driver
            </h3>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">Pilih Ekspedisi / Kurir</label>
              <select
                value={selectedCourier}
                onChange={e => setSelectedCourier(e.target.value)}
                className="w-full bg-[#11141B] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 font-bold"
              >
                {COURIER_OPTIONS.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {selectedCourier === 'Lainnya' && (
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5">Nama Ekspedisi Kustom</label>
                <input
                  type="text"
                  placeholder="Misal: Kurir Internal / Ekspedisi Lokal"
                  value={customCourier}
                  onChange={e => setCustomCourier(e.target.value)}
                  className="w-full bg-[#11141B] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5">Nama Driver / Kurir</label>
                <input
                  type="text"
                  placeholder="Misal: Pak Budi"
                  value={driverName}
                  onChange={e => setDriverName(e.target.value)}
                  className="w-full bg-[#11141B] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5">No. Polisi Kendaraan</label>
                <input
                  type="text"
                  placeholder="Misal: B 1234 XYZ"
                  value={vehiclePlate}
                  onChange={e => setVehiclePlate(e.target.value)}
                  className="w-full bg-[#11141B] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 uppercase font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">No. HP Driver (Opsional)</label>
              <input
                type="text"
                placeholder="Misal: 081234567890"
                value={driverPhone}
                onChange={e => setDriverPhone(e.target.value)}
                className="w-full bg-[#11141B] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">Nama Pengirim (Gudang/Toko)</label>
              <input
                type="text"
                placeholder="Misal: PT NINEBALL INDONESIA / Toko Official"
                value={senderName}
                onChange={e => setSenderName(e.target.value)}
                className="w-full bg-[#11141B] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 font-bold"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">Nama ini yang akan tampil sebagai Pihak Pengirim di Surat Jalan Manifest.</span>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">Catatan Serah Terima</label>
              <input
                type="text"
                placeholder="Misal: Pick up sore gelombang 1"
                value={manifestNotes}
                onChange={e => setManifestNotes(e.target.value)}
                className="w-full bg-[#11141B] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          {/* Scanner Barcode Box */}
          <div className="bg-[#161B25] rounded-2xl p-5 border border-slate-800 shadow-md space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Barcode className="w-4 h-4 text-emerald-400" />
              Scan Barcode No. Order / No. Resi
            </h3>

            <form onSubmit={handleScanSubmit} className="flex gap-2">
              <input
                ref={scanInputRef}
                type="text"
                autoFocus
                placeholder="Scan barcode No. Order / No. Resi..."
                value={scanInput}
                onChange={e => handleInputChange(e.target.value)}
                className="flex-1 bg-[#11141B] border border-emerald-500/50 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 font-mono placeholder:text-slate-500"
              />
              <button
                type="submit"
                className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs rounded-xl shadow-md transition-all cursor-pointer shrink-0"
              >
                + Tambah
              </button>
            </form>
            <p className="text-[11px] text-slate-400 flex items-center gap-1">
              <span className="text-emerald-400 font-bold">⚡ Otomatis Masuk:</span> Gunakan barcode gun scanner, paket otomatis ditambahkan tanpa perlu klik tombol.
            </p>

            {/* Mode Khusus Admin: Bypass Scan */}
            {isAdmin && (
              <div className="bg-gradient-to-br from-amber-500/10 via-emerald-500/10 to-transparent border border-amber-500/30 rounded-xl p-3.5 space-y-2.5 mt-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-amber-400 flex items-center gap-1.5">
                    <Zap className="w-4 h-4 text-amber-400 fill-current" />
                    Khusus Admin: Bypass Scan
                  </span>
                  <span className="text-[10px] bg-amber-500/20 text-amber-300 font-bold px-2 py-0.5 rounded-full font-mono">
                    {unselectedOrders.length} Order Siap
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  Tidak perlu scan satu per satu. Anda dapat memasukkan seluruh pesanan <strong>Completed</strong> ke antrean manifest atau langsung menerbitkan Surat Jalan serah terima kurir.
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={unselectedOrders.length === 0}
                    onClick={handleAdminSelectAll}
                    className="flex-1 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-black text-xs rounded-xl shadow transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                    title="Masukkan semua pesanan completed ke antrean serah terima"
                  >
                    <CheckCircle className="w-4 h-4" />
                    <span>Pilih Semua ({unselectedOrders.length})</span>
                  </button>
                  <button
                    type="button"
                    disabled={completedOrders.length === 0}
                    onClick={handleAdminSendAllDirectly}
                    className="flex-1 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-black text-xs rounded-xl shadow transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                    title="Kirim semua order completed dan langsung cetak Surat Jalan"
                  >
                    <Zap className="w-4 h-4 fill-current" />
                    <span>Kirim Semua Langsung</span>
                  </button>
                </div>
              </div>
            )}

            {scanFeedback && (
              <div className={`p-2.5 rounded-xl text-xs font-semibold ${
                scanFeedback.type === 'success' 
                  ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' 
                  : 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
              }`}>
                {scanFeedback.message}
              </div>
            )}
          </div>
        </div>

        {/* Kolom Kanan: Antrean Paket & Eksekusi Manifest */}
        <div className="lg:col-span-7 space-y-5">
          <div className="bg-[#161B25] rounded-2xl p-5 border border-slate-800 shadow-md space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Package className="w-4 h-4 text-emerald-400" />
                  Antrean Paket untuk {activeCourierName}
                </h3>
                <span className="text-xs text-slate-400">
                  Total Terpilih: <strong className="text-emerald-400 font-mono">{activeManifestOrders.length} Order</strong> ({totalScannedPcs} Pcs)
                </span>
              </div>

              <div className="flex items-center gap-2">
                {isAdmin && unselectedOrders.length > 0 && (
                  <button
                    type="button"
                    onClick={handleAdminSelectAll}
                    className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
                    title="Khusus Admin: Masukkan semua order completed ke manifest"
                  >
                    <Zap className="w-3.5 h-3.5 fill-current" />
                    <span>+ Masukkan Semua ({unselectedOrders.length})</span>
                  </button>
                )}

                {activeManifestOrders.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setManifestOrderRefs([])}
                    className="text-xs text-slate-400 hover:text-rose-400 flex items-center gap-1 font-semibold transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset Antrean
                  </button>
                )}
              </div>
            </div>

            {/* List antrean paket */}
            {activeManifestOrders.length === 0 ? (
              <div className="p-10 text-center border-2 border-dashed border-slate-800 rounded-xl space-y-2">
                <Package className="w-8 h-8 text-slate-600 mx-auto" />
                <p className="text-xs font-bold text-slate-400">Belum ada paket yang dipindai ke manifest ini.</p>
                <p className="text-[11px] text-slate-500">
                  Gunakan barcode scanner pada kolom kiri atau klik tombol tambah cepat di bawah.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
                {activeManifestOrders.map((ord, idx) => (
                  <div
                    key={ord.referenceNumber}
                    className="p-3 bg-[#11141B] rounded-xl border border-slate-800 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-6 h-6 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-mono font-bold text-[10px] shrink-0">
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="font-extrabold text-white truncate flex items-center gap-2">
                          <span>{ord.referenceNumber}</span>
                          {ord.orderNumber && ord.orderNumber !== '-' && (
                            <span className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded font-mono">
                              No: {ord.orderNumber}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate flex items-center gap-2 mt-0.5">
                          <span>{ord.customerName}</span>
                          <span>•</span>
                          <span className="text-emerald-400 font-bold">{ord.totalQty} Pcs</span>
                          <span>•</span>
                          <span>{ord.totalSku} SKU</span>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRemoveFromQueue(ord.referenceNumber)}
                      className="text-slate-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer"
                      title="Hapus dari antrean"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Quick Pick: Order Completed yang belum di-scan */}
            {unselectedOrders.length > 0 && (
              <div className="pt-3 border-t border-slate-800/80">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-400 block">
                    Order Siap Diserahkan Lainnya ({unselectedOrders.length} Order):
                  </span>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={handleAdminSelectAll}
                      className="text-[11px] text-amber-400 hover:text-amber-300 font-extrabold flex items-center gap-1 cursor-pointer transition-colors"
                      title="Khusus Admin: Tambah semua order ke manifest"
                    >
                      <Zap className="w-3 h-3 fill-current" />
                      <span>+ Tambah Semua ({unselectedOrders.length})</span>
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-[100px] overflow-y-auto">
                  {unselectedOrders
                    .slice(0, 15)
                    .map(o => (
                      <button
                        key={o.referenceNumber}
                        type="button"
                        onClick={() => setManifestOrderRefs(prev => [...prev, o.referenceNumber])}
                        className="px-2.5 py-1 bg-[#11141B] hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-[10px] font-mono flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <span>+ {o.referenceNumber}</span>
                        <span className="text-emerald-400 font-bold">({o.totalQty})</span>
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* Tombol Cetak & Simpan Manifest */}
            <div className="pt-2">
              <button
                type="button"
                disabled={activeManifestOrders.length === 0}
                onClick={handleCreateManifest}
                className="w-full py-3 bg-emerald-500 hover:bg-emerald-450 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-extrabold text-sm rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <ShieldCheck className="w-5 h-5" />
                <span>Simpan & Cetak Surat Jalan Manifest ({activeManifestOrders.length} Paket)</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Riwayat Dokumen Manifest yang Sudah Dibuat */}
      <div className="bg-[#11141B] rounded-2xl p-6 border border-slate-800/80 shadow-md space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div>
            <h3 className="text-base font-extrabold text-white flex items-center gap-2">
              <FileText className="w-5 h-5 text-emerald-400" />
              Riwayat Manifest Serah Terima Kurir
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Riwayat manifest serah terima dipartisi dan dipisahkan rapi per cabang / sub-gudang.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setManifestHistoryFilter('CURRENT')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                manifestHistoryFilter === 'CURRENT'
                  ? 'bg-emerald-500 text-slate-950 shadow'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              <span>{currentWarehouse.name}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                manifestHistoryFilter === 'CURRENT' ? 'bg-slate-950/30 text-slate-950 font-black' : 'bg-slate-700 text-slate-300'
              }`}>
                {createdManifests.filter(m => (!m.branchId || m.branchId === activeBranch) && (!m.warehouseId || m.warehouseId.toUpperCase() === currentWarehouseId)).length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setManifestHistoryFilter('ALL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                manifestHistoryFilter === 'ALL'
                  ? 'bg-emerald-500 text-slate-950 shadow'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              <span>Semua Cabang Gudang</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                manifestHistoryFilter === 'ALL' ? 'bg-slate-950/30 text-slate-950 font-black' : 'bg-slate-700 text-slate-300'
              }`}>
                {createdManifests.filter(m => (!m.branchId || m.branchId === activeBranch)).length}
              </span>
            </button>
          </div>
        </div>

        {visibleManifests.length === 0 ? (
          <div className="p-8 text-center border-2 border-dashed border-slate-800/80 rounded-xl space-y-1">
            <p className="text-xs font-bold text-slate-400">
              Belum ada dokumen manifest serah terima untuk <span className="text-emerald-400">{currentWarehouse.name}</span>.
            </p>
            {createdManifests.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Pilih tab "Semua Cabang Gudang" di atas untuk melihat dokumen manifest dari gudang lainnya.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-[#161B25] text-slate-400 uppercase text-[10px] font-bold border-b border-slate-800">
                <tr>
                  <th className="px-4 py-3">No. Manifest</th>
                  <th className="px-4 py-3">Gudang / Cabang</th>
                  <th className="px-4 py-3">Waktu Serah Terima</th>
                  <th className="px-4 py-3">Ekspedisi / Kurir</th>
                  <th className="px-4 py-3">Driver / Plat</th>
                  <th className="px-4 py-3">Total Paket</th>
                  <th className="px-4 py-3">Petugas WMS</th>
                  <th className="px-4 py-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-medium">
                {visibleManifests.map(m => (
                  <tr key={m.manifestId} className="hover:bg-slate-800/20 transition-colors">
                    <td className="px-4 py-3 font-mono font-bold text-white">{m.manifestId}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-500/10 text-sky-400 border border-sky-500/20 whitespace-nowrap">
                        {m.warehouseName || m.warehouseId || 'Gudang Pusat'}
                      </span>
                    </td>
                    <td className="px-4 py-3">{formatToWibString(m.handedOverAt)}</td>
                    <td className="px-4 py-3 font-bold text-emerald-400">{m.courierName}</td>
                    <td className="px-4 py-3">
                      {m.driverName || '-'} {m.vehiclePlate && `(${m.vehiclePlate})`}
                    </td>
                    <td className="px-4 py-3">
                      <strong className="text-white">{m.totalOrders} Order</strong> ({m.totalQtyPcs} Pcs)
                    </td>
                    <td className="px-4 py-3 text-slate-400">{m.handedOverBy}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleExportExcel(m)}
                          title="Unduh Excel (.xlsx)"
                          className="px-2.5 py-1.5 bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-400 border border-emerald-800/60 rounded-lg font-bold text-[11px] inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5" />
                          <span>Excel</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPrintManifest(m)}
                          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-bold text-[11px] inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Printer className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Cetak Ulang</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteManifest(m.manifestId)}
                          title="Batalkan / Hapus Dokumen Manifest (Kembalikan Order)"
                          className="px-2.5 py-1.5 bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-800/60 rounded-lg font-bold text-[11px] inline-flex items-center gap-1 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Batal</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* MODAL PRINT PREVIEW SURAT JALAN MANIFEST (THERMAL / A4) */}
      {printManifest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm print:p-0 print:bg-white">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto print:border-none print:shadow-none print:max-w-none print:w-full print:p-0 print:m-0 print:bg-white print:text-black">
            {/* Header Dialog (Hidden when printing) */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 print:hidden">
              <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                <Printer className="w-4 h-4 text-emerald-400" />
                Pratinjau Cetak Surat Jalan Manifest
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleExportExcel(printManifest)}
                  className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  <span>Unduh Excel (.xlsx)</span>
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="px-4 py-1.5 bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <Printer className="w-4 h-4" />
                  <span>Cetak Sekarang</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPrintManifest(null)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition-colors cursor-pointer"
                >
                  Tutup
                </button>
              </div>
            </div>

            {/* AREA DOKUMEN CETAK (PRINTABLE) */}
            <div id="manifest-printable-area" className="bg-white text-black p-6 rounded-xl space-y-4 font-sans text-xs border border-slate-300 print:border-none print:p-0">
              {/* Header Surat Jalan */}
              <div className="border-b-2 border-black pb-3 flex justify-between items-start">
                <div>
                  <h1 className="text-base font-black tracking-tight uppercase">{printManifest.senderName || 'PENGIRIM'}</h1>
                  <h2 className="text-sm font-extrabold mt-0.5">SURAT JALAN & MANIFEST SERAH TERIMA KURIR</h2>
                  <p className="text-[11px] text-slate-600 mt-0.5">Bukti sah serah terima paket pesanan dari Gudang ke pihak Ekspedisi / Kurir.</p>
                </div>
                <div className="text-right font-mono text-[11px]">
                  <div>NO: <strong>{printManifest.manifestId}</strong></div>
                  <div>TANGGAL: <strong>{formatToWibString(printManifest.handedOverAt)}</strong></div>
                </div>
              </div>

              {/* Data Kurir & Gudang */}
              <div className="grid grid-cols-2 gap-4 text-[11px] bg-slate-50 p-3 rounded border border-slate-200">
                <div>
                  <div className="text-slate-500 font-semibold uppercase text-[10px]">Pihak Ekspedisi / Kurir:</div>
                  <div className="font-extrabold text-xs text-black mt-0.5">{printManifest.courierName}</div>
                  <div>Driver: <strong>{printManifest.driverName || '-'}</strong></div>
                  <div>No. Polisi: <strong>{printManifest.vehiclePlate || '-'}</strong></div>
                  {printManifest.driverPhone && <div>No. Telp: {printManifest.driverPhone}</div>}
                </div>
                <div>
                  <div className="text-slate-500 font-semibold uppercase text-[10px]">Pihak Pengirim (Gudang):</div>
                  <div className="font-extrabold text-xs text-black mt-0.5">
                    {printManifest.senderName || 'PENGIRIM'}{' '}
                    <span className="font-normal text-slate-700">
                      ({printManifest.warehouseName || printManifest.warehouseId || 'Gudang Pusat'})
                    </span>
                  </div>
                  <div>Petugas WMS: <strong>{printManifest.handedOverBy}</strong></div>
                  <div>Total Paket Diserahkan: <strong className="text-xs">{printManifest.totalOrders} Koli / Pesanan</strong> ({printManifest.totalQtyPcs} Pcs)</div>
                  {printManifest.notes && <div className="italic text-slate-600">Catatan: {printManifest.notes}</div>}
                </div>
              </div>

              {/* Tabel Rincian Order dalam Manifest */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse border border-slate-400 text-[10px]">
                  <thead>
                    <tr className="bg-slate-200 border-b border-slate-400 text-slate-800 font-bold uppercase">
                      <th className="p-1.5 border-r border-slate-400 w-8 text-center">No</th>
                      <th className="p-1.5 border-r border-slate-400 w-36">No. Order / Ref</th>
                      <th className="p-1.5 border-r border-slate-400 w-36">Batch / Dokumen</th>
                      <th className="p-1.5 border-r border-slate-400">Nama Customer / Penerima</th>
                      <th className="p-1.5 border-r border-slate-400 w-24 text-center">Kuantitas</th>
                      <th className="p-1.5 w-24 text-center">Status Fisik</th>
                    </tr>
                  </thead>
                  <tbody>
                    {printManifest.orderReferences.map((ref, i) => {
                      const matched = allCompletedOrdersMap.get(ref);
                      return (
                        <tr key={ref} className="border-b border-slate-300">
                          <td className="p-1.5 border-r border-slate-300 text-center font-mono">{i + 1}</td>
                          <td className="p-1.5 border-r border-slate-300 font-bold font-mono">{ref}</td>
                          <td className="p-1.5 border-r border-slate-300 font-mono">{matched?.batchNumber || '-'}</td>
                          <td className="p-1.5 border-r border-slate-300">{matched?.customerName || '-'}</td>
                          <td className="p-1.5 border-r border-slate-300 text-center font-bold">
                            {matched?.totalQty || 0} Pcs ({matched?.totalSku || 0} SKU)
                          </td>
                          <td className="p-1.5 text-center font-bold text-slate-700">✓ Selesai Packing</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-100 font-bold border-t-2 border-black">
                      <td colSpan={4} className="p-2 text-right border-r border-slate-400">TOTAL KESELURUHAN:</td>
                      <td className="p-2 text-center border-r border-slate-400 font-bold text-xs">{printManifest.totalQtyPcs} Pcs</td>
                      <td className="p-2 text-center">{printManifest.totalOrders} Koli</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Kolom Tanda Tangan Serah Terima */}
              <div className="pt-6 grid grid-cols-2 gap-8 text-center text-[11px]">
                <div>
                  <div className="font-bold text-slate-700">Diserahkan Oleh (Pihak Gudang):</div>
                  <div className="h-16 border-b border-slate-400 mx-8"></div>
                  <div className="font-extrabold mt-1">({printManifest.handedOverBy})</div>
                  <div className="text-[10px] text-slate-500">Staff Outbound / Dispatch</div>
                </div>

                <div>
                  <div className="font-bold text-slate-700">Diterima Oleh (Pihak Ekspedisi/Kurir):</div>
                  <div className="h-16 border-b border-slate-400 mx-8"></div>
                  <div className="font-extrabold mt-1">({printManifest.driverName || 'Kurir Ekspedisi'})</div>
                  <div className="text-[10px] text-slate-500">{printManifest.courierName} {printManifest.vehiclePlate && `[${printManifest.vehiclePlate}]`}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
