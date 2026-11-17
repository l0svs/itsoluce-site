-- Commande d'un pack en ligne : Particulier ou Entreprise.
--  Particulier : prénom + nom obligatoires, adresse facultative.
--  Entreprise  : société + adresse obligatoires (n° de TVA contrôlé par la fonction « pack »),
--                personne de contact facultative ; la facture est au nom de l'entreprise.
alter table public.pack_commandes drop constraint if exists pack_commandes_adresse_check;
alter table public.pack_commandes drop constraint if exists pack_commandes_prenom_check;
alter table public.pack_commandes drop constraint if exists pack_commandes_nom_check;
alter table public.pack_commandes add constraint pack_commandes_adresse_check
  check (length(trim(adresse)) <= 200 and (societe is null or length(trim(adresse)) >= 8));
alter table public.pack_commandes add constraint pack_commandes_prenom_check
  check (length(trim(prenom)) <= 60 and (societe is not null or length(trim(prenom)) >= 1));
alter table public.pack_commandes add constraint pack_commandes_nom_check
  check (length(trim(nom)) <= 60 and (societe is not null or length(trim(nom)) >= 1));

create or replace function public.finaliser_commande_pack(p_commande uuid, p_payment text, p_montant numeric)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare cmd pack_commandes; cid bigint; r jsonb; v_nom text; v_soc text; v_tva text;
begin
  select * into cmd from pack_commandes where id = p_commande for update;
  if not found then raise exception 'Commande introuvable.'; end if;
  if cmd.statut = 'payee' then
    return jsonb_build_object('deja', true, 'pack_id', cmd.pack_id,
      'client_id', (select client_id from packs where id = cmd.pack_id));
  end if;
  if cmd.mollie_payment_id is distinct from p_payment then raise exception 'Paiement inattendu pour cette commande.'; end if;
  if round(p_montant, 2) <> round(cmd.montant, 2) then raise exception 'Montant payé différent du prix du pack.'; end if;

  v_soc := nullif(trim(coalesce(cmd.societe, '')), '');
  v_tva := nullif(trim(coalesce(cmd.tva, '')), '');
  -- Sans personne de contact, le client porte le nom de l'entreprise.
  v_nom := coalesce(nullif(trim(trim(cmd.prenom) || ' ' || trim(cmd.nom)), ''), v_soc);
  select c.id into cid from clients c
   where lower(trim(c.email)) = lower(trim(cmd.email)) and c.supprime_le is null
   order by c.id limit 1;
  if cid is null then
    insert into clients (nom, email, telephone, adresse, type, societe, tva)
    values (v_nom, lower(trim(cmd.email)), trim(cmd.telephone), nullif(trim(cmd.adresse), ''),
            case when v_soc is not null then 'entreprise' else 'particulier' end, v_soc, v_tva)
    returning id into cid;
  else
    update clients c set telephone = coalesce(nullif(trim(c.telephone),''), trim(cmd.telephone)),
                         adresse   = coalesce(nullif(trim(c.adresse),''), nullif(trim(cmd.adresse), '')),
                         societe   = coalesce(nullif(trim(c.societe),''), v_soc),
                         tva       = coalesce(nullif(trim(c.tva),''), v_tva),
                         type      = case when v_soc is not null then 'entreprise' else c.type end,
                         updated_at = now()
     where c.id = cid;
  end if;

  r := pack_creer_interne(cid, cmd.formule, true, 'en_ligne', 'en_ligne', v_nom, cmd.email,
         cmd.telephone, nullif(trim(cmd.adresse), ''), v_soc, v_tva, p_payment,
         case when cmd.consentement then cmd.created_at end);
  update pack_commandes set statut = 'payee', pack_id = (r->>'pack_id')::bigint, traitee_le = now(), erreur = null
   where id = cmd.id;
  return r || jsonb_build_object('client_id', cid);
end $function$;
