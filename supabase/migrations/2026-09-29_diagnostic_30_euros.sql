-- Diagnostic facturé 30 € (le devis reste gratuit). Quand la réparation est
-- ensuite confiée, la prestation « Diagnostic déjà réalisé (déduit) » à −30 €
-- est ajoutée au devis et à la facture. Aucune des deux n'est affichée dans la
-- carte « Service supplémentaire » du site : le diagnostic figure déjà dans
-- les quatre cartes de tarifs.
update public.services set nom = 'Diagnostic', prix = 30, prix_max = null where id = 9;
update public.services set ordre = 11 where id = 5;
insert into public.services (nom, prix, prix_max, actif, vitrine, ordre)
values ('Diagnostic déjà réalisé (déduit)', -30, null, true, false, 10);
