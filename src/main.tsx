import React, { Component, ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleResetAndReload = () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {
      // ignore
    }
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0A0C10] text-slate-100 flex flex-col justify-center items-center p-6 text-center font-sans">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="w-12 h-12 rounded-full bg-rose-500/20 border border-rose-500/30 flex items-center justify-center mx-auto text-rose-400 font-bold text-xl">
              !
            </div>
            <h2 className="text-lg font-black text-white">Terjadi Kendala Memuat Aplikasi</h2>
            <p className="text-xs text-slate-400">
              {this.state.error?.message || 'Terjadi kesalahan sistem saat merender tampilan.'}
            </p>
            <div className="pt-2 flex flex-col gap-2">
              <button
                onClick={this.handleReload}
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all cursor-pointer shadow-lg shadow-blue-600/30"
              >
                Muat Ulang Halaman
              </button>
              <button
                onClick={this.handleResetAndReload}
                className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-all cursor-pointer"
              >
                Reset Cache & Muat Ulang
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
