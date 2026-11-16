import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareOrderSessionUpdates } from '../src/utils/orderSession.ts';
import { buildBranchExceptionReport, formatExceptionCsv } from '../src/utils/exceptionReport.ts';

test('prepareOrderSessionUpdates records and resolves operator issue reports without mutating order status or lock', () => {
  const baseOrder = {
    id: 'ord-1',
    referenceNumber: 'ORD-ISSUE-1',
    skuId: 'SKU-1019',
    skuName: 'Eyeliner Pen',
    qty: 5,
    expiredDate: '01/01/2028',
    location: 'A1-01',
    timestamp: '2026-11-14T08:00:00.000Z',
    scanned: false,
    status: 'Pending',
    pickingBy: 'Agun',
    pickingStartedAt: '2026-11-15T08:00:00.000Z',
    basketNumber: 'GB-01'
  };

  assert.throws(
    () =>
      prepareOrderSessionUpdates([baseOrder], 'ORD-ISSUE-1', {
        issueReport: { reportedBy: 'Agun', stage: 'Picking', type: 'Stok Kurang', notes: 'abc' }
      }),
    /minimal 5 karakter/
  );

  const reported = prepareOrderSessionUpdates(
    [baseOrder],
    'ORD-ISSUE-1',
    {
      issueReport: {
        reportedBy: 'Agun',
        stage: 'Picking',
        type: 'Stok Kurang',
        notes: 'Di rak A1-01 fisik hanya tersisa 3 pcs'
      }
    },
    '2026-11-15T10:00:00.000Z'
  );

  assert.equal(reported[0].status, 'Pending');
  assert.equal(reported[0].qty, 5);
  assert.equal(reported[0].pickingBy, 'Agun');
  assert.equal(reported[0].basketNumber, 'GB-01');
  assert.equal(reported[0].issueStage, 'Picking');
  assert.equal(reported[0].issueType, 'Stok Kurang');
  assert.equal(reported[0].issueReportedBy, 'Agun');
  assert.equal(reported[0].issueReportedAt, '2026-11-15T10:00:00.000Z');
  assert.equal(reported[0].issueResolvedAt, undefined);

  const resolved = prepareOrderSessionUpdates(
    reported,
    'ORD-ISSUE-1',
    { issueReport: { resolveBy: 'Marshanda' } },
    '2026-11-15T11:00:00.000Z'
  );
  assert.equal(resolved[0].issueResolvedAt, '2026-11-15T11:00:00.000Z');
  assert.equal(resolved[0].issueResolvedBy, 'Marshanda');
});

test('buildBranchExceptionReport aggregates open issues, stale orders, damaged stock, transfer variances, and CSV export', () => {
  const now = new Date('2026-11-15T12:00:00.000Z');
  const report = buildBranchExceptionReport(
    {
      orders: [
        {
          document_id: 'doc-1',
          payload: {
            id: 'doc-1',
            referenceNumber: 'ORD-ERR-1',
            status: 'Pending',
            qty: 2,
            issueReportedAt: '2026-11-15T11:30:00.000Z',
            issueReportedBy: 'Agil',
            issueStage: 'Packing',
            issueType: 'Barang Rusak',
            issueNotes: 'Kemasan penyok saat scan meja packing'
          }
        },
        {
          document_id: 'doc-2',
          payload: {
            id: 'doc-2',
            referenceNumber: 'ORD-ERR-1',
            status: 'Pending',
            qty: 3,
            issueReportedAt: '2026-11-15T11:30:00.000Z',
            issueReportedBy: 'Agil',
            issueStage: 'Packing',
            issueType: 'Barang Rusak',
            issueNotes: 'Kemasan penyok saat scan meja packing'
          }
        },
        {
          document_id: 'doc-3',
          payload: {
            id: 'doc-3',
            referenceNumber: 'ORD-OLD-1',
            status: 'Pending',
            qty: 4,
            timestamp: '2026-11-13T09:00:00.000Z',
            createdBy: 'Admin 1'
          }
        },
        {
          document_id: 'doc-4',
          payload: {
            id: 'doc-4',
            referenceNumber: 'ORD-CAN-1',
            status: 'Cancelled',
            qty: 6,
            cancellationReason: 'Permintaan customer',
            cancelledAt: '2026-11-15T09:00:00.000Z',
            cancelledBy: 'Jihan'
          }
        }
      ],
      stocks: [
        {
          document_id: 'stk-dmg',
          payload: {
            skuId: '1019',
            skuName: 'Eyeliner Pen',
            location: 'DAMAGE-01',
            expiredDate: '01/01/2028',
            status: 'Damage',
            qty: 7,
            warehouseName: 'Gudang Utama'
          }
        },
        {
          document_id: 'stk-ok',
          payload: {
            skuId: '2159',
            skuName: 'Jepit Mutiara',
            location: 'A1-01',
            expiredDate: 'No Expired',
            status: 'AMAN',
            qty: 50
          }
        }
      ],
      transfers: [
        {
          id: 'trf-12345678',
          source_branch: 'CENTER',
          destination_branch: 'KOL',
          status: 'RECEIVED',
          created_at: '2026-11-15T07:00:00.000Z',
          items: [{ qty: 10 }],
          receipt: [{ good: 8, damaged: 1 }],
          receipt_notes: '1 pcs pecah, 1 pcs kurang'
        }
      ],
      events: [
        {
          id: 99,
          created_at: '2026-11-15T06:00:00.000Z',
          actor_name: 'AMRI',
          action: 'BACKUP_RESTORE',
          entity_type: 'backups',
          entity_id: 'bk-1',
          reason: 'Pemulihan uji coba'
        }
      ]
    },
    now
  );

  assert.equal(report.summary.openIssues, 1);
  assert.equal(report.summary.staleOrders, 1);
  assert.equal(report.summary.cancelledOrders, 1);
  assert.equal(report.summary.stockAnomalies, 1);
  assert.equal(report.summary.transferAnomalies, 1);
  assert.equal(report.summary.criticalAudits, 1);

  const issueItem = report.items.find(i => i.category === 'ISSUE_REPORTED');
  assert.ok(issueItem);
  assert.equal(issueItem.qty, 5);
  assert.deepEqual(issueItem.actionableOrderIds, ['doc-1', 'doc-2']);

  const csv = formatExceptionCsv(report.items);
  assert.match(csv, /ORD-ERR-1/);
  assert.match(csv, /DAMAGE-01/);
  assert.match(csv, /trf-1234/i);
});

test('UI components wire Mode Fokus toggle, Lapor Kendala, and Laporan Exception tab', () => {
  const mabang = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
  const bulk = readFileSync(new URL('../src/components/BulkOutbound.tsx', import.meta.url), 'utf8');
  const consoleSrc = readFileSync(new URL('../src/components/ActivityConsole.tsx', import.meta.url), 'utf8');

  assert.match(mabang, /Mode Fokus/);
  assert.match(mabang, /Lapor Kendala/);
  assert.match(mabang, /wms-focus-mode/);

  assert.match(bulk, /Mode Fokus/);
  assert.match(bulk, /Lapor Kendala/);
  assert.match(bulk, /wms-focus-mode/);

  assert.match(consoleSrc, /Laporan Exception/);
  assert.match(consoleSrc, /buildBranchExceptionReport/);
});
