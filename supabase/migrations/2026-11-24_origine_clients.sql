-- Business plan : « Comment m'avez-vous connu ? »
-- La réponse est donnée sur le formulaire du site (demandes_formulaire.origine)
-- ou saisie dans la fiche client (clients.origine). Une fiche client créée à
-- partir d'une demande, quel que soit l'écran (Demandes, Devis, Réparations),
-- reprend la réponse de la dernière demande envoyée avec la même adresse e-mail.

alter table public.clients add column if not exists origine text;
alter table public.demandes_formulaire add column if not exists origine text;

-- Nouvelle version : un 9e paramètre facultatif. L'ancienne est supprimée pour
-- éviter deux fonctions du même nom (appel ambigu) ; un appel sans p_origine
-- fonctionne toujours.
drop function if exists public.submit_demande_formulaire(text, text, text, text, text, text, text, text);
create or replace function public.submit_demande_formulaire(
  p_prenom text, p_nom text, p_email text, p_telephone text,
  p_appareil text, p_mode_intervention text, p_adresse text, p_description text,
  p_origine text default null)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id bigint;
  v_prenom text := nullif(trim(coalesce(p_prenom, '')), '');
  v_nom text := nullif(trim(coalesce(p_nom, '')), '');
  v_email text := lower(nullif(trim(coalesce(p_email, '')), ''));
  v_telephone text := nullif(trim(coalesce(p_telephone, '')), '');
  v_appareil text := nullif(trim(coalesce(p_appareil, '')), '');
  v_mode text := nullif(trim(coalesce(p_mode_intervention, '')), '');
  v_adresse text := nullif(trim(coalesce(p_adresse, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_origine text := nullif(trim(coalesce(p_origine, '')), '');
begin
  if v_prenom is null or v_nom is null or v_email is null
     or v_appareil is null or v_description is null then
    raise exception 'Champs obligatoires manquants.';
  end if;
  if length(v_prenom) > 80 or length(v_nom) > 80 or length(v_email) > 200
     or length(coalesce(v_telephone, '')) > 40 or length(v_appareil) > 150
     or length(coalesce(v_mode, '')) > 40 or length(coalesce(v_adresse, '')) > 300
     or length(v_description) > 4000 or length(coalesce(v_origine, '')) > 60 then
    raise exception 'Un champ dépasse la longueur autorisée.';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'Adresse e-mail invalide.';
  end if;
  -- Fréquence : 3 demandes par heure pour une même adresse, 20 par heure en tout.
  if (select count(*) from public.demandes_formulaire
       where lower(email) = v_email and created_at > now() - interval '1 hour') >= 3
  or (select count(*) from public.demandes_formulaire
       where created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Trop de demandes envoyées, merci de réessayer plus tard.';
  end if;

  insert into public.demandes_formulaire (
    prenom, nom, email, telephone, appareil, mode_intervention, adresse, description, origine
  ) values (
    v_prenom, v_nom, v_email, v_telephone, v_appareil, v_mode, v_adresse, v_description, v_origine
  )
  returning id into v_id;

  -- Client déjà connu sans réponse : on la complète.
  if v_origine is not null then
    update public.clients set origine = v_origine
     where lower(email) = v_email and origine is null and supprime_le is null;
  end if;
  return v_id;
end;
$function$;
revoke execute on function public.submit_demande_formulaire(text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.submit_demande_formulaire(text, text, text, text, text, text, text, text, text) to anon, authenticated;

-- Fiche client créée sans réponse : reprise de la dernière demande du même e-mail.
create or replace function public.trg_client_origine()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.origine is null and new.email is not null then
    select d.origine into new.origine from demandes_formulaire d
     where lower(d.email) = lower(new.email) and d.origine is not null
     order by d.created_at desc limit 1;
  end if;
  return new;
end $$;
drop trigger if exists b_client_origine on public.clients;
create trigger b_client_origine before insert on public.clients
  for each row execute function public.trg_client_origine();
