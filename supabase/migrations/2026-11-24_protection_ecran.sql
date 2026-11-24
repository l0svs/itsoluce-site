-- « Protection hydrogel » devient « protection d'écran », plus parlant pour le client.
-- Seuls les textes visibles changent : les noms techniques (hydrogels, hydrogels_total…)
-- restent, et les factures déjà émises ne sont pas modifiées.

update public.pack_formules
   set libelle = replace(replace(libelle, 'protections hydrogel', 'protections d''écran'), 'protection hydrogel', 'protection d''écran'),
       resume  = replace(replace(resume,  'protections hydrogel', 'protections d''écran'), 'protection hydrogel', 'protection d''écran')
 where libelle ilike '%hydrogel%' or resume ilike '%hydrogel%';

-- Messages des fonctions : même définition, seul le texte change.
do $$
declare f regprocedure; def text;
begin
  foreach f in array array['public.noter_intervention_pack(bigint,text,date,text,text,integer,numeric,integer,boolean,boolean,text,bigint)'::regprocedure,
                           'public.retracter_pack(bigint)'::regprocedure] loop
    def := pg_get_functiondef(f);
    def := replace(def, 'protections hydrogel', 'protections d''''écran');
    def := replace(def, 'protection(s) hydrogel', 'protection(s) d''''écran');
    execute def;
  end loop;
end $$;
