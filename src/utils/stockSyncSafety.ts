export type StockSyncPhase = 'syncing' | 'synced' | 'failed';

export interface StockSyncState {
  phase: StockSyncPhase;
  stale: boolean;
  message: string;
}

export const initialStockSyncState: StockSyncState = {
  phase: 'syncing',
  stale: true,
  message: 'Memuat data stok dari sumber bersama.'
};

export function stockSyncStarted(current: StockSyncState): StockSyncState {
  return {
    phase: 'syncing',
    stale: current.stale,
    message: current.stale
      ? 'Sinkronisasi stok berlangsung. Data terakhir tetap tersedia, tetapi mungkin tidak terbaru.'
      : 'Sinkronisasi stok berlangsung. Data terakhir tetap tersedia untuk operasional.'
  };
}

export function stockSyncSucceeded(): StockSyncState {
  return {
    phase: 'synced',
    stale: false,
    message: 'Sinkronisasi stok berhasil.'
  };
}

export function stockSyncFailed(error: unknown): StockSyncState {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    phase: 'failed',
    stale: true,
    message: `Sinkronisasi stok gagal; data yang tampil dipertahankan dan mungkin tidak terbaru. ${detail}`
  };
}

export function createLatestRequestSequence() {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (request: number) => request === latest
  };
}
