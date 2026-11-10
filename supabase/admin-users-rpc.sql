-- ==============================================================================
-- RPC FUNCTION: admin_manage_user
-- Memungkinkan Admin membuat, mengedit, dan menghapus operator gudang langsung
-- dari database Postgres tanpa perlu Deno / Edge Function.
-- ==============================================================================

create or replace function public.admin_manage_user(body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_actor_active boolean;
  v_actor_branch text;
  v_actor_name text;
  v_action text := body->>'action';
  v_username text;
  v_email text;
  v_password text;
  v_full_name text;
  v_role text;
  v_branch_id text;
  v_target_id uuid;
  v_new_id uuid;
  v_admin_count int;
begin
  -- 1. Validasi pemanggil: harus Admin/Administrator aktif
  select role, is_active, branch_id, coalesce(nullif(full_name,''), email)
  into v_actor_role, v_actor_active, v_actor_branch, v_actor_name
  from public.profiles
  where id = v_actor_id;

  if v_actor_id is null or not coalesce(v_actor_active, false) or v_actor_role not in ('Admin', 'Administrator') then
    raise exception 'Hanya admin WMS yang dapat mengelola akun.';
  end if;

  v_branch_id := coalesce(nullif(trim(body->>'branchId'), ''), v_actor_branch, 'KOL');
  v_role := body->>'role';
  v_full_name := trim(coalesce(body->>'fullName', ''));

  if v_actor_role <> 'Administrator' and v_branch_id <> v_actor_branch then
    raise exception 'Akses cabang ditolak.';
  end if;
  if v_actor_role <> 'Administrator' and v_role = 'Administrator' then
    raise exception 'Hanya kantor pusat dapat memberikan akses Administrator.';
  end if;

  -- 2. AKSI: CREATE (Buat Operator Baru)
  if v_action = 'create' then
    v_username := lower(trim(coalesce(body->>'username', '')));
    v_password := body->>'password';

    if v_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
      raise exception 'ID akun tidak valid (minimal 3-32 karakter alfanumerik).';
    end if;
    if length(v_password) < 8 or length(v_password) > 128 then
      raise exception 'Password harus 8-128 karakter.';
    end if;
    if v_role not in ('Admin', 'Administrator', 'Picker', 'Packer', 'Shipping', 'Viewer') then
      raise exception 'Peran tidak valid.';
    end if;

    v_email := v_username || '@operators.blues.invalid';

    if exists (select 1 from auth.users where email = v_email) then
      raise exception 'ID akun sudah terdaftar.';
    end if;

    v_new_id := gen_random_uuid();

    -- Buat akun di auth.users
    insert into auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    ) values (
      v_new_id,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_password, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', v_full_name),
      now(),
      now()
    );

    -- Pastikan profil terisi lengkap dan aktif
    insert into public.profiles (id, email, full_name, role, branch_id, is_active)
    values (v_new_id, v_email, v_full_name, v_role, v_branch_id, true)
    on conflict (id) do update set
      email = excluded.email,
      full_name = excluded.full_name,
      role = excluded.role,
      branch_id = excluded.branch_id,
      is_active = true;

    -- Audit log
    insert into public.activity_events (branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason)
    values (v_branch_id, 'accounts', v_new_id::text, 'ACCOUNT_CREATE', v_actor_id, v_actor_name,
            jsonb_build_object('username', v_username, 'fullName', v_full_name, 'role', v_role, 'branch_id', v_branch_id),
            'Pengelolaan akun oleh admin');

    return jsonb_build_object('success', true, 'userId', v_new_id::text, 'username', v_username);

  -- 3. AKSI: UPDATE (Perbarui Operator)
  elsif v_action = 'update' then
    v_target_id := (body->>'userId')::uuid;
    if v_target_id is null then
      raise exception 'ID akun tidak valid.';
    end if;

    if v_actor_role <> 'Administrator' and v_role = 'Administrator' then
      raise exception 'Hanya Administrator yang dapat memberikan hak Administrator.';
    end if;

    -- Cegah downgrade admin terakhir
    select count(*) into v_admin_count from public.profiles where role = 'Administrator' and is_active = true;
    if v_admin_count <= 1 and v_role <> 'Administrator' and exists (select 1 from public.profiles where id = v_target_id and role = 'Administrator') then
      raise exception 'Administrator aktif terakhir tidak dapat diturunkan perannya.';
    end if;

    update public.profiles
    set full_name = v_full_name,
        role = v_role,
        branch_id = v_branch_id,
        updated_at = now()
    where id = v_target_id;

    insert into public.activity_events (branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason)
    values (v_branch_id, 'accounts', v_target_id::text, 'ACCOUNT_UPDATE', v_actor_id, v_actor_name,
            jsonb_build_object('fullName', v_full_name, 'role', v_role, 'branch_id', v_branch_id),
            'Pengelolaan akun oleh admin');

    return jsonb_build_object('success', true);

  -- 4. AKSI: DELETE (Hapus Operator)
  elsif v_action = 'delete' then
    v_target_id := (body->>'userId')::uuid;
    if v_target_id is null or v_target_id = v_actor_id then
      raise exception 'Akun aktif tidak dapat menghapus dirinya sendiri.';
    end if;

    -- Cegah hapus admin terakhir
    select count(*) into v_admin_count from public.profiles where role = 'Administrator' and is_active = true;
    if v_admin_count <= 1 and exists (select 1 from public.profiles where id = v_target_id and role = 'Administrator') then
      raise exception 'Administrator aktif terakhir tidak dapat dihapus.';
    end if;

    delete from public.profiles where id = v_target_id;
    delete from auth.users where id = v_target_id;

    insert into public.activity_events (branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason)
    values (v_branch_id, 'accounts', v_target_id::text, 'ACCOUNT_DELETE', v_actor_id, v_actor_name,
            jsonb_build_object('userId', v_target_id::text),
            'Pengelolaan akun oleh admin');

    return jsonb_build_object('success', true);

  else
    raise exception 'Aksi tidak dikenal.';
  end if;
end;
$$;

revoke all on function public.admin_manage_user(jsonb) from public, anon;
grant execute on function public.admin_manage_user(jsonb) to authenticated;
