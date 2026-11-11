-- ═══════════════════════════════════════════════════════════════════
-- Numéros des clients (CLI-0031…) et des dossiers de réparation (REP-0034…)
-- attribués par la base, comme les devis et les factures.
--
-- Avant : chaque page lisait le compteur, l'augmentait puis vérifiait que le
-- numéro était libre. Deux créations simultanées pouvaient se marcher dessus
-- et rien en base n'interdisait deux fois le même numéro.
-- Ces séries ne repartent pas à zéro chaque année (année 0 = série continue).
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ─── Séries ───────────────────────────────────────────────────────
alter table public.series_numeros drop constraint if exists series_numeros_serie_check;
alter table public.series_numeros add constraint series_numeros_serie_check
  check (serie in ('facture','note_credit','devis','client','reparation'));

insert into public.series_numeros (serie, annee, dernier)
select 'client', 0, greatest(
  coalesce((select max((regexp_match(numero, '^CLI-(\d+)$'))[1]::int) from public.clients), 0),
  coalesce((select valeur from public.compteurs where cle = 'client'), 0))
on conflict (serie, annee) do update
  set dernier = greatest(public.series_numeros.dernier, excluded.dernier);

insert into public.series_numeros (serie, annee, dernier)
select 'reparation', 0, greatest(
  coalesce((select max((regexp_match(numero, '^REP-(\d+)$'))[1]::int) from public.reparations), 0),
  coalesce((select valeur from public.compteurs where cle = 'reparation'), 0))
on conflict (serie, annee) do update
  set dernier = greatest(public.series_numeros.dernier, excluded.dernier);

-- ─── Attribution (remplace la version précédente) ─────────────────
-- Correctif au passage : lpad tronquait au-delà de 9999 (« 10000 » → « 1000 »).
create or replace function public.prochain_numero(p_serie text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  sans_annee boolean := p_serie in ('client','reparation');
  an int := case when sans_annee then 0
                 else extract(year from (now() at time zone 'Europe/Brussels'))::int end;
  n  int;
  num text;
begin
  insert into series_numeros (serie, annee, dernier) values (p_serie, an, 1)
  on conflict (serie, annee) do update set dernier = series_numeros.dernier + 1
  returning dernier into n;
  num := case when n < 10000 then lpad(n::text, 4, '0') else n::text end;
  return case p_serie
    when 'facture'     then an || '-' || num
    when 'note_credit' then 'NC-'  || an || '-' || num
    when 'devis'       then 'DEV-' || an || '-' || num
    when 'client'      then 'CLI-' || num
    when 'reparation'  then 'REP-' || num
  end;
end $$;
revoke all on function public.prochain_numero(text) from public, anon, authenticated;

-- ─── Déclencheurs ─────────────────────────────────────────────────
-- Création : numéro toujours attribué par la base (celui envoyé par le
-- navigateur est ignoré). Modification : un numéro attribué ne change plus.
create or replace function public.numeroter_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' or OLD.numero is null then
    NEW.numero := prochain_numero('client');
  else
    NEW.numero := OLD.numero;
  end if;
  return NEW;
end $$;

create or replace function public.numeroter_reparation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' or OLD.numero is null then
    NEW.numero := prochain_numero('reparation');
  else
    NEW.numero := OLD.numero;
  end if;
  return NEW;
end $$;

revoke execute on function public.numeroter_client()     from public, anon, authenticated;
revoke execute on function public.numeroter_reparation() from public, anon, authenticated;

drop trigger if exists clients_numero on public.clients;
create trigger clients_numero
  before insert or update of numero on public.clients
  for each row execute function public.numeroter_client();

drop trigger if exists reparations_numero on public.reparations;
create trigger reparations_numero
  before insert or update of numero on public.reparations
  for each row execute function public.numeroter_reparation();

-- ─── Unicité ──────────────────────────────────────────────────────
alter table public.clients drop constraint if exists clients_numero_key;
alter table public.clients add constraint clients_numero_key unique (numero);
alter table public.reparations drop constraint if exists reparations_numero_key;
alter table public.reparations add constraint reparations_numero_key unique (numero);

commit;
