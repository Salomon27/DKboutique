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
