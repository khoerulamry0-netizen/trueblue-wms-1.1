import type { OutboundItem, StockItem } from '../types';
import { getStockStatus } from './calculations';

export type ExceptionCategory =
  | 'ISSUE_REPORTED'
  | 'TRANSFER_ANOMALY'
  | 'STOCK_ANOMALY'
  | 'ORDER_STALE'
  | 'ORDER_CANCELLED'
  | 'AUDIT_CRITICAL';

export type ExceptionSeverity = 'high' | 'medium' | 'info';

export interface ExceptionTransferRow {
  id: string;
  source_branch: string;
  destination_branch: string;
  status: string;
  created_at: string;
  notes?: string;
  receipt_notes?: string;
  items?: Array<{ qty?: number; stock?: { skuId?: string; skuName?: string } }>;
  receipt?: Array<{ good?: number; damaged?: number; location?: string }>;
}

export interface ExceptionAuditEventRow {
  id: number | string;
  created_at: string;
  actor_name?: string;
  action: string;
  entity_type: string;
  entity_id: string;
  reason?: string;
}

export interface ExceptionReportItem {
  id: string;
  category: ExceptionCategory;
  severity: ExceptionSeverity;
  timestamp: string;
  reference: string;
  title: string;
  detail: string;
  actor: string;
  qty: number;
  actionableOrderIds?: string[];
  actionableOrderRef?: string;
}

export interface ExceptionSummary {
  total: number;
  high: number;
  medium: number;
  info: number;
  openIssues: number;
  transferAnomalies: number;
  stockAnomalies: number;
  staleOrders: number;
  cancelledOrders: number;
  criticalAudits: number;
}

export interface BranchExceptionReport {
  items: ExceptionReportItem[];
  summary: ExceptionSummary;
}

const CRITICAL_AUDIT_ACTIONS = new Set([
  'DELETE',
  'BACKUP_RESTORE',
  'ACCOUNT_DELETE',
  'STOCK_PURGE_COMPLETED',
  'PERIOD_ARCHIVE_COMPLETED'
]);

const SEVERITY_RANK: Record<ExceptionSeverity, number> = { high: 0, medium: 1, info: 2 };

