-- ═══════════════════════════════════════════════════════════════════
--  Pack Sérénité : formules, packs vendus, journal des interventions,
--  commandes en ligne (Mollie), comptes de l'espace client, rétractation.
--
--  Principes :
--   - toutes les écritures passent par des fonctions (règles vérifiées
--     en base : interventions restantes, période, rétractation 14 jours) ;
--   - la facture du pack est une facture ordinaire : même numérotation,
--     mêmes contrôles d'émission (factures_regles / controle_emission) ;
--   - un pack s'active quand sa facture passe « payée » ;
--   - l'espace client ne lit QUE ses propres données, par des fonctions
--     liées à auth.uid() ; il n'a aucun accès aux tables de l'ERP.
-- ═══════════════════════════════════════════════════════════════════

-- ── Formules ─────────────────────────────────────────────────────────
create table if not exists public.pack_formules (
  code          text primary key check (code ~ '^[a-z0-9_]{1,20}$'),
  nom           text not null,
  mois          int  not null check (mois between 1 and 36),
  interventions int  not null check (interventions between 1 and 100),
  hydrogels     int  not null default 0 check (hydrogels between 0 and 20),
  prix          numeric(10,2) not null check (prix > 0),
  actif         boolean not null default true,
  ordre         int not null default 0
);
insert into public.pack_formules (code, nom, mois, interventions, hydrogels, prix, ordre) values
  ('3m',  'Pack Sérénité 3 mois',  3,  2, 1, 199, 1),
  ('6m',  'Pack Sérénité 6 mois',  6,  4, 2, 349, 2),
  ('12m', 'Pack Sérénité 12 mois', 12, 8, 3, 599, 3)
on conflict (code) do nothing;

-- ── Packs vendus ─────────────────────────────────────────────────────
create table if not exists public.packs (
  id                    bigint generated always as identity primary key,
  client_id             bigint not null references public.clients(id),
  formule               text not null references public.pack_formules(code),
  nom                   text not null,
  mois                  int  not null,
  interventions_total   int  not null,
  hydrogels_total       int  not null default 0,
  prix                  numeric(10,2) not null,
  statut                text not null default 'en_attente'
                        check (statut in ('en_attente','actif','retracte','annule')),
  origine               text not null check (origine in ('erp','en_ligne')),
  facture_id            bigint references public.factures(id),
  date_debut            date,
  date_fin              date,
  paye_le               timestamptz,
  mollie_payment_id     text unique,
  consentement_le       timestamptz,
  retracte_le           timestamptz,
  note_credit_id        bigint references public.factures(id),
  remboursement_montant numeric(10,2),
  mollie_refund_id      text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists packs_client_idx  on public.packs(client_id);
create index if not exists packs_facture_idx on public.packs(facture_id);

-- ── Journal des interventions d'un pack ──────────────────────────────
create table if not exists public.pack_interventions (
  id            bigint generated always as identity primary key,
  pack_id       bigint not null references public.packs(id) on delete cascade,
  date_inter    date not null,
  type          text not null check (type in ('domicile','travail','depot')),
  description   text not null check (length(trim(description)) between 1 and 1000),
  note_interne  text check (note_interne is null or length(note_interne) <= 2000),
  duree_min     int check (duree_min is null or duree_min between 0 and 1440),
  km            numeric(7,1) check (km is null or km between 0 and 2000),
  decompte      int not null default 1 check (decompte in (0,1)),
  hydrogels     int not null default 0 check (hydrogels between 0 and 20),
  reparation_id bigint references public.reparations(id),
  cree_par      uuid default auth.uid(),
  created_at    timestamptz not null default now()
);
create index if not exists pack_inter_pack_idx on public.pack_interventions(pack_id);

alter table public.reparations add column if not exists pack_id bigint references public.packs(id);

-- ── Commandes en ligne (avant / pendant le paiement Mollie) ──────────
create table if not exists public.pack_commandes (
  id                uuid primary key default gen_random_uuid(),
  formule           text not null references public.pack_formules(code),
  montant           numeric(10,2) not null,
  prenom            text not null check (length(trim(prenom)) between 1 and 60),
  nom               text not null check (length(trim(nom)) between 1 and 60),
  email             text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 160),
  telephone         text not null check (length(trim(telephone)) between 6 and 30),
  adresse           text not null check (length(trim(adresse)) between 8 and 200),
  societe           text check (societe is null or length(societe) <= 120),
  tva               text check (tva is null or length(tva) <= 20),
  consentement      boolean not null,
  statut            text not null default 'cree' check (statut in ('cree','payee','echouee')),
  mollie_payment_id text unique,
  pack_id           bigint references public.packs(id),
  erreur            text,
  created_at        timestamptz not null default now(),
  traitee_le        timestamptz
);

