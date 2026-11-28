-- ═══════════════════════════════════════════════════════════
--  Peppol (point d'accès Recommand) : envoi des factures aux clients professionnels.
--
--  Une facture ne part QU'UNE SEULE FOIS :
--    1. peppol_reserver() la réserve de façon atomique : un seul appel gagne,
--       même en cas de double clic ou de double appel de Mollie ;
--    2. un envoi au résultat incertain (coupure réseau) passe en « incertain » :
--       on vérifie chez Recommand avant de permettre un nouvel essai ;
--    3. une facture livrée ou en cours de livraison ne peut plus repartir
--       (garde-fou trg_peppol_garde, en base, pas seulement à l'écran).
--
--  Statuts : envoi (réservée, appel en cours) · en_cours (acceptée, livraison
--  en attente) · livree · echec (rien n'a été livré : nouvel essai possible) ·
--  incertain (à vérifier chez Recommand avant tout nouvel essai).
-- ═══════════════════════════════════════════════════════════

alter table public.factures
  add column if not exists peppol_statut text,
  add column if not exists peppol_document_id text,
  add column if not exists peppol_envoye_le timestamptz,
  add column if not exists peppol_livree_le timestamptz,
  add column if not exists peppol_destinataire text,
  add column if not exists peppol_erreur text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'factures_peppol_statut_check') then
    alter table public.factures add constraint factures_peppol_statut_check
      check (peppol_statut is null or peppol_statut in ('envoi', 'en_cours', 'livree', 'echec', 'incertain'));
  end if;
end $$;
create unique index if not exists factures_peppol_document_id_uniq
  on public.factures (peppol_document_id) where peppol_document_id is not null;

-- Garde-fou : une facture livrée, en cours ou en cours d'envoi ne repart pas.
create or replace function public.trg_peppol_garde()
returns trigger language plpgsql set search_path = public as $$
begin
  if OLD.peppol_statut is not distinct from NEW.peppol_statut
     and OLD.peppol_document_id is not distinct from NEW.peppol_document_id then
    return NEW;
  end if;
  -- Un document Recommand rattaché ne change plus, sauf après un échec de livraison.
  if OLD.peppol_document_id is not null and NEW.peppol_document_id is distinct from OLD.peppol_document_id
     and OLD.peppol_statut is distinct from 'echec' then
    raise exception 'Facture % : déjà transmise via Peppol (document %).', OLD.numero, OLD.peppol_document_id;
  end if;
  if OLD.peppol_statut = 'livree' then
    raise exception 'Facture % : déjà livrée via Peppol, elle ne repart pas.', OLD.numero;
  end if;
  -- En cours de livraison : seulement livrée, échec, ou « incertain » (doublon signalé par le client).
  if OLD.peppol_statut = 'en_cours' and NEW.peppol_statut not in ('en_cours', 'livree', 'echec', 'incertain') then
    raise exception 'Facture % : transmission Peppol en cours.', OLD.numero;
  end if;
  if OLD.peppol_statut = 'envoi' and NEW.peppol_statut is null then
    raise exception 'Facture % : envoi Peppol en cours.', OLD.numero;
  end if;
  if OLD.peppol_statut = 'incertain' and NEW.peppol_statut = 'envoi' then
    raise exception 'Facture % : vérifie d''abord chez Recommand si l''envoi précédent est parti.', OLD.numero;
  end if;
  return NEW;
end $$;
drop trigger if exists b_peppol_garde on public.factures;
create trigger b_peppol_garde before update of peppol_statut, peppol_document_id on public.factures
  for each row execute function public.trg_peppol_garde();

-- Réservation atomique avant l'envoi : renvoie vrai pour UN SEUL appelant.
-- Facture : émise et encaissée. Note de crédit : émise et réglée (imputée ou remboursée).
-- Rien n'est parti (statut vide ou échec), et un envoi bloqué en « envoi » depuis
-- plus de 10 minutes n'est jamais repris automatiquement (il passe en « incertain »).
create or replace function public.peppol_reserver(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- Après un échec de livraison, l'ancien document Recommand est détaché : le nouvel envoi aura le sien.
  update factures set peppol_statut = 'envoi', peppol_envoye_le = now(), peppol_erreur = null, peppol_document_id = null
   where id = p_id and supprime_le is null and emise_le is not null
     and coalesce(peppol_statut, 'echec') = 'echec'
     and ((coalesce(type_document, 'facture') = 'facture' and statut = 'payee')
       or (type_document = 'note_credit' and statut in ('imputee', 'remboursee')));
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke execute on function public.peppol_reserver(bigint) from public, anon, authenticated;

-- Facture professionnelle belge : l'adresse doit contenir le code postal (4 chiffres)
-- pour que la facture Peppol soit valable (« Rue et numéro, code postal commune »).
create or replace function public.controle_emission()
returns trigger language plpgsql security definer set search_path = public as $function$
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
    if TG_TABLE_NAME = 'factures' and tva like 'BE%' and NEW.client_adresse !~ '(^|[^0-9])[1-9][0-9]{3}[ ]+[^0-9 ,]' then
      raise exception '% : adresse de l''entreprise incomplète. Indique « rue et numéro, code postal et commune » (ex. : Rue de la Station 12, 1480 Tubize).', doc;
    end if;
  end if;
  if TG_TABLE_NAME = 'factures' and to_jsonb(NEW)->>'type_document' = 'note_credit' then return NEW; end if;
  for l in select * from jsonb_array_elements(coalesce(NEW.lignes, '[]'::jsonb)) loop
    if coalesce(trim(l->>'description'), '') = '' then raise exception '% : une ligne n''a pas de description.', doc; end if;
    if coalesce((l->>'quantite')::numeric, 0) <= 0 then raise exception '% : quantité invalide sur « % ».', doc, l->>'description'; end if;
  end loop;
  if coalesce(NEW.total, 0) < 0 then raise exception '% : le total est négatif.', doc; end if;
  return NEW;
end $function$;

-- Suivi des livraisons en attente toutes les 15 minutes (même jeton que les autres tâches).
select cron.unschedule('peppol-suivi') where exists (select 1 from cron.job where jobname = 'peppol-suivi');
select cron.schedule('peppol-suivi', '*/15 * * * *', $cron$
  select net.http_post(
    url := 'https://esltsiutcjcwdbhkkvms.supabase.co/functions/v1/peppol',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-jeton', (select jeton from public.sync_jeton where id = 1)),
    body := '{"action":"suivre"}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id
  where exists (select 1 from public.factures where peppol_statut in ('en_cours', 'envoi', 'incertain'));
$cron$);

-- Accès API Recommand (production et bac à sable de test). Lu uniquement par la
-- fonction serveur peppol avec la clé de service : RLS activée sans politique,
-- aucun droit pour le site ni pour l'ERP. Les valeurs sont saisies hors dépôt.
create table if not exists public.recommand_acces (
  mode text primary key check (mode in ('production','test')),
  cle text not null, secret text not null, entreprise text not null,
  maj_le timestamptz not null default now());
alter table public.recommand_acces enable row level security;
revoke all on public.recommand_acces from anon, authenticated;

-- Mail de confirmation au client après la livraison Peppol (une seule fois) :
-- rempli au moment de l'envoi du mail. Les Packs du site ont leur propre mail
-- (« facture transmise via Peppol ») : la fonction le marque sans rien envoyer.
alter table public.factures add column if not exists peppol_mail_le timestamptz;

-- Le suivi tourne aussi pour un mail de confirmation à (re)tenter après une livraison.
select cron.unschedule('peppol-suivi') where exists (select 1 from cron.job where jobname = 'peppol-suivi');
select cron.schedule('peppol-suivi', '*/15 * * * *', $cron$
  select net.http_post(
    url := 'https://esltsiutcjcwdbhkkvms.supabase.co/functions/v1/peppol',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-jeton', (select jeton from public.sync_jeton where id = 1)),
    body := '{"action":"suivre"}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id
  where exists (select 1 from public.factures where peppol_statut in ('en_cours', 'envoi', 'incertain')
     or (peppol_statut = 'livree' and peppol_mail_le is null and client_email is not null and peppol_livree_le > now() - interval '3 days'));
$cron$);
