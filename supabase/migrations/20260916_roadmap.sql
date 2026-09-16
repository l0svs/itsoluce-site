-- ════════════════════════════════════════════════════════════════════
--  Roadmap IT Soluce — tables utilisées par /admin/roadmap.html
--  À exécuter une seule fois dans Supabase > SQL Editor.
-- ════════════════════════════════════════════════════════════════════

-- ── Phases (Phase 1, Q4 2026, Lancement…) ───────────────────────────
create table if not exists public.roadmap_phases (
  id         bigint generated always as identity primary key,
  titre      text        not null,
  periode    text,                       -- badge affiché : « Q4 2026 », « octobre 2026 »
  objectif   text,
  ordre      integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Actions rattachées à une phase ──────────────────────────────────
create table if not exists public.roadmap_items (
  id         bigint generated always as identity primary key,
  phase_id   bigint references public.roadmap_phases(id) on delete cascade,
  titre      text        not null,
  detail     text,
  statut     text        not null default 'todo'
             check (statut in ('todo','en_cours','bloque','fait')),
  priorite   text        not null default 'normale'
             check (priorite in ('haute','normale','basse')),
  categorie  text,
  echeance   date,
  ordre      integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists roadmap_items_phase_idx    on public.roadmap_items (phase_id, ordre);
create index if not exists roadmap_items_echeance_idx on public.roadmap_items (echeance);

-- ── RLS : même règle que le reste de l'ERP (accès réservé aux comptes
--    authentifiés, aucun accès anonyme) ─────────────────────────────
alter table public.roadmap_phases enable row level security;
alter table public.roadmap_items  enable row level security;

drop policy if exists roadmap_phases_all on public.roadmap_phases;
create policy roadmap_phases_all on public.roadmap_phases
  for all to authenticated using (true) with check (true);

drop policy if exists roadmap_items_all on public.roadmap_items;
create policy roadmap_items_all on public.roadmap_items
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.roadmap_phases to authenticated;
grant select, insert, update, delete on public.roadmap_items  to authenticated;
