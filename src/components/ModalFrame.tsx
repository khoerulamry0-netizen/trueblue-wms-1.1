import React,{useEffect,useRef} from 'react';
import {createPortal} from 'react-dom';
type Props={children:React.ReactNode;titleId:string;onClose:()=>void;className?:string};
export default function ModalFrame({children,titleId,onClose,className=''}:Props){
 const panel=useRef<HTMLElement>(null),closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{
  const before=document.activeElement as HTMLElement;
  const shell=document.querySelector<HTMLElement>('.blues-app-shell');const wasInert=shell?.inert;
  const overflow=document.body.style.overflow;document.body.style.overflow='hidden';if(shell)shell.inert=true;
  panel.current?.querySelector<HTMLButtonElement>('[data-modal-close]')?.focus();
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRef.current();return;}
   if(event.key!=='Tab')return;
   const nodes=(Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')||[]) as HTMLElement[]).filter(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');
   const first=nodes[0],last=nodes[nodes.length-1];if(!first){event.preventDefault();panel.current?.focus();return;}
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  };
  document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=overflow;if(shell)shell.inert=wasInert||false;if(before?.isConnected)before.focus();};
 },[]);
 return createPortal(<div className="blues-modal-layer"><section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={'blues-modal-frame '+className}>{children}</section></div>,document.body);
}
