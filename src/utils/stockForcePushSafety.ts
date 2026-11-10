export const STOCK_FORCE_PUSH_MAX_AGE_MS = 30_000;

export interface StockForcePushSnapshot<T extends { id: string; __wms_revision?: number }> {
  branchId: string;
  items: T[];
  revisions: ReadonlyMap<string, number>;
  complete: boolean;
  valid: boolean;
  branchWide: boolean;
  loadedAt: number;
  atomicSnapshotToken?: string;
}

export function getStockForcePushSafetyError<T extends { id: string; __wms_revision?: number }>(
  snapshot: StockForcePushSnapshot<T> | null,
  currentItems: T[],
  currentBranchId: string,
  online: boolean,
  now = Date.now()
): string | null {
  if (!snapshot) return 'Force push dibatalkan: belum ada snapshot stok cloud yang tervalidasi.';
  if (snapshot.branchId !== currentBranchId) return 'Force push dibatalkan: cabang snapshot berbeda dengan cabang aktif.';
  if (!snapshot.branchWide) return 'Force push dibatalkan: snapshot tidak mencakup seluruh cabang.';
  if (!snapshot.complete) return 'Force push dibatalkan: pembacaan stok belum lengkap.';
  if (!snapshot.valid) return 'Force push dibatalkan: snapshot stok tidak lolos validasi.';
  if (!online) return 'Force push dibatalkan: koneksi database tidak aktif.';
  if (snapshot.items !== currentItems) return 'Force push dibatalkan: data stok berubah sejak snapshot tervalidasi.';
  if (!Number.isFinite(snapshot.loadedAt) || now < snapshot.loadedAt || now - snapshot.loadedAt > STOCK_FORCE_PUSH_MAX_AGE_MS) {
    return 'Force push dibatalkan: snapshot stok sudah tidak terbaru.';
  }
  if (!snapshot.atomicSnapshotToken) {
    return 'Force push dinonaktifkan: server belum menyediakan bukti snapshot atomik seluruh cabang.';
  }

  const seen = new Set<string>();
  for (const item of snapshot.items) {
    if (!item.id || seen.has(item.id)) return 'Force push dibatalkan: identitas stok kosong atau duplikat.';
    seen.add(item.id);
    if (!Number.isSafeInteger(item.__wms_revision) || (item.__wms_revision ?? -1) < 0
      || snapshot.revisions.get(item.id) !== item.__wms_revision) {
      return `Force push dibatalkan: revision snapshot tidak diketahui untuk dokumen ${item.id}.`;
    }
  }

  for (const [id, revision] of snapshot.revisions) {
    if (!id || !Number.isSafeInteger(revision) || revision < 0) {
      return 'Force push dibatalkan: metadata revision snapshot tidak valid.';
    }
  }

  return null;
}

export async function runStockForcePushIfSafe<T extends { id: string; __wms_revision?: number }>(
  snapshot: StockForcePushSnapshot<T> | null,
  currentItems: T[],
  currentBranchId: string,
  online: boolean,
  write: () => Promise<void>,
  now = Date.now()
): Promise<void> {
  const error = getStockForcePushSafetyError(snapshot, currentItems, currentBranchId, online, now);
  if (error) throw new Error(error);
  await write();
}
