-- ============================================================
-- 0. NETTOYAGE
-- ============================================================
drop view if exists public.v_sorties_resume cascade;
drop table if exists public.sortie_operations cascade;
drop table if exists public.colis cascade;
drop table if exists public.sorties cascade;
drop table if exists public.app_sessions cascade;
drop table if exists public.login_attempts cascade;
drop table if exists public.livreurs cascade;
drop table if exists public.profiles cascade;
drop table if exists public.zones cascade;

drop type if exists public.app_role cascade;
drop type if exists public.sortie_statut cascade;
drop type if exists public.colis_source cascade;
drop type if exists public.colis_statut_livreur cascade;
drop type if exists public.operation_type cascade;

-- ============================================================
-- 1. EXTENSIONS & TYPES
-- ============================================================

create extension if not exists pgcrypto;

create type public.app_role as enum (
  'patronne',
  'gerant'
);

create type public.sortie_statut as enum (
  'en_cours',
  'cloturee'
);

create type public.colis_source as enum (
  'initial',
  'ajout'
);

create type public.colis_statut_livreur as enum (
  'en_attente',
  'livre',
  'retourne'
);

create type public.operation_type as enum (
  'ajout',
  'retour',
  'deduction_livraison',
  'frais_divers',
  'cloture'
);

-- ============================================================
-- 2. FONCTION UPDATED_AT
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- 3. ZONES
-- ============================================================

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  nom text not null unique,
  actif boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger zones_set_updated_at
before update on public.zones
for each row execute function public.set_updated_at();

-- ============================================================
-- 4. PROFILS ADMINISTRATION
-- ============================================================

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  role public.app_role not null,
  pin_hash text not null,
  actif boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- ============================================================
-- 5. LIVREURS
-- ============================================================

create table public.livreurs (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  telephone text,
  zone_id uuid not null references public.zones(id) on delete restrict,
  pin_hash text not null,
  actif boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger livreurs_set_updated_at
before update on public.livreurs
for each row execute function public.set_updated_at();

-- ============================================================
-- 6. SESSIONS ET SECURITÉ (BRUTE FORCE)
-- ============================================================

create table public.login_attempts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  success boolean not null default false,
  blocked_until timestamptz
);

create table public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  livreur_id uuid references public.livreurs(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_activity_at timestamptz not null default now(),
  revoked_at timestamptz,
  
  constraint only_one_user_type check (
    (profile_id is not null and livreur_id is null) or 
    (profile_id is null and livreur_id is not null)
  )
);
create unique index on public.app_sessions(auth_user_id) where revoked_at is null;

-- ============================================================
-- 7. HELPERS RLS
-- ============================================================

create or replace function public.has_valid_app_session()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_sessions
    where auth_user_id = auth.uid()
      and revoked_at is null
      and expires_at > now()
  );
$$;

create or replace function public.current_profile_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select profile_id from public.app_sessions
  where auth_user_id = auth.uid()
    and revoked_at is null
    and expires_at > now()
  limit 1;
$$;

create or replace function public.current_livreur_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select livreur_id from public.app_sessions
  where auth_user_id = auth.uid()
    and revoked_at is null
    and expires_at > now()
  limit 1;
$$;

create or replace function public.current_app_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select
    case
      when s.livreur_id is not null then 'livreur'
      when p.role is not null then p.role::text
      else null
    end
  from public.app_sessions s
  left join public.profiles p on p.id = s.profile_id
  where s.auth_user_id = auth.uid()
    and s.revoked_at is null
    and s.expires_at > now()
  limit 1;
$$;

-- ============================================================
-- 8. LOGIN ET LOGOUT RPC (PIN)
-- ============================================================

