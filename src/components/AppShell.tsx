import AccountSecurity from './AccountSecurity';
import React, {useState,useEffect,useRef,useMemo} from 'react';
import {LayoutDashboard,Package,Truck,ClipboardList,Boxes,ClipboardCheck,ArrowLeftRight,Calendar,LineChart,Database,Users,FileText,Menu,X,KeyRound,LogOut,ChevronRight,Moon,Sun,Scale,ShoppingCart,LayoutGrid,Palette,Check,RotateCcw} from 'lucide-react';
import BranchPanel from './BranchPanel';
import WriteStatus from './WriteStatus';
import type {UiTheme} from '../utils/uiTheme';
import type {BranchOperationType, UserAccount} from '../types';
import type {StockSyncState} from '../utils/stockSyncSafety';
import { useLanguage } from '../i18n/LanguageContext';
import {applyUiAccent,readCustomAccent,readUiAccent,type UiAccent} from '../utils/uiAccent';
import {branchSupportsOperation} from '../utils/orderType';

type Props={theme:UiTheme;onToggleTheme:()=>void;children:React.ReactNode;activeTab:string;onNavigate:(tab:string)=>void;currentUser:UserAccount|null;connected:boolean;stockSyncState:StockSyncState;onLogout:()=>void;onRefresh:()=>void;onUpload:()=>void;totalQty:number;branchOperationType?:BranchOperationType;onBranchOperationTypeChange?:(op:BranchOperationType)=>void};
const management=['Administrator','Admin'];
const accentOptions:{id:UiAccent;label:string;color:string}[]=[
 {id:'default',label:'Default',color:'#0d0d0d'},{id:'blue',label:'Biru',color:'#2f6feb'},
 {id:'green',label:'Hijau',color:'#10a37f'},{id:'yellow',label:'Kuning',color:'#f5b82e'},
 {id:'pink',label:'Merah muda',color:'#ed5fa0'},{id:'orange',label:'Oranye',color:'#ff7657'},
 {id:'purple',label:'Ungu',color:'#9654f4'},{id:'black',label:'Hitam',color:'#000000'},
 {id:'custom',label:'Kustom',color:'custom'}
];

