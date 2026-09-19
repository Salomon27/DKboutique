-- DK BOUTIQUE · MISE A JOUR UNIQUE / COHERENCE COLIS ET LIVREURS
-- Ce script INSTALLE des fonctions, politiques et tables sans effacer de donnees.
-- Il ne declenche aucune correction, aucun retrait et aucune remise a zero.
-- Exige que l'administration privee ait deja ete installee dans Supabase.
-- Uniquement sur la BASE DK BOUTIQUE (SQL Editor) : jamais database.sql.
-- Transactions atomiques : si une instruction echoue, la mise a jour est annulee.
begin;

-- Partie 1 : masquer et suspendre les livreurs retires, compatible avec une execution precedente.
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
drop policy if exists "DK active team admin read" on public.livreurs;
create policy "DK active team admin read" on public.livreurs for select to authenticated
using (actif = true and public.current_app_role() in ('gerant','patronne'));
drop policy if exists "DK active courier self read" on public.livreurs;
create policy "DK active courier self read" on public.livreurs for select to authenticated
using (actif = true and id = public.current_livreur_id());

drop policy if exists "Admins ALL Sorties" on public.sorties;
drop policy if exists "Gerant SELECT Sorties" on public.sorties;
drop policy if exists "Patronne SELECT Sorties" on public.sorties;
drop policy if exists "Livreur SELECT Sorties" on public.sorties;
drop policy if exists "DK active tours admin read" on public.sorties;
create policy "DK active tours admin read" on public.sorties for select to authenticated
using (public.dk_sortie_visible(id) and public.current_app_role() in ('gerant','patronne'));
drop policy if exists "DK active tours courier read" on public.sorties;
create policy "DK active tours courier read" on public.sorties for select to authenticated
using (public.dk_sortie_visible(id) and livreur_id = public.current_livreur_id());

drop policy if exists "Admins ALL Colis" on public.colis;
drop policy if exists "Gerant SELECT Colis" on public.colis;
drop policy if exists "Patronne SELECT Colis" on public.colis;
drop policy if exists "Livreur SELECT Colis" on public.colis;
drop policy if exists "DK active parcels admin read" on public.colis;
create policy "DK active parcels admin read" on public.colis for select to authenticated
using (public.dk_sortie_visible(sortie_id)
  and public.current_app_role() in ('gerant','patronne'));
drop policy if exists "DK active parcels courier read" on public.colis;
create policy "DK active parcels courier read" on public.colis for select to authenticated
using (public.dk_sortie_visible(sortie_id)
  and exists(select 1 from public.sorties s where s.id = sortie_id
    and s.livreur_id = public.current_livreur_id()));
drop policy if exists "Livreur UPDATE Colis Statut" on public.colis;

drop policy if exists "Admins ALL Ops" on public.sortie_operations;
drop policy if exists "Gerant SELECT Ops" on public.sortie_operations;
drop policy if exists "Patronne SELECT Ops" on public.sortie_operations;
drop policy if exists "DK active ops admin read" on public.sortie_operations;
create policy "DK active ops admin read" on public.sortie_operations for select to authenticated
using (public.dk_sortie_visible(sortie_id)
  and public.current_app_role() in ('gerant','patronne'));

