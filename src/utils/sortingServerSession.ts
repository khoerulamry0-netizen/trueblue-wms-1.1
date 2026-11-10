import { ScanRpcError, type ScanPhase, type ScanProgress, type ScanSession, type createServerScanRpc } from './serverScanRpc';

type Api = ReturnType<typeof createServerScanRpc>;
type Pending = { kind: 'scan'; id: string; code: string } | { kind: 'finish'; id: string };
type Saved = { sessionId: string; basket: string; pending: Pending | null };
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LockRunner = <T>(name: string, action: () => Promise<T>) => Promise<T>;

export function createScanServerSession(api: Api, storage: SessionStorage, makeId: () => string,
  branch: string, actor: string, reference: string, phase: ScanPhase, lock: LockRunner = (_name, action) => action()) {
  const key = `wms-${phase}-v1:${JSON.stringify([branch, actor, reference])}`;
  const label = phase === 'sorting' ? 'sortir' : 'packing';
  let busy = false;
  const session = (id: string): ScanSession => ({ id, branch, phase });

  function read(): Saved | null {
    const raw = storage.getItem(key);
    if (!raw) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('Data pemulihan sesi rusak; jangan mengulang scan.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Data pemulihan sesi tidak valid.');
    const data = value as Record<string, unknown>;
    if (typeof data.sessionId !== 'string' || !data.sessionId || typeof data.basket !== 'string' || !data.basket) {
      throw new Error('Data pemulihan sesi tidak valid.');
    }
    const pending = data.pending;
    if (pending !== null && (!pending || typeof pending !== 'object' || Array.isArray(pending))) throw new Error('Request pending tidak valid.');
    if (pending !== null) {
      const p = pending as Record<string, unknown>;
      if (typeof p.id !== 'string' || !p.id || (p.kind !== 'scan' && p.kind !== 'finish') ||
          (p.kind === 'scan' && (typeof p.code !== 'string' || !p.code))) throw new Error('Request pending tidak valid.');
    }
    return data as Saved;
  }
  function save(value: Saved) { storage.setItem(key, JSON.stringify(value)); }
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) throw new Error(`Operasi ${label} masih berjalan.`);
    busy = true;
    try { return await lock(key, fn); } finally { busy = false; }
  }
  async function status(): Promise<ScanProgress> {
    return api.status(branch, reference, phase);
  }

  function verify(progress: ScanProgress, saved: Saved) {
    if (progress.session.id !== saved.sessionId || progress.basket !== saved.basket) {
      throw new Error('Sesi server tidak cocok dengan sesi tersimpan. Periksa sebelum melanjutkan.');
    }
    if (!progress.current && progress.state === 'open') throw new Error(`Order berubah; sesi ${label} tidak dapat dilanjutkan.`);
  }
  async function recover(saved: Saved, resolvePending = false): Promise<ScanProgress> {
    const progress = await status();
    verify(progress, saved);
    if (saved.pending?.kind === 'scan') {
      const event = progress.events.find(e => e.requestId === saved.pending?.id);
      if (event) {
        if (event.inputCode !== saved.pending.code) throw new Error('Request scan tidak cocok dengan server.');
        if (resolvePending) save({ ...saved, pending: null });
      }
    } else if (saved.pending?.kind === 'finish' && progress.state === 'finished') {
      if (progress.finishRequest !== saved.pending.id) throw new Error('Penyelesaian server tidak cocok.');
      if (resolvePending) save({ ...saved, pending: null });
    }
    return progress;
  }
  async function open(basket: string): Promise<ScanProgress> {
    let saved = read();
    if (!saved) {
      try {
        const progress = await status();
        if (progress.state === 'cancelled') throw new Error('Sesi sebelumnya dibatalkan; mulai ulang memerlukan pemeriksaan.');
        if (progress.basket !== basket) throw new Error('Keranjang berbeda dari sesi server. Pulihkan tugas sebelumnya.');
        saved = { sessionId: progress.session.id, basket: progress.basket, pending: null };
        save(saved);
        return progress;
      } catch (error) {
        if (!(error instanceof ScanRpcError) || error.category !== 'not_found') throw error;
      }
      saved = { sessionId: makeId(), basket, pending: null };
      save(saved);
    }
    if (saved.basket !== basket) throw new Error('Keranjang berbeda dari sesi tersimpan. Pulihkan tugas sebelumnya.');
    try { return await recover(saved); }
    catch (error) {
      if (!(error instanceof ScanRpcError) || error.category !== 'not_found' || saved.pending) throw error;
      await api.start(session(saved.sessionId), reference, saved.basket);
      return recover(saved);
    }
  }
  async function sendPending(saved: Saved): Promise<ScanProgress> {
    const progress = await recover(saved, true);
    const refreshed = read();
    if (!refreshed?.pending) return progress;
    if (progress.state !== 'open') throw new Error('Sesi tidak aktif; periksa status server.');
    try {
      if (refreshed.pending.kind === 'scan') {
        await api.record(session(refreshed.sessionId), refreshed.pending.id, refreshed.pending.code);
      } else {
        await api.finish(session(refreshed.sessionId), refreshed.pending.id);
      }
    } catch (error) {
      if (error instanceof ScanRpcError && error.category === 'rejected') {
        save({ ...refreshed, pending: null });
        throw error;
      }
      try {
        const after = await recover(refreshed, true);
        if (!read()?.pending) return after;
      } catch { /* The outcome remains unknown until server status can be read. */ }
      throw new Error('Hasil belum diketahui. Pulihkan sesi sebelum scan atau menyelesaikan ulang.');
    }
    return recover(refreshed, true);
  }
  return {
    open: (basket: string) => exclusive(() => open(basket)),
    scan: (basket: string, code: string) => exclusive(async () => {
      if (read()?.pending) throw new Error('Ada request belum terkonfirmasi. Pulihkan sesi terlebih dahulu.');
      const progress = await open(basket);
      const saved = read();
      if (!saved || progress.state !== 'open') throw new Error(`Sesi ${label} tidak aktif.`);
      if (saved.pending) throw new Error('Ada request belum terkonfirmasi. Pulihkan sesi terlebih dahulu.');
      save({ ...saved, pending: { kind: 'scan', id: makeId(), code: code.trim() } });
      return sendPending(read()!);
    }),
    finish: (basket: string) => exclusive(async () => {
      if (read()?.pending) throw new Error('Ada request belum terkonfirmasi. Pulihkan sesi terlebih dahulu.');
      const progress = await open(basket);
      const saved = read();
      if (!saved || saved.pending || progress.state !== 'open') throw new Error('Sesi belum siap diselesaikan.');
      save({ ...saved, pending: { kind: 'finish', id: makeId() } });
      return sendPending(read()!);
    }),
    retry: () => exclusive(async () => {
      const saved = read();
      if (!saved) throw new Error('Sesi tidak ditemukan.');
      if (!saved.pending) return recover(saved);
      return sendPending(saved);
    }),
    hasPending: () => Boolean(read()?.pending)
  };
}

export function createSortingServerSession(api: Api, storage: SessionStorage, makeId: () => string,
  branch: string, actor: string, reference: string, lock?: LockRunner) {
  return createScanServerSession(api, storage, makeId, branch, actor, reference, 'sorting', lock);
}
