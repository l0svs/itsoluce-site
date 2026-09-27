-- Frais de livraison par fournisseur (€ par commande).
-- Lus par Stock (fournisseur de la pièce) et Catalogue (fiche « Foneday »)
-- pour calculer le prix de vente conseillé. Vide = pas de frais.
alter table public.fournisseurs
  add column if not exists frais_livraison numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fournisseurs_frais_livraison_positif') then
    alter table public.fournisseurs
      add constraint fournisseurs_frais_livraison_positif
      check (frais_livraison is null or frais_livraison >= 0);
  end if;
end $$;