-- ── Comptes de l'espace client ───────────────────────────────────────
create table if not exists public.clients_comptes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  client_id  bigint not null unique references public.clients(id),
  created_at timestamptz not null default now()
);

-- ── Droits : lecture ERP seulement, aucune écriture directe ──────────
alter table public.pack_formules      enable row level security;
alter table public.packs              enable row level security;
alter table public.pack_interventions enable row level security;
alter table public.pack_commandes     enable row level security;
alter table public.clients_comptes    enable row level security;

drop policy if exists pack_formules_public on public.pack_formules;
create policy pack_formules_public on public.pack_formules for select to anon, authenticated using (actif or public.a_acces(array['clients','factures']));
drop policy if exists packs_lire on public.packs;
create policy packs_lire on public.packs for select to authenticated using (public.a_acces(array['clients','factures','reparations']));
drop policy if exists pack_inter_lire on public.pack_interventions;
create policy pack_inter_lire on public.pack_interventions for select to authenticated using (public.a_acces(array['clients','factures','reparations']));
drop policy if exists pack_cmd_lire on public.pack_commandes;
create policy pack_cmd_lire on public.pack_commandes for select to authenticated using (public.a_acces(array['clients','factures']));
drop policy if exists clients_comptes_lire on public.clients_comptes;
create policy clients_comptes_lire on public.clients_comptes for select to authenticated using (public.a_acces(array['clients']));

revoke all on public.pack_formules, public.packs, public.pack_interventions, public.pack_commandes, public.clients_comptes from anon, authenticated;
grant select on public.pack_formules to anon, authenticated;
grant select on public.packs, public.pack_interventions, public.pack_commandes, public.clients_comptes to authenticated;

-- ═══════════════════════════════════════════════════════════════════
--  Fonctions internes
-- ═══════════════════════════════════════════════════════════════════

-- Active un pack : période qui démarre aujourd'hui (heure de Bruxelles).
create or replace function public.pack_activer(p_pack bigint)
returns void language plpgsql security definer set search_path = public as $$
declare auj date := (now() at time zone 'Europe/Brussels')::date;
begin
  update packs set statut = 'actif', paye_le = coalesce(paye_le, now()),
         date_debut = auj, date_fin = (auj + make_interval(months => mois))::date,
         updated_at = now()
   where id = p_pack and statut = 'en_attente';
end $$;

