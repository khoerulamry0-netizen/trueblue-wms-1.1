import React, { useMemo } from 'react';
import { Edit3, Eye, History, MapPin, Printer, Trash2 } from 'lucide-react';
import type { StockItem } from '../types';
import { formatNumber, getItemStockBreakdown, getProductCategory, isStockPickable, type LockedStockSummary } from '../utils/calculations';
import { getBarcodeForSku } from '../data/barcodeMap';
import { getInventorySkuTotals, groupStockBySku, inventoryDateLabel, inventoryMovementLabel, inventoryStatus } from '../utils/inventoryView';
import './InventoryStockTable.css';

type Props = {
  stock: StockItem[];
  summaryStock: StockItem[];
  matchedStock: StockItem[];
  locked: LockedStockSummary;
  scopeLabel: string;
  isAdmin: boolean;
  onHistory: (item: StockItem) => void;
  onPrint: (item: StockItem) => void;
  onEdit: (item: StockItem) => void;
  onDelete: (item: StockItem) => void;
};

export default function InventoryStockTable({ stock, summaryStock, matchedStock, locked, scopeLabel, isAdmin, onHistory, onPrint, onEdit, onDelete }: Props) {
  const totals = useMemo(() => getInventorySkuTotals(summaryStock, locked), [summaryStock, locked]);
  const groups = useMemo(() => groupStockBySku(stock), [stock]);
  const matchedGroups = useMemo(() => new Map(groupStockBySku(matchedStock).map(group => [group.key, group.items.length])), [matchedStock]);
  const actions = (item: StockItem) => <div className="stock-row-actions">{isAdmin ? <>
    <button type="button" onClick={() => onPrint(item)} title="Cetak Label Rak Gudang" aria-label={`Cetak label ${item.skuId} di ${item.location}`}><Printer size={16}/></button>
    <button type="button" onClick={() => onEdit(item)} title="Edit / Sesuaikan Stok" aria-label={`Sesuaikan stok ${item.skuId} di ${item.location}`}><Edit3 size={16}/></button>
    <button type="button" className="stock-delete" onClick={() => onDelete(item)} title="Hapus Stok" aria-label={`Hapus stok ${item.skuId} di ${item.location}`}><Trash2 size={16}/></button>
  </> : <span className="stock-readonly"><Eye size={14}/> Hanya lihat</span>}</div>;
  const packs = (item: StockItem) => <span className="stock-packs" title={`1 karton = ${item.qtyCtnSize} pcs; 1 inner = ${item.qtyInnerSize} pcs`}>Karton {formatNumber(item.qtyCtn)} · Inner {formatNumber(item.qtyInner)} · Eceran {formatNumber(item.qtyLoose)}</span>;

  return <section className="trueblue-stock-table" aria-label="Stok berdasarkan SKU dan lokasi">
    <p className="stock-scope-note">Ringkasan SKU: <strong>{scopeLabel}</strong>, seluruh rak. Filter status, lokasi, dan pencarian hanya membatasi rincian baris. Semua jumlah stok dalam pcs.</p>
    <div className="stock-table-scroll" tabIndex={0} aria-label="Tabel stok, gulir untuk melihat rincian">
      <table>
        <thead><tr><th scope="col">Lokasi / Gudang</th><th scope="col">Kedaluwarsa</th><th scope="col" className="stock-number">Fisik</th><th scope="col" className="stock-number">Dialokasikan</th><th scope="col" className="stock-number">Tersedia</th><th scope="col">Status</th><th scope="col">Aksi</th></tr></thead>
        {groups.length === 0 && <tbody><tr><td colSpan={7} className="stock-empty">Tidak ada stok yang cocok. Ubah pencarian atau filter.</td></tr></tbody>}
        {groups.map(group => {
          const item = group.items[0], total = totals.get(group.key)!;
          const barcode = getBarcodeForSku(item.skuId);
          return <tbody key={group.key} aria-label={`SKU ${item.skuId}`}>
            <tr className="stock-group-row"><th scope="rowgroup" colSpan={7} className="stock-group-heading">
              <div className="stock-group-layout">
                <div className="stock-product">
                  <button type="button" className="stock-product-link" title="Lihat riwayat pergerakan SKU" onClick={() => onHistory(item)}><span>SKU {item.skuId}</span><strong>{item.skuName}</strong><History size={15}/></button>
                  <div className="stock-product-meta"><span>{inventoryMovementLabel(getProductCategory(item.skuId, item.skuName))}</span>{barcode && barcode !== '-' && <span>Barcode: {barcode}</span>}</div>
                  <small>Menampilkan {group.items.length} dari {matchedGroups.get(group.key) || 0} baris yang cocok · {total.rows} baris pada gudang yang dipilih</small>
                </div>
                <dl className="stock-sku-summary" aria-label={`Ringkasan SKU ${item.skuId}`}>
                  <div><dt>Fisik</dt><dd>{formatNumber(total.physical)}</dd></div>
                  <div className={total.allocated > 0 ? 'stock-allocated' : ''}><dt>Dialokasikan</dt><dd>{formatNumber(total.allocated)}</dd></div>
                  <div className="stock-available"><dt>Tersedia</dt><dd>{formatNumber(total.available)}</dd></div>
                  <div className={total.held > 0 ? 'stock-held' : ''}><dt>Ditahan / buffer</dt><dd>{formatNumber(total.held)}</dd></div>
                </dl>
              </div>
            </th></tr>
            {group.items.map(row => {
              const breakdown = getItemStockBreakdown(row, locked), status = inventoryStatus(row), pickable = isStockPickable(row);
              const warehouse = row.warehouseName || (row.warehouseId && row.warehouseId !== 'WH-CENTRAL' ? row.warehouseId : 'Gudang Pusat');
              return <tr key={row.id} className={'stock-detail-row' + (!pickable ? ' stock-unpickable' : '')}>
                <td className="stock-mobile-cell" colSpan={7}>
                  <div className="stock-mobile-location"><strong><MapPin size={15}/>{row.location}</strong><span className={`stock-status stock-status-${status.tone}`}>{status.label}</span></div>
                  <div className="stock-mobile-meta">{warehouse} · {inventoryDateLabel(row)}</div>
                  <dl className="stock-mobile-quantities"><div><dt>Fisik</dt><dd>{formatNumber(breakdown.physicalQty)}</dd></div><div className={breakdown.lockedQty > 0 ? 'stock-allocated' : ''}><dt>Dialokasikan</dt><dd>{formatNumber(breakdown.lockedQty)}</dd></div><div className={pickable ? 'stock-available' : 'stock-held'}><dt>Tersedia</dt><dd>{formatNumber(breakdown.availableQty)}</dd></div></dl>
                  {!pickable && <p className="stock-held-note">Tidak dapat dipick</p>}
                  <div className="stock-mobile-footer">{packs(row)}{actions(row)}</div>
                </td>
                <td className="stock-desktop-cell"><strong className="stock-location"><MapPin size={15}/>{row.location}</strong><small className="stock-warehouse">{warehouse}</small></td>
                <td className="stock-desktop-cell stock-date">{inventoryDateLabel(row)}</td>
                <td className="stock-desktop-cell stock-number"><strong className="stock-quantity">{formatNumber(breakdown.physicalQty)}</strong>{packs(row)}</td>
                <td className={'stock-desktop-cell stock-number' + (breakdown.lockedQty > 0 ? ' stock-allocated' : '')}><strong className="stock-quantity">{formatNumber(breakdown.lockedQty)}</strong>{breakdown.lockedQty > 0 && <small>Belum dipick</small>}</td>
                <td className={'stock-desktop-cell stock-number ' + (pickable ? 'stock-available' : 'stock-held')}><strong className="stock-quantity">{formatNumber(breakdown.availableQty)}</strong>{!pickable && <small>Tidak dapat dipick</small>}</td>
                <td className="stock-desktop-cell"><span className={`stock-status stock-status-${status.tone}`}>{status.label}</span></td>
                <td className="stock-desktop-cell">{actions(row)}</td>
              </tr>;
            })}
          </tbody>;
        })}
      </table>
    </div>
  </section>;
}
