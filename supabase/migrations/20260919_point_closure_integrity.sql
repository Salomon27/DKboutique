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
