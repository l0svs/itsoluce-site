-- Annulation de 2026-09-27_frais_devis : retour au devis et au diagnostic
-- gratuits. Aucun devis ni aucune facture n'utilisait encore ces champs.

-- Prestation : retour à « Diagnostique » à 0 € (état d'avant). Le champ
-- « détail » d'origine n'a pas été conservé : il est laissé vide.
update public.services
   set nom = 'Diagnostique', prix = 0, prix_max = 0, unite = null, detail = null
 where id = 9;

-- Lecture publique : uniquement les prestations publiées, comme avant.
drop policy if exists services_vitrine_lecture_publique on public.services;
create policy services_vitrine_lecture_publique on public.services for select
  using (vitrine = true and actif = true);

drop index if exists public.services_un_seul_frais_devis;
alter table public.services drop column if exists frais_devis;

alter table public.devis drop column if exists frais_devis_deduit;
alter table public.devis drop column if exists frais_devis_facture_id;
alter table public.devis drop column if exists frais_devis;
