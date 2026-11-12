-- ═══════════════════════════════════════════════════════════════════
-- Lot : contrôle avant émission, parrainage, commandes de pièces,
--       kilomètres de déplacement, agenda synchronisé
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ═══ 1. Contrôle avant émission ═════════════════════════════════════
-- Déclencheur séparé, nommé pour passer APRÈS factures_regles /
-- devis_regles (ordre alphabétique) : il voit l'émission qui vient d'être
-- décidée (emise_le / emis_le posés) et la refuse si une mention manque.
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
  -- to_jsonb : OLD n'existe pas à la création, et les deux tables
  -- n'ont pas le même nom de colonne d'émission.
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
  begin
    for l in select * from jsonb_array_elements(coalesce(NEW.lignes, '[]'::jsonb)) loop
      if coalesce(trim(l->>'description'), '') = '' then
        raise exception '% : une ligne n''a pas de description.', doc;
      end if;
      if coalesce((l->>'quantite')::numeric, 0) <= 0 then
        raise exception '% : quantité invalide sur « % ».', doc, l->>'description';
      end if;
      if coalesce((l->>'prix_unitaire')::numeric, 0) < 0 and coalesce(l->>'parrainage', '') = '' then
        raise exception '% : prix négatif sur « % » (utilise la remise).', doc, l->>'description';
      end if;
    end loop;
    if coalesce(NEW.total, 0) < 0 then
      raise exception '% : le total est négatif.', doc;
    end if;
  end;
  return NEW;
end $$;
revoke execute on function public.controle_emission() from public, anon, authenticated;

drop trigger if exists factures_zcontrole on public.factures;
create trigger factures_zcontrole before insert or update on public.factures
  for each row execute function public.controle_emission();
drop trigger if exists devis_zcontrole on public.devis;
create trigger devis_zcontrole before insert or update on public.devis
  for each row execute function public.controle_emission();


-- ═══ 2. Parrainage ═══════════════════════════════════════════════════
alter table public.clients
  add column if not exists code_parrainage text,
  add column if not exists parrain_id bigint references public.clients(id) on delete set null,
  add column if not exists parraine_le timestamptz;
create unique index if not exists clients_code_parrainage_key on public.clients (upper(code_parrainage));

alter table public.demandes_formulaire add column if not exists code_parrainage text;

-- Réglages (modifiables dans Gestion)
insert into public.settings (cle, valeur) values
  ('parrainage_actif', 'oui'),
  ('parrainage_remise_filleul', '10'),
  ('parrainage_recompense', '10'),
  ('parrainage_minimum', '30'),
  ('parrainage_max_an', '5')
on conflict (cle) do nothing;

create or replace function public.parrainage_reglage(p_cle text, p_defaut numeric)
returns numeric language sql stable security definer set search_path = public as $$
  -- « 12,5 » et « 12.5 » acceptés ; une valeur illisible donne la valeur par défaut.
  select coalesce((select case when v ~ '^[0-9]+(\.[0-9]+)?$' then v::numeric end
                     from (select replace(regexp_replace(valeur, '[^0-9.,]', '', 'g'), ',', '.') v
                             from settings where cle = p_cle) x), p_defaut)
$$;
revoke execute on function public.parrainage_reglage(text, numeric) from public, anon;