-- Toute mutation du dossier d'un livreur retire est refusee, y compris via
-- les RPC SECURITY DEFINER existantes et des requetes directes.
create or replace function public.dk_guard_inactive_tour_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_active boolean; v_closure boolean := false;
begin
  if tg_table_name = 'sortie_operations' then
    v_closure := new.type = 'cloture';
  end if;
  if v_closure then
    -- La cloture verrouille deja la ligne sortie. Ne pas inverser l'ordre
    -- des verrous avec une desactivation du livreur simultanee.
    select (l.actif and s.suspendue_at is null and s.statut = 'cloturee')
    into v_active
    from public.sorties s join public.livreurs l on l.id = s.livreur_id
    where s.id = new.sortie_id;
  else
    -- Verrou lecteur sur le livreur : une ecriture en cours finit avant
    -- une suspension et aucune nouvelle ecriture ne peut la depasser.
    select (l.actif and s.suspendue_at is null and s.statut = 'en_cours')
    into v_active
    from public.sorties s join public.livreurs l on l.id = s.livreur_id
    where s.id = new.sortie_id
    for share of l;
  end if;
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
  if tg_op = 'INSERT' then
    select actif into v_active from public.livreurs
    where id = new.livreur_id for share;
    if v_active is distinct from true or new.suspendue_at is not null then
      raise exception 'Impossible de creer une tournee pour un livreur desactive.';
    end if;
    return new;
  end if;
  if old.suspendue_at is not null and new.suspendue_at is null then
    raise exception 'La tournee suspendue ne peut pas etre reactivee automatiquement.';
  end if;
  if new.statut is distinct from old.statut then
    select l.actif into v_active
    from public.livreurs l where l.id = old.livreur_id;
    if v_active is distinct from true or old.suspendue_at is not null then
      raise exception 'Statut bloque : livreur retire ou tournee suspendue.';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.dk_guard_suspended_sortie() from public, anon, authenticated;
drop trigger if exists dk_guard_suspended_sortie on public.sorties;
create trigger dk_guard_suspended_sortie before insert or update on public.sorties
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

-- Le client ne peut activer le bouton de retrait qu'une fois la migration
-- effectivement installee dans la base, pas seulement presente sur GitHub.
create or replace function public.maintenance_owner_status()
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if not dk_private.is_current_owner() then
    return jsonb_build_object('enabled',false);
  end if;
  return jsonb_build_object(
    'enabled', true,
    'suspension_enabled', true,
    'photos_pending', (select count(*) from dk_private.photo_cleanup)
  );
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

-- Partie 2 : correction ciblee d'un colis + purge privee d'un seul livreur.
alter table public.sorties add column if not exists suspendue_at timestamptz;

create schema if not exists dk_private;
revoke all on schema dk_private from public,anon,authenticated;

create table if not exists dk_private.colis_corrections (
 id uuid primary key default gen_random_uuid(),
 colis_id uuid not null unique,
 sortie_id uuid not null,
 photo_path text not null,
 valeur numeric(14,2) not null,
 motif text not null,
 statut_sortie text not null,
 montant_avant numeric(14,2) not null,
 montant_apres numeric(14,2) not null,
 colis_avant integer not null,
 colis_apres integer not null,
 auteur_profile_id uuid,
 cree_at timestamptz not null default now(),
 photo_supprimee_at timestamptz
);
revoke all on dk_private.colis_corrections from public,anon,authenticated;
create index if not exists dk_colis_corrections_sortie_idx on dk_private.colis_corrections(sortie_id, cree_at);

