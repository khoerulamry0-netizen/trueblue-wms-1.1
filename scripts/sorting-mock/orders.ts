import type { OutboundItem } from '../../src/types';

export type MockOrder = OutboundItem & { sortingState: 'pending' | 'finished' };

export function selectSortingOrders(orders: MockOrder[], savedTask: string | null): OutboundItem[] {
  let recoverable = new Set<string>();
  if (savedTask) {
    const task: unknown = JSON.parse(savedTask);
    if (!Array.isArray(task) || !task.length || task.some(entry =>
      !entry || typeof entry.reference !== 'string' || typeof entry.basket !== 'string')) {
      throw new Error('Tugas sorting mock tersimpan tidak valid. Gunakan Reset sesi mock.');
    }
    const references = task.map(entry => entry.reference as string);
    if (new Set(references).size !== references.length || references.some(ref => !orders.some(order => order.referenceNumber === ref))) {
      throw new Error('Tugas sorting mock tidak cocok dengan server. Gunakan Reset sesi mock.');
    }
    recoverable = new Set(references);
  }
  return orders.filter(order => order.sortingState === 'pending' || recoverable.has(order.referenceNumber));
}

export function parseOrders(value: unknown): MockOrder[] {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' ||
      typeof row.referenceNumber !== 'string' || typeof row.id !== 'string' ||
      (row.sortingState !== 'pending' && row.sortingState !== 'finished'))) {
    throw new Error('Snapshot order mock tidak valid.');
  }
  return value as MockOrder[];
}

export const sortingTaskKey = `wms-sorting-task-v1:${JSON.stringify(['MOCK-BRANCH', 'mock-packer'])}`;