-- Code lisible : IT-MARC-7KX (sans 0/O ni 1/I pour éviter les confusions)
create or replace function public.generer_code_parrainage(p_nom text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  base text;
  alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  suffixe text;
  code text;
begin
  base := upper(regexp_replace(translate(lower(coalesce(p_nom, '')),
            'àáâäãåçèéêëìíîïñòóôöõùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'), '[^a-z]', '', 'g'));
  base := left(nullif(base, ''), 4);
  if base is null then base := 'CLI'; end if;
  loop
    suffixe := '';
    for i in 1..3 loop
      suffixe := suffixe || substr(alpha, 1 + floor(random() * length(alpha))::int, 1);
    end loop;
    code := 'IT-' || base || '-' || suffixe;
    exit when not exists (select 1 from clients where upper(code_parrainage) = code);
  end loop;
  return code;
end $$;
revoke execute on function public.generer_code_parrainage(text) from public, anon, authenticated;

create or replace function public.clients_parrainage()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.code_parrainage is null or trim(NEW.code_parrainage) = '' then
    NEW.code_parrainage := generer_code_parrainage(NEW.nom);
  end if;
  if TG_OP = 'UPDATE' and OLD.code_parrainage is not null and NEW.code_parrainage is distinct from OLD.code_parrainage then
    NEW.code_parrainage := OLD.code_parrainage;   -- un code distribué ne change plus
  end if;
  if NEW.parrain_id is not null then
    if TG_OP = 'INSERT' or NEW.parrain_id is distinct from OLD.parrain_id then
      if NEW.parrain_id = NEW.id then
        raise exception 'Un client ne peut pas être son propre parrain.';
      end if;
      if TG_OP = 'UPDATE' and OLD.parrain_id is not null then
        raise exception 'Ce client a déjà un parrain.';
      end if;
      if exists (select 1 from clients p where p.id = NEW.parrain_id and p.parrain_id = NEW.id) then
        raise exception 'Parrainage croisé impossible.';
      end if;
      if NEW.email is not null and exists (select 1 from clients p where p.id = NEW.parrain_id
                                            and lower(p.email) = lower(NEW.email)) then
        raise exception 'Le parrain et le filleul ont la même adresse e-mail.';
      end if;
      if TG_OP = 'UPDATE' and exists (select 1 from factures f where f.client_id = NEW.id
                                       and f.statut = 'payee' and f.type_document = 'facture') then
        raise exception 'Ce client a déjà une facture payée : le parrainage est réservé aux nouveaux clients.';
      end if;
      NEW.parraine_le := now();
    end if;
  end if;
  return NEW;
end $$;
revoke execute on function public.clients_parrainage() from public, anon, authenticated;
drop trigger if exists clients_parrainage on public.clients;
create trigger clients_parrainage before insert or update on public.clients
  for each row execute function public.clients_parrainage();

update public.clients set code_parrainage = generer_code_parrainage(nom) where code_parrainage is null;

-- Grand livre des réductions : gains du parrain, utilisations, réduction
-- du filleul. Écrit uniquement par les déclencheurs ci-dessous.
create table if not exists public.parrainage_mouvements (
  id          bigint generated always as identity primary key,
  client_id   bigint not null references public.clients(id) on delete cascade,
  type        text not null check (type in ('gain','utilisation','remise_filleul','annulation')),
  montant     numeric(10,2) not null,
  facture_id  bigint references public.factures(id) on delete set null,
  filleul_id  bigint references public.clients(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
alter table public.parrainage_mouvements enable row level security;
drop policy if exists parrainage_lire on public.parrainage_mouvements;
create policy parrainage_lire on public.parrainage_mouvements for select to authenticated
  using (public.a_acces(array['clients','factures','devis','dashboard']));
revoke insert, update, delete on public.parrainage_mouvements from anon, authenticated;
grant select on public.parrainage_mouvements to authenticated;

create or replace function public.parrainage_solde(p_client_id bigint)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(montant), 0) from parrainage_mouvements
   where client_id = p_client_id and type in ('gain','utilisation','annulation')
$$;
grant execute on function public.parrainage_solde(bigint) to authenticated;
revoke execute on function public.parrainage_solde(bigint) from anon;

-- Lier un filleul à un parrain à partir du code (fiche client, demande).
create or replace function public.lier_parrain(p_client_id bigint, p_code text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_parrain clients%rowtype;
begin
  if not peut_ecrire(array['clients','demandes','devis','factures','reparations']) then
    raise exception 'Accès refusé.';
  end if;
  select * into v_parrain from clients
   where upper(code_parrainage) = upper(trim(coalesce(p_code, ''))) and supprime_le is null;
  if not found then
    raise exception 'Code de parrainage inconnu : %.', p_code;
  end if;
  update clients set parrain_id = v_parrain.id where id = p_client_id;
  return v_parrain.nom;
end $$;
revoke execute on function public.lier_parrain(bigint, text) from public, anon;
grant execute on function public.lier_parrain(bigint, text) to authenticated;

-- Effets d'une facture : réduction filleul et utilisation du parrain à
-- l'émission ; récompense du parrain au premier paiement du filleul.
create or replace function public.parrainage_facture()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_client clients%rowtype;
  l jsonb;
  remise_filleul numeric := 0;
  util_parrain numeric := 0;
  v_max numeric;
  v_solde numeric;
  v_gains_an int;
begin
  if NEW.type_document is distinct from 'facture' or NEW.client_id is null then
    return NEW;
  end if;
  select * into v_client from clients where id = NEW.client_id;

  -- ── À l'émission ──
  if NEW.emise_le is not null and (TG_OP = 'INSERT' or OLD.emise_le is null) then
    for l in select * from jsonb_array_elements(coalesce(NEW.lignes, '[]'::jsonb)) loop
      if l->>'parrainage' = 'filleul' then
        remise_filleul := remise_filleul - coalesce((l->>'total')::numeric, 0);
      elsif l->>'parrainage' = 'parrain' then
        util_parrain := util_parrain - coalesce((l->>'total')::numeric, 0);
      end if;
    end loop;
    if remise_filleul > 0 then
      if coalesce((select lower(trim(valeur)) from settings where cle = 'parrainage_actif'), 'oui') = 'non' then
        raise exception 'Le programme de parrainage est désactivé (Gestion › Facturation).';
      end if;
      if v_client.parrain_id is null then
        raise exception 'Réduction de parrainage impossible : ce client n''a pas de parrain.';
      end if;
      if exists (select 1 from parrainage_mouvements where client_id = NEW.client_id and type = 'remise_filleul') then
        raise exception 'La réduction de bienvenue du parrainage a déjà été utilisée par ce client.';
      end if;
      v_max := parrainage_reglage('parrainage_remise_filleul', 10);
      if remise_filleul > v_max + 0.001 then
        raise exception 'Réduction de parrainage trop élevée (maximum % €).', v_max;
      end if;
      if coalesce(NEW.total, 0) + remise_filleul < parrainage_reglage('parrainage_minimum', 30) then
        raise exception 'La réduction de bienvenue s''applique à partir de % € de réparation.', parrainage_reglage('parrainage_minimum', 30);
      end if;
      insert into parrainage_mouvements (client_id, type, montant, facture_id, note)
      values (NEW.client_id, 'remise_filleul', -remise_filleul, NEW.id, 'Réduction de bienvenue · facture ' || NEW.numero);
    end if;
    if util_parrain > 0 then
      v_solde := parrainage_solde(NEW.client_id);
      if util_parrain > v_solde + 0.001 then
        raise exception 'Réduction de parrainage supérieure au solde disponible (% €).', v_solde;
      end if;
      insert into parrainage_mouvements (client_id, type, montant, facture_id, note)
      values (NEW.client_id, 'utilisation', -util_parrain, NEW.id, 'Utilisée sur la facture ' || NEW.numero);
    end if;
  end if;

  -- ── Au premier paiement d'un filleul ──
  if NEW.statut = 'payee' and (TG_OP = 'INSERT' or OLD.statut is distinct from 'payee')
     and v_client.parrain_id is not null
     and coalesce((select lower(trim(valeur)) from settings where cle = 'parrainage_actif'), 'oui') <> 'non'
     and not exists (select 1 from parrainage_mouvements where filleul_id = NEW.client_id and type = 'gain')
     and coalesce(NEW.total, 0) + remise_filleul_total(NEW) >= parrainage_reglage('parrainage_minimum', 30) then
    select count(*) into v_gains_an from parrainage_mouvements
     where client_id = v_client.parrain_id and type = 'gain'
       and created_at >= date_trunc('year', now());
    if v_gains_an < parrainage_reglage('parrainage_max_an', 5) then
      insert into parrainage_mouvements (client_id, type, montant, facture_id, filleul_id, note)
      values (v_client.parrain_id, 'gain', parrainage_reglage('parrainage_recompense', 10), NEW.id, NEW.client_id,
              'Parrainage de ' || coalesce(v_client.nom, 'un client') || ' · facture ' || NEW.numero);
    end if;
  end if;
  return NEW;
end $$;

-- Montant de la réduction filleul contenue dans une facture (pour juger le
-- minimum sur le prix avant réduction).
create or replace function public.remise_filleul_total(f public.factures)
returns numeric language sql immutable as $$
  select coalesce(-sum((l->>'total')::numeric), 0)
    from jsonb_array_elements(coalesce(f.lignes, '[]'::jsonb)) l
   where l->>'parrainage' = 'filleul'
$$;
revoke execute on function public.parrainage_facture() from public, anon, authenticated;

drop trigger if exists factures_parrainage on public.factures;
create trigger factures_parrainage after insert or update on public.factures
  for each row execute function public.parrainage_facture();

-- Code saisi sur le formulaire public : gardé s'il existe, ignoré sinon
-- (sans le dire au visiteur, pour ne pas servir à tester des codes).
drop function if exists public.submit_demande_formulaire(text, text, text, text, text, text, text, text);
create or replace function public.submit_demande_formulaire(
  p_prenom text, p_nom text, p_email text, p_telephone text,
  p_appareil text, p_mode_intervention text, p_adresse text, p_description text,
  p_code_parrainage text default null)
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
  v_code text := upper(nullif(trim(coalesce(p_code_parrainage, '')), ''));
begin
  if v_prenom is null or v_nom is null or v_email is null
     or v_appareil is null or v_description is null then
    raise exception 'Champs obligatoires manquants.';
  end if;
  if length(v_prenom) > 80 or length(v_nom) > 80 or length(v_email) > 200
     or length(coalesce(v_telephone, '')) > 40 or length(v_appareil) > 150
     or length(coalesce(v_mode, '')) > 40 or length(coalesce(v_adresse, '')) > 300
     or length(v_description) > 4000 or length(coalesce(v_code, '')) > 30 then
    raise exception 'Un champ dépasse la longueur autorisée.';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'Adresse e-mail invalide.';
  end if;
  if (select count(*) from public.demandes_formulaire
       where lower(email) = v_email and created_at > now() - interval '1 hour') >= 3
  or (select count(*) from public.demandes_formulaire
       where created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Trop de demandes envoyées, merci de réessayer plus tard.';
  end if;
  if v_code is not null and not exists (select 1 from clients where upper(code_parrainage) = v_code and supprime_le is null) then
    v_code := null;
  end if;

  insert into public.demandes_formulaire (
    prenom, nom, email, telephone, appareil, mode_intervention, adresse, description, code_parrainage
  ) values (
    v_prenom, v_nom, v_email, v_telephone, v_appareil, v_mode, v_adresse, v_description, v_code
  )
  returning id into v_id;
  return v_id;
end;
$function$;
grant execute on function public.submit_demande_formulaire(text, text, text, text, text, text, text, text, text) to anon, authenticated;

-- Demande transformée (en réparation ou en devis) : le client créé hérite
-- du parrain indiqué par le code, s'il n'en a pas déjà un.
create or replace function public.demandes_parrainage()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_client bigint;
  v_parrain bigint;
begin
  if NEW.code_parrainage is null then return NEW; end if;
  if NEW.converti_reparation_id is not null and OLD.converti_reparation_id is null then
    select client_id into v_client from reparations where id = NEW.converti_reparation_id;
  elsif NEW.converti_devis_id is not null and OLD.converti_devis_id is null then
    select client_id into v_client from devis where id = NEW.converti_devis_id;
  end if;
  if v_client is null then return NEW; end if;
  select id into v_parrain from clients where upper(code_parrainage) = upper(NEW.code_parrainage) and supprime_le is null;
  if v_parrain is not null and v_parrain <> v_client then
    begin
      update clients set parrain_id = v_parrain where id = v_client and parrain_id is null;
    exception when others then
      null;   -- parrainage impossible (même e-mail…) : la transformation continue
    end;
  end if;
  return NEW;
end $$;
revoke execute on function public.demandes_parrainage() from public, anon, authenticated;
drop trigger if exists demandes_parrainage on public.demandes_formulaire;
create trigger demandes_parrainage after update on public.demandes_formulaire
  for each row execute function public.demandes_parrainage();


-- ═══ 3. Commandes de pièces ══════════════════════════════════════════
create table if not exists public.commandes_pieces (
  id              bigint generated always as identity primary key,
  reparation_id   bigint references public.reparations(id) on delete cascade,
  fournisseur     text not null default 'Foneday',
  numero_commande text,
  articles        text,
  montant         numeric(10,2),
  statut          text not null default 'commandee' check (statut in ('commandee','expediee','recue','annulee')),
  commandee_le    date not null default ((now() at time zone 'Europe/Brussels')::date),
  expediee_le     date,
  recue_le        date,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  modifie_par     uuid,
  modifie_le      timestamptz
);
alter table public.commandes_pieces enable row level security;
drop policy if exists commandes_lire on public.commandes_pieces;
drop policy if exists commandes_creer on public.commandes_pieces;
drop policy if exists commandes_modifier on public.commandes_pieces;
drop policy if exists commandes_supprimer on public.commandes_pieces;
create policy commandes_lire on public.commandes_pieces for select to authenticated
  using (public.a_acces(array['reparations','stock','dashboard']));
create policy commandes_creer on public.commandes_pieces for insert to authenticated
  with check (public.peut_ecrire(array['reparations','stock']));
create policy commandes_modifier on public.commandes_pieces for update to authenticated
  using (public.peut_ecrire(array['reparations','stock'])) with check (public.peut_ecrire(array['reparations','stock']));
create policy commandes_supprimer on public.commandes_pieces for delete to authenticated
  using (public.peut_effacer(array['reparations','stock']));
grant select, insert, update, delete on public.commandes_pieces to authenticated;
drop trigger if exists commandes_pieces_auteur on public.commandes_pieces;
create trigger commandes_pieces_auteur before insert or update on public.commandes_pieces
  for each row execute function public.marquer_auteur();
drop trigger if exists commandes_pieces_journal on public.commandes_pieces;
create trigger commandes_pieces_journal after insert or delete or update on public.commandes_pieces
  for each row execute function public.tracer();


-- ═══ 4. Kilomètres de déplacement ════════════════════════════════════
alter table public.rendezvous add column if not exists km numeric(7,1)
  check (km is null or (km >= 0 and km <= 5000));


-- ═══ 5. Agenda synchronisé ═══════════════════════════════════════════
create table if not exists public.agenda_jeton (
  id     integer primary key default 1 check (id = 1),
  jeton  text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  cree_le timestamptz not null default now()
);
insert into public.agenda_jeton (id) values (1) on conflict (id) do nothing;
alter table public.agenda_jeton enable row level security;
revoke all on public.agenda_jeton from anon, authenticated;

create or replace function public.agenda_jeton_lire(p_regenerer boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not peut_ecrire(array['planning']) then
    raise exception 'Accès refusé.';
  end if;
  if p_regenerer then
    update agenda_jeton set jeton = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
                            cree_le = now()
     where id = 1;
  end if;
  select jeton into v from agenda_jeton where id = 1;
  return v;
end $$;
revoke execute on function public.agenda_jeton_lire(boolean) from public, anon;
grant execute on function public.agenda_jeton_lire(boolean) to authenticated;

-- ═══ 6. Modèle de mail « Votre code de parrainage » ════════════════════
-- Ajouté à la liste personnalisée (Gestion › Mails) sans toucher aux autres
-- modèles ; rien n'est fait s'il existe déjà.
update public.settings s
   set valeur = (s.valeur::jsonb || jsonb_build_array(jsonb_build_object(
         'cle', 'parrainage',
         'nom', 'Votre code de parrainage',
         'objet', 'Votre code de parrainage IT Soluce',
         'corps', E'Bonjour {prenom},\n\nMerci pour votre confiance.\n\nVoici votre code de parrainage personnel : {code_parrainage}\n\nTransmettez-le à vos proches. À leur première réparation d''au moins {minimum_parrainage}, ils bénéficient de {remise_filleul} de réduction. Et dès que leur facture est réglée, vous recevez {recompense_parrain} de réduction sur votre prochaine réparation.\n\nLe plus simple est de leur transférer ce lien, le code y est déjà rempli\nhttps://itsoluce.be/?parrain={code_parrainage}#contact\n\nIls peuvent aussi indiquer le code dans le formulaire de demande ou me le communiquer lors de leur prise de contact.'
       )))::text
 where s.cle = 'mail_modeles_v2'
   and jsonb_typeof(s.valeur::jsonb) = 'array'
   and not exists (select 1 from jsonb_array_elements(s.valeur::jsonb) m where m->>'cle' = 'parrainage');

commit;
