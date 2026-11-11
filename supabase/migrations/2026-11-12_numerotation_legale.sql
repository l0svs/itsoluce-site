-- ═══════════════════════════════════════════════════════════════════
-- Numérotation légale des devis et des factures + note de crédit
-- ═══════════════════════════════════════════════════════════════════
--
-- Règles (appliquées par la base, quel que soit l'écran ou le code client) :
--
-- 1. Un BROUILLON n'a pas de numéro. Il se modifie et se supprime librement.
-- 2. Un document reçoit son numéro au moment où il est ÉMIS, c'est-à-dire
--    quand il quitte le statut « brouillon » (envoi, PDF remis, encaissement,
--    acceptation). Le numéro est pris dans une série par année, sans trou :
--      factures        2026-0028, 2026-0029…
--      notes de crédit NC-2026-0001…
--      devis           DEV-2026-0050…
--    La date d'émission devient la date du jour (heure belge) : numéros et
--    dates restent dans l'ordre chronologique.
-- 3. Un document émis ne change plus (lignes, montants, client, notes) et ne
--    se supprime plus. Une facture se corrige ou s'annule par une NOTE DE
--    CRÉDIT ; un devis se corrige par une nouvelle version (« révision »).
-- 4. Le navigateur ne choisit jamais un numéro : il est ignoré s'il en envoie un.
--
-- À valider avec un comptable agréé ITAA (format des séries, mentions).
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ─── 1. Séries de numérotation ────────────────────────────────────
create table if not exists public.series_numeros (
  serie   text not null check (serie in ('facture','note_credit','devis')),
  annee   int  not null,
  dernier int  not null default 0 check (dernier >= 0),
  primary key (serie, annee)
);
alter table public.series_numeros enable row level security;
drop policy if exists series_numeros_lire on public.series_numeros;
create policy series_numeros_lire on public.series_numeros
  for select to authenticated using (public.a_acces('{devis,factures,gestion}'));
-- Aucune politique d'écriture : seules les fonctions ci-dessous écrivent.

-- ─── 2. Nouvelles colonnes ────────────────────────────────────────
alter table public.factures
  add column if not exists type_document      text not null default 'facture',
  add column if not exists facture_origine_id bigint references public.factures(id),
  add column if not exists motif_credit       text,
  add column if not exists emise_le           timestamptz;
alter table public.factures drop constraint if exists factures_type_document_chk;
alter table public.factures add constraint factures_type_document_chk
  check (type_document in ('facture','note_credit'));
create index if not exists factures_facture_origine_id_idx on public.factures (facture_origine_id);

alter table public.devis
  add column if not exists emis_le           timestamptz,
  add column if not exists remplace_devis_id bigint references public.devis(id);

-- ─── 3. Reprise de l'existant ─────────────────────────────────────
-- Tout ce qui n'est pas un brouillon est considéré comme émis.
update public.factures set emise_le = coalesce(date_emission::timestamptz, created_at)
 where statut <> 'brouillon' and emise_le is null;
update public.devis set emis_le = coalesce(date_emission::timestamptz, created_at)
 where statut <> 'brouillon' and emis_le is null;

-- Les séries repartent du plus grand numéro existant (corbeille comprise),
-- pour ne jamais réattribuer un numéro déjà utilisé.
insert into public.series_numeros (serie, annee, dernier)
select 'facture', (m[1])::int, max((m[2])::int)
  from public.factures, regexp_match(numero, '^(\d{4})-(\d+)$') m
 where numero ~ '^\d{4}-\d+$'
 group by 2
on conflict (serie, annee) do update
  set dernier = greatest(public.series_numeros.dernier, excluded.dernier);

insert into public.series_numeros (serie, annee, dernier)
select 'devis', extract(year from created_at)::int,
       max((regexp_match(numero, '^DEV-(?:\d{4}-)?(\d+)$'))[1]::int)
  from public.devis
 where numero ~ '^DEV-'
 group by 2
on conflict (serie, annee) do update
  set dernier = greatest(public.series_numeros.dernier, excluded.dernier);

-- ─── 4. Attribution d'un numéro (atomique) ────────────────────────
-- L'UPSERT verrouille la ligne de la série : deux émissions simultanées
-- reçoivent forcément deux numéros consécutifs différents.
create or replace function public.prochain_numero(p_serie text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  an int := extract(year from (now() at time zone 'Europe/Brussels'))::int;
  n  int;
begin
  insert into series_numeros (serie, annee, dernier) values (p_serie, an, 1)
  on conflict (serie, annee) do update set dernier = series_numeros.dernier + 1
  returning dernier into n;
  return case p_serie
    when 'facture'     then an || '-'     || lpad(n::text, 4, '0')
    when 'note_credit' then 'NC-'  || an || '-' || lpad(n::text, 4, '0')
    when 'devis'       then 'DEV-' || an || '-' || lpad(n::text, 4, '0')
  end;
end $$;
revoke all on function public.prochain_numero(text) from public, anon, authenticated;

-- ─── 5. Règles des factures et notes de crédit ────────────────────
create or replace function public.factures_regles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  aujourdhui date := (now() at time zone 'Europe/Brussels')::date;
  emettre boolean := false;
begin
  if TG_OP = 'INSERT' then
    if NEW.type_document = 'note_credit' then
      if NEW.facture_origine_id is null then
        raise exception 'Une note de crédit doit se rapporter à une facture.';
      end if;
      perform 1 from factures o
       where o.id = NEW.facture_origine_id and o.type_document = 'facture'
         and o.emise_le is not null and o.supprime_le is null;
      if not found then
        raise exception 'La facture d''origine doit exister et être émise.';
      end if;
      if NEW.statut not in ('imputee','a_rembourser','remboursee') then
        raise exception 'Statut de note de crédit invalide : %.', NEW.statut;
      end if;
      if coalesce(NEW.total, 0) >= 0 then
        raise exception 'Le montant d''une note de crédit doit être négatif.';
      end if;
    elsif NEW.statut in ('creditee','imputee','a_rembourser','remboursee') then
      raise exception 'Statut réservé aux notes de crédit : %.', NEW.statut;
    end if;
    if NEW.statut = 'annulee' then
      raise exception 'Un brouillon se supprime, il ne s''annule pas.';
    end if;
    NEW.numero   := null;   -- jamais choisi par le navigateur
    NEW.emise_le := null;
    emettre := NEW.statut <> 'brouillon';

  elsif OLD.emise_le is not null then
    -- ── Document émis : contenu figé ──
    if NEW.numero             is distinct from OLD.numero
    or NEW.date_emission      is distinct from OLD.date_emission
    or NEW.emise_le           is distinct from OLD.emise_le
    or NEW.type_document      is distinct from OLD.type_document
    or NEW.facture_origine_id is distinct from OLD.facture_origine_id
    or NEW.lignes             is distinct from OLD.lignes
    or NEW.total              is distinct from OLD.total
    or NEW.remise             is distinct from OLD.remise
    or NEW.acompte            is distinct from OLD.acompte
    or NEW.client_nom         is distinct from OLD.client_nom
    or NEW.client_adresse     is distinct from OLD.client_adresse
    or NEW.client_societe     is distinct from OLD.client_societe
    or NEW.client_tva         is distinct from OLD.client_tva
    or NEW.notes              is distinct from OLD.notes
    or NEW.motif_credit       is distinct from OLD.motif_credit then
      raise exception 'Le document % est émis : son contenu ne peut plus être modifié. Corrige-le avec une note de crédit.', OLD.numero;
    end if;
    if NEW.supprime_le is not null and OLD.supprime_le is null then
      raise exception 'Le document % est émis : il ne peut pas être supprimé. Annule-le avec une note de crédit.', OLD.numero;
    end if;
    if NEW.statut is distinct from OLD.statut then
      if OLD.statut in ('creditee','annulee','imputee','remboursee') then
        raise exception 'Le document % est clôturé (%) : son statut ne change plus.', OLD.numero, OLD.statut;
      end if;
      if OLD.type_document = 'facture' then
        if NEW.statut not in ('envoyee','payee','non_reparable','creditee') then
          raise exception 'Statut impossible pour une facture émise : %.', NEW.statut;
        end if;
        if NEW.statut = 'creditee' then
          perform 1 from factures nc
           where nc.facture_origine_id = OLD.id and nc.type_document = 'note_credit'
             and nc.supprime_le is null;
          if not found then
            raise exception 'Une facture ne passe en « Créditée » que par une note de crédit.';
          end if;
        end if;
      elsif NEW.statut not in ('a_rembourser','remboursee') then
        raise exception 'Statut impossible pour une note de crédit : %.', NEW.statut;
      end if;
    end if;
    return NEW;

  else
    -- ── Brouillon ──
    if NEW.statut = 'annulee' then
      raise exception 'Un brouillon se supprime, il ne s''annule pas.';
    end if;
    if NEW.statut = 'creditee' then
      raise exception 'Un brouillon ne peut pas être crédité.';
    end if;
    NEW.numero   := OLD.numero;   -- anciens brouillons déjà numérotés : conservé
    NEW.emise_le := null;
    emettre := NEW.statut <> 'brouillon' and NEW.supprime_le is null;
  end if;

  if emettre then
    if coalesce(trim(NEW.client_nom), '') = '' then
      raise exception 'Nom du client manquant : le document ne peut pas être émis.';
    end if;
    if jsonb_typeof(NEW.lignes) is distinct from 'array' or jsonb_array_length(NEW.lignes) = 0 then
      raise exception 'Document sans ligne : il ne peut pas être émis.';
    end if;
    if NEW.numero is null then
      NEW.numero := prochain_numero(case when NEW.type_document = 'note_credit' then 'note_credit' else 'facture' end);
    end if;
    -- L'échéance garde le même délai, compté à partir de l'émission.
    if NEW.date_echeance is not null and NEW.date_emission is not null then
      NEW.date_echeance := aujourdhui + greatest(0, NEW.date_echeance - NEW.date_emission);
    end if;
    NEW.date_emission := aujourdhui;
    NEW.emise_le      := now();
  end if;
  return NEW;
end $$;

drop trigger if exists factures_regles on public.factures;
create trigger factures_regles
  before insert or update on public.factures
  for each row execute function public.factures_regles();

-- ─── 6. Règles des devis ──────────────────────────────────────────
create or replace function public.devis_regles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
    if NEW.supprime_le is not null and OLD.supprime_le is null then
      raise exception 'Le devis % est émis : il ne peut pas être supprimé. Classe-le « Refusé ».', OLD.numero;
    end if;
    if NEW.statut = 'brouillon' then
      raise exception 'Le devis % est émis : il ne redevient pas un brouillon.', OLD.numero;
    end if;
    return NEW;

  else
    NEW.numero  := OLD.numero;
    NEW.emis_le := null;
    emettre := NEW.statut <> 'brouillon' and NEW.supprime_le is null;
  end if;

  if emettre then
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
end $$;

drop trigger if exists devis_regles on public.devis;
create trigger devis_regles
  before insert or update on public.devis
  for each row execute function public.devis_regles();

commit;
