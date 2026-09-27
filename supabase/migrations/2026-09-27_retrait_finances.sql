-- Retrait du suivi financier de l'ERP : la comptabilité est tenue dans
-- Accountable. Annule 2026-09-27_depenses_identifiant_auto,
-- 2026-09-27_justificatifs_depenses et 2026-09-27_entrees, et supprime la
-- table depenses (plus aucun écran ne l'utilise).
-- La table charges (2 lignes inactives, plus lue par l'ERP) est supprimée aussi.
drop policy if exists justificatifs_lire on storage.objects;
drop policy if exists justificatifs_creer on storage.objects;
drop policy if exists justificatifs_modifier on storage.objects;
drop policy if exists justificatifs_supprimer on storage.objects;
-- Le bucket « justificatifs » (vide, privé, sans politique) ne peut pas être
-- supprimé en SQL (storage.protect_delete) : à retirer depuis le tableau de
-- bord Supabase, Storage › justificatifs › Delete bucket.

drop table if exists public.entrees;
drop table if exists public.depenses;
drop table if exists public.charges;