create or replace function public.login_with_pin(p_pin text)
returns json
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_attempts int;
  v_blocked timestamptz;
  v_profile public.profiles;
  v_livreur public.livreurs;
  v_zone public.zones;
  v_role text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Non autorisé (session Supabase introuvable).';
  end if;

  if p_pin !~ '^\d{4}$' then
    raise exception 'Format invalide.';
  end if;

  -- Bruteforce check
  select blocked_until into v_blocked
  from public.login_attempts
  where auth_user_id = v_uid and blocked_until is not null
  order by attempted_at desc limit 1;

  if v_blocked is not null and v_blocked > now() then
    raise exception 'Trop de tentatives. Réessayez plus tard.';
  end if;

  select count(*) into v_attempts
  from public.login_attempts
  where auth_user_id = v_uid and success = false and attempted_at > now() - interval '15 minutes';

  if v_attempts >= 5 then
    insert into public.login_attempts(auth_user_id, success, blocked_until)
    values (v_uid, false, now() + interval '15 minutes');
    raise exception 'Trop de tentatives. Réessayez plus tard.';
  end if;

  -- Recherche Gérant / Patronne
  select * into v_profile
  from public.profiles
  where actif = true and pin_hash = extensions.crypt(p_pin, pin_hash)
  limit 1;

  if v_profile.id is not null then
    v_role := v_profile.role::text;
    -- Révocation des anciennes sessions
    update public.app_sessions set revoked_at = now() where auth_user_id = v_uid and revoked_at is null;
    -- Création
    insert into public.app_sessions(auth_user_id, profile_id, expires_at)
    values (v_uid, v_profile.id, now() + interval '12 hours');
    
    insert into public.login_attempts(auth_user_id, success) values (v_uid, true);
    
    return json_build_object('success', true, 'role', v_role, 'nom', v_profile.nom, 'id', v_profile.id);
  end if;

  -- Recherche Livreur
  select * into v_livreur
  from public.livreurs
  where actif = true and pin_hash = extensions.crypt(p_pin, pin_hash)
  limit 1;

  if v_livreur.id is not null then
    select * into v_zone from public.zones where id = v_livreur.zone_id;
    v_role := 'livreur';
    update public.app_sessions set revoked_at = now() where auth_user_id = v_uid and revoked_at is null;
    insert into public.app_sessions(auth_user_id, livreur_id, expires_at)
    values (v_uid, v_livreur.id, now() + interval '12 hours');
    
    insert into public.login_attempts(auth_user_id, success) values (v_uid, true);
    
    return json_build_object('success', true, 'role', v_role, 'nom', v_livreur.nom, 'id', v_livreur.id, 'zone_id', v_livreur.zone_id, 'zone_nom', v_zone.nom);
  end if;

  -- Echec
  insert into public.login_attempts(auth_user_id, success) values (v_uid, false);
  raise exception 'Code PIN incorrect.';
end;
$$;

create or replace function public.logout_session()
returns void
language sql security definer
set search_path = ''
as $$
  update public.app_sessions
  set revoked_at = now()
  where auth_user_id = auth.uid() and revoked_at is null;
$$;

revoke execute on function public.login_with_pin(text) from public, anon;
grant execute on function public.login_with_pin(text) to authenticated;

revoke execute on function public.logout_session() from public, anon;
grant execute on function public.logout_session() to authenticated;


-- ============================================================
-- 9. SORTIES / TOURNÉES
-- ============================================================

create table public.sorties (
  id uuid primary key default gen_random_uuid(),
  livreur_id uuid not null references public.livreurs(id) on delete restrict,
  gerant_id uuid references public.profiles(id) on delete set null,
  zone_id uuid not null references public.zones(id) on delete restrict,
  statut public.sortie_statut not null default 'en_cours',
  montant_final numeric(14,2),
  nb_colis_final integer,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint montant_final_positive check (montant_final is null or montant_final >= 0),
  constraint nb_colis_final_positive check (nb_colis_final is null or nb_colis_final >= 0)
);

create unique index one_active_sortie_per_livreur
on public.sorties(livreur_id) where statut = 'en_cours';

