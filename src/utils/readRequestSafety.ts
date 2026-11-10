export class StaleReadError extends Error {
  constructor(message = 'Pembacaan dibatalkan karena ada permintaan yang lebih baru atau cabang berubah.') {
    super(message);
    this.name = 'StaleReadError';
  }
}

export class ReadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Pembacaan data melewati batas waktu ${timeoutMs} ms.`);
    this.name = 'ReadTimeoutError';
  }
}

export interface ReadRequest {
  signal: AbortSignal;
  isCurrent: () => boolean;
  cancel: () => void;
}

export function createLatestReadCoordinator() {
  let latestRequestId = 0;
  let latestController: AbortController | undefined;

  const invalidate = () => {
    latestRequestId += 1;
    latestController?.abort(new StaleReadError());
    latestController = undefined;
  };

  return {
    begin(isContextCurrent: () => boolean = () => true): ReadRequest {
      latestController?.abort(new StaleReadError());
      const requestId = ++latestRequestId;
      const controller = new AbortController();
      latestController = controller;
      return {
        signal: controller.signal,
        isCurrent: () => requestId === latestRequestId && !controller.signal.aborted && isContextCurrent(),
        cancel: () => {
          if (requestId === latestRequestId) invalidate();
          else controller.abort(new StaleReadError());
        }
      };
    },
    invalidate
  };
}

export async function runReadRequest<T>(
  work: (signal: AbortSignal) => Promise<T>,
  isCurrent: () => boolean,
  signals: AbortSignal[] = [],
  timeoutMs = 30_000
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const relayAbort = (signal: AbortSignal) => {
    const reason = signal.reason instanceof Error ? signal.reason : new StaleReadError();
    controller.abort(reason);
    rejectAbort(reason);
  };
  const externalAbortHandlers = signals.map(signal => {
    const handler = () => relayAbort(signal);
    if (signal.aborted) handler();
    else signal.addEventListener('abort', handler, { once: true });
    return { signal, handler };
  });

  const timer = setTimeout(() => {
    const error = new ReadTimeoutError(timeoutMs);
    controller.abort(error);
    rejectAbort(error);
  }, timeoutMs);

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      aborted
    ]);
    if (!isCurrent()) throw new StaleReadError();
    return result;
  } finally {
    clearTimeout(timer);
    externalAbortHandlers.forEach(({ signal, handler }) => signal.removeEventListener('abort', handler));
  }
}

export interface RevisionRow {
  document_id: string;
  revision: number;
}

export function applyRevisionSnapshot(
  versions: Map<string, number>,
  branchId: string,
  collectionName: string,
  rows: RevisionRow[],
  isCurrent: () => boolean,
  activeBranchId: string
): void {
  const stagedRows = rows.map(row => {
    if (!row.document_id || !Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new Error('Identitas dokumen atau revision hasil pembacaan tidak valid.');
    }
    return {
      key: JSON.stringify([branchId, collectionName, row.document_id]),
      revision: row.revision
    };
  });

  if (!isCurrent() || branchId !== activeBranchId) throw new StaleReadError();

  const keysToDelete: string[] = [];
  for (const key of versions.keys()) {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && parsed[0] === branchId && parsed[1] === collectionName) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach(key => versions.delete(key));
  stagedRows.forEach(row => versions.set(row.key, row.revision));
}

export function publishSnapshotWithRevisions(
  versions: Map<string, number>,
  branchId: string,
  collectionName: string,
  rows: RevisionRow[],
  isCurrent: () => boolean,
  activeBranchId: string,
  publish: () => void,
  afterPublish?: () => void
): void {
  const previous = new Map<string, number>();
  for (const [key, revision] of versions) {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && parsed[0] === branchId && parsed[1] === collectionName) {
      previous.set(key, revision);
    }
  }

  applyRevisionSnapshot(versions, branchId, collectionName, rows, isCurrent, activeBranchId);
  try {
    publish();
    if (!isCurrent() || branchId !== activeBranchId) throw new StaleReadError();
    afterPublish?.();
    if (!isCurrent() || branchId !== activeBranchId) throw new StaleReadError();
  } catch (error) {
    for (const key of Array.from(versions.keys())) {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && parsed[0] === branchId && parsed[1] === collectionName) {
        versions.delete(key);
      }
    }
    previous.forEach((revision, key) => versions.set(key, revision));
    throw error;
  }
}
