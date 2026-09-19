-- DK BOUTIQUE | MISE A NIVEAU DE LA BASE EN LIGNE
-- A executer une seule fois dans Supabase > SQL Editor > Run.
-- NON DESTRUCTIF : ne relancez jamais database.sql sur une base existante.
-- Applique les migrations déjà présentes dans le dépôt :
-- sécurisation métier, gestion équipe/zones, vues de synthèse et clôture.
-- N'efface PAS les tournées, colis, photos ou comptes existants.

-- DK Boutique TEST bundle
-- Generated to simplify first test deployment.
-- Execute once in Supabase SQL Editor on the existing DK Boutique project.


-- ===== supabase/migrations/20260919_core_hardening.sql =====
-- DK Boutique - Core hardening migration
-- Non destructive: do not replace the existing bootstrap database.sql with this file.

begin;

-- Session helpers are callable only by authenticated Supabase sessions.
revoke execute on function public.has_valid_app_session() from public, anon;
revoke execute on function public.current_app_role() from public, anon;
revoke execute on function public.current_profile_id() from public, anon;
revoke execute on function public.current_livreur_id() from public, anon;

grant execute on function public.has_valid_app_session() to authenticated;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.current_profile_id() to authenticated;
grant execute on function public.current_livreur_id() to authenticated;

-- Clients must never edit app_sessions or login_attempts directly.
drop policy if exists "Users manage own sessions" on public.app_sessions;
drop policy if exists "Users view own attempts" on public.login_attempts;

