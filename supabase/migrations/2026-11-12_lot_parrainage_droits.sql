-- ═══════════════════════════════════════════════════════════════════
-- Lot parrainage : droits (correctif de l'audit Supabase)
-- Rien n'est appelable sans connexion, et les fonctions internes
-- (utilisées par les déclencheurs) ne sont pas exposées.
-- ═══════════════════════════════════════════════════════════════════
begin;

revoke execute on function public.parrainage_solde(bigint) from public, anon;
grant execute on function public.parrainage_solde(bigint) to authenticated;
revoke execute on function public.parrainage_reglage(text, numeric) from public, anon, authenticated;
alter function public.remise_filleul_total(public.factures) set search_path = public;
revoke execute on function public.remise_filleul_total(public.factures) from public, anon, authenticated;

commit;
