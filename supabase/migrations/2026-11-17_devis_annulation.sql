-- Annulation d'un devis émis (envoyé, accepté, validité dépassée).
-- Le devis garde son numéro et passe « Annulé » (définitif) ; les éléments
-- liés suivent :
--  - dossier de réparation créé pour ce devis et pas encore commencé
--    (nouveau dossier / appareil reçu, aucune pièce sortie) : annulé aussi ;
--  - brouillon de facture lié : supprimé (pièces remises en stock) ;
--  - facture émise liée : refus, il faut d'abord une note de crédit.
-- La page publique du devis affiche « annulé » ; il ne s'accepte plus en ligne.

alter table public.devis add column if not exists annule_le timestamptz;
alter table public.devis add column if not exists motif_annulation text;

-- Règles : un devis annulé ne change plus de statut.
create or replace function public.devis_regles()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  aujourdhui date := (now() at time zone 'Europe/Brussels')::date;
  emettre boolean := false;
begin
  if TG_OP = 'INSERT' then
    NEW.numero  := null;
    NEW.emis_le := null;
    emettre := NEW.statut <> 'brouillon';

  elsif OLD.emis_le is not null then
    if NEW.numero            is distinct from OLD.numero
    or NEW.date_emission     is distinct from OLD.date_emission
    or NEW.emis_le           is distinct from OLD.emis_le
    or NEW.remplace_devis_id is distinct from OLD.remplace_devis_id
    or NEW.lignes            is distinct from OLD.lignes
    or NEW.total             is distinct from OLD.total
    or NEW.remise            is distinct from OLD.remise
    or NEW.acompte           is distinct from OLD.acompte
    or NEW.client_nom        is distinct from OLD.client_nom
    or NEW.client_adresse    is distinct from OLD.client_adresse
    or NEW.client_societe    is distinct from OLD.client_societe
    or NEW.client_tva        is distinct from OLD.client_tva
    or NEW.notes             is distinct from OLD.notes then
      raise exception 'Le devis % est émis : il ne se modifie plus. Utilise « Réviser le devis ».', OLD.numero;
    end if;
    if NEW.supprime_le is not null and OLD.supprime_le is null
       and coalesce(OLD.client_nom, '') !~* '\mtest\M' then
      raise exception 'Le devis % est émis : il ne peut pas être supprimé. Annule-le.', OLD.numero;
    end if;
    if NEW.statut = 'brouillon' then
      raise exception 'Le devis % est émis : il ne redevient pas un brouillon.', OLD.numero;
    end if;
    if OLD.statut = 'annule' and NEW.statut is distinct from 'annule' then
      raise exception 'Le devis % est annulé : son statut est définitif. Fais un nouveau devis.', OLD.numero;
    end if;
    if NEW.statut = 'annule' and OLD.statut is distinct from 'annule' then
      NEW.annule_le := coalesce(NEW.annule_le, now());
    end if;
    return NEW;

  else
    NEW.numero  := OLD.numero;
    NEW.emis_le := null;
    emettre := NEW.statut <> 'brouillon' and NEW.supprime_le is null;
  end if;

  if emettre then
    if NEW.statut = 'annule' then
      raise exception 'Un brouillon ne s''annule pas : supprime-le.';
    end if;
    if coalesce(trim(NEW.client_nom), '') = '' then
      raise exception 'Nom du client manquant : le devis ne peut pas être émis.';
    end if;
    if jsonb_typeof(NEW.lignes) is distinct from 'array' or jsonb_array_length(NEW.lignes) = 0 then
      raise exception 'Devis sans ligne : il ne peut pas être émis.';
    end if;
    if NEW.numero is null then
      NEW.numero := prochain_numero('devis');
    end if;
    if NEW.date_validite is not null and NEW.date_emission is not null then
      NEW.date_validite := aujourdhui + greatest(0, NEW.date_validite - NEW.date_emission);
    end if;
    NEW.date_emission := aujourdhui;
    NEW.emis_le       := now();
  end if;
  return NEW;
end $function$;

