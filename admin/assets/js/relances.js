/**
 * Relances clients — une seule logique pour tout l'ERP.
 *
 * Ce qui se relance, et quand (jours comptés à partir de la date de base) :
 *
 *   Devis envoyé sans réponse   base : envoi      1er rappel J+3, 2e rappel J+7
 *                                                 (ou dès que la validité expire dans 2 jours)
 *   Facture impayée             base : échéance   1er rappel J+1, 2e J+10, dernier J+24
 *   Appareil prêt non récupéré  base : prêt       1er rappel J+3, 2e J+10
 *   Demande « attente client »  base : attente    1 rappel J+3
 *   Avis Google                 base : rendu      1 demande J+2, si la facture est payée
 *                                                 (dossiers rendus depuis moins de 45 jours)
 *
 * Deux rappels d'un même document sont toujours espacés d'au moins 5 jours.
 * Rien ne part tout seul : chaque relance s'ouvre dans une fenêtre où le
 * message est relu et modifiable avant l'envoi. « J'ai appelé » et
 * « Ignorer ce rappel » sont aussi enregistrés : le rappel suivant en tient
 * compte. Tout est tracé dans la table `relances` (visible dans la fiche client).
 *
 * Usage :
 *   Relances.charger()                → Promise<[élément à relancer…]>
 *   Relances.pourDocument(type, id)   → Promise<élément | null> (prochain rappel, même pas encore dû)
 *   Relances.ouvrir(element, apres)   → fenêtre d'envoi ; `apres()` est appelé une fois l'action faite
 *   Relances.historique(type, id)     → Promise<[relances faites]>
 */