-- Crée le pack et sa facture (émise). p_payee : facture payée tout de suite.
create or replace function public.pack_creer_interne(
  p_client_id bigint, p_formule text, p_payee boolean, p_mode_paiement text,
  p_origine text, p_nom text, p_email text, p_telephone text, p_adresse text,
  p_societe text, p_tva text, p_mollie text, p_consentement timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f   pack_formules;
  pk  bigint;
  fac factures;
  auj date := (now() at time zone 'Europe/Brussels')::date;
  libelle text;
begin
  select * into f from pack_formules where code = p_formule and actif;
  if not found then raise exception 'Formule de pack inconnue.'; end if;
  if coalesce(trim(p_adresse), '') = '' then
    raise exception 'Adresse du client manquante : elle est obligatoire sur la facture.';
  end if;

  insert into packs (client_id, formule, nom, mois, interventions_total, hydrogels_total, prix,
                     origine, mollie_payment_id, consentement_le)
  values (p_client_id, f.code, f.nom, f.mois, f.interventions, f.hydrogels, f.prix,
          p_origine, p_mollie, p_consentement)
  returning id into pk;

  libelle := f.nom || ' — ' || f.interventions || ' interventions incluses (à domicile, sur le lieu de travail ou en dépôt)'
          || case when f.hydrogels > 0 then ', ' || f.hydrogels || ' protection' || case when f.hydrogels > 1 then 's' else '' end || ' hydrogel offerte' || case when f.hydrogels > 1 then 's' else '' end else '' end
          || ', pièces détachées −10 %. Valable ' || f.mois || ' mois à compter du paiement.';

  insert into factures (client_id, client_nom, client_email, client_telephone, client_adresse,
                        client_societe, client_tva, date_emission, date_echeance, statut,
                        lignes, total, remise, acompte, acompte_type, stock_decremente,
                        date_paiement, mode_paiement, notes)
  values (p_client_id, p_nom, nullif(trim(p_email), ''), nullif(trim(p_telephone), ''), trim(p_adresse),
          nullif(trim(p_societe), ''), nullif(trim(p_tva), ''), auj, auj,
          case when p_payee then 'payee' else 'envoyee' end,
          jsonb_build_array(jsonb_build_object('description', libelle, 'quantite', 1,
                            'prix_unitaire', f.prix, 'total', f.prix, 'stock_id', '')),
          f.prix, 0, 0, 'euro', true,
          case when p_payee then auj end, case when p_payee then p_mode_paiement end, null)
  returning * into fac;

  update packs set facture_id = fac.id where id = pk;
  if p_payee then perform pack_activer(pk); end if;
  return jsonb_build_object('pack_id', pk, 'facture_id', fac.id, 'numero', fac.numero);
end $$;

-- La facture d'un pack passe « payée » → le pack s'active ;
-- elle est entièrement créditée → le pack est annulé.
create or replace function public.pack_suivre_facture()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.statut = 'payee' and OLD.statut is distinct from 'payee' then
    perform pack_activer(p.id) from packs p where p.facture_id = NEW.id and p.statut = 'en_attente';
  elsif NEW.statut = 'creditee' and OLD.statut is distinct from 'creditee' then
    update packs set statut = 'annule', updated_at = now()
     where facture_id = NEW.id and statut in ('en_attente','actif');
  end if;
  return NEW;
end $$;
drop trigger if exists factures_zpack on public.factures;
create trigger factures_zpack after update of statut on public.factures
  for each row execute function public.pack_suivre_facture();

-- État calculé d'un pack (utilisé par l'ERP et l'espace client).
create or replace function public.pack_etat(p packs)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'utilisees',          coalesce((select sum(decompte) from pack_interventions where pack_id = p.id), 0),
    'restantes',          p.interventions_total - coalesce((select sum(decompte) from pack_interventions where pack_id = p.id), 0),
    'hydrogels_utilises', coalesce((select sum(hydrogels) from pack_interventions where pack_id = p.id), 0),
    'expire',             p.statut = 'actif' and p.date_fin < (now() at time zone 'Europe/Brussels')::date
  );
$$;

-- ═══════════════════════════════════════════════════════════════════
--  ERP
-- ═══════════════════════════════════════════════════════════════════

