import { StockItem, OutboundItem } from '../types';

export interface PackQuantities {
  qtyCtn: number;
  qtyInner: number;
  qtyLoose: number;
}

/**
 * Calculates carton, inner box, and loose quantities from total pieces.
 * Formula:
 * Qty CTN = floor(Qty / Carton Size)
 * Remainder = Qty % Carton Size
 * Qty Inner = floor(Remainder / Inner Size)
 * Qty Loose = Remainder % Inner Size
 */
export function calculatePackQuantities(
  qty: number,
  ctnSize: number,
  innerSize: number
): PackQuantities {
  const safeCtnSize = ctnSize > 0 ? ctnSize : 1000000;
  const safeInnerSize = innerSize > 0 ? innerSize : 1;

  const qtyCtn = Math.floor(qty / safeCtnSize);
  const remainder = qty % safeCtnSize;
  const qtyInner = Math.floor(remainder / safeInnerSize);
  const qtyLoose = remainder % safeInnerSize;

  return { qtyCtn, qtyInner, qtyLoose };
}

/**
 * Calculates total pieces from carton, inner, and loose quantities.
 */
export function calculateTotalFromPacks(
  ctn: number,
  inner: number,
  loose: number,
  ctnSize: number,
  innerSize: number
): number {
  const safeCtn = Math.max(0, ctn);
  const safeInner = Math.max(0, inner);
  const safeLoose = Math.max(0, loose);
  return safeCtn * ctnSize + safeInner * innerSize + safeLoose;
}

export function isNoExpiryDate(val: string | undefined | null): boolean {
  if (!val) return true;
  const str = String(val).trim();
  if (!str) return true;
  const lower = str.toLowerCase();
  if (
    lower === '-' ||
    lower === '--' ||
    lower === '---' ||
    lower === '–' ||
    lower === '—' ||
    lower === 'n/a' ||
    lower === 'na' ||
    lower === 'none' ||
    lower === 'null' ||
    lower === 'undefined'
  ) return true;
  if (/^(?:no[ _-]*exp(?:ired)?|no[ _-]*ed|tanpa[ _-]*k[ae]daluwarsa|tanpa[ _-]*exp(?:ired)?|tidak[ _-]*ada)$/i.test(lower)) return true;
  return false;
}

/**
 * Normalizes any date string (Excel serial number, YYYY-MM-DD, DD/MM/YYYY, etc.) to DD/MM/YYYY format.
 */
