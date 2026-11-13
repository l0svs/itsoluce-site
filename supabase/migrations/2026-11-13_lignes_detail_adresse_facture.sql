-- ═══════════════════════════════════════════════════════════════════
-- Devis et factures : détail des lignes et adresse obligatoire
--
-- 1. devis_public() renvoie aussi le « détail » de chaque ligne : la page
--    d'acceptation en ligne l'affiche sous la description, comme le PDF.
-- 2. controle_emission() refuse l'émission d'une facture sans adresse du
--    client (l'ERP le vérifiait déjà ; la base le garantit désormais).
--    Les notes de crédit et les documents déjà émis ne sont pas concernés.
-- ═══════════════════════════════════════════════════════════════════

begin;

create or replace function public.devis_public(p_jeton uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
                 'detail', nullif(trim(coalesce(l->>'detail', '')), ''),
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
end $$;
revoke execute on function public.devis_public(uuid) from public;
grant execute on function public.devis_public(uuid) to anon, authenticated;

create or replace function public.controle_emission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  emis_avant boolean;
  emis_apres boolean;
  l jsonb;
  tva text;
  pro boolean;
  doc text := case when TG_TABLE_NAME = 'devis' then 'Le devis ne peut pas être émis' else 'La facture ne peut pas être émise' end;
begin
  if TG_TABLE_NAME = 'factures' then
    emis_avant := TG_OP = 'UPDATE' and to_jsonb(OLD)->>'emise_le' is not null;
    emis_apres := to_jsonb(NEW)->>'emise_le' is not null;
  else
    emis_avant := TG_OP = 'UPDATE' and to_jsonb(OLD)->>'emis_le' is not null;
    emis_apres := to_jsonb(NEW)->>'emis_le' is not null;
  end if;
  if emis_avant or not emis_apres then
    return NEW;   -- seulement au moment de l'émission
  end if;

  if coalesce(trim(NEW.client_nom), '') = '' then
    raise exception '% : nom du client manquant.', doc;
  end if;

  pro := coalesce(trim(NEW.client_societe), '') <> '' or coalesce(trim(NEW.client_tva), '') <> '';
  if pro and coalesce(trim(NEW.client_adresse), '') = '' then
    raise exception '% : adresse du client professionnel manquante.', doc;
  end if;
  -- Toute facture (hors note de crédit) porte l'adresse du client.
  if TG_TABLE_NAME = 'factures' and coalesce(to_jsonb(NEW)->>'type_document', 'facture') <> 'note_credit'
     and coalesce(trim(NEW.client_adresse), '') = '' then
    raise exception '% : adresse du client manquante.', doc;
  end if;
  if coalesce(trim(NEW.client_tva), '') <> '' then
    tva := upper(regexp_replace(NEW.client_tva, '[^A-Za-z0-9]', '', 'g'));
    if tva !~ '^[A-Z]{2}[0-9A-Z]{8,12}$' or (tva like 'BE%' and tva !~ '^BE[01][0-9]{9}$') then
      raise exception '% : numéro de TVA du client invalide (%).', doc, NEW.client_tva;
    end if;
  end if;

  if TG_TABLE_NAME = 'factures' then
    if to_jsonb(NEW)->>'type_document' = 'note_credit' then
      return NEW;
    end if;
  end if;
  for l in select * from jsonb_array_elements(coalesce(NEW.lignes, '[]'::jsonb)) loop
    if coalesce(trim(l->>'description'), '') = '' then
      raise exception '% : une ligne n''a pas de description.', doc;
    end if;
    if coalesce((l->>'quantite')::numeric, 0) <= 0 then
      raise exception '% : quantité invalide sur « % ».', doc, l->>'description';
    end if;
  end loop;
  if coalesce(NEW.total, 0) < 0 then
    raise exception '% : le total est négatif.', doc;
  end if;
  return NEW;
end $$;
revoke execute on function public.controle_emission() from public, anon, authenticated;

commit;
