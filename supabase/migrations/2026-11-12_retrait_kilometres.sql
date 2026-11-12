-- ═══════════════════════════════════════════════════════════════════
-- Retrait du suivi des kilomètres de déplacement (Planning).
-- À appliquer APRÈS la mise en ligne du Planning sans kilomètres.
-- ═══════════════════════════════════════════════════════════════════
begin;
alter table public.rendezvous drop column if exists km;
commit;