-- Vendre un pack sur place (facture émise ; payée tout de suite ou plus tard).
create or replace function public.vendre_pack(p_client_id bigint, p_formule text, p_payee boolean, p_mode_paiement text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c clients;
begin
  if not peut_ecrire(array['factures']) then raise exception 'Droits insuffisants (Factures).'; end if;
  select * into c from clients where id = p_client_id and supprime_le is null;
  if not found then raise exception 'Client introuvable.'; end if;
  if p_payee and coalesce(p_mode_paiement, '') not in ('carte','especes','virement','mixte') then
    raise exception 'Mode de paiement invalide.';
  end if;
  if exists (select 1 from packs where client_id = c.id and statut = 'en_attente') then
    raise exception 'Ce client a déjà un pack en attente de paiement.';
  end if;
  return pack_creer_interne(c.id, p_formule, p_payee, p_mode_paiement, 'erp',
           c.nom, c.email, c.telephone, c.adresse, c.societe, c.tva, null, null);
end $$;

-- Noter une intervention ; crée le dossier si demandé, ou relie un dossier existant.
create or replace function public.noter_intervention_pack(
  p_pack bigint, p_type text, p_date date, p_description text, p_note text,
  p_duree_min int, p_km numeric, p_hydrogels int, p_decompter boolean,
  p_creer_dossier boolean, p_appareil text default null, p_reparation_id bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p packs; c clients; e jsonb; rep reparations; iid bigint;
  auj date := (now() at time zone 'Europe/Brussels')::date;
begin
  if not peut_ecrire(array['clients','reparations']) then raise exception 'Droits insuffisants.'; end if;
  select * into p from packs where id = p_pack for update;
  if not found then raise exception 'Pack introuvable.'; end if;
  if p.statut <> 'actif' then raise exception 'Ce pack n''est pas actif.'; end if;
  if coalesce(p_date, auj) < p.date_debut or coalesce(p_date, auj) > p.date_fin then
    raise exception 'La date est en dehors de la période du pack (% → %).', to_char(p.date_debut,'DD/MM/YYYY'), to_char(p.date_fin,'DD/MM/YYYY');
  end if;
  e := pack_etat(p);
  if p_decompter and (e->>'restantes')::int < 1 then raise exception 'Plus aucune intervention disponible dans ce pack.'; end if;
  if coalesce(p_hydrogels,0) > p.hydrogels_total - (e->>'hydrogels_utilises')::int then
    raise exception 'Plus assez de protections hydrogel dans ce pack.';
  end if;
  select * into c from clients where id = p.client_id;

  if p_reparation_id is not null then
    select * into rep from reparations where id = p_reparation_id and supprime_le is null for update;
    if not found then raise exception 'Dossier introuvable.'; end if;
    if rep.client_id is distinct from p.client_id then raise exception 'Ce dossier appartient à un autre client.'; end if;
    if rep.pack_id is not null then raise exception 'Ce dossier est déjà inclus dans un pack.'; end if;
    if rep.converti_facture_id is not null then raise exception 'Ce dossier est déjà facturé.'; end if;
    update reparations set pack_id = p.id, updated_at = now() where id = rep.id;
  elsif p_creer_dossier then
    insert into reparations (client_id, client_nom, client_email, client_telephone, appareil,
                             panne_description, statut, type, pack_id, notes)
    values (c.id, c.nom, c.email, c.telephone, coalesce(nullif(trim(p_appareil),''), 'Intervention'),
            trim(p_description), 'encours',
            case when p_type = 'depot' then 'reparation' else 'intervention' end, p.id,
            nullif(trim(coalesce(p_note,'')), ''))
    returning * into rep;
  end if;

  insert into pack_interventions (pack_id, date_inter, type, description, note_interne, duree_min, km,
                                  decompte, hydrogels, reparation_id)
  values (p.id, coalesce(p_date, auj), p_type, trim(p_description), nullif(trim(coalesce(p_note,'')),''),
          p_duree_min, p_km, case when p_decompter then 1 else 0 end, coalesce(p_hydrogels,0), rep.id)
  returning id into iid;
  update packs set updated_at = now() where id = p.id;
  return jsonb_build_object('intervention_id', iid, 'reparation_id', rep.id, 'reparation_numero', rep.numero);
end $$;

-- Retirer une ligne du journal (le dossier éventuel est conservé, mais délié).
create or replace function public.supprimer_intervention_pack(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare i pack_interventions;
begin
  if not peut_effacer(array['clients','reparations']) then raise exception 'Droits insuffisants.'; end if;
  select * into i from pack_interventions where id = p_id;
  if not found then return; end if;
  if i.reparation_id is not null then
    update reparations set pack_id = null, updated_at = now()
     where id = i.reparation_id and pack_id = i.pack_id;
  end if;
  delete from pack_interventions where id = p_id;
end $$;

-- Montant remboursé en cas de rétractation (particulier, 14 jours).
create or replace function public.pack_retractation_calcul(p_pack bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p packs; fac factures; e jsonb; prix_h numeric; brut numeric; m numeric; raison text;
begin
  if not a_acces(array['factures','clients']) then raise exception 'Droits insuffisants.'; end if;
  select * into p from packs where id = p_pack;
  if not found then raise exception 'Pack introuvable.'; end if;
  select * into fac from factures where id = p.facture_id;
  e := pack_etat(p);
  prix_h := coalesce(nullif(trim((select valeur from settings where cle = 'pack_hydrogel_prix')), '')::numeric, 14.99);
  brut := round(p.prix * (e->>'restantes')::int / p.interventions_total, 2);
  m := greatest(0, round(brut - (e->>'hydrogels_utilises')::int * prix_h, 2));
  raison := case
    when p.statut <> 'actif' then 'Le pack n''est pas actif.'
    when coalesce(trim(fac.client_societe),'') <> '' or coalesce(trim(fac.client_tva),'') <> '' then 'Client professionnel : pas de droit de rétractation.'
    when p.paye_le < now() - interval '14 days' then 'Délai de 14 jours dépassé (payé le ' || to_char(p.paye_le at time zone 'Europe/Brussels','DD/MM/YYYY') || ').'
    else null end;
  return jsonb_build_object('possible', raison is null, 'raison', raison, 'montant', m,
    'restantes', (e->>'restantes')::int, 'total', p.interventions_total,
    'hydrogels_utilises', (e->>'hydrogels_utilises')::int, 'prix_hydrogel', prix_h,
    'paye_le', p.paye_le, 'fin_delai', p.paye_le + interval '14 days',
    'en_ligne', p.mollie_payment_id is not null);
end $$;

-- Rétractation : note de crédit au prorata, pack clôturé.
create or replace function public.retracter_pack(p_pack bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p packs; fac factures; calc jsonb; m numeric; nc factures;
begin
  if not peut_ecrire(array['factures']) then raise exception 'Droits insuffisants (Factures).'; end if;
  select * into p from packs where id = p_pack for update;
  calc := pack_retractation_calcul(p_pack);
  if not (calc->>'possible')::boolean then raise exception '%', calc->>'raison'; end if;
  m := (calc->>'montant')::numeric;
  select * into fac from factures where id = p.facture_id;
  if m > 0 then
    insert into factures (type_document, facture_origine_id, statut, client_id, client_nom, client_email,
                          client_telephone, client_adresse, client_societe, client_tva, date_emission,
                          lignes, total, remise, acompte, acompte_type, motif_credit, stock_decremente)
    values ('note_credit', fac.id, 'a_rembourser', fac.client_id, fac.client_nom, fac.client_email,
            fac.client_telephone, fac.client_adresse, fac.client_societe, fac.client_tva,
            (now() at time zone 'Europe/Brussels')::date,
            jsonb_build_array(jsonb_build_object(
              'description', 'Rétractation ' || p.nom || ' — remboursement au prorata : '
                 || (calc->>'restantes') || ' intervention(s) non utilisée(s) sur ' || (calc->>'total')
                 || case when (calc->>'hydrogels_utilises')::int > 0
                         then ', ' || (calc->>'hydrogels_utilises') || ' protection(s) hydrogel posée(s) déduite(s)' else '' end
                 || ' — facture ' || fac.numero,
              'quantite', 1, 'prix_unitaire', -m, 'total', -m, 'stock_id', '')),
            -m, 0, 0, 'euro', 'Rétractation (14 jours)', true)
    returning * into nc;
  end if;
  update packs set statut = 'retracte', retracte_le = now(), note_credit_id = nc.id,
         remboursement_montant = m, updated_at = now()
   where id = p.id;
  return jsonb_build_object('montant', m, 'note_credit_id', nc.id, 'numero', nc.numero,
                            'mollie_payment_id', p.mollie_payment_id);
end $$;

-- ═══════════════════════════════════════════════════════════════════
--  Achat en ligne (appelées par la fonction serveur « pack », clé de service)
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.finaliser_commande_pack(p_commande uuid, p_payment text, p_montant numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cmd pack_commandes; cid bigint; r jsonb; nom_complet text;
begin
  select * into cmd from pack_commandes where id = p_commande for update;
  if not found then raise exception 'Commande introuvable.'; end if;
  if cmd.statut = 'payee' then
    return jsonb_build_object('deja', true, 'pack_id', cmd.pack_id,
      'client_id', (select client_id from packs where id = cmd.pack_id));
  end if;
  if cmd.mollie_payment_id is distinct from p_payment then raise exception 'Paiement inattendu pour cette commande.'; end if;
  if round(p_montant, 2) <> round(cmd.montant, 2) then raise exception 'Montant payé différent du prix du pack.'; end if;

  nom_complet := trim(cmd.prenom) || ' ' || trim(cmd.nom);
  select id into cid from clients
   where lower(trim(email)) = lower(trim(cmd.email)) and supprime_le is null
   order by id limit 1;
  if cid is null then
    insert into clients (nom, email, telephone, adresse, type, societe, tva)
    values (nom_complet, lower(trim(cmd.email)), trim(cmd.telephone), trim(cmd.adresse), 'particulier',
            nullif(trim(cmd.societe),''), nullif(trim(cmd.tva),''))
    returning id into cid;
  else
    update clients set telephone = coalesce(nullif(trim(telephone),''), trim(cmd.telephone)),
                       adresse   = coalesce(nullif(trim(adresse),''), trim(cmd.adresse)),
                       updated_at = now()
     where id = cid;
  end if;

  r := pack_creer_interne(cid, cmd.formule, true, 'en_ligne', 'en_ligne', nom_complet, cmd.email,
         cmd.telephone, cmd.adresse, cmd.societe, cmd.tva, p_payment,
         case when cmd.consentement then cmd.created_at end);
  update pack_commandes set statut = 'payee', pack_id = (r->>'pack_id')::bigint, traitee_le = now(), erreur = null
   where id = cmd.id;
  return r || jsonb_build_object('client_id', cid);
end $$;

-- Page « merci » : état minimal d'une commande (identifiant impossible à deviner).
create or replace function public.pack_commande_etat(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('statut', c.statut, 'prenom', c.prenom, 'formule', f.nom,
                            'date_fin', p.date_fin, 'email', c.email)
    from pack_commandes c join pack_formules f on f.code = c.formule
    left join packs p on p.id = c.pack_id
   where c.id = p_id and c.created_at > now() - interval '7 days';
$$;

-- ═══════════════════════════════════════════════════════════════════
--  Espace client (utilisateur connecté par lien e-mail)
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.espace_client_id()
returns bigint language sql stable security definer set search_path = public as $$
  select client_id from clients_comptes where user_id = auth.uid();
$$;

create or replace function public.espace_donnees()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare cid bigint := espace_client_id(); c clients;
begin
  if cid is null then return null; end if;
  select * into c from clients where id = cid;
  return jsonb_build_object(
    'client', jsonb_build_object('nom', c.nom, 'email', c.email),
    'packs', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'nom', p.nom, 'statut', p.statut, 'date_debut', p.date_debut, 'date_fin', p.date_fin,
        'interventions_total', p.interventions_total, 'hydrogels_total', p.hydrogels_total,
        'etat', pack_etat(p),
        'journal', coalesce((select jsonb_agg(jsonb_build_object('date', i.date_inter, 'type', i.type,
                     'description', i.description, 'decompte', i.decompte, 'hydrogels', i.hydrogels)
                     order by i.date_inter desc, i.id desc)
                   from pack_interventions i where i.pack_id = p.id), '[]'::jsonb)
      ) order by p.id desc) from packs p where p.client_id = cid and p.statut <> 'en_attente'), '[]'::jsonb),
    'factures', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'numero', f.numero,
        'date', f.date_emission, 'total', f.total, 'type', f.type_document, 'statut', f.statut)
        order by f.date_emission desc, f.id desc)
      from factures f where f.client_id = cid and f.emise_le is not null and f.supprime_le is null), '[]'::jsonb)
  );