-- Annulation (droits de l'utilisateur connecté : RLS appliquée).
create or replace function public.annuler_devis(p_devis bigint, p_motif text default null, p_dossier boolean default true)
 returns jsonb language plpgsql set search_path to 'public' as $function$
declare
  d devis%rowtype;
  v_motif text := nullif(left(trim(coalesce(p_motif, '')), 500), '');
  v_rep reparations%rowtype;
  v_reps bigint[];
  v_fac record;
  v_dossier text;
  v_fac_suppr text[] := '{}';
  v_quand text := to_char(now() at time zone 'Europe/Brussels', 'DD/MM/YYYY à HH24"h"MI');
begin
  select * into d from devis where id = p_devis and supprime_le is null for update;
  if not found then raise exception 'Devis introuvable.'; end if;
  if d.emis_le is null then raise exception 'Ce devis est un brouillon : supprime-le.'; end if;
  if d.statut = 'annule' then return jsonb_build_object('deja', true); end if;
  if d.statut = 'remplace' then raise exception 'Le devis % a été remplacé par une révision : annule plutôt la nouvelle version.', d.numero; end if;

  v_reps := array_remove(array[d.converti_reparation_id, d.reparation_id], null);

  -- Facture émise liée : il faut d'abord la corriger par une note de crédit.
  for v_fac in
    select f.* from factures f
     where f.supprime_le is null and coalesce(f.type_document, 'facture') <> 'note_credit'
       and (f.id = d.converti_facture_id or f.devis_id = d.id or (f.reparation_id = any(v_reps)))
  loop
    if v_fac.numero is not null and coalesce(v_fac.statut, '') not in ('annulee', 'creditee') then
      raise exception 'La facture % liée à ce devis est émise : annule-la d''abord par une note de crédit (Factures).', v_fac.numero;
    end if;
  end loop;

  -- Brouillons de facture liés : supprimés, pièces remises en stock.
  for v_fac in
    select f.* from factures f
     where f.supprime_le is null and f.numero is null
       and (f.id = d.converti_facture_id or f.devis_id = d.id or (f.reparation_id = any(v_reps)))
  loop
    if v_fac.stock_decremente then
      update stock s set quantite = s.quantite + coalesce(nullif(l->>'quantite', '')::numeric, 1), updated_at = now()
        from jsonb_array_elements(coalesce(v_fac.lignes, '[]'::jsonb)) l
       where (l->>'stock_id') ~ '^[0-9]+$' and s.id = (l->>'stock_id')::bigint;
    end if;
    delete from factures where id = v_fac.id;
    v_fac_suppr := v_fac_suppr || coalesce('brouillon #' || v_fac.id, '');
  end loop;

  -- Dossier pas encore commencé : annulé avec le devis.
  if p_dossier and array_length(v_reps, 1) > 0 then
    select * into v_rep from reparations
     where id = v_reps[1] and supprime_le is null
       and statut in ('attente_reception', 'recu') and coalesce(stock_decremente, false) = false
       and converti_facture_id is null
     for update;
    if found then
      update reparations
         set statut = 'annule',
             notes = concat_ws(E'\n', nullif(notes, ''),
                       'Annulé le ' || v_quand || ' avec le devis ' || coalesce(d.numero, '')
                       || coalesce(' : ' || v_motif, '') || '.'),
             updated_at = now()
       where id = v_rep.id;
      v_dossier := v_rep.numero;
    end if;
  end if;

  update devis set statut = 'annule', annule_le = now(), motif_annulation = v_motif, updated_at = now()
   where id = d.id;

  return jsonb_build_object('numero', d.numero, 'dossier_annule', v_dossier,
                            'brouillons_supprimes', coalesce(array_length(v_fac_suppr, 1), 0));
end $function$;
revoke execute on function public.annuler_devis(bigint, text, boolean) from public, anon;
grant execute on function public.annuler_devis(bigint, text, boolean) to authenticated;

-- Page publique du devis : état « annulé ».
create or replace function public.devis_public(p_jeton uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare
  d devis%rowtype;
  aujourdhui date := (now() at time zone 'Europe/Brussels')::date;
  etat text;
begin
  select * into d from devis
   where jeton_public = p_jeton and emis_le is not null and supprime_le is null;
  if not found then
    return null;
  end if;
  etat := case
    when d.statut = 'annule'   then 'annule'
    when d.statut = 'accepte'  then 'accepte'
    when d.statut = 'refuse'   then 'refuse'
    when d.statut = 'remplace' then 'remplace'
    when d.date_validite is not null and d.date_validite < aujourdhui then 'expire'
    else 'ouvert' end;
  return jsonb_build_object(
    'numero', d.numero,
    'date_emission', d.date_emission,
    'date_validite', d.date_validite,
    'etat', etat,
    'client_nom', d.client_nom,
    'client_societe', d.client_societe,
    'lignes', coalesce((select jsonb_agg(jsonb_build_object(
                 'description', l->>'description',
                 'quantite', l->'quantite',
                 'prix_unitaire', l->'prix_unitaire',
                 'total', l->'total'))
               from jsonb_array_elements(coalesce(d.lignes, '[]'::jsonb)) l), '[]'::jsonb),
    'remise', d.remise,
    'acompte', d.acompte,
    'total', d.total,
    'accepte_en_ligne_le', d.accepte_en_ligne_le,
    'accepte_par_nom', d.accepte_par_nom,
    'refuse_en_ligne_le', d.refuse_en_ligne_le,
    'motif_refus', d.motif_refus,
    'recontact_souhaite', d.recontact_souhaite);
end $function$;
