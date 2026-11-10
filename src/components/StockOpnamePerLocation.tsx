import { localScopeKey } from '../utils/localScope';
import React, { useState, useMemo, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { StockItem, UserAccount } from '../types';
import { formatNumber } from '../utils/calculations';
import {
  Boxes,
  Search,
  Filter,
  Download,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  MapPin,
  ClipboardList,
  CheckCheck,
  Building2,
  ArrowUpDown,
  Layers,
  ChevronRight,
  Info,
  SlidersHorizontal,
  FileDown
} from 'lucide-react';

export interface LocationOpnameRow {
  id: string; // Warehouse + SKU + Location + Expired
  warehouseId: string;
  warehouseName: string;
  location: string;
  zone: string;
  skuId: string;
  skuName: string;
  brand?: string;
  barcode?: string;
  expiredDate: string;
  systemQty: number;
  qtyCtnSize: number;
  qtyInnerSize: number;
  // User physical count inputs
  ctnInput: number;
  innerInput: number;
  looseInput: number;
  physicalQty: number;
  notes: string;
  isCounted: boolean;
  status: 'UNCOUNTED' | 'MATCH' | 'PLUS' | 'MINUS';
}

interface StockOpnamePerLocationProps {
  stock: StockItem[];
  currentUser: UserAccount | null;
}

export default function StockOpnamePerLocation({
  stock,
  currentUser
}: StockOpnamePerLocationProps) {
  // 1. Group / Filter States
  const [selectedWarehouse, setSelectedWarehouse] = useState('ALL');
  const [selectedZone, setSelectedZone] = useState<string>('ALL');
  const [selectedLocation, setSelectedLocation] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'UNCOUNTED' | 'MATCH' | 'DISCREPANCY'>('ALL');
  const [quickScanLocation, setQuickScanLocation] = useState<string>('');

  const buildOpnameRowsFromStock = (stockList: StockItem[], prevRows: LocationOpnameRow[] = []): LocationOpnameRow[] => {
    const prevMap = new Map(prevRows.map(r => [r.id, r]));
    return stockList
      .filter(s => s && typeof s.qty === 'number' && s.qty > 0)
      .map(s => {
        const ctnSize = s.qtyCtnSize && s.qtyCtnSize > 0 ? s.qtyCtnSize : 1;
        const innerSize = s.qtyInnerSize && s.qtyInnerSize > 0 ? s.qtyInnerSize : 1;
        const loc = (s.location || 'UNASSIGNED').trim().toUpperCase();
        let zone = 'Gudang Utama';
        if (loc.startsWith('A')) zone = 'Zona A';
        else if (loc.startsWith('B')) zone = 'Zona B';
        else if (loc.startsWith('C')) zone = 'Zona C';
        else if (loc.startsWith('D')) zone = 'Zona D';
        else if (loc.startsWith('E')) zone = 'Zona E';
        else if (loc.startsWith('F')) zone = 'Zona F';
        else if (loc.includes('ZONE 1') || loc.includes('URBAN')) zone = 'Zone 1 & Urban';
        else if (loc.includes('TRANSIT')) zone = 'Transit';
        else if (loc.includes('STAGING')) zone = 'Staging';

        const id = JSON.stringify([(s.warehouseId || 'WH-CENTRAL').toUpperCase(), s.skuId, loc, s.expiredDate]);
        const prev = prevMap.get(id);
        if (prev && prev.isCounted) {
          const ctnInput = prev.ctnInput || 0;
          const innerInput = prev.innerInput || 0;
          const looseInput = prev.looseInput || 0;
          const physicalQty = ctnInput * ctnSize + innerInput * innerSize + looseInput;
          const diff = physicalQty - s.qty;
          const status: LocationOpnameRow['status'] = diff === 0 ? 'MATCH' : diff > 0 ? 'PLUS' : 'MINUS';
          return {
            id,
            warehouseId: s.warehouseId || 'WH-CENTRAL',
            warehouseName: s.warehouseName || s.warehouseId || 'WH-CENTRAL',
            location: `${s.warehouseId || 'WH-CENTRAL'} / ${loc}`,
            zone,
            skuId: s.skuId,
            skuName: s.skuName,
            brand: s.brand || '',
            barcode: s.barcode || '',
            expiredDate: s.expiredDate || '-',
            systemQty: s.qty,
            qtyCtnSize: ctnSize,
            qtyInnerSize: innerSize,
            ctnInput,
            innerInput,
            looseInput,
            physicalQty,
            notes: prev.notes || '',
            isCounted: true,
            status
          };
        }

        return {
          id,
          warehouseId: s.warehouseId || 'WH-CENTRAL',
          warehouseName: s.warehouseName || s.warehouseId || 'WH-CENTRAL',
          location: `${s.warehouseId || 'WH-CENTRAL'} / ${loc}`,
          zone,
          skuId: s.skuId,
          skuName: s.skuName,
          brand: s.brand || '',
          barcode: s.barcode || '',
          expiredDate: s.expiredDate || '-',
          systemQty: s.qty,
          qtyCtnSize: ctnSize,
          qtyInnerSize: innerSize,
          ctnInput: 0,
          innerInput: 0,
          looseInput: 0,
          physicalQty: 0,
          notes: prev?.notes || '',
          isCounted: false,
          status: 'UNCOUNTED' as const
        };
      });
  };

  // 2. Local State for Opname Rows (Persisted in localStorage, strictly isolated - does NOT touch master stock)
  const [opnameRows, setOpnameRows] = useState<LocationOpnameRow[]>(() => {
    let savedRows: LocationOpnameRow[] = [];
    try {
      const saved = localStorage.getItem(localScopeKey('wms_opname_per_location_rows_v2',currentUser,false));
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          savedRows = parsed.filter((r: LocationOpnameRow) => r && r.systemQty > 0 && !!r.warehouseId);
        }
      }
    } catch (e) {
      console.warn('Failed to parse saved opname rows:', e);
    }

    if (stock.length > 0) {
      return buildOpnameRowsFromStock(stock, savedRows);
    }
    return savedRows;
  });

  // Sync / update opnameRows whenever stock changes while preserving in-progress physical counts
  useEffect(() => {
    if (stock.length > 0) {
      setOpnameRows(prev => buildOpnameRowsFromStock(stock, prev));
    }
  }, [stock]);

  // Persist opnameRows to local storage (hanya simpan data yang valid dengan stok sistem > 0)
  useEffect(() => {
    try {
      if (opnameRows.length > 0) {
        const toSave = opnameRows.filter(r => r.systemQty > 0);
        localStorage.setItem(localScopeKey('wms_opname_per_location_rows_v2',currentUser,false), JSON.stringify(toSave));
      }
    } catch (e) {
      console.warn('Failed to save opname rows to localStorage:', e);
    }
  }, [opnameRows]);

  // 3. Extract unique Zones & Locations (Hanya dari item dengan stok sistem > 0)
  const { allZones, allLocations, locationStatsMap } = useMemo(() => {
    const zonesSet = new Set<string>();
    const locationsSet = new Set<string>();
    const locMap = new Map<string, { totalItems: number; countedItems: number; totalSystemQty: number }>();

    opnameRows
      .filter(r => r.systemQty > 0 && (selectedWarehouse === 'ALL' || r.warehouseId === selectedWarehouse))
      .forEach(r => {
        zonesSet.add(r.zone);
        locationsSet.add(r.location);

        if (!locMap.has(r.location)) {
          locMap.set(r.location, { totalItems: 0, countedItems: 0, totalSystemQty: 0 });
        }
        const stat = locMap.get(r.location)!;
        stat.totalItems += 1;
        stat.totalSystemQty += r.systemQty;
        if (r.isCounted) {
          stat.countedItems += 1;
        }
      });

    return {
      allZones: Array.from(zonesSet).sort(),
      allLocations: Array.from(locationsSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      locationStatsMap: locMap
    };
  }, [opnameRows, selectedWarehouse]);

  // 4. Input Handlers
  const handleQuantityChange = (
    rowId: string,
    field: 'ctnInput' | 'innerInput' | 'looseInput',
    value: number
  ) => {
    const val = Math.max(0, isNaN(value) ? 0 : value);
    setOpnameRows(prev =>
      prev.map(r => {
        if (r.id !== rowId) return r;
        const updated = { ...r, [field]: val, isCounted: true };
        const ctnTotal = updated.ctnInput * updated.qtyCtnSize;
        const innerTotal = updated.innerInput * updated.qtyInnerSize;
        const looseTotal = updated.looseInput;
        updated.physicalQty = ctnTotal + innerTotal + looseTotal;

        const diff = updated.physicalQty - updated.systemQty;
        if (diff === 0) updated.status = 'MATCH';
        else if (diff > 0) updated.status = 'PLUS';
        else updated.status = 'MINUS';

        return updated;
      })
    );
  };

  const handleNotesChange = (rowId: string, notes: string) => {
    setOpnameRows(prev =>
      prev.map(r => (r.id === rowId ? { ...r, notes } : r))
    );
  };

  // Quick Set Match for a Single Row
  const handleSetRowMatch = (rowId: string) => {
    setOpnameRows(prev =>
      prev.map(r => {
        if (r.id !== rowId) return r;
        // Calculate pack breakdown
        const ctnSize = r.qtyCtnSize > 0 ? r.qtyCtnSize : 1;
        const innerSize = r.qtyInnerSize > 0 ? r.qtyInnerSize : 1;
        const ctn = Math.floor(r.systemQty / ctnSize);
        const remCtn = r.systemQty % ctnSize;
        const inner = Math.floor(remCtn / innerSize);
        const loose = remCtn % innerSize;

        return {
          ...r,
          ctnInput: ctn,
          innerInput: inner,
          looseInput: loose,
          physicalQty: r.systemQty,
          isCounted: true,
          status: 'MATCH'
        };
      })
    );
  };

  // Quick Set Match for Entire Selected Location
  const handleSetEntireLocationMatch = (targetLocation: string) => {
    if (!targetLocation || targetLocation === 'ALL') return;
    setOpnameRows(prev =>
      prev.map(r => {
        if (r.location !== targetLocation) return r;
        const ctnSize = r.qtyCtnSize > 0 ? r.qtyCtnSize : 1;
        const innerSize = r.qtyInnerSize > 0 ? r.qtyInnerSize : 1;
        const ctn = Math.floor(r.systemQty / ctnSize);
        const remCtn = r.systemQty % ctnSize;
        const inner = Math.floor(remCtn / innerSize);
        const loose = remCtn % innerSize;

        return {
          ...r,
          ctnInput: ctn,
          innerInput: inner,
          looseInput: loose,
          physicalQty: r.systemQty,
          isCounted: true,
          status: 'MATCH'
        };
      })
    );
  };

  // Reset Opname Session
  const handleResetOpnameSession = () => {
    if (
      !confirm(
        'PERINGATAN: Apakah Anda yakin ingin mereset seluruh data input Stock Opname per Lokasi? Input hitungan fisik akan dikembalikan ke 0.'
      )
    ) {
      return;
    }

    try {
      localStorage.removeItem(localScopeKey('wms_opname_per_location_rows_v2',currentUser,false));
    } catch {}
    setOpnameRows(buildOpnameRowsFromStock(stock, []));
  };

  // 5. Filtered Rows (RULE: Jika stok sistem 0 jangan di tampilkan)
  const filteredRows = useMemo(() => {
    return opnameRows.filter(r => {
      // RULE: Jika stok sistem 0 jangan di tampilkan
      if (!r || typeof r.systemQty !== 'number' || r.systemQty <= 0) return false;

      if (selectedWarehouse !== 'ALL' && r.warehouseId !== selectedWarehouse) return false;
      // Zone filter
      if (selectedZone !== 'ALL' && r.zone !== selectedZone) return false;

      // Location filter
      if (selectedLocation !== 'ALL' && r.location !== selectedLocation) return false;

      // Status filter
      if (statusFilter === 'UNCOUNTED' && r.isCounted) return false;
      if (statusFilter === 'MATCH' && (!r.isCounted || r.status !== 'MATCH')) return false;
      if (statusFilter === 'DISCREPANCY' && (!r.isCounted || r.status === 'MATCH')) return false;

      // Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchSku = r.skuId.toLowerCase().includes(q);
        const matchName = r.skuName.toLowerCase().includes(q);
        const matchLoc = r.location.toLowerCase().includes(q);
        const matchBarcode = r.barcode && r.barcode.toLowerCase().includes(q);
        if (!matchSku && !matchName && !matchLoc && !matchBarcode) return false;
      }

      return true;
    });
  }, [opnameRows, selectedWarehouse, selectedZone, selectedLocation, statusFilter, searchQuery]);

  // 6. Summary KPI Metrics (Hanya menghitung item dengan stok sistem > 0)
  const metrics = useMemo(() => {
    const activeOpnameRows = opnameRows.filter(r => r && r.systemQty > 0);
    const totalItems = activeOpnameRows.length;
    const countedItems = activeOpnameRows.filter(r => r.isCounted).length;
    const matchItems = activeOpnameRows.filter(r => r.isCounted && r.status === 'MATCH').length;
    const plusItems = activeOpnameRows.filter(r => r.isCounted && r.status === 'PLUS').length;
    const minusItems = activeOpnameRows.filter(r => r.isCounted && r.status === 'MINUS').length;

    let totalSystemQty = 0;
    let totalPhysicalQty = 0;
    let totalPlusQty = 0;
    let totalMinusQty = 0;

    activeOpnameRows.forEach(r => {
      totalSystemQty += r.systemQty;
      if (r.isCounted) {
        totalPhysicalQty += r.physicalQty;
        const diff = r.physicalQty - r.systemQty;
        if (diff > 0) totalPlusQty += diff;
        else if (diff < 0) totalMinusQty += Math.abs(diff);
      }
    });

    const accuracyRate = countedItems > 0 ? ((matchItems / countedItems) * 100).toFixed(1) : '0.0';
    const progressRate = totalItems > 0 ? ((countedItems / totalItems) * 100).toFixed(1) : '0.0';

    return {
      totalItems,
      countedItems,
      uncountedItems: totalItems - countedItems,
      matchItems,
      plusItems,
      minusItems,
      discrepancyItems: plusItems + minusItems,
      totalSystemQty,
      totalPhysicalQty,
      totalPlusQty,
      totalMinusQty,
      netVariance: totalPhysicalQty - totalSystemQty,
      accuracyRate,
      progressRate,
      uniqueLocations: allLocations.length
    };
  }, [opnameRows, allLocations.length]);

  // 7. EXPORT TO EXCEL (Does NOT affect stock, hanya item dengan stok sistem > 0)
  const handleExportExcel = () => {
    const dateStr = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toLocaleTimeString('id-ID');
    const operator = currentUser?.fullName || 'WMS Auditor';
    const activeOpnameRows = opnameRows.filter(r => r && r.systemQty > 0);

    // SHEET 1: RINGKASAN_OPNAME_LOKASI (Executive Summary)
    const summaryRows: any[][] = [
      ['========================================================================================================================'],
      ['LAPORAN HASIL STOCK OPNAME PER LOKASI RAK (AUDIT FISIK GUDANG WMS)'],
      ['========================================================================================================================'],
      ['Catatan Penting:', 'HASIL STOCK OPNAME INI MURNI UNTUK AUDIT & EVALUASI, TIDAK MEMPENGARUHI SALDO STOK SISTEM'],
      ['Filter Tampilan:', 'HANYA MENAMPILKAN BARANG DENGAN STOK SISTEM > 0 (STOK 0 TIDAK DITAMPILKAN)'],
      ['Tanggal Audit:', dateStr, 'Waktu Cetak:', timeStr],
      ['Auditor In-Charge:', operator, 'Peran / Role:', currentUser?.role || 'Staff Gudang'],
      ['Total Lokasi Rak:', metrics.uniqueLocations, 'Total Baris Item:', metrics.totalItems],
      ['Item Selesai Dihitung:', `${metrics.countedItems} / ${metrics.totalItems} (${metrics.progressRate}%)`],
      ['Tingkat Akurasi Opname:', `${metrics.accuracyRate}%`, 'Status SOP (Target >= 98%):', parseFloat(metrics.accuracyRate) >= 98 ? 'MEMENUHI TARGET' : 'PERLU REVIEW'],
      [''],
      ['------------------------------------------------------------------------------------------------------------------------'],
      ['1. REKAPITULASI KUANTITAS FISIK VS SISTEM'],
      ['------------------------------------------------------------------------------------------------------------------------'],
      ['Deskripsi Metrik', 'Jumlah (Pcs)', 'Satuan', 'Status Evaluasi'],
      ['Total Stok Buku Sistem (WMS)', metrics.totalSystemQty, 'Pcs', 'Saldo Master Sistem'],
      ['Total Stok Fisik Opname Lapangan', metrics.totalPhysicalQty, 'Pcs', 'Hasil Hitung Fisik'],
      ['Net Variansi Selisih', metrics.netVariance, 'Pcs', metrics.netVariance === 0 ? 'MATCH SEMPURNA' : metrics.netVariance > 0 ? `SURPLUS (+${metrics.netVariance})` : `DEFISIT (${metrics.netVariance})`],
      ['Total Selisih Lebih (Surplus / Plus)', `+${metrics.totalPlusQty}`, 'Pcs', metrics.totalPlusQty > 0 ? 'Kelebihan Fisik di Rak' : 'Nihil'],
      ['Total Selisih Kurang (Defisit / Minus)', `-${metrics.totalMinusQty}`, 'Pcs', metrics.totalMinusQty > 0 ? 'Kekurangan Fisik di Rak' : 'Nihil'],
      [''],
      ['------------------------------------------------------------------------------------------------------------------------'],
      ['2. BREAKDOWN STATUS HASIL AUDIT'],
      ['------------------------------------------------------------------------------------------------------------------------'],
      ['Status Item', 'Jumlah Baris', 'Persentase (%)', 'Rekomendasi Tindak Lanjut'],
      ['Sesuai (MATCH)', metrics.matchItems, `${metrics.totalItems > 0 ? ((metrics.matchItems / metrics.totalItems) * 100).toFixed(1) : 0}%`, 'Sesuai SOP, tidak perlu tindakan'],
      ['Selisih Lebih (PLUS)', metrics.plusItems, `${metrics.totalItems > 0 ? ((metrics.plusItems / metrics.totalItems) * 100).toFixed(1) : 0}%`, 'Investigasi barang terselip / salah catat inbound'],
      ['Selisih Kurang (MINUS)', metrics.minusItems, `${metrics.totalItems > 0 ? ((metrics.minusItems / metrics.totalItems) * 100).toFixed(1) : 0}%`, 'Investigasi potensi barang tercecer / outbound tidak tercatat'],
      ['Belum Dihitung (UNCOUNTED)', metrics.uncountedItems, `${metrics.totalItems > 0 ? ((metrics.uncountedItems / metrics.totalItems) * 100).toFixed(1) : 0}%`, 'Lanjutkan sesi penghitungan fisik'],
      [''],
      ['========================================================================================================================'],
      ['LEMBAR PENGESAHAN LAPORAN OPNAME LOKASI'],
      ['========================================================================================================================'],
      ['Dihitung Oleh (Auditor):', '', 'Diverifikasi Oleh (Supervisor):', '', 'Disetujui Oleh (Kepala Gudang):'],
      [''],
      [''],
      ['(___________________________)', '', '(___________________________)', '', '(___________________________)'],
      ['Nama / Tanggal:', '', 'Nama / Tanggal:', '', 'Nama / Tanggal:']
    ];

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [
      { wch: 38 },
      { wch: 25 },
      { wch: 25 },
      { wch: 35 },
      { wch: 25 }
    ];

    // SHEET 2: DETAIL_OPNAME_PER_LOKASI (Hanya item dengan stok sistem > 0)
    const detailRows = activeOpnameRows.map((r, idx) => {
      const diff = r.physicalQty - r.systemQty;
      return {
        'No': idx + 1,
        'Gudang': r.warehouseName,
        'Lokasi Rak': r.location,
        'Zona Gudang': r.zone,
        'SKU ID': r.skuId,
        'Nama Produk': r.skuName,
        'Brand': r.brand || '-',
        'Barcode': r.barcode || '-',
        'Expired Date': r.expiredDate,
        'Qty/CTN': r.qtyCtnSize,
        'Qty/Inner': r.qtyInnerSize,
        'Stok Sistem (Pcs)': r.systemQty,
        'Input Karton (CTN)': r.ctnInput,
        'Input Inner': r.innerInput,
        'Input Loose (Pcs)': r.looseInput,
        'Total Fisik Opname (Pcs)': r.isCounted ? r.physicalQty : '(Belum Dihitung)',
        'Selisih Variansi (Pcs)': r.isCounted ? diff : '-',
        'Status Verifikasi': !r.isCounted ? 'BELUM DIHITUNG' : r.status === 'MATCH' ? 'SESUAI (MATCH)' : r.status === 'PLUS' ? 'SURPLUS (+)' : 'DEFISIT (-)',
        'Catatan Auditor': r.notes || '-',
        'Dampak ke Stok': 'TIDAK MERUBAH STOK (AUDIT REPORT ONLY)'
      };
    });

    const wsDetail = XLSX.utils.json_to_sheet(detailRows);
    wsDetail['!cols'] = [
      { wch: 6 },
      { wch: 18 },
      { wch: 16 },
      { wch: 18 },
      { wch: 40 },
      { wch: 18 },
      { wch: 18 },
      { wch: 14 },
      { wch: 10 },
      { wch: 10 },
      { wch: 16 },
      { wch: 16 },
      { wch: 12 },
      { wch: 16 },
      { wch: 22 },
      { wch: 20 },
      { wch: 20 },
      { wch: 30 },
      { wch: 36 }
    ];

    // SHEET 3: REKAP_PER_LOKASI_RAK (Location-level Accuracy Breakdown)
    const locSummaryMap = new Map<string, {
      zone: string;
      itemCount: number;
      systemTotalQty: number;
      physicalTotalQty: number;
      matchCount: number;
      discrepancyCount: number;
      uncountedCount: number;
    }>();

    activeOpnameRows.forEach(r => {
      if (!locSummaryMap.has(r.location)) {
        locSummaryMap.set(r.location, {
          zone: r.zone,
          itemCount: 0,
          systemTotalQty: 0,
          physicalTotalQty: 0,
          matchCount: 0,
          discrepancyCount: 0,
          uncountedCount: 0
        });
      }
      const item = locSummaryMap.get(r.location)!;
      item.itemCount += 1;
      item.systemTotalQty += r.systemQty;
      if (r.isCounted) {
        item.physicalTotalQty += r.physicalQty;
        if (r.status === 'MATCH') item.matchCount += 1;
        else item.discrepancyCount += 1;
      } else {
        item.uncountedCount += 1;
      }
    });

    const locationSummaryRows = Array.from(locSummaryMap.entries())
      .sort(([locA], [locB]) => locA.localeCompare(locB, undefined, { numeric: true }))
      .map(([loc, data], idx) => {
        const diffQty = data.physicalTotalQty - data.systemTotalQty;
        const accuracy = data.itemCount > 0 ? ((data.matchCount / data.itemCount) * 100).toFixed(1) : '0.0';
        return {
          'No': idx + 1,
          'Lokasi Rak': loc,
          'Zona': data.zone,
          'Total SKU / Batch': data.itemCount,
          'Total Stok Sistem': data.systemTotalQty,
          'Total Stok Fisik': data.physicalTotalQty,
          'Selisih Qty': diffQty,
          'Item Match': data.matchCount,
          'Item Selisih': data.discrepancyCount,
          'Belum Dihitung': data.uncountedCount,
          'Akurasi Rak (%)': `${accuracy}%`,
          'Status Lokasi': data.uncountedCount > 0 ? 'DALAM PROGRES' : data.discrepancyCount === 0 ? '100% MATCH' : 'ADA SELISIH'
        };
      });

    const wsLocationSummary = XLSX.utils.json_to_sheet(locationSummaryRows);
    wsLocationSummary['!cols'] = [
      { wch: 6 },
      { wch: 18 },
      { wch: 16 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 14 },
      { wch: 12 },
      { wch: 14 },
      { wch: 16 },
      { wch: 16 },
      { wch: 18 }
    ];

    // SHEET 4: DAFTAR_SELISIH_OPNAME (Variance Only)
    const discrepancyRows = activeOpnameRows
      .filter(r => r.isCounted && r.status !== 'MATCH')
      .map((r, idx) => {
        const diff = r.physicalQty - r.systemQty;
        return {
          'No': idx + 1,
          'Gudang': r.warehouseName,
        'Lokasi Rak': r.location,
          'Zona': r.zone,
          'SKU ID': r.skuId,
          'Nama Produk': r.skuName,
          'Expired Date': r.expiredDate,
          'Stok Sistem (Pcs)': r.systemQty,
          'Stok Fisik (Pcs)': r.physicalQty,
          'Selisih (Pcs)': diff > 0 ? `+${diff}` : diff,
          'Tipe Selisih': diff > 0 ? 'SURPLUS (+)' : 'DEFISIT (-)',
          'Catatan': r.notes || '-',
          'Dampak': 'TIDAK MENGUBAH STOK SISTEM'
        };
      });

    const wsDiscrepancy = XLSX.utils.json_to_sheet(
      discrepancyRows.length > 0
        ? discrepancyRows
        : [{ 'Info': 'Seluruh item yang telah dihitung berstatus 100% MATCH (Tidak ada selisih).' }]
    );
    wsDiscrepancy['!cols'] = [
      { wch: 6 },
      { wch: 18 },
      { wch: 16 },
      { wch: 18 },
      { wch: 38 },
      { wch: 14 },
      { wch: 18 },
      { wch: 18 },
      { wch: 16 },
      { wch: 16 },
      { wch: 30 },
      { wch: 30 }
    ];

    // Combine into Workbook
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsSummary, 'RINGKASAN_EXECUTIVE');
    XLSX.utils.book_append_sheet(wb, wsDetail, 'DETAIL_OPNAME_PER_LOKASI');
    XLSX.utils.book_append_sheet(wb, wsLocationSummary, 'REKAP_PER_LOKASI_RAK');
    XLSX.utils.book_append_sheet(wb, wsDiscrepancy, 'DAFTAR_SELISIH');

    const fileName = `Laporan_Stock_Opname_Per_Lokasi_${dateStr}.xlsx`;
    XLSX.writeFile(wb, fileName);
  };

  return (
    <div className="space-y-6" id="stock-opname-per-location-container">
      {/* 1. HEADER SECTION */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-md text-[10px] font-extrabold uppercase tracking-wider font-mono">
              Audit Fisik Terisolasi
            </span>
            <span className="text-slate-500 text-xs font-mono">• Audit Lokasi Rak WMS</span>
          </div>
          <h2 className="text-2xl font-black text-white tracking-tight flex items-center gap-2.5 mt-1">
            <ClipboardList className="w-6 h-6 text-indigo-400 shrink-0" />
            Stock Opname Per Lokasi
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Penghitungan fisik stok berdasarkan lokasi rak gudang. Hasil opname dapat diunduh dalam format <strong className="text-emerald-400">Excel (.xlsx)</strong> lengkap dan <strong className="text-white">tidak mempengaruhi saldo stok sistem</strong>.
            <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-amber-300/90 font-medium bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20 font-mono">
              Stok sistem 0 disembunyikan
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-2 bg-[#11141B] border border-slate-800 px-3 py-1.5 rounded-xl text-xs">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="text-slate-400">Auditor:</span>
            <span className="text-white font-bold">{currentUser?.fullName || 'WMS Auditor'}</span>
          </div>

          <button
            onClick={handleExportExcel}
            className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-emerald-500/20 transition-all cursor-pointer flex items-center gap-2 active:scale-95"
            id="export-stock-opname-excel-btn"
            title="Download Laporan Lengkap Excel (Tidak Merubah Stok)"
          >
            <FileSpreadsheet className="w-4 h-4 shrink-0 text-slate-950" />
            <span>Download Excel Opname</span>
          </button>

          <button
            onClick={handleResetOpnameSession}
            className="px-3 py-2.5 bg-slate-800/80 hover:bg-rose-950/40 hover:text-rose-300 text-slate-400 text-xs font-medium rounded-xl transition-all cursor-pointer border border-slate-700/60 flex items-center gap-1.5"
            title="Reset seluruh input hitungan fisik sesi ini"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Hitungan</span>
          </button>
        </div>
      </div>

      {/* 2. ISOLATION NOTICE BANNER */}
      <div className="bg-indigo-950/30 border border-indigo-500/30 rounded-2xl p-4 text-xs text-indigo-200 flex items-start gap-3 shadow-md">
        <Info className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-bold text-white text-sm">
            Mode Audit Opname Mandiri (Safety Protected)
          </p>
          <p className="text-slate-300 leading-relaxed">
            Fitur ini dirancang khusus untuk audit fisik per rak tanpa risiko mengubah saldo inventaris aktif Anda. Semua input Karton (CTN), Inner, dan Loose (Pcs) tersimpan dalam memori audit lokal dan dianalisis dalam rekap laporan Excel tanpa mengeksekusi penyesuaian (adjustment) ke master stok.
          </p>
        </div>
      </div>

      {/* 3. KPI METRIC CARDS */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* KPI 1: Progres Penghitungan */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Progres Hitung Item
              </span>
              <div className="text-2xl font-black text-white font-mono mt-1">
                {metrics.countedItems} <span className="text-xs font-normal text-slate-500">/ {metrics.totalItems}</span>
              </div>
            </div>
            <div className="p-2.5 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20">
              <Boxes className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3">
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${metrics.progressRate}%` }}
              ></div>
            </div>
            <div className="flex justify-between text-[10px] text-slate-400 mt-1">
              <span>{metrics.progressRate}% Selesai</span>
              <span>{metrics.uncountedItems} Belum</span>
            </div>
          </div>
        </div>

        {/* KPI 2: Akurasi Match */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Akurasi Fisik vs Sistem
              </span>
              <div className="text-2xl font-black text-emerald-400 font-mono mt-1">
                {metrics.accuracyRate}%
              </div>
            </div>
            <div className="p-2.5 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
              <CheckCircle2 className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 text-[10px] text-slate-400 flex items-center justify-between">
            <span>Sesuai: <strong className="text-emerald-400">{metrics.matchItems}</strong></span>
            <span>Target SOP: &ge;98%</span>
          </div>
        </div>

        {/* KPI 3: Discrepancy / Selisih */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Item Selisih (Discrepancy)
              </span>
              <div className="text-2xl font-black text-amber-400 font-mono mt-1">
                {metrics.discrepancyItems} <span className="text-xs font-normal text-slate-400">SKU</span>
              </div>
            </div>
            <div className="p-2.5 bg-amber-500/10 text-amber-400 rounded-xl border border-amber-500/20">
              <AlertTriangle className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 text-[10px] text-slate-400 flex items-center justify-between">
            <span className="text-emerald-400 font-mono">Surplus: +{formatNumber(metrics.totalPlusQty)}</span>
            <span className="text-rose-400 font-mono">Defisit: -{formatNumber(metrics.totalMinusQty)}</span>
          </div>
        </div>

        {/* KPI 4: Cakupan Lokasi */}
        <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 shadow-lg flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block font-mono">
                Cakupan Lokasi Rak
              </span>
              <div className="text-2xl font-black text-white font-mono mt-1">
                {metrics.uniqueLocations} <span className="text-xs font-normal text-slate-500">Lokasi</span>
              </div>
            </div>
            <div className="p-2.5 bg-purple-500/10 text-purple-400 rounded-xl border border-purple-500/20">
              <MapPin className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 text-[10px] text-slate-400 flex items-center justify-between">
            <span>Zona Aktif: <strong className="text-white">{allZones.length}</strong></span>
            <span className="text-purple-400 font-mono">Master Rak WMS</span>
          </div>
        </div>
      </div>

      <p className="text-sm text-slate-600">Hitungan dipisahkan per gudang. Hitungan lama yang belum memiliki identitas gudang perlu diperiksa ulang; salinan lama tetap tersimpan di perangkat.</p>
      {/* 4. FILTER & LOCATION SELECTOR TOOLBAR */}
      <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-4 space-y-4 shadow-md">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div><label className="block text-xs mb-1">Pilih Gudang:</label><select aria-label="Gudang opname" value={selectedWarehouse} onChange={e=>{setSelectedWarehouse(e.target.value);setSelectedZone('ALL');setSelectedLocation('ALL')}} className="w-full border rounded-lg p-2"><option value="ALL">Semua gudang</option>{Array.from(new Map(opnameRows.map(r=>[r.warehouseId,r.warehouseName])).entries()).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></div>
          {/* Zona Selector */}
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              Pilih Zona Gudang:
            </label>
            <select
              value={selectedZone}
              onChange={e => {
                setSelectedZone(e.target.value);
                setSelectedLocation('ALL');
              }}
              className="w-full bg-[#161B25] border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              <option value="ALL">Semua Zona Gudang ({allZones.length})</option>
              {allZones.map(z => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>

          {/* Lokasi Rak Selector */}
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
              <span>Pilih Lokasi Rak:</span>
              {selectedLocation !== 'ALL' && (
                <span className="text-indigo-400 font-mono">
                  {locationStatsMap.get(selectedLocation)?.countedItems || 0}/
                  {locationStatsMap.get(selectedLocation)?.totalItems || 0} Selesai
                </span>
              )}
            </label>
            <select
              value={selectedLocation}
              onChange={e => setSelectedLocation(e.target.value)}
              className="w-full bg-[#161B25] border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              <option value="ALL">Semua Lokasi Rak ({allLocations.length} Rak)</option>
              {allLocations
                .filter(loc => {
                  if (selectedZone === 'ALL') return true;
                  const row = opnameRows.find(r => r.location === loc);
                  return row?.zone === selectedZone;
                })
                .map(loc => {
                  const stat = locationStatsMap.get(loc);
                  const isDone = stat && stat.countedItems === stat.totalItems;
                  return (
                    <option key={loc} value={loc}>
                      {loc} ({stat?.totalItems || 0} Item{isDone ? ' - Selesai' : ''})
                    </option>
                  );
                })}
            </select>
          </div>

          {/* Status Filter */}
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              Filter Status Hitung:
            </label>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as any)}
              className="w-full bg-[#161B25] border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              <option value="ALL">Semua Status ({metrics.totalItems})</option>
              <option value="UNCOUNTED">Belum Dihitung ({metrics.uncountedItems})</option>
              <option value="MATCH">Sesuai (Match) ({metrics.matchItems})</option>
              <option value="DISCREPANCY">Selisih (Discrepancy) ({metrics.discrepancyItems})</option>
            </select>
          </div>

          {/* Search Input */}
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              Pencarian Cepat:
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Cari SKU, Nama, Barcode, Rak..."
                className="w-full bg-[#161B25] border border-slate-700/80 rounded-xl pl-8 pr-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        </div>

        {/* Fast Action Row for Selected Location */}
        {selectedLocation !== 'ALL' && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800/80 bg-indigo-950/20 px-3 py-2.5 rounded-xl border border-indigo-500/20">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-indigo-400 shrink-0" />
              <span className="text-xs text-slate-300">
                Lokasi aktif: <strong className="text-white font-mono">{selectedLocation}</strong>{' '}
                ({locationStatsMap.get(selectedLocation)?.totalItems || 0} item barang di rak ini)
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSetEntireLocationMatch(selectedLocation)}
                className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-xs font-bold rounded-lg border border-emerald-500/30 transition-all cursor-pointer flex items-center gap-1.5"
                title="Tandai seluruh item di rak ini sesuai sistem"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>Set Semua Item Rak Ini Sesuai (Match)</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 5. OPNAME TABLE VIEW */}
      <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-bold text-white uppercase tracking-wider font-mono">
              Daftar Barang per Lokasi Rak
            </span>
            <span className="text-xs text-slate-400 font-mono">
              ({filteredRows.length} dari {metrics.totalItems} baris)
            </span>
          </div>

          <div className="text-xs text-slate-400 flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-600 inline-block"></span>
              <span>Belum</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
              <span>Match</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block"></span>
              <span>Selisih</span>
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-[#161B25] text-slate-400 font-bold uppercase tracking-wider text-[10px] border-b border-slate-800 font-mono">
              <tr>
                <th className="py-3 px-3 w-12 text-center">No</th>
                <th className="py-3 px-3 w-28">Lokasi Rak</th>
                <th className="py-3 px-3 w-32">SKU ID</th>
                <th className="py-3 px-3">Nama Produk</th>
                <th className="py-3 px-3 w-24">Expired Date</th>
                <th className="py-3 px-3 w-24 text-right">Stok Sistem</th>
                <th className="py-3 px-3 w-48 text-center bg-indigo-950/20 border-x border-indigo-500/20">
                  Input Fisik (CTN / Inner / Loose)
                </th>
                <th className="py-3 px-3 w-24 text-right">Total Fisik</th>
                <th className="py-3 px-3 w-20 text-center">Selisih</th>
                <th className="py-3 px-3 w-24 text-center">Status</th>
                <th className="py-3 px-3 w-36">Catatan</th>
                <th className="py-3 px-3 w-20 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-slate-500">
                    <p className="text-sm font-medium">Tidak ada data item yang sesuai dengan filter.</p>
                    <p className="text-xs mt-1 text-slate-600">Coba ubah pilihan Zona, Lokasi Rak, atau kata kunci pencarian.</p>
                  </td>
                </tr>
              ) : (
                filteredRows.map((row, idx) => {
                  const diff = row.physicalQty - row.systemQty;
                  return (
                    <tr
                      key={row.id}
                      className={`hover:bg-slate-800/30 transition-colors ${
                        row.isCounted
                          ? row.status === 'MATCH'
                            ? 'bg-emerald-950/5'
                            : 'bg-amber-950/10'
                          : ''
                      }`}
                    >
                      <td className="py-3 px-3 text-center text-slate-500 font-mono">{idx + 1}</td>

                      <td className="py-3 px-3 font-mono font-bold text-indigo-300">
                        <span className="px-2 py-0.5 bg-indigo-500/10 border border-indigo-500/20 rounded-md">
                          {row.location}<span className="block text-xs font-normal">{row.warehouseName}</span>
                        </span>
                      </td>

                      <td className="py-3 px-3 font-mono font-bold text-white">
                        {row.skuId}
                      </td>

                      <td className="py-3 px-3">
                        <div className="font-semibold text-slate-200 line-clamp-1">{row.skuName}</div>
                        {row.barcode && (
                          <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                            Barcode: {row.barcode}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-3 font-mono text-slate-400 text-[11px]">
                        {row.expiredDate}
                      </td>

                      <td className="py-3 px-3 text-right font-mono font-bold text-white">
                        {formatNumber(row.systemQty)}
                        <span className="text-[10px] text-slate-500 block font-normal">Pcs</span>
                      </td>

                      {/* Tri-pack Input: Karton, Inner, Loose */}
                      <td className="py-2 px-3 bg-indigo-950/10 border-x border-indigo-500/10">
                        <div className="flex items-center gap-1.5">
                          {/* CTN */}
                          <div className="flex-1 min-w-[50px]">
                            <label className="block text-[9px] text-slate-500 text-center font-mono">
                              CTN ({row.qtyCtnSize})
                            </label>
                            <input
                              type="number"
                              min={0}
                              value={row.ctnInput || ''}
                              placeholder="0"
                              onChange={e => handleQuantityChange(row.id, 'ctnInput', parseInt(e.target.value, 10))}
                              className="w-full bg-[#161B25] border border-slate-700/80 rounded-md py-1 px-1 text-center font-mono text-xs text-white focus:outline-none focus:border-indigo-400"
                            />
                          </div>

                          {/* Inner */}
                          <div className="flex-1 min-w-[50px]">
                            <label className="block text-[9px] text-slate-500 text-center font-mono">
                              Inr ({row.qtyInnerSize})
                            </label>
                            <input
                              type="number"
                              min={0}
                              value={row.innerInput || ''}
                              placeholder="0"
                              onChange={e => handleQuantityChange(row.id, 'innerInput', parseInt(e.target.value, 10))}
                              className="w-full bg-[#161B25] border border-slate-700/80 rounded-md py-1 px-1 text-center font-mono text-xs text-white focus:outline-none focus:border-indigo-400"
                            />
                          </div>

                          {/* Loose */}
                          <div className="flex-1 min-w-[50px]">
                            <label className="block text-[9px] text-slate-500 text-center font-mono">
                              Pcs
                            </label>
                            <input
                              type="number"
                              min={0}
                              value={row.looseInput || ''}
                              placeholder="0"
                              onChange={e => handleQuantityChange(row.id, 'looseInput', parseInt(e.target.value, 10))}
                              className="w-full bg-[#161B25] border border-slate-700/80 rounded-md py-1 px-1 text-center font-mono text-xs text-white focus:outline-none focus:border-indigo-400"
                            />
                          </div>
                        </div>
                      </td>

                      {/* Total Physical */}
                      <td className="py-3 px-3 text-right font-mono font-bold">
                        {row.isCounted ? (
                          <span className="text-white">{formatNumber(row.physicalQty)}</span>
                        ) : (
                          <span className="text-slate-600">-</span>
                        )}
                        <span className="text-[10px] text-slate-500 block font-normal">Pcs</span>
                      </td>

                      {/* Difference */}
                      <td className="py-3 px-3 text-center font-mono font-bold">
                        {!row.isCounted ? (
                          <span className="text-slate-600">-</span>
                        ) : diff === 0 ? (
                          <span className="text-emerald-400">0</span>
                        ) : diff > 0 ? (
                          <span className="text-emerald-400">+{formatNumber(diff)}</span>
                        ) : (
                          <span className="text-rose-400">{formatNumber(diff)}</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3 px-3 text-center">
                        {!row.isCounted ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-800 text-slate-400 border border-slate-700">
                            Belum
                          </span>
                        ) : row.status === 'MATCH' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
                            Match
                          </span>
                        ) : row.status === 'PLUS' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20 font-bold">
                            Surplus
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/20 font-bold">
                            Defisit
                          </span>
                        )}
                      </td>

                      {/* Notes */}
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={row.notes}
                          placeholder="Catatan fisik..."
                          onChange={e => handleNotesChange(row.id, e.target.value)}
                          className="w-full bg-[#161B25] border border-slate-700/60 rounded-md py-1 px-2 text-[11px] text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-indigo-400"
                        />
                      </td>

                      {/* Action */}
                      <td className="py-3 px-3 text-center">
                        <button
                          onClick={() => handleSetRowMatch(row.id)}
                          className="px-2 py-1 bg-slate-800 hover:bg-emerald-500/20 hover:text-emerald-300 text-slate-400 rounded-md text-[10px] font-bold transition-all cursor-pointer border border-slate-700/60"
                          title="Setel kuantitas fisik persis sama dengan sistem"
                        >
                          Match
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
