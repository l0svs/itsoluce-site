-- ═══════════════════════════════════════════════════════════════════
-- Devis de test : supprimables même après émission
--
-- Un devis émis ne se supprime pas (on le classe « Refusé »). Exception
-- demandée pour les essais : un devis dont le nom du client contient le mot
-- « test » (ex. « Linton Test ») peut être mis à la corbeille même émis.
-- Son numéro n'est pas réutilisé (trou dans la série des devis, sans
-- conséquence : contrairement aux factures, les devis n'ont pas
-- d'obligation de numérotation continue). Les factures ne sont pas
-- concernées.
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.devis_regles()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
    if NEW.supprime_le is not null and OLD.supprime_le is null
       and coalesce(OLD.client_nom, '') !~* '\mtest\M' then
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
end $function$;

revoke execute on function public.devis_regles() from public, anon, authenticated;
