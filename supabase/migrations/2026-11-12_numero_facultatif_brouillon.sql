-- Un brouillon n'a pas de numéro : la colonne doit pouvoir être vide.
-- (À appliquer après 2026-11-12_numerotation_legale.sql : en production,
-- numero était NOT NULL et bloquait la création des brouillons.)
-- L'unicité (factures_numero_key / devis_numero_key) reste en place pour tous
-- les numéros attribués ; un document émis a toujours un numéro.
alter table public.factures alter column numero drop not null;
alter table public.devis    alter column numero drop not null;
alter table public.factures drop constraint if exists factures_numero_si_emise;
alter table public.factures add constraint factures_numero_si_emise
  check (emise_le is null or numero is not null);
alter table public.devis drop constraint if exists devis_numero_si_emis;
alter table public.devis add constraint devis_numero_si_emis
  check (emis_le is null or numero is not null);
