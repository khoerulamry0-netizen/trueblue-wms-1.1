import React, { useMemo } from 'react';
import { ArrowRight, Boxes, PackageCheck } from 'lucide-react';
import type { DccLog, OutboundItem, StockItem, ReturnItem } from '../types';
import { formatNumber } from '../utils/calculations';
import { canBrowseInventory, canOpenWork, getDashboardView } from '../utils/dashboardView';
import { useLanguage } from '../i18n/LanguageContext';
import './DashboardOverview.css';

type Props = { stock: StockItem[]; orders: OutboundItem[]; logs: DccLog[]; returns?: ReturnItem[]; role?: string; onInventory?: (focus: string) => void; onWork?: (stage: 'pick' | 'validate') => void };
export default function DashboardOverview({ stock, orders, logs, returns = [], role, onInventory, onWork }: Props) {
  const { t, language } = useLanguage();
  const view = useMemo(() => getDashboardView(stock, orders, logs, language, returns), [stock, orders, logs, language, returns]);
  const browse = canBrowseInventory(role) && !!onInventory;
  const metric = (label: string, value: number, detail: string, focus: string, tone = '') => {
    const content = <><span className="dash-label">{label}</span><strong className={value > 0 ? tone : ''}>{formatNumber(value)} <small>pcs</small></strong><span className="dash-detail">{detail}</span>{browse && <span className="dash-card-link">{t('dash.viewDetails')} <ArrowRight size={14}/></span>}</>;
    return browse ? <button type="button" className="dash-metric" onClick={() => onInventory?.(focus)} aria-label={`${t('dash.viewDetails')} ${label.toLowerCase()}`}>{content}</button> : <div className="dash-metric">{content}</div>;
  };
  return <div className="trueblue-dashboard-overview">
    <section aria-labelledby="dashboard-work-heading">
      <div className="dash-section-heading">
        <h2 id="dashboard-work-heading">{role === 'Viewer' ? t('dash.operationalQueue') : t('dash.actionRequired')}</h2>
        <span>{role === 'Viewer' ? t('dash.branchSummary') : t('dash.pendingOrders')}</span>
      </div>
      <div className="dash-work-grid">{([{ stage: 'pick', title: t('dash.awaitingPicking'), queue: view.picking, Icon: Boxes }, { stage: 'validate', title: t('dash.awaitingPacking'), queue: view.packing, Icon: PackageCheck }] as const).map(({ stage, title, queue, Icon }) => {
        const allowed = canOpenWork(role, stage) && !!onWork;
        const content = <><div className="dash-work-title"><span>{title}</span><span className="dash-order-count">{formatNumber(queue.orders)} {language === 'en' ? (queue.orders === 1 ? 'order' : 'orders') : 'order'}</span><Icon size={22}/></div><strong>{formatNumber(queue.qty)} <small>pcs</small></strong><span className="dash-work-action">{allowed ? <>{stage === 'pick' ? t('dash.openPicking') : t('dash.openPacking')} <ArrowRight size={16}/></> : role === 'Viewer' ? t('dash.branchSummary') : stage === 'pick' ? (language === 'en' ? 'Picker team stage' : 'Tahap tim pengambilan') : (language === 'en' ? 'Packer team stage' : 'Tahap tim pengemasan')}</span></>;
        const className = 'dash-work-card' + (queue.qty > 0 && stage === 'pick' ? ' has-attention' : '');
        return allowed ? <button key={stage} type="button" className={className} onClick={() => onWork?.(stage)}>{content}</button> : <div key={stage} className={className}>{content}</div>;
      })}</div>
    </section>
    <section aria-labelledby="dashboard-stock-heading">
      <div className="dash-section-heading">
        <h2 id="dashboard-stock-heading">{t('dash.stockSummary')}</h2>
        <span>{formatNumber(view.skuCount)} {language === 'en' ? 'SKUs' : 'SKU'} · {formatNumber(view.stockedSkus)} {language === 'en' ? 'with stock' : 'memiliki stok'} · {formatNumber(view.rows)} {language === 'en' ? 'location rows' : 'baris lokasi'}</span>
      </div>
      <div className="dash-stock-grid">
        {metric(t('dash.physical'), view.totals.physical, t('dash.allRecordedStock'), 'ALL')}
        {metric(t('dash.allocated'), view.totals.allocated, t('dash.forOrdersUnpicked'), 'ALLOCATED', 'dash-warning')}
        {metric(t('dash.available'), view.totals.available, t('dash.pickableUnallocated'), 'AVAILABLE', 'dash-safe')}
        {metric(t('dash.heldBuffer'), view.totals.held, t('dash.cannotBePicked'), 'BLOCKED', 'dash-danger')}
      </div>
    </section>
    <section className="dash-expiry-panel" aria-labelledby="dashboard-expiry-heading">
      <div className="dash-section-heading">
        <h2 id="dashboard-expiry-heading">{t('dash.conditionExpiry')}</h2>
        <span>{t('dash.percentPhysical')}</span>
      </div>
      <div className="dash-expiry-grid">{view.expiry.map(item => {
        const content = <><span className="dash-expiry-title"><i className={item.qty > 0 ? 'dash-dot-' + item.tone : ''}/>{item.label}</span><span className="dash-detail">{item.detail}</span><strong>{formatNumber(item.qty)} <small>pcs</small></strong><span className="dash-expiry-meta"><span>{item.skus} SKU</span><span>{item.percent}%</span></span>{browse && <span className="dash-card-link">{t('dash.viewDetails')} <ArrowRight size={13}/></span>}</>;
        return browse ? <button key={item.focus} className="dash-expiry-cell" type="button" aria-label={`${t('dash.viewDetails')} ${item.label}`} onClick={() => onInventory?.(item.focus)}>{content}</button> : <div key={item.focus} className="dash-expiry-cell">{content}</div>;
      })}</div>
      <p className="dash-note">{t('dash.dashNote')}</p>
    </section>
    <section aria-labelledby="dashboard-today-heading">
      <div className="dash-section-heading">
        <h2 id="dashboard-today-heading">{t('dash.todayActivity')}</h2>
        <span>{language === 'en' ? 'Period 00:00–23:59 WIB' : 'Periode 00.00–23.59 WIB'}</span>
      </div>
      <div className="dash-today-grid">{[
        { label: `Outbound Order (${view.today.orderCount} ${language === 'en' ? 'orders' : 'order'})`, qty: view.today.orderOutbound },
        { label: language === 'en' ? 'Quick Outbound' : 'Outbound Cepat', qty: view.today.quickOutbound },
        { label: t('dash.internalTransfer'), qty: view.today.internal },
        { label: t('dash.incomingTransfer'), qty: view.today.incoming }
      ].map(item => <div className="dash-today-card" key={item.label}><span className="dash-label">{item.label}</span><strong>{formatNumber(item.qty)} <small>pcs</small></strong></div>)}</div>
    </section>
  </div>;
}
