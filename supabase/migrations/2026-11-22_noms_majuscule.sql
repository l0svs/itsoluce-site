-- Prénoms et noms : chaque partie commence par une majuscule, partout (ERP, site,
-- mails) : « ivana pugliesi » → « Ivana Pugliesi », « arthur freitas de paula » →
-- « Arthur Freitas De Paula », « jean-pierre » → « Jean-Pierre », « o'brien » → « O'Brien ».
-- Seule la première lettre de chaque partie est touchée : le reste du mot n'est
-- jamais mis en minuscules (« McDonald », « DUPONT » restent tels quels).
create or replace function public.nom_propre(p text)
returns text language plpgsql immutable set search_path = public as $$
declare res text := ''; c text; prec text := ' '; i int;
begin
  if p is null then return null; end if;
  for i in 1 .. length(p) loop
    c := substr(p, i, 1);
    if prec in (' ', '-', '''', '’') then res := res || upper(c); else res := res || c; end if;
    prec := c;
  end loop;
  return res;
end $$;

-- Appliqué seulement quand la valeur est saisie ou modifiée : une facture ou un
-- devis déjà émis n'est jamais réécrit.
create or replace function public.trg_noms_propres()
returns trigger language plpgsql set search_path = public as $$
declare col text; v text;
begin
  foreach col in array TG_ARGV loop
    v := to_jsonb(NEW) ->> col;
    if v is not null and (TG_OP = 'INSERT' or v is distinct from (to_jsonb(OLD) ->> col))
       and v <> nom_propre(v) then
      NEW := jsonb_populate_record(NEW, jsonb_build_object(col, nom_propre(v)));
    end if;
  end loop;
  return NEW;
end $$;

drop trigger if exists a_noms_propres on public.clients;
create trigger a_noms_propres before insert or update of nom on public.clients
  for each row execute function public.trg_noms_propres('nom');
drop trigger if exists a_noms_propres on public.demandes_formulaire;
create trigger a_noms_propres before insert or update of nom, prenom on public.demandes_formulaire
  for each row execute function public.trg_noms_propres('nom', 'prenom');
drop trigger if exists a_noms_propres on public.pack_commandes;
create trigger a_noms_propres before insert or update of nom, prenom on public.pack_commandes
  for each row execute function public.trg_noms_propres('nom', 'prenom');
drop trigger if exists a_noms_propres on public.reparations;
create trigger a_noms_propres before insert or update of client_nom on public.reparations
  for each row execute function public.trg_noms_propres('client_nom');
drop trigger if exists a_noms_propres on public.rendezvous;
create trigger a_noms_propres before insert or update of client_nom on public.rendezvous
  for each row execute function public.trg_noms_propres('client_nom');
drop trigger if exists a_noms_propres on public.taches;
create trigger a_noms_propres before insert or update of client_nom on public.taches
  for each row execute function public.trg_noms_propres('client_nom');
drop trigger if exists a_noms_propres on public.devis;
create trigger a_noms_propres before insert or update of client_nom, accepte_par_nom on public.devis
  for each row execute function public.trg_noms_propres('client_nom', 'accepte_par_nom');
drop trigger if exists a_noms_propres on public.factures;
create trigger a_noms_propres before insert or update of client_nom on public.factures
  for each row execute function public.trg_noms_propres('client_nom');

-- Rattrapage des fiches existantes (pas les factures ni devis émis).
update public.clients set nom = nom_propre(nom) where nom <> nom_propre(nom);
update public.demandes_formulaire set nom = nom_propre(nom), prenom = nom_propre(prenom)
  where nom <> nom_propre(nom) or prenom <> nom_propre(prenom);
update public.pack_commandes set nom = nom_propre(nom), prenom = nom_propre(prenom)
  where nom <> nom_propre(nom) or prenom <> nom_propre(prenom);
update public.reparations set client_nom = nom_propre(client_nom) where client_nom <> nom_propre(client_nom);
update public.rendezvous set client_nom = nom_propre(client_nom) where client_nom <> nom_propre(client_nom);
update public.taches set client_nom = nom_propre(client_nom) where client_nom <> nom_propre(client_nom);
update public.devis set client_nom = nom_propre(client_nom) where numero is null and client_nom <> nom_propre(client_nom);
update public.factures set client_nom = nom_propre(client_nom) where numero is null and client_nom <> nom_propre(client_nom);
