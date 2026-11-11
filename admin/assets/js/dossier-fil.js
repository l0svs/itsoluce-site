/**
 * Fil du dossier client — le même sur Demandes, Devis, Réparations et Factures.
 *
 *   Demande › Devis › Réparation › Facture › Encaissé
 *
 * À partir de n'importe quel document, le fil retrouve les autres (liens déjà
 * présents en base : converti_devis_id, converti_reparation_id, reparation_id,
 * converti_facture_id, devis_id), affiche l'état de chacun, un lien pour
 * l'ouvrir, et la prochaine chose à faire pour faire avancer le dossier.
 *
 * Usage : DossierFil.afficher(element, { devis: 12 })  (ou demande / reparation / facture)
 *
 * Autonome, comme admin-palette.js : même client Supabase (clé publique anon,
 * session partagée par le navigateur). Une table non autorisée pour ce compte
 * est simplement absente du fil (lecture refusée par RLS).
 */
(function () {
  'use strict';
  var SB_URL = 'https://esltsiutcjcwdbhkkvms.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzbHRzaXV0Y2pjd2RiaGtrdm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3NjM2OTEsImV4cCI6MjA5NzMzOTY5MX0.Sl2cdnqEr7VSBeq1wwMBpfQW9yBB0IG9RkOiZi9GXvo';
  var sbPromise = null;
  function client() {
    if (!sbPromise) {
      sbPromise = import('https://esm.sh/@supabase/supabase-js@2')
        .then(function (mod) { return mod.createClient(SB_URL, SB_KEY); })
        .catch(function () { return null; });
    }
    return sbPromise;
  }

  var COLS = {
    demandes_formulaire: 'id,prenom,nom,created_at,converti_reparation_id,converti_devis_id',
    devis: 'id,numero,statut,total,date_validite,reparation_id,converti_reparation_id,converti_facture_id',
    reparations: 'id,numero,statut,converti_facture_id,date_fin',
    factures: 'id,numero,statut,total,acompte,devis_id,reparation_id,date_paiement'
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var EUR = new Intl.NumberFormat('fr-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function eur(v) { return EUR.format(Number(v) || 0) + ' €'; }
  function jour(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' });
  }

  /* Une requête qui échoue (colonne absente, accès refusé) ne bloque pas le
     fil : la pièce manquante est simplement ignorée. */
  function un(sb, table, col, val) {
    if (val == null || val === '') return Promise.resolve(null);
    return sb.from(table).select(COLS[table]).eq(col, val)
      .order('id', { ascending: false }).limit(1)
      .then(function (r) { return (!r.error && r.data && r.data[0]) || null; })
      .catch(function () { return null; });
  }

  async function resoudre(sb, depart) {
    var d = { demande: null, devis: null, reparation: null, facture: null };
    if (depart.demande) d.demande = await un(sb, 'demandes_formulaire', 'id', depart.demande);
    if (depart.devis) d.devis = await un(sb, 'devis', 'id', depart.devis);
    if (depart.reparation) d.reparation = await un(sb, 'reparations', 'id', depart.reparation);
    if (depart.facture) d.facture = await un(sb, 'factures', 'id', depart.facture);
    // Trois passes suffisent : chaque passe complète à partir de ce qui est connu.
    for (var i = 0; i < 3; i++) {
      if (!d.devis && d.demande) d.devis = await un(sb, 'devis', 'id', d.demande.converti_devis_id);
      if (!d.devis && d.facture) d.devis = await un(sb, 'devis', 'id', d.facture.devis_id);
      if (!d.devis && d.reparation) {
        d.devis = await un(sb, 'devis', 'converti_reparation_id', d.reparation.id)
          || await un(sb, 'devis', 'reparation_id', d.reparation.id);
      }
      if (!d.reparation && d.demande) d.reparation = await un(sb, 'reparations', 'id', d.demande.converti_reparation_id);
      if (!d.reparation && d.devis) d.reparation = await un(sb, 'reparations', 'id', d.devis.converti_reparation_id || d.devis.reparation_id);
      if (!d.reparation && d.facture) d.reparation = await un(sb, 'reparations', 'id', d.facture.reparation_id);
      if (!d.facture && d.reparation) d.facture = await un(sb, 'factures', 'id', d.reparation.converti_facture_id)
        || await un(sb, 'factures', 'reparation_id', d.reparation.id);
      if (!d.facture && d.devis) d.facture = await un(sb, 'factures', 'id', d.devis.converti_facture_id)
        || await un(sb, 'factures', 'devis_id', d.devis.id);
      if (!d.demande && d.devis) d.demande = await un(sb, 'demandes_formulaire', 'converti_devis_id', d.devis.id);
      if (!d.demande && d.reparation) d.demande = await un(sb, 'demandes_formulaire', 'converti_reparation_id', d.reparation.id);
    }
    return d;
  }

  var DEV = { brouillon: 'brouillon', envoye: 'envoyé', accepte: 'accepté', refuse: 'refusé' };
  var REP = { attente_reception: 'à réceptionner', recu: 'appareil reçu', attente: 'attente de pièce', encours: 'en réparation', pret: 'prêt', rendu: 'rendu', non_reparable: 'non réparable', annule: 'annulé' };
  var FAC = { brouillon: 'brouillon', envoyee: 'envoyée', payee: 'payée', annulee: 'annulée', non_reparable: 'diagnostic offert' };

  function etapes(d) {
    var e = [];
    var dem = d.demande, dev = d.devis, rep = d.reparation, fac = d.facture;
    if (dem) e.push({ cle: 'demande', titre: 'Demande', sous: 'reçue le ' + jour(dem.created_at), etat: 'ok', href: '/admin/demandes.html?id=' + dem.id });
    if (dev) {
      var expire = dev.statut === 'envoye' && dev.date_validite && new Date(dev.date_validite) < new Date();
      e.push({ cle: 'devis', titre: 'Devis ' + (dev.numero || ''), sous: expire ? 'validité dépassée' : (DEV[dev.statut] || dev.statut),
        etat: dev.statut === 'accepte' ? 'ok' : dev.statut === 'refuse' ? 'ko' : 'cours', href: '/admin/devis.html?q=' + encodeURIComponent(dev.numero || '') });
    } else e.push({ cle: 'devis', titre: 'Devis', sous: 'aucun', etat: 'vide' });
    if (rep) {
      e.push({ cle: 'reparation', titre: 'Réparation ' + (rep.numero || ''), sous: REP[rep.statut] || rep.statut,
        etat: ['pret', 'rendu'].indexOf(rep.statut) >= 0 ? 'ok' : ['non_reparable', 'annule'].indexOf(rep.statut) >= 0 ? 'ko' : 'cours',
        href: '/admin/reparations.html?q=' + encodeURIComponent(rep.numero || '') });
    } else e.push({ cle: 'reparation', titre: 'Réparation', sous: 'pas encore créée', etat: 'vide' });
    if (fac) {
      e.push({ cle: 'facture', titre: 'Facture ' + (fac.numero || ''), sous: FAC[fac.statut] || fac.statut,
        etat: fac.statut === 'brouillon' ? 'cours' : fac.statut === 'annulee' ? 'ko' : 'ok', href: '/admin/factures.html?open=' + fac.id });
    } else e.push({ cle: 'facture', titre: 'Facture', sous: 'pas encore créée', etat: 'vide' });
    var paye = fac && (fac.statut === 'payee' || fac.statut === 'non_reparable');
    e.push({ cle: 'paye', titre: 'Encaissé',
      sous: !fac ? '—' : fac.statut === 'payee' ? (fac.date_paiement ? 'le ' + jour(fac.date_paiement) : 'payée') : fac.statut === 'non_reparable' ? 'rien à encaisser' : fac.statut === 'envoyee' ? eur(fac.total) + ' à encaisser' : '—',
      etat: paye ? 'ok' : fac && fac.statut === 'envoyee' ? 'cours' : 'vide',
      href: fac ? '/admin/factures.html?open=' + fac.id : null });
    return e;
  }

  /* La prochaine chose à faire pour avancer le dossier, en une phrase. */
  function prochaine(d) {
    var dev = d.devis, rep = d.reparation, fac = d.facture;
    if (fac && fac.statut === 'payee' && rep && rep.statut === 'pret') return "Rendre l'appareil au client";
    if (fac && (fac.statut === 'payee' || fac.statut === 'non_reparable')) return null;
    if (fac && fac.statut === 'envoyee') return 'Encaisser ' + eur(fac.total);
    if (fac && fac.statut === 'brouillon') return 'Vérifier et envoyer la facture';
    if (rep && rep.statut === 'annule') return null;
    if (rep && rep.statut === 'non_reparable') return 'Facturer le diagnostic (ou l’offrir)';
    if (rep && rep.statut === 'pret') return 'Créer la facture';
    if (rep && rep.statut === 'rendu') return 'Créer la facture';
    if (rep && rep.statut === 'attente_reception') return "Réceptionner l'appareil";
    if (rep) return 'Terminer la réparation';
    if (dev && dev.statut === 'accepte') return 'Créer la réparation';
    if (dev && dev.statut === 'refuse') return null;
    if (dev && dev.statut === 'envoye') return "Attendre l'accord du client (relancer si besoin)";
    if (dev) return 'Envoyer le devis au client';
    if (d.demande) return 'Faire le devis';
    return null;
  }

  var style = document.createElement('style');
  style.textContent =
    '.dfil{display:flex;flex-direction:column;gap:8px;}' +
    '.dfil-lab{font-size:10.5px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.6px;}' +
    '.dfil-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px;}' +
    '.dfil-sep{color:var(--t3);font-size:12px;padding:0 1px;}' +
    '.dfil-e{display:inline-flex;flex-direction:column;gap:1px;padding:5px 9px;border-radius:8px;border:1px solid var(--ln);background:var(--bg2);text-decoration:none;color:var(--t1);line-height:1.2;min-width:0;}' +
    'a.dfil-e:hover{border-color:var(--a);}' +
    '.dfil-e b{font-size:11.5px;font-weight:600;white-space:nowrap;display:flex;align-items:center;gap:5px;}' +
    '.dfil-e em{font-style:normal;font-size:10.5px;color:var(--t2);white-space:nowrap;}' +
    '.dfil-e i{width:7px;height:7px;border-radius:50%;background:var(--t3);flex-shrink:0;}' +
    '.dfil-e.ok i{background:var(--ok);}' +
    '.dfil-e.cours i{background:var(--a);}' +
    '.dfil-e.ko i{background:var(--d);}' +
    '.dfil-e.vide{background:transparent;border-style:dashed;color:var(--t3);}' +
    '.dfil-e.vide em{color:var(--t3);}' +
    '.dfil-e.ici{border-color:var(--a);box-shadow:0 0 0 2px var(--ad);}' +
    '.dfil-next{font-size:12px;color:var(--t2);}' +
    '.dfil-next b{color:var(--a);font-weight:600;}' +
    '.dfil-next.fini b{color:var(--ok);}';
  document.head.appendChild(style);

  var jeton = new WeakMap();

  window.DossierFil = {
    /** Vide le fil et annule un affichage encore en cours de chargement. */
    vider: function (el) {
      if (!el) return;
      jeton.set(el, {});
      el.innerHTML = '';
    },
    /**
     * Affiche le fil dans `el`. `depart` : { demande | devis | reparation | facture : id }.
     * `ici` : la clé de l'étape de la page courante (mise en évidence, sans lien).
     */
    afficher: function (el, depart, ici) {
      if (!el) return Promise.resolve(null);
      var t = {};
      jeton.set(el, t);
      return client().then(function (sb) {
        if (!sb) return null;
        return resoudre(sb, depart).then(function (d) {
          if (jeton.get(el) !== t) return d; // un autre dossier a été ouvert entre-temps
          var html = etapes(d).map(function (s) {
            var cls = 'dfil-e ' + s.etat + (s.cle === ici ? ' ici' : '');
            var corps = '<b><i></i>' + esc(s.titre) + '</b><em>' + esc(s.sous) + '</em>';
            return (s.href && s.cle !== ici)
              ? '<a class="' + cls + '" href="' + esc(s.href) + '">' + corps + '</a>'
              : '<span class="' + cls + '">' + corps + '</span>';
          }).join('<span class="dfil-sep">›</span>');
          var p = prochaine(d);
          el.innerHTML = '<div class="dfil"><div class="dfil-lab">Dossier client</div>' +
            '<div class="dfil-row">' + html + '</div>' +
            (p ? '<div class="dfil-next">Prochaine étape : <b>' + esc(p) + '</b></div>'
               : '<div class="dfil-next fini"><b>Dossier terminé</b></div>') + '</div>';
          return d;
        });
      }).catch(function () { return null; });
    }
  };
})();
