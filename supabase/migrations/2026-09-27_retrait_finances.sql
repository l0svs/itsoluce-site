-- Retrait du suivi financier de l'ERP : la comptabilité est tenue dans
-- Accountable. Annule 2026-09-27_depenses_identifiant_auto,
-- 2026-09-27_justificatifs_depenses et 2026-09-27_entrees, et supprime la
-- table depenses (plus aucun écran ne l'utilise).
-- La table charges est conservée telle quelle (non lue par l'ERP).
drop policy if exists justificatifs_lire on storage.objects;
drop policy if exists justificatifs_creer on storage.objects;
drop policy if exists justificatifs_modifier on storage.objects;
drop policy if exists justificatifs_supprimer on storage.objects;
delete from storage.buckets where id = 'justificatifs';  -- bucket vide

drop table if exists public.entrees;
drop table if exists public.depenses;