-- Livreur may change only the delivery status of a parcel assigned to
-- their active tour. This SECURITY DEFINER RPC replaces generic table UPDATE.
create or replace function public.update_livreur_colis_status(
  p_colis_id uuid,
  p_statut text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_livreur_id uuid;
begin
  if p_statut not in ('en_attente', 'livre', 'retourne') then
    raise exception 'Statut invalide.';
  end if;

  v_livreur_id := public.current_livreur_id();

  if v_livreur_id is null then
    raise exception 'Accès refusé.';
  end if;

  update public.colis c
  set statut_livreur = p_statut::public.colis_statut_livreur
  from public.sorties s
  where c.id = p_colis_id
    and c.sortie_id = s.id
    and s.livreur_id = v_livreur_id
    and s.statut = 'en_cours';

  if not found then
    raise exception 'Colis introuvable, non autorisé ou tournée clôturée.';
  end if;
end;
$$;

revoke execute on function public.update_livreur_colis_status(uuid, text) from public, anon;
grant execute on function public.update_livreur_colis_status(uuid, text) to authenticated;

-- Financial-operation integrity is checked server-side.
create or replace function public.enforce_sortie_operation_integrity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_colis_sortie_id uuid;
  v_colis_valeur numeric(14,2);
  v_sortie_statut public.sortie_statut;
begin
  select s.statut
  into v_sortie_statut
  from public.sorties s
  where s.id = new.sortie_id;

  if v_sortie_statut is null then
    raise exception 'Tournée introuvable.';
  end if;

  if v_sortie_statut <> 'en_cours' and new.type <> 'cloture' then
    raise exception 'La tournée est déjà clôturée.';
  end if;

  if new.colis_id is not null then
    select c.sortie_id, c.valeur
    into v_colis_sortie_id, v_colis_valeur
    from public.colis c
    where c.id = new.colis_id;

    if v_colis_sortie_id is null then
      raise exception 'Colis introuvable.';
    end if;

    if v_colis_sortie_id <> new.sortie_id then
      raise exception 'Le colis n''appartient pas à cette tournée.';
    end if;
  end if;

  if new.type = 'retour' then
    if new.colis_id is null then
      raise exception 'Un retour doit être lié à un colis.';
    end if;
    new.montant := v_colis_valeur;
    new.quantite := 1;
  elsif new.type = 'deduction_livraison' then
    if new.colis_id is null then
      raise exception 'Une déduction livraison doit être liée à un colis.';
    end if;
    if v_colis_valeur <> 0 then
      raise exception 'La déduction livraison est réservée aux colis déjà payés.';
    end if;
    if new.montant <= 0 then
      raise exception 'Montant de déduction invalide.';
    end if;
    new.quantite := 1;
  elsif new.type = 'frais_divers' then
    if new.montant <= 0 then
      raise exception 'Montant de frais invalide.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists sortie_operations_integrity on public.sortie_operations;
create trigger sortie_operations_integrity
before insert or update on public.sortie_operations
for each row execute function public.enforce_sortie_operation_integrity();

-- Role separation: Gérant operates; Patronne supervises read-only.
drop policy if exists "Admins ALL Sorties" on public.sorties;
drop policy if exists "Gerant SELECT Sorties" on public.sorties;
drop policy if exists "Gerant INSERT Sorties" on public.sorties;
drop policy if exists "Patronne SELECT Sorties" on public.sorties;

create policy "Gerant SELECT Sorties"
on public.sorties for select
to authenticated
using (public.current_app_role() = 'gerant');

create policy "Gerant INSERT Sorties"
on public.sorties for insert
to authenticated
with check (public.current_app_role() = 'gerant');

create policy "Patronne SELECT Sorties"
on public.sorties for select
to authenticated
using (public.current_app_role() = 'patronne');

drop policy if exists "Admins ALL Colis" on public.colis;
drop policy if exists "Livreur UPDATE Colis Statut" on public.colis;
drop policy if exists "Gerant SELECT Colis" on public.colis;
drop policy if exists "Gerant INSERT Colis" on public.colis;
drop policy if exists "Patronne SELECT Colis" on public.colis;

create policy "Gerant SELECT Colis"
on public.colis for select
to authenticated
using (public.current_app_role() = 'gerant');

create policy "Gerant INSERT Colis"
on public.colis for insert
to authenticated
with check (
  public.current_app_role() = 'gerant'
  and exists (
    select 1
    from public.sorties s
    where s.id = sortie_id
      and s.statut = 'en_cours'
  )
);

create policy "Patronne SELECT Colis"
on public.colis for select
to authenticated
using (public.current_app_role() = 'patronne');

drop policy if exists "Admins ALL Ops" on public.sortie_operations;
drop policy if exists "Gerant SELECT Ops" on public.sortie_operations;
drop policy if exists "Gerant INSERT Ops" on public.sortie_operations;
drop policy if exists "Gerant DELETE Ops" on public.sortie_operations;
drop policy if exists "Patronne SELECT Ops" on public.sortie_operations;

create policy "Gerant SELECT Ops"
on public.sortie_operations for select
to authenticated
using (public.current_app_role() = 'gerant');

create policy "Gerant INSERT Ops"
on public.sortie_operations for insert
to authenticated
with check (
  public.current_app_role() = 'gerant'
  and type <> 'cloture'
  and exists (
    select 1
    from public.sorties s
    where s.id = sortie_id
      and s.statut = 'en_cours'
  )
);

create policy "Gerant DELETE Ops"
on public.sortie_operations for delete
to authenticated
using (
  public.current_app_role() = 'gerant'
  and type <> 'cloture'
  and exists (
    select 1
    from public.sorties s
    where s.id = sortie_id
      and s.statut = 'en_cours'
  )
);

create policy "Patronne SELECT Ops"
on public.sortie_operations for select
to authenticated
using (public.current_app_role() = 'patronne');

create unique index if not exists one_delivery_deduction_per_colis
on public.sortie_operations(colis_id)
where type = 'deduction_livraison' and colis_id is not null;

create unique index if not exists one_return_operation_per_colis
on public.sortie_operations(colis_id)
where type = 'retour' and colis_id is not null;

-- Only the Gérant may close a tour. Row locking prevents concurrent closure.
create or replace function public.cloturer_sortie(p_sortie_id uuid)
returns table (sortie_id uuid, montant_final numeric, nb_colis integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_net numeric(14,2);
  v_nb integer;
  v_role text;
  v_statut public.sortie_statut;
begin
  v_role := public.current_app_role();

  if v_role <> 'gerant' then
    raise exception 'Accès refusé.';
  end if;

  select s.statut
  into v_statut
  from public.sorties s
  where s.id = p_sortie_id
  for update;

  if v_statut is null then
    raise exception 'Tournée introuvable.';
  end if;

  if v_statut <> 'en_cours' then
    raise exception 'Cette tournée est déjà clôturée.';
  end if;

  select r.net_a_encaisser, r.nb_colis_total
  into v_net, v_nb
  from public.v_sorties_resume r
  where r.id = p_sortie_id;

  update public.sorties
  set statut = 'cloturee',
      montant_final = v_net,
      nb_colis_final = v_nb,
      closed_at = now()
  where id = p_sortie_id;

  insert into public.sortie_operations
    (sortie_id, type, montant, quantite, commentaire)
  values
    (p_sortie_id, 'cloture', v_net, v_nb, 'Clôture définitive de la tournée');

  return query select p_sortie_id, v_net, v_nb;
end;
$$;

revoke execute on function public.cloturer_sortie(uuid) from public, anon;
grant execute on function public.cloturer_sortie(uuid) to authenticated;

commit;


-- ===== supabase/migrations/20260919_operational_modules.sql =====
-- DK Boutique - Operational modules
-- Secure team/zone management and shared operational summaries.

begin;

create or replace function public.pin_already_used(
  p_pin text,
  p_exclude_livreur uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used boolean;
begin
  if p_pin !~ '^\d{4}$' then
    return true;
  end if;

  select exists (
    select 1
    from public.profiles p
    where p.actif = true
      and p.pin_hash = extensions.crypt(p_pin, p.pin_hash)

    union all

    select 1
    from public.livreurs l
    where l.actif = true
      and (p_exclude_livreur is null or l.id <> p_exclude_livreur)
      and l.pin_hash = extensions.crypt(p_pin, l.pin_hash)
  )
  into v_used;

  return coalesce(v_used, false);
end;
$$;

revoke execute on function public.pin_already_used(text, uuid) from public, anon, authenticated;

create or replace function public.create_livreur_account(
  p_nom text,
  p_telephone text,
  p_zone_id uuid,
  p_pin text
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_nom text;
begin
  if public.current_app_role() <> 'gerant' then
    raise exception 'Accès refusé.';
  end if;

  v_nom := nullif(trim(p_nom), '');
  if v_nom is null then
    raise exception 'Le nom du livreur est requis.';
  end if;

  if p_pin !~ '^\d{4}$' then
    raise exception 'Le code PIN doit contenir exactement 4 chiffres.';
  end if;

  if not exists (
    select 1 from public.zones
    where id = p_zone_id and actif = true
  ) then
    raise exception 'Zone invalide ou inactive.';
  end if;

  if public.pin_already_used(p_pin, null) then
    raise exception 'Ce code PIN est déjà utilisé.';
  end if;

  insert into public.livreurs (
    nom, telephone, zone_id, pin_hash, actif
  )
  values (
    v_nom,
    nullif(trim(p_telephone), ''),
    p_zone_id,
    extensions.crypt(p_pin, extensions.gen_salt('bf')),
    true
  )
  returning id into v_id;

  return json_build_object(
    'success', true,
    'id', v_id,
    'nom', v_nom
  );
end;
$$;

revoke execute on function public.create_livreur_account(text, text, uuid, text) from public, anon;
grant execute on function public.create_livreur_account(text, text, uuid, text) to authenticated;


create or replace function public.update_livreur_account(
  p_livreur_id uuid,
  p_nom text,
  p_telephone text,
  p_zone_id uuid,
  p_actif boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_app_role() <> 'gerant' then
    raise exception 'Accès refusé.';
  end if;

  if nullif(trim(p_nom), '') is null then
    raise exception 'Le nom du livreur est requis.';
  end if;

  if not exists (
    select 1 from public.zones
    where id = p_zone_id
  ) then
    raise exception 'Zone introuvable.';
  end if;

  if p_actif = false and exists (
    select 1
    from public.sorties s
    where s.livreur_id = p_livreur_id
      and s.statut = 'en_cours'
  ) then
    raise exception 'Impossible de désactiver un livreur actuellement en tournée.';
  end if;

  update public.livreurs
  set nom = trim(p_nom),
      telephone = nullif(trim(p_telephone), ''),
      zone_id = p_zone_id,
      actif = p_actif
  where id = p_livreur_id;

  if not found then
    raise exception 'Livreur introuvable.';
  end if;
end;
$$;

revoke execute on function public.update_livreur_account(uuid, text, text, uuid, boolean) from public, anon;
grant execute on function public.update_livreur_account(uuid, text, text, uuid, boolean) to authenticated;


create or replace function public.reset_livreur_pin(
  p_livreur_id uuid,
  p_pin text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_app_role() <> 'gerant' then
    raise exception 'Accès refusé.';
  end if;

  if p_pin !~ '^\d{4}$' then
    raise exception 'Le code PIN doit contenir exactement 4 chiffres.';
  end if;

  if public.pin_already_used(p_pin, p_livreur_id) then
    raise exception 'Ce code PIN est déjà utilisé.';
  end if;

  update public.livreurs
  set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
  where id = p_livreur_id;

  if not found then
    raise exception 'Livreur introuvable.';
  end if;

  update public.app_sessions
  set revoked_at = now()
  where livreur_id = p_livreur_id
    and revoked_at is null;
end;
$$;

revoke execute on function public.reset_livreur_pin(uuid, text) from public, anon;
grant execute on function public.reset_livreur_pin(uuid, text) to authenticated;


create or replace function public.create_zone(p_nom text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_nom text := nullif(trim(p_nom), '');
begin
  if public.current_app_role() <> 'gerant' then
    raise exception 'Accès refusé.';
  end if;

  if v_nom is null then
    raise exception 'Le nom de la zone est requis.';
  end if;

  insert into public.zones(nom, actif)
  values (v_nom, true)
  on conflict (nom) do update
    set actif = true
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.create_zone(text) from public, anon;
grant execute on function public.create_zone(text) to authenticated;


create or replace function public.update_zone(
  p_zone_id uuid,
  p_nom text,
  p_actif boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_app_role() <> 'gerant' then
    raise exception 'Accès refusé.';
  end if;

  if nullif(trim(p_nom), '') is null then
    raise exception 'Le nom de la zone est requis.';
  end if;

  if p_actif = false and exists (
    select 1
    from public.livreurs l
    where l.zone_id = p_zone_id
      and l.actif = true
  ) then
    raise exception 'Cette zone est encore affectée à un livreur actif.';
  end if;

  update public.zones
  set nom = trim(p_nom),
      actif = p_actif
  where id = p_zone_id;

  if not found then
    raise exception 'Zone introuvable.';
  end if;
end;
$$;

revoke execute on function public.update_zone(uuid, text, boolean) from public, anon;
grant execute on function public.update_zone(uuid, text, boolean) to authenticated;


create or replace view public.v_livreurs_resume
with (security_invoker = true)
as
select
  l.id,
  l.nom,
  l.telephone,
  l.zone_id,
  z.nom as zone_nom,
  l.actif,
  coalesce(s_stats.en_tournee, false) as en_tournee,
  coalesce(s_stats.nb_tournees, 0)::integer as nb_tournees,
  coalesce(c_stats.nb_colis_total, 0)::integer as nb_colis_total,
  coalesce(c_stats.nb_colis_livres, 0)::integer as nb_colis_livres,
  coalesce(c_stats.nb_colis_retournes, 0)::integer as nb_colis_retournes,
  coalesce(s_stats.total_encaisse, 0) as total_encaisse
from public.livreurs l
join public.zones z on z.id = l.zone_id
left join lateral (
  select
    exists (
      select 1
      from public.sorties sa
      where sa.livreur_id = l.id
        and sa.statut = 'en_cours'
    ) as en_tournee,
    count(*)::integer as nb_tournees,
    coalesce(
      sum(s.montant_final) filter (where s.statut = 'cloturee'),
      0
    ) as total_encaisse
  from public.sorties s
  where s.livreur_id = l.id
) s_stats on true
left join lateral (
  select
    count(c.id)::integer as nb_colis_total,
    count(c.id) filter (where c.statut_livreur = 'livre')::integer as nb_colis_livres,
    count(c.id) filter (where c.statut_livreur = 'retourne')::integer as nb_colis_retournes
  from public.colis c
  join public.sorties s on s.id = c.sortie_id
  where s.livreur_id = l.id
) c_stats on true;

grant select on public.v_livreurs_resume to authenticated;

commit;


-- ===== supabase/migrations/20260919_reporting_scope.sql =====
-- DK Boutique - Reporting scope and performance indexes

begin;

-- Append gerant_id to the canonical tour summary without changing existing columns.
create or replace view public.v_sorties_resume
with (security_invoker = true)
as
select
  s.id,
  s.livreur_id,
  l.nom as livreur_nom,
  s.zone_id,
  z.nom as zone_nom,
  s.statut,
  s.created_at,
  s.closed_at,
  coalesce(c.nb_initial, 0) as nb_colis_initial,
  coalesce(c.montant_initial, 0) as montant_initial,
  coalesce(c.nb_ajouts, 0) as nb_colis_ajoutes,
  coalesce(c.montant_ajouts, 0) as montant_ajouts,
  coalesce(c.nb_total, 0) as nb_colis_total,
  coalesce(c.montant_total_colis, 0) as montant_chargement,
  coalesce(c.nb_livres, 0) as nb_livres,
  coalesce(c.nb_retour_signale, 0) as nb_retour_signale,
  coalesce(c.nb_en_attente, 0) as nb_en_attente,
  coalesce(o.montant_retours, 0) as montant_retours,
  coalesce(o.nb_retours, 0) as nb_retours_confirmes,
  coalesce(o.deduction_livraison, 0) as deduction_livraison,
  coalesce(o.frais_divers, 0) as frais_divers,
  greatest(
    0,
    coalesce(c.montant_total_colis, 0)
      - coalesce(o.montant_retours, 0)
      - coalesce(o.deduction_livraison, 0)
      - coalesce(o.frais_divers, 0)
  ) as net_a_encaisser,
  s.montant_final,
  s.nb_colis_final,
  s.gerant_id
from public.sorties s
join public.livreurs l on l.id = s.livreur_id
join public.zones z on z.id = s.zone_id
left join lateral (
  select
    count(*) filter (where c.source = 'initial')::integer as nb_initial,
    coalesce(sum(c.valeur) filter (where c.source = 'initial'), 0) as montant_initial,
    count(*) filter (where c.source = 'ajout')::integer as nb_ajouts,
    coalesce(sum(c.valeur) filter (where c.source = 'ajout'), 0) as montant_ajouts,
    count(*)::integer as nb_total,
    coalesce(sum(c.valeur), 0) as montant_total_colis,
    count(*) filter (where c.statut_livreur = 'livre')::integer as nb_livres,
    count(*) filter (where c.statut_livreur = 'retourne')::integer as nb_retour_signale,
    count(*) filter (where c.statut_livreur = 'en_attente')::integer as nb_en_attente
  from public.colis c
  where c.sortie_id = s.id
) c on true
left join lateral (
  select
    coalesce(sum(o.montant) filter (where o.type = 'retour'), 0) as montant_retours,
    count(*) filter (where o.type = 'retour')::integer as nb_retours,
    coalesce(sum(o.montant) filter (where o.type = 'deduction_livraison'), 0) as deduction_livraison,
    coalesce(sum(o.montant) filter (where o.type = 'frais_divers'), 0) as frais_divers
  from public.sortie_operations o
  where o.sortie_id = s.id
) o on true;

grant select on public.v_sorties_resume to authenticated;

create index if not exists sorties_closed_at_idx
  on public.sorties(closed_at desc)
  where statut = 'cloturee';

create index if not exists sorties_created_at_idx
  on public.sorties(created_at desc);

create index if not exists sorties_gerant_created_idx
  on public.sorties(gerant_id, created_at desc);

create index if not exists colis_sortie_created_idx
  on public.colis(sortie_id, created_at);

create index if not exists colis_status_idx
  on public.colis(statut_livreur);

create index if not exists sortie_operations_sortie_created_idx
  on public.sortie_operations(sortie_id, created_at);

commit;



-- Controler la clôture après les autres migrations.
-- DK Boutique - Point closure integrity
-- Requires the core hardening migration.

begin;

create or replace function public.cloturer_sortie(p_sortie_id uuid)
returns table (sortie_id uuid, montant_final numeric, nb_colis integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_net numeric(14,2);
  v_nb integer;
  v_role text;
  v_statut public.sortie_statut;
  v_pending integer;
  v_unconfirmed_returns integer;
begin
  v_role := public.current_app_role();

  if v_role <> 'gerant' then
    raise exception 'Accès refusé.';
  end if;

  select s.statut
  into v_statut
  from public.sorties s
  where s.id = p_sortie_id
  for update;

  if v_statut is null then
    raise exception 'Tournée introuvable.';
  end if;

  if v_statut <> 'en_cours' then
    raise exception 'Cette tournée est déjà clôturée.';
  end if;

  select count(*)
  into v_pending
  from public.colis c
  where c.sortie_id = p_sortie_id
    and c.statut_livreur = 'en_attente';

  if v_pending > 0 then
    raise exception '% colis sont encore en attente.', v_pending;
  end if;

  select count(*)
  into v_unconfirmed_returns
  from public.colis c
  where c.sortie_id = p_sortie_id
    and c.statut_livreur = 'retourne'
    and not exists (
      select 1
      from public.sortie_operations o
      where o.sortie_id = p_sortie_id
        and o.colis_id = c.id
        and o.type = 'retour'
    );

  if v_unconfirmed_returns > 0 then
    raise exception '% retour(s) signalé(s) doivent encore être confirmés.', v_unconfirmed_returns;
  end if;

  select r.net_a_encaisser, r.nb_colis_total
  into v_net, v_nb
  from public.v_sorties_resume r
  where r.id = p_sortie_id;

  if v_nb is null or v_nb <= 0 then
    raise exception 'Impossible de clôturer une tournée sans colis.';
  end if;

  update public.sorties
  set statut = 'cloturee',
      montant_final = v_net,
      nb_colis_final = v_nb,
      closed_at = now()
  where id = p_sortie_id;

  insert into public.sortie_operations
    (sortie_id, type, montant, quantite, commentaire)
  values
    (p_sortie_id, 'cloture', v_net, v_nb, 'Clôture définitive de la tournée');

  return query
  select p_sortie_id, v_net, v_nb;
end;
$$;

revoke execute on function public.cloturer_sortie(uuid) from public, anon;
grant execute on function public.cloturer_sortie(uuid) to authenticated;

commit;


-- Vérification finale (les colonnes doivent être toutes présentes).
select
  exists (select 1 from information_schema.columns where table_schema='public' and table_name='v_sorties_resume' and column_name='gerant_id') as vue_tournees_avec_gerant,
  to_regclass('public.v_livreurs_resume') is not null as vue_equipe_disponible,
  to_regprocedure('public.create_livreur_account(text,text,uuid,text)') is not null as creation_livreur_disponible,
  to_regprocedure('public.update_livreur_colis_status(uuid,text)') is not null as statut_livreur_disponible,
  to_regprocedure('public.cloturer_sortie(uuid)') is not null as cloture_disponible;