(function () {
  'use strict';
  var SB_URL = 'https://esltsiutcjcwdbhkkvms.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzbHRzaXV0Y2pjd2RiaGtrdm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3NjM2OTEsImV4cCI6MjA5NzMzOTY5MX0.Sl2cdnqEr7VSBeq1wwMBpfQW9yBB0IG9RkOiZi9GXvo';
  var AVIS_DEFAUT = 'https://maps.app.goo.gl/txUcSmNZTpqiAyDN9';
  var sbPromise = null;
  function client() {
    if (!sbPromise) {
      sbPromise = import('https://esm.sh/@supabase/supabase-js@2')
        .then(function (mod) { return mod.createClient(SB_URL, SB_KEY); })
        .catch(function () { return null; });
    }
    return sbPromise;
  }
  function script(src, test) {
    if (test()) return Promise.resolve();
    return new Promise(function (ok, ko) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { ko(new Error('Chargement impossible : ' + src)); };
      document.head.appendChild(s);
    });
  }

  // ─── Règles ───────────────────────────────────────────────────────
  var REGLES = {
    devis:   { max: 2, delais: { 1: 3, 2: 7 } },
    facture: { max: 3, delais: { 1: 1, 2: 10, 3: 24 } },
    pret:    { max: 2, delais: { 1: 3, 2: 10 } },
    demande: { max: 1, delais: { 1: 3 } },
    avis:    { max: 1, delais: { 1: 2 } }
  };
  var ECART_MIN = 5;           // jours entre deux rappels d'un même document
  var AVIS_FENETRE = 45;       // pas de demande d'avis au-delà
  var NOMS = {
    devis: ['', '1er rappel', '2e rappel'],
    facture: ['', '1er rappel', '2e rappel', 'Dernier rappel'],
    pret: ['', '1er rappel', '2e rappel'],
    demande: ['', 'Rappel'],
    avis: ['', "Demande d'avis"]
  };

  // ─── Modèles de mail ──────────────────────────────────────────────
  // {prenom} {devis} {facture} {montant} {solde} {date_doc} {validite}
  // {echeance} {iban} {appareil} {dossier} {date_pret} {lien_avis}
  var MODELES = {
    devis: {
      1: { objet: 'Votre devis {devis}',
           corps: "Bonjour {prenom},\n\nJe me permets de revenir vers vous au sujet du devis {devis} d'un montant de {montant}, envoyé le {date_doc}. Avez-vous pu en prendre connaissance ?\n\nSi la proposition vous convient, une simple réponse à ce mail suffit pour lancer la réparation. Je reste à votre disposition pour toute question ou adaptation." },
      2: { objet: "Votre devis {devis} — valable jusqu'au {validite}",
           corps: "Bonjour {prenom},\n\nPetit rappel : le devis {devis} d'un montant de {montant} reste valable jusqu'au {validite}. Passé cette date, le prix des pièces peut évoluer.\n\nSouhaitez-vous que je lance la réparation ? Il suffit de répondre à ce mail." }
    },
    facture: {
      1: { objet: 'Rappel — facture {facture}',
           corps: "Bonjour {prenom},\n\nSauf erreur de ma part, la facture {facture} du {date_doc}, d'un montant de {solde}, arrivée à échéance le {echeance}, n'est pas encore réglée.\n\nVous pouvez effectuer le virement sur le compte {iban} en indiquant la référence {facture}.\n\nSi le paiement a été fait entre-temps, merci de ne pas tenir compte de ce message." },
      2: { objet: 'Deuxième rappel — facture {facture}',
           corps: "Bonjour {prenom},\n\nMalgré mon précédent rappel, la facture {facture} d'un montant de {solde} (échéance au {echeance}) reste impayée à ce jour.\n\nMerci d'effectuer le règlement dans les 14 jours sur le compte {iban}, en indiquant la référence {facture}. En cas de difficulté, n'hésitez pas à me contacter : nous trouverons une solution.\n\nSi le paiement a été fait entre-temps, merci de ne pas tenir compte de ce message." },
      3: { objet: 'Dernier rappel — facture {facture}',
           corps: "Bonjour {prenom},\n\nLa facture {facture} d'un montant de {solde} reste impayée malgré mes rappels.\n\nSans règlement dans les 14 jours, je serai contraint de vous adresser une mise en demeure.\n\nPaiement : compte {iban}, référence {facture}. Je reste joignable si vous souhaitez en parler." }
    },
    pret: {
      1: { objet: 'Votre {appareil} vous attend — {dossier}',
           corps: "Bonjour {prenom},\n\nPetit rappel : la réparation de votre {appareil} (dossier {dossier}) est terminée et l'appareil vous attend.{reste}\n\nDites-moi simplement quand vous souhaitez passer le récupérer." },
      2: { objet: 'Votre {appareil} est toujours disponible — {dossier}',
           corps: "Bonjour {prenom},\n\nVotre {appareil} (dossier {dossier}) est prêt depuis le {date_pret} et vous attend toujours.{reste}\n\nPour rappel, conformément à mes conditions générales, un appareil non récupéré dans les 30 jours suivant la fin de l'intervention peut être considéré comme abandonné. Pouvez-vous me dire quand vous passez ?" }
    },
    demande: {
      1: { objet: 'Votre demande de réparation — {appareil}',
           corps: "Bonjour {prenom},\n\nJe reviens vers vous concernant votre demande pour votre {appareil}. Avez-vous pu prendre connaissance de mon précédent message ?\n\nJe reste disponible si vous souhaitez en discuter ou fixer un rendez-vous." }
    },
    avis: {
      1: { objet: 'Votre avis sur la réparation de votre {appareil}',
           corps: "Bonjour {prenom},\n\nMerci encore d'avoir confié votre {appareil} à IT Soluce. J'espère que tout fonctionne parfaitement.\n\nSi vous êtes satisfait, un avis Google m'aiderait beaucoup à me faire connaître ; cela prend une minute :\n{lien_avis}\n\nEt si quelque chose ne va pas, répondez simplement à ce mail : je m'en occupe." }
    }
  };

  // ─── Outils ───────────────────────────────────────────────────────
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var EUR = new Intl.NumberFormat('fr-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function eur(v) { return EUR.format(Number(v) || 0) + ' €'; }
  function debutJour(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function jours(a, b) { return Math.round((debutJour(b) - debutJour(a)) / 86400000); }
  function plus(d, n) { var x = debutJour(d); x.setDate(x.getDate() + n); return x; }
  function dateLongue(d) {
    var x = new Date(d);
    return isNaN(x) ? '' : x.toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function dateCourte(d) {
    var x = new Date(d);
    return isNaN(x) ? '' : x.toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' });
  }
  function prenomDe(nom) { return String(nom || '').trim().split(/\s+/)[0] || ''; }
  function remplir(txt, v) {
    return String(txt).replace(/\{(\w+)\}/g, function (m, k) { return v[k] != null && v[k] !== '' ? v[k] : m; });
  }
  function texteVersHtml(t, lienAvis) {
    return String(t).split(/\n\s*\n/).map(function (p) {
      var h = esc(p).replace(/\n/g, '<br>');
      if (lienAvis) h = h.split(esc(lienAvis)).join('<a href="' + esc(lienAvis) + '" style="color:#1d4ed8;">Laisser un avis Google</a>');
      return '<p>' + h + '</p>';
    }).join('');
  }

  // ─── Données ──────────────────────────────────────────────────────
  var cache = null;
  async function lire(sb, table, cols, filtre) {
    var q = sb.from(table).select(cols);
    if (filtre) q = filtre(q);
    var r = await q.limit(3000);
    return r.error ? [] : (r.data || []);
  }
  async function donnees(force) {
    if (cache && !force) return cache;
    var sb = await client();
    if (!sb) throw new Error('Connexion impossible');
    var res = await Promise.all([
      lire(sb, 'devis', 'id,numero,client_id,client_nom,client_email,total,statut,date_emission,date_validite,date_envoi,emis_le', function (q) { return q.eq('statut', 'envoye'); }),
      lire(sb, 'factures', 'id,numero,client_id,client_nom,client_email,total,acompte,statut,type_document,date_emission,date_echeance,date_paiement,reparation_id'),
      lire(sb, 'reparations', 'id,numero,client_id,client_nom,client_email,appareil,modele,statut,date_fin,converti_facture_id,garantie_de_id'),
      lire(sb, 'demandes_formulaire', 'id,prenom,nom,email,appareil,en_attente_depuis,converti_reparation_id,converti_devis_id'),
      lire(sb, 'relances', '*'),
      lire(sb, 'settings', 'cle,valeur')
    ]);
    var reglages = {};
    res[5].forEach(function (r) { reglages[r.cle] = r.valeur == null ? '' : String(r.valeur).trim(); });
    cache = { sb: sb, devis: res[0], factures: res[1], reps: res[2], demandes: res[3], relances: res[4], settingsLignes: res[5], reglages: reglages };
    return cache;
  }
  function historiqueDe(d, type, id) {
    return d.relances.filter(function (r) { return r.type === type && Number(r.document_id) === Number(id); })
      .sort(function (a, b) { return new Date(a.fait_le) - new Date(b.fait_le); });
  }

  /* Prochain rappel d'un document : niveau, date à partir de laquelle il est dû. */
  function prochain(d, type, id, base, extraDu) {
    var regle = REGLES[type];
    var h = historiqueDe(d, type, id);
    var fait = h.reduce(function (m, r) { return Math.max(m, Number(r.niveau) || 0); }, 0);
    var niveau = fait + 1;
    if (niveau > regle.max || !base) return null;
    var du = plus(base, regle.delais[niveau]);
    if (extraDu && extraDu < du) du = extraDu;
    var dernier = h.length ? h[h.length - 1].fait_le : null;
    if (dernier && jours(dernier, du) < ECART_MIN) du = plus(dernier, ECART_MIN);
    return { niveau: niveau, du: du, historique: h };
  }

  function construire(d, type, doc, p) {
    var aujourdhui = new Date();
    var e = { type: type, id: doc.id, niveau: p.niveau, du: p.du, historique: p.historique, doc: doc,
              estDu: debutJour(p.du) <= debutJour(aujourdhui), libelleNiveau: NOMS[type][p.niveau] };
    var v = { iban: d.reglages.finance_iban || '', lien_avis: d.reglages.avis_google_url || AVIS_DEFAUT };
    if (type === 'devis') {
      e.client_id = doc.client_id; e.nom = doc.client_nom; e.email = doc.client_email;
      e.titre = 'Devis ' + (doc.numero || ''); e.montant = Number(doc.total) || 0;
      e.sous = 'envoyé le ' + dateCourte(doc.date_envoi || doc.date_emission) + (doc.date_validite ? ' · valable jusqu’au ' + dateCourte(doc.date_validite) : '');
      e.href = '/admin/devis.html?q=' + encodeURIComponent(doc.numero || '');
      Object.assign(v, { devis: doc.numero, montant: eur(doc.total), date_doc: dateLongue(doc.date_envoi || doc.date_emission), validite: dateLongue(doc.date_validite) });
      e.pdf = { type: 'devis', id: doc.id };
    } else if (type === 'facture') {
      var solde = Math.max(0, (Number(doc.total) || 0) - (Number(doc.acompte) || 0));
      e.client_id = doc.client_id; e.nom = doc.client_nom; e.email = doc.client_email;
      e.titre = 'Facture ' + (doc.numero || ''); e.montant = solde;
      var retard = doc.date_echeance ? jours(doc.date_echeance, aujourdhui) : 0;
      e.sous = retard > 0 ? 'échue depuis ' + retard + ' jour' + (retard > 1 ? 's' : '') : 'échéance le ' + dateCourte(doc.date_echeance);
      e.href = '/admin/factures.html?open=' + doc.id;
      Object.assign(v, { facture: doc.numero, solde: eur(solde), date_doc: dateLongue(doc.date_emission), echeance: dateLongue(doc.date_echeance) });
      e.pdf = { type: 'facture', id: doc.id };
    } else if (type === 'pret' || type === 'avis') {
      var app = [doc.modele || doc.appareil].filter(Boolean).join(' ') || 'appareil';
      e.client_id = doc.client_id; e.nom = doc.client_nom; e.email = doc.client_email;
      e.titre = (doc.numero || 'Dossier') + ' · ' + app;
      e.href = '/admin/reparations.html?q=' + encodeURIComponent(doc.numero || '');
      var f = d.factures.filter(function (x) { return x.reparation_id === doc.id && x.type_document !== 'note_credit' && ['brouillon', 'envoyee'].indexOf(x.statut) >= 0; })[0];
      var reste = f ? Math.max(0, (Number(f.total) || 0) - (Number(f.acompte) || 0)) : 0;
      e.montant = type === 'pret' ? reste : 0;
      e.sous = type === 'pret' ? 'prêt depuis ' + jours(doc.date_fin, aujourdhui) + ' jours' + (reste ? ' · ' + eur(reste) + ' à régler' : '')
                               : 'rendu le ' + dateCourte(doc.date_fin) + ' · facture payée';
      Object.assign(v, { appareil: app, dossier: doc.numero || '', date_pret: dateLongue(doc.date_fin),
                         reste: reste ? ' Le montant restant à régler est de ' + eur(reste) + '.' : '' });
    } else if (type === 'demande') {
      var nom = [doc.prenom, doc.nom].filter(Boolean).join(' ');
      e.nom = nom; e.email = doc.email; e.client_id = null;
      e.titre = 'Demande · ' + (doc.appareil || 'appareil');
      e.sous = 'sans réponse depuis ' + jours(doc.en_attente_depuis, aujourdhui) + ' jours';
      e.href = '/admin/demandes.html?id=' + doc.id;
      Object.assign(v, { appareil: doc.appareil || 'appareil' });
    }
    v.prenom = type === 'demande' ? (doc.prenom || prenomDe(e.nom)) : prenomDe(e.nom);
    var m = MODELES[type][p.niveau];
    e.objet = remplir(m.objet, v);
    e.corps = remplir(m.corps, v);
    e.lienAvis = type === 'avis' ? v.lien_avis : null;
    return e;
  }

  function candidats(d) {
    var out = [];
    var aujourdhui = new Date();
    d.devis.forEach(function (x) {
      if (x.statut !== 'envoye' || !x.numero) return;
      var expire = x.date_validite ? plus(x.date_validite, -2) : null;
      var p = prochain(d, 'devis', x.id, x.date_envoi || x.date_emission, expire);
      if (p) out.push(construire(d, 'devis', x, p));
    });
    d.factures.forEach(function (x) {
      if (x.type_document === 'note_credit' || x.statut !== 'envoyee' || !x.numero) return;
      var p = prochain(d, 'facture', x.id, x.date_echeance || x.date_emission);
      if (p) out.push(construire(d, 'facture', x, p));
    });
    d.reps.forEach(function (x) {
      if (x.statut === 'pret' && x.date_fin) {
        var p = prochain(d, 'pret', x.id, x.date_fin);
        if (p) out.push(construire(d, 'pret', x, p));
      }
      if (x.statut === 'rendu' && x.date_fin && !x.garantie_de_id && jours(x.date_fin, aujourdhui) <= AVIS_FENETRE) {
        var payee = d.factures.some(function (f) { return f.reparation_id === x.id && f.statut === 'payee' && f.type_document !== 'note_credit'; })
          && !d.factures.some(function (f) { return f.reparation_id === x.id && f.statut === 'creditee'; });
        if (!payee) return;
        var pa = prochain(d, 'avis', x.id, x.date_fin);
        if (pa) out.push(construire(d, 'avis', x, pa));
      }
    });
    d.demandes.forEach(function (x) {
      if (!x.en_attente_depuis || x.converti_reparation_id || x.converti_devis_id) return;
      var p = prochain(d, 'demande', x.id, x.en_attente_depuis);
      if (p) out.push(construire(d, 'demande', x, p));
    });
    return out;
  }

  // ─── Fenêtre d'envoi ──────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent =
    '#rl-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:600;display:none;align-items:center;justify-content:center;padding:20px;}' +
    '#rl-ov.open{display:flex;}' +
    '#rl-box{background:var(--bg2);border-radius:16px;width:100%;max-width:560px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.35);}' +
    '.rl-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:15px 20px;border-bottom:1px solid var(--ln);}' +
    '.rl-h b{font-size:15px;color:var(--t1);}' +
    '.rl-h button{background:none;border:none;color:var(--t3);font-size:22px;cursor:pointer;line-height:1;}' +
    '.rl-b{padding:16px 20px;display:flex;flex-direction:column;gap:12px;}' +
    '.rl-b label{display:block;font-size:12px;font-weight:500;color:var(--t2);margin-bottom:5px;}' +
    '.rl-b input,.rl-b textarea{width:100%;box-sizing:border-box;padding:9px 12px;background:var(--bg3);border:1px solid transparent;border-radius:10px;color:var(--t1);font:inherit;font-size:13.5px;outline:none;}' +
    '.rl-b textarea{min-height:190px;resize:vertical;line-height:1.55;}' +
    '.rl-b input:focus,.rl-b textarea:focus{background:var(--bg2);border-color:var(--a);}' +
    '.rl-info{font-size:12.5px;line-height:1.5;color:var(--t2);background:var(--ad);border-radius:10px;padding:9px 12px;}' +
    '.rl-hist{font-size:12px;color:var(--t3);}' +
    '.rl-case{display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--t2);}' +
    '.rl-case input{width:auto;}' +
    '.rl-f{display:flex;gap:8px;flex-wrap:wrap;padding:14px 20px;border-top:1px solid var(--ln);}' +
    '.rl-f button{flex:1;min-width:120px;padding:10px 14px;border-radius:980px;border:none;font:inherit;font-size:13px;font-weight:500;cursor:pointer;background:var(--bg3);color:var(--t1);}' +
    '.rl-f button:hover{background:var(--bg4);}' +
    '.rl-f button.rl-prim{background:var(--a);color:#fff;}' +
    '.rl-f button.rl-prim:hover{opacity:.88;background:var(--a);}' +
    '.rl-f button:disabled{opacity:.6;cursor:default;}';
  document.head.appendChild(style);

  var ov = null, courant = null, apresAction = null;
  function construireFenetre() {
    if (ov) return;
    ov = document.createElement('div');
    ov.id = 'rl-ov';
    ov.innerHTML = '<div id="rl-box" role="dialog" aria-modal="true">' +
      '<div class="rl-h"><b id="rl-titre">Relance</b><button type="button" aria-label="Fermer" data-act="fermer">×</button></div>' +
      '<div class="rl-b">' +
      '<div class="rl-info" id="rl-info"></div>' +
      '<div><label for="rl-a">Destinataire</label><input type="email" id="rl-a"/></div>' +
      '<div><label for="rl-objet">Objet</label><input type="text" id="rl-objet"/></div>' +
      '<div><label for="rl-corps">Message (la signature est ajoutée à l’envoi)</label><textarea id="rl-corps"></textarea></div>' +
      '<label class="rl-case" id="rl-pdf-wrap"><input type="checkbox" id="rl-pdf" checked/> Joindre le PDF du document</label>' +
      '<div class="rl-hist" id="rl-hist"></div>' +
      '</div>' +
      '<div class="rl-f">' +
      '<button type="button" data-act="ignorer" title="Passer ce rappel sans rien envoyer">Ignorer ce rappel</button>' +
      '<button type="button" data-act="appel" title="Tu as relancé par téléphone">J’ai appelé</button>' +
      '<button type="button" class="rl-prim" data-act="envoyer" id="rl-envoyer">Envoyer</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (ev) {
      if (ev.target === ov) return fermer();
      var b = ev.target.closest('[data-act]');
      if (!b) return;
      var a = b.dataset.act;
      if (a === 'fermer') fermer();
      else if (a === 'envoyer') envoyer();
      else if (a === 'appel') noter('telephone');
      else if (a === 'ignorer') noter('ignore');
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && ov.classList.contains('open')) fermer(); });
  }
  function fermer() { if (ov) ov.classList.remove('open'); courant = null; }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'ok');
    else alert(msg);
  }

  async function enregistrer(e, canal, objet, destinataire) {
    var d = await donnees();
    var ligne = { type: e.type, document_id: e.id, niveau: e.niveau, canal: canal,
                  client_id: e.client_id || null, destinataire: destinataire || null, objet: objet || null };
    var r = await d.sb.from('relances').insert(ligne).select().single();
    if (r.error) throw new Error(r.error.message);
    d.relances.push(r.data);
    return r.data;
  }
  async function noter(canal) {
    var e = courant; if (!e) return;
    try {
      await enregistrer(e, canal, canal === 'telephone' ? 'Appel téléphonique' : 'Rappel ignoré', null);
      fermer();
      toast(canal === 'telephone' ? 'Appel noté — le rappel suivant viendra plus tard' : 'Rappel passé');
      if (apresAction) apresAction();
    } catch (err) { toast('Erreur : ' + (err.message || err), 'err'); }
  }
  function pdfDepuisPage(pdf) {
    return new Promise(function (ok, ko) {
      var cadre = document.createElement('iframe');
      cadre.style.cssText = 'position:fixed;left:-12000px;top:0;width:1200px;height:900px;opacity:0;pointer-events:none;border:0;';
      cadre.src = '/admin/' + (pdf.type === 'devis' ? 'devis' : 'factures') + '.html?export=pdf&id=' + pdf.id;
      var fin = setTimeout(function () { nettoyer(); ko(new Error('délai dépassé')); }, 45000);
      function ecoute(ev) {
        if (ev.origin !== location.origin || ev.source !== cadre.contentWindow || !ev.data || ev.data.type !== 'itsoluce-pdf') return;
        nettoyer();
        ev.data.erreur ? ko(new Error(ev.data.erreur)) : ok(ev.data);
      }
      function nettoyer() { clearTimeout(fin); window.removeEventListener('message', ecoute); cadre.remove(); }
      window.addEventListener('message', ecoute);
      document.body.appendChild(cadre);
    });
  }
  async function envoyer() {
    var e = courant; if (!e) return;
    var a = document.getElementById('rl-a').value.trim();
    var objet = document.getElementById('rl-objet').value.trim();
    var corps = document.getElementById('rl-corps').value;
    if (!a) return toast('Le destinataire est requis', 'err');
    if (/\{[a-z_]+\}/i.test(corps + objet)) return toast('Un champ entre accolades n’est pas rempli', 'err');
    var btn = document.getElementById('rl-envoyer');
    btn.disabled = true; btn.textContent = 'Envoi…';
    try {
      await script('/admin/assets/js/envoi-mail.js', function () { return typeof window.envoyerMailERP === 'function'; });
      await script('/admin/assets/js/signature-mail.js', function () { return typeof window.signatureMailHTML === 'function'; });
      var d = await donnees();
      var piece = {};
      if (e.pdf && document.getElementById('rl-pdf').checked) {
        btn.textContent = 'PDF…';
        var r = await pdfDepuisPage(e.pdf);
        piece = { pdfBase64: r.base64, pdfName: r.nom };
        btn.textContent = 'Envoi…';
      }
      var html = texteVersHtml(corps, e.lienAvis) + window.signatureMailHTML(window.entrepriseDepuisReglages(d.settingsLignes));
      var s = await d.sb.auth.getSession();
      var envoi = await window.envoyerMailERP(Object.assign({ SB: SB_URL, jeton: s.data.session.access_token, to: a, subject: objet, html: html, repli: 'send-reminder' }, piece));
      await enregistrer(e, 'mail', objet, a);
      fermer();
      toast(e.type === 'avis' ? 'Demande d’avis envoyée à ' + a : 'Relance envoyée à ' + a);
      if (envoi && envoi.avertissement) setTimeout(function () { toast(envoi.avertissement, 'err'); }, 3500);
      if (apresAction) apresAction();
    } catch (err) {
      toast('Envoi impossible : ' + (err.message || err), 'err');
    } finally { btn.disabled = false; btn.textContent = 'Envoyer'; }
  }

  function ouvrir(e, apres) {
    construireFenetre();
    courant = e; apresAction = apres || null;
    document.getElementById('rl-titre').textContent = e.type === 'avis' ? 'Demander un avis Google' : e.libelleNiveau + ' · ' + e.titre;
    var info = e.type === 'avis'
      ? 'Une seule demande par dossier, envoyée après le rendu et le paiement.'
      : e.titre + ' — ' + esc(e.nom || '') + ' · ' + e.sous + (e.estDu ? '' : ' · ce rappel est normalement prévu le ' + dateCourte(e.du));
    if (e.type === 'facture' && e.niveau >= 2) info += '<br>Particuliers : pas de frais ni d’intérêts ajoutés automatiquement. Avant d’en réclamer, vérifie les règles avec ton comptable ou l’UCM.';
    document.getElementById('rl-info').innerHTML = info;
    document.getElementById('rl-a').value = e.email || '';
    document.getElementById('rl-objet').value = e.objet;
    document.getElementById('rl-corps').value = e.corps;
    document.getElementById('rl-pdf-wrap').style.display = e.pdf ? '' : 'none';
    document.getElementById('rl-pdf').checked = !!e.pdf;
    document.getElementById('rl-hist').textContent = e.historique.length
      ? 'Déjà fait : ' + e.historique.map(function (h) {
          return (h.canal === 'telephone' ? 'appel' : h.canal === 'ignore' ? 'rappel ignoré' : 'mail') + ' le ' + dateCourte(h.fait_le);
        }).join(', ')
      : 'Aucune relance faite pour l’instant.';
    ov.classList.add('open');
    setTimeout(function () {
      var t = document.getElementById('rl-corps');
      t.focus(); t.setSelectionRange(0, 0); t.scrollTop = 0;
      document.getElementById('rl-box').scrollTop = 0;
    }, 50);
  }

  window.Relances = {
    REGLES: REGLES,
    charger: async function (force) {
      var d = await donnees(force !== false);
      return candidats(d).filter(function (e) { return e.estDu; })
        .sort(function (a, b) { return a.du - b.du; });
    },
    aVenir: async function () {
      var d = await donnees(true);
      return candidats(d).filter(function (e) { return !e.estDu; }).sort(function (a, b) { return a.du - b.du; });
    },
    pourDocument: async function (type, id) {
      var d = await donnees(true);
      return candidats(d).filter(function (e) { return e.type === type && Number(e.id) === Number(id); })[0] || null;
    },
    historique: async function (type, id) {
      var d = await donnees();
      return historiqueDe(d, type, id);
    },
    ouvrir: ouvrir
  };
})();
