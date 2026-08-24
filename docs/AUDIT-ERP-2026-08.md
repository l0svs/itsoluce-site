# Audit complet — ERP IT Soluce

**Date :** 24 août 2026
**Périmètre :** `admin/*.html` (15 pages), `assets/js/admin-security.js`, `index.html` (formulaire public),
projet Supabase `itsoluce-erp` (schéma, RLS, RPC, Edge Functions, cron), hébergement GitHub Pages.
**Objectif de l'audit :** vérifier que l'ERP tient la route pour un passage en indépendant à 100 %
(gros volume de clients) et qu'il est sécurisé.
**Nature :** audit en lecture seule. Aucun fichier applicatif, aucune donnée, aucun paramètre n'a été modifié.

---

## 0. Synthèse

L'ERP est **fonctionnel et bien pensé sur le plan métier** : le parcours diagnostic → devis → réparation →
facture → garantie est cohérent, l'échappement HTML a été traité sérieusement (`admin-security.js`),
le RLS est activé sur les 19 tables, le token Foneday ne fuite pas côté navigateur, et aucune clé
`service_role` n'est présente dans le dépôt ni dans l'historique Git. C'est déjà mieux que beaucoup
d'outils internes.

En revanche, **il n'est pas prêt pour un passage à 100 %**, pour trois raisons de fond :

| Axe | État | Verdict |
|---|---|---|
| Sécurité | 2 failles critiques, 4 majeures | ❌ à corriger avant de monter en volume |
| Intégrité comptable | trous de numérotation déjà présents en production | ❌ risque en cas de contrôle TVA |
| Montée en charge | aucune pagination, aucun index métier | ❌ casse entre 1 000 et 5 000 lignes |
| Exploitation (sauvegarde) | plan Supabase Free, aucune sauvegarde | ❌ risque de perte totale |
| Maintenabilité | ~6 500 lignes de CSS dupliquées sur 15 fichiers | ⚠️ coût d'évolution qui grimpe |

**Les 5 choses à faire en premier**, dans l'ordre :

1. Fermer les Edge Functions `send-invoice`, `send-reminder`, `foneday-proxy` et `sync-foneday` (§2.1, §2.2).
2. Vérifier/désactiver l'inscription publique Supabase (§2.3).
3. Passer en plan Supabase Pro et mettre en place une sauvegarde vérifiée (§5.1).
4. Rendre la numérotation des factures atomique et sans trou (§3.1).
5. Ajouter pagination + index avant que le volume n'arrive (§4.1, §4.2).

Une estimation d'effort figure au §9.

---

## 1. Architecture constatée

```
Navigateur (GitHub Pages, itsoluce.be)
  ├── index.html ──── RPC anon ──────────► submit_demande_reparation()  [SECURITY DEFINER]
  │                └── Formspree
  └── admin/*.html (15 pages autonomes)
        ├── @supabase/supabase-js@2 (esm.sh, CDN)
        ├── jspdf + html2canvas (cdnjs, CDN)
        └── PostgREST + Auth Supabase ──► Postgres 17 (RLS: authenticated → true)
                                       └► Edge Functions: send-invoice, send-reminder,
                                          foneday-proxy, sync-foneday
                                             └► pg_cron 04:00 → sync-foneday
```

**Points structurants :**

- Aucun build, aucun framework, aucun bundler. 15 pages HTML autonomes, chacune ré-embarquant
  son CSS, sa navigation, son système de notifications et son client Supabase.
- Toute la logique métier (prix, TVA, stock, numérotation, garanties) vit **dans le navigateur**.
  Le serveur ne fait qu'appliquer le RLS. Autrement dit : **la base fait confiance au client**.
- 1 315 812 octets / 17 697 lignes pour le dossier `admin/`.
- 1 seul compte utilisateur (`linton@itsoluce.be`), 1 seul environnement (pas de recette/staging).

Cette architecture est parfaitement légitime pour un outil solo à faible volume. Elle devient le
facteur limitant dès qu'on ajoute du volume, un second utilisateur, ou une exigence de conformité.

---

## 2. Sécurité

### 2.1 🔴 CRITIQUE — Les Edge Functions d'envoi d'e-mail sont ouvertes à tout Internet

**Fichiers :** Edge Functions `send-invoice`, `send-reminder` (Supabase).

Les deux fonctions sont déployées avec `verify_jwt: true`. Ce réglage vérifie uniquement que le
`Authorization: Bearer …` contient **un JWT signé par le projet**. Or **la clé anon en est un** — et
elle est publiée en clair dans `admin/login.html`, dans les 14 pages admin et dans `index.html`.

Aucune des deux fonctions ne vérifie le claim `role` du jeton, ni l'origine de l'appel
(`Access-Control-Allow-Origin: *`).

**Conséquence concrète :** n'importe qui, en lisant le code source de votre site, peut envoyer
des e-mails arbitraires **depuis `IT Soluce <contact@itsoluce.be>`**, avec pièce jointe PDF,
vers n'importe quelle adresse, sans limite.

```
POST /functions/v1/send-invoice
Authorization: Bearer <clé anon, publique>
{"to":"victime@x.be","subject":"…","html":"…","pdfBase64":"…"}
```

**Impact :**
- Relais ouvert de spam / phishing sous votre identité et votre domaine.
- Réputation du domaine `itsoluce.be` détruite (SPF/DKIM valides → les mails passent) :
  vos vraies factures finissent en spam pendant des mois.
- Suspension probable du compte Resend, donc plus aucune facture envoyée.
- Responsabilité juridique si le domaine sert à du phishing.

