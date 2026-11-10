import React from 'react';
import {Plus,Smartphone,ArrowUpRight} from 'lucide-react';
interface Props {userRole?:string;onNavigate:(tab:any)=>void;totalSkuCount?:number;totalUnitsCount?:number}
export default function EnterpriseWmsBanner({userRole,onNavigate}:Props){
 const viewer=userRole==='Viewer';
 const manage=['Administrator','Admin'].includes(userRole||'');
 const label=viewer?'Lihat stok':userRole==='Picker'?'Buka pengambilan':userRole==='Packer'?'Buka pengemasan':'Order gerai baru';
 return <div id="wms-enterprise-banner" className="blues-page-heading"><div><p className="blues-eyebrow">Ringkasan</p><h1>Ringkasan gudang</h1><p className="blues-page-description">Stok, kedaluwarsa, dan pekerjaan yang perlu ditindaklanjuti.</p></div><div className="blues-heading-actions">{manage&&<button className="blues-button" onClick={()=>onNavigate('mobile-sync')}><Smartphone size={16}/><span>Akses perangkat</span></button>}<button className="blues-button blues-button-primary" onClick={()=>onNavigate(viewer?'inventory':'bulk')}>{viewer?<ArrowUpRight size={16}/>:<Plus size={16}/>}<span>{label}</span></button></div></div>;
}
