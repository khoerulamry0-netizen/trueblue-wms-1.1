import type { BranchOperationType, ChannelOperationType, OrderType } from '../types';

export function normalizeBranchOperationType(
  value: unknown,
  fallback: BranchOperationType = 'HYBRID'
): BranchOperationType {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'B2B' || normalized === 'ONLINE' || normalized === 'HYBRID') {
    return normalized;
  }
  return fallback;
}

export function normalizeOrderType(value: unknown): OrderType {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'B2B' || normalized === 'ONLINE') {
    return normalized;
  }
  return 'UNASSIGNED';
}

/**
 * Resolves an order's operational type strictly from explicit persisted metadata.
 * Legacy orders without explicit orderType stay UNASSIGNED — never inferred from PO or customer name.
 */
export function resolveOrderType(order: {
  orderType?: unknown;
  order_type?: unknown;
} | null | undefined): OrderType {
  if (!order) return 'UNASSIGNED';
  return normalizeOrderType(order.orderType ?? order.order_type);
}

export function branchSupportsOperation(
  branchOp: BranchOperationType,
  op: ChannelOperationType
): boolean {
  if (branchOp === 'HYBRID') return true;
  return branchOp === op;
}

export function isQuickOutboundItem(order: {
  outboundType?: unknown;
  isQuickOutbound?: unknown;
} | null | undefined): boolean {
  if (!order) return false;
  return Boolean(order.isQuickOutbound) || order.outboundType === 'quick';
}

export function isOrderVisibleForOperation(
  order: {
    orderType?: unknown;
    order_type?: unknown;
  } | null | undefined,
  channel: ChannelOperationType,
  branchOp: BranchOperationType = 'HYBRID'
): boolean {
  if (!order) return false;
  if (!branchSupportsOperation(branchOp, channel)) return false;
  return resolveOrderType(order) === channel;
}

export function formatOrderTypeBadge(type: OrderType): string {
  if (type === 'B2B') return 'B2B';
  if (type === 'ONLINE') return 'ONLINE';
  return 'UNASSIGNED';
}