-- Le gérant corrige UNIQUEMENT les colis de ses propres tournées.
-- Un retour et une annulation de saisie sont deux actions distinctes:
-- retirer le colis et ses opérations le sort des totaux; aucun faux retour.
create or replace function public.corriger_colis_saisi(p_colis_id uuid, p_motif text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
 v_sortie public.sorties%rowtype;
 v_colis public.colis%rowtype;
 v_before public.v_sorties_resume%rowtype;
 v_after public.v_sorties_resume%rowtype;
 v_actor uuid;
 v_correction dk_private.colis_corrections%rowtype;
 v_reason text;
begin
 if public.current_app_role() <> 'gerant' then
   raise exception 'Seul le gérant peut corriger un colis saisi.';
 end if;
 v_actor := public.current_profile_id();
 if v_actor is null then raise exception 'Session invalide.'; end if;
 v_reason := nullif(btrim(p_motif),'');
 if v_reason is null or pg_catalog.length(v_reason) < 5
    or pg_catalog.length(v_reason) > 180 then
   raise exception 'Précisez le motif de la correction (5 à 180 caractères).';
 end if;

 -- Verrou sur le dossier, même pour une tournée déjà clôturée.
 select s.* into v_sortie
 from public.sorties s join public.colis c on c.sortie_id = s.id
 where c.id = p_colis_id for update of s;
 if not found then
   select * into v_correction
   from dk_private.colis_corrections where colis_id = p_colis_id;
   if found and v_correction.auteur_profile_id = v_actor
      and exists (
        select 1 from public.sorties s join public.livreurs l on l.id = s.livreur_id
        where s.id = v_correction.sortie_id and s.gerant_id = v_actor
          and l.actif and s.suspendue_at is null
      ) then
     return jsonb_build_object('ok',true,'already_corrected',true,
       'photo_path',v_correction.photo_path,'colis_id',p_colis_id,
       'montant_apres',v_correction.montant_apres);
   end if;
   raise exception 'Colis introuvable, déjà corrigé ou non autorisé.';
 end if;
 if v_sortie.gerant_id is distinct from v_actor
    or v_sortie.suspendue_at is not null
    or not exists(select 1 from public.livreurs
                  where id = v_sortie.livreur_id and actif) then
   raise exception 'Ce dossier n’est pas accessible au gérant.';
 end if;
 select * into v_colis from public.colis where id = p_colis_id for update;
 if not found then raise exception 'Colis introuvable.'; end if;
 select * into v_before from public.v_sorties_resume where id = v_sortie.id;
 if not found then raise exception 'Synthèse de la tournée indisponible.'; end if;

 -- FK sortie_operations.colis_id = RESTRICT : supprimer uniquement les
 -- opérations reliées à CE colis avant sa suppression définitive.
 delete from public.sortie_operations where colis_id = p_colis_id;
 delete from public.colis where id = p_colis_id;
 select * into v_after from public.v_sorties_resume where id = v_sortie.id;
 if not found then raise exception 'Synthèse de la tournée indisponible après correction.'; end if;

 if v_sortie.statut = 'cloturee' then
   -- Les états financiers déjà figés doivent porter le montant CORRIGÉ,
   -- et pas un montant historique contenant un colis supprimé.
   update public.sorties set
      montant_final = v_after.net_a_encaisser,
      nb_colis_final = v_after.nb_colis_total
   where id = v_sortie.id;
   update public.sortie_operations set
      montant = v_after.net_a_encaisser,
      quantite = v_after.nb_colis_total
   where sortie_id = v_sortie.id and type = 'cloture';
 end if;

 insert into dk_private.photo_cleanup(path)
 values(v_colis.photo_path) on conflict(path) do nothing;
 insert into dk_private.colis_corrections
    (colis_id,sortie_id,photo_path,valeur,motif,statut_sortie,
     montant_avant,montant_apres,colis_avant,colis_apres,auteur_profile_id)
 values(p_colis_id,v_sortie.id,v_colis.photo_path,v_colis.valeur,
        v_reason,v_sortie.statut::text,v_before.net_a_encaisser,
        v_after.net_a_encaisser,v_before.nb_colis_total,v_after.nb_colis_total,v_actor);
 return jsonb_build_object('ok',true,'photo_path',v_colis.photo_path,
   'colis_id',p_colis_id,'sortie_id',v_sortie.id,
   'montant_avant',v_before.net_a_encaisser,
   'montant_apres',v_after.net_a_encaisser,
   'colis_avant',v_before.nb_colis_total,'colis_apres',v_after.nb_colis_total,
   'cloturee',v_sortie.statut='cloturee');
end;
$$;

-- Photo liée à une correction : le responsable peut la retirer via Storage
-- sans obtenir le droit de supprimer arbitrairement d'autres photos.
create or replace function public.dk_photo_corrigee_autorisee(p_path text)
returns boolean language sql stable security definer set search_path = ''
as $$
 select public.current_app_role()='gerant' and exists(
   select 1 from dk_private.colis_corrections c
   join public.sorties s on s.id=c.sortie_id
   join public.livreurs l on l.id=s.livreur_id
   where c.photo_path=p_path and c.photo_supprimee_at is null
     and s.gerant_id=public.current_profile_id()
     and l.actif and s.suspendue_at is null
 );
$$;
revoke execute on function public.dk_photo_corrigee_autorisee(text) from public,anon;
grant execute on function public.dk_photo_corrigee_autorisee(text) to authenticated;

drop policy if exists "dk_correction_photo_delete" on storage.objects;
create policy "dk_correction_photo_delete" on storage.objects
for delete to authenticated
using (bucket_id='colis-photos' and public.dk_photo_corrigee_autorisee(name));

-- Supabase Storage demande aussi SELECT pour supprimer un objet privé.
drop policy if exists "dk_correction_photo_select" on storage.objects;
create policy "dk_correction_photo_select" on storage.objects
for select to authenticated
using (bucket_id='colis-photos' and public.dk_photo_corrigee_autorisee(name));

create or replace function public.confirmer_photo_colis_corrigee(p_colis_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_row dk_private.colis_corrections%rowtype;
begin
 if public.current_app_role()<>'gerant' then raise exception 'Accès refusé.'; end if;
 select * into v_row from dk_private.colis_corrections
 where colis_id=p_colis_id for update;
 if not found or v_row.auteur_profile_id is distinct from public.current_profile_id() then
   raise exception 'Correction introuvable ou non autorisée.';
 end if;
 if exists(select 1 from storage.objects
           where bucket_id='colis-photos' and name=v_row.photo_path) then
   return jsonb_build_object('ok',false,'error','Photo encore présente dans le stockage.');
 end if;
 update dk_private.colis_corrections set photo_supprimee_at=now()
 where colis_id=p_colis_id;
 delete from dk_private.photo_cleanup where path=v_row.photo_path;
 return jsonb_build_object('ok',true);
end;
$$;

-- Détail consultable SUR DEMANDE, hors calcul financier.
create or replace function public.consulter_corrections_colis(p_sortie_id uuid)
returns table(colis_id uuid,cree_at timestamptz,motif text,valeur numeric,
  montant_avant numeric,montant_apres numeric,colis_avant integer,colis_apres integer,
  photo_a_supprimer boolean)
language plpgsql security definer set search_path = ''
as $$
begin
 if public.current_app_role() not in ('gerant','patronne')
   or not exists(
     select 1 from public.sorties s
     join public.livreurs l on l.id=s.livreur_id
     where s.id=p_sortie_id and s.suspendue_at is null and l.actif
   ) then
   raise exception 'Accès au dossier refusé.';
 end if;
 if public.current_app_role()='gerant' and not exists(
   select 1 from public.sorties
   where id=p_sortie_id and gerant_id=public.current_profile_id()
 ) then raise exception 'Dossier non autorisé.'; end if;
 return query
 select c.colis_id,c.cree_at,c.motif,c.valeur,
   c.montant_avant,c.montant_apres,c.colis_avant,c.colis_apres,
   c.photo_supprimee_at is null
 from dk_private.colis_corrections c
 where c.sortie_id=p_sortie_id order by c.cree_at desc;
end;
$$;

-- La suppression de TOUT le livreur test ne doit pas obliger à vider DK Boutique.
-- Seul le propriétaire déjà configuré, avec son code privé, peut effacer
-- ses tournées actives/archives, leurs colis, opérations, puis le compte.
-- Ces lignes ne seront plus prises en compte dans les synthèses.
create or replace function public.maintenance_liste_livreurs()
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
 if not dk_private.is_current_owner() then raise exception 'Accès refusé.'; end if;
 return coalesce((
   select jsonb_agg(jsonb_build_object(
     'id',l.id,'nom',l.nom,'zone_nom',z.nom,'actif',l.actif,
     'nb_tournees',(select count(*) from public.sorties s where s.livreur_id=l.id),
     'nb_colis',(select count(*) from public.colis c join public.sorties s
       on s.id=c.sortie_id where s.livreur_id=l.id),
     'en_tournee',exists(select 1 from public.sorties s
       where s.livreur_id=l.id and s.statut='en_cours' and s.suspendue_at is null)
   ) order by l.nom)
   from public.livreurs l join public.zones z on z.id=l.zone_id
 ),'[]'::jsonb);
end;
$$;

create or replace function public.maintenance_effacer_livreur(
 p_livreur_id uuid,p_secret text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_livreur public.livreurs%rowtype;v_tours bigint;v_colis bigint;
begin
 if not dk_private.verify_owner_secret(p_secret) then
   return jsonb_build_object('ok',false,'error','Code privé refusé ou accès bloqué.');
 end if;
 select * into v_livreur from public.livreurs where id=p_livreur_id for update;
 if not found then
   return jsonb_build_object('ok',false,'error','Livreur introuvable.');
 end if;
 select count(*) into v_tours from public.sorties where livreur_id=p_livreur_id;
 select count(*) into v_colis from public.colis c join public.sorties s
   on s.id=c.sortie_id where s.livreur_id=p_livreur_id;

 insert into dk_private.photo_cleanup(path)
 select obj.name from storage.objects obj
 where obj.bucket_id='colis-photos' and exists(
   select 1 from public.sorties s where s.livreur_id=p_livreur_id
     and obj.name like ('sorties/'||s.id::text||'/%')
 )
 on conflict (path) do nothing;

 -- Conserver les seuls éléments de preuve privés nécessaires à l'audit,
 -- mais ne garder aucune transaction ni somme dans les vues financières.
 update public.app_sessions set revoked_at=now()
 where livreur_id=p_livreur_id and revoked_at is null;
 delete from public.sortie_operations o where exists(
   select 1 from public.sorties s
   where s.id=o.sortie_id and s.livreur_id=p_livreur_id);
 delete from public.colis c where exists(
   select 1 from public.sorties s
   where s.id=c.sortie_id and s.livreur_id=p_livreur_id);
 delete from dk_private.colis_corrections c where exists(
   select 1 from public.sorties s
   where s.id=c.sortie_id and s.livreur_id=p_livreur_id);
 delete from public.sorties where livreur_id=p_livreur_id;
 delete from public.app_sessions where livreur_id=p_livreur_id;
 delete from public.livreurs where id=p_livreur_id;

 insert into dk_private.maintenance_log(actor_profile_id,action,target_id,summary)
 values(public.current_profile_id(),'livreur_efface',p_livreur_id,
   jsonb_build_object('nom',v_livreur.nom,'tournees',v_tours,'colis',v_colis));

 insert into dk_private.cleanup_grant(auth_user_id,expires_at)
 values(auth.uid(),now()+interval '30 minutes')
 on conflict(auth_user_id) do update set expires_at=excluded.expires_at;

 return jsonb_build_object('ok',true,'tournees',v_tours,'colis',v_colis,
   'photos_pending',(select count(*) from dk_private.photo_cleanup));
end;
$$;

revoke execute on function public.corriger_colis_saisi(uuid,text) from public,anon;
revoke execute on function public.confirmer_photo_colis_corrigee(uuid) from public,anon;
revoke execute on function public.consulter_corrections_colis(uuid) from public,anon;
revoke execute on function public.maintenance_liste_livreurs() from public,anon;
revoke execute on function public.maintenance_effacer_livreur(uuid,text) from public,anon;
grant execute on function public.corriger_colis_saisi(uuid,text) to authenticated;
grant execute on function public.confirmer_photo_colis_corrigee(uuid) to authenticated;
grant execute on function public.consulter_corrections_colis(uuid) to authenticated;
grant execute on function public.maintenance_liste_livreurs() to authenticated;
grant execute on function public.maintenance_effacer_livreur(uuid,text) to authenticated;
-- Réinitialisation générale : effacer aussi les rectifications privées, mais
-- préserver la file de nettoyage des photos et le journal propriétaire.
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
  delete from dk_private.colis_corrections where id is not null;
  delete from public.sortie_operations where id is not null;
  delete from public.colis where id is not null;
  delete from public.sorties where id is not null;
  delete from public.app_sessions where livreur_id is not null;
  delete from public.livreurs where id is not null;
  delete from public.zones where id is not null;

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

notify pgrst, 'reload schema';
commit;
