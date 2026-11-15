-- Paiement Mollie en mode test : le parcours complet est exécuté puis annulé.
-- Aucune facture ni aucun numéro de la série légale n'est consommé.
alter table public.pack_commandes drop constraint if exists pack_commandes_statut_check;
alter table public.pack_commandes add constraint pack_commandes_statut_check check (statut in ('cree','payee','echouee','test_ok'));

create or replace function public.simuler_commande_pack(p_commande uuid, p_payment text, p_montant numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  begin
    r := finaliser_commande_pack(p_commande, p_payment, p_montant);
    r := r || jsonb_build_object('pack', (select to_jsonb(p) from packs p where p.id = (r->>'pack_id')::bigint),
                                 'facture', (select to_jsonb(f) from factures f where f.id = (r->>'facture_id')::bigint),
                                 'facture_statut', (select statut from factures where id = (r->>'facture_id')::bigint));
    raise exception using errcode = 'P0099', message = r::text;
  exception when sqlstate 'P0099' then
    r := sqlerrm::jsonb;
  end;
  update pack_commandes set statut = 'test_ok', traitee_le = now(),
         erreur = left('Simulation (paiement de test) : ' || (r - 'facture' - 'pack')::text, 2000)
   where id = p_commande and statut = 'cree';
  return r;
end $$;
revoke execute on function public.simuler_commande_pack(uuid,text,numeric) from public, anon, authenticated;
