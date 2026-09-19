-- DK BOUTIQUE | Correction de colis et purge ciblée d'un livreur
-- Installation NON DESTRUCTIVE : aucune donnée supprimée par ce script.
-- Requiert l'administration privée déjà installée; pas de code secret dans Git.
begin;

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
commit;
