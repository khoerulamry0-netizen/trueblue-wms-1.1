import { localScopeKey } from '../utils/localScope';
import React, { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import { 
  Bot, 
  Send, 
  Trash2, 
  Sparkles, 
  RefreshCw, 
  Copy, 
  Check, 
  Cpu, 
  Zap, 
  ShieldCheck, 
  AlertCircle, 
  HelpCircle, 
  Package, 
  Layers, 
  Database,
  Sliders,
  ChevronDown,
  User,
  Clock
} from 'lucide-react';
import { StockItem, OutboundItem, UserAccount } from '../types';
import { supabase } from '../supabase';
import { getStockStatus } from '../utils/calculations';
import { getAssistantStockDetails } from '../utils/assistantStockContext';
import { assistantApiUrl, assistantConnectionError } from '../utils/assistantConnection';

const assistantServerOrigin = import.meta.env.DEV ? undefined : import.meta.env.VITE_ASSISTANT_API_URL;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  model?: string;
  isError?: boolean;
}

interface AiChatbotProps {
  stock: StockItem[];
  orderHistory?: OutboundItem[];
  currentUser: UserAccount | null;
  onNavigateTab?: (tab: string) => void;
}

interface BotRoleConfig {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemInstruction: string;
  recommendedModel: 'gemini-3.5-flash' | 'gemini-3.1-flash-lite' | 'gemini-3.1-pro-preview';
}

const BOT_ROLES: BotRoleConfig[] = [
  {
    id: 'warehouse_specialist',
    name: 'Spesialis Gudang & DCC',
    icon: '🏢',
    description: 'Bantuan operasional harian, cek lokasi rak, mutasi, alur picking & packing',
    recommendedModel: 'gemini-3.5-flash',
    systemInstruction: 
      'Anda adalah Spesialis Operasional Gudang & DCC (Daily Cycle Count) di TRUEBLUE WMS. ' +
      'Keahlian Anda meliputi alur kerja picking barang, validasi packing barcode, penataan barang di rak gudang, transfer mutasi internal/eksternal, serta audit fisik stok. ' +
      'Jawab dengan ramah, lugas, dan terstruktur dalam Bahasa Indonesia. Gunakan poin-poin tebal jika memberikan instruksi langkah demi langkah.'
  },
  {
    id: 'fefo_analyst',
    name: 'Analis Stok & FEFO',
    icon: '📊',
    description: 'Analisis umur simpan barang, status kadaluarsa (Under 3M/6M), dan perputaran stok',
    recommendedModel: 'gemini-3.1-pro-preview',
    systemInstruction: 
      'Anda adalah Analis Senior Inventaris & Prinsip FEFO (First Expired, First Out) pergudangan retail. ' +
      'Tugas Anda adalah memantau status expired date (AMAN, Under 24M, Under 18M, Under 6M, Under 3M, dan Expired/Damage), memberikan peringatan resiko kerugian dead stock, dan merekomendasikan SKU mana yang harus diprioritaskan keluar terlebih dahulu. ' +
      'Berikan wawasan analitis, kalkulasi persentase stok, dan saran tindakan mitigasi konkret.'
  },
  {
    id: 'fast_lookup',
    name: 'Operator Cepat (Fast Lookup)',
    icon: '⚡',
    description: 'Jawaban super ringkas dan instan untuk pengecekan cepat di lantai gudang',
    recommendedModel: 'gemini-3.1-flash-lite',
    systemInstruction: 
      'Anda adalah Asisten Cepat Lantai Gudang untuk operator. ' +
      'Jawab dengan sangat ringkas, padat, dan langsung to-the-point (maksimal 2-4 kalimat atau tabel mini). ' +
      'Fokus langsung pada SKU, Jumlah Pcs, dan Lokasi Rak tanpa basa-basi pengantar.'
  },
  {
    id: 'sop_advisor',
    name: 'Konsultan SOP & Regulasi',
    icon: '🛡️',
    description: 'Panduan standar operasional WMS dan penyimpanan barang',
    recommendedModel: 'gemini-3.5-flash',
    systemInstruction: 
      'Anda adalah konsultan SOP dan manajemen gudang. ' +
      'Anda membantu menjelaskan alur penerimaan, penyimpanan, zonasi barang rusak atau karantina, kebersihan rak, pelacakan batch, dan audit pergudangan. Sesuaikan saran dengan jenis barang dan prosedur perusahaan. ' +
      'Bantu staf gudang memahami standar operasional yang benar.'
  }
];

