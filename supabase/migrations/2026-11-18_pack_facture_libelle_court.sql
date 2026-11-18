-- Facture d'un pack : une seule ligne courte, « Pack Sérénité Famille — Assistance
-- et conseil informatique », au lieu du détail complet de la formule.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.pack_creer_interne'::regproc);
  n := regexp_replace(d, 'libelle := f\.nom \|\| '' — '' \|\| coalesce\(.*?mois à compter du paiement\.'';',
                      'libelle := ''Pack '' || f.nom || '' — Assistance et conseil informatique'';');
  if n = d then raise exception 'Libellé du pack introuvable : rien modifié.'; end if;
  execute n;
end $$;
