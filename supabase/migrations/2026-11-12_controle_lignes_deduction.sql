-- ═══════════════════════════════════════════════════════════════════
-- Contrôle avant émission : les lignes négatives redeviennent permises
-- (« Diagnostic déjà réalisé (déduit) », « Diagnostic offert »).
-- Seul un TOTAL négatif reste refusé.
-- ═══════════════════════════════════════════════════════════════════
begin;
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
