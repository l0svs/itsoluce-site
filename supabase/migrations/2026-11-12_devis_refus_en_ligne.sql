-- ═══════════════════════════════════════════════════════════════════
-- Refus du devis en ligne
--
-- Sur la page de son devis, le client peut aussi décliner : motif, petit
-- commentaire facultatif et, si c'est une question de prix, demande d'être
-- recontacté pour une solution moins chère. Le devis passe en « Refusé »
-- (les relances s'arrêtent d'elles-mêmes) et IT Soluce est prévenu par mail
-- (fonction devis-accepte, une seule fois grâce à refus_notifie_le).
-- ═══════════════════════════════════════════════════════════════════

begin;

alter table public.devis
  add column if not exists refuse_en_ligne_le timestamptz,
  add column if not exists motif_refus        text,
  add column if not exists commentaire_refus  text,
  add column if not exists recontact_souhaite boolean not null default false,
  add column if not exists refus_notifie_le   timestamptz;

-- Lecture publique : ajoute les informations de refus.
create or replace function public.devis_public(p_jeton uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d devis%rowtype;
  aujourdhui date := (now() at time zone 'Europe/Brussels')::date;
  etat text;
begin
  select * into d from devis
   where jeton_public = p_jeton and emis_le is not null and supprime_le is null;
  if not found then
    return null;
  end if;
  etat := case
    when d.statut = 'accepte'  then 'accepte'
    when d.statut = 'refuse'   then 'refuse'
    when d.statut = 'remplace' then 'remplace'
    when d.date_validite is not null and d.date_validite < aujourdhui then 'expire'
    else 'ouvert' end;
  return jsonb_build_object(
    'numero', d.numero,
    'date_emission', d.date_emission,
    'date_validite', d.date_validite,
    'etat', etat,
    'client_nom', d.client_nom,
    'client_societe', d.client_societe,
    'lignes', coalesce((select jsonb_agg(jsonb_build_object(
                 'description', l->>'description',
                 'quantite', l->'quantite',
                 'prix_unitaire', l->'prix_unitaire',
                 'total', l->'total'))
               from jsonb_array_elements(coalesce(d.lignes, '[]'::jsonb)) l), '[]'::jsonb),
    'remise', d.remise,
    'acompte', d.acompte,
    'total', d.total,
    'accepte_en_ligne_le', d.accepte_en_ligne_le,
    'accepte_par_nom', d.accepte_par_nom,
    'refuse_en_ligne_le', d.refuse_en_ligne_le,
    'motif_refus', d.motif_refus,
    'recontact_souhaite', d.recontact_souhaite);
end $$;

create or replace function public.refuser_devis_en_ligne(
  p_jeton uuid, p_motif text, p_commentaire text, p_recontact boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d devis%rowtype;
  v_motif text := nullif(trim(coalesce(p_motif, '')), '');
  v_comm  text := nullif(trim(coalesce(p_commentaire, '')), '');
begin
  if v_motif is null or v_motif not in ('prix','autre_solution','plus_besoin','delai','autre') then
    raise exception 'Choisissez la raison de votre refus.';
  end if;
  if length(coalesce(v_comm, '')) > 1000 then
    raise exception 'Le commentaire est trop long (1000 caractères maximum).';
  end if;
  select * into d from devis
   where jeton_public = p_jeton and emis_le is not null and supprime_le is null
   for update;
  if not found then
    raise exception 'Devis introuvable.';
  end if;
  if d.statut = 'refuse' then
    return public.devis_public(p_jeton);   -- double clic : rien à refaire
  end if;
  if d.statut <> 'envoye' then
    raise exception 'Ce devis ne peut plus être refusé en ligne.';
  end if;
  update devis
     set statut = 'refuse', refuse_en_ligne_le = now(), motif_refus = v_motif,
         commentaire_refus = v_comm,
         recontact_souhaite = (v_motif = 'prix' and coalesce(p_recontact, false)),
         updated_at = now()
   where id = d.id;
  return public.devis_public(p_jeton);
end $$;

revoke all on function public.refuser_devis_en_ligne(uuid, text, text, boolean) from public;
grant execute on function public.refuser_devis_en_ligne(uuid, text, text, boolean) to anon, authenticated;

commit;
