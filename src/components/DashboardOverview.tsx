import React, { useMemo } from 'react';
import { ArrowRight, Boxes, PackageCheck } from 'lucide-react';
import type { DccLog, OutboundItem, StockItem } from '../types';
import { formatNumber } from '../utils/calculations';
import { canBrowseInventory, canOpenWork, getDashboardView } from '../utils/dashboardView';
import './DashboardOverview.css';

type Props = { stock: StockItem[]; orders: OutboundItem[]; logs: DccLog[]; role?: string; onInventory?: (focus: string) => void; onWork?: (stage: 'pick' | 'validate') => void };
export default function DashboardOverview({ stock, orders, logs, role, onInventory, onWork }: Props) {
  const view = useMemo(() => getDashboardView(stock, orders, logs), [stock, orders, logs]);
  const browse = canBrowseInventory(role) && !!onInventory;
  const metric = (label: string, value: number, detail: string, focus: string, tone = '') => {
    const content = <><span className="dash-label">{label}</span><strong className={value > 0 ? tone : ''}>{formatNumber(value)} <small>pcs</small></strong><span className="dash-detail">{detail}</span>{browse && <span className="dash-card-link">Lihat rincian <ArrowRight size={14}/></span>}</>;
    return browse ? <button type="button" className="dash-metric" onClick={() => onInventory?.(focus)} aria-label={`Lihat stok ${label.toLowerCase()}`}>{content}</button> : <div className="dash-metric">{content}</div>;
  };
  return <div className="trueblue-dashboard-overview">
    <section aria-labelledby="dashboard-work-heading">
      <div className="dash-section-heading"><h2 id="dashboard-work-heading">{role === 'Viewer' ? 'Antrean operasional' : 'Perlu ditindaklanjuti'}</h2><span>{role === 'Viewer' ? 'Ringkasan cabang · hanya lihat' : 'Order yang belum selesai'}</span></div>
      <div className="dash-work-grid">{([{ stage: 'pick', title: 'Menunggu pengambilan', queue: view.picking, Icon: Boxes }, { stage: 'validate', title: 'Menunggu pengemasan', queue: view.packing, Icon: PackageCheck }] as const).map(({ stage, title, queue, Icon }) => {
        const allowed = canOpenWork(role, stage) && !!onWork;
        const content = <><div className="dash-work-title"><span>{title}</span><span className="dash-order-count">{formatNumber(queue.orders)} order</span><Icon size={22}/></div><strong>{formatNumber(queue.qty)} <small>pcs</small></strong><span className="dash-work-action">{allowed ? <>{stage === 'pick' ? 'Buka pengambilan' : 'Buka pengemasan'} <ArrowRight size={16}/></> : role === 'Viewer' ? 'Ringkasan · hanya lihat' : stage === 'pick' ? 'Tahap tim pengambilan' : 'Tahap tim pengemasan'}</span></>;
        const className = 'dash-work-card' + (queue.qty > 0 && stage === 'pick' ? ' has-attention' : '');
        return allowed ? <button key={stage} type="button" className={className} onClick={() => onWork?.(stage)}>{content}</button> : <div key={stage} className={className}>{content}</div>;
      })}</div>
    </section>
    <section aria-labelledby="dashboard-stock-heading">
      <div className="dash-section-heading"><h2 id="dashboard-stock-heading">Ringkasan stok</h2><span>{formatNumber(view.skuCount)} SKU · {formatNumber(view.stockedSkus)} memiliki stok · {formatNumber(view.rows)} baris lokasi</span></div>
      <div className="dash-stock-grid">
        {metric('Fisik', view.totals.physical, 'Seluruh stok tercatat', 'ALL')}
        {metric('Dialokasikan', view.totals.allocated, 'Untuk order, belum dipick', 'ALLOCATED', 'dash-warning')}
        {metric('Tersedia', view.totals.available, 'Layak picking, belum dialokasikan', 'AVAILABLE', 'dash-safe')}
        {metric('Ditahan / buffer', view.totals.held, 'Tidak dapat dipick', 'BLOCKED', 'dash-danger')}
      </div>
    </section>
    <section className="dash-expiry-panel" aria-labelledby="dashboard-expiry-heading">
      <div className="dash-section-heading"><h2 id="dashboard-expiry-heading">Kondisi stok & kedaluwarsa</h2><span>Persentase dari stok fisik</span></div>
      <div className="dash-expiry-grid">{view.expiry.map(item => {
        const content = <><span className="dash-expiry-title"><i className={item.qty > 0 ? 'dash-dot-' + item.tone : ''}/>{item.label}</span><span className="dash-detail">{item.detail}</span><strong>{formatNumber(item.qty)} <small>pcs</small></strong><span className="dash-expiry-meta"><span>{item.skus} SKU</span><span>{item.percent}%</span></span>{browse && <span className="dash-card-link">Lihat rincian <ArrowRight size={13}/></span>}</>;
        return browse ? <button key={item.focus} className="dash-expiry-cell" type="button" aria-label={`Lihat stok ${item.label}`} onClick={() => onInventory?.(item.focus)}>{content}</button> : <div key={item.focus} className="dash-expiry-cell">{content}</div>;
      })}</div>
      <p className="dash-note">Setiap baris stok masuk satu kategori. Satu SKU dapat muncul di beberapa kategori karena berbeda rak atau tanggal. Stok ditahan mencakup rusak, kedaluwarsa, karantina, dan buffer.</p>
    </section>
    <section aria-labelledby="dashboard-today-heading">
      <div className="dash-section-heading"><h2 id="dashboard-today-heading">Aktivitas hari ini · WIB</h2><span>Periode 00.00–23.59 WIB</span></div>
      <div className="dash-today-grid">{[{ label: 'Outbound selesai', qty: view.today.outbound }, { label: 'Transfer internal', qty: view.today.internal }, { label: 'Transfer masuk', qty: view.today.incoming }].map(item => <div className="dash-today-card" key={item.label}><span className="dash-label">{item.label}</span><strong>{formatNumber(item.qty)} <small>pcs</small></strong></div>)}</div>
    </section>
  </div>;
}
