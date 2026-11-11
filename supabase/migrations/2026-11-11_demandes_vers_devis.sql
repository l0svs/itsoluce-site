-- Demande du site → devis : la demande garde le devis qui lui répond.
-- NULL = pas de devis. Sert au statut « Devis fait » de la page Demandes et
-- au fil du dossier (Demande › Devis › Réparation › Facture › Encaissé).
alter table public.demandes_formulaire
  add column if not exists converti_devis_id bigint
    references public.devis(id) on delete set null;

create index if not exists demandes_formulaire_converti_devis_id_idx
  on public.demandes_formulaire (converti_devis_id);
