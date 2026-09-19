-- DK Boutique · administration réservée à un profil propriétaire.
-- Non destructif à l'installation. Le secret réel n'est JAMAIS enregistré dans ce dépôt.
-- À installer avec SQL Editor puis configurer séparément OWNER_PRIVATE_SETUP.sql.
begin;

create schema if not exists dk_private;
revoke all on schema dk_private from public, anon, authenticated;

create table if not exists dk_private.owner_control (
  id integer primary key check (id = 1),
  owner_profile_id uuid not null references public.profiles(id) on delete restrict,
  secret_hash text not null,
  failures integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);
revoke all on dk_private.owner_control from public, anon, authenticated;

create table if not exists dk_private.photo_cleanup (
  path text primary key,
  recorded_at timestamptz not null default now()
);
revoke all on dk_private.photo_cleanup from public, anon, authenticated;

create table if not exists dk_private.cleanup_grant (
  auth_user_id uuid primary key,
  expires_at timestamptz not null
);
revoke all on dk_private.cleanup_grant from public, anon, authenticated;

-- Journal privé des actions sensibles ; pas de PIN, pas de photo, pas de montant enregistré ici.
create table if not exists dk_private.maintenance_log (
  id bigint generated always as identity primary key,
  actor_profile_id uuid,
  action text not null,
  target_id uuid,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
revoke all on dk_private.maintenance_log from public, anon, authenticated;

create or replace function dk_private.is_current_owner()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from dk_private.owner_control c
    join public.profiles p on p.id = c.owner_profile_id
    join public.app_sessions s on s.profile_id = p.id
    where c.id = 1 and p.actif and p.role::text = 'patronne'
      and s.auth_user_id = auth.uid() and s.revoked_at is null
      and s.expires_at > now()
  );
$$;

