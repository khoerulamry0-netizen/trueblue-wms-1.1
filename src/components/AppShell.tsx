import AccountSecurity from './AccountSecurity';
import React, {useState,useEffect,useRef} from 'react';
import {LayoutDashboard,Package,Truck,ClipboardList,Boxes,ClipboardCheck,ArrowLeftRight,Calendar,LineChart,Database,Users,MessageSquare,Menu,X,KeyRound,LogOut,RefreshCw,UploadCloud,ChevronRight,Moon,Sun,Shield} from 'lucide-react';
import BranchPanel from './BranchPanel';
import WriteStatus from './WriteStatus';
import type {UiTheme} from '../utils/uiTheme';
import type {UserAccount} from '../types';
import type {StockSyncState} from '../utils/stockSyncSafety';

type Props={theme:UiTheme;onToggleTheme:()=>void;children:React.ReactNode;activeTab:string;onNavigate:(tab:string)=>void;currentUser:UserAccount|null;connected:boolean;stockSyncState:StockSyncState;onLogout:()=>void;onRefresh:()=>void;onUpload:()=>void;totalQty:number};
const management=['Administrator','Admin'];
const operators=[...management,'Picker','Packer','Shipping'];
const menus=[
 {group:'Ringkasan',items:[{id:'dashboard',label:'Dashboard DC',icon:LayoutDashboard},{id:'analytics',label:'Analitik',icon:LineChart,roles:management}]},
 {group:'Operasional',items:[{id:'inventory',label:'Stok',icon:Package,roles:[...management,'Viewer']},{id:'inbound',label:'Inbound',icon:Truck,roles:management},{id:'bulk',label:'Outbound',icon:ClipboardList,roles:operators},{id:'mabang',label:'Picking/Packing',icon:Boxes,roles:operators},{id:'quick-outbound',label:'Outbound Cepat',icon:ClipboardCheck,roles:management},{id:'bulk-transfer',label:'Warehouse & Transfer',icon:ArrowLeftRight,roles:[...management,'Viewer']},{id:'daily-cycle-count',label:'Stock Opname (DCC)',icon:Calendar,roles:management}]},
 {group:'Master data',items:[{id:'catalog',label:'Katalog Produk',icon:Database,roles:management},{id:'users',label:'Kelola Operator',icon:Users,roles:management}]},
 {group:'Bantuan',items:[{id:'ai-chat',label:'Asisten WMS',icon:MessageSquare}]}
];
export default function AppShell({theme,onToggleTheme,children,activeTab,onNavigate,currentUser,connected,stockSyncState,onLogout,onRefresh,onUpload,totalQty}:Props){
 const [securityOpen,setSecurityOpen]=useState(false);
 const [open,setOpen]=useState(false),[adminTarget,setAdminTarget]=useState<HTMLDivElement|null>(null);
 const [desktopCollapsed,setDesktopCollapsed]=useState(false);
 const [isDesktop,setIsDesktop]=useState(()=>window.matchMedia('(min-width: 1100px)').matches);
 const side=useRef<HTMLElement>(null),toggle=useRef<HTMLButtonElement>(null);
 const closeNavigation=()=>{if(isDesktop){setDesktopCollapsed(true);toggle.current?.focus()}else setOpen(false)};
 const active=menus.flatMap(g=>g.items).find(i=>i.id===activeTab);
 const [showSyncBanner, setShowSyncBanner] = useState(false);
 useEffect(() => {
   if (stockSyncState.phase === 'failed' || stockSyncState.stale || (!connected && stockSyncState.phase !== 'syncing')) {
     setShowSyncBanner(true);
   } else {
     setShowSyncBanner(false);
   }
 }, [stockSyncState.phase, stockSyncState.stale, connected]);
 useEffect(()=>{const q=window.matchMedia('(min-width: 1100px)');const change=()=>{setIsDesktop(q.matches);setOpen(false)};q.addEventListener('change',change);return()=>q.removeEventListener('change',change)},[]);
 useEffect(()=>{
   if(!open)return;
   const before=document.activeElement as HTMLElement,overflow=document.body.style.overflow;
   document.body.style.overflow='hidden';side.current?.querySelector<HTMLButtonElement>('[data-close-menu]')?.focus();
   const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);return}if(e.key!=='Tab')return;const nodes=(Array.from(side.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],select')||[]) as HTMLElement[]).filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}};
   document.addEventListener('keydown',key);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',key);if(before?.isConnected)before.focus()};
 },[open]);
 const navigate=(id:string)=>{onNavigate(id);setOpen(false)};
 return <div className={'blues-app-shell'+(desktopCollapsed?' is-sidebar-collapsed':'')}>
  {securityOpen&&<AccountSecurity onClose={()=>setSecurityOpen(false)}/>}
  <a className="blues-skip-link" href="#blues-main">Langsung ke konten</a>
  {open&&<button className="blues-sidebar-backdrop" aria-label="Tutup menu navigasi" onClick={()=>setOpen(false)}/>}
  <aside ref={side} id="blues-sidebar" className={'blues-sidebar'+(open?' is-open':'')} role={open?'dialog':undefined} aria-modal={open?true:undefined} aria-label="Navigasi TRUEBLUE WMS">
   <div className="blues-brand"><button onClick={()=>navigate('dashboard')} aria-label="TRUEBLUE WMS — Dashboard"><img src="/trueblue-lion.png" alt="Logo singa biru TRUEBLUE"/><span><strong>TRUEBLUE <span>WMS</span></strong><small>WAREHOUSE OPERATION</small></span></button><button data-close-menu className="blues-menu-close blues-icon-button" aria-label="Tutup navigasi" onClick={closeNavigation}><X size={20}/></button></div>
   <div className="blues-sidebar-scroll"><nav aria-label="Menu utama">{menus.map(group=>{const visible=group.items.filter(item=>!('roles' in item)||item.roles?.includes(currentUser?.role||''));return visible.length?<div className="blues-nav-group" key={group.group}><p className="blues-nav-caption">{group.group}</p>{visible.map(item=><button key={item.id} className={'blues-nav-link'+(activeTab===item.id?' is-active':'')} aria-current={activeTab===item.id?'page':undefined} onClick={()=>navigate(item.id)}><item.icon size={18} strokeWidth={1.7}/><span>{item.label}</span></button>)}</div>:null})}</nav><div ref={setAdminTarget} className="blues-admin-nav"/></div>
   <div className="blues-sidebar-status"><span className={'blues-status-dot'+(stockSyncState.phase==='synced'&&connected?'':' is-offline')}/><span>{stockSyncState.phase==='syncing'?'Sinkronisasi stok berlangsung':stockSyncState.phase==='failed'?'Sinkronisasi stok gagal':connected?'Sinkronisasi stok berhasil':'Data stok mungkin tidak terbaru'}</span><small>TRUEBLUE WMS</small></div>
  </aside>
  <div className="blues-workspace" inert={open?true:undefined}>
   <header className="blues-topbar"><div className="blues-topbar-start"><button ref={toggle} className="blues-menu-toggle blues-icon-button" aria-label={isDesktop&&!desktopCollapsed?'Sembunyikan menu navigasi':'Buka menu navigasi'} aria-expanded={isDesktop?!desktopCollapsed:open} aria-controls="blues-sidebar" onClick={()=>{if(isDesktop)setDesktopCollapsed(value=>!value);else setOpen(true)}}><Menu size={22}/></button><div className="blues-breadcrumb"><span>Workspace</span><ChevronRight size={14}/><strong>{active?.label||'Operasional'}</strong></div></div>
    <div className="blues-topbar-end"><BranchPanel currentUser={currentUser} navigationTarget={adminTarget} onAction={()=>setOpen(false)}/><button className={'blues-icon-button blues-theme-toggle'+(theme==='chelsea'?' is-chelsea':'')} aria-label={theme==='citrus'?'Gunakan tema Chelsea FC':theme==='chelsea'?'Gunakan tema gelap':'Gunakan tema terang'} title={theme==='citrus'?'Gunakan tema Chelsea FC':theme==='chelsea'?'Tema Chelsea FC aktif (Klik untuk tema gelap)':'Gunakan tema terang'} aria-pressed={theme!=='citrus'} onClick={onToggleTheme}>{theme==='dark'?<Sun size={19}/>:theme==='chelsea'?<Shield size={18}/>:<Moon size={19}/>}</button><div className="blues-user"><span className="blues-avatar">{currentUser?.fullName?.charAt(0)||'U'}</span><div><strong>{currentUser?.fullName}</strong><small>{currentUser?.role}</small></div></div><button className="blues-icon-button" aria-label="Ganti password akun" title="Ganti password akun" onClick={()=>setSecurityOpen(true)}><KeyRound size={18}/></button><button id="header-logout-btn" className="blues-icon-button blues-logout" aria-label="Keluar akun" title="Keluar akun" onClick={onLogout}><LogOut size={18}/></button></div>
   </header>
   <WriteStatus/>
   {showSyncBanner && (
    <div
     role={stockSyncState.phase==='failed'||stockSyncState.stale?'alert':'status'}
     aria-live={stockSyncState.phase==='failed'||stockSyncState.stale?'assertive':'polite'}
     className={'mx-4 mt-3 flex items-center justify-between rounded-xl border px-4 py-2.5 text-sm sm:mx-6 transition-all shadow-sm '+(stockSyncState.phase==='failed'||stockSyncState.stale?'border-amber-500/50 bg-amber-500/10 text-amber-100':'border-emerald-500/30 bg-emerald-500/10 text-emerald-100')}
    >
     <div className="flex items-center gap-2">
      <strong>{stockSyncState.phase==='syncing'?(stockSyncState.stale?'Sinkronisasi berlangsung; data stok mungkin tidak terbaru':'Sinkronisasi stok berlangsung'):stockSyncState.phase==='failed'||!connected?'Sinkronisasi stok gagal atau data mungkin tidak terbaru':'Sinkronisasi stok berhasil'}</strong>
      <span className="text-xs opacity-90">{!connected&&stockSyncState.phase==='synced'?'Koneksi sumber data terputus; ':''}{stockSyncState.message}</span>
     </div>
     <button
      type="button"
      onClick={() => setShowSyncBanner(false)}
      className="p-1 hover:bg-white/10 rounded-lg transition-colors cursor-pointer text-xs shrink-0"
      aria-label="Tutup notifikasi"
     >
      <X size={15}/>
     </button>
    </div>
   )}
   <div className="blues-content-scroll" id="blues-main" tabIndex={-1}>{children}</div>
  </div>
 </div>;
}
