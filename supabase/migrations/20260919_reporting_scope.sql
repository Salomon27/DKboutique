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
