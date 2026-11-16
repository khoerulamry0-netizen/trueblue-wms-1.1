import {supabase,getActiveBranch} from '../supabase';
import { useLanguage } from '../i18n/LanguageContext';
import React, { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { 
  Printer, 
  X, 
  ClipboardList, 
  FileText, 
  AlertTriangle,
  Package,
  Layers,
  CheckCircle2,
  Eye,
  Boxes,
  UserCheck
} from 'lucide-react';
import { formatNumber } from '../utils/calculations';

export interface ShippingOrderData {
  branchId?: string;
  referenceNumber: string;
  orderNumber?: string;
  orderId?: string;
  noPo?: string;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  batchNumber?: string;
  courier?: string;
  trackingNumber?: string;
  timestamp?: string;
  weight?: string | number;
  items: Array<{
    id: string;
    skuId: string;
    skuName: string;
    location?: string;
    expiredDate?: string;
    qty: number;
  }>;
  totalQty?: number;
  packerName?: string;
  pickerName?: string;
  inputByName?: string;
}

interface ShippingReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: ShippingOrderData | null;
  currentUser?: { fullName?: string; username?: string; role?: string } | null;
  autoPrint?: boolean;
}

export default function ShippingReceiptModal({
  isOpen,
  onClose,
  order,
  currentUser,
  autoPrint = false
}: ShippingReceiptModalProps) {
  const { t, language } = useLanguage();
  const senderBranch = order?.branchId || getActiveBranch();
  const [sender, setSender] = useState<{ branch: string; name: string; phone: string }>({
    branch: senderBranch,
    name: 'TrueBlue WMS',
    phone: '-'
  });
  const [senderError, setSenderError] = useState('');
  const senderReady = !!sender && sender.branch === senderBranch;

  useEffect(() => {
    let live = true;
    if (!isOpen) return;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 4000);

    (async () => {
      try {
        if (!supabase) return;
        const { data, error } = await supabase
          .from('branches')
          .select('sender_name, sender_phone')
          .eq('id', senderBranch)
          .abortSignal(controller.signal)
          .single();
        if (error) throw error;
        if (live && data) {
          setSender({
            branch: senderBranch,
            name: data.sender_name?.trim() || 'TrueBlue WMS',
            phone: data.sender_phone?.trim() || '-'
          });
        }
      } catch (e: any) {
        if (live) {
          setSender({
            branch: senderBranch,
            name: 'TrueBlue WMS',
            phone: '-'
          });
        }
      } finally {
        clearTimeout(abortTimer);
      }
    })();

    return () => {
      live = false;
      clearTimeout(abortTimer);
      controller.abort();
    };
  }, [isOpen, senderBranch]);
  const [copiedReceipt, setCopiedReceipt] = useState(false);
  const [isInIframe, setIsInIframe] = useState(false);
  const [activePreviewTab, setActivePreviewTab] = useState<'both' | 'page1' | 'page2'>('both');
  const [includePage2, setIncludePage2] = useState(true);

  const barcodeSvgRef = useRef<SVGSVGElement | null>(null);
  const barcodeSvgPage2Ref = useRef<SVGSVGElement | null>(null);
  const hasAutoPrintedRef = useRef(false);
  const [autoCloseSeconds, setAutoCloseSeconds] = useState<number | null>(null);
  const autoCloseCancelledRef = useRef<boolean>(false);

  // Check if running inside an iframe (like AI Studio preview)
  useEffect(() => {
    try {
      setIsInIframe(window.self !== window.top);
    } catch (e) {
      setIsInIframe(true);
    }
  }, []);

  // Resolve values with proper fallbacks (safe for null order)
  const resolvedOrderId = order?.orderId?.trim() || 
    order?.batchNumber?.trim() || 
    order?.orderNumber?.trim() || 
    (order?.referenceNumber 
      ? `ORD-${order.referenceNumber.replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase()}` 
      : `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
  
  const resolvedCustomer = order?.customerName?.trim() || '-';
  const resolvedAddress = order?.customerAddress?.trim() || '-';
  const resolvedPhone = order?.customerPhone?.trim() || '-';
  const itemsList = order?.items || [];
  const totalCalculatedQty = itemsList.reduce((sum, i) => sum + (i.qty || 0), 0) || order?.totalQty || 0;

  const formattedDate = order?.timestamp 
    ? new Date(order.timestamp).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    : new Date().toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });

  // Render Barcode via JsBarcode using the Order ID for Page 1 & Page 2
  useEffect(() => {
    if (isOpen && order && resolvedOrderId) {
      // Delay slightly so DOM nodes are mounted
      const timer = setTimeout(() => {
        if (barcodeSvgRef.current) {
          try {
            JsBarcode(barcodeSvgRef.current, resolvedOrderId, {
              format: 'CODE128',
              lineColor: '#000000',
              width: 2.1,
              height: 56,
              displayValue: true,
              text: resolvedOrderId,
              fontSize: 18,
              font: 'sans-serif',
              fontOptions: 'bold',
              textMargin: 6,
              margin: 4,
              background: '#ffffff'
            });
          } catch (err) {
            console.error('Failed to generate shipping barcode for Order ID:', resolvedOrderId, err);
          }
        }

        if (barcodeSvgPage2Ref.current) {
          try {
            JsBarcode(barcodeSvgPage2Ref.current, resolvedOrderId, {
              format: 'CODE128',
              lineColor: '#000000',
              width: 1.8,
              height: 38,
              displayValue: true,
              text: resolvedOrderId,
              fontSize: 11,
              font: 'monospace',
              textMargin: 3,
              margin: 2,
              background: '#ffffff'
            });
          } catch (err) {
            console.error('Failed to generate Page 2 barcode for Order ID:', resolvedOrderId, err);
          }
        }
      }, 100);

      return () => clearTimeout(timer);
    } else {
      hasAutoPrintedRef.current = false;
    }
  }, [resolvedOrderId, isOpen, order, activePreviewTab, includePage2]);

  // Efek Otomatis Cetak (Auto-Print) saat resi terbuka
  useEffect(() => {
    if (isOpen && order && (senderReady || senderError) && autoPrint && !hasAutoPrintedRef.current) {
      hasAutoPrintedRef.current = true;
      const printTimer = setTimeout(() => {
        handlePrint();
        // Start auto-close countdown after print
        setAutoCloseSeconds(3);
      }, 500); 
      return () => clearTimeout(printTimer);
    }
  }, [isOpen, order, autoPrint, senderReady, senderError]);

  // Efek Countdown Auto-Close
  useEffect(() => {
    if (autoCloseSeconds !== null && autoCloseSeconds > 0) {
      const timer = setTimeout(() => setAutoCloseSeconds(autoCloseSeconds - 1), 1000);
      return () => clearTimeout(timer);
    } else if (autoCloseSeconds === 0) {
      if (!autoCloseCancelledRef.current) {
        onClose();
      }
    }
  }, [autoCloseSeconds, onClose]);

  // Conditional early return only AFTER all hooks are called
  if (!isOpen || !order) return null;

  // Track user interaction to cancel auto-close
  const handleUserInteraction = () => {
    if (autoCloseSeconds !== null) {
      setAutoCloseSeconds(null);
      autoCloseCancelledRef.current = true;
    }
  };

  // Plaintext Receipt for copying / downloading
  const generateReceiptText = () => {
    let text = `========================================\n`;
    text += `LEMBAR 1: RESI PENGIRIMAN TRUEBLUE WMS\n`;
    text += `----------------------------------------\n`;
    text += `Dear      : ${resolvedCustomer}\n`;
    text += `Order id  : ${resolvedOrderId}\n\n`;
    text += `Address   : ${resolvedAddress}\n\n`;
    text += `Phone     : ${resolvedPhone}\n`;
    text += `________________________________________\n\n`;
    text += `From      : ${sender?.name || '-'}\n\n`;
    text += `Phone     : ${sender?.phone || '-'}\n`;
    text += `========================================\n\n`;

    if (includePage2) {
      text += `========================================\n`;
      text += `LEMBAR 2: DESKRIPSI ISI PAKET (PACKING SLIP)\n`;
      text += `----------------------------------------\n`;
      text += `Order ID  : ${resolvedOrderId}\n`;
      text += `Penerima  : ${resolvedCustomer} (${resolvedPhone})\n`;
      text += `Waktu     : ${formattedDate}\n`;
      text += `Petugas   : Input: ${order.inputByName || 'Admin'} | Picker: ${order.pickerName || '-'} | Packer: ${order.packerName || '-'}\n`;
      text += `----------------------------------------\n`;
      text += `DAFTAR ISI BARANG:\n`;
      itemsList.forEach((item, index) => {
        text += `${index + 1}. [${item.skuId}] ${item.skuName}\n`;
        text += `   Qty: ${item.qty} pcs`;
        if (item.location) text += ` | Rak: ${item.location}`;
        if (item.expiredDate) text += ` | Exp: ${item.expiredDate}`;
        text += `\n`;
      });
      text += `----------------------------------------\n`;
      text += `TOTAL KUANTITAS: ${formatNumber(totalCalculatedQty)} Pcs (${itemsList.length} SKU)\n`;
      text += `========================================\n`;
    }

    return text;
  };

  const handleCopyReceipt = () => {
    if(!senderReady){window.alert(senderError || 'Tunggu data pengirim cabang selesai dimuat.');return;}
    const text = generateReceiptText();
    navigator.clipboard.writeText(text).then(() => {
      setCopiedReceipt(true);
      setTimeout(() => setCopiedReceipt(false), 3000);
    });
  };

  const handleDownloadReceipt = () => {
    if(!senderReady){window.alert(senderError || 'Tunggu data pengirim cabang selesai dimuat.');return;}
    const text = generateReceiptText();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Resi_BLUES_WMS_${resolvedOrderId}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    if(!senderReady){window.alert(senderError || 'Tunggu data pengirim cabang selesai dimuat.');return;}
    // Pastikan jika includePage2 aktif, tab preview juga disinkronkan ke 'both'
    if (includePage2 && activePreviewTab !== 'both') {
      setActivePreviewTab('both');
    }

    // Buat iframe khusus cetak untuk memastikan CSS print tidak terpotong oleh parent overflow atau tab dialog
    try {
      const existingFrame = document.getElementById('receipt-print-iframe');
      if (existingFrame) {
        existingFrame.remove();
      }

      const printFrame = document.createElement('iframe');
      printFrame.id = 'receipt-print-iframe';
      printFrame.style.position = 'fixed';
      printFrame.style.right = '0';
      printFrame.style.bottom = '0';
      printFrame.style.width = '0';
      printFrame.style.height = '0';
      printFrame.style.border = '0';
      document.body.appendChild(printFrame);

      const frameDoc = printFrame.contentWindow?.document;
      if (!frameDoc) {
        window.print();
        return;
      }

      // Ambil elemen DOM printable yang sudah ter-render
      const page1El = document.getElementById('receipt-page-1');
      const page2El = document.getElementById('receipt-page-2');

      const page1Html = page1El ? page1El.outerHTML : '';
      const page2Html = (includePage2 && page2El) ? page2El.outerHTML : '';

      frameDoc.open();
      frameDoc.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Cetak Resi TRUEBLUE WMS - ${resolvedOrderId}</title>
          <style>
            @page {
              size: 4in 6in;
              margin: 0;
            }
            * {
              box-sizing: border-box;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            html, body {
              margin: 0 !important;
              padding: 0 !important;
              background: #fff !important;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
            .print-page-wrapper {
              width: 4in !important;
              height: 5.95in !important;
              max-height: 5.95in !important;
              max-width: 4in !important;
              box-sizing: border-box !important;
              margin: 0 !important;
              padding: 0.12in 0.14in !important;
              background: #fff !important;
              color: #000 !important;
              page-break-inside: avoid !important;
              break-inside: avoid !important;
              page-break-after: always !important;
              break-after: page !important;
              display: flex !important;
              flex-direction: column !important;
              justify-content: space-between !important;
              overflow: hidden !important;
            }
            .print-page-wrapper:last-child {
              page-break-after: auto !important;
              break-after: auto !important;
            }
            #receipt-page-1 {
              border: 2px solid #000 !important;
              border-radius: 16px !important;
            }
            .no-print {
              display: none !important;
            }
            svg {
              max-width: 100% !important;
              height: auto !important;
            }
            /* Native layout fallbacks for printable element inside iframe */
            .border-dashed { border-style: dashed !important; }
            .border-black { border-color: #000 !important; }
            .border-2 { border-width: 2px !important; border-style: solid !important; }
            .border-b-2 { border-bottom-width: 2px !important; border-bottom-style: solid !important; border-color: #000 !important; }
            .border-b { border-bottom-width: 1px !important; border-bottom-style: solid !important; border-color: #000 !important; }
            .border { border-width: 1px !important; border-style: solid !important; }
            .border-t { border-top-width: 1px !important; border-top-style: solid !important; border-color: #000 !important; }
            .border-t-2 { border-top-width: 2px !important; border-top-style: solid !important; border-color: #000 !important; }
            .rounded-lg { border-radius: 8px !important; }
            .rounded-xl { border-radius: 12px !important; }
            .rounded-2xl { border-radius: 16px !important; }
            .p-5 { padding: 1.25rem !important; }
            .p-4 { padding: 1rem !important; }
            .p-3 { padding: 0.75rem !important; }
            .p-2 { padding: 0.5rem !important; }
            .px-2 { padding-left: 0.5rem !important; padding-right: 0.5rem !important; }
            .py-1 { padding-top: 0.25rem !important; padding-bottom: 0.25rem !important; }
            .py-2 { padding-top: 0.5rem !important; padding-bottom: 0.5rem !important; }
            .py-2\\.5 { padding-top: 0.625rem !important; padding-bottom: 0.625rem !important; }
            .py-1\\.5 { padding-top: 0.375rem !important; padding-bottom: 0.375rem !important; }
            .text-black { color: #000 !important; }
            .bg-white { background-color: #fff !important; }
            .font-bold { font-weight: 700 !important; }
            .font-extrabold { font-weight: 800 !important; }
            .font-black { font-weight: 900 !important; }
            .font-mono { font-family: monospace, Courier, sans-serif !important; }
            .flex { display: flex !important; }
            .flex-col { flex-direction: column !important; }
            .flex-1 { flex: 1 1 0% !important; }
            .justify-between { justify-content: space-between !important; }
            .justify-start { justify-content: flex-start !important; }
            .items-center { align-items: center !important; }
            .grid { display: grid !important; }
            .grid-cols-\\[85px_22px_1fr\\] { grid-template-columns: 85px 22px 1fr !important; }
            .grid-cols-12 { grid-template-columns: repeat(12, minmax(0, 1fr)) !important; }
            .col-span-1 { grid-column: span 1 / span 1 !important; }
            .col-span-2 { grid-column: span 2 / span 2 !important; }
            .col-span-7 { grid-column: span 7 / span 7 !important; }
            .col-span-8 { grid-column: span 8 / span 8 !important; }
            .col-span-3 { grid-column: span 3 / span 3 !important; }
            .text-center { text-align: center !important; }
            .text-right { text-align: right !important; }
            .text-base { font-size: 15px !important; }
            .text-sm { font-size: 13px !important; }
            .text-xs { font-size: 11px !important; }
            .uppercase { text-transform: uppercase !important; }
            .break-words { word-break: break-word !important; overflow-wrap: break-word !important; }
            .break-all { word-break: break-all !important; }
          </style>
        </head>
        <body>
          ${page1Html}
          ${page2Html}
        </body>
        </html>
      `);
      frameDoc.close();

      setTimeout(() => {
        printFrame.contentWindow?.focus();
        printFrame.contentWindow?.print();
        setTimeout(() => {
          printFrame.remove();
        }, 2000);
      }, 400);

    } catch (e) {
      console.warn('Fallback standard window.print due to:', e);
      window.print();
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-[#11141B] border border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-150 flex flex-col my-4 max-h-[95vh]">
        
        {/* Modal Header */}
        <div className="bg-[#151922] px-5 py-3.5 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shadow-md">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-white text-sm uppercase tracking-wider flex items-center gap-2 flex-wrap">
                <span>Cetak Label Resi TRUEBLUE WMS</span>
                {autoCloseSeconds !== null && (
                  <span className="text-[10px] bg-rose-500/15 text-rose-300 border border-rose-500/25 px-2 py-0.5 rounded-full font-bold animate-pulse">
                    Auto-tutup dalam {autoCloseSeconds}s
                  </span>
                )}
                <span className="text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 px-2 py-0.5 rounded-full font-bold">
                  Ukuran 4x6
                </span>
                <span className="text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/25 px-2 py-0.5 rounded-full font-bold">
                  {includePage2 ? '2 Lembar' : '1 Lembar'}
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">
                {autoCloseSeconds !== null 
                  ? 'Resi telah otomatis dicetak. Modal akan tertutup otomatis.' 
                  : 'Lembar 1: Label Alamat • Lembar 2: Packing Slip'}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-slate-800 cursor-pointer"
            title="Tutup dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Control & Tabs Bar */}
        <div className="bg-[#0E121A] px-5 py-2.5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0" onClick={handleUserInteraction}>
          {/* Preview View Switcher */}
          <div className="flex items-center gap-1.5 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => setActivePreviewTab('both')}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                activePreviewTab === 'both'
                  ? 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Semua (Lembar 1 & 2)</span>
            </button>
            <button
              type="button"
              onClick={() => setActivePreviewTab('page1')}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                activePreviewTab === 'page1'
                  ? 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <span>Lembar 1 (Resi)</span>
            </button>
            <button
              type="button"
              onClick={() => setActivePreviewTab('page2')}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                activePreviewTab === 'page2'
                  ? 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <span>Lembar 2 (Isi Paket)</span>
            </button>
          </div>

          {/* Toggle include Page 2 during printing */}
          <label className="flex items-center gap-2 cursor-pointer select-none text-xs font-bold text-slate-300 bg-slate-900/80 px-3 py-1.5 rounded-xl border border-slate-800 hover:border-slate-700">
            <input
              type="checkbox"
              checked={includePage2}
              onChange={(e) => setIncludePage2(e.target.checked)}
              className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-500 bg-slate-800 border-slate-700"
            />
            <span className="flex items-center gap-1 text-amber-300">
              <Package className="w-3.5 h-3.5 text-amber-400" />
              Sertakan Lembar ke-2 (Deskripsi Isi Paket)
            </span>
          </label>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-6">
          
          {isInIframe && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-xs text-amber-400 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500 mt-0.5" />
              <div className="space-y-0.5">
                <p className="font-extrabold uppercase tracking-wide text-[10px]">Info Printer Thermal Browser:</p>
                <p className="leading-relaxed text-[11px] text-slate-300">
                  Jika dialog cetak terhalang frame editor, silakan klik tombol <strong>"Buka di Tab Baru"</strong> di pojok kanan atas preview.
                </p>
              </div>
            </div>
          )}

          {/* PRINTABLE CONTAINER (Rendered on Screen as Preview & sent to Printer via @media print) */}
          <div id="printable-shipping-label-container" className="space-y-6">
            
            {/* Embedded Print CSS for 4x6 inch paper (100mm x 150mm) with Multi-page Page Breaks */}
            <style dangerouslySetInnerHTML={{__html: `
              @page {
                size: 4in 6in;
                margin: 0;
              }
              @media print {
                html, body {
                  width: 4in !important;
                  margin: 0 !important;
                  padding: 0 !important;
                  background: white !important;
                  -webkit-print-color-adjust: exact !important;
                  print-color-adjust: exact !important;
                }
                body * {
                  visibility: hidden !important;
                }
                #printable-shipping-label-container,
                #printable-shipping-label-container * {
                  visibility: visible !important;
                }
                #printable-shipping-label-container {
                  position: absolute !important;
                  left: 0 !important;
                  top: 0 !important;
                  width: 4in !important;
                  margin: 0 !important;
                  padding: 0 !important;
                }
                .shipping-receipt-page {
                  page-break-after: always !important;
                  break-after: page !important;
                  page-break-inside: avoid !important;
                  break-inside: avoid !important;
                  display: flex !important;
                  flex-direction: column !important;
                  justify-content: space-between !important;
                  box-sizing: border-box !important;
                  margin: 0 !important;
                  padding: 0.12in 0.14in !important;
                  width: 4in !important;
                  height: 5.95in !important;
                  max-height: 5.95in !important;
                  overflow: hidden !important;
                  max-width: 4in !important;
                  box-shadow: none !important;
                  background: white !important;
                  color: black !important;
                }
                #receipt-page-1 {
                  border: 2px solid #000 !important;
                  border-radius: 16px !important;
                }
                #receipt-page-2 {
                  border: 1px solid #cbd5e1 !important;
                  border-radius: 12px !important;
                }
                .shipping-receipt-page:last-child {
                  page-break-after: auto !important;
                  break-after: auto !important;
                }
                .no-print {
                  display: none !important;
                }
              }
            `}} />

            {/* ======================================================== */}
            {/* LEMBAR KE-1: LABEL RESI / ALAMAT PENGIRIMAN (4x6 INCH)   */}
            {/* ======================================================== */}
            <div className={`space-y-2 ${activePreviewTab === 'page2' ? 'hidden print:block' : 'block'}`}>
              <div className="flex items-center justify-between text-xs text-slate-400 px-1 font-mono font-bold no-print">
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                  LEMBAR KE-1: LABEL ALAMAT PENGIRIMAN (4x6)
                </span>
                <span>Ukuran: 4 x 6 Inci</span>
              </div>

              <div id="receipt-page-1" className="shipping-receipt-page print-page-wrapper bg-white text-black rounded-2xl p-3 sm:p-4 shadow-md font-sans text-xs flex flex-col justify-between max-w-[420px] mx-auto border-2 border-black">
                {/* 1. TOP BARCODE OF ORDER ID */}
                <div className="flex flex-col items-center justify-center pt-1 pb-2 border-b border-black">
                  <svg ref={barcodeSvgRef} className="max-w-full h-auto"></svg>
                </div>

                {/* 2. SIX ROWS WITH SOLID SEPARATOR LINES */}
                <div className="flex-1 flex flex-col justify-start text-black pt-1">
                  {/* Row 1: Dear */}
                  <div className="grid grid-cols-[85px_22px_1fr] items-center py-2.5 px-2 border-b border-black">
                    <span className="font-bold text-base text-black">Dear</span>
                    <span className="font-bold text-base text-center text-black">:</span>
                    <span className="font-extrabold text-base text-black break-words">
                      {resolvedCustomer || '-'}
                    </span>
                  </div>

                  {/* Row 2: Order id */}
                  <div className="grid grid-cols-[85px_22px_1fr] items-center py-2.5 px-2 border-b border-black">
                    <span className="font-bold text-base text-black">Order id</span>
                    <span className="font-bold text-base text-center text-black">:</span>
                    <span className="font-extrabold text-base text-black font-mono break-all">
                      {resolvedOrderId}
                    </span>
                  </div>

                  {/* Row 3: Address */}
                  <div className="grid grid-cols-[85px_22px_1fr] items-center py-2.5 px-2 border-b border-black">
                    <span className="font-bold text-base text-black">Address</span>
                    <span className="font-bold text-base text-center text-black">:</span>
                    <span className="font-bold text-base text-black leading-snug break-words whitespace-pre-wrap">
                      {resolvedAddress || '-'}
                    </span>
                  </div>

                  {/* Row 4: Phone */}
                  <div className="grid grid-cols-[85px_22px_1fr] items-center py-2.5 px-2 border-b border-black">
                    <span className="font-bold text-base text-black">Phone</span>
                    <span className="font-bold text-base text-center text-black">:</span>
                    <span className="font-bold text-base text-black font-mono break-words">
                      {resolvedPhone || '-'}
                    </span>
                  </div>

                  {/* Row 5: From */}
                  <div className="grid grid-cols-[85px_22px_1fr] items-center py-2.5 px-2 border-b border-black">
                    <span className="font-bold text-base text-black">From</span>
                    <span className="font-bold text-base text-center text-black">:</span>
                    <span className="font-extrabold text-base text-black break-words leading-tight">
                      {senderReady ? sender.name : 'TEST ORDER'}
                    </span>
                  </div>

                  {/* Row 6: Phone */}
                  <div className="grid grid-cols-[85px_22px_1fr] items-center py-2.5 px-2 border-b border-black">
                    <span className="font-bold text-base text-black">Phone</span>
                    <span className="font-bold text-base text-center text-black">:</span>
                    <span className="font-extrabold text-base text-black font-mono">
                      {senderReady ? (sender.phone || '-') : '085649452864'}
                    </span>
                  </div>
                </div>

                {/* 3. FOOTER SECTION: SOLID DIVIDER LINE & TEXT */}
                <div className="mt-auto pt-4">
                  <div className="border-t-2 border-black pt-2 pb-1 px-1 flex items-center justify-between text-xs sm:text-sm font-bold text-black uppercase">
                    <span className="truncate max-w-[210px]">{senderReady ? sender.name : 'TEST ORDER'}</span>
                    <span className="tracking-wide">HALAMAN 1 DARI {includePage2 ? '2' : '1'}</span>
                  </div>
                </div>
              </div>
              </div>

            {/* ======================================================== */}
            {/* LEMBAR KE-2: DESKRIPSI ISI PAKET (PACKING SLIP 4x6 INCH) */}
            {/* ======================================================== */}
            {includePage2 && (
              <div className={`space-y-2 ${activePreviewTab === 'page1' ? 'hidden print:block' : 'block'}`}>
                <div className="flex items-center justify-between text-xs text-slate-400 px-1 font-mono font-bold no-print">
                  <span className="flex items-center gap-1.5 text-amber-400">
                    <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                    LEMBAR KE-2: DESKRIPSI ISI PAKET / PACKING SLIP (4x6)
                  </span>
                  <span className="text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                    {itemsList.length} SKU • {formatNumber(totalCalculatedQty)} Pcs
                  </span>
                </div>

                <div id="receipt-page-2" className="shipping-receipt-page print-page-wrapper bg-white text-slate-900 rounded-xl p-5 sm:p-6 shadow-md font-sans text-xs space-y-3 max-w-[420px] mx-auto border border-slate-200">
                  
                  {/* Page 2 Header */}
                  <div className="border-b-2 border-black pb-2 flex items-center justify-between">
                    <div>
                      <h4 className="font-black text-sm uppercase tracking-wide text-black">
                        {senderReady ? sender.name : 'Memuat pengirim…'}
                      </h4>
                      <div className="text-[10px] font-extrabold uppercase tracking-wider text-black flex items-center gap-1.5 mt-0.5">
                        <span className="bg-black text-white px-1.5 py-0.2 rounded font-mono text-[9px]">
                          LEMBAR 2
                        </span>
                        <span>DESKRIPSI ISI PAKET (PACKING SLIP)</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[9px] font-mono font-bold block text-neutral-600">
                        {formattedDate}
                      </span>
                      <span className="text-[8px] font-mono text-neutral-500">
                        WMS PACKING VERIFIED
                      </span>
                    </div>
                  </div>

                  {/* Order & Customer Summary Info Box */}
                  <div className="bg-neutral-50 border border-neutral-300 rounded-lg p-2.5 text-[10px] leading-tight space-y-1">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-neutral-500 block text-[9px]">Order ID / No. Resi:</span>
                        <strong className="font-mono text-black text-xs font-black">{resolvedOrderId}</strong>
                      </div>
                      <div>
                        <span className="text-neutral-500 block text-[9px]">Penerima (Customer):</span>
                        <strong className="text-black truncate block">{resolvedCustomer}</strong>
                        <span className="text-neutral-600 font-mono text-[9px]">{resolvedPhone}</span>
                      </div>
                    </div>

                    {order.noPo && (
                      <div className="pt-0.5 border-t border-neutral-200 text-[9px]">
                        <span className="text-neutral-500">No. PO / Ref: </span>
                        <span className="font-mono font-bold text-black">{order.noPo}</span>
                      </div>
                    )}
                  </div>

                  {/* Compact Barcode for Packing Slip */}
                  <div className="flex justify-center py-0.5">
                    <svg ref={barcodeSvgPage2Ref} className="max-w-full h-auto"></svg>
                  </div>

                  {/* TABEL DESKRIPSI ISI PAKET */}
                  <div className="flex-1 flex flex-col justify-between">
                    <div className="border border-black rounded-lg overflow-hidden">
                      <div className="bg-neutral-900 text-white font-extrabold text-[10px] uppercase px-3 py-1.5 grid grid-cols-12 gap-2 tracking-wider">
                        <div className="col-span-1 text-center">No</div>
                        <div className="col-span-8">SKU ID</div>
                        <div className="col-span-3 text-right">Qty</div>
                      </div>

                      <div className="divide-y divide-neutral-200 max-h-[240px] print:max-h-none overflow-y-auto print:overflow-visible">
                        {itemsList.map((item, idx) => (
                          <div 
                            key={`item-${item.id || idx}`} 
                            className={`px-3 py-2 grid grid-cols-12 gap-2 text-xs items-center ${
                              idx % 2 === 1 ? 'bg-neutral-50' : 'bg-white'
                            }`}
                          >
                            <div className="col-span-1 text-center font-mono font-bold text-neutral-500">
                              {idx + 1}
                            </div>
                            <div className="col-span-8 font-mono font-bold text-black text-xs sm:text-sm break-all">
                              {item.skuId}
                            </div>
                            <div className="col-span-3 text-right font-mono font-black text-black text-xs sm:text-sm">
                              {item.qty} <span className="text-[10px] font-normal text-neutral-600">pcs</span>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Total Baris Kuantitas */}
                      <div className="bg-neutral-100 border-t-2 border-black px-2.5 py-1.5 flex items-center justify-between text-[11px] font-bold">
                        <div className="flex items-center gap-1 text-neutral-700">
                          <Boxes className="w-3.5 h-3.5 text-black" />
                          <span>{t('receipt.totalItems')}</span>
                          <span className="font-mono font-normal text-[10px]">({itemsList.length} SKU)</span>
                        </div>
                        <div className="font-mono font-black text-sm text-black">
                          {formatNumber(totalCalculatedQty)} <span className="text-[10px]">Pcs</span>
                        </div>
                      </div>
                    </div>

                    {/* Operator Signatures / Audit Footer */}
                    <div className="mt-2 border-t border-neutral-300 pt-1.5 flex items-center justify-between text-[8px] font-mono text-neutral-600">
                      <div>
                        Input: <strong className="text-black">{order.inputByName || 'Admin'}</strong> • 
                        Picker: <strong className="text-black">{order.pickerName || '-'}</strong> • 
                        Packer: <strong className="text-black">{order.packerName || '-'}</strong>
                      </div>
                      <div>
                        CS: {senderReady ? sender.phone : '—'}
                      </div>
                    </div>

                  </div>

                </div>
              </div>
            )}

            {/* Operator Processing Summary Banner (Screen Only) */}
            <div className="p-3 bg-slate-900/90 rounded-xl border border-slate-800 text-[11px] grid grid-cols-3 gap-2 text-center no-print max-w-[420px] mx-auto">
              <div>
                <span className="text-[10px] text-slate-500 block uppercase font-bold">Input Order</span>
                <span className="text-emerald-400 font-semibold">{order.inputByName || 'Admin'}</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 block uppercase font-bold">Picker</span>
                <span className="text-sky-400 font-semibold">{order.pickerName || 'Picker Staff'}</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 block uppercase font-bold">Packer</span>
                <span className="text-purple-400 font-semibold">{order.packerName || 'Packer Staff'}</span>
              </div>
            </div>

          </div>

        </div>

        {/* Modal Action Buttons */}
        <div className="bg-[#151922] px-5 py-3.5 border-t border-slate-800 flex flex-col sm:flex-row gap-2.5 shrink-0">
          <button
            disabled={!senderReady}
            onClick={handlePrint}
            className="flex-1 py-2.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 text-xs font-black rounded-xl tracking-wider uppercase transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/15"
          >
            <Printer className="w-4 h-4" />
            <span>
              {includePage2 ? t('receipt.printTwoPages') : t('receipt.printOnePage')}
            </span>
          </button>

          <button
            disabled={!senderReady}
            onClick={handleCopyReceipt}
            className={`px-3.5 py-2.5 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 border ${
              copiedReceipt 
                ? 'bg-emerald-500/15 border-emerald-500 text-emerald-400' 
                : 'bg-[#1a202c] border-slate-800 text-slate-350 hover:text-white hover:bg-slate-800'
            }`}
          >
            <ClipboardList className="w-4 h-4" />
            {copiedReceipt ? t('receipt.copied') : t('receipt.copyText')}
          </button>

          <button
            disabled={!senderReady}
            onClick={handleDownloadReceipt}
            className="px-3.5 py-2.5 text-xs font-bold rounded-xl bg-[#1a202c] border border-slate-800 text-slate-350 hover:text-white hover:bg-slate-800 transition-all cursor-pointer flex items-center justify-center gap-1.5"
            title="Unduh resi sebagai file .txt"
          >
            <FileText className="w-4 h-4 text-emerald-450" />
            {t('receipt.downloadTxt')}
          </button>
          
          <button
            onClick={onClose}
            className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-bold rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-1"
          >
            {t('action.close')}
          </button>
        </div>

      </div>
    </div>
  );
}
