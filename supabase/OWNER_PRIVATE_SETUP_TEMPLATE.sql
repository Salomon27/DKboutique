-- CONFIGURATION PRIVÉE : À copier dans Supabase SQL Editor, JAMAIS à committer
-- ou à envoyer dans une capture. Le véritable code n'est pas dans GitHub.
-- Étape 1 : exécuter la migration 20260919_private_owner_maintenance.sql.
-- Étape 2 : contrôler l'identité ci-dessous (une seule Patronne active).
select id, nom, role, actif
from public.profiles
where role::text = 'patronne';

-- Étape 3 : dans VOTRE SQL Editor privé uniquement, remplacer la chaîne
-- REMPLACER_PAR_VOTRE_CODE_PRIVE par votre code exact, sans l'envoyer à GitHub.
-- Si plusieurs Patronnes actives existent, NE PAS exécuter : contactez l'administrateur
-- pour sélectionner explicitement le profil propriétaire.
do $private_setup$
declare
  v_private_code text := 'REMPLACER_PAR_VOTRE_CODE_PRIVE';
  v_owner_id uuid;
  v_count integer;
begin
  if v_private_code = 'REMPLACER_PAR_VOTRE_CODE_PRIVE'
     or pg_catalog.length(v_private_code) < 8 then
    raise exception 'Configuration non effectuée : saisissez votre propre code dans SQL Editor.';
  end if;
  select count(*) into v_count
  from public.profiles where role::text = 'patronne' and actif = true;
  if v_count <> 1 then
    raise exception 'Un seul profil Patronne actif doit être identifié avant configuration.';
  end if;
  select id into v_owner_id
  from public.profiles where role::text = 'patronne' and actif = true;
  insert into dk_private.owner_control
    (id, owner_profile_id, secret_hash, failures, blocked_until, updated_at)
  values
    (1, v_owner_id,
      extensions.crypt(v_private_code, extensions.gen_salt('bf', 12)),
      0, null, now())
  on conflict (id) do update set
    owner_profile_id = excluded.owner_profile_id,
    secret_hash = excluded.secret_hash,
    failures = 0,
    blocked_until = null,
    updated_at = now();

  -- Écrasement de la variable locale, pas de stockage en clair en base.
  v_private_code := null;
end;
$private_setup$;

-- Vérification ne retournant ni le secret ni son empreinte :
select (select nom from public.profiles
        where id = (select owner_profile_id from dk_private.owner_control where id = 1))
        as profil_proprietaire,
       exists(select 1 from dk_private.owner_control where id = 1) as configuration_active;
