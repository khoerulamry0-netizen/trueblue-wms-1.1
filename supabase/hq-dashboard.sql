
create function wms_private.dashboard_expiry_date(raw text) returns date
language plpgsql immutable set search_path='' as $$
declare normalized text;
begin
 normalized=wms_private.transfer_expired_date(raw);
 if normalized='No Expired' then return null;end if;
 return make_date(split_part(normalized,'/',3)::integer,split_part(normalized,'/',2)::integer,split_part(normalized,'/',1)::integer);
exception when others then return null;
end;$$;
revoke all on function wms_private.dashboard_expiry_date(text) from public,anon,authenticated;
create function wms_private.hq_dashboard(p_low_stock integer,p_near_days integer,p_branch_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;today date=(now() at time zone 'Asia/Jakarta')::date;
begin
 if auth.uid() is null or not wms_private.is_hq() then raise exception 'Dashboard jaringan hanya untuk Administrator kantor pusat';end if;
 if p_low_stock is null or p_low_stock not between 0 and 1000000 or p_near_days is null or p_near_days not between 1 and 730 then raise exception 'Batas stok atau periode kedaluwarsa tidak valid';end if;
 if p_branch_id is not null and not exists(select 1 from public.branches where id=p_branch_id) then raise exception 'Cabang tidak ditemukan';end if;
 with
 selected_branches as(select id,name from public.branches where p_branch_id is null or id=p_branch_id),
 stock as materialized(
 select d.branch_id,d.document_id,upper(trim(d.payload->>'skuId')) sku_id,coalesce(d.payload->>'skuName',d.payload->>'skuId') sku_name,
 d.payload->>'location' location,d.payload->>'expiredDate' expired_text,
 coalesce((d.payload->>'qty')::numeric,0) qty,
 wms_private.dashboard_expiry_date(d.payload->>'expiredDate') expiry_date,
 lower(coalesce(d.payload->>'status','')) raw_status
 from public.wms_documents d join selected_branches b on b.id=d.branch_id
 where d.collection_name='stock' and left(d.document_id,7)<>'SYSTEM_'
 ),
 classified as materialized(
 select *,case
 when raw_status like '%damage%' or lower(coalesce(expired_text,'')) like '%damage%' then 'DAMAGE'
 when expiry_date<=today or raw_status='expired' or lower(coalesce(expired_text,''))='expired' then 'EXPIRED'
 when expiry_date>today and expiry_date<=today+p_near_days then 'NEAR'
 when expiry_date is null and lower(trim(coalesce(expired_text,''))) not in ('','-','no expired','no ed','no_expired','noed') then 'INVALID_DATE'
 else 'SAFE' end category from stock
 ),
 sku_sources as(
 select branch_id,sku_id,sku_name,qty from stock
 union all
 select d.branch_id,upper(trim(coalesce(d.payload->>'skuId',d.document_id))),coalesce(d.payload->>'skuName',d.payload->>'skuId',d.document_id),0::numeric
 from public.wms_documents d join selected_branches b on b.id=d.branch_id where collection_name='catalog'
 ),
 sku_totals as(select branch_id,sku_id,max(sku_name) sku_name,sum(qty) qty from sku_sources where coalesce(sku_id,'')<>'' group by branch_id,sku_id),
 stock_summary as(
 select branch_id,sum(qty) total_qty,coalesce(sum(qty) filter(where category='EXPIRED'),0) expired_qty,
 coalesce(sum(qty) filter(where category='NEAR'),0) near_qty,coalesce(sum(qty) filter(where category='DAMAGE'),0) damage_qty,
 count(*) filter(where category='INVALID_DATE' and qty>0) invalid_date_rows
 from classified group by branch_id
 ),
 sku_summary as(select branch_id,count(*) filter(where qty>0) active_skus,count(*) filter(where qty<=p_low_stock) low_skus,count(*) filter(where qty=0) empty_skus from sku_totals group by branch_id),
 order_summary as(select d.branch_id,count(*) pending_orders from public.wms_documents d join selected_branches b on b.id=d.branch_id where collection_name='orders' and coalesce(payload->>'status','Pending')='Pending' group by d.branch_id),
 pending as materialized(
 select t.id,t.source_branch,t.destination_branch,t.status,t.created_at,t.updated_at,
 (select coalesce(sum((value->>'qty')::numeric),0) from jsonb_array_elements(t.items)) qty,
 t.created_at<now()-interval '24 hours' overdue
 from public.branch_transfers t where status in ('DRAFT','SHIPPED','IN_TRANSIT')
 and (p_branch_id is null or source_branch=p_branch_id or destination_branch=p_branch_id)
 ),
 branch_rows as(
 select b.id,b.name,coalesce(s.total_qty,0) total_qty,coalesce(k.active_skus,0) active_skus,
 coalesce(k.low_skus,0) low_skus,coalesce(k.empty_skus,0) empty_skus,coalesce(s.near_qty,0) near_qty,
 coalesce(s.expired_qty,0) expired_qty,coalesce(s.damage_qty,0) damage_qty,coalesce(s.invalid_date_rows,0) invalid_date_rows,
 coalesce(o.pending_orders,0) pending_orders,
 (select count(*) from pending where source_branch=b.id) outgoing_transfers,
 (select count(*) from pending where destination_branch=b.id) incoming_transfers,
 (select max(created_at) from public.branch_backups where branch_id=b.id and kind='DAILY') last_daily_backup
 from selected_branches b left join stock_summary s on s.branch_id=b.id left join sku_summary k on k.branch_id=b.id left join order_summary o on o.branch_id=b.id
 )
 select jsonb_build_object(
 'as_of',now(),'today_wib',today,'low_stock_threshold',p_low_stock,'near_expiry_days',p_near_days,
 'totals',jsonb_build_object(
 'branches',(select count(*) from selected_branches),'qty',(select coalesce(sum(qty),0) from stock),
 'active_skus',(select count(distinct sku_id) from sku_totals where qty>0),
 'low_sku_positions',(select count(*) from sku_totals where qty<=p_low_stock),
 'empty_sku_positions',(select count(*) from sku_totals where qty=0),
 'near_qty',(select coalesce(sum(qty),0) from classified where category='NEAR'),
 'expired_qty',(select coalesce(sum(qty),0) from classified where category='EXPIRED'),
 'damage_qty',(select coalesce(sum(qty),0) from classified where category='DAMAGE'),
 'invalid_date_rows',(select count(*) from classified where category='INVALID_DATE' and qty>0),
 'pending_orders',(select coalesce(sum(pending_orders),0) from order_summary),
 'pending_transfers',(select count(*) from pending),'overdue_transfers',(select count(*) from pending where overdue)
 ),
 'branches',(select coalesce(jsonb_agg(to_jsonb(br) order by br.id),'[]') from branch_rows br),
 'low_stock',(select coalesce(jsonb_agg(to_jsonb(l) order by l.qty,l.branch_id,l.sku_id),'[]') from (select * from sku_totals where qty<=p_low_stock order by qty,branch_id,sku_id limit 100)l),
 'expiry_alerts',(select coalesce(jsonb_agg(to_jsonb(e) order by e.expiry_date nulls last,e.branch_id,e.sku_id),'[]') from (select branch_id,sku_id,sku_name,location,expired_text,expiry_date,qty,category from classified where qty>0 and category<>'SAFE' order by expiry_date nulls last,branch_id,sku_id limit 100)e),
 'pending_transfers',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at),'[]') from (select * from pending order by created_at limit 100)t),
 'list_limit',100
 ) into result;
 return result;
end;$$;
revoke all on function wms_private.hq_dashboard(integer,integer,text) from public,anon;
grant execute on function wms_private.hq_dashboard(integer,integer,text) to authenticated;
create function public.hq_dashboard(p_low_stock integer default 10,p_near_days integer default 90,p_branch_id text default null)
returns jsonb language sql stable security invoker set search_path='' as $$select wms_private.hq_dashboard(p_low_stock,p_near_days,p_branch_id)$$;
revoke all on function public.hq_dashboard(integer,integer,text) from public,anon;
grant execute on function public.hq_dashboard(integer,integer,text) to authenticated;
