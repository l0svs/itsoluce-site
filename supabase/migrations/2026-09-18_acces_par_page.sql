-- ═══════════════════════════════════════════════════════════
--  IT Soluce — Comptes utilisateurs et cloisonnement des données
--  Appliqué le 18 septembre 2026.
--
--  Ce fichier est la trace de ce qui tourne en base. Il n'est pas rejoué
--  automatiquement : le dépôt ne porte pas d'outil de migration. Il existe
--  pour qu'on sache, plus tard, pourquoi les politiques sont ce qu'elles
--  sont — et pour pouvoir les reconstruire si besoin.
-- ═══════════════════════════════════════════════════════════

-- ── 1. Les comptes et leurs pages ──────────────────────────
create table if not exists public.profils (
  id         uuid primary key references auth.users(id) on delete cascade,
  nom        text not null default '',
  email      text not null default '',
  role       text not null default 'equipe' check (role in ('proprietaire','equipe')),
  pages      text[] not null default '{}',
  actif      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profils enable row level security;

-- Une politique qui lirait « profils » pour décider de l'accès à « profils »
-- boucle à l'infini. Ces fonctions contournent RLS pour trancher.
create or replace function public.est_proprietaire()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profils
                 where id = auth.uid() and role = 'proprietaire' and actif);
$$;

create or replace function public.compte_actif()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profils where id = auth.uid() and actif);
$$;

-- Vrai si le compte est propriétaire, ou s'il détient une des pages citées.
create or replace function public.a_acces(requises text[])
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profils
    where id = auth.uid() and actif
      and (role = 'proprietaire' or pages && requises)
  );
$$;

drop policy if exists profils_lire_soi  on public.profils;
drop policy if exists profils_lire_tous on public.profils;
create policy profils_lire_soi  on public.profils for select to authenticated using (id = auth.uid());
create policy profils_lire_tous on public.profils for select to authenticated using (public.est_proprietaire());
-- Aucune politique d'écriture : créer ou modifier un compte passe uniquement
-- par la fonction edge gestion-utilisateurs, qui revérifie le rôle et agit
-- avec la clé de service. Un utilisateur ne peut pas s'accorder des pages.

-- ── 2. L'accès aux données suit les pages ──────────────────
--
--  Jusqu'ici chaque politique disait « true » : tout compte connecté lisait
--  et écrivait tout. Masquer une page dans l'interface ne changeait rien à
--  ce qu'un compte pouvait demander à l'API.
--
--  La correspondance n'est pas « une table par page » : la page Devis lit
--  les clients, le Dashboard lit les factures. Elle est relevée dans le code
--  des pages, pas devinée.
--
--  ┌─────────────────────┬──────────────────────────────────────────────────┐
--  │ table               │ lecture accordée par                             │
--  ├─────────────────────┼──────────────────────────────────────────────────┤
--  │ clients             │ clients demandes devis factures planning repar.   │
--  │ compteurs           │ clients demandes devis factures reparations       │
--  │ demandes_formulaire │ demandes dashboard                               │
--  │ devis               │ clients devis factures                            │
--  │ factures            │ clients devis factures gestion reparations        │
--  │ reparations         │ + gestion planning dashboard                      │
--  │ rendezvous          │ planning dashboard                                │
--  │ stock               │ devis factures reparations stock dashboard        │
--  │ services            │ devis factures gestion reparations                │
--  │ fournisseurs        │ gestion stock                                     │
--  │ charges, depenses   │ gestion                                           │
--  │ foneday_*           │ catalogue                                         │
--  │ mouvements, pockets │ propriétaire seul — aucune page ne s'en sert      │
--  │ publications, taches│ idem                                              │
--  │ settings            │ tout compte actif — sauf finance_grille, réservée  │
--  │                     │ à gestion catalogue stock (coefficients de marge)  │
--  └─────────────────────┴──────────────────────────────────────────────────┘
--
--  L'écriture est plus étroite que la lecture : la page Devis lit les clients
--  et les modifie, mais ne touche pas aux rendez-vous.

