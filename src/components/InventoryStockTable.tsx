import React, { useMemo } from 'react';
import { Edit3, Eye, History, MapPin, Printer, Trash2 } from 'lucide-react';
import type { StockItem } from '../types';
import { formatNumber, getItemStockBreakdown, getProductCategory, isStockPickable, type LockedStockSummary } from '../utils/calculations';
import { getBarcodeForSku } from '../data/barcodeMap';
import { getInventorySkuTotals, groupStockBySku, inventoryDateLabel, inventoryMovementLabel, inventoryStatus } from '../utils/inventoryView';
import { useLanguage } from '../i18n/LanguageContext';
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
  const { t, language } = useLanguage();
  const totals = useMemo(() => getInventorySkuTotals(summaryStock, locked), [summaryStock, locked]);
  const groups = useMemo(() => groupStockBySku(stock), [stock]);
  const matchedGroups = useMemo(() => new Map(groupStockBySku(matchedStock).map(group => [group.key, group.items.length])), [matchedStock]);
  
  const actions = (item: StockItem) => <div className="stock-row-actions">{isAdmin ? <>
    <button type="button" onClick={() => onPrint(item)} title={t('stock.printLocationLabel')} aria-label={`${t('stock.printLocationLabel')} ${item.skuId} di ${item.location}`}><Printer size={16}/></button>
    <button type="button" onClick={() => onEdit(item)} title={t('stock.editStock')} aria-label={`${t('stock.editStock')} ${item.skuId} di ${item.location}`}><Edit3 size={16}/></button>
    <button type="button" className="stock-delete" onClick={() => onDelete(item)} title={t('stock.deleteStock')} aria-label={`${t('stock.deleteStock')} ${item.skuId} di ${item.location}`}><Trash2 size={16}/></button>
  </> : <span className="stock-readonly"><Eye size={14}/> {t('stock.readOnly')}</span>}</div>;
  
  const packs = (item: StockItem) => <span className="stock-packs" title={`1 ${t('stock.carton').toLowerCase()} = ${item.qtyCtnSize} pcs; 1 ${t('stock.inner').toLowerCase()} = ${item.qtyInnerSize} pcs`}>{t('stock.carton')} {formatNumber(item.qtyCtn)} · {t('stock.inner')} {formatNumber(item.qtyInner)} · {t('stock.loose')} {formatNumber(item.qtyLoose)}</span>;

  return <section className="trueblue-stock-table" aria-label="Stok berdasarkan SKU dan lokasi">
    <p className="stock-scope-note">{t('stock.scopeNote', { scope: scopeLabel })}</p>
    <div className="stock-table-scroll" tabIndex={0} aria-label="Tabel stok, gulir untuk melihat rincian">
      <table>
        <thead><tr><th scope="col">{t('stock.locationWarehouse')}</th><th scope="col">{t('stock.expiryDate')}</th><th scope="col" className="stock-number">{t('stock.physical')}</th><th scope="col" className="stock-number">{t('stock.allocated')}</th><th scope="col" className="stock-number">{t('stock.available')}</th><th scope="col">{t('stock.remainingEd')}</th><th scope="col">{t('stock.action')}</th></tr></thead>
        {groups.length === 0 && <tbody><tr><td colSpan={7} className="stock-empty">{t('stock.noMatch')}</td></tr></tbody>}
        {groups.map(group => {
          const item = group.items[0], total = totals.get(group.key)!;
          const barcode = getBarcodeForSku(item.skuId);
          return <tbody key={group.key} className="stock-group-tbody" aria-label={`SKU ${item.skuId}`}>
            <tr className="stock-group-row"><th scope="rowgroup" colSpan={7} className="stock-group-heading">
              <div className="stock-group-layout">
                <div className="stock-product">
                  <button type="button" className="stock-product-link" title={t('stock.viewHistory')} onClick={() => onHistory(item)}><span>SKU {item.skuId}</span><strong>{item.skuName}</strong><History size={15}/></button>
                  <div className="stock-product-meta"><span>{inventoryMovementLabel(getProductCategory(item.skuId, item.skuName), language)}</span>{barcode && barcode !== '-' && <span>Barcode: {barcode}</span>}</div>
                  <small>{t('stock.showingMatch', { count: group.items.length, total: matchedGroups.get(group.key) || 0, rows: total.rows })}</small>
                </div>
                <dl className="stock-sku-summary" aria-label={`Ringkasan SKU ${item.skuId}`}>
                  <div><dt>{t('stock.physical')}</dt><dd>{formatNumber(total.physical)}</dd></div>
                  <div className={total.allocated > 0 ? 'stock-allocated' : ''}><dt>{t('stock.allocated')}</dt><dd>{formatNumber(total.allocated)}</dd></div>
                  <div className="stock-available"><dt>{t('stock.available')}</dt><dd>{formatNumber(total.available)}</dd></div>
                  <div className={total.held > 0 ? 'stock-held' : ''}><dt>{t('stock.heldBuffer')}</dt><dd>{formatNumber(total.held)}</dd></div>
                </dl>
              </div>
            </th></tr>
            {group.items.map(row => {
              const breakdown = getItemStockBreakdown(row, locked), status = inventoryStatus(row, language), pickable = isStockPickable(row);
              const warehouse = row.warehouseName || (row.warehouseId && row.warehouseId !== 'WH-CENTRAL' ? row.warehouseId : t('stock.centralWarehouse'));
              return <tr key={row.id} className={'stock-detail-row' + (!pickable ? ' stock-unpickable' : '')}>
                <td className="stock-mobile-cell" colSpan={7}>
                  <div className="stock-mobile-location"><strong><MapPin size={15}/>{row.location}</strong><span className={`stock-status stock-status-${status.tone}`}>{status.label}</span></div>
                  <div className="stock-mobile-meta">{warehouse} · {inventoryDateLabel(row, language)}</div>
                  <dl className="stock-mobile-quantities"><div><dt>{t('stock.physical')}</dt><dd>{formatNumber(breakdown.physicalQty)}</dd></div><div className={breakdown.lockedQty > 0 ? 'stock-allocated' : ''}><dt>{t('stock.allocated')}</dt><dd>{formatNumber(breakdown.lockedQty)}</dd></div><div className={pickable ? 'stock-available' : 'stock-held'}><dt>{t('stock.available')}</dt><dd>{formatNumber(breakdown.availableQty)}</dd></div></dl>
                  {!pickable && <p className="stock-held-note">{t('stock.unpickable')}</p>}
                  <div className="stock-mobile-footer">{packs(row)}{actions(row)}</div>
                </td>
                <td className="stock-desktop-cell"><strong className="stock-location"><MapPin size={15}/>{row.location}</strong><small className="stock-warehouse">{warehouse}</small></td>
                <td className="stock-desktop-cell stock-date">{inventoryDateLabel(row, language)}</td>
                <td className="stock-desktop-cell stock-number"><strong className="stock-quantity">{formatNumber(breakdown.physicalQty)}</strong>{packs(row)}</td>
                <td className={'stock-desktop-cell stock-number' + (breakdown.lockedQty > 0 ? ' stock-allocated' : '')}><strong className="stock-quantity">{formatNumber(breakdown.lockedQty)}</strong>{breakdown.lockedQty > 0 && <small>{t('stock.unallocated')}</small>}</td>
                <td className={'stock-desktop-cell stock-number ' + (pickable ? 'stock-available' : 'stock-held')}><strong className="stock-quantity">{formatNumber(breakdown.availableQty)}</strong>{!pickable && <small>{t('stock.unpickable')}</small>}</td>
                <td className="stock-desktop-cell"><span className={`stock-status stock-status-${status.tone}`}>{status.label}</span></td>
                <td className="stock-desktop-cell">{actions(row)}</td>
              </tr>;
            })}
            <tr className="stock-group-spacer" aria-hidden="true"><td colSpan={7}></td></tr>
          </tbody>;
        })}
      </table>
    </div>
  </section>;
}
