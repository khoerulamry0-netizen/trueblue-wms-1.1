export interface StockItem {
  __wms_revision?: number;
  __wms_revision_document_id?: string;
  __wms_source_ids?: string[];
  __wms_source_revisions?: Record<string, number>;
  id: string; // unique combination of SKU, Location, and Expired Date
  skuId: string;
  skuName: string;
  brand?: string;
  barcode?: string;
  expiredDate: string;
  location: string;
  qty: number;
  totalQtySku: number; // total quantity across all locations
  qtyCtnSize: number; // Qty/CTN
  qtyCtn: number; // Qty CTN
  qtyInnerSize: number; // Qty Inner/PCS
  qtyInner: number; // Qty Inner
  qtyLoose: number; // Qty Loose
  status: 'AMAN' | 'Under 24Month' | 'Under 18 Month' | 'Under 6 Month' | 'Under 3 Month' | 'Near ED' | 'Damage' | 'Expired' | string;
  warehouseId?: string; // ID / Code of warehouse e.g. WH-CENTRAL, WH-SUB-SBY
  warehouseName?: string; // Display name of warehouse
}

export type StockItemInput = Omit<
  StockItem,
  'totalQtySku' | 'qtyCtnSize' | 'qtyCtn' | 'qtyInnerSize' | 'qtyInner' | 'qtyLoose' | 'status'
> & {
  totalQtySku?: number | null;
  qtyCtnSize?: number | null;
  qtyCtn?: number | null;
  qtyInnerSize?: number | null;
  qtyInner?: number | null;
  qtyLoose?: number | null;
  status?: StockItem['status'] | null;
};

export interface OutboundItem {
  createdBy?: string;
  createdById?: string;
  createdAt?: string;
  pickedBy?: string;
  pickedById?: string;
  sortedBy?: string;
  sortedById?: string;
  sortedAt?: string;
  packedBy?: string;
  packedById?: string;
  completedAt?: string;
  packedAt?: string;
  id: string;
  referenceNumber: string;
  skuId: string;
  skuName: string;
  expiredDate: string;
  qty: number;
  location: string;
  timestamp: string;
  scanned: boolean; // barcode verified
  status: 'Pending' | 'Completed' | 'Cancelled';
  notes?: string;
  orderNumber?: string;
  noPo?: string;
  customerName?: string;
  customerAddress?: string;
  customerPhone?: string;
  picked?: boolean; // picking verification complete
  isPicked?: boolean; // picking verification complete alias
  pickedAt?: string;
  stockDeducted?: boolean; // indicates whether stock has been deducted from racks
  pickingBy?: string; // name of user currently picking this order
  pickingStartedAt?: string; // ISO timestamp
  packingBy?: string; // name of user currently packing this order
  packingStartedAt?: string; // ISO timestamp
  batchNumber?: string; // Batch number assignment
  basketNumber?: string; // Picking and packing basket assignment
  shipped?: boolean; // Whether the item/batch is shipped
  shippedAt?: string;
  shippedBy?: string;
  manifestId?: string;
  centralWmsDeducted?: boolean; // Whether stock has been deducted from Central WMS
  centralWmsDeductedAt?: string;
  warehouseId?: string;
  warehouseName?: string;
}

export interface DccLog {
  id: string;
  timestamp: string;
  type: 'INBOUND' | 'OUTBOUND' | 'TRANSFER' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT';
  skuId: string;
  skuName: string;
  locationFrom: string;
  locationTo: string;
  qty: number;
  description: string;
  user: string;
  expiredDate?: string;
  warehouseId?: string;
  warehouseName?: string;
  targetWarehouseId?: string;
  targetWarehouseName?: string;
}

export interface LocationDetail {
  name: string;
  zone: string;
  itemsCount: number;
  totalQty: number;
}

export interface UserAccount {
  branch_id?: string;
  id?: string;
  email?: string;
  is_active?: boolean;
  username: string;
  password?: string;
  role: string;
  fullName: string;
}

