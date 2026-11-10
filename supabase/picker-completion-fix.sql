-- ==============================================================================
-- IZIN PENUH OPERATOR PICKER / PACKER & PENGHAPUSAN RESTRIKSI STOK
-- Jalankan skrip ini langsung di Supabase Dashboard -> SQL Editor -> Run
-- ==============================================================================

-- 1. Izinkan pengambilan stok di seluruh area (tidak ada blokir karantina/buffer)
create or replace function wms_private.stock_pickable(p jsonb) returns boolean language sql immutable set search_path='' as $$
 select true;
$$;

-- 2. Izinkan operator (Picker & Packer) memproses mutasi stok dan order
--    Menghapus error "Operator tidak boleh menambah atau mengganti identitas stok"
--    Menghapus pembatasan hapus dokumen, perubahan alokasi, dan batasan identitas stok
create or replace function wms_private.validate_operational_write(b text,ups jsonb,dels jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare r text; i jsonb; p jsonb; oldp jsonb; c text; q numeric;
begin
 select role into r from public.profiles where id=auth.uid() and is_active;
 if r is null or r not in ('Administrator','Admin','Picker','Packer') then raise exception 'Peran tidak boleh menulis';end if;

 -- Batasi operator hanya pada koleksi operasional (orders, stock, logs, batches)
 for i in select value from jsonb_array_elements(ups||dels) loop
  c=i->>'collection_name';
  if r in ('Picker','Packer') and c not in ('orders','stock','logs','batches') then 
    raise exception 'Peran operator tidak boleh mengubah koleksi %',c;
  end if;
 end loop;

 -- Validasi data dasar stok & order
 for i in select value from jsonb_array_elements(ups) loop
  c=i->>'collection_name';
  select payload into oldp from public.wms_documents where branch_id=b and collection_name=c and document_id=i->>'document_id';
  p=case when coalesce((i->>'merge')::boolean,false) then coalesce(oldp,'{}')||(i->'payload') else i->'payload' end;
  if c='stock' then
   if jsonb_typeof(p->'qty') is distinct from 'number' then raise exception 'Jumlah stok harus angka bulat';end if;
   q=(p->>'qty')::numeric;
   if q<0 or q<>trunc(q) or q>9007199254740991 then raise exception 'Jumlah stok tidak valid';end if;
   if coalesce(trim(p->>'skuId'),'')='' or coalesce(trim(p->>'location'),'')='' then raise exception 'Identitas stok wajib lengkap';end if;
  elsif c='orders' then
   if jsonb_typeof(p->'qty') is distinct from 'number' or (p->>'qty')::numeric<=0 or (p->>'qty')::numeric<>trunc((p->>'qty')::numeric) then raise exception 'Jumlah order harus bilangan bulat positif';end if;
   if coalesce(p->>'status','') not in ('Pending','Completed','Cancelled') then raise exception 'Status order tidak valid';end if;
  end if;
 end loop;
end;$$;

revoke all on function wms_private.stock_pickable(jsonb),wms_private.validate_operational_write(text,jsonb,jsonb) from public,anon,authenticated;
