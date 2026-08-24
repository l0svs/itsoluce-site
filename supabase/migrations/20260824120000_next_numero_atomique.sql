-- Compteur de numérotation atomique (clients, devis, factures, réparations, diagnostics).
--
-- Problème corrigé : le code applicatif lisait `compteurs.valeur`, ajoutait 1,
-- puis réécrivait. Deux onglets — ou deux appareils — qui créent une facture au
-- même moment lisaient la même valeur et produisaient le MÊME numéro.
-- Pour des factures, c'est un problème comptable et légal, pas seulement un bug.
--
-- Cette fonction fait l'incrément côté base, sous verrou : les appels
-- concurrents sont sérialisés et chaque appelant reçoit un numéro unique.
--
-- Sûre à appliquer : purement additive, ne modifie aucune donnée existante et
-- ne touche à aucun schéma de table. Réversible avec :
--   drop function if exists public.next_numero(text);

create or replace function public.next_numero(p_cle text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_valeur integer;
begin
  -- Sérialise les appels concurrents portant sur la même clé, y compris
  -- lors de la toute première insertion.
  perform pg_advisory_xact_lock(hashtext(p_cle));

  update public.compteurs
     set valeur = coalesce(valeur, 0) + 1
   where cle = p_cle
  returning valeur into v_valeur;

  if v_valeur is null then
    insert into public.compteurs (cle, valeur)
    values (p_cle, 1)
    returning valeur into v_valeur;
  end if;

  return v_valeur;
end;
$$;

grant execute on function public.next_numero(text) to authenticated;