end $$;

create or replace function public.espace_facture(p_id bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('numero', f.numero, 'type', f.type_document, 'date_emission', f.date_emission,
    'date_paiement', f.date_paiement, 'mode_paiement', f.mode_paiement, 'statut', f.statut, 'client_nom', f.client_nom,
    'client_adresse', f.client_adresse, 'client_societe', f.client_societe, 'client_tva', f.client_tva,
    'lignes', f.lignes, 'total', f.total, 'remise', f.remise, 'motif_credit', f.motif_credit,
    'origine', (select o.numero from factures o where o.id = f.facture_origine_id),
    'entreprise', (select jsonb_object_agg(cle, valeur) from settings
                    where cle in ('entreprise_nom','entreprise_adresse','entreprise_bce','entreprise_email','entreprise_telephone','finance_mention_tva')))
  from factures f
  where f.id = p_id and f.client_id = espace_client_id() and f.emise_le is not null and f.supprime_le is null;
$$;

-- Demande d'intervention depuis l'espace : arrive dans « Demandes ».
create or replace function public.espace_demande(p_message text)
returns void language plpgsql security definer set search_path = public as $$
declare cid bigint := espace_client_id(); c clients; pre text; nm text;
begin
  if cid is null then raise exception 'Compte client introuvable.'; end if;
  if length(trim(coalesce(p_message,''))) not between 3 and 1500 then raise exception 'Décrivez votre demande (3 à 1500 caractères).'; end if;
  select * into c from clients where id = cid;
  if (select count(*) from demandes_formulaire where lower(email) = lower(c.email)
        and created_at > now() - interval '24 hours') >= 5 then
    raise exception 'Trop de demandes aujourd''hui : appelez-moi directement.';
  end if;
  pre := split_part(trim(c.nom), ' ', 1);
  nm  := nullif(trim(substr(trim(c.nom), length(pre) + 1)), '');
  insert into demandes_formulaire (prenom, nom, email, telephone, appareil, mode_intervention, adresse, description)
  values (pre, coalesce(nm, '-'), c.email, c.telephone, 'Pack Sérénité', 'Pack Sérénité', c.adresse, trim(p_message));
end $$;

-- ── Droits d'exécution ───────────────────────────────────────────────
revoke execute on function public.pack_activer(bigint) from public, anon, authenticated;
revoke execute on function public.pack_creer_interne(bigint,text,boolean,text,text,text,text,text,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke execute on function public.pack_suivre_facture() from public, anon, authenticated;
revoke execute on function public.finaliser_commande_pack(uuid,text,numeric) from public, anon, authenticated;
revoke execute on function public.pack_etat(public.packs) from public, anon;
grant  execute on function public.pack_etat(public.packs) to authenticated;
revoke execute on function public.vendre_pack(bigint,text,boolean,text) from public, anon;
revoke execute on function public.noter_intervention_pack(bigint,text,date,text,text,int,numeric,int,boolean,boolean,text,bigint) from public, anon;
revoke execute on function public.supprimer_intervention_pack(bigint) from public, anon;
revoke execute on function public.pack_retractation_calcul(bigint) from public, anon;
revoke execute on function public.retracter_pack(bigint) from public, anon;
grant execute on function public.vendre_pack(bigint,text,boolean,text) to authenticated;
grant execute on function public.noter_intervention_pack(bigint,text,date,text,text,int,numeric,int,boolean,boolean,text,bigint) to authenticated;
grant execute on function public.supprimer_intervention_pack(bigint) to authenticated;
grant execute on function public.pack_retractation_calcul(bigint) to authenticated;
grant execute on function public.retracter_pack(bigint) to authenticated;
revoke execute on function public.pack_commande_etat(uuid) from public;
grant  execute on function public.pack_commande_etat(uuid) to anon, authenticated;
revoke execute on function public.espace_client_id() from public, anon;
revoke execute on function public.espace_donnees() from public, anon;
revoke execute on function public.espace_facture(bigint) from public, anon;
revoke execute on function public.espace_demande(text) from public, anon;
grant execute on function public.espace_client_id() to authenticated;
grant execute on function public.espace_donnees() to authenticated;
grant execute on function public.espace_facture(bigint) to authenticated;
grant execute on function public.espace_demande(text) to authenticated;

insert into public.settings (cle, valeur) values ('pack_hydrogel_prix', '14.99') on conflict (cle) do nothing;
