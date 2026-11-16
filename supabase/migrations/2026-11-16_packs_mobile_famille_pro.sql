-- ═══════════════════════════════════════════════════════════
--  Pack Sérénité : nouvelles formules annuelles Mobile / Famille / Pro.
--  - Famille et Pro : 1 intervention par mois (main-d'œuvre incluse, 1 h),
--    non reportée d'un mois sur l'autre (période = mois du pack, à partir
--    de la date de début).
--  - Mobile : pas d'intervention mensuelle ; 1 « intervention » au compteur
--    = le transfert vers un nouveau smartphone offert.
--  - Rétractation : prix payé moins les prestations déjà fournies à leur
--    tarif normal (85 € par intervention, 14,99 € par hydrogel posé).
--  Les anciennes formules 3m / 6m / 12m sont désactivées dans un second temps,
--  une fois la nouvelle page pack.html en ligne.
-- ═══════════════════════════════════════════════════════════

alter table public.pack_formules
  add column if not exists par_mois boolean not null default false,
  add column if not exists libelle  text,
  add column if not exists resume   text;
alter table public.packs
  add column if not exists par_mois boolean not null default false;

insert into public.pack_formules (code, nom, mois, interventions, hydrogels, prix, actif, ordre, par_mois, libelle, resume) values
 ('mobile', 'Sérénité Mobile', 12, 1, 2, 69, true, 1, false,
  '2 protections hydrogel, transfert vers un nouveau smartphone offert, diagnostic offert, bilan santé annuel du smartphone, rendez-vous prioritaire, déplacement inclus, −20 % sur la main-d''œuvre des réparations.',
  'vos 2 protections hydrogel, le transfert vers votre nouveau smartphone et le diagnostic offert'),
 ('famille', 'Sérénité Famille', 12, 12, 4, 349, true, 2, true,
  '1 intervention par mois pour tous les appareils du foyer (main-d''œuvre incluse, 1 h maximum, à domicile, sur le lieu de travail ou en dépôt), 4 protections hydrogel, diagnostic offert, bilan santé annuel, rendez-vous prioritaire, déplacement inclus, −20 % sur la main-d''œuvre au-delà.',
  '1 intervention par mois, main-d''œuvre incluse, à domicile, sur votre lieu de travail ou en dépôt à Tubize'),
 ('pro', 'Sérénité Pro', 12, 12, 4, 590, true, 3, true,
  '1 intervention par mois pour les postes et appareils de l''entreprise (main-d''œuvre incluse, 1 h maximum, sur place ou en dépôt), 4 protections hydrogel, diagnostic offert, bilan santé annuel, rendez-vous prioritaire, déplacement inclus, −20 % sur la main-d''œuvre au-delà.',
  '1 intervention par mois, main-d''œuvre incluse, sur place ou en dépôt à Tubize')
on conflict (code) do update set nom = excluded.nom, mois = excluded.mois, interventions = excluded.interventions,
  hydrogels = excluded.hydrogels, prix = excluded.prix, actif = true, ordre = excluded.ordre,
  par_mois = excluded.par_mois, libelle = excluded.libelle, resume = excluded.resume;
update public.pack_formules set ordre = ordre + 100 where code in ('3m','6m','12m') and ordre < 100;

insert into public.settings (cle, valeur) values ('pack_intervention_prix', '85')
on conflict (cle) do nothing;

-- Période mensuelle du pack contenant une date : [début + k mois ; début + k+1 mois[.
create or replace function public.pack_periode(p_debut date, p_d date, out debut_p date, out fin_p date)
language plpgsql immutable set search_path = public as $$
declare k int := greatest(0, (date_part('year', age(p_d, p_debut)) * 12 + date_part('month', age(p_d, p_debut)))::int - 1);
begin
  while (p_debut + make_interval(months => k + 1))::date <= p_d loop k := k + 1; end loop;
  debut_p := (p_debut + make_interval(months => k))::date;
  fin_p   := (p_debut + make_interval(months => k + 1))::date - 1;
end $$;
revoke execute on function public.pack_periode(date, date) from public, anon, authenticated;

create or replace function public.pack_etat(p packs)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'utilisees',          coalesce((select sum(decompte) from pack_interventions where pack_id = p.id), 0),
    'restantes',          p.interventions_total - coalesce((select sum(decompte) from pack_interventions where pack_id = p.id), 0),
    'hydrogels_utilises', coalesce((select sum(hydrogels) from pack_interventions where pack_id = p.id), 0),
    'expire',             p.statut = 'actif' and p.date_fin < (now() at time zone 'Europe/Brussels')::date,
    'par_mois',           p.par_mois,
    'mois_debut',         per.debut_p,
    'mois_fin',           per.fin_p,
    'mois_utilisee',      coalesce((select sum(decompte) from pack_interventions
                                     where pack_id = p.id and date_inter between per.debut_p and per.fin_p), 0) > 0
  )
  from pack_periode(coalesce(p.date_debut, (now() at time zone 'Europe/Brussels')::date),
                    greatest(coalesce(p.date_debut, (now() at time zone 'Europe/Brussels')::date),
                             least((now() at time zone 'Europe/Brussels')::date,
                                   coalesce(p.date_fin, (now() at time zone 'Europe/Brussels')::date)))) per;
$$;
revoke execute on function public.pack_etat(public.packs) from public, anon, authenticated;

create or replace function public.pack_creer_interne(p_client_id bigint, p_formule text, p_payee boolean, p_mode_paiement text,
  p_origine text, p_nom text, p_email text, p_telephone text, p_adresse text, p_societe text, p_tva text,
  p_mollie text, p_consentement timestamp with time zone)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
  f   pack_formules;
  pk  bigint;
  fac factures;
  auj date := (now() at time zone 'Europe/Brussels')::date;
  libelle text;
begin
  select * into f from pack_formules where code = p_formule and actif;
  if not found then raise exception 'Formule de pack inconnue.'; end if;
  if coalesce(trim(p_adresse), '') = '' and (coalesce(trim(p_societe), '') <> '' or coalesce(trim(p_tva), '') <> '') then
    raise exception 'Adresse du client professionnel manquante : elle est obligatoire sur la facture.';
  end if;

  insert into packs (client_id, formule, nom, mois, interventions_total, hydrogels_total, prix,
                     origine, mollie_payment_id, consentement_le, par_mois)
  values (p_client_id, f.code, f.nom, f.mois, f.interventions, f.hydrogels, f.prix,
          p_origine, p_mollie, p_consentement, f.par_mois)
  returning id into pk;

  libelle := f.nom || ' — ' || coalesce(nullif(trim(f.libelle), ''),
            f.interventions || ' interventions incluses (à domicile, sur le lieu de travail ou en dépôt)'
            || case when f.hydrogels > 0 then ', ' || f.hydrogels || ' protection' || case when f.hydrogels > 1 then 's' else '' end
                    || ' hydrogel offerte' || case when f.hydrogels > 1 then 's' else '' end else '' end
            || ', pièces détachées −10 %.')
          || ' Valable ' || f.mois || ' mois à compter du paiement.';

  insert into factures (client_id, client_nom, client_email, client_telephone, client_adresse,
                        client_societe, client_tva, date_emission, date_echeance, statut,
                        lignes, total, remise, acompte, acompte_type, stock_decremente,
                        date_paiement, mode_paiement, notes)
  values (p_client_id, p_nom, nullif(trim(p_email), ''), nullif(trim(p_telephone), ''), nullif(trim(p_adresse), ''),
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
end $function$;

create or replace function public.noter_intervention_pack(p_pack bigint, p_type text, p_date date, p_description text, p_note text,
  p_duree_min integer, p_km numeric, p_hydrogels integer, p_decompter boolean, p_creer_dossier boolean,
  p_appareil text default null, p_reparation_id bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
  p packs; c clients; e jsonb; rep reparations; iid bigint; per record;
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
  if p_decompter and p.par_mois then
    select * into per from pack_periode(p.date_debut, coalesce(p_date, auj));
    if exists (select 1 from pack_interventions where pack_id = p.id and decompte > 0
                and date_inter between per.debut_p and per.fin_p) then
      raise exception 'L''intervention du mois est déjà utilisée (période du % au %). Décochez « Décompter » : elle sera facturée avec la remise de 20 pour cent.',
        to_char(per.debut_p,'DD/MM/YYYY'), to_char(per.fin_p,'DD/MM/YYYY');
    end if;
  end if;
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
end $function$;

create or replace function public.pack_retractation_calcul(p_pack bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $function$
declare
  p packs; fac factures; e jsonb; prix_h numeric; prix_i numeric; m numeric; raison text;
begin
  if not a_acces(array['factures','clients']) then raise exception 'Droits insuffisants.'; end if;
  select * into p from packs where id = p_pack;
  if not found then raise exception 'Pack introuvable.'; end if;
  select * into fac from factures where id = p.facture_id;
  e := pack_etat(p);
  prix_h := coalesce(nullif(trim((select valeur from settings where cle = 'pack_hydrogel_prix')), '')::numeric, 14.99);
  prix_i := coalesce(nullif(trim((select valeur from settings where cle = 'pack_intervention_prix')), '')::numeric, 85);
  m := greatest(0, round(p.prix - (e->>'utilisees')::int * prix_i - (e->>'hydrogels_utilises')::int * prix_h, 2));
  raison := case
    when p.statut <> 'actif' then 'Le pack n''est pas actif.'
    when coalesce(trim(fac.client_societe),'') <> '' or coalesce(trim(fac.client_tva),'') <> '' then 'Client professionnel : pas de droit de rétractation.'
    when p.paye_le < now() - interval '14 days' then 'Délai de 14 jours dépassé (payé le ' || to_char(p.paye_le at time zone 'Europe/Brussels','DD/MM/YYYY') || ').'
    else null end;
  return jsonb_build_object('possible', raison is null, 'raison', raison, 'montant', m, 'prix', p.prix,
    'utilisees', (e->>'utilisees')::int, 'prix_intervention', prix_i,
    'restantes', (e->>'restantes')::int, 'total', p.interventions_total,
    'hydrogels_utilises', (e->>'hydrogels_utilises')::int, 'prix_hydrogel', prix_h,
    'paye_le', p.paye_le, 'fin_delai', p.paye_le + interval '14 days',
    'en_ligne', p.mollie_payment_id is not null);
end $function$;

create or replace function public.retracter_pack(p_pack bigint)
returns jsonb language plpgsql security definer set search_path = public as $function$
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
              'description', 'Rétractation ' || p.nom || ' — remboursement du prix payé, prestations déjà fournies déduites'
                 || case when (calc->>'utilisees')::int > 0
                         then ' : ' || (calc->>'utilisees') || ' intervention(s) à ' || replace(to_char((calc->>'prix_intervention')::numeric, 'FM999990.00'), '.', ',') || ' €' else '' end
                 || case when (calc->>'hydrogels_utilises')::int > 0
                         then case when (calc->>'utilisees')::int > 0 then ', ' else ' : ' end
                              || (calc->>'hydrogels_utilises') || ' protection(s) hydrogel à ' || replace(to_char((calc->>'prix_hydrogel')::numeric, 'FM999990.00'), '.', ',') || ' €' else '' end
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
end $function$;

-- Espace client : la formule du pack est transmise (affichage Mobile / Famille / Pro).
-- (Même fonction qu'avant, avec 'formule' en plus dans chaque pack.)
-- Voir la définition appliquée en base : public.espace_donnees().
