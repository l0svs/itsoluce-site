-- Statuts des dossiers de réparation, version simplifiée (6 étapes) :
--   À réceptionner (attente_reception) → Diagnostic (recu) → En attente (attente,
--   motif « client » ou « piece ») → En réparation (encours) → Prêt (pret) →
--   Clôturé : rendu (rendu), non réparé (non_reparable) ou annulé (annule).
-- Les codes en base ne changent pas : garantie, avis, relances et statistiques
-- continuent de fonctionner. Les étapes avancent toutes seules :
--   devis envoyé            → En attente · accord client
--   devis accepté           → En réparation (ou En attente · pièce si une commande est en cours)
--   pièce commandée         → En attente · pièce
--   dernière pièce reçue    → En réparation
--   facture encaissée       → Clôturé · rendu
-- Un dossier « Prêt » ou clôturé ne recule jamais à cause d'un devis ou d'une commande.

alter table public.reparations add column if not exists attente_motif text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reparations_attente_motif_check') then
    alter table public.reparations add constraint reparations_attente_motif_check
      check (attente_motif is null or attente_motif in ('client', 'piece'));
  end if;
end $$;
update public.reparations set attente_motif = 'piece' where statut = 'attente' and attente_motif is null;

-- Le motif n'a de sens qu'« En attente ».
create or replace function public.trg_rep_motif()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.statut is distinct from 'attente' then new.attente_motif := null; end if;
  return new;
end $$;
drop trigger if exists b_rep_motif on public.reparations;
create trigger b_rep_motif before insert or update of statut, attente_motif on public.reparations
  for each row execute function public.trg_rep_motif();

-- Avance un dossier ouvert (jamais un dossier Prêt ou clôturé, jamais un supprimé).
create or replace function public.rep_avancer(p_id bigint, p_statut text, p_motif text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r reparations;
begin
  if p_id is null then return; end if;
  select * into r from reparations where id = p_id and supprime_le is null for update;
  if not found then return; end if;
  if r.statut in ('pret', 'rendu', 'non_reparable', 'annule') and p_statut <> 'rendu' then return; end if;
  if r.statut in ('rendu', 'non_reparable', 'annule') then return; end if;
  if r.statut = p_statut and r.attente_motif is not distinct from p_motif then return; end if;
  update reparations
     set statut = p_statut,
         attente_motif = case when p_statut = 'attente' then p_motif end,
         date_fin = case when p_statut = 'rendu' then coalesce(date_fin, now()) else date_fin end,
         updated_at = now()
   where id = p_id;
end $$;
revoke execute on function public.rep_avancer(bigint, text, text) from public, anon, authenticated;

create or replace function public.rep_commande_en_cours(p_rep bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from commandes_pieces where reparation_id = p_rep and statut in ('commandee', 'expediee'));
$$;
revoke execute on function public.rep_commande_en_cours(bigint) from public, anon, authenticated;

-- Devis : envoyé → attente accord client ; accepté → réparation (ou attente pièce).
create or replace function public.trg_devis_statut_dossier()
returns trigger language plpgsql security definer set search_path = public as $$
declare rid bigint := coalesce(new.converti_reparation_id, new.reparation_id); st text;
begin
  if rid is null or new.supprime_le is not null or new.statut is not distinct from old.statut then return null; end if;
  select statut into st from reparations where id = rid;
  if new.statut = 'envoye' and st in ('recu', 'encours', 'attente') then
    perform rep_avancer(rid, 'attente', 'client');
  elsif new.statut = 'accepte' and st in ('recu', 'attente') then
    if rep_commande_en_cours(rid) then perform rep_avancer(rid, 'attente', 'piece');
    else perform rep_avancer(rid, 'encours'); end if;
  end if;
  return null;
end $$;
drop trigger if exists z_devis_statut_dossier on public.devis;
create trigger z_devis_statut_dossier after update of statut on public.devis
  for each row execute function public.trg_devis_statut_dossier();

-- Commandes de pièces : commandée → attente pièce ; dernière reçue → réparation.
create or replace function public.trg_commande_statut_dossier()
returns trigger language plpgsql security definer set search_path = public as $$
declare st text; mo text;
begin
  if new.reparation_id is null then return null; end if;
  if tg_op = 'UPDATE' and new.statut is not distinct from old.statut then return null; end if;
  select statut, attente_motif into st, mo from reparations where id = new.reparation_id;
  if new.statut in ('commandee', 'expediee') and st in ('recu', 'encours', 'attente') then
    perform rep_avancer(new.reparation_id, 'attente', 'piece');
  elsif new.statut in ('recue', 'annulee') and st = 'attente' and mo = 'piece'
        and not rep_commande_en_cours(new.reparation_id) then
    perform rep_avancer(new.reparation_id, 'encours');
  end if;
  return null;
end $$;
drop trigger if exists z_commande_statut_dossier on public.commandes_pieces;
create trigger z_commande_statut_dossier after insert or update of statut on public.commandes_pieces
  for each row execute function public.trg_commande_statut_dossier();

-- Facture encaissée → dossier clôturé « rendu » (la garantie démarre).
create or replace function public.trg_facture_payee_dossier()
returns trigger language plpgsql security definer set search_path = public as $$
declare rid bigint;
begin
  if new.statut <> 'payee' or new.statut is not distinct from old.statut
     or coalesce(new.type_document, 'facture') = 'note_credit' or new.supprime_le is not null then return null; end if;
  rid := coalesce(new.reparation_id,
                  (select id from reparations where converti_facture_id = new.id and supprime_le is null limit 1),
                  (select coalesce(d.converti_reparation_id, d.reparation_id) from devis d where d.id = new.devis_id));
  if rid is not null then perform rep_avancer(rid, 'rendu'); end if;
  return null;
end $$;
drop trigger if exists z_facture_payee_dossier on public.factures;
create trigger z_facture_payee_dossier after update of statut on public.factures
  for each row execute function public.trg_facture_payee_dossier();
