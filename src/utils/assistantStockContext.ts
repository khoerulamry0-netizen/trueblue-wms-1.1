import {StockItem} from '../types';
import {getStockStatus} from './calculations';

// Only search rows already supplied by the active branch/role data scope.
export function getAssistantStockDetails(stock: StockItem[], question: string, budget = 23000): string {
  const query = question.toLowerCase();
  const terms = query.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  const words = terms.filter(word => word.length >= 3);
  const exact = stock.filter(row => terms.includes(row.skuId.toLowerCase()) || (!!row.barcode && terms.includes(row.barcode.toLowerCase())));
  const matched = exact.length ? exact : stock.filter(row => {
    const sku = row.skuId.toLowerCase();
    return words.includes(sku) || (row.barcode && words.includes(row.barcode.toLowerCase())) ||
      words.some(word => sku.includes(word) || row.skuName.toLowerCase().includes(word));
  });
  const relevant = matched.length ? matched : stock;
  const groups = new Map<string, {skuId: string; name: string; qty: number; rows: StockItem[]}>();
  for (const row of relevant) {
    const key = row.skuId.toUpperCase();
    const group = groups.get(key) || {skuId: row.skuId, name: row.skuName, qty: 0, rows: []};
    group.qty += Number(row.qty) || 0;
    group.rows.push(row);
    groups.set(key, group);
  }
  const prefix = `Detail dari cabang yang sedang diakses. ${matched.length ? 'Hasil pencarian pertanyaan' : 'Daftar stok'}: ${relevant.length} baris lokasi, ${groups.size} SKU.\n`;
  let text = prefix, shown = 0, clippedRows = 0;
  for (const group of groups.values()) {
    const heading = `SKU: ${group.skuId} | ${group.name} | Total: ${group.qty} pcs (${group.rows.length} baris lokasi)\n`;
    if (text.length + heading.length > budget - 600) break;
    text += heading;
    shown++;
    for (const row of group.rows) {
      const detail = `- Gudang: ${row.warehouseId || 'WH-CENTRAL'} | Rak: ${row.location} | Qty: ${row.qty} | ED: ${row.expiredDate} | Status: ${getStockStatus(row)}\n`;
      if (text.length + detail.length > budget - 600) { clippedRows++; continue; }
      text += detail;
    }
  }
  return text + `\nCakupan detail: ${shown}/${groups.size} SKU; ${clippedRows} baris lokasi pada SKU yang ditampilkan tidak dirinci. ` +
    (shown < groups.size || clippedRows ? 'Konteks terbatas. Jangan menganggap SKU yang tidak dirinci stoknya nol atau menyimpulkan detailnya; minta pengguna menyebutkan SKU spesifik.' : 'Seluruh hasil pencarian tercakup.');
}
