import type { BranchOperationType, ChannelOperationType, OrderType } from '../types';

export const TRUSTED_ONLINE_MARKETPLACE_SOURCES = [
  'SHOPEE',
  'TIKTOK',
  'TIKTOK_SHOP',
  'TOKOPEDIA',
  'LAZADA',
  'BLIBLI',
  'MABANG',
  'JUBELIO',
] as const;

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

export function classifyWebhookOrderType(
  payload: Record<string, unknown> | null | undefined
): {
  orderType: OrderType;
  orderSource: string;
  trusted: boolean;
} {
  if (!payload || typeof payload !== 'object') {
    return { orderType: 'UNASSIGNED', orderSource: 'WEBHOOK_UNKNOWN', trusted: false };
  }

  const rawSource = String(
    payload.orderSource ??
      payload.order_source ??
      payload.marketplace ??
      payload.platform ??
      payload.source ??
      ''
  )
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');

  const explicit = normalizeOrderType(payload.orderType ?? payload.order_type);
  if (explicit === 'B2B' || explicit === 'ONLINE') {
    return {
      orderType: explicit,
      orderSource: rawSource || 'WEBHOOK_EXPLICIT',
      trusted: true,
    };
  }

  if (
    rawSource &&
    (TRUSTED_ONLINE_MARKETPLACE_SOURCES as readonly string[]).includes(rawSource)
  ) {
    return {
      orderType: 'ONLINE',
      orderSource: rawSource,
      trusted: true,
    };
  }

  return {
    orderType: 'UNASSIGNED',
    orderSource: rawSource || 'WEBHOOK_UNKNOWN',
    trusted: false,
  };
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

export function isOrderVisibleForBranchManifest(
  order: {
    orderType?: unknown;
    order_type?: unknown;
  } | null | undefined,
  branchOp: BranchOperationType,
  filterChannel: 'ALL' | ChannelOperationType = 'ALL'
): boolean {
  const type = resolveOrderType(order);
  if (type === 'UNASSIGNED') return false;
  if (!branchSupportsOperation(branchOp, type)) return false;
  if (filterChannel !== 'ALL' && type !== filterChannel) return false;
  return true;
}

export function validateManifestOrderSelection(
  orders: Array<{
    orderType?: unknown;
    order_type?: unknown;
    shipped?: unknown;
  }>,
  branchOp: BranchOperationType
): {
  ok: boolean;
  orderType?: ChannelOperationType;
  error?: string;
} {
  if (!Array.isArray(orders) || orders.length === 0) {
    return {
      ok: false,
      error: 'Pilih minimal 1 order untuk dibuatkan manifest.',
    };
  }

  const foundTypes = new Set<ChannelOperationType>();
  for (const order of orders) {
    if (order?.shipped) {
      return {
        ok: false,
        error: 'Ada order yang sudah tercatat terkirim pada manifest lain.',
      };
    }

    const type = resolveOrderType(order);
    if (type === 'UNASSIGNED') {
      return {
        ok: false,
        error:
          'Order berstatus UNASSIGNED harus diklasifikasikan sebagai B2B atau ONLINE oleh Admin sebelum masuk manifest.',
      };
    }

    if (!branchSupportsOperation(branchOp, type)) {
      return {
        ok: false,
        error: `Cabang bertipe ${branchOp} tidak mengizinkan manifest order ${type}.`,
      };
    }

    foundTypes.add(type);
  }

  if (foundTypes.size > 1) {
    return {
      ok: false,
      error:
        'Manifest B2B dan Manifest Online harus terpisah dan tidak boleh digabung dalam satu dokumen.',
    };
  }

  return {
    ok: true,
    orderType: Array.from(foundTypes)[0],
  };
}

export function formatOrderTypeBadge(type: OrderType): string {
  if (type === 'B2B') return 'B2B';
  if (type === 'ONLINE') return 'ONLINE';
  return 'UNASSIGNED';
}
