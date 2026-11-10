import React, { useState, useEffect, useRef } from 'react';
import { X, Camera, Keyboard, Volume2, VolumeX, Barcode, MapPin, RotateCw, Sparkles, CheckCircle2 } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { StockItem } from '../types';
import { getBarcodeForSku } from '../data/barcodeMap';

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (scannedValue: string) => void;
  stock: StockItem[];
  title?: string;
}

export default function BarcodeScannerModal({
  isOpen,
  onClose,
  onScanSuccess,
  stock,
  title = "Pindai Barcode / Lokasi"
}: BarcodeScannerModalProps) {
  const [activeTab, setActiveTab] = useState<'camera' | 'simulate'>('camera');
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  
  // Simulated search list inside modal
  const [simulateSearch, setSimulateSearch] = useState('');

  const html5QrcodeRef = useRef<Html5Qrcode | null>(null);
  const isTransitioningRef = useRef(false);
  const stopTimeoutRef = useRef<any>(null);
  const startTimeoutRef = useRef<any>(null);
  const scannerId = "reader-element-canvas";

  // Web Audio success beep
  const playBeep = () => {
    if (isMuted) return;
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(1000, audioCtx.currentTime); // high crisp beep
      gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
      
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
      console.warn("Web Audio not supported or blocked", e);
    }
  };

  // Unique list of products & locations for quick selection / simulation
  const simulatorItems = React.useMemo(() => {
    const items: { type: 'PRODUCT' | 'LOCATION'; label: string; value: string; details: string }[] = [];
    
    // Extract unique locations
    const locations = Array.from(new Set(stock.map(s => s.location))).filter(Boolean).sort();
    locations.forEach(loc => {
      items.push({
        type: 'LOCATION',
        label: `Lokasi: ${loc}`,
        value: loc,
        details: 'Nomor Rak Penyimpanan WMS'
      });
    });

    // Extract unique SKUs
    const skuMap = new Map<string, string>();
    stock.forEach(s => {
      skuMap.set(s.skuId, s.skuName);
    });

    Array.from(skuMap.entries()).forEach(([skuId, name]) => {
      const barcode = getBarcodeForSku(skuId);
      items.push({
        type: 'PRODUCT',
        label: `${skuId} - ${name}`,
        value: skuId,
        details: barcode && barcode !== '-' ? `Barcode: ${barcode}` : 'Hanya SKU ID'
      });
      
      if (barcode && barcode !== '-') {
        items.push({
          type: 'PRODUCT',
          label: `Barcode: ${barcode} (${skuId})`,
          value: barcode,
          details: `Nama: ${name}`
        });
      }
    });

    return items;
  }, [stock]);

  // Filtered list for simulation
  const filteredSimulatorItems = React.useMemo(() => {
    const q = simulateSearch.toLowerCase().trim();
    if (!q) return simulatorItems.slice(0, 15); // Show first 15 by default
    return simulatorItems.filter(item => 
      item.label.toLowerCase().includes(q) || 
      item.value.toLowerCase().includes(q) ||
      item.details.toLowerCase().includes(q)
    );
  }, [simulatorItems, simulateSearch]);

  // Handle successful scan
  const handleSuccess = (decodedText: string) => {
    playBeep();
    onScanSuccess(decodedText.trim());
    onClose();
  };

  // Start Html5Qrcode camera scanning
  const startScanner = async () => {
    if (startTimeoutRef.current) {
      clearTimeout(startTimeoutRef.current);
      startTimeoutRef.current = null;
    }

    if (isTransitioningRef.current) {
      startTimeoutRef.current = setTimeout(() => {
        startScanner();
      }, 150);
      return;
    }

    try {
      setScannerError(null);
      isTransitioningRef.current = true;
      
      if (html5QrcodeRef.current) {
        if (html5QrcodeRef.current.isScanning) {
          try {
            await html5QrcodeRef.current.stop();
          } catch (e) {}
        }
        try {
          html5QrcodeRef.current.clear();
        } catch (e) {}
        html5QrcodeRef.current = null;
      }

      const container = document.getElementById(scannerId);
      if (!container) {
        isTransitioningRef.current = false;
        return;
      }

      const html5Qrcode = new Html5Qrcode(scannerId);
      html5QrcodeRef.current = html5Qrcode;

      setIsScanning(true);
      await html5Qrcode.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: (width, height) => {
            const minSize = Math.min(width, height);
            const boxSize = Math.floor(minSize * 0.7);
            return {
              width: boxSize,
              height: Math.floor(boxSize * 0.5) // landscape rectangle is great for barcodes
            };
          }
        },
        (decodedText) => {
          handleSuccess(decodedText);
        },
        () => {
          // Silent failure for framing matches
        }
      );
    } catch (err: any) {
      console.error("Camera scan start error:", err);
      setScannerError(
        err.message || 
        "Kamera tidak dapat diakses. Mohon beri izin akses kamera atau gunakan tab 'Simulasi'."
      );
      setIsScanning(false);
    } finally {
      isTransitioningRef.current = false;
    }
  };

  const stopScanner = async () => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }

    if (isTransitioningRef.current) {
      stopTimeoutRef.current = setTimeout(() => {
        stopScanner();
      }, 150);
      return;
    }

    if (html5QrcodeRef.current) {
      if (html5QrcodeRef.current.isScanning) {
        isTransitioningRef.current = true;
        try {
          await html5QrcodeRef.current.stop();
        } catch (e) {
          console.warn("Error stopping scanner:", e);
        } finally {
          isTransitioningRef.current = false;
        }
      }
      try {
        html5QrcodeRef.current.clear();
      } catch (e) {}
      html5QrcodeRef.current = null;
    }
    setIsScanning(false);
  };

  // Trigger camera start when on camera tab
  useEffect(() => {
    if (isOpen && activeTab === 'camera') {
      const timer = setTimeout(() => {
        startScanner();
      }, 300);
      return () => {
        clearTimeout(timer);
        stopScanner();
      };
    } else {
      stopScanner();
    }
  }, [isOpen, activeTab]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
      if (startTimeoutRef.current) clearTimeout(startTimeoutRef.current);
      
      if (html5QrcodeRef.current) {
        if (html5QrcodeRef.current.isScanning) {
          html5QrcodeRef.current.stop().catch(() => {});
        }
      }
    };
  }, []);

  return (
    <div className={`fixed inset-0 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in ${isOpen ? "" : "hidden"}`}>
      <div className="bg-[#11141B] rounded-2xl max-w-lg w-full flex flex-col shadow-2xl border border-slate-800 overflow-hidden">
        
        {/* Header */}
        <div className="px-5 py-4 bg-slate-950/40 border-b border-slate-800/60 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <span className="p-1.5 bg-emerald-500/10 border border-emerald-500/25 rounded-lg text-emerald-400">
              <Barcode className="w-4 h-4 animate-pulse" />
            </span>
            <h3 className="font-bold text-white text-sm tracking-tight">{title}</h3>
          </div>
          <div className="flex items-center gap-1">
            {/* Audio Toggle */}
            <button
              onClick={() => setIsMuted(!isMuted)}
              className="p-1.5 hover:bg-slate-800/80 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
              title={isMuted ? "Aktifkan beep suara" : "Senyapkan beep suara"}
            >
              {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
            </button>
            {/* Close */}
            <button 
              onClick={onClose}
              className="p-1.5 hover:bg-slate-800/80 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Custom Tab Selector */}
        <div className="flex border-b border-slate-850 bg-slate-950/20 p-1">
          <button
            onClick={() => setActiveTab('camera')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              activeTab === 'camera' 
                ? 'bg-emerald-500 text-slate-950 font-black' 
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Camera className="w-3.5 h-3.5" />
            Kamera HP / Perangkat
          </button>
          <button
            onClick={() => setActiveTab('simulate')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              activeTab === 'simulate' 
                ? 'bg-emerald-500 text-slate-950 font-black' 
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Keyboard className="w-3.5 h-3.5" />
            Simulasi Klik (Cepat)
          </button>
        </div>

        {/* Modal Content Body */}
        <div className="p-5 flex-1 flex flex-col min-h-[300px] max-h-[450px] bg-[#0E1117] overflow-y-auto">
          
          {activeTab === 'camera' ? (
            <div className="flex-1 flex flex-col justify-center items-center space-y-4">
              
              {/* Scanner Video Area */}
              <div className="relative w-full aspect-square max-w-[280px] bg-slate-950 rounded-xl overflow-hidden border border-slate-800/80 flex items-center justify-center">
                
                {/* Simulated scanning alignment guide line */}
                {isScanning && (
                  <div className="absolute left-0 right-0 h-0.5 bg-rose-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-bounce z-10 top-1/2" />
                )}

                {/* Laser Corner Brackets */}
                <div className="absolute top-4 left-4 w-5 h-5 border-t-2 border-l-2 border-emerald-400 z-10" />
                <div className="absolute top-4 right-4 w-5 h-5 border-t-2 border-r-2 border-emerald-400 z-10" />
                <div className="absolute bottom-4 left-4 w-5 h-5 border-b-2 border-l-2 border-emerald-400 z-10" />
                <div className="absolute bottom-4 right-4 w-5 h-5 border-b-2 border-r-2 border-emerald-400 z-10" />

                {/* Html5Qrcode video target */}
                <div id={scannerId} className="w-full h-full [&>video]:object-cover" />

                {/* Loading state / Placeholder when no access */}
                {!isScanning && !scannerError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0E1117] text-slate-500 text-xs gap-2">
                    <RotateCw className="w-6 h-6 animate-spin text-emerald-400" />
                    <span>Mengaktifkan kamera...</span>
                  </div>
                )}
              </div>

              {/* Status & Error */}
              {scannerError ? (
                <div className="bg-rose-950/35 border border-rose-500/20 text-rose-350 p-4 rounded-xl text-center max-w-sm">
                  <p className="text-xs font-bold leading-normal">{scannerError}</p>
                  <button
                    onClick={startScanner}
                    className="mt-3 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-[10px] uppercase tracking-wider rounded-lg border border-slate-700 transition-all cursor-pointer"
                  >
                    Coba Hubungkan Kembali
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-slate-450 text-center max-w-xs leading-relaxed font-medium">
                  Arahkan kamera perangkat Anda ke Barcode Produk (EAN-13, SKU) atau label lokasi rak untuk langsung menyaring daftar pencarian.
                </p>
              )}

            </div>
          ) : (
            // Simulation panel
            <div className="flex flex-col flex-1 space-y-3">
              {/* Search bar inside simulation list */}
              <div className="relative">
                <input
                  type="text"
                  placeholder="Ketik SKU, Barcode, atau Lokasi..."
                  value={simulateSearch}
                  onChange={(e) => setSimulateSearch(e.target.value)}
                  className="w-full px-3.5 py-2 text-xs bg-[#161B25] border border-slate-800 rounded-xl text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              {/* Suggestions / simulation items list */}
              <div className="flex-1 overflow-y-auto max-h-[300px] space-y-2 pr-1">
                {filteredSimulatorItems.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 text-xs italic bg-[#161B25] rounded-xl border border-slate-800/40">
                    Tidak ada hasil simulasi yang cocok.
                  </div>
                ) : (
                  filteredSimulatorItems.map((item, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => handleSuccess(item.value)}
                      className="w-full flex items-center justify-between p-3 bg-[#151922] hover:bg-[#1C222F] border border-slate-800/45 hover:border-emerald-500/30 rounded-xl transition-all text-left cursor-pointer group"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`p-1.5 rounded-lg border ${
                          item.type === 'LOCATION' 
                            ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-400' 
                            : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                        }`}>
                          {item.type === 'LOCATION' ? <MapPin className="w-3.5 h-3.5" /> : <Barcode className="w-3.5 h-3.5" />}
                        </span>
                        <div>
                          <p className="text-xs font-bold text-white group-hover:text-emerald-400 transition-colors font-mono">{item.value}</p>
                          <p className="text-[10px] text-slate-500 leading-none mt-0.5">{item.label}</p>
                        </div>
                      </div>
                      <span className="text-[10px] text-slate-500 font-bold group-hover:text-emerald-400 transition-colors">
                        Simulasikan ➜
                      </span>
                    </button>
                  ))
                )}
              </div>
              <p className="text-[10px] text-slate-550 italic text-center">
                *Saran: Tab di atas memudahkan pengujian fitur scan tanpa perlu kamera fisik.
              </p>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-slate-950/40 border-t border-slate-850 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition-all cursor-pointer"
          >
            Tutup
          </button>
        </div>

      </div>
    </div>
  );
}
