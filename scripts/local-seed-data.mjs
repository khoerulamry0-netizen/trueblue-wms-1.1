export const branchId = 'DEV_LOCAL';

export const warehouses = [
  { id: 'WH-DEV-01', code: 'WH-DEV-01', name: 'Development Warehouse 01', type: 'CENTRAL', address: 'Local', city: 'Development', picName: 'Synthetic Operator 1', picPhone: '00000000', capacityCbm: 1000, status: 'ACTIVE', isCentral: true },
  { id: 'WH-DEV-02', code: 'WH-DEV-02', name: 'Development Warehouse 02', type: 'SUB_BRANCH', address: 'Local', city: 'Development', picName: 'Synthetic Operator 2', picPhone: '00000000', capacityCbm: 1000, status: 'ACTIVE', isCentral: false },
];

export const operators = [
  { email: 'picker.local@example.invalid', fullName: 'Synthetic Picker', role: 'Picker' },
  { email: 'packer.local@example.invalid', fullName: 'Synthetic Packer', role: 'Packer' },
];

export function buildSeedDocuments(now) {
  const documents = [];
  for (const warehouse of warehouses) {
    documents.push({
      branch_id: branchId,
      collection_name: 'warehouses',
      document_id: warehouse.id,
      payload: { ...warehouse, createdAt: now, updatedAt: now },
    });
  }

  for (let index = 1; index <= 100; index += 1) {
    const skuId = `DEV-SKU-${String(index).padStart(3, '0')}`;
    const catalog = {
      id: skuId,
      skuId,
      skuName: `Synthetic Product ${String(index).padStart(3, '0')}`,
      brand: 'LOCAL-TEST',
      barcode: `990000000${String(index).padStart(4, '0')}`,
      qtyCtnSize: 12,
      qtyInnerSize: 1,
    };
    documents.push({ branch_id: branchId, collection_name: 'catalog', document_id: skuId, payload: catalog });
    for (const stockWarehouse of warehouses) {
      const stockId = getCanonicalStockId(skuId, 'No Expired', 'RACK-A', stockWarehouse.id);
      documents.push({
        branch_id: branchId,
        collection_name: 'stock',
        document_id: stockId,
        payload: {
          ...catalog,
          id: stockId,
          warehouseId: stockWarehouse.id,
          warehouseName: stockWarehouse.name,
          expiredDate: 'No Expired',
          location: 'RACK-A',
          qty: 100,
          totalQtySku: 100,
          qtyCtn: 8,
          qtyLoose: 4,
          qtyInner: 0,
          status: 'AMAN',
        },
      });
    }
  }

  for (let index = 1; index <= 100; index += 1) {
    const skuId = `DEV-SKU-${String(index).padStart(3, '0')}`;
    const warehouse = warehouses[(index - 1) % warehouses.length];
    const id = `DEV-ORDER-${String(index).padStart(3, '0')}`;
    documents.push({
      branch_id: branchId,
      collection_name: 'orders',
      document_id: id,
      payload: {
        id,
        orderNumber: id,
        referenceNumber: id,
        customerName: `Synthetic Customer ${String(index).padStart(3, '0')}`,
        skuId,
        skuName: `Synthetic Product ${String(index).padStart(3, '0')}`,
        qty: (index % 3) + 1,
        location: 'RACK-A',
        expiredDate: 'No Expired',
        warehouseId: warehouse.id,
        status: 'Pending',
        stockDeducted: false,
        picked: false,
        scanned: false,
        timestamp: now,
        createdBy: 'Synthetic Seed',
      },
    });
  }
  return documents;
}
import { getCanonicalStockId } from '../src/utils/calculations.ts';
