import { Warehouse, WarehousePickingRouteConfig, PickingRoutePattern } from '../types';

export const DEFAULT_TRUEBLUE_ROUTE_CONFIG: WarehousePickingRouteConfig = {
  pattern: 'TRUEBLUE_DC',
  aisleSequence: ['E', 'F', 'D', 'DISPLAY'],
  customRules: 'Rak E (E1..E11 Ascending) → Rak F (Ascending) → Rak D (D11..D6 Descending) → Display',
  specialAreas: ['DISPLAY', 'STAGE', 'MEZZANINE']
};

export const DEFAULT_CENTRAL_WAREHOUSE: Warehouse = {
  id: 'WH-CENTRAL',
  code: 'WH-CENTRAL',
  name: 'Gudang Pusat (Central DC)',
  type: 'CENTRAL',
  address: 'Kawasan Industri & Pergudangan Terpadu',
  city: 'Jakarta Utara',
  picName: 'AMRI',
  picPhone: '081234567890',
  capacityCbm: 5000,
  status: 'ACTIVE',
  isCentral: true,
  notes: 'Gudang Distribusi Utama & Pusat Stok',
  pickingRouteConfig: DEFAULT_TRUEBLUE_ROUTE_CONFIG,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

export function ensureCentralWarehouse(warehouses: Warehouse[] = []): Warehouse[] {
  const list = Array.isArray(warehouses) ? [...warehouses] : [];
  const centralIndex = list.findIndex(w => w.isCentral || (w.id || '').toUpperCase() === 'WH-CENTRAL');
  if (centralIndex === -1) {
    return [DEFAULT_CENTRAL_WAREHOUSE, ...list];
  }
  const central = list[centralIndex];
  list[centralIndex] = {
    ...central,
    id: 'WH-CENTRAL',
    code: central.code || 'WH-CENTRAL',
    isCentral: true
  };
  return list;
}

export interface RoutePresetOption {
  id: PickingRoutePattern;
  name: string;
  description: string;
  defaultAisles: string[];
}

export const ROUTE_PRESETS: RoutePresetOption[] = [
  {
    id: 'TRUEBLUE_DC',
    name: 'Pola Khusus TrueBlue DC (E → F → D → Display)',
    description: 'E1..E11 (Kecil ke Besar) → Rak F → D11..D6 (Besar ke Kecil) → Rack Display',
    defaultAisles: ['E', 'F', 'D', 'DISPLAY']
  },
  {
    id: 'S_SHAPE_SNAKE',
    name: 'Pola S-Shape / Snake (Zig-zag antar lorong)',
    description: 'Lorong ganjil (Depan → Belakang), Lorong genap (Belakang → Depan). Meminimalkan jalan kosong picker.',
    defaultAisles: ['A', 'B', 'C', 'D', 'E', 'F']
  },
  {
    id: 'LINEAR_ASC',
    name: 'Pola Linear Berurutan (A → B → C → D)',
    description: 'Semua lorong diurutkan dari nomor rak terkecil ke terbesar secara alfabetis (1 → N).',
    defaultAisles: ['A', 'B', 'C', 'D', 'E', 'F']
  },
  {
    id: 'CUSTOM',
    name: 'Pola Kustom Manual',
    description: 'Tentukan sendiri urutan lorong/rak sesuai denah spesifik gudang ini.',
    defaultAisles: ['A', 'B', 'C']
  }
];

/**
 * Menghitung skor urutan lokasi pengambilan rak gudang (Sorting Score)
 * Semakin kecil skor, semakin awal lokasi tersebut harus didatangi picker.
 */
export function getWarehouseRouteScore(
  location: string, 
  config: WarehousePickingRouteConfig = DEFAULT_TRUEBLUE_ROUTE_CONFIG
): number {
  if (!location) return 999999;
  const loc = location.toUpperCase().trim();

  // Area terlarang/karantina ditaruh paling belakang (900000+)
  if (loc.startsWith('ZONE 1') || loc.includes('DAMAGE')) return 990000;
  if (loc === 'TRANSIT') return 980000;
  if (loc.includes('STAGE') || loc.includes('STAGING')) return 950000;

  // Area display
  if (loc.includes('DISPLAY') || loc.includes('RACK DISPLAY')) {
    return 800000;
  }

  // Mezzanine
  if (loc.includes('MEZZANINE') || loc.includes('MEZ')) {
    return 820000;
  }

  // Format standar: [A-Z][0-9]-[bay]-[level] (contoh: E3-01-02, F1-01-01, D10-01-02, A1-02, dll.)
  const match = loc.match(/^([A-Z]+)(\d+)?(?:-(\d+))?(?:-(\d+))?/);
  if (match) {
    const aisleChar = match[1]; // misal 'E', 'F', 'D', 'A', 'AA'
    const aisleNum = match[2] ? parseInt(match[2], 10) : 1;
    const bayNum = match[3] ? parseInt(match[3], 10) : 1;
    const levelNum = match[4] ? parseInt(match[4], 10) : 1;

    // 1. POLA DEFAULT TRUEBLUE DC (E1..E11 -> F -> D11..D6 -> Display)
    if (config.pattern === 'TRUEBLUE_DC') {
      if (aisleChar === 'E') {
        return 100000 + (aisleNum * 1000) + (bayNum * 10) + levelNum;
      }
      if (aisleChar === 'F') {
        return 200000 + (aisleNum * 1000) + (bayNum * 10) + levelNum;
      }
      if (aisleChar === 'D') {
        // Descending from D11 down to D6 (100 - aisleNum)
        return 300000 + ((100 - aisleNum) * 1000) + (bayNum * 10) + levelNum;
      }
      const charScore = (aisleChar.charCodeAt(0) - 65) * 10000;
      return 500000 + charScore + (aisleNum * 1000) + (bayNum * 10) + levelNum;
    }

    // 2. POLA S-SHAPE / SNAKE ZIG-ZAG
    if (config.pattern === 'S_SHAPE_SNAKE') {
      const aisles = config.aisleSequence && config.aisleSequence.length > 0
        ? config.aisleSequence.map(a => a.trim().toUpperCase())
        : ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
      
      const aisleIndex = aisles.indexOf(aisleChar);
      const effectiveIndex = aisleIndex >= 0 ? aisleIndex : (aisleChar.charCodeAt(0) - 65 + 10);
      const isReverseAisle = effectiveIndex % 2 === 1; // Lorong ganjil reverse (descending)

      const numScore = isReverseAisle 
        ? ((100 - aisleNum) * 100) + (100 - bayNum)
        : (aisleNum * 100) + bayNum;

      return (effectiveIndex * 100000) + numScore + levelNum;
    }

    // 3. POLA LINEAR ASCENDING (A -> B -> C, 1 -> N)
    if (config.pattern === 'LINEAR_ASC') {
      const aisles = config.aisleSequence && config.aisleSequence.length > 0
        ? config.aisleSequence.map(a => a.trim().toUpperCase())
        : ['A', 'B', 'C', 'D', 'E', 'F'];
      
      const aisleIndex = aisles.indexOf(aisleChar);
      const effectiveIndex = aisleIndex >= 0 ? aisleIndex : (aisleChar.charCodeAt(0) - 65 + 10);
      return (effectiveIndex * 100000) + (aisleNum * 1000) + (bayNum * 10) + levelNum;
    }

    // 4. POLA KUSTOM MANUAL BERDASARKAN URUTAN AISLE
    if (config.pattern === 'CUSTOM') {
      const aisles = (config.aisleSequence || []).map(a => a.trim().toUpperCase());
      const aisleIndex = aisles.indexOf(aisleChar);
      if (aisleIndex >= 0) {
        return (aisleIndex * 100000) + (aisleNum * 1000) + (bayNum * 10) + levelNum;
      }
      const charScore = (aisleChar.charCodeAt(0) - 65) * 10000;
      return 600000 + charScore + (aisleNum * 1000) + (bayNum * 10) + levelNum;
    }
  }

  return 700000;
}

/**
 * Menghasilkan ringkasan teks alur rute picking
 */
export function describeRouteConfig(config?: WarehousePickingRouteConfig): string {
  if (!config) return DEFAULT_TRUEBLUE_ROUTE_CONFIG.customRules || 'Pola Khusus TrueBlue DC';
  if (config.pattern === 'TRUEBLUE_DC') {
    return 'E1..E11 (Asc) → Rak F → D11..D6 (Desc) → Display';
  }
  if (config.pattern === 'S_SHAPE_SNAKE') {
    const aisles = config.aisleSequence?.join(' ⇄ ') || 'A ⇄ B ⇄ C';
    return `S-Shape Zigzag (${aisles})`;
  }
  if (config.pattern === 'LINEAR_ASC') {
    const aisles = config.aisleSequence?.join(' → ') || 'A → B → C';
    return `Linear Berurutan (${aisles})`;
  }
  if (config.pattern === 'CUSTOM') {
    const aisles = config.aisleSequence?.join(' → ') || 'Kustom';
    return `Kustom Manual (${aisles})`;
  }
  return 'Rute Standar';
}
