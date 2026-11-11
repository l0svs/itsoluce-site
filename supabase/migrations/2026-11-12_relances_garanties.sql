-- ═══════════════════════════════════════════════════════════════════
-- Relances clients et retours sous garantie
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ─── Relances ─────────────────────────────────────────────────────
-- Historique de chaque relance faite (mail, appel) ou volontairement
-- ignorée. Sert à savoir quel rappel vient ensuite, et à l'afficher dans
-- la fiche client. Pas de modification ni de suppression : c'est un journal.
create table if not exists public.relances (
  id           bigint generated always as identity primary key,
  type         text not null check (type in ('devis','facture','pret','demande','avis')),
  document_id  bigint not null,
  niveau       int  not null default 1 check (niveau between 0 and 9),
  canal        text not null default 'mail' check (canal in ('mail','telephone','ignore')),
  client_id    bigint references public.clients(id) on delete set null,
  destinataire text,
  objet        text,
  fait_le      timestamptz not null default now(),
  fait_par     uuid default auth.uid()
);
create index if not exists relances_document_idx on public.relances (type, document_id);
create index if not exists relances_client_idx   on public.relances (client_id);

alter table public.relances enable row level security;
drop policy if exists relances_lire  on public.relances;
drop policy if exists relances_creer on public.relances;
create policy relances_lire on public.relances for select to authenticated
  using (public.a_acces('{dashboard,devis,factures,reparations,demandes,clients}'));
create policy relances_creer on public.relances for insert to authenticated
  with check (public.peut_ecrire('{dashboard,devis,factures,reparations,demandes,clients}'));

-- ─── Retour sous garantie ─────────────────────────────────────────
-- Un dossier de retour garde le lien vers le dossier d'origine.
alter table public.reparations
  add column if not exists garantie_de_id bigint references public.reparations(id) on delete set null;
create index if not exists reparations_garantie_de_id_idx on public.reparations (garantie_de_id);

commit;
