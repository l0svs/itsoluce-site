-- ═══════════════════════════════════════════════════════════════════
-- Recontrôle sécurité — novembre 2026
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ─── 1. Synchronisation Foneday : jeton obligatoire ───────────────
-- La fonction sync-foneday n'avait aucun contrôle d'accès (verify_jwt
-- désactivé pour que la tâche planifiée puisse l'appeler) : n'importe qui
-- pouvait déclencher une synchro complète et lire des prix d'achat dans la
-- réponse. Même mécanisme que la synchronisation des mails : un jeton
-- aléatoire en base, envoyé par la tâche planifiée, vérifié par la fonction.
create table if not exists public.sync_jeton (
  id    integer primary key default 1 check (id = 1),
  jeton text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
);
insert into public.sync_jeton (id) values (1) on conflict (id) do nothing;
alter table public.sync_jeton enable row level security;
revoke all on public.sync_jeton from anon, authenticated;

-- La tâche de 04:00 envoie désormais le jeton. Sans danger avant le
-- déploiement de la nouvelle fonction : l'ancienne ignore cet en-tête.
select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'sync-foneday-quotidien'),
  command := $cmd$
  select net.http_post(
    url := 'https://esltsiutcjcwdbhkkvms.supabase.co/functions/v1/sync-foneday',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-jeton', (select jeton from public.sync_jeton where id = 1)
    ),
    timeout_milliseconds := 150000
  ) as request_id;
  $cmd$
);

-- ─── 2. Formulaire public : tailles et fréquence ──────────────────
-- Appelable sans connexion (c'est voulu) mais sans aucune limite : un robot
-- pouvait remplir la table de textes énormes, à volonté. Le site envoie
-- aussi chaque demande par Formspree : un refus ici ne bloque pas un vrai
-- visiteur.
create or replace function public.submit_demande_formulaire(
  p_prenom text, p_nom text, p_email text, p_telephone text,
  p_appareil text, p_mode_intervention text, p_adresse text, p_description text)
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
begin
  if v_prenom is null or v_nom is null or v_email is null
     or v_appareil is null or v_description is null then
    raise exception 'Champs obligatoires manquants.';
  end if;
  if length(v_prenom) > 80 or length(v_nom) > 80 or length(v_email) > 200
     or length(coalesce(v_telephone, '')) > 40 or length(v_appareil) > 150
     or length(coalesce(v_mode, '')) > 40 or length(coalesce(v_adresse, '')) > 300
     or length(v_description) > 4000 then
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
    prenom, nom, email, telephone, appareil, mode_intervention, adresse, description
  ) values (
    v_prenom, v_nom, v_email, v_telephone, v_appareil, v_mode, v_adresse, v_description
  )
  returning id into v_id;
  return v_id;
end;
$function$;

-- ─── 3. Fonctions internes non appelables de l'extérieur ──────────
-- Signalé par l'analyseur Supabase : fonctions « security definer »
-- exécutables par un visiteur non connecté. Les fonctions de déclencheur
-- n'ont pas besoin de ce droit pour fonctionner (il n'est vérifié qu'à la
-- création du déclencheur) ; les fonctions de corbeille ne servent qu'au
-- propriétaire connecté.
revoke execute on function public.tracer()              from public, anon, authenticated;
revoke execute on function public.mettre_en_corbeille() from public, anon, authenticated;
revoke execute on function public.factures_regles()     from public, anon, authenticated;
revoke execute on function public.devis_regles()        from public, anon, authenticated;
revoke execute on function public.corbeille_lister()            from public, anon;
revoke execute on function public.corbeille_purger(integer)     from public, anon;
revoke execute on function public.corbeille_restaurer(text, text) from public, anon;
-- Le propriétaire connecté garde l'accès à la corbeille (les fonctions
-- vérifient elles-mêmes qu'il s'agit bien du propriétaire).
grant execute on function public.corbeille_lister()              to authenticated;
grant execute on function public.corbeille_purger(integer)       to authenticated;
grant execute on function public.corbeille_restaurer(text, text) to authenticated;

commit;