create or replace function dk_private.verify_owner_secret(p_secret text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_control dk_private.owner_control%rowtype;
begin
  if not dk_private.is_current_owner() then return false; end if;
  select * into v_control from dk_private.owner_control
  where id = 1 for update;
  if not found then return false; end if;
  if v_control.blocked_until is not null and v_control.blocked_until > now() then
    return false;
  end if;
  if p_secret is not null and
    extensions.crypt(p_secret, v_control.secret_hash) = v_control.secret_hash then
    update dk_private.owner_control
      set failures = 0, blocked_until = null, updated_at = now()
      where id = 1;
    return true;
  end if;
  update dk_private.owner_control
    set failures = case when blocked_until is not null and blocked_until <= now()
                           then 1 else failures + 1 end,
        blocked_until = case
          when (case when blocked_until is not null and blocked_until <= now()
                         then 1 else failures + 1 end) >= 5
          then now() + interval '30 minutes'
          else blocked_until end,
        updated_at = now()
  where id = 1;
  return false;
end;
$$;

revoke execute on function dk_private.is_current_owner() from public, anon, authenticated;
revoke execute on function dk_private.verify_owner_secret(text) from public, anon, authenticated;

create or replace function public.maintenance_owner_status()
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if not dk_private.is_current_owner() then
    return jsonb_build_object('enabled', false);
  end if;
  return jsonb_build_object(
    'enabled', true,
    'photos_pending', (select count(*) from dk_private.photo_cleanup)
  );
end;
$$;

-- Suppression physique uniquement d'un livreur n'ayant aucun dossier historique.
-- Sinon le compte est désactivé et ses sessions sont révoquées pour préserver les preuves.
create or replace function public.maintenance_retire_livreur(
  p_livreur_id uuid, p_secret text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_has_history boolean; v_name text;
begin
  if not dk_private.verify_owner_secret(p_secret) then
    return jsonb_build_object('ok',false,'error','Autorisation refusée ou temporairement bloquée.');
  end if;
  select nom into v_name from public.livreurs where id = p_livreur_id for update;
  if v_name is null then
    return jsonb_build_object('ok',false,'error','Livreur introuvable.');
  end if;
  select exists(select 1 from public.sorties where livreur_id = p_livreur_id)
    into v_has_history;
  update public.app_sessions set revoked_at = now()
    where livreur_id = p_livreur_id and revoked_at is null;
  if v_has_history then
    update public.livreurs set actif = false where id = p_livreur_id;
    insert into dk_private.maintenance_log(actor_profile_id,action,target_id,summary)
      values(public.current_profile_id(),'livreur_desactive',p_livreur_id,
        jsonb_build_object('nom',v_name,'historique_conserve',true));
    return jsonb_build_object('ok',true,'mode','desactive',
      'message','Compte désactivé. Historique des tournées conservé.');
  end if;
  delete from public.livreurs where id = p_livreur_id;
  insert into dk_private.maintenance_log(actor_profile_id,action,target_id,summary)
    values(public.current_profile_id(),'livreur_supprime',p_livreur_id,
      jsonb_build_object('nom',v_name,'historique_conserve',false));
  return jsonb_build_object('ok',true,'mode','supprime',
    'message','Compte supprimé définitivement (aucune tournée associée).');
end;
$$;

-- Le nettoyage des fichiers est suivi séparément : SQL ne supprime PAS les fichiers Storage.
-- Les photos enregistrées dans le bucket, y compris les objets orphelins, sont consignées.
create or replace function public.maintenance_reset_business(p_secret text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_colis bigint; v_tours bigint; v_livreurs bigint; v_zones bigint;
begin
  if not dk_private.verify_owner_secret(p_secret) then
    return jsonb_build_object('ok',false,'error','Autorisation refusée ou temporairement bloquée.');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(246801357);
  select count(*) into v_colis from public.colis;
  select count(*) into v_tours from public.sorties;
  select count(*) into v_livreurs from public.livreurs;
  select count(*) into v_zones from public.zones;

  insert into dk_private.photo_cleanup(path)
    select name from storage.objects where bucket_id = 'colis-photos'
    on conflict (path) do nothing;

  -- Invalider immédiatement les sessions des autres tablettes.
  update public.app_sessions set revoked_at = now()
    where auth_user_id is distinct from auth.uid() and revoked_at is null;
  delete from public.sortie_operations;
  delete from public.colis;
  delete from public.sorties;
  delete from public.app_sessions where livreur_id is not null;
  delete from public.livreurs;
  delete from public.zones;

  insert into dk_private.cleanup_grant(auth_user_id, expires_at)
    values (auth.uid(), now() + interval '30 minutes')
    on conflict (auth_user_id) do update set expires_at = excluded.expires_at;

  insert into dk_private.maintenance_log(actor_profile_id,action,summary)
    values(public.current_profile_id(),'reinitialisation',
      jsonb_build_object('colis',v_colis,'tournees',v_tours,'livreurs',v_livreurs,
        'zones',v_zones,'photos_a_nettoyer',
          (select count(*) from dk_private.photo_cleanup)));
  return jsonb_build_object('ok',true, 'colis', v_colis, 'tournees',v_tours,
    'livreurs',v_livreurs,'zones',v_zones,
    'photos_pending',(select count(*) from dk_private.photo_cleanup));
end;
$$;

create or replace function public.maintenance_enable_photo_cleanup(p_secret text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if not dk_private.verify_owner_secret(p_secret) then
    return jsonb_build_object('ok',false,'error','Autorisation refusée ou temporairement bloquée.');
  end if;
  insert into dk_private.cleanup_grant(auth_user_id,expires_at)
    values(auth.uid(),now() + interval '30 minutes')
    on conflict(auth_user_id) do update set expires_at = excluded.expires_at;
  return jsonb_build_object('ok',true,
    'photos_pending',(select count(*) from dk_private.photo_cleanup));
end;
$$;

create or replace function public.maintenance_can_cleanup_photo(p_path text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select dk_private.is_current_owner()
    and exists(select 1 from dk_private.cleanup_grant g
      where g.auth_user_id = auth.uid() and g.expires_at > now())
    and exists(select 1 from dk_private.photo_cleanup p where p.path = p_path);
$$;

create or replace function public.maintenance_cleanup_page()
returns text[] language plpgsql security definer set search_path = ''
as $$
begin
  if not dk_private.is_current_owner() or not exists (
    select 1 from dk_private.cleanup_grant
    where auth_user_id = auth.uid() and expires_at > now()
  ) then
    raise exception 'Autorisation expirée : ressaisissez le code.';
  end if;
  return coalesce(array(
    select path from dk_private.photo_cleanup
    order by recorded_at, path limit 50
  ), array[]::text[]);
end;
$$;

create or replace function public.maintenance_mark_photos_removed(p_paths text[])
returns integer language plpgsql security definer set search_path = ''
as $$
declare v_deleted integer;
begin
  if not dk_private.is_current_owner() or not exists (
    select 1 from dk_private.cleanup_grant
    where auth_user_id = auth.uid() and expires_at > now()
  ) then
    raise exception 'Autorisation expirée : ressaisissez le code.';
  end if;
  if coalesce(array_length(p_paths,1),0) > 50 then
    raise exception 'Lot trop important.';
  end if;
  delete from dk_private.photo_cleanup where path = any(coalesce(p_paths,array[]::text[]));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Une autorisation pour les images n'est valable que 30 minutes, pour la patronne
-- désignée et uniquement pour les chemins inscrits dans le nettoyage.
drop policy if exists "dk_owner_cleanup_photo_read" on storage.objects;
create policy "dk_owner_cleanup_photo_read" on storage.objects
for select to authenticated
using (bucket_id = 'colis-photos' and public.maintenance_can_cleanup_photo(name));

drop policy if exists "dk_owner_cleanup_photo_delete" on storage.objects;
create policy "dk_owner_cleanup_photo_delete" on storage.objects
for delete to authenticated
using (bucket_id = 'colis-photos' and public.maintenance_can_cleanup_photo(name));

revoke execute on function public.maintenance_owner_status() from public, anon;
revoke execute on function public.maintenance_retire_livreur(uuid,text) from public, anon;
revoke execute on function public.maintenance_reset_business(text) from public, anon;
revoke execute on function public.maintenance_enable_photo_cleanup(text) from public, anon;
revoke execute on function public.maintenance_can_cleanup_photo(text) from public, anon;
revoke execute on function public.maintenance_cleanup_page() from public, anon;
revoke execute on function public.maintenance_mark_photos_removed(text[]) from public, anon;

grant execute on function public.maintenance_owner_status() to authenticated;
grant execute on function public.maintenance_retire_livreur(uuid,text) to authenticated;
grant execute on function public.maintenance_reset_business(text) to authenticated;
grant execute on function public.maintenance_enable_photo_cleanup(text) to authenticated;
grant execute on function public.maintenance_can_cleanup_photo(text) to authenticated;
grant execute on function public.maintenance_cleanup_page() to authenticated;
grant execute on function public.maintenance_mark_photos_removed(text[]) to authenticated;
commit;
