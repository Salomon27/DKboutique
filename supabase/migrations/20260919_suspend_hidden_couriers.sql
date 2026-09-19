-- DK Boutique | Suspension complete et masquage des livreurs retires.
-- NON DESTRUCTIF : aucune suppression des colis, photos, operations ou archives.
-- A executer dans Supabase SQL Editor APRES la migration private_owner_maintenance.
begin;

-- Une tournee interrompue n'est PAS une tournee cloturee ni un encaissement.
alter table public.sorties add column if not exists suspendue_at timestamptz;
create index if not exists sorties_suspendue_livreur_idx
  on public.sorties(livreur_id, suspendue_at);

-- Etat persistant pour les chauffeurs deja desactives avant cette mise a niveau.
update public.sorties s
set suspendue_at = now()
from public.livreurs l
where s.livreur_id = l.id and l.actif = false
  and s.statut = 'en_cours' and s.suspendue_at is null;

-- Helpers SECURITY DEFINER: une photo, un colis ou une tournee d'un compte
-- retire ne peut pas etre lu via les tables directes, meme avec un URL de dossier.
create or replace function public.dk_livreur_visible(p_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.livreurs l
                where l.id = p_id and l.actif = true);
$$;

create or replace function public.dk_sortie_visible(p_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(
    select 1 from public.sorties s
    join public.livreurs l on l.id = s.livreur_id
    where s.id = p_id and l.actif = true and s.suspendue_at is null
  );
$$;

revoke execute on function public.dk_livreur_visible(uuid) from public, anon;
revoke execute on function public.dk_sortie_visible(uuid) from public, anon;
grant execute on function public.dk_livreur_visible(uuid) to authenticated;
grant execute on function public.dk_sortie_visible(uuid) to authenticated;

-- Supprimer les anciennes politiques permissives pour ne pas laisser de
-- raccourci via les requetes directes (PostgREST).
drop policy if exists "Admins see livreurs" on public.livreurs;
drop policy if exists "Livreur sees self" on public.livreurs;
create policy "DK active team admin read" on public.livreurs for select to authenticated
using (actif = true and public.current_app_role() in ('gerant','patronne'));
create policy "DK active courier self read" on public.livreurs for select to authenticated
using (actif = true and id = public.current_livreur_id());

drop policy if exists "Admins ALL Sorties" on public.sorties;
drop policy if exists "Gerant SELECT Sorties" on public.sorties;
drop policy if exists "Patronne SELECT Sorties" on public.sorties;
drop policy if exists "Livreur SELECT Sorties" on public.sorties;
create policy "DK active tours admin read" on public.sorties for select to authenticated
using (public.dk_sortie_visible(id) and public.current_app_role() in ('gerant','patronne'));
create policy "DK active tours courier read" on public.sorties for select to authenticated
using (public.dk_sortie_visible(id) and livreur_id = public.current_livreur_id());

drop policy if exists "Admins ALL Colis" on public.colis;
drop policy if exists "Gerant SELECT Colis" on public.colis;
drop policy if exists "Patronne SELECT Colis" on public.colis;
drop policy if exists "Livreur SELECT Colis" on public.colis;
create policy "DK active parcels admin read" on public.colis for select to authenticated
using (public.dk_sortie_visible(sortie_id)
  and public.current_app_role() in ('gerant','patronne'));
create policy "DK active parcels courier read" on public.colis for select to authenticated
using (public.dk_sortie_visible(sortie_id)
  and exists(select 1 from public.sorties s where s.id = sortie_id
    and s.livreur_id = public.current_livreur_id()));
drop policy if exists "Livreur UPDATE Colis Statut" on public.colis;

drop policy if exists "Admins ALL Ops" on public.sortie_operations;
drop policy if exists "Gerant SELECT Ops" on public.sortie_operations;
drop policy if exists "Patronne SELECT Ops" on public.sortie_operations;
create policy "DK active ops admin read" on public.sortie_operations for select to authenticated
using (public.dk_sortie_visible(sortie_id)
  and public.current_app_role() in ('gerant','patronne'));

-- Toute mutation du dossier d'un livreur retire est refusee, y compris via
-- les RPC SECURITY DEFINER existantes et des requetes directes.
create or replace function public.dk_guard_inactive_tour_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_active boolean;
begin
  select (l.actif and s.suspendue_at is null and s.statut = 'en_cours')
  into v_active
  from public.sorties s
  join public.livreurs l on l.id = s.livreur_id
  where s.id = new.sortie_id
  for share of l, s;
  if v_active is distinct from true then
    raise exception 'Tournee indisponible : livreur desactive ou tournee suspendue.';
  end if;
  return new;
end;
$$;
revoke execute on function public.dk_guard_inactive_tour_write() from public, anon, authenticated;
drop trigger if exists dk_guard_inactive_colis on public.colis;
create trigger dk_guard_inactive_colis before insert or update on public.colis
for each row execute function public.dk_guard_inactive_tour_write();
drop trigger if exists dk_guard_inactive_operation on public.sortie_operations;
create trigger dk_guard_inactive_operation before insert or update on public.sortie_operations
for each row execute function public.dk_guard_inactive_tour_write();

create or replace function public.dk_guard_suspended_sortie()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_active boolean;
begin
  if old.suspendue_at is not null and new.suspendue_at is null then
    raise exception 'La tournee suspendue ne peut pas etre reactivee automatiquement.';
  end if;
  if new.statut is distinct from old.statut then
    select l.actif into v_active
    from public.livreurs l where l.id = old.livreur_id for share;
    if v_active is distinct from true or old.suspendue_at is not null then
      raise exception 'Statut bloque : livreur retire ou tournee suspendue.';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.dk_guard_suspended_sortie() from public, anon, authenticated;
drop trigger if exists dk_guard_suspended_sortie on public.sorties;
create trigger dk_guard_suspended_sortie before update on public.sorties
for each row execute function public.dk_guard_suspended_sortie();

-- Le responsable peut gerer les coordonnees, mais une desactivation
-- est irreversible depuis sa fiche. Une tournee en cours se suspend
-- uniquement par le module prive (code proprietaire).
create or replace function public.update_livreur_account(
  p_livreur_id uuid,p_nom text,p_telephone text,p_zone_id uuid,p_actif boolean
) returns void language plpgsql security definer set search_path = ''
as $$
declare v_actif boolean;
begin
  if public.current_app_role() <> 'gerant' then raise exception 'Acces refuse.'; end if;
  if nullif(trim(p_nom),'') is null then raise exception 'Nom requis.'; end if;
  if not exists(select 1 from public.zones where id = p_zone_id) then
    raise exception 'Zone introuvable.';
  end if;
  select actif into v_actif from public.livreurs where id = p_livreur_id for update;
  if not found then raise exception 'Livreur introuvable ou desactive.'; end if;
  if v_actif = false and p_actif = true then
    raise exception 'Reactivation reservee a une procedure de controle.';
  end if;
  if p_actif = false and exists(
    select 1 from public.sorties
    where livreur_id = p_livreur_id and statut = 'en_cours' and suspendue_at is null
  ) then
    raise exception 'Tournee active : suspension reservee a l administration privee.';
  end if;
  update public.livreurs
  set nom = trim(p_nom), telephone = nullif(trim(p_telephone),''),
      zone_id = p_zone_id, actif = p_actif
  where id = p_livreur_id;
  if p_actif = false then
    update public.app_sessions set revoked_at = now()
    where livreur_id = p_livreur_id and revoked_at is null;
  end if;
end;
$$;

-- Le code prive reste seulement dans dk_private.owner_control : jamais en JS ni ici.
-- Verrouillage du livreur, suspension des tours actives, desactivation et journal
-- forment UNE SEULE transaction atomique.
create or replace function public.maintenance_retire_livreur(
  p_livreur_id uuid,p_secret text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_name text; v_actif boolean; v_has_history boolean; v_suspended integer;
begin
  if not dk_private.verify_owner_secret(p_secret) then
    return jsonb_build_object('ok',false,
      'error','Autorisation refusee ou temporairement bloquee.');
  end if;
  select nom,actif into v_name,v_actif
    from public.livreurs where id = p_livreur_id for update;
  if not found then return jsonb_build_object('ok',false,'error','Livreur introuvable.'); end if;
  if v_actif is false then
    return jsonb_build_object('ok',true,'mode','desactive',
      'message','Ce livreur est deja desactive et masque.');
  end if;
  select exists(select 1 from public.sorties where livreur_id = p_livreur_id)
    into v_has_history;
  update public.sorties
  set suspendue_at = now()
  where livreur_id = p_livreur_id and statut = 'en_cours' and suspendue_at is null;
  get diagnostics v_suspended = row_count;
  update public.livreurs set actif = false where id = p_livreur_id;
  update public.app_sessions set revoked_at = now()
    where livreur_id = p_livreur_id and revoked_at is null;
  if v_has_history then
    insert into dk_private.maintenance_log(actor_profile_id,action,target_id,summary)
      values(public.current_profile_id(),'livreur_suspendu',p_livreur_id,
        jsonb_build_object('nom',v_name,'tournees_suspendues',v_suspended,
          'historique_conserve',true));
    return jsonb_build_object('ok',true,'mode','desactive','tournees_suspendues',v_suspended,
      'message','Livreur desactive. Toutes ses tournees, photos et donnees sont masquees. '
        || v_suspended || ' tournee(s) en cours suspendue(s). Historique conserve en base pour controle.');
  end if;
  delete from public.livreurs where id = p_livreur_id;
  insert into dk_private.maintenance_log(actor_profile_id,action,target_id,summary)
    values(public.current_profile_id(),'livreur_supprime',p_livreur_id,
      jsonb_build_object('nom',v_name,'historique_conserve',false));
  return jsonb_build_object('ok',true,'mode','supprime',
    'message','Livreur sans historique supprime definitivement.');
end;
$$;

-- Empêcher les URL de photo nouvellement signee de contourner le masquage.
drop policy if exists "dk_colis_authorized_photo_read" on storage.objects;
create policy "dk_colis_authorized_photo_read" on storage.objects
for select to authenticated
using (
  bucket_id = 'colis-photos'
  and (storage.foldername(name))[1] = 'sorties'
  and exists(
    select 1 from public.sorties s
    join public.livreurs l on l.id = s.livreur_id
    where s.id::text = (storage.foldername(name))[2]
      and l.actif = true and s.suspendue_at is null
      and (
        public.current_app_role() = 'patronne'
        or (public.current_app_role() = 'gerant'
          and s.gerant_id = public.current_profile_id())
        or (public.current_app_role() = 'livreur'
          and s.livreur_id = public.current_livreur_id())
      )
  )
);
-- La lecture des photos appartenant aux tours suspendus doit etre bloquee
-- aussi pour les gérants qui gardent un ancien lien de dossier.
commit;
