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
