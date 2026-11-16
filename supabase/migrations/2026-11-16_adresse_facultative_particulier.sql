-- 16/11/2026 : l'adresse du client n'est plus obligatoire sur la facture d'un
-- particulier (elle le reste pour un professionnel : société ou n° de TVA).
create or replace function public.controle_emission()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  emis_avant boolean; emis_apres boolean; l jsonb; tva text; pro boolean;
  doc text := case when TG_TABLE_NAME = 'devis' then 'Le devis ne peut pas être émis' else 'La facture ne peut pas être émise' end;
begin
  if TG_TABLE_NAME = 'factures' then
    emis_avant := TG_OP = 'UPDATE' and to_jsonb(OLD)->>'emise_le' is not null;
    emis_apres := to_jsonb(NEW)->>'emise_le' is not null;
  else
    emis_avant := TG_OP = 'UPDATE' and to_jsonb(OLD)->>'emis_le' is not null;
    emis_apres := to_jsonb(NEW)->>'emis_le' is not null;
  end if;
  if emis_avant or not emis_apres then return NEW; end if;
  if coalesce(trim(NEW.client_nom), '') = '' then raise exception '% : nom du client manquant.', doc; end if;
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
  if TG_TABLE_NAME = 'factures' and to_jsonb(NEW)->>'type_document' = 'note_credit' then return NEW; end if;
  for l in select * from jsonb_array_elements(coalesce(NEW.lignes, '[]'::jsonb)) loop
    if coalesce(trim(l->>'description'), '') = '' then raise exception '% : une ligne n''a pas de description.', doc; end if;
    if coalesce((l->>'quantite')::numeric, 0) <= 0 then raise exception '% : quantité invalide sur « % ».', doc, l->>'description'; end if;
  end loop;
  if coalesce(NEW.total, 0) < 0 then raise exception '% : le total est négatif.', doc; end if;
  return NEW;
end $$;
revoke execute on function public.controle_emission() from public, anon, authenticated;

-- Pack vendu à un particulier sans adresse : autorisé (obligatoire pour un professionnel).
do $m$ declare d text; begin
  d := pg_get_functiondef('public.pack_creer_interne(bigint,text,boolean,text,text,text,text,text,text,text,text,text,timestamptz)'::regprocedure);
  d := replace(d, $a$  if coalesce(trim(p_adresse), '') = '' then
    raise exception 'Adresse du client manquante : elle est obligatoire sur la facture.';$a$,
    $b$  if coalesce(trim(p_adresse), '') = '' and (coalesce(trim(p_societe), '') <> '' or coalesce(trim(p_tva), '') <> '') then
    raise exception 'Adresse du client professionnel manquante : elle est obligatoire sur la facture.';$b$);
  d := replace(d, $a$nullif(trim(p_telephone), ''), trim(p_adresse),$a$, $b$nullif(trim(p_telephone), ''), nullif(trim(p_adresse), ''),$b$);
  if d !~ 'professionnel manquante' or d !~ 'nullif\(trim\(p_adresse\)' then raise exception 'remplacement pack_creer_interne échoué'; end if;
  execute d;
end $m$;
revoke execute on function public.pack_creer_interne(bigint,text,boolean,text,text,text,text,text,text,text,text,text,timestamptz) from public, anon, authenticated;