const SUGGESTED_PROMPTS = [
  'Cek produk yang mendekati expired (FEFO)',
  'Berapa total stok dan jumlah SKU di gudang saat ini?',
  'Bagaimana alur kerja picking order yang benar?',
  'Rangkum stok kritis (Under 3 Bulan & Karantina)'
];

export default function AiChatbot({
  stock,
  orderHistory = [],
  currentUser,
  onNavigateTab
}: AiChatbotProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem(localScopeKey('dcc_wms_ai_chat_history',currentUser,false));
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('Failed to load chat history', e);
    }
    return [
      {
        id: 'welcome-msg',
        role: 'assistant',
        content: `Halo ${currentUser?.fullName || 'Rekan Tim'}! 👋 Saya adalah **Asisten AI DCC Inventory WMS** siap membantu Anda menganalisis stok, melacak lokasi rak, status kadaluarsa (FEFO), serta panduan picking dan packing.\n\nAda yang bisa saya bantu terkait operasional gudang hari ini?`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        model: 'gemini-3.5-flash'
      }
    ];
  });

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [includeStock, setIncludeStock] = useState(true);
  const [assistantStatus, setAssistantStatus] = useState<'checking'|'configured'|'unconfigured'|'error'>('checking');
  const [statusMessage, setStatusMessage] = useState('Memeriksa konfigurasi AI…');
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const session = await supabase?.auth.getSession();
        const token = session?.data.session?.access_token;
        if (!token) throw new Error('Silakan login ulang ke WMS.');
        const response = await fetch(assistantApiUrl('/api/chat/status', assistantServerOrigin), { headers: { Authorization: 'Bearer '+token }, signal: AbortSignal.timeout(15000) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Konfigurasi AI belum dapat diperiksa.');
        if (active) { setAssistantStatus(data.configured ? 'configured' : 'unconfigured'); setStatusMessage(data.configured ? 'Konfigurasi Gemini tersedia.' : 'Gemini belum diaktifkan. Administrator perlu memasang kunci API pada hosting WMS.'); }
      } catch (error: unknown) { if (active) { setAssistantStatus('error'); setStatusMessage(assistantConnectionError(error, 'Koneksi Asisten terganggu. Coba lagi sebentar.')); } }
    })();
    return () => { active = false; };
  }, [currentUser?.id]);
  const [selectedRole, setSelectedRole] = useState<string>('warehouse_specialist');
  const [selectedModel, setSelectedModel] = useState<'gemini-3.5-flash' | 'gemini-3.1-flash-lite' | 'gemini-3.1-pro-preview'>('gemini-3.5-flash');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-save messages to local storage
  useEffect(() => {
    try {
      localStorage.setItem(localScopeKey('dcc_wms_ai_chat_history',currentUser,false), JSON.stringify(messages));
    } catch (e) {
      console.warn('Failed to save chat history', e);
    }
  }, [messages]);

  // Scroll to bottom when messages update or loading changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const activeRoleConfig = BOT_ROLES.find(r => r.id === selectedRole) || BOT_ROLES[0];

  // Compile real-time warehouse data context
  const generateWarehouseContext = (question: string): string => {
    const totalUnits = stock.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const uniqueSkus = new Set(stock.map(s => s.skuId)).size;

    // Status counts
    const statusCounts: Record<string, number> = {};
    stock.forEach(item => {
      const s = getStockStatus(item);
      statusCounts[s] = (statusCounts[s] || 0) + (Number(item.qty) || 0);
    });

    // Orders summary
    const pendingOrders = orderHistory.filter(o => o.status === 'Pending').length;
    const pendingPicking = orderHistory.filter(o => o.status === 'Pending' && !o.picked).length;

    const sampleItems = getAssistantStockDetails(stock, question);

    return `RINGKASAN GUDANG TERKINI:
- Total Stok: ${totalUnits.toLocaleString('id-ID')} pcs
- Total SKU Unik: ${uniqueSkus} produk
- Status Rincian:
  * AMAN: ${(statusCounts['AMAN'] || 0).toLocaleString('id-ID')} pcs
  * Under 24M: ${(statusCounts['Under 24Month'] || 0).toLocaleString('id-ID')} pcs
  * Under 18M: ${(statusCounts['Under 18 Month'] || 0).toLocaleString('id-ID')} pcs
  * Under 6M: ${(statusCounts['Under 6 Month'] || 0).toLocaleString('id-ID')} pcs
  * Under 3M (Kritis): ${(statusCounts['Under 3 Month'] || 0).toLocaleString('id-ID')} pcs
  * Expired / Damage (Karantina): ${((statusCounts['Damage'] || 0) + (statusCounts['Expired'] || 0) + (statusCounts['Karantina'] || 0)).toLocaleString('id-ID')} pcs
- Order Pending: ${pendingOrders} item (${pendingPicking} perlu picking)
- Detail SKU & Lokasi Rak yang Relevan:
${sampleItems}`;
  };

  const handleSendMessage = async (textToSend?: string) => {
    const messageContent = (textToSend || input).trim();
    if (!messageContent || isLoading) return;
    if (assistantStatus === 'unconfigured') { setStatusMessage('Gemini belum diaktifkan. Minta Administrator memasang GEMINI_API_KEY di hosting WMS.'); return; }

    const userMessage: ChatMessage = {
      id: 'msg-' + Date.now() + '-u',
      role: 'user',
      content: messageContent,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setIsLoading(true);

    try {
      const warehouseContext = includeStock ? generateWarehouseContext(messageContent) : '';

      // Format message history for multi-turn Gemini API
      // Keep up to the last 12 turns to stay within token balance
      const recentHistory = (includeStock ? updatedMessages.filter(m => !m.isError).slice(-12) : [userMessage]).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        content: m.content
      }));

      const sessionResult = await supabase?.auth.getSession();
      const accessToken = sessionResult?.data.session?.access_token;
      if (!accessToken) throw new Error('Silakan login ke WMS terlebih dahulu.');
      const res = await fetch(assistantApiUrl('/api/chat', assistantServerOrigin), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          messages: recentHistory,
          model: selectedModel,
          systemInstruction: activeRoleConfig.systemInstruction,
          warehouseContext
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server error (${res.status})`);
      }

      const data = await res.json();
      const assistantMessage: ChatMessage = {
        id: 'msg-' + Date.now() + '-a',
        role: 'assistant',
        content: data.text || 'Tidak ada respon yang diterima dari model.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        model: data.model || selectedModel
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (err: unknown) {
      console.error('Chat error:', err);
      const errorMessage: ChatMessage = {
        id: 'msg-' + Date.now() + '-err',
        role: 'assistant',
        content: `⚠️ **Gagal memproses permintaan:**\n${assistantConnectionError(err, 'Terjadi gangguan koneksi ke server Gemini API.')}\n\n*Coba lagi setelah koneksi pulih. Jika pesan menyebut kunci API atau kuota, hubungi Administrator.*`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        model: selectedModel,
        isError: true
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  };

  const handleClearHistory = () => {
    if (confirm('Hapus seluruh riwayat percakapan dengan AI?')) {
      const resetMsg: ChatMessage[] = [
        {
          id: 'welcome-reset',
          role: 'assistant',
          content: `Riwayat percakapan telah dibersihkan. Saya siap membantu Anda kembali!`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          model: selectedModel
        }
      ];
      setMessages(resetMsg);
      localStorage.removeItem(localScopeKey('dcc_wms_ai_chat_history',currentUser,false));
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="trueblue-assistant flex flex-col h-[calc(100vh-140px)] max-h-[860px] bg-white border border-slate-800 rounded-2xl shadow-2xl overflow-hidden font-sans">
      
      {/* Top Header Bar */}
      <div className="bg-white border-b border-slate-800/90 px-4 py-3 shrink-0 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500/20 to-cyan-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-md shadow-emerald-500/10">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-wide flex items-center gap-1.5">
                <span>Asisten TRUEBLUE</span>
                <span className="inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <Sparkles className="w-3 h-3" /> Multi-Turn Chat
                </span>
              </h2>
            </div>
            <p className="text-[11px] text-slate-400">
              Asisten kecerdasan buatan pergudangan, FEFO, analisa stok & SOP DCC
            </p>
          </div>
        </div>

        {/* Controls: Role Preset & Model Selector */}
        <div className="trueblue-assistant-controls flex flex-wrap items-center gap-2">
          
          {/* Role Preset Selector */}
          <div className="relative">
            <label className="text-[9px] uppercase font-bold text-slate-400 block mb-0.5">Peran Bot:</label>
            <div className="flex items-center gap-1 bg-white border border-slate-750 rounded-lg px-2.5 py-1 text-xs text-slate-200">
              <span className="text-sm">{activeRoleConfig.icon}</span>
              <select
                value={selectedRole}
                onChange={(e) => {
                  const newRole = e.target.value;
                  setSelectedRole(newRole);
                  const matched = BOT_ROLES.find(r => r.id === newRole);
                  if (matched) {
                    setSelectedModel(matched.recommendedModel);
                  }
                }}
                className="bg-transparent text-xs font-semibold text-slate-200 outline-none cursor-pointer pr-1"
              >
                {BOT_ROLES.map(role => (
                  <option key={role.id} value={role.id} className="bg-white text-slate-200">
                    {role.icon} {role.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Model Selector */}
          <div>
            <label className="text-[9px] uppercase font-bold text-slate-400 block mb-0.5">Model Gemini:</label>
            <div className="flex items-center gap-1.5 bg-white border border-slate-750 rounded-lg px-2.5 py-1 text-xs">
              <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value as any)}
                className="bg-transparent text-xs font-semibold text-slate-200 outline-none cursor-pointer pr-1"
              >
                <option value="gemini-3.5-flash" className="bg-white text-slate-200">
                  gemini-3.5-flash (Tugas Umum)
                </option>
                <option value="gemini-3.1-flash-lite" className="bg-white text-slate-200">
                  gemini-3.1-flash-lite (Respon Cepat)
                </option>
                <option value="gemini-3.1-pro-preview" className="bg-white text-slate-200">
                  gemini-3.1-pro-preview (Kompleks & Analitis)
                </option>
              </select>
            </div>
          </div>

          {/* Clear History Button */}
          <div className="self-end">
            <button
              onClick={handleClearHistory}
              className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg border border-slate-750 transition-colors cursor-pointer flex items-center gap-1 text-xs"
              title="Hapus riwayat percakapan"
            >
              <Trash2 className="w-4 h-4" />
              <span className="hidden md:inline text-[11px] font-medium">Hapus</span>
            </button>
          </div>

        </div>
      </div>

      <div role="status" className="px-4 py-2 border-b text-xs" style={{background: assistantStatus === 'configured' ? '#eff6ff' : '#fff7ed', color:'#334155', borderColor:'#dbe4ef'}}>
        {statusMessage}
      </div>
      <label className="px-4 py-2 flex items-center gap-2 text-xs" style={{color:'#334155'}}>
        <input type="checkbox" checked={includeStock} onChange={e => setIncludeStock(e.target.checked)} />
        Sertakan data stok cabang aktif ke Gemini
      </label>
      {/* Active Role Description & Live Context Info Banner */}
      <div className="trueblue-assistant-context bg-white px-4 py-2 border-b border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-300 flex items-center gap-1">
            <span>{activeRoleConfig.icon}</span>
            <span>{activeRoleConfig.name}:</span>
          </span>
          <span className="truncate max-w-md">{activeRoleConfig.description}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono text-[10px] font-bold">
            <Database className="w-3 h-3" />
            Terhubung {stock.length} Baris Stok ({stock.reduce((a, b) => a + (Number(b.qty) || 0), 0).toLocaleString()} Pcs)
          </span>
        </div>
      </div>

      {/* Messages Scrollable Thread */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 scroll-smooth">
        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          return (
            <div
              key={msg.id}
              className={`flex gap-3 max-w-[88%] sm:max-w-[80%] ${
                isUser ? 'ml-auto flex-row-reverse' : 'mr-auto'
              }`}
            >
              {/* Avatar Icon */}
              <div
                className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                  isUser
                    ? 'bg-blue-600/20 text-blue-400 border-blue-500/30'
                    : msg.isError
                    ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                    : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                }`}
              >
                {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              </div>

              {/* Message Bubble Container */}
              <div
                className={`relative group rounded-2xl px-4 py-3 text-xs sm:text-sm leading-relaxed ${
                  isUser
                    ? 'trueblue-chat-user bg-blue-50 text-slate-800 rounded-tr-none shadow-md shadow-blue-500/10'
                    : msg.isError
                    ? 'bg-rose-950/40 text-rose-200 border border-rose-500/30 rounded-tl-none shadow-sm'
                    : 'bg-white text-slate-200 border border-slate-800 rounded-tl-none shadow-sm'
                }`}
              >
                {/* Header Tag for Assistant (Model Badge & Role) */}
                {!isUser && (
                  <div className="flex items-center justify-between gap-3 mb-1.5 pb-1 border-b border-slate-800/80 text-[10px]">
                    <span className="font-extrabold text-emerald-400 flex items-center gap-1">
                      <Sparkles className="w-2.5 h-2.5" />
                      Gemini AI • {msg.model || selectedModel}
                    </span>
                    <button
                      onClick={() => handleCopy(msg.id, msg.content)}
                      className="text-slate-400 hover:text-white transition-colors p-0.5 rounded cursor-pointer flex items-center gap-1 opacity-60 group-hover:opacity-100"
                      title="Salin teks pesan"
                    >
                      {copiedId === msg.id ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-[9px] text-emerald-400">Tersalin</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span className="text-[9px]">Salin</span>
                        </>
                      )}
                    </button>
                  </div>
                )}

                {/* Message Body with Markdown */}
                <div className="prose prose-xs sm:prose-sm max-w-none break-words space-y-2">
                  <Markdown>{msg.content}</Markdown>
                </div>

                {/* Timestamp */}
                <div
                  className={`mt-1.5 text-[9px] flex items-center justify-end gap-1 ${
                    isUser ? 'text-blue-200/80' : 'text-slate-500'
                  }`}
                >
                  <Clock className="w-2.5 h-2.5" />
                  <span>{msg.timestamp}</span>
                </div>
              </div>
            </div>
          );
        })}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex gap-3 max-w-[80%] mr-auto items-start">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 animate-pulse" />
            </div>
            <div className="bg-white border border-slate-800 rounded-2xl rounded-tl-none px-4 py-3 text-xs text-slate-400 flex items-center gap-2 shadow-sm">
              <RefreshCw className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
              <span>Gemini sedang menganalisis data gudang & merumuskan jawaban...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggested Prompt Chips */}
      <div className="bg-white px-4 py-2 border-t border-slate-800/80 flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        <span className="text-[10px] text-slate-500 uppercase font-bold shrink-0 flex items-center gap-1">
          <HelpCircle className="w-3 h-3 text-slate-400" /> Saran:
        </span>
        {SUGGESTED_PROMPTS.map((prompt, idx) => (
          <button
            key={idx}
            onClick={() => handleSendMessage(prompt)}
            disabled={isLoading}
            className="px-2.5 py-1 bg-slate-800/70 hover:bg-slate-750 border border-slate-700/60 hover:border-emerald-500/40 text-[11px] text-slate-300 hover:text-emerald-300 rounded-lg whitespace-nowrap transition-all cursor-pointer disabled:opacity-50 shrink-0"
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* Input Area */}
      <div className="bg-white p-3 sm:p-4 border-t border-slate-800 shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage();
          }}
          className="flex items-end gap-2"
        >
          <div className="relative flex-1 bg-white border border-slate-750 focus-within:border-emerald-500/80 rounded-xl transition-all shadow-inner">
            <textarea
              ref={textareaRef}
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tanyakan sesuatu mengenai stok, lokasi rak, expired date FEFO, atau SOP gudang... (Enter untuk kirim)"
              disabled={isLoading}
              className="w-full bg-transparent px-3.5 py-2.5 text-xs sm:text-sm text-slate-200 placeholder-slate-500 outline-none resize-none max-h-32"
            />
          </div>

          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="h-11 px-4 bg-emerald-500 hover:bg-emerald-450 disabled:bg-slate-800 text-slate-950 disabled:text-slate-600 font-bold rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-md shadow-emerald-500/10 cursor-pointer disabled:cursor-not-allowed shrink-0"
            title="Kirim pesan (Enter)"
          >
            {isLoading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span className="hidden sm:inline text-xs font-extrabold uppercase tracking-wider">Kirim</span>
              </>
            )}
          </button>
        </form>
      </div>

    </div>
  );
}
