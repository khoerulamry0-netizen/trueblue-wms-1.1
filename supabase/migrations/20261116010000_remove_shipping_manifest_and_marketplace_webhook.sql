-- Retire Shipping Manifest and Marketplace Webhook.
-- Keep this as a forward migration so existing migration history remains intact.

drop function if exists public.commit_shipping_manifest(uuid, text, text[], jsonb, text);
drop function if exists public.marketplace_order_webhook(jsonb, text);
drop table if exists public.shipping_manifests cascade;
