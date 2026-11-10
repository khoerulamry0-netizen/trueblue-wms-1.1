import React, { useState } from 'react';
import { Image as ImageIcon, X, RotateCcw, Check, Sparkles, ExternalLink, Boxes } from 'lucide-react';

interface BrandingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentLogoUrl: string;
  currentBrandName: string;
  currentSubBrandName: string;
  onSave: (logoUrl: string, brandName: string, subBrandName: string) => void;
}

export default function BrandingModal({
  isOpen,
  onClose,
  currentLogoUrl,
  currentBrandName,
  currentSubBrandName,
  onSave
}: BrandingModalProps) {
  const [logoUrl, setLogoUrl] = useState(currentLogoUrl);
  const [brandName, setBrandName] = useState(currentBrandName);
  const [subBrandName, setSubBrandName] = useState(currentSubBrandName);
  const [imageError, setImageError] = useState(false);

  if (!isOpen) return null;

  const handleReset = () => {
    setLogoUrl('');
    setBrandName('TRUEBLUE WMS');
    setSubBrandName('SUPERMARKET & DC');
    setImageError(false);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(logoUrl, brandName, subBrandName);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-150 font-sans">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <ImageIcon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Ganti Logo &amp; Branding WMS</h3>
              <p className="text-xs text-slate-400">Ubah URL gambar logo dan nama identitas supermarket</p>
            </div>
          </div>
          <button 
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
            title="Tutup"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              URL Gambar Logo (Direct Link Gambar)
            </label>
            <input 
              type="text"
              value={logoUrl}
              onChange={(e) => {
                setLogoUrl(e.target.value);
                setImageError(false);
              }}
              placeholder="Contoh: https://i.ibb.co/xyz/supermarket-logo.png"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
            />
            <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
              💡 Masukkan tautan langsung file gambar (berformat <strong>.png</strong>, <strong>.svg</strong>, <strong>.jpg</strong>, atau <strong>.webp</strong>). Kosongkan input ini jika ingin kembali menggunakan logo vektor asli TRUEBLUE WMS.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Nama Brand / Perusahaan
              </label>
              <input 
                type="text"
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder="TRUEBLUE WMS"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors uppercase font-bold"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Sub-Judul / Keterangan
              </label>
              <input 
                type="text"
                value={subBrandName}
                onChange={(e) => setSubBrandName(e.target.value)}
                placeholder="RETAIL GROCERY DC"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors uppercase font-semibold text-slate-300"
              />
            </div>
          </div>

          {/* Live Preview Section */}
          <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800/80 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-extrabold tracking-wider text-slate-400 uppercase">
                Pratinjau Langsung (Live Preview)
              </span>
              {logoUrl.trim() && !imageError && (
                <span className="text-[10px] text-emerald-400 font-semibold flex items-center gap-1">
                  <Check className="w-3 h-3" /> URL Aktif
                </span>
              )}
            </div>
            
            <div className="flex items-center gap-3.5 p-3.5 bg-slate-900 rounded-xl border border-slate-800 shadow-inner">
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center p-1.5 overflow-hidden shrink-0">
                {logoUrl.trim() ? (
                  <img src={logoUrl} alt="Logo" className="w-full h-full object-contain" />
                ) : (
                  <Boxes className="w-6 h-6 text-blue-400" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-black text-white uppercase tracking-wider truncate leading-tight">
                  {brandName || 'TRUEBLUE WMS'}
                </h4>
                <p className="text-[10px] text-blue-400 font-bold uppercase tracking-widest mt-0.5 truncate leading-tight">
                  {subBrandName || 'CLOUD SYSTEM WMS'}
                </p>
              </div>
            </div>
          </div>

          {/* Action Footer */}
          <div className="flex items-center justify-between pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={handleReset}
              className="text-xs text-slate-400 hover:text-rose-400 transition-colors flex items-center gap-1.5 px-2.5 py-2 cursor-pointer font-medium"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Bawaan</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-600/30 transition-all cursor-pointer flex items-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                <span>Terapkan Logo</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
