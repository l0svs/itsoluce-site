-- ═══════════════════════════════════════════════════════════════════
-- Site vitrine : bandeau « Absence », section « Réalisations »,
-- prestations « Sur devis »
--
-- 1. Absence : les réglages vivent dans settings (Gestion › Absence).
--    Le site ne lit pas settings (réservée aux comptes connectés) : il
--    appelle site_absence(), qui ne renvoie que l'absence à afficher, et
--    seulement pendant la période d'annonce et d'absence.
-- 2. Réalisations : une table (titre, appareil, description, médias) et un
--    espace de stockage public pour les photos et vidéos. Le site ne lit
--    que les réalisations publiées.
-- 3. Prestations : un prix vide signifie « Sur devis » sur le site.
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ─── 1. Absence ───
create or replace function public.site_absence()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_auj    date := (now() at time zone 'Europe/Brussels')::date;
  v_debut  date;
  v_fin    date;
  v_annonce int;
begin
  if coalesce((select lower(trim(valeur)) from settings where cle = 'absence_actif'), 'non') <> 'oui' then
    return null;
  end if;
  begin
    v_debut := nullif(trim((select valeur from settings where cle = 'absence_debut')), '')::date;
    v_fin   := nullif(trim((select valeur from settings where cle = 'absence_fin')), '')::date;
    v_annonce := coalesce(nullif(trim((select valeur from settings where cle = 'absence_annonce_jours')), '')::int, 7);
  exception when others then
    return null;   -- réglage illisible : rien plutôt qu'un bandeau faux
  end;
  if v_debut is null or v_fin is null or v_fin < v_debut then
    return null;
  end if;
  v_annonce := least(greatest(v_annonce, 0), 60);
  if v_auj < v_debut - v_annonce or v_auj > v_fin then
    return null;
  end if;
  return jsonb_build_object(
    'phase',    case when v_auj < v_debut then 'avant' else 'pendant' end,
    'debut',    v_debut,
    'fin',      v_fin,
    'retour',   v_fin + 1,
    'message',  nullif(trim(coalesce((select valeur from settings where cle = 'absence_message'), '')), ''),
    'depots',   coalesce((select lower(trim(valeur)) from settings where cle = 'absence_depots'), 'oui') = 'oui',
    'telephone',coalesce((select lower(trim(valeur)) from settings where cle = 'absence_telephone'), 'oui') = 'oui'
  );
end $$;
revoke execute on function public.site_absence() from public;
grant execute on function public.site_absence() to anon, authenticated;

-- ─── 2. Réalisations ───
create table if not exists public.realisations (
  id          bigint generated always as identity primary key,
  titre       text not null check (length(trim(titre)) between 1 and 120),
  appareil    text check (appareil is null or length(appareil) <= 80),
  description text check (description is null or length(description) <= 600),
  medias      jsonb not null default '[]'::jsonb check (jsonb_typeof(medias) = 'array'),
  publie      boolean not null default false,
  ordre       integer not null default 0,
  date_realisation date not null default ((now() at time zone 'Europe/Brussels')::date),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.realisations enable row level security;

drop policy if exists realisations_public    on public.realisations;
drop policy if exists realisations_lire      on public.realisations;
drop policy if exists realisations_creer     on public.realisations;
drop policy if exists realisations_modifier  on public.realisations;
drop policy if exists realisations_supprimer on public.realisations;
create policy realisations_public    on public.realisations for select to anon using (publie);
create policy realisations_lire      on public.realisations for select to authenticated using (publie or public.a_acces(array['gestion']));
create policy realisations_creer     on public.realisations for insert to authenticated with check (public.peut_ecrire(array['gestion']));
create policy realisations_modifier  on public.realisations for update to authenticated using (public.peut_ecrire(array['gestion'])) with check (public.peut_ecrire(array['gestion']));
create policy realisations_supprimer on public.realisations for delete to authenticated using (public.peut_effacer(array['gestion']));
grant select on public.realisations to anon;
grant select, insert, update, delete on public.realisations to authenticated;

-- Espace public : photos (compressées par l'ERP) et vidéos courtes.
-- 50 Mo par fichier, limite du plan gratuit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('realisations', 'realisations', true, 52428800,
        array['image/jpeg', 'image/webp', 'image/png', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists realisations_fichiers_deposer   on storage.objects;
drop policy if exists realisations_fichiers_modifier  on storage.objects;
drop policy if exists realisations_fichiers_supprimer on storage.objects;
create policy realisations_fichiers_deposer on storage.objects for insert to authenticated
  with check (bucket_id = 'realisations' and public.peut_ecrire(array['gestion']));
create policy realisations_fichiers_modifier on storage.objects for update to authenticated
  using (bucket_id = 'realisations' and public.peut_ecrire(array['gestion']))
  with check (bucket_id = 'realisations' and public.peut_ecrire(array['gestion']));
create policy realisations_fichiers_supprimer on storage.objects for delete to authenticated
  using (bucket_id = 'realisations' and public.peut_effacer(array['gestion']));
-- Lecture : l'espace est public, les fichiers se lisent par leur adresse.
-- Aucune politique de lecture n'est ajoutée : la liste des fichiers reste
-- invisible pour un visiteur.

-- ─── 3. Prestations « Sur devis » ───
alter table public.services alter column prix drop not null;

-- « Autres interventions » : sur devis, en dernier ; « Nettoyage manette »
-- juste avant.
update public.services set prix = null, prix_max = null, unite = null
 where lower(trim(nom)) = 'autres interventions';
update public.services s set ordre = m.o + 2
  from (select coalesce(max(ordre), 0) o from public.services) m
 where lower(trim(s.nom)) = 'autres interventions';
update public.services s set ordre = m.o + 1
  from (select coalesce(max(ordre), 0) o from public.services where lower(trim(nom)) <> 'autres interventions') m
 where lower(trim(s.nom)) = 'nettoyage manette';

commit;