function safeTimeMs(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Menggabungkan temuan anomali cabang secara read-only dari order, stok, transfer, dan log audit.
 */
export function buildBranchExceptionReport(
  params: {
    orders: Array<{ document_id?: string; payload: Partial<OutboundItem> & { cancellationReason?: string; cancelledAt?: string; cancelledBy?: string; isSorted?: boolean } }>;
    stocks: Array<{ document_id?: string; payload: Partial<StockItem> & { status?: string } }>;
    transfers: ExceptionTransferRow[];
    events: ExceptionAuditEventRow[];
  },
  now: Date = new Date()
): BranchExceptionReport {
  const nowMs = now.getTime();
  const staleCutoffMs = nowMs - 24 * 60 * 60 * 1000;
  const items: ExceptionReportItem[] = [];

  const pendingByRef = new Map<string, Array<{ docId: string; payload: Partial<OutboundItem> & { isSorted?: boolean } }>>();
  const cancelledByRef = new Map<string, Array<{ docId: string; payload: Partial<OutboundItem> & { cancellationReason?: string; cancelledAt?: string; cancelledBy?: string } }>>();

  for (const row of params.orders) {
    const p = row.payload || {};
    const ref = (p.referenceNumber || p.orderNumber || row.document_id || '').trim();
    const docId = row.document_id || p.id || '';
    if (!ref) continue;
    if (p.status === 'Cancelled') {
      const list = cancelledByRef.get(ref) || [];
      list.push({ docId, payload: p });
      cancelledByRef.set(ref, list);
    } else if (p.status === 'Pending' || !p.status) {
      const list = pendingByRef.get(ref) || [];
      list.push({ docId, payload: p });
      pendingByRef.set(ref, list);
    }
  }

  for (const [ref, rows] of pendingByRef.entries()) {
    const flagged = rows.find(r => r.payload.issueReportedAt && !r.payload.issueResolvedAt);
    const totalQty = rows.reduce((sum, r) => sum + Number(r.payload.qty || 0), 0);
    const docIds = rows.map(r => r.docId).filter(Boolean);

    if (flagged) {
      const p = flagged.payload;
      items.push({
        id: `issue:${ref}`,
        category: 'ISSUE_REPORTED',
        severity: 'high',
        timestamp: p.issueReportedAt || '',
        reference: ref,
        title: `${p.issueType || 'Kendala Lapangan'} (${p.issueStage || 'Operasional'})`,
        detail: `${p.issueNotes || 'Perlu peninjauan supervisor'} · ${rows.length} baris SKU`,
        actor: p.issueReportedBy || 'Operator',
        qty: totalQty,
        actionableOrderIds: docIds,
        actionableOrderRef: ref
      });
    }

    const first = rows[0]?.payload || {};
    const refTs = safeTimeMs(first.pickingStartedAt || first.packingStartedAt || first.createdAt || first.timestamp);
    const notShipped = !first.shipped && !first.shippedAt;
    if (notShipped && refTs > 0 && refTs < staleCutoffMs) {
      const stage = first.isSorted
        ? 'Siap Packing'
        : first.isPicked || first.picked
          ? 'Di Meja Sortir'
          : first.pickingBy
            ? `Sedang Dipick (${first.pickingBy})`
            : 'Menunggu Picking';
      items.push({
        id: `stale:${ref}`,
        category: 'ORDER_STALE',
        severity: 'medium',
        timestamp: new Date(refTs).toISOString(),
        reference: ref,
        title: `Order tertahan > 24 jam (${stage})`,
        detail: `${rows.length} baris SKU${first.customerName ? ` · Customer: ${first.customerName}` : ''}`,
        actor: first.packingBy || first.pickingBy || first.createdBy || '—',
        qty: totalQty,
        actionableOrderIds: docIds,
        actionableOrderRef: ref
      });
    }
  }

  for (const [ref, rows] of cancelledByRef.entries()) {
    const first = rows[0]?.payload || {};
    const totalQty = rows.reduce((sum, r) => sum + Number(r.payload.qty || 0), 0);
    items.push({
      id: `cancel:${ref}`,
      category: 'ORDER_CANCELLED',
      severity: 'info',
      timestamp: first.cancelledAt || first.timestamp || '',
      reference: ref,
      title: 'Order dibatalkan',
      detail: first.cancellationReason || 'Tidak ada catatan alasan',
      actor: first.cancelledBy || first.createdBy || 'Admin',
      qty: totalQty
    });
  }

  for (const row of params.stocks) {
    const s = row.payload || {};
    const qty = Number(s.qty || 0);
    if (qty <= 0) continue;
    const computed = getStockStatus({
      expiredDate: s.expiredDate || '',
      status: s.status || 'AMAN',
      location: s.location || ''
    });
    if (!['Damage', 'Expired', 'Karantina'].includes(computed)) continue;

    items.push({
      id: `stock:${row.document_id || `${s.skuId}|${s.location}|${s.expiredDate}`}`,
      category: 'STOCK_ANOMALY',
      severity: computed === 'Damage' || computed === 'Expired' ? 'high' : 'medium',
      timestamp: '',
      reference: `${s.skuId || 'SKU'} @ ${s.location || '-'}`,
      title: `Stok ${computed === 'Karantina' ? 'Karantina / QC Hold' : computed}`,
      detail: `${s.skuName || s.skuId || ''} · ED ${s.expiredDate || 'No Expired'} · Rak ${s.location || '-'}`,
      actor: s.warehouseName || s.warehouseId || 'Gudang',
      qty
    });
  }

  for (const t of params.transfers) {
    const shippedTotal = (t.items || []).reduce((sum, it) => sum + Number(it.qty || 0), 0);
    const damagedTotal = (t.receipt || []).reduce((sum, r) => sum + Number(r.damaged || 0), 0);
    const receivedGoodTotal = (t.receipt || []).reduce((sum, r) => sum + Number(r.good || 0), 0);
    const shortTotal = t.status === 'RECEIVED' ? Math.max(0, shippedTotal - receivedGoodTotal - damagedTotal) : 0;

    if (damagedTotal > 0 || shortTotal > 0) {
      items.push({
        id: `transfer-var:${t.id}`,
        category: 'TRANSFER_ANOMALY',
        severity: 'high',
        timestamp: t.created_at,
        reference: `${t.source_branch} → ${t.destination_branch} (${t.id.slice(0, 8).toUpperCase()})`,
        title: `Transfer selisih/rusak (Rusak ${damagedTotal} · Kurang ${shortTotal} pcs)`,
        detail: t.receipt_notes || t.notes || 'Periksa catatan penerimaan transfer cabang.',
        actor: t.destination_branch,
        qty: damagedTotal + shortTotal
      });
    } else if (!['RECEIVED', 'CANCELLED'].includes(t.status) && safeTimeMs(t.created_at) > 0 && safeTimeMs(t.created_at) < staleCutoffMs) {
      items.push({
        id: `transfer-stale:${t.id}`,
        category: 'TRANSFER_ANOMALY',
        severity: 'medium',
        timestamp: t.created_at,
        reference: `${t.source_branch} → ${t.destination_branch} (${t.id.slice(0, 8).toUpperCase()})`,
        title: `Transfer menggantung > 24 jam (${t.status})`,
        detail: t.notes || 'Belum diterima cabang tujuan.',
        actor: t.source_branch,
        qty: shippedTotal
      });
    }
  }

  for (const ev of params.events) {
    if (!CRITICAL_AUDIT_ACTIONS.has(ev.action)) continue;
    items.push({
      id: `audit:${ev.id}`,
      category: 'AUDIT_CRITICAL',
      severity: ev.action === 'DELETE' || ev.action === 'BACKUP_RESTORE' ? 'medium' : 'info',
      timestamp: ev.created_at,
      reference: `${ev.entity_type}: ${ev.entity_id}`,
      title: `Audit sensitif (${ev.action})`,
      detail: ev.reason || 'Aksi sensitif tercatat di sistem.',
      actor: ev.actor_name || 'Sistem',
      qty: 0
    });
  }

  items.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rankDiff !== 0) return rankDiff;
    return safeTimeMs(b.timestamp) - safeTimeMs(a.timestamp);
  });

  const summary: ExceptionSummary = {
    total: items.length,
    high: items.filter(i => i.severity === 'high').length,
    medium: items.filter(i => i.severity === 'medium').length,
    info: items.filter(i => i.severity === 'info').length,
    openIssues: items.filter(i => i.category === 'ISSUE_REPORTED').length,
    transferAnomalies: items.filter(i => i.category === 'TRANSFER_ANOMALY').length,
    stockAnomalies: items.filter(i => i.category === 'STOCK_ANOMALY').length,
    staleOrders: items.filter(i => i.category === 'ORDER_STALE').length,
    cancelledOrders: items.filter(i => i.category === 'ORDER_CANCELLED').length,
    criticalAudits: items.filter(i => i.category === 'AUDIT_CRITICAL').length
  };

  return { items, summary };
}

function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function formatExceptionCsv(items: ExceptionReportItem[]): string {
  const headers = ['Prioritas', 'Kategori', 'Referensi', 'Temuan', 'Detail', 'Pelapor / Lokasi', 'Qty (pcs)', 'Waktu (ISO)'];
  const rows = items.map(item => [
    item.severity.toUpperCase(),
    item.category,
    item.reference,
    item.title,
    item.detail,
    item.actor,
    item.qty,
    item.timestamp || '-'
  ]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(escapeCsvCell).join(',')).join('\r\n');
}
