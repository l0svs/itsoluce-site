-- Journal des e-mails sortants + limitation de débit.
--
-- Objectif : même si une session de l'ERP était un jour volée, elle ne peut
-- pas servir de canon à spam sous le domaine itsoluce.be. Bénéfice
-- secondaire : on dispose enfin d'une trace des envois.

create table if not exists public.email_envois (
  id            bigint generated always as identity primary key,
  user_id       uuid        not null,
  destinataire  text        not null,
  fonction      text        not null,
  created_at    timestamptz not null default now()
);

comment on table public.email_envois is
  'Journal des e-mails sortants. Alimente la limitation de débit des Edge Functions send-invoice et send-reminder.';

create index if not exists idx_email_envois_user_recent
  on public.email_envois (user_id, created_at desc);

-- RLS activé SANS aucune politique : la table est donc invisible et
-- inaccessible pour anon comme pour authenticated. Seul service_role
-- (qui contourne le RLS), utilisé par les Edge Functions, y accède.
alter table public.email_envois enable row level security;

-- Vérifie le quota horaire et enregistre l'envoi. Renvoie false si le
-- quota est dépassé, auquel cas rien n'est inséré.
create or replace function public.enregistrer_envoi_email(
  p_user_id      uuid,
  p_destinataire text,
  p_fonction     text,
  p_limite       integer default 60
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.email_envois
  where user_id = p_user_id
    and created_at > now() - interval '1 hour';

  if v_count >= p_limite then
    return false;
  end if;

  insert into public.email_envois (user_id, destinataire, fonction)
  values (p_user_id, p_destinataire, p_fonction);

  return true;
end;
$$;

-- IMPORTANT : une fonction SECURITY DEFINER exécutable par anon est
-- exactement le défaut que signale l'advisor Supabase sur
-- submit_demande_reparation. On ne le reproduit pas ici : seul
-- service_role peut appeler cette fonction.
revoke all on function public.enregistrer_envoi_email(uuid, text, text, integer) from public;
revoke all on function public.enregistrer_envoi_email(uuid, text, text, integer) from anon;
revoke all on function public.enregistrer_envoi_email(uuid, text, text, integer) from authenticated;
grant execute on function public.enregistrer_envoi_email(uuid, text, text, integer) to service_role;
