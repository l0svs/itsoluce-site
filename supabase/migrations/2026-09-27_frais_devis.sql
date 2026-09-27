-- Frais de devis : un montant fixe facturé pour chaque devis, déduit de la
-- facture finale si le client accepte la réparation.
--
-- Source unique du montant : la prestation cochée « Frais de devis » dans
-- Gestion › Prestations (une seule à la fois). Le site vitrine la lit pour
-- afficher le prix, l'ERP la lit pour les devis.

-- 1. Prestation « Frais de devis »
alter table public.services add column if not exists frais_devis boolean not null default false;
create unique index if not exists services_un_seul_frais_devis
  on public.services (frais_devis) where frais_devis;

-- Le site vitrine lit, sans connexion, les prestations publiées ET la
-- prestation « Frais de devis » (pour afficher son prix).
drop policy if exists services_vitrine_lecture_publique on public.services;
create policy services_vitrine_lecture_publique on public.services for select
  using ((vitrine = true or frais_devis = true) and actif = true);

-- L'ancienne prestation « Diagnostique » à 0 € devient les frais de devis.
update public.services
   set nom = 'Frais de devis', prix = 30, prix_max = null, unite = null,
       detail = 'Facturés pour chaque devis, quel que soit l''appareil. Déduits de la facture si la réparation est acceptée.',
       frais_devis = true, actif = true, vitrine = false
 where id = 9 and not exists (select 1 from public.services where frais_devis);

-- 2. Suivi sur le devis
alter table public.devis add column if not exists frais_devis numeric not null default 0;
alter table public.devis add column if not exists frais_devis_facture_id bigint references public.factures(id) on delete set null;
alter table public.devis add column if not exists frais_devis_deduit boolean not null default false;
