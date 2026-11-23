-- Support creating operator accounts directly in PostgreSQL RPC `admin_manage_user`
-- so account creation works cleanly even when Edge Function `admin-users` is not deployed.
create or replace function public.admin_manage_user(body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor record;
  v_action text;
  v_target_id uuid;
  v_target record;
  v_branch_id text;
  v_full_name text;
  v_role text;
  v_username text;
  v_password text;
  v_email text;
  v_new_id uuid;
  v_instance_id uuid;
  v_admin_count integer;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'Sesi masuk tidak valid.');
  end if;

  select role, is_active, branch_id, full_name, email
  into v_actor
  from public.profiles
  where id = auth.uid();

  if not found or not v_actor.is_active or v_actor.role not in ('Admin', 'Administrator') then
    return jsonb_build_object('error', 'Hanya admin WMS yang dapat mengelola akun.');
  end if;

  v_action := lower(trim(coalesce(body->>'action', '')));
  v_branch_id := upper(coalesce(nullif(trim(coalesce(body->>'branchId', '')), ''), v_actor.branch_id, 'CENTER'));
  v_full_name := trim(coalesce(body->>'fullName', ''));
  v_role := trim(coalesce(body->>'role', ''));

  if v_actor.role <> 'Administrator' and v_branch_id <> v_actor.branch_id then
    return jsonb_build_object('error', 'Akses cabang ditolak.');
  end if;
  if v_actor.role <> 'Administrator' and v_role = 'Administrator' then
    return jsonb_build_object('error', 'Hanya kantor pusat dapat memberikan akses Administrator.');
  end if;

  if v_action = 'create' then
    v_username := lower(trim(coalesce(body->>'username', '')));
    v_password := coalesce(body->>'password', '');
    v_full_name := coalesce(nullif(v_full_name, ''), v_username);

    if v_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$'
       or length(v_password) < 8
       or length(v_password) > 128
       or length(v_full_name) not between 1 and 120
       or v_role not in ('Administrator', 'Admin', 'Picker', 'Packer', 'Shipping', 'Viewer') then
      return jsonb_build_object('error', 'ID, password (minimal 8 karakter), nama, atau peran tidak valid.');
    end if;

    if not exists (select 1 from public.branches where id = v_branch_id) then
      if v_actor.role = 'Administrator' then
        insert into public.branches (id, name, operation_type)
        values (v_branch_id, v_branch_id, 'HYBRID')
        on conflict (id) do nothing;
      else
        return jsonb_build_object('error', 'Akses cabang ditolak: Cabang "' || v_branch_id || '" tidak terdaftar.');
      end if;
    end if;

    v_email := v_username || '@operators.blues.invalid';

    if exists (select 1 from auth.users where lower(email) = v_email) then
      return jsonb_build_object('error', 'ID akun "' || v_username || '" sudah terdaftar.');
    end if;

    v_new_id := gen_random_uuid();
    select coalesce(
      (select u.instance_id from auth.users u where u.id = auth.uid()),
      '00000000-0000-0000-0000-000000000000'::uuid
    ) into v_instance_id;

    insert into auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    ) values (
      v_new_id,
      v_instance_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_password, gen_salt('bf')),
      now(),
      '',
      '',
      '',
      '',
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', v_full_name),
      now(),
      now()
    );

    insert into auth.identities (
      id,
      user_id,
      provider_id,
      identity_data,
      provider,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),
      v_new_id,
      v_new_id::text,
      jsonb_build_object(
        'sub', v_new_id::text,
        'email', v_email,
        'email_verified', true,
        'phone_verified', false
      ),
      'email',
      now(),
      now(),
      now()
    ) on conflict (provider_id, provider) do nothing;

    insert into public.profiles (id, email, full_name, role, branch_id, is_active)
    values (v_new_id, v_email, v_full_name, v_role, v_branch_id, true)
    on conflict (id) do update set
      email = excluded.email,
      full_name = excluded.full_name,
      role = excluded.role,
      branch_id = excluded.branch_id,
      is_active = true;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_new_id::text, 'ACCOUNT_CREATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('username', v_username, 'fullName', v_full_name, 'role', v_role, 'branch_id', v_branch_id),
      'Pengelolaan akun oleh admin'
    );

    return jsonb_build_object('success', true, 'userId', v_new_id::text, 'username', v_username);
  elsif v_action = 'update' then
    if coalesce(trim(body->>'userId'), '') = '' or length(v_full_name) not between 1 and 120
       or v_role not in ('Administrator', 'Admin', 'Picker', 'Packer', 'Shipping', 'Viewer') then
      return jsonb_build_object('error', 'Profil atau peran tidak valid.');
    end if;

    v_target_id := (body->>'userId')::uuid;
    select id, role, is_active, branch_id into v_target
    from public.profiles where id = v_target_id for update;

    if not found then
      return jsonb_build_object('error', 'Akun tidak ditemukan.');
    end if;
    if v_actor.role <> 'Administrator' and (v_target.branch_id <> v_actor.branch_id or v_target.role = 'Administrator') then
      return jsonb_build_object('error', 'Akses akun ditolak.');
    end if;

    if v_target.is_active and v_target.role = 'Administrator' and v_role <> 'Administrator' then
      select count(*) into v_admin_count from public.profiles where role = 'Administrator' and is_active;
      if v_admin_count <= 1 then
        return jsonb_build_object('error', 'Admin terakhir tidak dapat diturunkan perannya.');
      end if;
    end if;

    update public.profiles
    set full_name = v_full_name,
        role = v_role,
        branch_id = v_branch_id
    where id = v_target_id;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_target_id::text, 'ACCOUNT_UPDATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('fullName', v_full_name, 'role', v_role, 'branch_id', v_branch_id),
      'Pengelolaan akun oleh admin'
    );

    return jsonb_build_object('success', true);
  elsif v_action = 'delete' then
    if coalesce(trim(body->>'userId'), '') = '' then
      return jsonb_build_object('error', 'ID akun tidak valid.');
    end if;

    v_target_id := (body->>'userId')::uuid;
    if v_target_id = auth.uid() then
      return jsonb_build_object('error', 'Akun aktif tidak dapat menonaktifkan dirinya sendiri.');
    end if;

    select id, role, is_active, branch_id into v_target
    from public.profiles where id = v_target_id for update;
    if not found then
      return jsonb_build_object('error', 'Akun tidak ditemukan.');
    end if;
    if v_actor.role <> 'Administrator' and (v_target.branch_id <> v_actor.branch_id or v_target.role = 'Administrator') then
      return jsonb_build_object('error', 'Akses akun ditolak.');
    end if;

    if v_target.is_active and v_target.role = 'Administrator' then
      select count(*) into v_admin_count from public.profiles where role = 'Administrator' and is_active;
      if v_admin_count <= 1 then
        return jsonb_build_object('error', 'Admin terakhir tidak dapat dihapus atau dinonaktifkan.');
      end if;
    end if;

    update public.profiles set is_active = false where id = v_target_id;

    insert into public.activity_events (
      branch_id, entity_type, entity_id, action, actor_id, actor_name, after_data, reason
    ) values (
      v_branch_id, 'accounts', v_target_id::text, 'ACCOUNT_DEACTIVATE',
      auth.uid(), coalesce(nullif(v_actor.full_name, ''), v_actor.email),
      jsonb_build_object('userId', v_target_id::text),
      'Penonaktifan akun oleh admin'
    );

    return jsonb_build_object('success', true);
  end if;

  return jsonb_build_object('error', 'Aksi pengelolaan akun tidak dikenal.');
end;
$$;

revoke all on function public.admin_manage_user(jsonb) from public, anon;
grant execute on function public.admin_manage_user(jsonb) to authenticated;
