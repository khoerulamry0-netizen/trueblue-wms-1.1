import {readAllRows} from './utils/readAllRows';
import {applyRevisionSnapshot, createLatestReadCoordinator, publishSnapshotWithRevisions, runReadRequest, StaleReadError, type ReadRequest} from './utils/readRequestSafety';
import { displayAccountId } from './accountId';
import {isStockItem} from './types';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerScanRpc } from './utils/serverScanRpc';
import { isServerScanEnabled } from './utils/serverScanFeature';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

if (import.meta.env.DEV) {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase belum dikonfigurasi. Isi VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY.');
  }
  if (supabaseAnonKey.startsWith('REPLACE_')) {
    throw new Error('VITE_SUPABASE_ANON_KEY masih berisi placeholder.');
  }

  try {
    new URL(supabaseUrl);
  } catch {
    throw new Error('VITE_SUPABASE_URL tidak valid.');
  }
}

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true
      },
      realtime: { params: { eventsPerSecond: 20 } }
    })
  : null;

// WMS data access layer keeps the existing workflows on one
// Supabase/Postgres source of truth while clients listen for database changes.
export const db = supabase;
export const SERVER_SCAN_ENABLED = isServerScanEnabled(import.meta.env.VITE_SERVER_SCAN_ENABLED);
export const DEV_BASELINE_SORTING = import.meta.env.DEV && import.meta.env.VITE_DEV_BASELINE_SORTING === 'true';
if (DEV_BASELINE_SORTING && SERVER_SCAN_ENABLED) {
  throw new Error('VITE_DEV_BASELINE_SORTING dan VITE_SERVER_SCAN_ENABLED tidak dapat diaktifkan bersamaan.');
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write'
}

let activeBranchId = localStorage.getItem("blues-active-branch") || "CENTER";
const stockReadCoordinator = createLatestReadCoordinator();
export function getActiveBranch() { return activeBranchId; }
export function setActiveBranch(id: string) {
  if (id !== activeBranchId) {
    stockReadCoordinator.invalidate();
    removeRealtimeChannel();
  }
  activeBranchId = id;
  localStorage.setItem("blues-active-branch", id);
  if (refreshers.size) ensureRealtimeChannel();
}

export interface CollectionReference {
  branchId: string;
  collectionName: string;
}

const versions = new Map<string, number>();
const versionKey = (b:string,c:string,id:string) => JSON.stringify([b,c,id]);
let writesBlocked = false;
let pendingWrites = 0;
const blockedCollections = new Map<string, number>();
let snapshotGeneration = 0;
function signalWrites(error?:string) { window.dispatchEvent(new CustomEvent("wms-write-status",{detail:{pending:pendingWrites,error}})); }

function acknowledgeFreshSnapshot(collectionName: string, generation: number) {
  if (!writesBlocked) return;
  const blockedAt = blockedCollections.get(collectionName);
  if (blockedAt === undefined || generation <= blockedAt) return;
  blockedCollections.delete(collectionName);
  if (blockedCollections.size === 0) {
    writesBlocked = false;
    signalWrites();
  }
}

export interface DocumentReference {
  expectedRevision: number | null;
  branchId: string;
  collectionName: string;
  id: string;
}

export interface DocumentSnapshot {
  id: string;
  data: () => Record<string, unknown>;
}

export interface QuerySnapshot {
  docs: DocumentSnapshot[];
  empty: boolean;
  metadata: { fromCache: boolean };
  forEach: (callback: (document: DocumentSnapshot) => void) => void;
}

type SnapshotListener = (snapshot: QuerySnapshot) => void;
type ErrorListener = (error: unknown) => void;
const refreshers = new Map<string, Set<() => void>>();
let realtimeChannel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;
let realtimeBranchId: string | null = null;
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function refreshCollection(name: string) {
  refreshers.get(name)?.forEach(refresh => refresh());
}

function scheduleCollectionRefresh(name: string) {
  const existing = refreshTimers.get(name);
  if (existing) clearTimeout(existing);
  refreshTimers.set(name, setTimeout(() => {
    refreshTimers.delete(name);
    refreshCollection(name);
  }, 100));
}

function removeRealtimeChannel() {
  refreshTimers.forEach(timer => clearTimeout(timer));
  refreshTimers.clear();
  if (supabase && realtimeChannel) void supabase.removeChannel(realtimeChannel);
  realtimeChannel = null;
  realtimeBranchId = null;
}