export interface PhysicalAuditItem {
  id: string;
  timestamp: string;
  skuId: string;
  skuName: string;
  location: string;
  expiredDate: string;
  systemQty: number;
  physicalQty: number;
  difference: number; // physicalQty - systemQty
  status: 'MATCH' | 'PLUS' | 'MINUS';
  operator: string;
  notes: string;
  isAdjusted?: boolean;
}

export interface CatalogItem {
  id: string; // SKU ID
  skuId: string;
  skuName: string;
  brand?: string;
  barcode?: string;
  qtyCtnSize: number;
  qtyInnerSize: number;
}

export interface ReturnItem {
  id: string;
  timestamp: string;
  skuId: string;
  skuName: string;
  expiredDate: string;
  qty: number;
  customerName: string;
  batchNumber: string;
  reason?: string;
  location: string; // 'TRANSIT'
  operator: string;
  status: 'TRANSIT' | 'PROCESSED' | string;
}

export interface InboundReceiptItem {
  id: string;
  poNumber: string;
  supplierName: string;
  skuId: string;
  skuName: string;
  expiredDate: string;
  receivedQty: number;
  targetLocation: string;
  status: 'RECEIVED' | 'PUTAWAY' | 'QC_HOLD';
  receivedDate: string;
  operator: string;
  notes?: string | null;
  batchNumber?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOptionalStringFields(record: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => record[field] === undefined || typeof record[field] === 'string');
}

function hasNullableOptionalStringFields(record: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => record[field] == null || typeof record[field] === 'string');
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value == null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value == null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

export function isStockItem(value: unknown): value is StockItemInput {
  if (!isRecord(value)) return false;

  const identityFields = ['id', 'skuId', 'skuName', 'expiredDate', 'location'];
  return identityFields.every((field) => typeof value[field] === 'string' && value[field].trim().length > 0)
    && Number.isSafeInteger(value.qty) && typeof value.qty === 'number' && value.qty >= 0
    && isOptionalNonNegativeInteger(value.totalQtySku)
    && isOptionalPositiveInteger(value.qtyCtnSize)
    && isOptionalNonNegativeInteger(value.qtyCtn)
    && isOptionalPositiveInteger(value.qtyInnerSize)
    && isOptionalNonNegativeInteger(value.qtyInner)
    && isOptionalNonNegativeInteger(value.qtyLoose)
    && (value.status == null || typeof value.status === 'string')
    && (value.__wms_revision === undefined || (Number.isSafeInteger(value.__wms_revision) && typeof value.__wms_revision === 'number' && value.__wms_revision >= 0))
    && hasOptionalStringFields(value, ['brand', 'barcode', 'warehouseId', 'warehouseName']);
}

export function isInboundReceiptItem(value: unknown): value is InboundReceiptItem {
  if (!isRecord(value)) return false;

  const stringFields = ['id', 'poNumber', 'supplierName', 'skuId', 'skuName', 'expiredDate', 'targetLocation', 'receivedDate', 'operator'];
  return stringFields.every((field) => typeof value[field] === 'string')
    && isFiniteNumber(value.receivedQty)
    && (value.status === 'RECEIVED' || value.status === 'PUTAWAY' || value.status === 'QC_HOLD')
    && hasNullableOptionalStringFields(value, ['notes', 'batchNumber']);
}

export type BatchShippingStatus = 'BELUM_TERKIRIM' | 'DALAM_PENGIRIMAN' | 'SUDAH_TERKIRIM';
export type CentralWmsStatus = 'BELUM_TERPOTONG' | 'SUDAH_TERPOTONG';

export interface BatchItemDetail {
  skuId: string;
  skuName: string;
  qty: number;
  location?: string;
  expiredDate?: string;
  orderNumber?: string;
  referenceNumber?: string;
}

export interface BatchRecord {
  id: string; // Unique ID (usually normalized batch number)
  batchNumber: string; // e.g., BATCH-20261009-01, OUT-BULK-20261009-123
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp

