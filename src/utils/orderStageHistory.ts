import type {OutboundItem} from '../types';

export function formatProcessTime(value?: string): string {
 if (!value?.trim() || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return 'Belum tercatat';
 const date = new Date(value);
 if (!Number.isFinite(date.getTime())) return 'Belum tercatat';
 return new Intl.DateTimeFormat('id-ID', {timeZone:'Asia/Jakarta',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date).replace(/\./g, ':')+' WIB';
}

export function getOrderStageHistory(item: OutboundItem) {
 return [
  {stage:'Input',name:item.createdBy,processedAt:item.createdAt},
  {stage:'Picking',name:item.pickedBy,processedAt:item.pickedAt},
  {stage:'Sortir',name:item.sortedBy,processedAt:item.sortedAt},
  {stage:'Packing / Validasi',name:item.packedBy,processedAt:item.packedAt},
 ].map(row=>({...row,name:row.name?.trim()||'Belum tercatat',timeLabel:formatProcessTime(row.processedAt)}));
}