function requireClient(): SupabaseClient {
  if (!supabase) {
    throw new Error('Supabase belum dikonfigurasi. Isi VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY.');
  }
  return supabase;
}

export const serverScanRpc = createServerScanRpc(
  (name, args) => requireClient().rpc(name, args),
  getActiveBranch
);

export function collection(_database: unknown, name: string): CollectionReference {
  return { collectionName: name, branchId: activeBranchId };
}

export function doc(_database: unknown, source: CollectionReference | string, id: string): DocumentReference {
  const branchId = typeof source === 'string' ? activeBranchId : source.branchId;
  const collectionName = typeof source === 'string' ? source : source.collectionName;
  return { collectionName, id, branchId, expectedRevision: versions.get(versionKey(branchId,collectionName,id)) ?? null };
}

function toSnapshot(rows: Array<{ document_id: string; payload: Record<string, unknown> }>, fromCache = false): QuerySnapshot {
  const docs = rows.map((row) => ({ id: row.document_id, data: () => row.payload }));
  return { docs, empty: docs.length === 0, metadata: { fromCache }, forEach: (callback) => docs.forEach(callback) };
}

async function fetchCollection(
  name: string,
  branchId: string,
  isCurrent: () => boolean,
  signals: AbortSignal[] = []
): Promise<{snapshot: QuerySnapshot; revisions: Array<{document_id: string; revision: number}>}> {
  return runReadRequest(async (signal) => {
    const client = requireClient();
    if (name === 'users') {
      const data = await readAllRows<{id:string;email:string;full_name:string;role:string;is_active:boolean;branch_id:string|null}>(() => client.from('profiles').select('id,email,full_name,role,is_active,branch_id'), 'id', () => branchId === activeBranchId && isCurrent(), 500, signal);
      data.sort((a,b) => a.email.localeCompare(b.email) || a.id.localeCompare(b.id));
      const rows = (data ?? []).map((profile) => ({
        document_id: profile.email,
        payload: {
          id: profile.id,
          username: displayAccountId(profile.email),
          email: profile.email,
          fullName: profile.full_name,
          role: profile.role,
          is_active: profile.is_active,
          branch_id: profile.branch_id
        }
      }));
      if (branchId !== activeBranchId || !isCurrent()) {
        throw new StaleReadError('Cabang berubah saat membaca data. Buka ulang halaman di cabang tujuan.');
      }
      return {snapshot: toSnapshot(rows, rows.length === 0), revisions: []};
    }

    const data = await readAllRows<{document_id:string;payload:Record<string,unknown>;revision:number}>(
      () => client.from('wms_documents').select('document_id,payload,revision').eq('collection_name',name).eq('branch_id',branchId),
      'document_id', () => branchId === activeBranchId && isCurrent(), 500, signal
    );
    if (!Array.isArray(data)) throw new Error('Format daftar dokumen tidak valid.');
    const rows = (data ?? []).map((row) => {
      if (!row.document_id || !Number.isSafeInteger(row.revision) || row.revision < 0) {
        throw new Error('Identitas dokumen atau revision hasil pembacaan tidak valid.');
      }
      if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
        throw new Error(`Payload dokumen ${row.document_id} tidak valid.`);
      }
      if (name === 'stock' && !row.document_id.startsWith('SYSTEM_') && !isStockItem(row.payload)) {
        throw new Error(`Dokumen stok ${row.document_id} tidak valid; batch pembacaan dibatalkan.`);
      }
      return {document_id:row.document_id,payload:{...row.payload,__wms_revision:row.revision,...(name === 'stock' ? {__wms_document_id:row.document_id} : {})} as Record<string,unknown>};
    });
    const revisions = data.map(row => ({document_id: row.document_id, revision: row.revision}));
    if (branchId !== activeBranchId || !isCurrent()) {
      throw new StaleReadError('Cabang berubah saat membaca data. Buka ulang halaman di cabang tujuan.');
    }
    return {snapshot: toSnapshot(rows, rows.length === 0), revisions};
  }, () => branchId === activeBranchId && isCurrent(), signals);
}