create trigger sorties_set_updated_at
before update on public.sorties
for each row execute function public.set_updated_at();

-- ============================================================
-- 10. COLIS
-- ============================================================

create table public.colis (
  id uuid primary key default gen_random_uuid(),
  sortie_id uuid not null references public.sorties(id) on delete cascade,
  source public.colis_source not null default 'initial',
  valeur numeric(14,2) not null default 0,
  commentaire text,
  photo_path text not null,
  statut_livreur public.colis_statut_livreur not null default 'en_attente',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint colis_valeur_positive check (valeur >= 0)
);

create trigger colis_set_updated_at
before update on public.colis
for each row execute function public.set_updated_at();

-- ============================================================
-- 11. OPÉRATIONS SUR UNE TOURNÉE
-- ============================================================

create table public.sortie_operations (
  id uuid primary key default gen_random_uuid(),
  sortie_id uuid not null references public.sorties(id) on delete cascade,
  colis_id uuid references public.colis(id) on delete restrict,
  type public.operation_type not null,
  montant numeric(14,2) not null default 0,
  quantite integer not null default 0,
  commentaire text,
  created_at timestamptz not null default now(),
  constraint operation_montant_positive check (montant >= 0),
  constraint operation_quantite_positive check (quantite >= 0)
);

create unique index one_return_operation_per_colis
on public.sortie_operations(colis_id) where type = 'retour' and colis_id is not null;
create unique index one_cloture_per_sortie
on public.sortie_operations(sortie_id) where type = 'cloture';

-- ============================================================
-- 12. VUE DE CALCUL DES TOURNÉES
-- ============================================================

create or replace view public.v_sorties_resume
with (security_invoker = true)
as
select
  s.id, s.livreur_id, l.nom as livreur_nom, s.zone_id, z.nom as zone_nom,
  s.statut, s.created_at, s.closed_at,
  coalesce(c.nb_initial, 0) as nb_colis_initial, coalesce(c.montant_initial, 0) as montant_initial,
  coalesce(c.nb_ajouts, 0) as nb_colis_ajoutes, coalesce(c.montant_ajouts, 0) as montant_ajouts,
  coalesce(c.nb_total, 0) as nb_colis_total, coalesce(c.montant_total_colis, 0) as montant_chargement,
  coalesce(c.nb_livres, 0) as nb_livres, coalesce(c.nb_retour_signale, 0) as nb_retour_signale,
  coalesce(c.nb_en_attente, 0) as nb_en_attente,
  coalesce(o.montant_retours, 0) as montant_retours, coalesce(o.nb_retours, 0) as nb_retours_confirmes,
  coalesce(o.deduction_livraison, 0) as deduction_livraison, coalesce(o.frais_divers, 0) as frais_divers,
  greatest(0, coalesce(c.montant_total_colis, 0) - coalesce(o.montant_retours, 0) - coalesce(o.deduction_livraison, 0) - coalesce(o.frais_divers, 0)) as net_a_encaisser,
  s.montant_final, s.nb_colis_final
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
  from public.colis c where c.sortie_id = s.id
) c on true
left join lateral (
  select
    coalesce(sum(o.montant) filter (where o.type = 'retour'), 0) as montant_retours,
    count(*) filter (where o.type = 'retour')::integer as nb_retours,
    coalesce(sum(o.montant) filter (where o.type = 'deduction_livraison'), 0) as deduction_livraison,
    coalesce(sum(o.montant) filter (where o.type = 'frais_divers'), 0) as frais_divers
  from public.sortie_operations o where o.sortie_id = s.id
) o on true;

-- ============================================================
-- 13. FONCTION DE CLÔTURE
-- ============================================================