do $$
declare m record; p record;
begin
  for m in
    select * from (values
      ('clients',             array['clients','demandes','devis','factures','planning','reparations'],                       array['clients','demandes','devis','factures','reparations']),
      ('compteurs',           array['clients','demandes','devis','factures','reparations'],                                  array['clients','demandes','devis','factures','reparations']),
      ('demandes_formulaire', array['demandes','dashboard'],                                                                 array['demandes']),
      -- Le Dashboard ne figure pas dans ces quatre listes : sa vue financière
      -- suit la page Factures. Un compte à qui on donne Dashboard sans
      -- Factures voit l'activité, pas les montants.
      ('devis',               array['clients','devis','factures'],                                                           array['devis']),
      ('factures',            array['clients','devis','factures','gestion','reparations'],                                   array['devis','factures','reparations']),
      ('reparations',         array['clients','demandes','devis','factures','gestion','planning','reparations','dashboard'], array['demandes','devis','reparations']),
      ('rendezvous',          array['planning','dashboard'],                                                                 array['planning']),
      ('stock',               array['devis','factures','reparations','stock','dashboard'],                                   array['devis','factures','reparations','stock']),
      ('services',            array['devis','factures','gestion','reparations'],                                             array['gestion']),
      ('fournisseurs',        array['gestion','stock'],                                                                      array['gestion']),
      ('charges',             array['gestion'],                                                                              array['gestion']),
      ('depenses',            array['gestion'],                                                                              array['gestion']),
      ('foneday_produits',    array['catalogue'],                                                                            array[]::text[]),
      ('foneday_historique',  array['catalogue'],                                                                            array[]::text[]),
      -- Un tableau vide ne recoupe aucune page : seul le propriétaire passe.
      ('mouvements',          array[]::text[], array[]::text[]),
      ('pockets',             array[]::text[], array[]::text[]),
      ('publications',        array[]::text[], array[]::text[]),
      ('taches',              array[]::text[], array[]::text[])
    ) as t(tbl, lire, ecrire)
  loop
    -- Les politiques « anon » sont épargnées : la lecture publique des
    -- prestations par le site vitrine doit survivre.
    for p in select policyname from pg_policies
             where schemaname='public' and tablename=m.tbl and 'authenticated'=any(roles)
    loop execute format('drop policy %I on public.%I', p.policyname, m.tbl); end loop;

    execute format('create policy %I on public.%I for select to authenticated using (public.a_acces(%L))',
                   m.tbl||'_lire', m.tbl, m.lire);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.a_acces(%L))',
                   m.tbl||'_creer', m.tbl, m.ecrire);
    execute format('create policy %I on public.%I for update to authenticated using (public.a_acces(%L)) with check (public.a_acces(%L))',
                   m.tbl||'_modifier', m.tbl, m.ecrire, m.ecrire);
    execute format('create policy %I on public.%I for delete to authenticated using (public.a_acces(%L))',
                   m.tbl||'_supprimer', m.tbl, m.ecrire);
  end loop;
end $$;

-- Les coordonnées, le logo et la mention TVA sont lus par presque toutes les
-- pages, y compris pour composer un e-mail. Les réserver à quelques pages
-- casserait l'affichage ailleurs sans rien protéger. La modification reste
-- à Gestion.
-- Une seule clé de settings n'est pas anodine : « finance_grille » porte les
-- coefficients de marge, la formule qui transforme un prix de pièce en prix
-- de vente. Elle n'est lue que par les trois pages qui calculent un prix.
-- Le filtrage se fait à la ligne, puisqu'ici une ligne est un réglage.
drop policy if exists settings_lire on public.settings;
create policy settings_lire on public.settings
  for select to authenticated
  using (
    case
      when cle = 'finance_grille' then public.a_acces(array['gestion','catalogue','stock'])
      else public.compte_actif()
    end
  );
create policy settings_creer     on public.settings for insert to authenticated with check (public.a_acces(array['gestion']));
create policy settings_modifier  on public.settings for update to authenticated using (public.a_acces(array['gestion'])) with check (public.a_acces(array['gestion']));
create policy settings_supprimer on public.settings for delete to authenticated using (public.a_acces(array['gestion']));

-- ── 3. Prestations publiées sur le site vitrine ────────────
alter table public.services add column if not exists vitrine boolean not null default false;
drop policy if exists services_vitrine_lecture_publique on public.services;
create policy services_vitrine_lecture_publique on public.services
  for select to anon using (vitrine = true and actif = true);
-- Une politique filtre les lignes, pas les colonnes : le droit de lecture est
-- restreint aux seules colonnes que le site affiche.
grant select (id, nom, prix, prix_max, unite, ordre) on public.services to anon;

-- ═══════════════════════════════════════════════════════════
--  Suite — journal, garde-fous, corbeille (18 septembre 2026)
--
--  Tout est posé par des déclencheurs : les pages n'ont rien à changer.
--  Une suppression lancée depuis n'importe quelle page devient une mise en
--  corbeille, et la ligne sort des résultats sans qu'aucune requête n'ait
--  été retouchée — la politique de lecture exclut supprime_le non nul.
--
--  Deux drapeaux sur profils remplacent une matrice de droits :
--    lecture_seule   → consulte sans modifier
--    peut_supprimer  → autorise la mise en corbeille
--  Ni l'un ni l'autre ne s'applique au propriétaire.
--
--  Le journal enregistre création, modification, suppression et
--  restauration, avec l'auteur et l'état avant/après. Il est lisible par le
--  propriétaire seul et n'a aucune politique d'écriture : un journal que son
--  sujet peut effacer ne vaut rien.
--
--  Fonctions utilitaires, réservées au propriétaire :
--    corbeille_lister()                  → ce qui est récupérable
--    corbeille_restaurer(table, id)      → remet une ligne en service
--    corbeille_purger(jours default 30)  → supprime pour de bon
--
--  La purge est programmée : pg_cron lance corbeille_purge_planifiee(30)
--  chaque nuit à 03h17 UTC. Cette variante existe parce que la purge
--  manuelle exige d'être propriétaire — auth.uid() doit désigner un compte —
--  alors qu'une tâche planifiée n'a aucune session et échouerait sur ce
--  contrôle. Son droit d'exécution est retiré à anon et authenticated : un
--  navigateur ne peut pas court-circuiter le contrôle de rôle par cette
--  porte. Une purge non vide laisse une trace au journal.
--
--  Le journal est lisible par TOUT compte propriétaire, pas par le seul
--  créateur de l'ERP — la politique s'appuie sur est_proprietaire().
--
--  Le SQL complet appliqué se trouve dans l'historique des migrations
--  Supabase sous le nom « journal_drapeaux_corbeille ».
-- ═══════════════════════════════════════════════════════════
