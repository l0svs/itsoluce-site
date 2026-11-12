-- ═══════════════════════════════════════════════════════════════════
-- Devis accepté → dossier de réparation automatique
-- + demandes du site « traitées »
--
-- Quand un devis passe en « accepté » (en ligne par le client, ou dans
-- l'ERP), la base rattache ou crée le dossier de réparation :
--   1. devis déjà rattaché à un dossier (fait depuis un dossier, ou
--      « Créer la réparation » déjà utilisé) → rien de nouveau ;
--   2. le client a exactement UN dossier ouvert sans devis → le devis y est
--      rattaché (cas d'un dossier ouvert avant le devis) ;
--   3. sinon → nouveau dossier « à réceptionner » : client, appareil de la
--      demande du site, panne = lignes du devis, prix du devis, pièces du
--      stock liées.
-- La demande du site d'origine est reliée au dossier.
-- ═══════════════════════════════════════════════════════════════════
begin;

-- ─── Demandes du site : « traitée » (différent de « sans suite ») ───
alter table public.demandes_formulaire add column if not exists traitee_le timestamptz;

-- ─── Devis accepté → dossier ───
create or replace function public.devis_dossier_auto()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[];
  v_rep public.reparations%rowtype;
  v_dem_id bigint;
  v_dem_appareil text;
  v_dem_desc text;
  v_lignes text;
  v_panne text;
  v_pieces jsonb;
  v_cout numeric;
  v_quand text := to_char(now() at time zone 'Europe/Brussels', 'DD/MM/YYYY à HH24"h"MI');
begin
  if NEW.statut is distinct from 'accepte' or NEW.supprime_le is not null then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.statut = 'accepte' then
    return NEW;   -- seulement au passage en « accepté »
  end if;

  -- 1. Déjà rattaché à un dossier
  if coalesce(NEW.converti_reparation_id, NEW.reparation_id) is not null then
    NEW.converti_reparation_id := coalesce(NEW.converti_reparation_id, NEW.reparation_id);
    NEW.reparation_id := coalesce(NEW.reparation_id, NEW.converti_reparation_id);
    if NEW.reparation_numero is null then
      select numero into NEW.reparation_numero from reparations where id = NEW.reparation_id;
    end if;
    return NEW;
  end if;

  -- Demande du site à l'origine du devis
  select id, appareil, description into v_dem_id, v_dem_appareil, v_dem_desc
    from demandes_formulaire where converti_devis_id = NEW.id order by id limit 1;

  -- 2. Un seul dossier ouvert du client, sans devis rattaché
  if NEW.client_id is not null then
    select array_agg(r.id) into v_ids
      from reparations r
     where r.client_id = NEW.client_id
       and r.supprime_le is null
       and r.garantie_de_id is null
       and coalesce(r.statut, '') not in ('rendu', 'annule', 'non_reparable')
       and not exists (select 1 from devis d2
                        where d2.id <> NEW.id and d2.supprime_le is null and d2.statut <> 'refuse'
                          and (d2.converti_reparation_id = r.id or d2.reparation_id = r.id));
    if coalesce(array_length(v_ids, 1), 0) = 1 then
      update reparations
         set prix_devis = case when coalesce(prix_devis, 0) = 0 then coalesce(NEW.total, 0) else prix_devis end,
             notes = concat_ws(E'\n', nullif(notes, ''),
                       'Devis ' || coalesce(NEW.numero, '') || ' accepté le ' || v_quand || ' : rattaché automatiquement à ce dossier.'),
             updated_at = now()
       where id = v_ids[1]
      returning * into v_rep;
      NEW.converti_reparation_id := v_rep.id;
      NEW.reparation_id := v_rep.id;
      NEW.reparation_numero := v_rep.numero;
      if v_dem_id is not null then
        update demandes_formulaire set converti_reparation_id = v_rep.id
         where id = v_dem_id and converti_reparation_id is null;
      end if;
      return NEW;
    end if;
  end if;

  -- 3. Nouveau dossier « à réceptionner »
  select string_agg('• ' || trim(l->>'description'), E'\n')
    into v_lignes
    from jsonb_array_elements(coalesce(NEW.lignes, '[]'::jsonb)) l
   where coalesce(trim(l->>'description'), '') <> '';
  -- Les notes du devis reprennent souvent la demande (« Appareil : … Panne : … ») :
  -- on ne les ajoute que si elles apportent autre chose.
  v_panne := concat_ws(E'\n\n', nullif(trim(coalesce(v_dem_desc, '')), ''), v_lignes,
               case when nullif(trim(coalesce(v_dem_desc, '')), '') is not null
                         and position(trim(v_dem_desc) in coalesce(NEW.notes, '')) > 0 then null
                    else nullif(trim(coalesce(NEW.notes, '')), '') end);

  select coalesce(jsonb_agg(jsonb_build_object(
           'stock_id', (l->>'stock_id')::bigint,
           'service_id', null,
           'nom', coalesce(s.nom, l->>'description'),
           'qte', coalesce(nullif(l->>'quantite', '')::numeric, 1),
           'cout', coalesce(s.prix_achat, 0))), '[]'::jsonb),
         coalesce(sum(coalesce(nullif(l->>'quantite', '')::numeric, 1) * coalesce(s.prix_achat, 0)), 0)
    into v_pieces, v_cout
    from jsonb_array_elements(coalesce(NEW.lignes, '[]'::jsonb)) l
    left join stock s on s.id = case when (l->>'stock_id') ~ '^[0-9]+$' then (l->>'stock_id')::bigint end
   where (l->>'stock_id') ~ '^[0-9]+$';

  insert into reparations (client_id, client_nom, client_email, client_telephone,
                           appareil, modele, panne_description, statut,
                           prix_devis, prix_final, cout_pieces, pieces, notes, updated_at)
  values (NEW.client_id, coalesce(nullif(trim(NEW.client_nom), ''), 'Client'), NEW.client_email, NEW.client_telephone,
          coalesce(nullif(trim(v_dem_appareil), ''), ''), null, coalesce(nullif(v_panne, ''), 'À compléter'), 'attente_reception',
          coalesce(NEW.total, 0), 0, v_cout, v_pieces,
          'Créé automatiquement : devis ' || coalesce(NEW.numero, '') || ' accepté'
            || case when NEW.accepte_en_ligne_le is not null then ' en ligne' else '' end
            || ' le ' || v_quand || '.',
          now())
  returning * into v_rep;

  NEW.converti_reparation_id := v_rep.id;
  NEW.reparation_id := v_rep.id;
  NEW.reparation_numero := v_rep.numero;
  if v_dem_id is not null then
    update demandes_formulaire set converti_reparation_id = v_rep.id
     where id = v_dem_id and converti_reparation_id is null;
  end if;
  return NEW;
end $$;
revoke execute on function public.devis_dossier_auto() from public, anon, authenticated;

-- Nommé pour passer APRÈS devis_regles et devis_zcontrole (ordre alphabétique) :
-- le dossier n'est créé que pour un devis réellement accepté et valide.
drop trigger if exists devis_zdossier on public.devis;
create trigger devis_zdossier before insert or update on public.devis
  for each row execute function public.devis_dossier_auto();

commit;