create or replace function public.cloturer_sortie(p_sortie_id uuid)
returns table (sortie_id uuid, montant_final numeric, nb_colis integer)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_net numeric(14,2); v_nb integer; v_role text;
begin
  v_role := public.current_app_role();
  if v_role not in ('gerant', 'patronne') then
    raise exception 'Accès refusé.';
  end if;

  if not exists (select 1 from public.sorties where id = p_sortie_id and statut = 'en_cours') then
    raise exception 'Cette tournée est inexistante ou déjà clôturée.';
  end if;

  select r.net_a_encaisser, r.nb_colis_total into v_net, v_nb
  from public.v_sorties_resume r where r.id = p_sortie_id;

  update public.sorties set statut = 'cloturee', montant_final = v_net, nb_colis_final = v_nb, closed_at = now() where id = p_sortie_id;
  insert into public.sortie_operations (sortie_id, type, montant, quantite, commentaire)
  values (p_sortie_id, 'cloture', v_net, v_nb, 'Clôture définitive de la tournée');

  return query select p_sortie_id, v_net, v_nb;
end;
$$;

revoke execute on function public.cloturer_sortie(uuid) from public, anon;
grant execute on function public.cloturer_sortie(uuid) to authenticated;

-- ============================================================
-- 14. POLITIQUES RLS STRICTES
-- ============================================================

alter table public.zones enable row level security;
alter table public.profiles enable row level security;
alter table public.livreurs enable row level security;
alter table public.sorties enable row level security;
alter table public.colis enable row level security;
alter table public.sortie_operations enable row level security;
alter table public.app_sessions enable row level security;
alter table public.login_attempts enable row level security;

-- App Sessions : un utilisateur voit uniquement ses propres sessions
create policy "Users manage own sessions" on public.app_sessions
to authenticated using (auth_user_id = auth.uid());

-- Login Attempts : un utilisateur voit uniquement ses tentatives
create policy "Users view own attempts" on public.login_attempts
to authenticated using (auth_user_id = auth.uid());

-- Zones : Lecture pour tout le monde avec une session
create policy "Read Zones if session" on public.zones for select
to authenticated using (public.has_valid_app_session());

-- Profils / Livreurs : Lecture pour les admin, Livreurs voient leur propre profil
create policy "Admins see profiles" on public.profiles for select
to authenticated using (public.current_app_role() in ('gerant', 'patronne'));
create policy "Admins see livreurs" on public.livreurs for select
to authenticated using (public.current_app_role() in ('gerant', 'patronne'));
create policy "Livreur sees self" on public.livreurs for select
to authenticated using (id = public.current_livreur_id());

-- Sorties : Admin voient tout. Livreur voit uniquement SES sorties
create policy "Admins ALL Sorties" on public.sorties 
to authenticated using (public.current_app_role() in ('gerant', 'patronne'));

create policy "Livreur SELECT Sorties" on public.sorties for select
to authenticated using (livreur_id = public.current_livreur_id());

-- Colis : Admin voient tout. Livreur voit les colis de sa sortie. Livreur peut modifier statut.
create policy "Admins ALL Colis" on public.colis 
to authenticated using (public.current_app_role() in ('gerant', 'patronne'));

create policy "Livreur SELECT Colis" on public.colis for select
to authenticated using (sortie_id in (select id from public.sorties where livreur_id = public.current_livreur_id()));

create policy "Livreur UPDATE Colis Statut" on public.colis for update
to authenticated using (sortie_id in (select id from public.sorties where livreur_id = public.current_livreur_id()))
with check (sortie_id in (select id from public.sorties where livreur_id = public.current_livreur_id()));

-- Opérations : Admin voient et insèrent tout.
create policy "Admins ALL Ops" on public.sortie_operations
to authenticated using (public.current_app_role() in ('gerant', 'patronne'));

-- Vues : gérées par security_invoker = true

-- Index Unique Anti-Double Déduction (Module Le Point)
CREATE UNIQUE INDEX IF NOT EXISTS one_delivery_deduction_per_colis
ON public.sortie_operations(colis_id)
WHERE type = 'deduction_livraison' AND colis_id IS NOT NULL;