export function normalizeDateToDmy(val: string | undefined | null): string {
  if (!val) return '';
  const str = String(val).trim();
  if (!str) return '';

  if (isNoExpiryDate(str)) {
    return 'No Expired';
  }

  // Excel serial date number
  if (!isNaN(Number(str)) && Number(str) > 30000 && Number(str) < 70000) {
    const jsDate = new Date((Number(str) - (25567 + 2)) * 86400 * 1000);
    const day = String(jsDate.getDate()).padStart(2, '0');
    const month = String(jsDate.getMonth() + 1).padStart(2, '0');
    const year = jsDate.getFullYear();
    return `${day}/${month}/${year}`;
  }

  // Months name map for English and Indonesian
  const monthsMap: Record<string, string> = {
    jan: '01', january: '01', januari: '01',
    feb: '02', february: '02', febuari: '02', pebruari: '02',
    mar: '03', march: '03', maret: '03',
    apr: '04', april: '04',
    may: '05', mei: '05',
    jun: '06', june: '06', juni: '06',
    jul: '07', july: '07', juli: '07',
    aug: '08', agt: '08', august: '08', agustus: '08',
    sep: '09', september: '09', sept: '09',
    oct: '10', okt: '10', october: '10', oktober: '10',
    nov: '11', november: '11', nopember: '11',
    dec: '12', des: '12', december: '12', desember: '12'
  };

  // 1. Text Month Format: "30-Sep-2028", "30 Sep 28", "30/Sep/2028", "30 September 2028"
  const textMonthMatch1 = str.match(/^(\d{1,2})[\/\- ]([a-zA-Z]{3,12})[\/\- ](\d{2,4})$/);
  if (textMonthMatch1) {
    const [, d, mStr, y] = textMonthMatch1;
    const mLower = mStr.toLowerCase();
    if (monthsMap[mLower]) {
      const fullYear = y.length === 2 ? '20' + y : y;
      return `${d.padStart(2, '0')}/${monthsMap[mLower]}/${fullYear}`;
    }
  }

  // 2. Text Month Format with leading Month: "Sep-30-2028", "Sep 30 28"
  const textMonthMatch2 = str.match(/^([a-zA-Z]{3,12})[\/\- ](\d{1,2})[\/\- ](\d{2,4})$/);
  if (textMonthMatch2) {
    const [, mStr, d, y] = textMonthMatch2;
    const mLower = mStr.toLowerCase();
    if (monthsMap[mLower]) {
      const fullYear = y.length === 2 ? '20' + y : y;
      return `${d.padStart(2, '0')}/${monthsMap[mLower]}/${fullYear}`;
    }
  }

  // 3. Month & Year Only Text: "Sep-2028", "Sep 28", "September 2028" -> defaults to 1st of month
  const monthYearMatch = str.match(/^([a-zA-Z]{3,12})[\/\-\. ](\d{2,4})$/);
  if (monthYearMatch) {
    const [, mStr, y] = monthYearMatch;
    const mLower = mStr.toLowerCase();
    if (monthsMap[mLower]) {
      const fullYear = y.length === 2 ? '20' + y : y;
      return `01/${monthsMap[mLower]}/${fullYear}`;
    }
  }

  // 4. Numeric Month & Year Only: "08/2028", "8-2028", "08.2028", "08 2028" (Common on expiry-date labels) -> defaults to 1st of month
  const numericMyMatch = str.match(/^(\d{1,2})[\/\-\. ](\d{2,4})$/);
  if (numericMyMatch) {
    const [, m, y] = numericMyMatch;
    const mNum = parseInt(m, 10);
    if (mNum >= 1 && mNum <= 12) {
      const fullYear = y.length === 2 ? '20' + y : y;
      return `01/${m.padStart(2, '0')}/${fullYear}`;
    }
  }

  // ISO or YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  const ymdMatch = str.match(/^(\d{4})[\/\-\. ](\d{1,2})[\/\-\. ](\d{1,2})([T ].*)?$/);
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch;
    return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
  }

  // D/M/YYYY or DD/MM/YYYY or D-M-YY or D.M.YYYY or D M YYYY
  const dmyMatch = str.match(/^(\d{1,2})[\/\-\. ](\d{1,2})[\/\-\. ](\d{2,4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const fullYear = y.length === 2 ? '20' + y : y;
    return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${fullYear}`;
  }

  return str;
}

/**
 * Evaluates stock expired status based on expiration date compared to current date (today) per date.
 * - Expired: expDate <= today
 * - Under 3 Month: expDate < 3 months from today (per date)
 * - Under 6 Month: expDate < 6 months from today (per date)
 * - Under 18 Month: expDate < 18 months from today (per date)
 * - Under 24Month: expDate < 24 months (2 years) from today (per date)
 * - AMAN: expDate >= 24 months from today (per date)
 */
export function getExpiredStatus(expiredDate: string): 'AMAN' | 'Under 24Month' | 'Under 18 Month' | 'Under 6 Month' | 'Under 3 Month' | 'Near ED' | 'Damage' | 'Expired' {
  if (isNoExpiryDate(expiredDate)) return 'AMAN';
  
  const normalized = (expiredDate || '').trim().toLowerCase();
  
  if (normalized.includes('damage') || normalized.includes('rusak')) {
    return 'Damage';
  }

  if (normalized.includes('expired') || normalized.includes('kedaluwarsa')) {
    return 'Expired';
  }

  // Normalize first to ensure consistent format (DD/MM/YYYY)
  const cleanDate = normalizeDateToDmy(expiredDate);
  if (isNoExpiryDate(cleanDate)) return 'AMAN';

  // Parse date like DD/MM/YYYY or D/M/YYYY
  const parts = cleanDate.split('/');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // 0-indexed month
    const year = parseInt(parts[2], 10);

    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
      const expDate = new Date(year, month, day);

      // Dynamic current date (today at 00:00:00)
      const todayWib=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jakarta'}).format(new Date());
      const currentDate=new Date(todayWib+'T00:00:00');

      if (expDate <= currentDate) {
        return 'Expired'; // Already expired or expires today
      }

      // Exact threshold dates calculated per date from today:
      // 3 months from today (per date)
      const target3Months = new Date(currentDate.getFullYear(), currentDate.getMonth() + 3, currentDate.getDate());

      // 6 months from today (per date)
      const target6Months = new Date(currentDate.getFullYear(), currentDate.getMonth() + 6, currentDate.getDate());

      // 18 months from today (per date)
      const target18Months = new Date(currentDate.getFullYear(), currentDate.getMonth() + 18, currentDate.getDate());

      // 24 months (2 years) from today (per date)
      const target24Months = new Date(currentDate.getFullYear() + 2, currentDate.getMonth(), currentDate.getDate());

      if (expDate < target3Months) {
        return 'Under 3 Month';
      } else if (expDate < target6Months) {
        return 'Under 6 Month';
      } else if (expDate < target18Months) {
        return 'Under 18 Month';
      } else if (expDate < target24Months) {
        return 'Under 24Month';
      } else {
        return 'AMAN';
      }
    }
  }

  return 'AMAN';
}

/**
 * Helper to check if a status falls into any near-expiry / under-expiry category
 */
export function isNearExpiryStatus(status: string): boolean {
  if (!status) return false;
  const s = status.toLowerCase().replace(/\s+/g, '');
  return (
    s.includes('under3') ||
    s.includes('under6') ||
    s.includes('under18') ||
    s.includes('under24') ||
    s.includes('neared') ||
    s.includes('nearexpiry')
  );
}

/**
 * Returns consistent Tailwind CSS classes for status badges
 */
export function getStatusBadgeClass(status: string): string {
  const norm = (status || '').toLowerCase().replace(/\s+/g, '');
  if (norm.includes('under3')) {
    return 'bg-red-500/15 text-red-300 border border-red-500/30 font-black animate-pulse';
  }
  if (norm.includes('under6') || norm.includes('neared')) {
    return 'bg-rose-500/10 text-rose-300 border border-rose-500/25 font-extrabold';
  }
  if (norm.includes('under18')) {
    return 'bg-orange-500/10 text-orange-300 border border-orange-500/25 font-extrabold';
  }
  if (norm.includes('under24')) {
    return 'bg-amber-500/10 text-amber-300 border border-amber-500/25 font-extrabold';
  }
  if (norm.includes('damage')) {
    return 'bg-pink-500/10 text-pink-400 border border-pink-500/25 font-extrabold';
  }
  if (norm.includes('expired')) {
    return 'bg-red-950/40 text-red-400 border border-red-700/50 font-extrabold';
  }
  return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold';
}

/**
 * Format a number with Indonesian local style (e.g. 15.120)
 */
export function formatNumber(val: number): string {
  return new Intl.NumberFormat('id-ID').format(val);
}

/**
 * Format a date string (ISO or local) to WIB (Western Indonesia Time) with format: DD/MM/YYYY HH:mm
 */
export function formatToWibString(timestamp: string | Date, includeSeconds = false): string {
  if (!timestamp) return '-';
  try {
    const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(includeSeconds ? { second: '2-digit' } : {})
    }).replace(/\./g, ':') + ' WIB';
  } catch (e) {
    return String(timestamp);
  }
}

/**
 * Format a date string to just time in WIB (HH:mm)
 */
export function formatToWibTimeOnly(timestamp: string | Date): string {
  if (!timestamp) return '-';
  try {
    const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/\./g, ':');
  } catch (e) {
    return '';
  }
}

/**
 * Check if a timestamp falls on today's date (WIB / local time starting at 00:00)
 */
export function isToday(timestamp: string | Date | undefined | null): boolean {
  if (!timestamp) return false;
  try {
    let date: Date;
    if (typeof timestamp === 'string') {
      date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        const parts = timestamp.split(/[\/\s,\.\:-]/);
        if (parts.length >= 3) {
          const day = parseInt(parts[0], 10);
          const month = parseInt(parts[1], 10) - 1;
          const year = parseInt(parts[2], 10);
          date = new Date(year, month, day);
        }
      }
    } else {
      date = timestamp;
    }

    if (isNaN(date.getTime())) return false;

    const tz = 'Asia/Jakarta';
    const targetDateStr = date.toLocaleDateString('en-CA', { timeZone: tz });
    const todayDateStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    return targetDateStr === todayDateStr;
  } catch (e) {
    return false;
  }
}

export const SKU_CATEGORY_MAP: Record<string, string> = {
  "1007-01": "DEAD STOCK",
  "1014-01": "DEAD STOCK",
  "1014-02": "DEAD STOCK",
  "1014-03": "DEAD STOCK",
  "1014-04": "DEAD STOCK",
  "1014-05": "DEAD STOCK",
  "1015": "DEAD STOCK",
  "1019": "FAST MOVING",
  "2140": "SLOW MOVING",
  "2141": "SLOW MOVING",
  "2145": "DEAD STOCK",
  "6048-01": "DEAD STOCK",
  "9112-01": "DEAD STOCK",
  "9131": "FAST MOVING",
  "9137": "DEAD STOCK",
  "9144-01": "SLOW MOVING",
  "9144-02": "SLOW MOVING",
  "9144-03": "SLOW MOVING",
  "9144-04": "SLOW MOVING",
  "9144-05": "SLOW MOVING",
  "9144-06": "SLOW MOVING",
  "9144-07": "SLOW MOVING",
  "9144-08": "SLOW MOVING",
  "9144-09": "SLOW MOVING",
  "9144-10": "SLOW MOVING",
  "9144-11": "SLOW MOVING",
  "9144-14": "SLOW MOVING",
  "9981": "FAST MOVING",
  "E110-H01": "SLOW MOVING",
  "FC001": "SLOW MOVING",
  "FC002": "DEAD STOCK",
  "FC003": "DEAD STOCK",
  "HC001": "MEDIUM",
  "HC002-01": "SLOW MOVING",
  "HC002-02": "SLOW MOVING",
  "HC002-03": "DEAD STOCK",
  "HC002-04": "SLOW MOVING",
  "HC002-05": "SLOW MOVING",
  "HC002-06": "SLOW MOVING",
  "HC003-01": "SLOW MOVING",
  "HC003-02": "SLOW MOVING",
  "HC003-03": "SLOW MOVING",
  "HC003-04": "SLOW MOVING",
  "HC003-05": "SLOW MOVING",
  "HC003-06": "SLOW MOVING",
  "HC003-07": "SLOW MOVING",
  "HC003-08": "SLOW MOVING",
  "HC003-09": "SLOW MOVING",
  "HC003-10": "SLOW MOVING",
  "HC003-11": "SLOW MOVING",
  "HC003-12": "SLOW MOVING",
  "HC004-01": "SLOW MOVING",
  "HC004-02": "SLOW MOVING",
  "HC004-03": "SLOW MOVING",
  "HC004-04": "SLOW MOVING",
  "HC005-01": "DEAD STOCK",
  "HC005-02": "DEAD STOCK",
  "HC005-03": "SLOW MOVING",
  "HC005-04": "SLOW MOVING",
  "HC006-01": "SLOW MOVING",
  "HC006-02": "SLOW MOVING",
  "HC006-03": "SLOW MOVING",
  "HC006-04": "SLOW MOVING",
  "HC006-05": "SLOW MOVING",
  "HC006-06": "SLOW MOVING",
  "HC007-01": "MEDIUM",
  "HC007-02": "SLOW MOVING",
  "HC007-03": "SLOW MOVING",
  "HC007-04": "SLOW MOVING",
  "HC008-01": "SLOW MOVING",
  "HC008-02": "DEAD STOCK",
  "HC008-03": "SLOW MOVING",
  "HC008-04": "SLOW MOVING",
  "HC008-W01": "DEAD STOCK",
  "HC008-W02": "DEAD STOCK",
  "HC009-01": "SLOW MOVING",
  "HC009-02": "SLOW MOVING",
  "HC009-03": "SLOW MOVING",
  "HC009-04": "MEDIUM",
  "HC009-05": "SLOW MOVING",
  "HC009-06": "SLOW MOVING",
  "HC009-07": "SLOW MOVING",
  "HC009-08": "SLOW MOVING",
  "HC010": "SLOW MOVING",
  "HC015-01": "SLOW MOVING",
  "HC015-02": "SLOW MOVING",
  "HC015-03": "SLOW MOVING",
  "HC016-01": "SLOW MOVING",
  "HC016-02": "SLOW MOVING",
  "HC016-03": "SLOW MOVING",
  "HC016-04": "SLOW MOVING",
  "HC018-01": "SLOW MOVING",
  "HC018-02": "SLOW MOVING",
  "HC020-01": "DEAD STOCK",
  "HC020-02": "DEAD STOCK",
  "HC020-03": "DEAD STOCK",
  "HC020-04": "DEAD STOCK",
  "LE003-01": "DEAD STOCK",
  "LE003-02": "SLOW MOVING",
  "LE003-03": "SLOW MOVING",
  "LE009-13": "SLOW MOVING",
  "LE009-14": "SLOW MOVING",
  "LE009-15": "SLOW MOVING",
  "PF01-F01": "SLOW MOVING",
  "PF01-F02": "DEAD STOCK",
  "PF01-F03": "DEAD STOCK",
  "PF01-F04": "DEAD STOCK",
  "PF02-S01": "DEAD STOCK",
  "PF02-S02": "DEAD STOCK",
  "PF02-S03": "SLOW MOVING",
  "PF02-S04": "DEAD STOCK",
  "PS01-F01": "SLOW MOVING",
  "PS01-F02": "SLOW MOVING",
  "PS01-F03": "SLOW MOVING",
  "PS01-F04": "SLOW MOVING",
  "PS02-S01": "SLOW MOVING",
  "PS02-S02": "SLOW MOVING",
  "PS02-S03": "SLOW MOVING",
  "PS02-S04": "SLOW MOVING",
  "SC023-01": "DEAD STOCK",
  "SC023-03": "DEAD STOCK",
  "SC023-05": "DEAD STOCK",
  "SC028-01": "DEAD STOCK",
  "SC028-02": "DEAD STOCK",
  "SC028-04": "DEAD STOCK",
  "SC029-01": "SLOW MOVING",
  "SC029-02": "SLOW MOVING",
  "SC029-04": "SLOW MOVING",
  "SC030-01": "DEAD STOCK",
  "SC030-02": "SLOW MOVING",
  "SC030-03": "SLOW MOVING",
  "SC032": "FAST MOVING",
  "SC033-H001": "DEAD STOCK",
  "SC033-H002": "DEAD STOCK",
  "SC033-H003": "DEAD STOCK",
  "SC036-L01": "DEAD STOCK",
  "SC036-L02": "DEAD STOCK",
  "SC036-L03": "DEAD STOCK",
  "SC036-L04": "DEAD STOCK",
  "SC036-L05": "DEAD STOCK",
  "SC036-L07": "DEAD STOCK",
  "SC036-L09": "DEAD STOCK",
  "SC036-L10": "DEAD STOCK",
  "SC036-L11": "DEAD STOCK",
  "SC038-C01": "DEAD STOCK",
  "SC038-C02": "DEAD STOCK",
  "SC038-C03": "DEAD STOCK",
  "SC039": "FAST MOVING",
  "SC040-01": "DEAD STOCK",
  "SC040-02": "DEAD STOCK",
  "SC040-03": "DEAD STOCK",
  "SC040-04": "DEAD STOCK",
  "SC042-01": "DEAD STOCK",
  "SC042-03": "DEAD STOCK",
  "SC043-03": "DEAD STOCK",
  "SC043-04": "DEAD STOCK",
  "SC043-06": "DEAD STOCK",
  "SC044-01": "DEAD STOCK",
  "SC044-02": "DEAD STOCK",
  "SC044-03": "DEAD STOCK",
  "SC044-04": "DEAD STOCK",
  "SC044-05": "DEAD STOCK",
  "SC044-06": "DEAD STOCK",
  "SC046": "SLOW MOVING",
  "SC047-01": "DEAD STOCK",
  "SC047-02": "DEAD STOCK",
  "SC047-03": "DEAD STOCK",
  "SC047-04": "DEAD STOCK",
  "SC048-01": "DEAD STOCK",
  "SC048-02": "DEAD STOCK",
  "SC048-03": "DEAD STOCK",
  "SC048-04": "DEAD STOCK",
  "SC048-05": "DEAD STOCK",
  "SC048-06": "DEAD STOCK",
  "SC049-01": "SLOW MOVING",
  "SC049-02": "SLOW MOVING",
  "SC049-03": "SLOW MOVING",
  "SC049-04": "SLOW MOVING",
  "SC049-05": "SLOW MOVING",
  "SC049-06": "SLOW MOVING",
  "SC050": "MEDIUM",
  "SC053-01": "DEAD STOCK",
  "SC053-02": "DEAD STOCK",
  "SC053-03": "DEAD STOCK",
  "SC054-110": "DEAD STOCK",
  "SC054-120": "DEAD STOCK",
  "SC055-01": "SLOW MOVING",
  "SC055-02": "SLOW MOVING",
  "SC055-03": "SLOW MOVING",
  "SC056": "FAST MOVING",
  "SC057-01": "SLOW MOVING",
  "SC057-02": "SLOW MOVING",
  "SC057-03": "SLOW MOVING",
  "SC057-04": "SLOW MOVING",
  "SC057-05": "SLOW MOVING",
  "SC057-06": "SLOW MOVING",
  "SC057-07": "SLOW MOVING",
  "SC057-08": "SLOW MOVING",
  "SC059-N110": "DEAD STOCK",
  "SC059-N120": "DEAD STOCK",
  "SC059-N220": "DEAD STOCK",
  "SC059-N230": "DEAD STOCK",
  "SC060": "DEAD STOCK",
  "SC061-01": "SLOW MOVING",
  "SC061-02": "SLOW MOVING",
  "SC061-03": "SLOW MOVING",
  "SC061-04": "SLOW MOVING",
  "SC063-E01": "DEAD STOCK",
  "SC063-E02": "DEAD STOCK",
  "SC063-E03": "DEAD STOCK",
  "SC063-E04": "DEAD STOCK",
  "SC063-E05": "DEAD STOCK",
  "SC063-E06": "DEAD STOCK",
  "SC064-M11": "SLOW MOVING",
  "SC064-M12": "SLOW MOVING",
  "SC064-M13": "SLOW MOVING",
  "SC064-M14": "FAST MOVING",
  "SC064-M15": "SLOW MOVING",
  "SC064-M16": "FAST MOVING",
  "SC064-M17": "SLOW MOVING",
  "SC064-M18": "SLOW MOVING",
  "SC064-M19": "SLOW MOVING",
  "SC064-M20": "SLOW MOVING",
  "SC064-M21": "SLOW MOVING",
  "SC065-01": "DEAD STOCK",
  "SC065-02": "DEAD STOCK",
  "SC065-03": "DEAD STOCK",
  "SC065-04": "DEAD STOCK",
  "SC065-05": "DEAD STOCK",
  "SC065-06": "DEAD STOCK",
  "SC066-01": "SLOW MOVING",
  "SC066-03": "SLOW MOVING",
  "SC067-N110": "SLOW MOVING",
  "SC067-N120": "SLOW MOVING",
  "SC067-N130": "DEAD STOCK",
  "SC069-01": "DEAD STOCK",
  "SC069-02": "DEAD STOCK",
  "SC069-03": "SLOW MOVING",
  "SC137-W21": "DEAD STOCK",
  "SC138-W03": "DEAD STOCK",
  "SE010-01": "DEAD STOCK",
  "SE010-02": "DEAD STOCK",
  "SE010-03": "DEAD STOCK",
  "SM001-1": "DEAD STOCK",
  "SM001-4": "DEAD STOCK",
  "SM001-7": "DEAD STOCK",
  "SM002": "DEAD STOCK",
  "SN010": "MEDIUM",
  "SN013": "DEAD STOCK",
  "SN014": "MEDIUM",
  "SN015-04": "DEAD STOCK",
  "SN016": "SLOW MOVING",
  "SN017": "SLOW MOVING",
  "SN019-2": "DEAD STOCK",
  "SN020-01": "SLOW MOVING",
  "SN020-02": "SLOW MOVING",
  "SN020-03": "SLOW MOVING",
  "SN020-04": "SLOW MOVING",
  "SN059-N230": "DEAD STOCK",
  "TZ017-S01": "DEAD STOCK",
  "TZ017-S02": "DEAD STOCK",
  "TZ017-S03": "DEAD STOCK",
  "TZ018": "DEAD STOCK",
  "1016-01": "DEAD STOCK",
  "ZP-ZIPPA": "DEAD STOCK",
  "MV001-F01": "SLOW MOVING",
  "MV001-F02": "SLOW MOVING",
  "MV001-F03": "SLOW MOVING",
  "MV001-F04": "SLOW MOVING",
  "MV001-F05": "SLOW MOVING",
  "MV001-F06": "SLOW MOVING",
  "MV001-F07": "SLOW MOVING",
  "MV001-F08": "SLOW MOVING",
  "SC064-N01": "SLOW MOVING",
  "SC064-N02": "SLOW MOVING",
  "SC064-N03": "SLOW MOVING",
  "SC076": "SLOW MOVING",
  "ZP-F006": "DEAD STOCK",
  "2000-2": "DEAD STOCK",
  "SK001": "DEAD STOCK"
};

/**
 * Automatically determine the product category based on SKU ID or fallback to SKU name.
 */
// Movement classes use completed outbound units in the last 30 days, never SKU prefixes.
let MOVEMENT_SALES:Record<string,number>={};
export function getCompletedOutbound(orders:OutboundItem[],now=new Date()):OutboundItem[]{
 const since=now.getTime()-30*86400000;
 return orders.filter(o=>{const when=Date.parse(o.completedAt||o.packedAt||o.timestamp);return o.status==='Completed'&&Number.isFinite(o.qty)&&o.qty>0&&when>=since&&when<=now.getTime()});
}
export function updateMovementSales(orders:OutboundItem[],now=new Date()){
 const result:Record<string,number>={};for(const o of getCompletedOutbound(orders,now)){const key=o.skuId.trim().toUpperCase();result[key]=(result[key]||0)+o.qty}MOVEMENT_SALES=result;
}
export function getProductCategory(skuId:string,_skuName?:string):string{const qty=MOVEMENT_SALES[skuId?.trim().toUpperCase()]||0;return qty>=100?'FAST MOVING':qty>=10?'MEDIUM':qty>0?'SLOW MOVING':'BELUM ADA OUTBOUND';}
export function getStockStatus(item: Pick<StockItem, 'expiredDate' | 'status' | 'location'>): string {
  const status = (item.status || '').toLowerCase().trim();
  const loc = (item.location || '').toLowerCase().trim();

  // 1. Explicit Damage / Rusak
  if (/damage|rusak/.test(status) || /damage|rusak/.test(loc)) return 'Damage';

  // 2. Explicit Expired (exclude "tanpa kedaluwarsa")
  if (!isNoExpiryDate(status) && /expired|kedaluwarsa/.test(status)) return 'Expired';

  // 3. Quarantine / Hold dedicated locations
  if (/karantina|quarantine|qc[ _-]*hold/.test(loc)) return 'Karantina';

  // 4. Products with no expiration date (or non-perishable)
  if (isNoExpiryDate(item.expiredDate)) {
    // If status was explicitly set to QC_HOLD while awaiting inspection:
    if (/qc[ _-]*hold/.test(status)) return 'Karantina';
    // Clean active stock in standard warehouse storage rack
    return 'AMAN';
  }

  // 5. Expiry Date validation
  const normalizedDate = normalizeDateToDmy(item.expiredDate);
  const dateStatus = getExpiredStatus(item.expiredDate);

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(normalizedDate)) {
    const [d, m, y] = normalizedDate.split('/').map(Number);
    const parsed = new Date(y, m - 1, d);
    if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
      return 'Karantina'; // Malformed calendar date -> needs date review
    }
  } else if (!isNoExpiryDate(normalizedDate) && normalizedDate !== 'No Expired' && normalizedDate !== '--') {
    return 'Karantina';
  }

  if (['Damage', 'Expired'].includes(dateStatus)) return dateStatus;

  // 6. Explicit QC hold status
  if (/qc[ _-]*hold/.test(status)) return 'Karantina';

  return dateStatus;
}
export function isStockPickable(_item:Pick<StockItem,'expiredDate'|'status'|'location'>):boolean{
 return true;
}

// Known pack-size mappings, with editable product-specific values in the catalog
export const SKU_SIZE_MAP: Record<string, { ctn: number; inner: number }> = {
  "1007-01": { ctn: 1000, inner: 12 },
  "1014-01": { ctn: 600, inner: 12 },
  "1014-02": { ctn: 600, inner: 12 },
  "1014-03": { ctn: 600, inner: 12 },
  "1014-04": { ctn: 600, inner: 12 },
  "1014-05": { ctn: 600, inner: 12 },
  "1015": { ctn: 576, inner: 12 },
  "1019": { ctn: 720, inner: 12 },
  "2140": { ctn: 1000, inner: 1 },
  "2141": { ctn: 1000, inner: 1 },
  "2145": { ctn: 1000, inner: 1 },
  "6048-01": { ctn: 1000, inner: 12 },
  "9112": { ctn: 1000, inner: 1 },
  "9112-01": { ctn: 1000, inner: 1 },
  "9131": { ctn: 720, inner: 120 },
  "9137": { ctn: 500, inner: 1 },
  "9144-01": { ctn: 720, inner: 60 },
  "9144-02": { ctn: 720, inner: 60 },
  "9144-03": { ctn: 720, inner: 60 },
  "9144-04": { ctn: 720, inner: 60 },
  "9144-05": { ctn: 720, inner: 60 },
  "9144-06": { ctn: 720, inner: 60 },
  "9144-07": { ctn: 720, inner: 60 },
  "9144-08": { ctn: 720, inner: 60 },
  "9144-09": { ctn: 720, inner: 60 },
  "9144-10": { ctn: 720, inner: 60 },
  "9144-11": { ctn: 720, inner: 60 },
  "9144-14": { ctn: 720, inner: 60 },
  "9981": { ctn: 720, inner: 180 },
  "E110-H01": { ctn: 432, inner: 1 },
  "FC001": { ctn: 320, inner: 40 },
  "FC002": { ctn: 192, inner: 48 },
  "HC001": { ctn: 576, inner: 12 },
  "HC002-01": { ctn: 576, inner: 12 },
  "HC002-02": { ctn: 576, inner: 12 },
  "HC002-03": { ctn: 576, inner: 12 },
  "HC002-04": { ctn: 576, inner: 12 },
  "HC002-05": { ctn: 576, inner: 12 },
  "HC002-06": { ctn: 576, inner: 12 },
  "HC003-01": { ctn: 576, inner: 12 },
  "HC003-02": { ctn: 576, inner: 12 },
  "HC003-03": { ctn: 576, inner: 12 },
  "HC003-04": { ctn: 576, inner: 12 },
  "HC003-05": { ctn: 576, inner: 12 },
  "HC003-06": { ctn: 576, inner: 12 },
  "HC003-07": { ctn: 576, inner: 12 },
  "HC003-08": { ctn: 576, inner: 12 },
  "HC003-09": { ctn: 576, inner: 12 },
  "HC003-10": { ctn: 576, inner: 12 },
  "HC003-11": { ctn: 576, inner: 12 },
  "HC003-12": { ctn: 576, inner: 12 },
  "HC004-01": { ctn: 96, inner: 12 },
  "HC004-02": { ctn: 96, inner: 12 },
  "HC004-03": { ctn: 96, inner: 12 },
  "HC004-04": { ctn: 96, inner: 12 },
  "HC005-01": { ctn: 192, inner: 12 },
  "HC005-02": { ctn: 192, inner: 12 },
  "HC005-03": { ctn: 192, inner: 12 },
  "HC005-04": { ctn: 192, inner: 12 },
  "HC006-01": { ctn: 576, inner: 12 },
  "HC006-02": { ctn: 576, inner: 12 },
  "HC006-03": { ctn: 576, inner: 12 },
  "HC006-04": { ctn: 576, inner: 12 },
  "HC006-05": { ctn: 576, inner: 12 },
  "HC006-06": { ctn: 576, inner: 12 },
  "HC007-01": { ctn: 720, inner: 12 },
  "HC007-02": { ctn: 720, inner: 12 },
  "HC007-03": { ctn: 720, inner: 12 },
  "HC007-04": { ctn: 720, inner: 12 },
  "HC008-01": { ctn: 1000, inner: 6 },
  "HC008-02": { ctn: 1000, inner: 6 },
  "HC008-03": { ctn: 1000, inner: 6 },
  "HC008-04": { ctn: 1000, inner: 6 },
  "HC008-W01": { ctn: 1000, inner: 6 },
  "HC008-W02": { ctn: 1000, inner: 6 },
  "HC009-01": { ctn: 360, inner: 12 },
  "HC009-02": { ctn: 360, inner: 12 },
  "HC009-03": { ctn: 360, inner: 12 },
  "HC009-04": { ctn: 360, inner: 12 },
  "HC009-05": { ctn: 360, inner: 12 },
  "HC009-06": { ctn: 360, inner: 12 },
  "HC009-07": { ctn: 360, inner: 12 },
  "HC009-08": { ctn: 360, inner: 12 },
  "HC010": { ctn: 576, inner: 12 },
  "HC015-01": { ctn: 144, inner: 6 },
  "HC015-02": { ctn: 144, inner: 6 },
  "HC015-03": { ctn: 144, inner: 6 },
  "HC016-01": { ctn: 432, inner: 12 },
  "HC016-02": { ctn: 432, inner: 12 },
  "HC016-03": { ctn: 432, inner: 12 },
  "HC016-04": { ctn: 432, inner: 12 },
  "HC018-01": { ctn: 576, inner: 12 },
  "HC018-02": { ctn: 576, inner: 12 },
  "HC020-01": { ctn: 144, inner: 12 },
  "HC020-02": { ctn: 144, inner: 12 },
  "HC020-03": { ctn: 144, inner: 12 },
  "HC020-04": { ctn: 144, inner: 12 },
  "LE003-01": { ctn: 192, inner: 24 },
  "LE003-02": { ctn: 192, inner: 24 },
  "LE003-03": { ctn: 192, inner: 24 },
  "LE009-13": { ctn: 360, inner: 12 },
  "LE009-14": { ctn: 360, inner: 12 },
  "LE009-15": { ctn: 360, inner: 12 },
  "MV001-F01": { ctn: 432, inner: 12 },
  "MV001-F02": { ctn: 432, inner: 12 },
  "MV001-F03": { ctn: 432, inner: 12 },
  "MV001-F04": { ctn: 432, inner: 12 },
  "MV001-F05": { ctn: 432, inner: 12 },
  "MV001-F06": { ctn: 432, inner: 12 },
  "MV001-F07": { ctn: 432, inner: 12 },
  "MV001-F08": { ctn: 432, inner: 12 },
  "PF01-F01": { ctn: 60, inner: 10 },
  "PF01-F02": { ctn: 60, inner: 10 },
  "PF01-F03": { ctn: 60, inner: 10 },
  "PF01-F04": { ctn: 60, inner: 10 },
  "PF02-S01": { ctn: 60, inner: 10 },
  "PF02-S02": { ctn: 60, inner: 10 },
  "PF02-S03": { ctn: 60, inner: 10 },
  "PF02-S04": { ctn: 60, inner: 10 },
  "PS01-F01": { ctn: 600, inner: 30 },
  "PS01-F02": { ctn: 600, inner: 30 },
  "PS01-F03": { ctn: 600, inner: 30 },
  "PS01-F04": { ctn: 600, inner: 30 },
  "PS02-S01": { ctn: 600, inner: 30 },
  "PS02-S02": { ctn: 600, inner: 30 },
  "PS02-S03": { ctn: 600, inner: 30 },
  "PS02-S04": { ctn: 600, inner: 30 },
  "SC023-01": { ctn: 144, inner: 12 },
  "SC023-03": { ctn: 144, inner: 12 },
  "SC028-01": { ctn: 720, inner: 12 },
  "SC028-02": { ctn: 720, inner: 12 },
  "SC028-04": { ctn: 720, inner: 12 },
  "SC029-01": { ctn: 432, inner: 12 },
  "SC029-02": { ctn: 432, inner: 12 },
  "SC029-04": { ctn: 432, inner: 12 },
  "SC030-02": { ctn: 576, inner: 12 },
  "SC030-03": { ctn: 576, inner: 12 },
  "SC032": { ctn: 576, inner: 12 },
  "SC033-H001": { ctn: 720, inner: 12 },
  "SC033-H002": { ctn: 720, inner: 12 },
  "SC033-H003": { ctn: 720, inner: 12 },
  "SC036-L01": { ctn: 576, inner: 12 },
  "SC036-L02": { ctn: 576, inner: 12 },
  "SC036-L03": { ctn: 576, inner: 12 },
  "SC036-L04": { ctn: 576, inner: 12 },
  "SC036-L05": { ctn: 576, inner: 12 },
  "SC036-L07": { ctn: 576, inner: 12 },
  "SC036-L09": { ctn: 576, inner: 12 },
  "SC036-L10": { ctn: 576, inner: 12 },
  "SC036-L11": { ctn: 576, inner: 12 },
  "SC038-C01": { ctn: 96, inner: 12 },
  "SC038-C02": { ctn: 96, inner: 12 },
  "SC038-C03": { ctn: 96, inner: 12 },
  "SC039": { ctn: 150, inner: 1 },
  "SC040-01": { ctn: 1000, inner: 12 },
  "SC040-02": { ctn: 1000, inner: 12 },
  "SC040-03": { ctn: 1000, inner: 12 },
  "SC040-04": { ctn: 1000, inner: 12 },
  "SC042-01": { ctn: 192, inner: 12 },
  "SC042-03": { ctn: 192, inner: 12 },
  "SC043-03": { ctn: 432, inner: 12 },
  "SC043-04": { ctn: 432, inner: 12 },
  "SC043-06": { ctn: 432, inner: 12 },
  "SC044-01": { ctn: 1000, inner: 12 },
  "SC044-02": { ctn: 1000, inner: 12 },
  "SC044-03": { ctn: 1000, inner: 12 },
  "SC044-05": { ctn: 1000, inner: 12 },
  "SC044-06": { ctn: 1000, inner: 12 },
  "SC046": { ctn: 576, inner: 12 },
  "SC047-01": { ctn: 1000, inner: 1 },
  "SC047-02": { ctn: 1000, inner: 1 },
  "SC047-03": { ctn: 1000, inner: 1 },
  "SC047-04": { ctn: 1000, inner: 1 },
  "SC048-01": { ctn: 432, inner: 12 },
  "SC048-02": { ctn: 432, inner: 12 },
  "SC048-03": { ctn: 432, inner: 12 },
  "SC048-04": { ctn: 432, inner: 12 },
  "SC048-05": { ctn: 432, inner: 12 },
  "SC048-06": { ctn: 432, inner: 12 },
  "SC049-01": { ctn: 432, inner: 12 },
  "SC049-02": { ctn: 432, inner: 12 },
  "SC049-03": { ctn: 432, inner: 12 },
  "SC049-04": { ctn: 432, inner: 12 },
  "SC049-05": { ctn: 432, inner: 12 },
  "SC049-06": { ctn: 432, inner: 12 },
  "SC050": { ctn: 720, inner: 12 },
  "SC053-01": { ctn: 216, inner: 12 },
  "SC053-02": { ctn: 216, inner: 12 },
  "SC053-03": { ctn: 216, inner: 12 },
  "SC054-110": { ctn: 72, inner: 6 },
  "SC054-120": { ctn: 72, inner: 6 },
  "SC055-01": { ctn: 144, inner: 12 },
  "SC055-02": { ctn: 144, inner: 12 },
  "SC055-03": { ctn: 144, inner: 12 },
  "SC056": { ctn: 576, inner: 12 },
  "SC057-01": { ctn: 576, inner: 12 },
  "SC057-02": { ctn: 576, inner: 12 },
  "SC057-03": { ctn: 576, inner: 12 },
  "SC057-04": { ctn: 576, inner: 12 },
  "SC057-05": { ctn: 576, inner: 12 },
  "SC057-06": { ctn: 576, inner: 12 },
  "SC057-07": { ctn: 576, inner: 12 },
  "SC057-08": { ctn: 576, inner: 12 },
  "SC059-N110": { ctn: 360, inner: 12 },
  "SC059-N120": { ctn: 360, inner: 12 },
  "SC059-N220": { ctn: 360, inner: 12 },
  "SC059-N230": { ctn: 1000, inner: 12 },
  "SC060": { ctn: 576, inner: 12 },
  "SC061-01": { ctn: 576, inner: 12 },
  "SC061-02": { ctn: 576, inner: 12 },
  "SC061-03": { ctn: 576, inner: 12 },
  "SC061-04": { ctn: 576, inner: 12 },
  "SC063-E01": { ctn: 576, inner: 12 },
  "SC063-E02": { ctn: 576, inner: 12 },
  "SC063-E03": { ctn: 576, inner: 12 },
  "SC063-E04": { ctn: 576, inner: 12 },
  "SC063-E05": { ctn: 576, inner: 12 },
  "SC063-E06": { ctn: 576, inner: 12 },
  "SC064-M11": { ctn: 432, inner: 12 },
  "SC064-M12": { ctn: 432, inner: 12 },
  "SC064-M13": { ctn: 432, inner: 12 },
  "SC064-M14": { ctn: 432, inner: 12 },
  "SC064-M15": { ctn: 432, inner: 12 },
  "SC064-M16": { ctn: 432, inner: 12 },
  "SC064-M17": { ctn: 432, inner: 12 },
  "SC064-M18": { ctn: 432, inner: 12 },
  "SC064-M19": { ctn: 432, inner: 12 },
  "SC064-M20": { ctn: 432, inner: 12 },
  "SC064-M21": { ctn: 432, inner: 12 },
  "SC064-N01": { ctn: 432, inner: 12 },
  "SC064-N02": { ctn: 432, inner: 12 },
  "SC064-N03": { ctn: 432, inner: 12 },
  "SC065-01": { ctn: 720, inner: 12 },
  "SC065-02": { ctn: 720, inner: 12 },
  "SC065-03": { ctn: 720, inner: 12 },
  "SC065-04": { ctn: 720, inner: 12 },
  "SC065-05": { ctn: 1000, inner: 12 },
  "SC065-06": { ctn: 720, inner: 12 },
  "SC066-01": { ctn: 192, inner: 12 },
  "SC066-03": { ctn: 192, inner: 12 },
  "SC067-N110": { ctn: 144, inner: 6 },
  "SC067-N120": { ctn: 144, inner: 6 },
  "SC067-N130": { ctn: 144, inner: 6 },
  "SC069-01": { ctn: 192, inner: 1 },
  "SC069-02": { ctn: 192, inner: 1 },
  "SC069-03": { ctn: 192, inner: 1 },
  "SC076": { ctn: 160, inner: 1 },
  "SC137-W21": { ctn: 1000, inner: 1 },
  "SC138-W03": { ctn: 1000, inner: 1 },
  "SE010-01": { ctn: 432, inner: 12 },
  "SE010-02": { ctn: 432, inner: 12 },
  "SE010-03": { ctn: 432, inner: 12 },
  "SM001-1": { ctn: 2600, inner: 650 },
  "SM001-7": { ctn: 2600, inner: 650 },
  "SM002": { ctn: 2600, inner: 650 },
  "SN010": { ctn: 432, inner: 1 },
  "SN013": { ctn: 1000, inner: 1 },
  "SN014": { ctn: 300, inner: 1 },
  "SN015-04": { ctn: 500, inner: 6 },
  "SN016": { ctn: 150, inner: 1 },
  "SN017": { ctn: 360, inner: 12 },
  "SN019-2": { ctn: 1400, inner: 1 },
  "SN020-01": { ctn: 432, inner: 12 },
  "SN020-02": { ctn: 432, inner: 12 },
  "SN020-03": { ctn: 432, inner: 12 },
  "SN020-04": { ctn: 432, inner: 12 },
  "TZ017-S01": { ctn: 1000, inner: 1 },
  "TZ018": { ctn: 40, inner: 1 },
  "BC-02": { ctn: 1000, inner: 1 },
  "2128": { ctn: 50000, inner: 1 },
  "ZP-MIBS": { ctn: 50000, inner: 1 },
  "2114": { ctn: 50000, inner: 1 },
  "ZP-F006": { ctn: 1000, inner: 1 },
  "2000-2": { ctn: 1000, inner: 1 },
  "SK001": { ctn: 1000, inner: 1 }
};

let DYNAMIC_CATALOG_REGISTRY: Record<string, { ctn: number; inner: number }> = {};

export function updateDynamicCatalogRegistry(items: { skuId: string; qtyCtnSize: number; qtyInnerSize: number }[]) {
  const newRegistry: Record<string, { ctn: number; inner: number }> = {};
  items.forEach(item => {
    if (item.skuId) {
      newRegistry[item.skuId.trim().toUpperCase()] = {
        ctn: item.qtyCtnSize,
        inner: item.qtyInnerSize
      };
    }
  });
  DYNAMIC_CATALOG_REGISTRY = newRegistry;
}

/**
 * Retrieves the precise QTY/CTN and QTY/INNER for a given SKU ID based on user specifications.
 */
export function getProductPackSizes(skuId: string): { qtyCtnSize: number; qtyInnerSize: number } {
  if (!skuId) return { qtyCtnSize: 720, qtyInnerSize: 12 };
  
  const cleanId = skuId.trim().toUpperCase();

  // Dynamic catalog check first
  if (DYNAMIC_CATALOG_REGISTRY[cleanId]) {
    return {
      qtyCtnSize: DYNAMIC_CATALOG_REGISTRY[cleanId].ctn,
      qtyInnerSize: DYNAMIC_CATALOG_REGISTRY[cleanId].inner
    };
  }

  // Exact matches first
  if (SKU_SIZE_MAP[cleanId]) {
    return {
      qtyCtnSize: SKU_SIZE_MAP[cleanId].ctn,
      qtyInnerSize: SKU_SIZE_MAP[cleanId].inner
    };
  }

  // Prefix/partial matches if we can find them
  const keys = Object.keys(SKU_SIZE_MAP);
  for (const key of keys) {
    if (cleanId.startsWith(key) || key.startsWith(cleanId)) {
      return {
        qtyCtnSize: SKU_SIZE_MAP[key].ctn,
        qtyInnerSize: SKU_SIZE_MAP[key].inner
      };
    }
  }

  // General fallback patterns based on prefixes if any
  if (cleanId.startsWith('1014-')) {
    return { qtyCtnSize: 600, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('9144-')) {
    return { qtyCtnSize: 720, qtyInnerSize: 60 };
  } else if (cleanId.startsWith('HC002-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC003-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC004-')) {
    return { qtyCtnSize: 96, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC005-')) {
    return { qtyCtnSize: 192, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC006-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC007-')) {
    return { qtyCtnSize: 720, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC008-')) {
    return { qtyCtnSize: 1000, qtyInnerSize: 6 };
  } else if (cleanId.startsWith('HC009-')) {
    return { qtyCtnSize: 360, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC015-')) {
    return { qtyCtnSize: 144, qtyInnerSize: 6 };
  } else if (cleanId.startsWith('HC016-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC018-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('HC020-')) {
    return { qtyCtnSize: 144, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('LE003-')) {
    return { qtyCtnSize: 192, qtyInnerSize: 24 };
  } else if (cleanId.startsWith('LE009-')) {
    return { qtyCtnSize: 360, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('MV001-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('PF01-')) {
    return { qtyCtnSize: 60, qtyInnerSize: 10 };
  } else if (cleanId.startsWith('PF02-')) {
    return { qtyCtnSize: 60, qtyInnerSize: 10 };
  } else if (cleanId.startsWith('PS01-')) {
    return { qtyCtnSize: 600, qtyInnerSize: 30 };
  } else if (cleanId.startsWith('PS02-')) {
    return { qtyCtnSize: 600, qtyInnerSize: 30 };
  } else if (cleanId.startsWith('SC023-')) {
    return { qtyCtnSize: 144, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC028-')) {
    return { qtyCtnSize: 720, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC029-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC030-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC033-')) {
    return { qtyCtnSize: 720, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC036-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC038-')) {
    return { qtyCtnSize: 96, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC040-')) {
    return { qtyCtnSize: 1000, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC042-')) {
    return { qtyCtnSize: 192, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC043-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC044-')) {
    return { qtyCtnSize: 1000, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC047-')) {
    return { qtyCtnSize: 1000, qtyInnerSize: 1 };
  } else if (cleanId.startsWith('SC048-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC049-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC053-')) {
    return { qtyCtnSize: 216, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC054-')) {
    return { qtyCtnSize: 72, qtyInnerSize: 6 };
  } else if (cleanId.startsWith('SC055-')) {
    return { qtyCtnSize: 144, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC057-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC059-')) {
    return { qtyCtnSize: 360, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC061-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC063-')) {
    return { qtyCtnSize: 576, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC064-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC065-')) {
    return { qtyCtnSize: 720, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC066-')) {
    return { qtyCtnSize: 192, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SC067-')) {
    return { qtyCtnSize: 144, qtyInnerSize: 6 };
  } else if (cleanId.startsWith('SC069-')) {
    return { qtyCtnSize: 192, qtyInnerSize: 1 };
  } else if (cleanId.startsWith('SE010-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  } else if (cleanId.startsWith('SM001-')) {
    return { qtyCtnSize: 2600, qtyInnerSize: 650 };
  } else if (cleanId.startsWith('SN015-')) {
    return { qtyCtnSize: 500, qtyInnerSize: 6 };
  } else if (cleanId.startsWith('SN020-')) {
    return { qtyCtnSize: 432, qtyInnerSize: 12 };
  }

  return { qtyCtnSize: 720, qtyInnerSize: 12 };
}

/**
 * Generates a unified canonical ID for a stock item based on SKU, expired date, location, and optional warehouse.
 */
export function getCanonicalStockId(skuId: string, expiredDate: string, location: string, warehouseId?: string): string {
  const cleanSku = (skuId || '').trim().toUpperCase();
  let cleanLoc = (location || '').trim().toUpperCase();
  if (cleanLoc === 'RAK KAYU') {
    cleanLoc = 'RACK DISPLAY';
  }
  const normalizedEd = normalizeDateToDmy(expiredDate) || 'No Expired';
  const cleanWh = (warehouseId || 'WH-CENTRAL').trim().toUpperCase();
  if (!cleanWh || cleanWh === 'WH-CENTRAL') {
    return `${cleanSku}_${normalizedEd.replace(/[\/\-\. ]/g, '_')}_${cleanLoc.replace(/[\/\-\. ]/g, '_')}`;
  }
  return `${cleanWh}_${cleanSku}_${normalizedEd.replace(/[\/\-\. ]/g, '_')}_${cleanLoc.replace(/[\/\-\. ]/g, '_')}`;
}

/**
 * Finds the index of a stock item in an array using canonical ID matching with robust fallbacks.
 */
export function findStockIndex(
  stockList: StockItem[],
  skuId: string,
  expiredDate: string,
  location: string,
  targetId?: string,
  warehouseId?: string
): number {
  const cleanWh = (warehouseId || 'WH-CENTRAL').trim().toUpperCase();
  const canonicalId = targetId || getCanonicalStockId(skuId, expiredDate, location, cleanWh);
  
  // 1. Direct canonical ID match
  let idx = stockList.findIndex(item => item.id === canonicalId);
  if (idx > -1) return idx;

  // 2. Computed canonical ID match
  idx = stockList.findIndex(item => getCanonicalStockId(item.skuId, item.expiredDate, item.location, item.warehouseId) === canonicalId);
  if (idx > -1) return idx;

  // 3. Fallback: Normalized field match with whitespace/symbol relaxation
  const cleanSku = (skuId || '').trim().toLowerCase();
  const cleanLoc = (location || '').trim().toLowerCase().replace(/[-_\s]/g, '');
  const normEd = normalizeDateToDmy(expiredDate) || 'No Expired';

  idx = stockList.findIndex(item => {
    const itemSku = (item.skuId || '').trim().toLowerCase();
    const itemLoc = (item.location || '').trim().toLowerCase().replace(/[-_\s]/g, '');
    const itemEd = normalizeDateToDmy(item.expiredDate) || 'No Expired';
    const itemWh = (item.warehouseId || 'WH-CENTRAL').trim().toUpperCase();
    const edMatches = itemEd === normEd || normEd === 'No Expired' || itemEd === 'No Expired';
    return itemSku === cleanSku && itemLoc === cleanLoc && edMatches && (cleanWh === 'ALL' || itemWh === cleanWh);
  });
  if (idx > -1) return idx;

  // 4. Fallback: Match by SKU and warehouse (and location if possible)
  idx = stockList.findIndex(item => {
    const itemSku = (item.skuId || '').trim().toLowerCase();
    const itemWh = (item.warehouseId || 'WH-CENTRAL').trim().toUpperCase();
    const itemLoc = (item.location || '').trim().toLowerCase().replace(/[-_\s]/g, '');
    return itemSku === cleanSku && (cleanWh === 'ALL' || itemWh === cleanWh) && (itemLoc === cleanLoc || !cleanLoc);
  });

  return idx;
}

/**
 * Deduplicates stock items by merging their quantities if they have the same SKU, expired date, location, and warehouse.
 * Also recalculates SKU total quantities (totalQtySku) across all locations to maintain cross-device sync.
 */
export function deduplicateAndMergeStock(items: StockItem[]): StockItem[] {
  const map = new Map<string, StockItem>();
  items.forEach(item => {
    const cleanSku = (item.skuId || '').trim().toUpperCase();
    let location = (item.location || '').trim().toUpperCase();
    if (location === 'RAK KAYU') {
      location = 'RACK DISPLAY';
    }
    const warehouseId = item.warehouseId || 'WH-CENTRAL';
    const warehouseName = item.warehouseName || (warehouseId === 'WH-CENTRAL' ? 'Gudang Pusat (Jakarta)' : warehouseId);
    const normalizedEd = normalizeDateToDmy(item.expiredDate) || 'No Expired';
    const cleanId = getCanonicalStockId(cleanSku, normalizedEd, location, warehouseId);
    const calculatedStatus = getStockStatus({...item,expiredDate:normalizedEd});
    const sanitizedQty = Math.max(0, Math.floor(Number(item.qty) || 0));

    const { qtyCtnSize: catalogCtn, qtyInnerSize: catalogInner } = getProductPackSizes(cleanSku);
    const qtyCtnSize = catalogCtn || Math.max(1, Math.floor(Number(item.qtyCtnSize) || 720));
    const qtyInnerSize = catalogInner || Math.max(1, Math.floor(Number(item.qtyInnerSize) || 12));
    const sourceIds = Array.isArray(item.__wms_source_ids) && item.__wms_source_ids.length
      ? [...new Set(item.__wms_source_ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [item.id];
    const sourceRevisions = { ...(item.__wms_source_revisions || {}) };
    if (item.__wms_revision_document_id && Number.isSafeInteger(item.__wms_revision)) {
      sourceRevisions[item.__wms_revision_document_id] = item.__wms_revision!;
    }

    if (map.has(cleanId)) {
      const existing = map.get(cleanId)!;
      const newQty = existing.qty + sanitizedQty;
      const splits = calculatePackQuantities(newQty, qtyCtnSize, qtyInnerSize);
      const mergedSourceRevisions = { ...(existing.__wms_source_revisions || {}) };
      Object.assign(mergedSourceRevisions, sourceRevisions);
      map.set(cleanId, {
        ...existing,
        id: cleanId,
        skuId: cleanSku,
        location,
        warehouseId,
        warehouseName,
        expiredDate: normalizedEd,
        qty: newQty,
        qtyCtnSize,
        qtyInnerSize,
        qtyCtn: splits.qtyCtn,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose,
        status: ['Damage','Expired','Karantina'].includes(existing.status)?existing.status:calculatedStatus,
        __wms_source_ids: [...new Set([...(existing.__wms_source_ids || [existing.id]), ...sourceIds])],
        __wms_source_revisions: mergedSourceRevisions
      });
    } else {
      const splits = calculatePackQuantities(sanitizedQty, qtyCtnSize, qtyInnerSize);
      map.set(cleanId, {
        ...item,
        id: cleanId,
        skuId: cleanSku,
        location,
        warehouseId,
        warehouseName,
        expiredDate: normalizedEd,
        qty: sanitizedQty,
        qtyCtnSize,
        qtyInnerSize,
        qtyCtn: splits.qtyCtn,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose,
        status: calculatedStatus,
        __wms_source_ids: sourceIds,
        __wms_source_revisions: sourceRevisions
      });
    }
  });

  // Calculate SKU-wide total quantity (totalQtySku) across all locations and warehouses
  const skuTotals: Record<string, number> = {};
  map.forEach(item => {
    skuTotals[item.skuId] = (skuTotals[item.skuId] || 0) + item.qty;
  });

  const result: StockItem[] = [];
  map.forEach(item => {
    result.push({
      ...item,
      totalQtySku: skuTotals[item.skuId] || 0
    });
  });

  return result;
}

export interface LockedStockSummary {
  byCanonicalId: Map<string, number>;
  bySku: Map<string, number>;
  byWarehouseSku: Map<string, number>;
  bySkuLocation: Map<string, number>;
  totalLockedQty: number;
  lockedOrdersCount: number;
  lockedOrderRefs: Set<string>;
}

/**
 * Calculates stock quantity locked by active pending orders that have not yet been physically deducted from racks.
 */
export function getLockedStockSummary(orderHistory: OutboundItem[] | undefined): LockedStockSummary {
  const byCanonicalId = new Map<string, number>();
  const bySku = new Map<string, number>();
  const byWarehouseSku = new Map<string, number>();
  const bySkuLocation = new Map<string, number>();
  const lockedOrderRefs = new Set<string>();
  let totalLockedQty = 0;

  if (!orderHistory || !Array.isArray(orderHistory)) {
    return {
      byCanonicalId,
      bySku,
      byWarehouseSku,
      bySkuLocation,
      totalLockedQty: 0,
      lockedOrdersCount: 0,
      lockedOrderRefs
    };
  }

  orderHistory.forEach(item => {
    // Only items that are in Pending status and not yet physically deducted from racks represent locked/reserved stock
    const isLocked = item.status === 'Pending' && item.stockDeducted !== true;
    if (!isLocked || item.qty <= 0) return;

    const sku = (item.skuId || '').trim().toUpperCase();
    const loc = (item.location || '').trim().toUpperCase();
    const normEd = normalizeDateToDmy(item.expiredDate) || 'No Expired';
    const whId = (item.warehouseId || 'WH-CENTRAL').trim().toUpperCase();
    const canonicalId = getCanonicalStockId(sku, normEd, loc, whId);
    const skuLocKey = `${whId}__${sku}__${loc}`;
    const whSkuKey = `${whId}__${sku}`;

    byCanonicalId.set(canonicalId, (byCanonicalId.get(canonicalId) || 0) + item.qty);
    bySku.set(sku, (bySku.get(sku) || 0) + item.qty);
    byWarehouseSku.set(whSkuKey, (byWarehouseSku.get(whSkuKey) || 0) + item.qty);
    bySkuLocation.set(skuLocKey, (bySkuLocation.get(skuLocKey) || 0) + item.qty);
    
    totalLockedQty += item.qty;
    if (item.referenceNumber) {
      lockedOrderRefs.add(item.referenceNumber);
    }
  });

  return {
    byCanonicalId,
    bySku,
    byWarehouseSku,
    bySkuLocation,
    totalLockedQty,
    lockedOrdersCount: lockedOrderRefs.size,
    lockedOrderRefs
  };
}

/**
 * Generates an available stock pool (free to be ordered) by subtracting locked pending order quantities
 * from physical stock. Recalculates pack splits and totalQtySku per SKU.
 */
export function getAvailableStockPool(
  stock: StockItem[], 
  orderHistory: OutboundItem[] | undefined
): StockItem[] {
  const lockedSummary = getLockedStockSummary(orderHistory);

  const availableItems: StockItem[] = stock.map(item => {
    const canonicalId = getCanonicalStockId(item.skuId, item.expiredDate, item.location, item.warehouseId);
    const lockedQty = lockedSummary.byCanonicalId.get(canonicalId) || (item.id && item.id !== canonicalId ? lockedSummary.byCanonicalId.get(item.id) || 0 : 0);
    const availableQty = isStockPickable(item) ? Math.max(0, item.qty - lockedQty) : 0;

    const splits = calculatePackQuantities(
      availableQty, 
      item.qtyCtnSize || 144, 
      item.qtyInnerSize || 12
    );

    return {
      ...item,
      qty: availableQty,
      qtyCtn: splits.qtyCtn,
      qtyInner: splits.qtyInner,
      qtyLoose: splits.qtyLoose
    };
  });

  // Recalculate available totalQtySku across all locations
  const skuAvailableTotals: Record<string, number> = {};
  availableItems.forEach(item => {
    skuAvailableTotals[item.skuId] = (skuAvailableTotals[item.skuId] || 0) + item.qty;
  });

  return availableItems.map(item => ({
    ...item,
    totalQtySku: skuAvailableTotals[item.skuId] || 0
  }));
}

/**
 * Returns physical, locked, and available stock breakdown for a specific stock line item.
 */
export function getItemStockBreakdown(
  item: StockItem,
  orderHistory: OutboundItem[] | undefined | LockedStockSummary
): { physicalQty: number; lockedQty: number; availableQty: number } {
  const lockedSummary = (orderHistory && 'byCanonicalId' in orderHistory)
    ? orderHistory as LockedStockSummary
    : getLockedStockSummary(orderHistory as OutboundItem[] | undefined);

  const canonicalId = getCanonicalStockId(item.skuId, item.expiredDate, item.location, item.warehouseId);
  const lockedQty = lockedSummary.byCanonicalId.get(canonicalId) || (item.id && item.id !== canonicalId ? lockedSummary.byCanonicalId.get(item.id) || 0 : 0);
  const physicalQty = item.qty;
  const availableQty = isStockPickable(item) ? Math.max(0, physicalQty - lockedQty) : 0;

  return { physicalQty, lockedQty, availableQty };
}

/**
 * Helper to check if a location belongs to Zone 1 or Urban Storage.
 * These locations are designated as buffer/reserve areas where direct picking (outbound) is strictly forbidden.
 */
// Proteksi lokasi Zone 1 dan Urban dinonaktifkan sesuai kebutuhan transfer stok ke sub-warehouse & picking
export const isZoneOrUrbanLocation = (_locationName?: string | null): boolean => {
  return false;
};




