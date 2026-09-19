-- DK Boutique: secure storage access for parcel photos.
-- Execute once in Supabase SQL Editor against the existing DK Boutique project.
-- Safe for existing data: no bucket recreation, table edits, or deletion of files.
begin;

-- The browser uploads only to: sorties/<sortie UUID>/<colis UUID>.jpg
-- A logged-in Gérant may upload only into one of their active tours.
drop policy if exists "dk_colis_gerant_upload" on storage.objects;
create policy "dk_colis_gerant_upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'colis-photos'
  and public.current_app_role() = 'gerant'
  and (storage.foldername(name))[1] = 'sorties'
  and storage.filename(name) ~ '^[0-9a-fA-F-]{36}[.]jpg$'
  and exists (
    select 1
    from public.sorties s
    where s.id::text = (storage.foldername(name))[2]
      and s.statut = 'en_cours'
      and s.gerant_id = public.current_profile_id()
  )
);

-- The Gérant sees their tour photos; the Patronne supervises;
-- a Livreur sees only photos from their own tours (including archives).
drop policy if exists "dk_colis_authorized_photo_read" on storage.objects;
create policy "dk_colis_authorized_photo_read"
on storage.objects for select to authenticated
using (
  bucket_id = 'colis-photos'
  and (storage.foldername(name))[1] = 'sorties'
  and exists (
    select 1
    from public.sorties s
    where s.id::text = (storage.foldername(name))[2]
      and (
        public.current_app_role() = 'patronne'
        or (public.current_app_role() = 'gerant'
            and s.gerant_id = public.current_profile_id())
        or (public.current_app_role() = 'livreur'
            and s.livreur_id = public.current_livreur_id())
      )
  )
);

-- Remove an uploaded object only from the same manager's active tour,
-- e.g. when a parcel insert fails after the image was uploaded.
drop policy if exists "dk_colis_gerant_cleanup" on storage.objects;
create policy "dk_colis_gerant_cleanup"
on storage.objects for delete to authenticated
using (
  bucket_id = 'colis-photos'
  and public.current_app_role() = 'gerant'
  and (storage.foldername(name))[1] = 'sorties'
  and exists (
    select 1
    from public.sorties s
    where s.id::text = (storage.foldername(name))[2]
      and s.statut = 'en_cours'
      and s.gerant_id = public.current_profile_id()
  )
);
commit;