export default function AppShell({theme,onToggleTheme,children,activeTab,onNavigate,currentUser,connected,stockSyncState,onLogout,onRefresh,onUpload,totalQty,branchOperationType='HYBRID',onBranchOperationTypeChange}:Props){
 const { t, language, toggleLanguage } = useLanguage();
 const [securityOpen,setSecurityOpen]=useState(false);
 const [accent,setAccent]=useState<UiAccent>(readUiAccent),[customAccent,setCustomAccent]=useState(readCustomAccent),[accentOpen,setAccentOpen]=useState(false);
 const [open,setOpen]=useState(()=>currentUser?.role === 'Picker'),[adminTarget,setAdminTarget]=useState<HTMLDivElement|null>(null);
 const [desktopCollapsed,setDesktopCollapsed]=useState(false);
 const [isDesktop,setIsDesktop]=useState(()=>window.matchMedia('(min-width: 1100px)').matches);
 const side=useRef<HTMLElement>(null),toggle=useRef<HTMLButtonElement>(null),accentMenu=useRef<HTMLDivElement>(null);
 const closeNavigation=()=>{if(isDesktop){setDesktopCollapsed(true);toggle.current?.focus()}else setOpen(false)};

 const menus = useMemo(() => {
  const showB2b = branchSupportsOperation(branchOperationType, 'B2B');
  const showOnline = branchSupportsOperation(branchOperationType, 'ONLINE');
  return [
   {
     group: t('nav.summary'),
     items: [
       { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard, roles: [...management, 'Viewer'] },
       { id: 'analytics', label: t('nav.analytics'), icon: LineChart, roles: management }
     ]
   },
   {
     group: t('nav.operations'),
     items: [
       { id: 'picker-hub', label: t('nav.pickerHub'), icon: LayoutGrid, roles: ['Picker'] },
       { id: 'inventory', label: t('nav.inventory'), icon: Package, roles: [...management, 'Viewer'] },
       { id: 'inbound', label: t('nav.inbound'), icon: Truck, roles: management },
       { id: 'return', label: t('nav.return'), icon: RotateCcw, roles: management },
       { id: 'quick-outbound', label: t('nav.outboundQuick'), icon: ClipboardCheck, roles: management },
       { id: 'bulk-transfer', label: t('nav.warehouseTransfer'), icon: ArrowLeftRight, roles: [...management, 'Viewer'] },
       { id: 'daily-cycle-count', label: t('nav.stockOpname'), icon: Calendar, roles: management },
       { id: 'reconciliation', label: t('nav.reconciliation'), icon: Scale, roles: management }
     ]
   },
   ...(showB2b ? [{
     group: t('nav.outboundB2bGroup'),
     items: [
       { id: 'b2b-input', label: t('nav.b2bInput'), icon: ShoppingCart, roles: management },
       { id: 'b2b-picking', label: t('nav.b2bPicking'), icon: ClipboardList, roles: [...management, 'Picker'] },
       { id: 'b2b-packing', label: t('nav.b2bPacking'), icon: ClipboardCheck, roles: [...management, 'Packer'] },
       { id: 'b2b-history', label: t('nav.b2bHistory'), icon: FileText, roles: management }
     ]
   }] : []),
   ...(showOnline ? [{
     group: t('nav.outboundOnlineGroup'),
     items: [
       { id: 'online-input', label: t('nav.onlineInput'), icon: ShoppingCart, roles: management },
       { id: 'online-picking', label: t('nav.onlinePicking'), icon: Boxes, roles: [...management, 'Picker'] },
       { id: 'online-sorting', label: t('nav.onlineSorting'), icon: Boxes, roles: [...management, 'Packer'] },
       { id: 'online-packing', label: t('nav.onlinePacking'), icon: ClipboardCheck, roles: [...management, 'Packer'] },
       { id: 'online-history', label: t('nav.onlineHistory'), icon: FileText, roles: management }
     ]
   }] : []),
   {
     group: t('nav.shippingGroup'),
     items: [
       { id: 'shipping-manifest', label: t('nav.shippingManifest'), icon: Truck, roles: [...management, 'Shipping'] }
     ]
   },
   {
     group: t('nav.masterData'),
     items: [
       { id: 'catalog', label: t('nav.catalog'), icon: Database, roles: management },
       { id: 'users', label: t('nav.operators'), icon: Users, roles: management }
     ]
   }
  ];
 }, [t, branchOperationType]);

 const homeRoute = currentUser?.role === 'Shipping'
  ? 'shipping-manifest'
  : currentUser?.role === 'Picker'
    ? 'picker-hub'
    : currentUser?.role === 'Packer'
      ? (branchOperationType === 'B2B' ? 'b2b-packing' : 'online-sorting')
      : 'dashboard';

 const active=menus.flatMap(g=>g.items).find(i=>i.id===activeTab);
 const [showSyncBanner, setShowSyncBanner] = useState(false);
 useEffect(() => {
   if (currentUser?.role === 'Picker') {
     setOpen(true);
     setDesktopCollapsed(false);
   }
 }, [currentUser?.role]);
 useEffect(() => {
   if (stockSyncState.phase === 'failed' || stockSyncState.stale || (!connected && stockSyncState.phase !== 'syncing')) {
     setShowSyncBanner(true);
   } else {
     setShowSyncBanner(false);
   }
 }, [stockSyncState.phase, stockSyncState.stale, connected]);
 useEffect(()=>{const q=window.matchMedia('(min-width: 1100px)');const change=()=>{setIsDesktop(q.matches);setOpen(false)};q.addEventListener('change',change);return()=>q.removeEventListener('change',change)},[]);
 useEffect(() => {
   const toggleHandler = () => {
     if (isDesktop) setDesktopCollapsed(prev => !prev);
     else setOpen(prev => !prev);
   };
   window.addEventListener('wms-toggle-sidebar', toggleHandler);
   return () => window.removeEventListener('wms-toggle-sidebar', toggleHandler);
 }, [isDesktop]);
 useEffect(()=>{applyUiAccent(accent,customAccent)},[accent,customAccent]);
 useEffect(()=>{if(!accentOpen)return;const close=(event:MouseEvent)=>{if(!accentMenu.current?.contains(event.target as Node))setAccentOpen(false)};const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setAccentOpen(false)};document.addEventListener('mousedown',close);document.addEventListener('keydown',key);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',key)}},[accentOpen]);
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
  <a className="blues-skip-link" href="#blues-main">{t('sync.skipToContent')}</a>
  {open&&<button className="blues-sidebar-backdrop" aria-label="Tutup menu navigasi" onClick={()=>setOpen(false)}/>}
  <aside ref={side} id="blues-sidebar" className={'blues-sidebar'+(open?' is-open':'')} role={open?'dialog':undefined} aria-modal={open?true:undefined} aria-label="Navigasi TRUEBLUE WMS">
   <div className="blues-brand"><button onClick={()=>navigate(homeRoute)} aria-label="TRUEBLUE WMS — Dashboard"><img src="/trueblue-wms-logo.png" alt="Logo TRUEBLUE WMS"/><span><strong>TRUEBLUE <span>WMS</span></strong><small>WAREHOUSE OPERATION · {branchOperationType}</small></span></button><button data-close-menu className="blues-menu-close blues-icon-button" aria-label="Tutup navigasi" onClick={closeNavigation}><X size={20}/></button></div>
   <div className="blues-sidebar-scroll"><nav aria-label="Menu utama">{menus.map(group=>{const visible=group.items.filter(item=>!('roles' in item)||item.roles?.includes(currentUser?.role||''));return visible.length?<div className="blues-nav-group" key={group.group}><p className="blues-nav-caption">{group.group}</p>{visible.map(item=><button key={item.id} className={'blues-nav-link'+(activeTab===item.id?' is-active':'')} aria-current={activeTab===item.id?'page':undefined} onClick={()=>navigate(item.id)}><item.icon size={18} strokeWidth={1.7}/><span>{item.label}</span></button>)}</div>:null})}</nav><div ref={setAdminTarget} className="blues-admin-nav"/></div>
   <div className="blues-sidebar-status"><span className={'blues-status-dot'+(stockSyncState.phase==='synced'&&connected?'':' is-offline')}/><span>{stockSyncState.phase==='syncing'?t('sync.syncing'):stockSyncState.phase==='failed'?t('sync.failed'):connected?t('sync.synced'):t('sync.stale')}</span><small>TRUEBLUE WMS · Copyright by KHOERUL AMRI</small></div>
  </aside>
  <div className="blues-workspace" inert={open?true:undefined}>
   <header className="blues-topbar"><div className="blues-topbar-start"><button ref={toggle} className="blues-menu-toggle blues-icon-button" aria-label={isDesktop&&!desktopCollapsed?'Sembunyikan menu navigasi':'Buka menu navigasi'} aria-expanded={isDesktop?!desktopCollapsed:open} aria-controls="blues-sidebar" onClick={()=>{if(isDesktop)setDesktopCollapsed(value=>!value);else setOpen(true)}}><Menu size={22}/></button><div className="blues-breadcrumb"><span>{t('topbar.workspace')}</span><ChevronRight size={14}/><strong>{active?.label||t('topbar.operations')}</strong></div></div>
    <div className="blues-topbar-end"><BranchPanel currentUser={currentUser} navigationTarget={adminTarget} onAction={()=>setOpen(false)} onOpenWebhook={()=>navigate('marketplace-webhook')} onBranchOperationTypeChange={onBranchOperationTypeChange}/><button type="button" className="blues-icon-button blues-lang-toggle" aria-label={language === 'id' ? t('topbar.switchToEnglish') : t('topbar.switchToIndonesian')} title={language === 'id' ? t('topbar.switchToEnglish') : t('topbar.switchToIndonesian')} onClick={toggleLanguage}><span className="font-extrabold text-[11px] font-mono tracking-tight select-none px-1">{language === 'id' ? 'EN' : 'ID'}</span></button><div className="blues-accent-control" ref={accentMenu}><button className="blues-icon-button" aria-label="Pilih warna aksen" title="Warna aksen" aria-haspopup="menu" aria-expanded={accentOpen} onClick={()=>setAccentOpen(value=>!value)}><Palette size={19}/></button>{accentOpen&&<div className="blues-accent-menu" role="menu" aria-label="Warna aksen">{accentOptions.map(option=><div className="blues-accent-row" key={option.id}>{option.id==='custom'?<><label className="blues-accent-option"><span className="blues-accent-swatch" style={{background:customAccent}}/><span>Kustom</span><input className="blues-custom-color" type="color" value={customAccent} aria-label="Pilih warna aksen kustom" onChange={event=>{setCustomAccent(event.target.value);setAccent('custom')}}/>{accent==='custom'&&<Check size={18}/>}</label></>:<button role="menuitemradio" aria-checked={accent===option.id} className="blues-accent-option" onClick={()=>{setAccent(option.id);setAccentOpen(false)}}><span className="blues-accent-swatch" style={{background:option.color}}/><span>{option.label}</span>{accent===option.id&&<Check size={18}/>}</button>}</div>)}</div>}</div><button className="blues-icon-button blues-theme-toggle" aria-label={theme==='dark'?'Gunakan mode terang':'Gunakan mode gelap'} title={theme==='dark'?'Gunakan mode terang':'Gunakan mode gelap'} aria-pressed={theme==='dark'} onClick={onToggleTheme}>{theme==='dark'?<Sun size={19}/>:<Moon size={19}/>}</button><div className="blues-user"><span className="blues-avatar">{currentUser?.fullName?.charAt(0)||'U'}</span><div><strong>{currentUser?.fullName}</strong><small>{currentUser?.role}</small></div></div><button className="blues-icon-button" aria-label={t('topbar.changePassword')} title={t('topbar.changePassword')} onClick={()=>setSecurityOpen(true)}><KeyRound size={18}/></button><button id="header-logout-btn" className="blues-icon-button blues-logout" aria-label={t('topbar.logout')} title={t('topbar.logout')} onClick={onLogout}><LogOut size={18}/></button></div>
   </header>
   <WriteStatus/>
   {showSyncBanner && (
    <div
     role={stockSyncState.phase==='failed'||stockSyncState.stale?'alert':'status'}
     aria-live={stockSyncState.phase==='failed'||stockSyncState.stale?'assertive':'polite'}
     className={'mx-4 mt-3 flex items-center justify-between rounded-xl border px-4 py-2.5 text-sm sm:mx-6 transition-all shadow-sm '+(stockSyncState.phase==='failed'||stockSyncState.stale?'border-amber-500/50 bg-amber-500/10 text-amber-100':'border-emerald-500/30 bg-emerald-500/10 text-emerald-100')}
    >
     <div className="flex items-center gap-2">
      <strong>{stockSyncState.phase==='syncing'?(stockSyncState.stale?t('sync.bannerStaleProgress'):t('sync.syncing')):stockSyncState.phase==='failed'||!connected?t('sync.bannerFailedOrStale'):t('sync.synced')}</strong>
      <span className="text-xs opacity-90">{!connected&&stockSyncState.phase==='synced'?t('sync.disconnected'):''}{stockSyncState.message}</span>
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
