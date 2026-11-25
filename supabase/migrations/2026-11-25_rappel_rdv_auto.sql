-- Rappel automatique des rendez-vous, 24 h avant, par e-mail (fonction rappel-rdv).
-- rappel_auto : choisi dans le planning (activé par défaut).
-- Si la date du rendez-vous change, le rappel est réarmé pour la nouvelle date.

alter table public.rendezvous add column if not exists rappel_auto boolean not null default true;

create or replace function public.trg_rdv_rappel_rearme()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.date_debut is distinct from old.date_debut and new.date_debut > now() then
    new.rappel_envoye_le := null;
  end if;
  return new;
end $$;
drop trigger if exists b_rdv_rappel_rearme on public.rendezvous;
create trigger b_rdv_rappel_rearme before update of date_debut on public.rendezvous
  for each row execute function public.trg_rdv_rappel_rearme();

-- Passage toutes les 15 minutes (même jeton que la synchronisation Foneday).
select cron.unschedule('rappel-rdv') where exists (select 1 from cron.job where jobname = 'rappel-rdv');
select cron.schedule('rappel-rdv', '*/15 * * * *', $cron$
  select net.http_post(
    url := 'https://esltsiutcjcwdbhkkvms.supabase.co/functions/v1/rappel-rdv',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-jeton', (select jeton from public.sync_jeton where id = 1)
    ),
    timeout_milliseconds := 60000
  ) as request_id;
$cron$);
