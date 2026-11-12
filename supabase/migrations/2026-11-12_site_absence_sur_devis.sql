-- ═══════════════════════════════════════════════════════════════════
-- Site vitrine : bandeau « Absence », prestations « Sur devis »
--
-- 1. Absence : les réglages vivent dans settings (Gestion › Absence).
--    Le site ne lit pas settings (réservée aux comptes connectés) : il
--    appelle site_absence(), qui ne renvoie que l'absence à afficher, et
--    seulement pendant la période d'annonce et d'absence.
-- 2. Prestations : un prix vide signifie « Sur devis » sur le site.
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ─── 1. Absence ───
create or replace function public.site_absence()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_auj    date := (now() at time zone 'Europe/Brussels')::date;
  v_debut  date;
  v_fin    date;
  v_annonce int;
begin
  if coalesce((select lower(trim(valeur)) from settings where cle = 'absence_actif'), 'non') <> 'oui' then
    return null;
  end if;
  begin
    v_debut := nullif(trim((select valeur from settings where cle = 'absence_debut')), '')::date;
    v_fin   := nullif(trim((select valeur from settings where cle = 'absence_fin')), '')::date;
    v_annonce := coalesce(nullif(trim((select valeur from settings where cle = 'absence_annonce_jours')), '')::int, 7);
  exception when others then
    return null;   -- réglage illisible : rien plutôt qu'un bandeau faux
  end;
  if v_debut is null or v_fin is null or v_fin < v_debut then
    return null;
  end if;
  v_annonce := least(greatest(v_annonce, 0), 60);
  if v_auj < v_debut - v_annonce or v_auj > v_fin then
    return null;
  end if;
  return jsonb_build_object(
    'phase',    case when v_auj < v_debut then 'avant' else 'pendant' end,
    'debut',    v_debut,
    'fin',      v_fin,
    'retour',   v_fin + 1,
    'message',  nullif(trim(coalesce((select valeur from settings where cle = 'absence_message'), '')), ''),
    'depots',   coalesce((select lower(trim(valeur)) from settings where cle = 'absence_depots'), 'oui') = 'oui',
    'telephone',coalesce((select lower(trim(valeur)) from settings where cle = 'absence_telephone'), 'oui') = 'oui'
  );
end $$;
revoke execute on function public.site_absence() from public;
grant execute on function public.site_absence() to anon, authenticated;

-- ─── 2. Prestations « Sur devis » ───
alter table public.services alter column prix drop not null;

-- « Autres interventions » : sur devis, en dernier ; « Nettoyage manette »
-- juste avant.
update public.services set prix = null, prix_max = null, unite = null
 where lower(trim(nom)) = 'autres interventions';
update public.services s set ordre = m.o + 2
  from (select coalesce(max(ordre), 0) o from public.services) m
 where lower(trim(s.nom)) = 'autres interventions';
update public.services s set ordre = m.o + 1
  from (select coalesce(max(ordre), 0) o from public.services where lower(trim(nom)) <> 'autres interventions') m
 where lower(trim(s.nom)) = 'nettoyage manette';

commit;
