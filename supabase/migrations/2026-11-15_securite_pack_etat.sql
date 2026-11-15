-- Audit 15/11/2026 : pack_etat n'est appelée que par d'autres fonctions (espace_donnees).
-- Un compte connecté ne doit pas pouvoir l'appeler directement (nombre d'interventions d'un autre pack).
revoke execute on function public.pack_etat(public.packs) from public, anon, authenticated;
