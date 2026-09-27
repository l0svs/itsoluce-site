-- Justificatif (PDF ou photo) attaché à une dépense.
-- Fichiers dans un bucket privé : lecture par lien signé de courte durée,
-- mêmes droits que la table depenses (page Gestion).
alter table public.depenses add column if not exists justificatif text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('justificatifs', 'justificatifs', false, 10485760,
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists justificatifs_lire on storage.objects;
drop policy if exists justificatifs_creer on storage.objects;
drop policy if exists justificatifs_modifier on storage.objects;
drop policy if exists justificatifs_supprimer on storage.objects;

create policy justificatifs_lire on storage.objects for select to authenticated
  using (bucket_id = 'justificatifs' and public.a_acces(array['gestion']));
create policy justificatifs_creer on storage.objects for insert to authenticated
  with check (bucket_id = 'justificatifs' and public.peut_ecrire(array['gestion']));
create policy justificatifs_modifier on storage.objects for update to authenticated
  using (bucket_id = 'justificatifs' and public.peut_ecrire(array['gestion']))
  with check (bucket_id = 'justificatifs' and public.peut_ecrire(array['gestion']));
create policy justificatifs_supprimer on storage.objects for delete to authenticated
  using (bucket_id = 'justificatifs' and public.peut_effacer(array['gestion']));