  // 1. Status Pengiriman (Barang sudah terkirim atau belum)
  shippingStatus: BatchShippingStatus;
  shippedAt?: string;
  shippedBy?: string;
  courierName?: string; // J&T, SiCepat, Lalamove, Truk Internal, dll.
  trackingNumber?: string; // No Resi / Surat Jalan / DO
  driverName?: string;
  vehiclePlate?: string; // Nomor Plat Kendaraan

  // 2. Status Pemotongan Stok WMS Pusat (Stok sudah terpotong dari WMS pusat atau belum)
  centralWmsStatus: CentralWmsStatus;
  centralWmsDeductedAt?: string;
  centralWmsDeductedBy?: string;
  centralWmsDocNumber?: string; // No Dokumen / SAP / No Transaksi WMS Pusat
  centralWmsNotes?: string;

  // Metadata agregat
  customerName?: string;
  destination?: string;
  totalSkus: number;
  totalPcs: number;
  notes?: string;
  createdBy?: string;
  orderNumber?: string;
  sourceReference?: string; // Reference Number / Order Number
  items?: BatchItemDetail[];
}

export interface ActiveDevice {
  deviceId: string;
  deviceType: 'desktop' | 'mobile' | 'tablet';
  deviceModel: string;
  browser: string;
  os: string;
  screenResolution: string;
  username: string;
  role: string;
  fullName: string;
  currentTab: string;
  lastActive: string;
  onlineStatus: 'online' | 'offline' | 'idle';
}

export type WarehouseType = 'CENTRAL' | 'SUB_BRANCH' | 'TRANSIT' | 'RETAIL' | 'QUARANTINE';
export type WarehouseStatus = 'ACTIVE' | 'INACTIVE';

export type PickingRoutePattern = 'TRUEBLUE_DC' | 'LINEAR_ASC' | 'S_SHAPE_SNAKE' | 'CUSTOM';

export interface WarehousePickingRouteConfig {
  pattern: PickingRoutePattern;
  aisleSequence?: string[]; // Urutan lorong/rak, misal: ['E', 'F', 'D', 'DISPLAY'] atau ['A', 'B', 'C', 'D']
  customRules?: string; // Deskripsi alur
  specialAreas?: string[]; // Area khusus, misal: ['DISPLAY', 'MEZZANINE', 'STAGE']
}

export interface Warehouse {
  id: string; // e.g., 'WH-CENTRAL', 'WH-SUB-SBY', 'WH-SUB-BDG'
  code: string; // e.g., 'WH-CENTRAL'
  name: string; // e.g., 'Gudang Pusat (Jakarta)'
  type: WarehouseType;
  address: string;
  city: string;
  picName: string; // Penanggung Jawab / Kepala Gudang
  picPhone: string;
  capacityCbm?: number; // Kapasitas (m³)
  status: WarehouseStatus;
  isCentral?: boolean; // True untuk Gudang Utama
  notes?: string;
  pickingRouteConfig?: WarehousePickingRouteConfig; // Alur rute picking per warehouse
  createdAt: string;
  updatedAt?: string;
}

export interface InterWarehouseTransferItem {
  skuId: string;
  skuName: string;
  expiredDate: string;
  sourceLocation: string;
  targetLocation?: string;
  sourceStockId?: string;
  qty: number;
  qtyCtn?: number;
  qtyInner?: number;
  qtyLoose?: number;
}

export interface InterWarehouseTransfer {
  id: string; // e.g., 'TRF-20261025-001'
  transferNumber: string;
  suratJalanNumber: string; // e.g., 'SJ-MUTASI-20261025-01'
  sourceWarehouseId: string;
  sourceWarehouseName: string;
  targetWarehouseId: string;
  targetWarehouseName: string;
  status: 'PENDING' | 'IN_TRANSIT' | 'RECEIVED' | 'COMPLETED' | 'CANCELLED';
  items: InterWarehouseTransferItem[];
  totalSkus: number;
  totalQty: number;
  courierName?: string;
  vehiclePlate?: string;
  driverName?: string;
  driverPhone?: string;
  notes?: string;
  createdBy: string;
  createdAt: string;
  dispatchedAt?: string;
  dispatchedBy?: string;
  receivedAt?: string;
  receivedBy?: string;
}
