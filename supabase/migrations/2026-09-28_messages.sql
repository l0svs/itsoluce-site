-- Page Messages : copie de la boîte contact@itsoluce.be (OVH Zimbra) dans
-- l'ERP. La boîte OVH reste la référence : cette table est remplie et vidée
-- uniquement par la fonction edge « mail » (clé de service). Les comptes de
-- l'ERP la lisent, mais ne peuvent ni y écrire ni en effacer une ligne :
-- marquer lu, déplacer ou supprimer passe par la fonction, qui fait le même
-- geste dans la boîte OVH.

create table public.mails (
  id           bigint generated always as identity primary key,
  dossier      text not null,              -- INBOX, Sent, Junk, Trash (noms OVH)
  uid          bigint not null,            -- numéro du mail dans son dossier OVH
  uidvalidity  bigint not null,
  message_id   text,
  in_reply_to  text,
  refs         text,
  fil          text not null,              -- clé de conversation
  de_email     text,
  de_nom       text,
  repondre_a   text,
  a            jsonb not null default '[]',
  cc           jsonb not null default '[]',
  objet        text not null default '',
  date_mail    timestamptz,
  extrait      text not null default '',
  texte        text not null default '',
  html         text,
  pieces       jsonb not null default '[]', -- noms et tailles ; le contenu reste chez OVH
  taille       integer not null default 0,
  partiel      boolean not null default false,
  lu           boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (dossier, uidvalidity, uid)
);
create index mails_dossier_date on public.mails (dossier, date_mail desc);
create index mails_fil on public.mails (fil);
create index mails_de_email on public.mails (de_email);

alter table public.mails enable row level security;
create policy mails_lire on public.mails for select to authenticated
  using (public.a_acces(array['messages']));

-- Brouillons rédigés dans l'ERP (ils ne remontent pas dans la boîte OVH).
create table public.mail_brouillons (
  id            bigint generated always as identity primary key,
  a             text not null default '',
  cc            text not null default '',
  objet         text not null default '',
  corps         text not null default '',
  repondre_a_id bigint,
  transfert_de_id bigint,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.mail_brouillons enable row level security;
create policy mail_brouillons_lire on public.mail_brouillons for select to authenticated
  using (public.a_acces(array['messages']));
create policy mail_brouillons_creer on public.mail_brouillons for insert to authenticated
  with check (public.peut_ecrire(array['messages']));
create policy mail_brouillons_modifier on public.mail_brouillons for update to authenticated
  using (public.peut_ecrire(array['messages'])) with check (public.peut_ecrire(array['messages']));
create policy mail_brouillons_supprimer on public.mail_brouillons for delete to authenticated
  using (public.peut_ecrire(array['messages']));

-- État de la dernière synchronisation, affiché dans Messages et dans Gestion.
-- Table à part (et non « settings ») : settings est journalisée, et une ligne
-- de journal toutes les 5 minutes noierait le reste.
create table public.mail_etat (
  id               integer primary key default 1 check (id = 1),
  derniere_synchro timestamptz,
  ok               boolean,
  message          text,
  nouveaux         integer
);
insert into public.mail_etat (id) values (1);
alter table public.mail_etat enable row level security;
create policy mail_etat_lire on public.mail_etat for select to authenticated
  using (public.a_acces(array['messages','gestion']));

-- Jeton de la tâche planifiée. Aucune politique : aucun compte de l'ERP ne
-- peut le lire ; seules la fonction (clé de service) et pg_cron y accèdent.
create table public.mail_jeton (
  id    integer primary key default 1 check (id = 1),
  jeton text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
);
insert into public.mail_jeton (id) values (1);
alter table public.mail_jeton enable row level security;
revoke all on public.mail_jeton from anon, authenticated;

-- Synchronisation toutes les 5 minutes.
select cron.schedule(
  'mail-synchro',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://esltsiutcjcwdbhkkvms.supabase.co/functions/v1/mail',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mail-jeton', (select jeton from public.mail_jeton where id = 1)
    ),
    body := '{"action":"synchro"}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
