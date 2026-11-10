export type ScanPhase = 'sorting' | 'packing';

type RpcResult = { data: unknown; error: unknown };
type RpcCall = (name: string, args: Record<string, string>) => PromiseLike<RpcResult>;

export class ScanRpcError extends Error {
  constructor(readonly category: 'not_found' | 'rejected' | 'unknown', message: string) {
    super(message);
  }
}

export interface ScanSession {
  id: string;
  branch: string;
  phase: ScanPhase;
}

export interface ScanProgress {
  session: ScanSession;
  reference: string;
  basket: string;
  state: 'open' | 'finished' | 'cancelled';
  current: boolean;
  finishRequest: string | null;
  counts: Array<{ documentId: string; sku: string; required: number; scanned: number }>;
  events: Array<{ requestId: string; inputCode: string; documentId: string; sku: string }>;
}

export interface VerifiedReceipt {
  branch: string;
  reference: string;
  source: 'packing' | 'direct';
  operationId: string;
  documents: Record<string, unknown>[];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function createServerScanRpc(rpc: RpcCall, activeBranch: () => string) {
  function checkBranch(branch: string) {
    if (!branch || activeBranch() !== branch) throw new Error('Cabang berubah; buka ulang sesi scan.');
  }

  async function call(name: string, args: Record<string, string>, branch: string) {
    checkBranch(branch);
    let response: RpcResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        Promise.resolve(rpc(name, args)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 15000);
        })
      ]);
    } catch {
      throw new ScanRpcError('unknown', 'Server belum mengonfirmasi scan; periksa sesi sebelum mengulang.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response.error) {
      const error = objectValue(response.error);
      if (error?.code === 'P0001' && error.message === 'Sesi scan tidak ditemukan' && name === 'get_order_scan_status') {
        throw new ScanRpcError('not_found', 'Sesi scan belum tersedia.');
      }
      if (error?.code === 'P0001') throw new ScanRpcError('rejected', 'Server menolak permintaan scan.');
      throw new ScanRpcError('unknown', 'Server belum mengonfirmasi scan; periksa sesi sebelum mengulang.');
    }
    checkBranch(branch);
    const data = objectValue(response.data);
    if (!data) throw new Error('Konfirmasi server tidak valid; periksa sesi sebelum mengulang.');
    return data;
  }

  return {
    async start(session: ScanSession, reference: string, basket: string): Promise<void> {
      const data = await call('start_order_scan', {
        p_session: session.id, p_branch: session.branch, p_reference: reference,
        p_phase: session.phase, p_basket: basket
      }, session.branch);
      if (data.session !== session.id || data.state !== 'open') {
        throw new Error('Sesi scan belum dikonfirmasi sebagai aktif.');
      }
    },
    async record(session: ScanSession, requestId: string, code: string): Promise<{ documentId: string; sku: string }> {
      const data = await call('record_order_scan', {
        p_session: session.id, p_request: requestId, p_code: code
      }, session.branch);
      if (typeof data.document_id !== 'string' || !data.document_id ||
          typeof data.sku !== 'string' || !data.sku) {
        throw new Error('Hasil scan server tidak valid; periksa sesi sebelum mengulang.');
      }
      return { documentId: data.document_id, sku: data.sku };
    },
    async finish(session: ScanSession, requestId: string): Promise<void> {
      const data = await call('finish_order_scan', {
        p_session: session.id, p_request: requestId
      }, session.branch);
      if (data.session !== session.id || data.phase !== session.phase || data.state !== 'finished') {
        throw new Error('Penyelesaian server belum terkonfirmasi.');
      }
    },
    async status(branch: string, reference: string, phase: ScanPhase): Promise<ScanProgress> {
      const data = await call('get_order_scan_status', {
        p_branch: branch, p_reference: reference, p_phase: phase
      }, branch);
      const finishRequest = data.finish_request;
      if (data.branch !== branch || data.reference !== reference || data.phase !== phase ||
          typeof data.session !== 'string' || !data.session || typeof data.basket !== 'string' || !data.basket ||
          (data.state !== 'open' && data.state !== 'finished' && data.state !== 'cancelled') ||
          typeof data.current !== 'boolean' || (finishRequest !== null && typeof finishRequest !== 'string') ||
          !Array.isArray(data.counts) || data.counts.length === 0 || !Array.isArray(data.events)) {
        throw new Error('Status scan server tidak valid.');
      }
      const counts: ScanProgress['counts'] = [];
      const events: ScanProgress['events'] = [];
      for (const value of data.counts) {
        const row = objectValue(value);
        if (!row || typeof row.document_id !== 'string' || !row.document_id || typeof row.sku !== 'string' || !row.sku ||
            typeof row.required !== 'number' || !Number.isSafeInteger(row.required) || row.required <= 0 ||
            typeof row.scanned !== 'number' || !Number.isSafeInteger(row.scanned) || row.scanned < 0 || row.scanned > row.required ||
            counts.some(item => item.documentId === row.document_id)) {
          throw new Error('Hitungan scan server tidak valid.');
        }
        counts.push({ documentId: row.document_id, sku: row.sku, required: row.required, scanned: row.scanned });
      }
      for (const value of data.events) {
        const row = objectValue(value);
        if (!row || typeof row.request_id !== 'string' || !row.request_id ||
            typeof row.input_code !== 'string' || !row.input_code ||
            typeof row.document_id !== 'string' || !row.document_id || typeof row.sku !== 'string' || !row.sku) {
          throw new Error('Riwayat scan server tidak valid.');
        }
        const { request_id, input_code, document_id, sku } = row;
        if (events.some(item => item.requestId === request_id) ||
            !counts.some(item => item.documentId === document_id && item.sku.trim().toUpperCase() === sku.trim().toUpperCase())) {
          throw new Error('Riwayat scan server tidak valid.');
        }
        events.push({ requestId: request_id, inputCode: input_code, documentId: document_id, sku });
      }
      if (counts.some(row => events.filter(event => event.documentId === row.documentId).length !== row.scanned) ||
          (data.state === 'finished' && typeof finishRequest !== 'string')) {
        throw new Error('Progres scan server tidak konsisten.');
      }
      return {
        session: { id: data.session, branch, phase }, reference, basket: data.basket,
        state: data.state, current: data.current,
        finishRequest: typeof finishRequest === 'string' ? finishRequest : null, counts, events
      };
    },
    async receipt(branch: string, reference: string): Promise<VerifiedReceipt> {
      const data = await call('get_verified_order_receipt', { p_branch: branch, p_reference: reference }, branch);
      if (data.branch !== branch || data.reference !== reference ||
          (data.source !== 'packing' && data.source !== 'direct') ||
          typeof data.operation_id !== 'string' || !data.operation_id ||
          !Array.isArray(data.documents) || data.documents.length === 0) {
        throw new Error('Bukti resi server tidak valid.');
      }
      const documents: Record<string, unknown>[] = [];
      for (const value of data.documents) {
        const row = objectValue(value);
        if (!row || row.referenceNumber !== reference || row.status !== 'Completed' ||
            typeof row.id !== 'string' || !row.id || typeof row.skuId !== 'string' || !row.skuId ||
            typeof row.qty !== 'number' || !Number.isSafeInteger(row.qty) || row.qty <= 0 ||
            documents.some(item => item.id === row.id)) {
          throw new Error('Data resi server tidak valid.');
        }
        documents.push(row);
      }
      return { branch, reference, source: data.source, operationId: data.operation_id, documents };
    }
  };
}