**Correctif recommandé :**
1. Dans chaque fonction, décoder le JWT et **refuser si `role !== 'authenticated'`**
   (idéalement : `createClient(...).auth.getUser(jwt)` et vérifier que l'utilisateur existe).
2. Restreindre le CORS à `https://itsoluce.be` au lieu de `*`.
3. Ne pas accepter `to` librement : vérifier côté serveur que l'adresse correspond bien au
   `client_email` de la facture/du RDV visé, en relisant la ligne en base avec la `service_role`.
4. Ajouter un compteur d'envois par utilisateur et par heure.

### 2.2 🔴 CRITIQUE — `foneday-proxy` expose votre compte fournisseur, `sync-foneday` est totalement ouverte

**Fichiers :** Edge Functions `foneday-proxy`, `sync-foneday`.

`foneday-proxy` souffre exactement du même problème que le §2.1 (`verify_jwt: true` + clé anon
publique + CORS `*`). Les actions exposées sont :

| Action | Ce qu'un tiers peut faire |
|---|---|
| `orders`, `invoices` | Lire **tout votre historique de commandes et vos factures fournisseur** (donc vos prix d'achat réels, vos volumes, votre marge) |
| `invoice-pdf` | Télécharger vos factures fournisseur en PDF |
| `addresses` | Lire vos adresses de livraison |
| `cart-add` / `cart-remove` | **Modifier votre panier Foneday** — ajouter n'importe quelle quantité de n'importe quelle référence |

`sync-foneday` est encore plus exposée : `verify_jwt: false`, donc **aucune authentification du tout**.
Un simple `curl` déclenche le téléchargement des 13 766 produits + 28 upserts par lot. En boucle, cela
brûle votre quota API Foneday, votre quota Edge Functions et votre bande passante Supabase.

Le `verify_jwt: false` s'explique : le job `pg_cron` (04:00, `sync-foneday-quotidien`) appelle la
fonction **sans en-tête d'autorisation**.

**Correctif recommandé :**
- `sync-foneday` : remettre `verify_jwt: true` et faire passer au cron la `service_role` stockée
  dans Supabase Vault ; **ou** garder `verify_jwt: false` mais exiger un en-tête secret partagé
  (`x-sync-secret`) comparé à un `Deno.env.get()`.
- `foneday-proxy` : même correctif d'authentification que §2.1, et **retirer `cart-add` / `cart-remove`
  de la liste blanche** tant que l'authentification n'est pas durcie — c'est la seule action qui
  engage de l'argent.

### 2.3 🔴 À VÉRIFIER EN PRIORITÉ — Inscription publique Supabase

**Non vérifiable depuis cet environnement** (accès réseau sortant vers `*.supabase.co` bloqué par la
politique du bac à sable). **À contrôler manuellement, c'est le point le plus important de l'audit.**

Toutes vos politiques RLS sont de la forme :

```sql
CREATE POLICY auth_select_clients ON clients
  FOR SELECT TO authenticated USING (true);
```

Soit : **tout compte authentifié, quel qu'il soit, lit et écrit 100 % des données** — clients,
factures, chiffre d'affaires, charges, stock, paramètres.

Si l'inscription publique est restée activée (**c'est le réglage par défaut d'un projet Supabase**),
alors n'importe qui peut, avec la clé anon publique :

```
POST /auth/v1/signup  {"email":"…","password":"…"}
```

…obtenir un jeton `authenticated`, et **aspirer ou détruire toute la base**. Vous n'avez qu'un seul
utilisateur (`linton@itsoluce.be`, aucune inscription parasite à ce jour), donc rien ne s'est produit,
mais la porte est peut-être ouverte.

**À faire tout de suite :**
1. Dashboard Supabase → *Authentication* → *Sign In / Providers* → **désactiver « Allow new users to sign up »**.
2. Vérification en ligne de commande :
   ```bash
   curl -s "https://esltsiutcjcwdbhkkvms.supabase.co/auth/v1/settings" -H "apikey: <clé anon>"
   # attendu : "disable_signup": true
   ```
3. Ne pas s'arrêter là : même signup fermé, les politiques `USING (true)` restent une
   protection binaire. Dès que vous ajoutez un employé ou un stagiaire, il aura accès à votre
   compte bancaire, vos marges et vos charges. Voir §2.4.

### 2.4 🟠 MAJEUR — Aucun rôle, aucune séparation des droits

Il n'existe qu'un seul niveau d'accès. Aucune colonne `user_id`, `role` ou `created_by` nulle part,
aucune table `profiles`.

Le jour où vous embauchez, prenez un stagiaire ou déléguez l'atelier, cette personne voit :
votre IBAN, vos charges fixes, votre bénéfice net, vos prix d'achat, votre grille de marge, et
peut supprimer n'importe quelle facture.

**Correctif :** table `profiles(user_id, role)` + politiques RLS conditionnées
(`role = 'admin'` pour `charges`, `settings`, `factures.delete` ; `role = 'technicien'` pour
`reparations`, `stock`, `planning`).

### 2.5 🟠 MAJEUR — Le formulaire public n'a aucune limite

**Fichier :** `index.html:2725` → RPC `public.submit_demande_reparation`.

Le design est bon (RPC `SECURITY DEFINER` plutôt qu'un accès table direct), mais la fonction ne fait
**aucune validation** :

- Aucune limite de longueur : `panne_description` est un `text` illimité. Un appel peut y écrire
  plusieurs mégaoctets. Votre quota base est de 500 Mo (plan Free).
- Aucune limite de débit : un script peut créer 100 000 clients + 100 000 réparations en quelques minutes.
- Aucune validation du format e-mail.
- Le seul rempart est un honeypot (`website`) côté JavaScript — contourné en une ligne par un robot
  qui appelle directement le RPC.

**Conséquence en cascade :** comme le dashboard charge *toutes* les réparations à chaque ouverture
(§4.1), un spam de 50 000 lignes rend l'ERP inutilisable **et** déclenche le rattrapage de numérotation
de `reparations.html:1051`, qui exécute **2 requêtes HTTP séquentielles par ligne sans numéro** — soit
100 000 requêtes à l'ouverture de la page.

**Correctif :**
```sql
-- dans submit_demande_reparation, en tête :
if length(coalesce(p_description,'')) > 2000 then
  raise exception 'Description trop longue';
end if;
-- + table anti-abus : max 3 demandes / heure par email ou par IP
```
Et poser un vrai captcha (Cloudflare Turnstile, gratuit) sur le formulaire.

### 2.6 🟠 MAJEUR — Aucune 2FA, aucune protection contre les mots de passe compromis

- `auth.mfa_factors` est vide : **aucun second facteur**. Un seul mot de passe protège l'intégralité
  de votre entreprise.
- L'advisor Supabase signale : *Leaked Password Protection Disabled* — les mots de passe présents dans
  les fuites connues (HaveIBeenPwned) sont acceptés.
- Aucune journalisation des connexions, aucune alerte sur connexion depuis un nouvel appareil.
- Aucune expiration de session côté ERP : la session Supabase se rafraîchit indéfiniment. Un
  navigateur laissé ouvert sur un poste partagé reste connecté.

**Correctif :** activer la 2FA TOTP sur le compte, activer *Leaked Password Protection*
(Auth → Policies), et ajouter une déconnexion automatique après inactivité côté ERP.

### 2.7 🟡 MOYEN — Chaîne d'approvisionnement des scripts non maîtrisée

**Fichiers :** `devis.html:475-476`, `factures.html:471-472`, `diagnostics.html:475-476`,
et les 15 imports `https://esm.sh/@supabase/supabase-js@2`.

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
```

- **Aucun attribut `integrity` (SRI)** sur les scripts cdnjs.
- L'import `@supabase/supabase-js@2` est une version **flottante** : esm.sh sert la dernière `2.x`,
  qui change sans que vous le sachiez.
- **Aucune Content-Security-Policy** (aucune balise `<meta http-equiv="Content-Security-Policy">`
  dans les 15 pages — GitHub Pages ne permet pas d'en-têtes HTTP, mais la balise meta fonctionne).

Si esm.sh ou cdnjs est compromis, ou si une version 2.x de supabase-js est malveillante, le code
injecté s'exécute avec votre session : lecture de toute la base, exfiltration du jeton stocké en
`localStorage`. C'est le scénario qui contourne tout le reste de vos protections.

**Correctif :** héberger les 3 bibliothèques en local dans `assets/js/` avec une version figée
(ou garder le CDN + `integrity` + `crossorigin`), et ajouter une CSP `<meta>` restrictive.

### 2.8 🟡 MOYEN — `prestations.html` n'a aucun garde d'authentification

**Fichier :** `admin/prestations.html`.

Les 13 autres pages commencent par :
```js
const {data:{session}} = await sb.auth.getSession()
if(!session){ window.location.href='/admin/login.html'; throw new Error('no session') }
```
`prestations.html` **n'a pas ce bloc**. Un visiteur non connecté n'est pas redirigé : il obtient une
page cassée qui échoue silencieusement. Le RLS empêche la fuite de données, donc ce n'est pas une
brèche — mais c'est une incohérence qui trahit l'absence de socle commun (§6.1).

*Note générale :* `getSession()` lit le `localStorage` **sans valider auprès du serveur**.
`getUser()` serait plus correct pour un garde d'accès. Cela reste cosmétique tant que le RLS tient.

### 2.9 🟢 Ce qui est bien fait

- **RLS activé sur les 19 tables** — aucune table publique en écriture directe.
- **Échappement HTML rigoureux** : `escHtml()` et surtout `escJsAttr()` (dans `admin-security.js`)
  traitent correctement le cas piégeux du gestionnaire inline `onclick="f('${…}')"`, où l'échappement
  HTML seul serait insuffisant. Le script est chargé en script classique pour s'exécuter avant les
  modules. C'est du travail sérieux.
- **Aucun secret dans le dépôt** : ni `service_role`, ni `RESEND_API_KEY`, ni `FONEDAY_TOKEN`,
  y compris dans l'historique Git.
- Le `FONEDAY_TOKEN` reste côté serveur (intention correcte du proxy, à sécuriser via §2.2).
- `robots.txt` interdit `/admin/`, et les 15 pages portent `<meta name="robots" content="noindex, nofollow">`.
- Le formulaire public passe par un RPC dédié plutôt que par un accès table direct.

---

## 3. Intégrité des données & comptabilité

### 3.1 🔴 CRITIQUE — La numérotation des factures a déjà des trous en production

**Fichiers :** `factures.html:1072`, `devis.html:1035`, `diagnostics.html:854`, `clients.html:724`,
`reparations.html:1027` et `reparations.html:1162` (6 implémentations de la même fonction).

```js
async function nextNumero(cle, format){
  const {data:cpt} = await sb.from('compteurs').select('valeur').eq('cle',cle).single()
  const nouvelle = (cpt?.valeur||0)+1
  await sb.from('compteurs').update({valeur:nouvelle}).eq('cle',cle)   // ← lecture puis écriture
  …
}
```

Trois défauts cumulés :

**a) Course critique.** Lecture puis écriture non atomiques. Deux onglets, deux appareils, ou deux
clics rapides produisent le **même numéro**. Sur `factures.numero` et `devis.numero` il existe une
contrainte `UNIQUE` → le second enregistrement échoue avec une erreur brute. Sur
`reparations.numero`, `clients.numero` et `diagnostics.numero`, **il n'y a pas de contrainte
unique** → doublons silencieux.

**b) Numéro consommé avant l'insertion.** Le compteur est incrémenté, *puis* l'insertion est tentée.
Coupure réseau, erreur de validation, abandon → le numéro est perdu définitivement.

**État réel de votre base aujourd'hui :**

| Compteur | Valeur | Enregistrements | Numéros perdus |
|---|---|---|---|
| `facture` | 18 | 9 | **9** |
| `devis` | 38 | 13 | **25** |
| `reparation` | 22 | 9 | 13 |
| `client` | 17 | 11 | 6 |

Factures présentes : `2026-0004, 0007, 0008, 0012, 0013, 0014, 0015, 0017, 0018`.
**Manquantes : 0001, 0002, 0003, 0005, 0006, 0009, 0010, 0011, 0016.**

**Pourquoi c'est grave :** en Belgique, la numérotation des factures doit être **séquentielle et
ininterrompue** (art. 5 de l'AR n°1 du Code de la TVA). Une séquence à neuf trous sur neuf factures
est exactement le signal qui déclenche un contrôle approfondi, avec présomption de factures
supprimées. Aujourd'hui le volume est faible et explicable ; à 500 factures/an, c'est ingérable.

**c) Le numéro est attribué à la création du brouillon**, pas à l'émission. La facture `2026-0015`
est en brouillon depuis le 30/07 tout en consommant un numéro.

**Correctif :**
```sql
create or replace function public.next_numero(p_cle text)
returns integer language plpgsql security definer as $$
declare v integer;
begin
  update compteurs set valeur = valeur + 1 where cle = p_cle returning valeur into v;
  return v;   -- atomique : UPDATE … RETURNING sous verrou de ligne
end $$;
```
+ n'attribuer le numéro **qu'au passage en statut `envoyee`/`payee`**, jamais au brouillon
+ ajouter `UNIQUE` sur `reparations.numero`, `clients.numero`, `diagnostics.numero`
+ centraliser : une seule implémentation, pas six.

### 3.2 🔴 CRITIQUE — Une facture émise reste modifiable et n'est jamais archivée

- `deleteFacture()` (`factures.html:1349`) fait un **`DELETE` physique**. Le message de confirmation
  avertit correctement (« en comptabilité, une facture émise ne devrait pas être supprimée mais
  annulée ») — puis supprime quand même la ligne, définitivement, sans trace.
- Une facture au statut `payee` peut être rouverte et modifiée : montants, lignes, client, date.
- **Aucun bucket Supabase Storage n'existe** (`storage.buckets` est vide). Le PDF n'est donc
  **jamais archivé** : il est **régénéré à la volée** depuis les données courantes à chaque ouverture.
  Modifier une facture après envoi change rétroactivement le PDF « original ».
- Aucune notion de **note de crédit** — le seul moyen d'annuler une facture est de la supprimer.
- Aucune piste d'audit : pas de `created_by`, pas de `updated_by`, pas de table d'historique.

**Conséquence :** vous ne pouvez pas prouver ce que le client a réellement reçu. En cas de litige ou
de contrôle, l'ERP ne fait pas foi.

**Correctif :** statut `emise` verrouillant l'enregistrement (déclencheur Postgres refusant l'`UPDATE`
des champs financiers), suppression remplacée par une **note de crédit**, et archivage du PDF dans un
bucket Storage privé au moment de l'émission.

### 3.3 🟠 MAJEUR — Le stock se désynchronise silencieusement

**Fichiers :** `reparations.html:1218-1230`, `factures.html:1330-1340`, `devis.html:1583-1590`.

```js
const newQty = Math.max(0, Number(piece.quantite) - (pd.qte||1))
await sb.from('stock').update({quantite:newQty}).eq('id',piece.id)
```

Quatre problèmes :

1. **Perte de mise à jour.** La nouvelle quantité est calculée à partir du **cache navigateur**
   (`allStockPieces`), puis écrite en **valeur absolue**. Un onglet ouvert depuis une heure écrase
   la quantité réelle. Il faut un décrément atomique côté serveur :
   `update stock set quantite = quantite - $1 where id = $2 and quantite >= $1`.
2. **Échec silencieux.** `if(!piece || Number(piece.quantite)<=0) continue` — si la pièce est
   introuvable dans le cache ou déjà à zéro, le décrément est **sauté sans message**… alors que
   `stock_decremente` a **déjà été mis à `true`** juste avant. Le décrément ne se rattrapera jamais.
3. **Pas de transaction.** `reparations.update()` réussit, puis les `stock.update()` peuvent échouer
   un par un, sans annulation.
4. `Math.max(0, …)` **masque le stock négatif** au lieu de l'alerter — un signal d'inventaire faux
   est plus dangereux qu'une erreur visible.

De plus, **aucun mouvement de stock n'est journalisé**. Impossible de savoir pourquoi une quantité a
bougé, ni de faire un inventaire tournant. Et aucune ré-incrémentation quand une réparation passée
en « prêt » est finalement annulée.

**Risque de double décrément :** `devis.html` convertit un devis en **réparation** *et* en **facture**,
les deux marquant `stock_decremente: true` sur leur propre enregistrement — mais ce sont deux
enregistrements différents. Un devis converti en réparation (dont les pièces seront décrémentées au
passage en « prêt ») puis en facture (qui décrémente aussi ses lignes) sort la pièce **deux fois**.

### 3.4 🟠 MAJEUR — Le fichier client se pollue tout seul

**a) Déduplication par nom.** `factures.html:1275` :
```js
if(!existant) existant = allClients.find(c => c.nom && c.nom.toLowerCase() === nom.toLowerCase())
```
Deux personnes différentes portant le même nom sont **fusionnées en un seul client** — factures,
réparations et historique mélangés. À 50 clients c'est improbable ; à 3 000, « Jean Dupont » arrive
forcément.

**b) Le RPC public ne déduplique que par e-mail.** Un client qui laisse le champ e-mail vide crée un
**nouveau client à chaque demande**.

**c) Numéros de client incohérents — visible dans vos données.** La fonction `nextNumero` de
`factures.html` ne connaît que le format `'facture'` et retombe sur `` `DEV-${…}` `` ; celles de
`devis.html` et `diagnostics.html` retombent sur un numéro **sans préfixe**. Résultat en base :

```
0013, 0015, CLI-0002, CLI-0006, CLI-0008, CLI-0009, CLI-0010,
CLI-0011, CLI-0012, CLI-0014, CLI-0017
```

Deux clients sur onze ont un numéro cassé. Et créer un client depuis la page Factures produirait un
client numéroté **`DEV-00xx`**, indiscernable d'un devis.

**d) Aucune clé étrangère.** `factures.client_id`, `devis.client_id`, `reparations.client_id`,
`rendezvous.client_id`, `taches.client_id` n'ont **aucune contrainte** (seule `diagnostics` en a).
Supprimer un client laisse des enregistrements orphelins pointant vers un `id` inexistant, sans erreur.

### 3.5 🟠 MAJEUR — Montants en virgule flottante, jamais arrondis

**Fichier :** `factures.html`, fonction `calcTotaux()`.

Les totaux sont calculés en `Number` JavaScript et enregistrés **sans arrondi** :

```js
remiseEuros = sousTotal * (remiseVal/100)
const total = Math.max(0, sousTotal - remiseEuros)
// … puis  total: total  →  enregistré tel quel
```

L'affichage applique `.toFixed(2)`, la base non. Votre facture **`2026-0015` vaut `146.661 €` en base**
alors que le PDF imprime `146,66 €`. Le client paie 146,66, votre chiffre d'affaires compte 146,661.
Sur des centaines de factures avec remise, l'écart cumulé fausse la déclaration.

**Correctif :** arrondir à 2 décimales avant écriture (`Math.round(x*100)/100`), typer les colonnes
en `numeric(12,2)`, et recalculer les totaux **côté serveur** à partir des lignes.

### 3.6 🟠 MAJEUR — Aucune gestion de la TVA

Vous êtes actuellement en franchise (`TVA non applicable, art. 56bis`), ce qui est cohérent avec le
statut « Indépendant complémentaire » enregistré dans `settings`.

**Mais la franchise s'arrête à 25 000 € de chiffre d'affaires annuel.** En passant à 100 %, vous
dépasserez ce seuil — c'est même l'objectif. Or l'ERP **n'a aucun moteur de TVA** :

- pas de taux par ligne, pas de HTVA/TVAC, pas de total TVA sur la facture ;
- la mention `art. 56bis` est **codée en dur** dans `factures.html:976`, `devis.html` et `diagnostics.html` ;
- pas d'autoliquidation ni de mention intracommunautaire (le champ `client_tva` existe mais n'a aucun effet) ;
- aucun récapitulatif TVA exploitable pour la déclaration trimestrielle.

Le jour du basculement, **tout le module de facturation est à refaire**. C'est le chantier
fonctionnel le plus lourd de cet audit et il ne se contourne pas.

### 3.7 🟡 MOYEN — L'adresse client manque sur 7 factures sur 9

Requête sur vos données : 7 des 9 factures ont `client_adresse` à `NULL`.

Cause identifiée : `reparations.html:1177` copie `r.client_adresse` lors de la conversion
réparation → facture, **mais la colonne `client_adresse` n'existe pas dans la table `reparations`**.
La valeur est donc systématiquement `undefined` → `null`. Le gabarit PDF masque proprement le bloc
(`${f.client_adresse ? … : ''}`), donc l'anomalie est invisible à l'écran.

En Belgique, le **nom et l'adresse du client sont des mentions obligatoires** sur une facture
(art. 5, §1er, 3° de l'AR n°1). Sept de vos neuf factures ne sont pas conformes.

### 3.8 🟡 MOYEN — Les garanties démarrent trop tôt

**Fichier :** `garanties.html:631`.

```js
const debut = r.date_fin ? new Date(r.date_fin) : new Date(r.created_at)
```

`date_fin` est écrit au **premier passage en statut « prêt »** (`reparations.html:1213`), pas à la
remise réelle au client. Un appareil prêt le lundi et récupéré 15 jours plus tard perd 15 jours de
garantie.

Par ailleurs, `GARANTIE_MOIS` est une constante (3 mois) : impossible d'avoir une durée différente
selon la pièce, alors que vos propres CGV mentionnent la **garantie légale de conformité de 2 ans sur
les pièces neuves**. Et il n'existe **aucune table de retours SAV** : une réparation qui revient sous
garantie n'est pas tracée, donc votre taux de reprise réel est inconnu.

---

## 4. Montée en charge

### 4.1 🔴 CRITIQUE — Aucune pagination : chaque page charge la base entière

Sur les 15 pages, on compte **0 appel à `.range()`** et **2 appels à `.limit()`** (tous deux dans
`catalogue.html`, pour le catalogue Foneday). Partout ailleurs :

```js
// dashboard.html:778
const [rRep,rFac,rDev,rRdv,rStock,rCharges] = await Promise.all([
  sb.from('reparations').select('*'),
  sb.from('factures').select('*'),
  sb.from('devis').select('*'),
  sb.from('rendezvous').select('*'),
  sb.from('stock').select('*'),
  sb.from('charges').select('*')
])
```

**Tous les filtres, toutes les recherches, tous les KPI sont calculés en JavaScript sur la totalité
des tables**, rechargée à chaque ouverture de page.

Deux plafonds vont être atteints :

- **Limite `max-rows` de l'API PostgREST** (1 000 lignes par défaut chez Supabase — *à vérifier dans
  Settings → API*). Au-delà, la réponse est **tronquée silencieusement** : le dashboard calculera
  votre chiffre d'affaires sur les 1 000 premières factures seulement. **Pas d'erreur, juste un
  chiffre faux.** C'est le mode de défaillance le plus dangereux du lot.
- **`statement_timeout = 8s`** sur le rôle `authenticated` (vérifié). Passé un certain volume,
  la requête est coupée et la page affiche « Erreur ».

**Estimation :** à 5 000 réparations + 3 000 factures (≈ 2 ans à plein temps), le dashboard tente de
transférer plusieurs mégaoctets **par ouverture**, sur le plan Free plafonné à 5 Go d'egress/mois.

**Correctif :** pagination `.range()` côté serveur, filtres transformés en `.eq()`/`.ilike()`/`.gte()`,
et KPI calculés par des **vues Postgres agrégées** (`select sum(total) … where date_paiement …`)
plutôt que par téléchargement complet.

### 4.2 🟠 MAJEUR — Zéro index métier

Inventaire complet des index (hors clés primaires) :

| Table | Index utiles |
|---|---|
| `foneday_produits` | `sku`, `category`, `model_brand`, `suitable_for` ✅ |
| `factures`, `devis` | `numero` (unique) uniquement |
| `clients`, `reparations`, `rendezvous`, `taches`, `stock`, `diagnostics`, `charges` | **aucun** |

Rien sur `created_at`, `statut`, `client_id`, `date_emission`, `email`. Or chaque page fait
`.order('created_at', {ascending:false})` → **balayage séquentiel + tri complet** à chaque appel.
Le RPC public fait `select id from clients where email = …` → balayage complet à chaque soumission
de formulaire.

**Correctif :**
```sql
create index on reparations (created_at desc);
create index on reparations (statut) where statut not in ('rendu','annule','non_reparable');
create index on reparations (client_id);
create index on factures (date_emission desc);
create index on factures (statut);
create index on clients (lower(email));
create index on rendezvous (date_debut);
create index on diagnostics (client_id);      -- signalé par l'advisor Supabase
create index on diagnostics (reparation_id);  -- signalé par l'advisor Supabase
```

### 4.3 🟠 MAJEUR — Deux boucles qui explosent avec le volume

**a) Rattrapage de numérotation à chaque chargement** — `reparations.html:1050-1056` :
```js
const sansNumero = allReps.filter(r => !r.numero).sort(…)
for(const r of sansNumero){
  const num = await nextNumero('reparation','REP')   // 2 requêtes HTTP
  await sb.from('reparations').update({numero:num}).eq('id',r.id)  // 1 requête HTTP
}
```
Boucle **séquentielle**, exécutée à **chaque ouverture** de la page. Le RPC public ne pose pas de
numéro → chaque demande web arrive sans numéro. 500 demandes en attente = **1 500 requêtes HTTP
séquentielles** au chargement, navigateur figé. Combiné au §2.5, c'est un déni de service en un clic.

**b) `markAllRead()`** (dupliqué dans les 14 pages) :
```js
const ids = data.map(r => r.id)
await sb.from('reparations').update({vue:true}).in('id', ids)
```
`.in()` construit une URL contenant tous les identifiants. Au-delà de quelques milliers →
**HTTP 414 URI Too Long**. Remplacer par `.eq('vue', false)` sans liste.

### 4.4 🟡 MOYEN — Le catalogue Foneday garde des produits fantômes

**Fichier :** Edge Function `sync-foneday`.

```js
for (const prod of produits) {
  if (prod.instock !== "Y") continue;   // ← produit ignoré, jamais mis à jour en base
```

La synchronisation est un `upsert` pur : elle **n'invalide jamais** les produits disparus du flux ou
passés hors stock. Ils restent en base avec `instock = true`, indéfiniment.

**Mesuré dans votre base aujourd'hui :**

> **897 produits sur 13 766 (6,5 %)** sont affichés « en stock » alors qu'ils n'ont plus été vus
> depuis plus de 2 jours. Le plus ancien remonte au **29 juin 2026**, soit près de deux mois.

Concrètement : vous chiffrez un devis sur une pièce que Foneday ne vend plus.

**Correctif :** avant l'upsert, `update foneday_produits set instock = false where synced_at < <début du run>`,
et masquer dans `catalogue.html` tout produit dont `synced_at` a plus de 48 h.

### 4.5 🟡 MOYEN — Le cron ne signale jamais ses échecs

Le job `sync-foneday-quotidien` affiche 56 exécutions `succeeded`. Mais il utilise `net.http_post`
(`pg_net`), qui est **asynchrone** : `succeeded` signifie *« la requête a été mise en file »*, pas
*« la synchronisation a réussi »*. Si l'API Foneday renvoie une erreur 500 pendant trois semaines,
`cron.job_run_details` reste au vert et vous ne le saurez jamais.

**Correctif :** faire écrire à la fonction une ligne de résultat dans une table `sync_logs`,
et afficher dans `catalogue.html` un bandeau si la dernière synchronisation réussie a plus de 36 h.

---

## 5. Exploitation & continuité

### 5.1 🔴 CRITIQUE — Plan Supabase Free : aucune sauvegarde, mise en pause automatique

Organisation `IT Soluce` → **plan `free`**. Base actuelle : 21 Mo.

Trois conséquences pour un outil qui porte votre comptabilité :

1. **Aucune sauvegarde automatique.** Le plan Free n'inclut ni sauvegarde quotidienne ni PITR.
   Une fausse manipulation, une suppression accidentelle, un incident côté Supabase, et **tout est
   perdu** : clients, factures, historique. Il n'existe aujourd'hui **aucune copie de vos données
   hors de ce projet**.
2. **Mise en pause après 7 jours d'inactivité.** Deux semaines de vacances → projet suspendu, ERP
   hors ligne, réactivation manuelle nécessaire.
3. **Quotas :** 500 Mo de base et 5 Go d'egress/mois — que le §4.1 consommera vite.

**Correctif — c'est le point n°1 pour « être tranquille » :**
- Passer en **Pro (25 $/mois)** : sauvegardes quotidiennes sur 7 jours, pas de mise en pause.
- **En plus**, un export hebdomadaire vers un stockage que vous contrôlez (`pg_dump` planifié).
  Une sauvegarde chez le même prestataire que la base n'est pas une sauvegarde.
- **Tester une restauration une fois.** Une sauvegarde jamais restaurée n'est pas une sauvegarde.

### 5.2 🟠 MAJEUR — Un bouton efface une table entière en un clic

**Fichier :** `settings.html:1171`.

```js
window.resetTable = async function(table){
  if(!confirm(`⚠️ Vider définitivement la table "${table}" ?`)) return
  const {data} = await sb.from(table).select('id')
  await sb.from(table).delete().in('id', data.map(r=>r.id))
}
```

Exposé pour `reparations`, `stock` et `taches`. Un seul `confirm()` sépare un clic distrait de la
perte de **tout votre historique de réparations** — sans sauvegarde (§5.1), c'est définitif.

**Correctif :** retirer purement et simplement ces boutons de l'interface. Une remise à zéro de
table est une opération d'administration, pas une fonctionnalité produit.

### 5.3 🟠 MAJEUR — Aucun environnement de test, aucun garde-fou de déploiement

- Un seul projet Supabase : **la base de production est aussi la base de développement**.
- `git log` montre des allers-retours (`Remet tout l'ERP a son etat d'avant mes interventions`) :
  chaque modification est testée directement en production.
- Aucun test automatisé, aucune CI, aucune revue. Le déploiement est un `git push` sur GitHub Pages :
  **une erreur de syntaxe dans un `<script>` met l'ERP hors service immédiatement**, sans alerte.
- Aucune migration SQL versionnée : le schéma existe uniquement dans le dashboard Supabase. Il n'est
  pas reproductible, et un projet de secours ne peut pas être recréé à l'identique.

**Correctif :** un second projet Supabase de recette, les migrations versionnées dans le dépôt
(`supabase/migrations/`), et un contrôle de syntaxe minimal en GitHub Action avant publication.

### 5.4 🟡 MOYEN — Aucune supervision

Aucune alerte, aucun suivi d'erreurs (Sentry ou équivalent), aucun contrôle de disponibilité.
Une erreur JavaScript est capturée par un `catch` qui appelle `console.warn` — invisible en usage réel.
On compte **plus de 60 blocs `catch` silencieux** ou réduits à un `console.warn` dans `admin/`.
Si l'envoi de factures tombe en panne, vous l'apprendrez par un client.

---

## 6. Qualité de code & maintenabilité

### 6.1 🟠 MAJEUR — Duplication massive

Chaque page réimplémente intégralement le socle :

| Élément dupliqué | Occurrences |
|---|---|
| Fonction `loadNotifs()` | 14 |
| Fonction `renderNotifs()` | 14 |
| Fonction `showToast()` | 14 |
| `setMode()` / `applyMode()` (thème) | 14 |
| `doLogout()` | 14 |
| URL + clé Supabase codées en dur | 15 |
| Navigation latérale (12 liens) | 14 |
| Bloc `<style>` | 15 fichiers, **~6 500 lignes de CSS** |
| Fonction `nextNumero()` | 6 (avec **3 comportements différents** — cf. §3.4c) |
| Constante `ENTREPRISE` | 3 fichiers + 1 copie locale `ENTREPRISE_LOC` dans `factures.html:1644` |

**Conséquence :** ajouter un lien au menu = 14 modifications. Corriger un bug de notification =
14 modifications, dont on en oubliera une. C'est déjà arrivé : `nextNumero` a divergé entre fichiers
et produit les numéros clients cassés du §3.4c. Et `prestations.html` a perdu son garde
d'authentification (§2.8) — exactement le symptôme d'un socle copié-collé.

**Correctif :** extraire `assets/js/erp-core.js` (client Supabase, garde de session, notifications,
toasts, thème, `nextNumero`, constantes entreprise) et `assets/css/erp.css`. Sans build, sans
framework — juste des fichiers partagés. Gain estimé : **-60 % de code**.

### 6.2 🟠 MAJEUR — La page Paramètres ne pilote presque rien

La table `settings` contient 31 clés (`entreprise_nom`, `entreprise_adresse`, `finance_iban`,
`finance_mention_tva`, `finance_taux_horaire`…). **Aucune page ne la lit, à part `settings.html`
elle-même.**

Vérifié : `from('settings')` n'apparaît que dans `settings.html`. `factures.html`, `devis.html` et
`diagnostics.html` utilisent leur propre constante `ENTREPRISE` **codée en dur**.

**Conséquence directe :** changer votre adresse, votre IBAN ou votre mention TVA dans les Paramètres
**n'a aucun effet sur vos factures**. Vous croirez avoir mis à jour vos documents, ils continueront à
sortir avec les anciennes valeurs. C'est un piège silencieux, et il devient un vrai problème le jour
du changement de régime TVA (§3.6).

### 6.3 🟠 MAJEUR — La grille tarifaire existe en trois exemplaires incohérents

| Emplacement | Portée |
|---|---|
| `localStorage['erp-grille']` | lu par `catalogue.html:738` et `stock.html:757` — **propre au navigateur** |
| `settings.finance_grille` (Supabase) | écrit et relu **par `settings.html` uniquement** |
| Constante `GRILLE` dans `sync-foneday/index.ts` | **codée en dur**, applique les prix aux 13 766 produits |

Trois conséquences :

1. Sur un navigateur où `settings.html` n'a jamais été ouverte, `catalogue.html` retombe sur
   `GRILLE_DEFAUT` : **vos prix changent selon l'appareil que vous utilisez.**
2. Modifier la grille dans les Paramètres **ne recalcule pas** `foneday_produits.prix_vente_calcule` —
   les 13 766 prix du catalogue restent sur l'ancienne grille jusqu'au prochain déploiement de la
   fonction.
3. Vider le cache du navigateur remet vos marges par défaut.

**Correctif :** source unique dans `settings`, lue par toutes les pages et par l'Edge Function.

### 6.4 🟡 MOYEN — Fonctionnalités mortes et code résiduel

Tables présentes en base, **référencées par aucune page** du dépôt :

| Table | Lignes | État |
|---|---|---|
| `mouvements` | 5 | orpheline (module trésorerie ?) |
| `pockets` | 4 | orpheline (enveloppes budgétaires ?) |
| `depenses` | 4 | orpheline |
| `publications` | 1 | orpheline (planning réseaux sociaux) — avec 4 index inutilisés |
| `foneday_historique` | 207 | écrite par le cron, **jamais lue** : l'historique des prix d'achat est collecté pour rien |

Autres angles morts :

- **`charges` est lue mais jamais éditée.** `dashboard.html` calcule votre « bénéfice net » à partir
  de cette table, mais **aucune page ne permet de créer ou modifier une charge**. Votre KPI le plus
  important repose sur 2 lignes que vous ne pouvez pas maintenir depuis l'ERP.
- **`taches` est lue par 13 pages, écrite par aucune.** Les 4 tâches existantes restent affichées
  dans le panneau de notifications sans possibilité de les cocher ni de les supprimer.
- `stock.photo_url` existe mais aucun bucket Storage n'est configuré : les photos de pièces sont
  impossibles.
- `settings.html:1148` — la suppression d'utilisateur affiche « Fonctionnalité nécessitant une clé
  service_role — à configurer côté backend » : bouton présent, fonction absente.

### 6.5 🟡 MOYEN — Les PDF sont des images

`factures.html:1512`, `devis.html:1389`, `diagnostics.html:1136` : le PDF est produit par
`html2canvas` → une **capture bitmap** collée dans un PDF `jsPDF`.

- Pas de couche texte : facture non sélectionnable, non recherchable, illisible par un logiciel
  comptable ou un lecteur d'écran.
- Fichiers lourds (`scale: 2` sur une page A4).
- Rendu dépendant du navigateur et des polices installées.
- Impression de mauvaise qualité.
- Incompatible avec la **facturation électronique structurée (Peppol/UBL)**, qui devient obligatoire
  en Belgique entre entreprises — un PDF-image n'est pas une facture électronique au sens légal.

**Correctif :** génération PDF vectorielle (`jsPDF` en mode texte, ou `pdfmake`), idéalement côté
serveur pour un rendu identique partout.

### 6.6 🟡 MOYEN — Divers

- **Planning sans détection de conflit** : `planning.html` n'a aucune vérification de chevauchement.
  Deux rendez-vous à la même heure sont enregistrés sans avertissement.
- **Rappels manuels** : `send-reminder` n'est déclenchée que par un clic. Aucun envoi automatique
  la veille d'un RDV, alors que `rappel_envoye_le` est prévu pour ça.
- **Pas de mode hors ligne**, pas de service worker : une connexion instable en intervention à
  domicile = ERP inutilisable, et une saisie en cours est perdue.
- **Pas de sauvegarde de brouillon** : fermer un panneau de facture par erreur perd tout le formulaire.
- **Le RPC public crée les réparations en statut `recu`**, alors que le dashboard connaît un statut
  `attente_reception` mieux adapté à une demande web (appareil pas encore reçu).
- **Aucune annulation possible** (`Ctrl+Z`) sur une suppression, nulle part.

---

## 7. Conformité (Belgique / RGPD)

| Point | État | Commentaire |
|---|---|---|
| Numérotation séquentielle des factures | ❌ | 9 trous sur 9 factures (§3.1) |
| Mentions obligatoires (adresse client) | ❌ | absente sur 7 factures sur 9 (§3.7) |
| Immuabilité de la facture émise | ❌ | modifiable et supprimable, PDF non archivé (§3.2) |
| Note de crédit | ❌ | inexistante |
| Conservation 7 ans | ⚠️ | dépend d'une base sans sauvegarde (§5.1) |
| Régime TVA | ⚠️ | franchise `art. 56bis` codée en dur, aucun moteur TVA (§3.6) |
| Facturation électronique (Peppol/UBL) | ❌ | PDF bitmap, aucun format structuré (§6.5) |
| Mentions légales / RGPD site public | ✅ | présentes dans `index.html` (responsable de traitement, cookies) |
| Droit à l'effacement | ❌ | supprimer un client laisse ses nom/e-mail/téléphone recopiés dans `factures`, `devis`, `reparations` |
| Registre des traitements | ❓ | à établir |
| Journal des accès aux données personnelles | ❌ | inexistant |

**Sur le droit à l'effacement :** les données client sont **dénormalisées** (`client_nom`,
`client_email`, `client_telephone` recopiés dans chaque facture/devis/réparation). Une demande
d'effacement ne peut pas être honorée en supprimant la fiche client. La réponse correcte est une
**pseudonymisation** des enregistrements non comptables, les factures devant être conservées 7 ans
au titre de l'obligation légale — mais rien n'est prévu pour ça aujourd'hui.

---

## 8. Récapitulatif des points, par gravité

### 🔴 Critique — à traiter avant toute montée en volume

| # | Point | Où |
|---|---|---|
| 1 | Relais e-mail ouvert (`send-invoice`, `send-reminder`) | §2.1 |
| 2 | Compte fournisseur Foneday exposé (`foneday-proxy`, `sync-foneday`) | §2.2 |
| 3 | Inscription publique Supabase **à vérifier** + RLS `USING (true)` | §2.3 |
| 4 | Numérotation de factures non atomique — trous déjà présents | §3.1 |
| 5 | Facture émise modifiable/supprimable, PDF jamais archivé | §3.2 |
| 6 | Aucune pagination — troncature silencieuse des KPI à 1 000 lignes | §4.1 |
| 7 | Plan Free : aucune sauvegarde, mise en pause après 7 jours | §5.1 |

### 🟠 Majeur

| # | Point | Où |
|---|---|---|
| 8 | Aucun rôle ni séparation des droits | §2.4 |
| 9 | Formulaire public sans limite de débit ni de taille | §2.5 |
| 10 | Aucune 2FA, mots de passe compromis acceptés | §2.6 |
| 11 | Désynchronisation silencieuse du stock | §3.3 |
| 12 | Fusion de clients par nom, numéros incohérents, aucune clé étrangère | §3.4 |
| 13 | Montants non arrondis (`146.661 €` en base) | §3.5 |
| 14 | Aucun moteur de TVA — bloquant au-delà de 25 000 € de CA | §3.6 |
| 15 | Zéro index métier | §4.2 |
| 16 | Boucles de rattrapage et `.in()` qui explosent avec le volume | §4.3 |
| 17 | Bouton « vider la table » en un clic | §5.2 |
| 18 | Aucun environnement de test, aucune migration versionnée | §5.3 |
| 19 | ~6 500 lignes de CSS et 14 copies du socle applicatif | §6.1 |
| 20 | La page Paramètres ne pilote pas les factures | §6.2 |
| 21 | Grille tarifaire en trois exemplaires incohérents | §6.3 |

### 🟡 Moyen

| # | Point | Où |
|---|---|---|
| 22 | CDN sans SRI, version flottante, aucune CSP | §2.7 |
| 23 | `prestations.html` sans garde d'authentification | §2.8 |
| 24 | Adresse client absente sur 7 factures sur 9 | §3.7 |
| 25 | Garanties démarrant au statut « prêt », durée fixe, pas de SAV | §3.8 |
| 26 | 897 produits Foneday fantômes affichés « en stock » | §4.4 |
| 27 | Le cron ne remonte jamais ses échecs | §4.5 |
| 28 | Aucune supervision, 60+ `catch` silencieux | §5.4 |
| 29 | 5 tables mortes, `charges` et `taches` sans interface | §6.4 |
| 30 | PDF bitmap, incompatible Peppol | §6.5 |
| 31 | Planning sans détection de conflit, rappels manuels, pas de hors-ligne | §6.6 |

---

## 9. Plan d'action proposé

### Vague 1 — Sécurité & sauvegarde (à faire cette semaine)

> Objectif : ne plus pouvoir tout perdre, et fermer les portes ouvertes.
> Effort estimé : **1 à 2 jours.**

1. Vérifier et **désactiver l'inscription publique** Supabase — 5 minutes, priorité absolue (§2.3).
2. Ajouter la vérification du rôle dans les 4 Edge Functions + restreindre le CORS (§2.1, §2.2).
3. Retirer `cart-add` / `cart-remove` de `foneday-proxy` en attendant (§2.2).
4. Passer en **plan Pro** + mettre en place un `pg_dump` hebdomadaire externe + **tester une
   restauration** (§5.1).
5. Activer la **2FA** et la protection contre les mots de passe compromis (§2.6).
6. Supprimer les boutons `resetTable` (§5.2).
7. Ajouter le garde de session manquant dans `prestations.html` (§2.8).

### Vague 2 — Intégrité comptable (2 à 3 semaines)

> Objectif : que l'ERP fasse foi. C'est ce qui vous protège en cas de contrôle.
> Effort estimé : **5 à 8 jours.**

8. `next_numero()` atomique en RPC, numéro attribué **à l'émission** seulement, contraintes `UNIQUE`
   ajoutées, et régularisation documentée des trous existants avec votre comptable (§3.1).
9. Verrouillage des factures émises + **notes de crédit** + archivage du PDF dans un bucket Storage
   privé (§3.2).
10. Arrondi systématique à 2 décimales, colonnes en `numeric(12,2)`, totaux recalculés côté serveur (§3.5).
11. Décrément de stock atomique via RPC + journal des mouvements + correction du double décrément (§3.3).
12. Clés étrangères, déduplication client par e-mail uniquement, `nextNumero` centralisée,
    correction des deux numéros clients cassés (§3.4).
13. Ajouter `client_adresse` sur `reparations` et corriger la conversion (§3.7).

### Vague 3 — Montée en charge (1 à 2 mois)

> Objectif : tenir 5 000 clients sans ralentir.
> Effort estimé : **8 à 12 jours.**

14. Créer les index métier — **rapide et très rentable**, à faire dès maintenant en réalité (§4.2).
15. Pagination `.range()` + filtres côté serveur sur toutes les listes (§4.1).
16. Vues Postgres agrégées pour les KPI du dashboard (§4.1).
17. Supprimer les boucles de rattrapage, poser le numéro dans le RPC public (§4.3).
18. Invalidation des produits Foneday périmés + bandeau de fraîcheur (§4.4).
19. Limitation de débit et de taille sur le formulaire public + Turnstile (§2.5).

### Vague 4 — Socle & pérennité (en continu)

> Objectif : pouvoir faire évoluer l'ERP sans le casser.
> Effort estimé : **10 à 15 jours.**

20. Extraire `assets/js/erp-core.js` + `assets/css/erp.css` — **prérequis de tout le reste**,
    à faire idéalement avant la vague 3 (§6.1).
21. Brancher `settings` sur les factures, devis et diagnostics (§6.2).
22. Source unique pour la grille tarifaire (§6.3).
23. Rôles et politiques RLS différenciées, avant la première embauche (§2.4).
24. **Moteur de TVA** — à planifier dès que le CA approche 25 000 € (§3.6). Chantier à part entière.
25. PDF vectoriels, puis étude Peppol/UBL (§6.5).
26. Projet Supabase de recette + migrations versionnées + supervision des erreurs (§5.3, §5.4).
27. Nettoyage des tables mortes, interfaces `charges` et `taches` (§6.4).

---

## 10. Conclusion

Le socle métier est bon. Ce qui manque est **la couche de fiabilité** : atomicité, sauvegarde,
pagination, immuabilité comptable, séparation des droits. Ce sont des chantiers connus, bornés,
qui ne remettent pas en cause vos choix d'architecture — vous pouvez rester sur du HTML statique +
Supabase pour un usage solo, même à quelques milliers de clients, à condition de déporter la logique
sensible (numérotation, stock, totaux) côté serveur en RPC Postgres.

Deux points ne se contournent pas et méritent d'être planifiés dès maintenant, parce qu'ils sont
inévitables et lourds :

- **La sauvegarde** (§5.1). Aujourd'hui, un incident efface votre entreprise. Rien ne justifie
  d'attendre.
- **La TVA** (§3.6). Le passage à 100 % vous fera dépasser les 25 000 €, et le module de facturation
  devra être refait. Mieux vaut le concevoir avant d'avoir 500 factures à reprendre.

Le reste — pagination, index, socle partagé — est du travail d'ingénierie classique qui peut se faire
progressivement, à condition de commencer par le §6.1 (factoriser le socle), sans quoi chaque
correction devra être appliquée quatorze fois.

---

*Audit réalisé le 24 août 2026 en lecture seule sur la branche `claude/erp-complete-audit-63x8f8`.
Aucune modification n'a été apportée au code, aux données ou à la configuration.
Le seul point non vérifiable depuis l'environnement d'audit est l'état de l'inscription publique
Supabase (§2.3), l'accès réseau sortant vers `*.supabase.co` étant bloqué — à contrôler manuellement
en priorité.*
