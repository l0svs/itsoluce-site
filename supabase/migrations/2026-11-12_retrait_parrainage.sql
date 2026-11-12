-- ═══════════════════════════════════════════════════════════════════
-- Retrait du système de parrainage (décision du 12/11/2026 : peut-être
-- plus tard). Le reste du lot (contrôle avant émission, commandes de
-- pièces, kilomètres, agenda) est conservé.
-- Le code complet reste dans l'historique Git
-- (2026-11-12_lot_parrainage_commandes_agenda.sql) pour une remise en place.
-- À appliquer APRÈS la mise en ligne des pages sans parrainage.
-- ═══════════════════════════════════════════════════════════════════
begin;

-- Déclencheurs et fonctions
drop trigger if exists factures_parrainage on public.factures;
drop trigger if exists clients_parrainage on public.clients;
drop trigger if exists demandes_parrainage on public.demandes_formulaire;
drop function if exists public.parrainage_facture();
drop function if exists public.clients_parrainage();
drop function if exists public.demandes_parrainage();
drop function if exists public.lier_parrain(bigint, text);
drop function if exists public.parrainage_solde(bigint);
drop function if exists public.remise_filleul_total(public.factures);
drop function if exists public.generer_code_parrainage(text);
drop function if exists public.parrainage_reglage(text, numeric);

-- Données (aucun parrainage réel au moment du retrait : 0 lien, 0 mouvement)
drop table if exists public.parrainage_mouvements;
drop index if exists public.clients_code_parrainage_key;
alter table public.clients
  drop column if exists parraine_le,
  drop column if exists parrain_id,
  drop column if exists code_parrainage;
alter table public.demandes_formulaire drop column if exists code_parrainage;

-- Réglages et modèle de mail
delete from public.settings
 where cle in ('parrainage_actif', 'parrainage_remise_filleul', 'parrainage_recompense',
               'parrainage_minimum', 'parrainage_max_an');
update public.settings s
   set valeur = (select coalesce(jsonb_agg(m.v order by m.i), '[]'::jsonb)
                   from jsonb_array_elements(s.valeur::jsonb) with ordinality as m(v, i)
                  where m.v->>'cle' is distinct from 'parrainage')::text
 where s.cle = 'mail_modeles_v2'
   and jsonb_typeof(s.valeur::jsonb) = 'array'
   and exists (select 1 from jsonb_array_elements(s.valeur::jsonb) m where m->>'cle' = 'parrainage');

-- Formulaire du site : retour à la version à 8 paramètres
drop function if exists public.submit_demande_formulaire(text, text, text, text, text, text, text, text, text);
create or replace function public.submit_demande_formulaire(
  p_prenom text, p_nom text, p_email text, p_telephone text,
  p_appareil text, p_mode_intervention text, p_adresse text, p_description text)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id bigint;
  v_prenom text := nullif(trim(coalesce(p_prenom, '')), '');
  v_nom text := nullif(trim(coalesce(p_nom, '')), '');
  v_email text := lower(nullif(trim(coalesce(p_email, '')), ''));
  v_telephone text := nullif(trim(coalesce(p_telephone, '')), '');
  v_appareil text := nullif(trim(coalesce(p_appareil, '')), '');
  v_mode text := nullif(trim(coalesce(p_mode_intervention, '')), '');
  v_adresse text := nullif(trim(coalesce(p_adresse, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
begin
  if v_prenom is null or v_nom is null or v_email is null
     or v_appareil is null or v_description is null then
    raise exception 'Champs obligatoires manquants.';
  end if;
  if length(v_prenom) > 80 or length(v_nom) > 80 or length(v_email) > 200
     or length(coalesce(v_telephone, '')) > 40 or length(v_appareil) > 150
     or length(coalesce(v_mode, '')) > 40 or length(coalesce(v_adresse, '')) > 300
     or length(v_description) > 4000 then
    raise exception 'Un champ dépasse la longueur autorisée.';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'Adresse e-mail invalide.';
  end if;
  -- Fréquence : 3 demandes par heure pour une même adresse, 20 par heure en tout.
  if (select count(*) from public.demandes_formulaire
       where lower(email) = v_email and created_at > now() - interval '1 hour') >= 3
  or (select count(*) from public.demandes_formulaire
       where created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Trop de demandes envoyées, merci de réessayer plus tard.';
  end if;

  insert into public.demandes_formulaire (
    prenom, nom, email, telephone, appareil, mode_intervention, adresse, description
  ) values (
    v_prenom, v_nom, v_email, v_telephone, v_appareil, v_mode, v_adresse, v_description
  )
  returning id into v_id;
  return v_id;
end;
$function$;
grant execute on function public.submit_demande_formulaire(text, text, text, text, text, text, text, text) to anon, authenticated;

-- Contrôle avant émission : plus d'exception pour les lignes de parrainage
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

  -- Lignes : seules les factures et devis « normaux » (une note de crédit
  -- reprend les lignes de la facture d'origine).
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
    if coalesce((l->>'prix_unitaire')::numeric, 0) < 0 then
      raise exception '% : prix négatif sur « % » (utilise la remise).', doc, l->>'description';
    end if;
  end loop;
  if coalesce(NEW.total, 0) < 0 then
    raise exception '% : le total est négatif.', doc;
  end if;
  return NEW;
end $$;
revoke execute on function public.controle_emission() from public, anon, authenticated;

commit;
