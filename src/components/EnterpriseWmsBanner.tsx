import React from 'react';
import {Plus,Smartphone,ArrowUpRight} from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {userRole?:string;onNavigate:(tab:any)=>void;totalSkuCount?:number;totalUnitsCount?:number}
export default function EnterpriseWmsBanner({userRole,onNavigate}:Props){
  const { t } = useLanguage();
  const viewer = userRole === 'Viewer';
  const manage = ['Administrator','Admin'].includes(userRole || '');
  const label = viewer ? t('dash.viewStock') : userRole === 'Picker' ? t('dash.openPicking') : userRole === 'Packer' ? t('dash.openPacking') : t('dash.newStoreOrder');
  return <div id="wms-enterprise-banner" className="blues-page-heading">
    <div>
      <p className="blues-eyebrow">{t('dash.bannerEyebrow')}</p>
      <h1>{t('dash.bannerTitle')}</h1>
      <p className="blues-page-description">{t('dash.bannerDesc')}</p>
    </div>
    <div className="blues-heading-actions">
      {manage && <button className="blues-button" onClick={() => onNavigate('mobile-sync')}><Smartphone size={16}/><span>{t('dash.deviceAccess')}</span></button>}
      <button className="blues-button blues-button-primary" onClick={() => onNavigate(viewer ? 'inventory' : 'bulk')}>
        {viewer ? <ArrowUpRight size={16}/> : <Plus size={16}/>}
        <span>{label}</span>
      </button>
    </div>
  </div>;
}