function ensureRealtimeChannel() {
  if (!supabase || (realtimeChannel && realtimeBranchId === activeBranchId)) return;
  if (realtimeChannel) removeRealtimeChannel();
  const branchId = activeBranchId;
  realtimeBranchId = branchId;
  realtimeChannel = supabase
    .channel(`wms-live-data-${branchId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_documents', filter: `branch_id=eq.${branchId}` }, (change) => {
      const collectionName = (change.new as { collection_name?: string } | null)?.collection_name
        ?? (change.old as { collection_name?: string } | null)?.collection_name;
      const eventBranchId = (change.new as { branch_id?: string } | null)?.branch_id
        ?? (change.old as { branch_id?: string } | null)?.branch_id;
      if (collectionName && eventBranchId === activeBranchId) scheduleCollectionRefresh(collectionName);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
      scheduleCollectionRefresh('users');
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED' && branchId === activeBranchId) {
        refreshers.forEach((_listeners, collectionName) => scheduleCollectionRefresh(collectionName));
      }
    });
}

export function onSnapshot(
  reference: CollectionReference,
  listener: SnapshotListener,
  errorListener?: ErrorListener,
  appliedListener?: () => void
): () => void {
  const { collectionName, branchId } = reference;
  let active = true, sequence = 0;
  const localCoordinator = createLatestReadCoordinator();
  let stockRequest: ReadRequest | undefined;
  const refresh = () => {
    const request = ++sequence;
    const isContextCurrent = () => active && request === sequence && branchId === activeBranchId;
    const localRequest = localCoordinator.begin(isContextCurrent);
    stockRequest = collectionName === 'stock' ? stockReadCoordinator.begin(isContextCurrent) : undefined;
    const requests = [localRequest, ...(stockRequest ? [stockRequest] : [])];
    const isCurrent = () => requests.every(item => item.isCurrent());
    const readGeneration = ++snapshotGeneration;
    void fetchCollection(collectionName, branchId, isCurrent, requests.map(item => item.signal))
      .then(({snapshot, revisions}) => {
        if (!isCurrent()) throw new StaleReadError();
        if (collectionName !== 'users') {
          publishSnapshotWithRevisions(
            versions,
            branchId,
            collectionName,
            revisions,
            isCurrent,
            activeBranchId,
            () => listener(snapshot),
            appliedListener
          );
          acknowledgeFreshSnapshot(collectionName, readGeneration);
        } else {
          listener(snapshot);
          if (!isCurrent()) throw new StaleReadError();
          appliedListener?.();
          acknowledgeFreshSnapshot(collectionName, readGeneration);
        }
      })
      .catch(error => {
        if (isCurrent()) errorListener?.(error);
      });
  };
  const listeners = refreshers.get(collectionName) ?? new Set<() => void>();
  listeners.add(refresh);
  refreshers.set(collectionName, listeners);
  ensureRealtimeChannel();
  refresh();

  return () => {
    active = false; sequence++;
    localCoordinator.invalidate();
    stockRequest?.cancel();
    listeners.delete(refresh);
    if (!listeners.size) refreshers.delete(collectionName);
    if (!refreshers.size && supabase && realtimeChannel) {
      refreshTimers.forEach(timer => clearTimeout(timer));
      refreshTimers.clear();
      removeRealtimeChannel();
    }
  };
}

export async function getDocs(reference: CollectionReference): Promise<QuerySnapshot> {
  const {collectionName, branchId} = reference;
  const isContextCurrent = () => branchId === activeBranchId;
  const request = collectionName === 'stock' ? stockReadCoordinator.begin(isContextCurrent) : undefined;
  const isCurrent = () => isContextCurrent() && (request?.isCurrent() ?? true);
  const readGeneration = ++snapshotGeneration;
  try {
    const result = await fetchCollection(collectionName, branchId, isCurrent, request ? [request.signal] : []);
    if (!isCurrent()) throw new StaleReadError();
    if (collectionName !== 'users') {
      applyRevisionSnapshot(versions, branchId, collectionName, result.revisions, isCurrent, activeBranchId);
    }
    acknowledgeFreshSnapshot(collectionName, readGeneration);
    return result.snapshot;
  } catch (error) {
    if (request && !request.isCurrent() && !(error instanceof StaleReadError)) throw new StaleReadError();
    throw error;
  }
}

function cleanJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, child]) => child !== undefined && !key.startsWith("__wms_"))
        .map(([key, child]) => [key, cleanJson(child)])
    );
  }
  return value;
}

export async function setDoc(reference: DocumentReference, data: object, options?: { merge?: boolean }): Promise<void> {
 const batch=writeBatch(db);batch.set(reference,data,options);await batch.commit();
}
export async function deleteDoc(reference: DocumentReference): Promise<void> {
 const batch=writeBatch(db);batch.delete(reference);await batch.commit();
}
export function writeBatch(_database: unknown) {
 const branchId=activeBranchId,requestId=crypto.randomUUID();
 const upserts=new Map<string,any>(),deletes=new Map<string,any>();
 let frozen: {p_request_id:string;p_branch_id:string;p_upserts:any[];p_deletes:any[]}|null=null;
 const check=(ref:DocumentReference)=>{if(ref.collectionName==='users')throw new Error('Kelola akun harus melalui fungsi admin.');if(ref.branchId!==branchId)throw new Error('Transaksi lintas cabang ditolak.');if(frozen)throw new Error('Transaksi sudah dikirim.');};
 return {
  set(ref:DocumentReference,data:object,options?:{merge?:boolean}) {
   check(ref);const key=versionKey(branchId,ref.collectionName,ref.id);deletes.delete(key);
   const revision=(data as any).__wms_revision;
   const revisionDocumentId=(data as any).__wms_revision_document_id ?? (data as any).id;
   const expectedRevision=revision!==undefined&&revisionDocumentId===ref.id?revision:ref.expectedRevision;
   if(ref.collectionName==='stock'){
    const sourceIds=(data as any).__wms_source_ids;
    const sourceRevisions=(data as any).__wms_source_revisions;
    if(Array.isArray(sourceIds))for(const sourceId of sourceIds){
     if(typeof sourceId!=='string'||!sourceId||sourceId===ref.id)continue;
     const aliasKey=versionKey(branchId,'stock',sourceId);
     upserts.delete(aliasKey);
     const pinned=sourceRevisions&&typeof sourceRevisions[sourceId]==='number'?sourceRevisions[sourceId]:undefined;
     const aliasRevision=pinned===undefined?versions.get(aliasKey)??null:pinned;
     if(versions.has(aliasKey)||pinned!==undefined){
      deletes.set(aliasKey,{collection_name:'stock',document_id:sourceId,expected_revision:aliasRevision});
     }
    }
   }
   upserts.set(key,{collection_name:ref.collectionName,document_id:ref.id,payload:cleanJson(data),merge:!!options?.merge,expected_revision:expectedRevision});
  },
  delete(ref:DocumentReference){
   check(ref);const key=versionKey(branchId,ref.collectionName,ref.id);upserts.delete(key);
   if(ref.collectionName==='stock'&&!versions.has(key)){
    return;
   }
   deletes.set(key,{collection_name:ref.collectionName,document_id:ref.id,expected_revision:ref.expectedRevision});
  },
  async commit(){
   if(!upserts.size&&!deletes.size)return;
   if(writesBlocked)throw new Error('Perubahan sebelumnya gagal. Muat data terbaru dahulu.');
   frozen??={p_request_id:requestId,p_branch_id:branchId,p_upserts:Array.from(upserts.values()),p_deletes:Array.from(deletes.values())};
   pendingWrites++;signalWrites();
   const controller=new AbortController();
   const deadline=setTimeout(()=>controller.abort(),45000);
   try {
    const {data,error}=await requireClient().rpc('commit_wms_write',frozen).abortSignal(controller.signal);
    if(error)throw error;
    for(const row of data||[]){const key=versionKey(branchId,row.collection_name,row.document_id);if(row.revision===null)versions.delete(key);else versions.set(key,row.revision);}
   }catch(error:any){if(controller.signal.aborted)error=new Error('Server belum mengonfirmasi transaksi dalam 45 detik; commit mungkin sudah diterapkan. Muat data terbaru dan periksa stok sebelum mencoba lagi.');writesBlocked=true;[...upserts.values(),...deletes.values()].forEach(item=>blockedCollections.set(item.collection_name,snapshotGeneration));signalWrites(error.message||'Penyimpanan gagal. Periksa koneksi dan muat data terbaru.');throw error;}
   finally{clearTimeout(deadline);pendingWrites--;signalWrites();for(const name of new Set([...upserts.values(),...deletes.values()].map(x=>x.collection_name))) scheduleCollectionRefresh(name);}
  }
 };
}

export function handleSupabaseError(error: unknown, operationType: OperationType, path: string | null) {
  console.warn(`Supabase ${operationType} failed${path ? ` for ${path}` : ''}:`, error);
}
