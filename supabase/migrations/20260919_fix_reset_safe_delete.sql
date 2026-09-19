-- DK Boutique · correctif du module de reinitialisation.
-- NON DESTRUCTIF lors de l'execution de ce script : remplace uniquement la fonction.
-- Le code prive existant, les comptes et les donnees sont preserves.
-- La reinitialisation reste soumise au profil proprietaire, au code prive
-- et aux confirmations de l'interface. Ne pas relancer database.sql.
begin;
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
revoke execute on function public.maintenance_reset_business(text) from public, anon;
grant execute on function public.maintenance_reset_business(text) to authenticated;
commit;
