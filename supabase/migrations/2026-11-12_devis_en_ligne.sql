-- ═══════════════════════════════════════════════════════════════════
-- Acceptation du devis en ligne
--
-- Chaque devis reçoit un lien secret (jeton aléatoire, impossible à
-- deviner). Le mail du devis contient ce lien : le client voit son devis
-- sur itsoluce.be et l'accepte en indiquant son nom. Le devis passe alors
-- en « Accepté » dans l'ERP, avec la date et le nom saisi.
-- Le visiteur ne lit jamais la table : deux fonctions contrôlées
-- renvoient uniquement ce qui est nécessaire, pour ce seul devis.
-- ═══════════════════════════════════════════════════════════════════

begin;

alter table public.devis
  add column if not exists jeton_public       uuid not null default gen_random_uuid(),
  add column if not exists accepte_en_ligne_le timestamptz,
  add column if not exists accepte_par_nom     text,
  -- Mails envoyés après l'acceptation (confirmation client + notification) :
  -- posé une seule fois par la fonction devis-accepte, contre les doubles envois.
  add column if not exists confirmation_envoyee_le timestamptz;

alter table public.devis drop constraint if exists devis_jeton_public_key;
alter table public.devis add constraint devis_jeton_public_key unique (jeton_public);

-- ─── Lecture publique d'un devis par son lien ─────────────────────
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
    'accepte_par_nom', d.accepte_par_nom);
end $$;

-- ─── Acceptation ──────────────────────────────────────────────────
create or replace function public.accepter_devis_en_ligne(p_jeton uuid, p_nom text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d devis%rowtype;
  v_nom text := nullif(trim(coalesce(p_nom, '')), '');
  aujourdhui date := (now() at time zone 'Europe/Brussels')::date;
begin
  if v_nom is null or length(v_nom) < 2 or length(v_nom) > 120 then
    raise exception 'Indiquez votre nom pour accepter le devis.';
  end if;
  select * into d from devis
   where jeton_public = p_jeton and emis_le is not null and supprime_le is null
   for update;
  if not found then
    raise exception 'Devis introuvable.';
  end if;
  if d.statut = 'accepte' then
    return public.devis_public(p_jeton);   -- double clic : rien à refaire
  end if;
  if d.statut <> 'envoye' then
    raise exception 'Ce devis ne peut plus être accepté en ligne.';
  end if;
  if d.date_validite is not null and d.date_validite < aujourdhui then
    raise exception 'Ce devis a expiré le %. Contactez-moi pour un nouveau devis.', to_char(d.date_validite, 'DD/MM/YYYY');
  end if;
  update devis
     set statut = 'accepte', accepte_en_ligne_le = now(), accepte_par_nom = v_nom, updated_at = now()
   where id = d.id;
  return public.devis_public(p_jeton);
end $$;

revoke all on function public.devis_public(uuid) from public;
revoke all on function public.accepter_devis_en_ligne(uuid, text) from public;
grant execute on function public.devis_public(uuid) to anon, authenticated;
grant execute on function public.accepter_devis_en_ligne(uuid, text) to anon, authenticated;

commit;
