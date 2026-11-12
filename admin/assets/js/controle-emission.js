/**
 * Contrôle avant émission d'une facture ou d'un devis.
 *
 * Mêmes règles que le déclencheur controle_emission() en base : la page
 * prévient avant la confirmation, la base reste le garde-fou final (une
 * facture incomplète ne peut pas être émise, même si la page se trompe).
 *
 *   window.problemesEmission(doc) → liste de messages (vide = tout va bien)
 *   doc : { client_nom, client_societe, client_adresse, client_tva, lignes, total, type_document }
 */
(function () {
  function tvaValide(v) {
    var t = String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!/^[A-Z]{2}[0-9A-Z]{8,12}$/.test(t)) return false;
    if (t.indexOf('BE') === 0 && !/^BE[01][0-9]{9}$/.test(t)) return false;
    return true;
  }
  window.tvaClientValide = tvaValide;

  window.problemesEmission = function (doc) {
    var p = [];
    if (!doc) return p;
    var vide = function (v) { return !String(v == null ? '' : v).trim(); };
    if (vide(doc.client_nom)) p.push('Nom du client manquant.');
    var pro = !vide(doc.client_societe) || !vide(doc.client_tva);
    if (pro && vide(doc.client_adresse)) p.push('Adresse du client professionnel manquante.');
    if (!vide(doc.client_tva) && !tvaValide(doc.client_tva)) p.push('Numéro de TVA du client invalide (' + String(doc.client_tva).trim() + ').');
    if (doc.type_document === 'note_credit') return p;
    var lignes = Array.isArray(doc.lignes) ? doc.lignes : [];
    if (!lignes.length) p.push('Aucune ligne.');
    lignes.forEach(function (l) {
      var d = String(l.description || '').trim();
      if (!d) p.push('Une ligne n’a pas de description.');
      else if (!(Number(l.quantite) > 0)) p.push('Quantité invalide sur « ' + d + ' ».');
      else if (Number(l.prix_unitaire) < 0) p.push('Prix négatif sur « ' + d + ' » : utilise la remise.');
    });
    if (Number(doc.total) < 0) p.push('Le total est négatif.');
    return p.filter(function (x, i, a) { return a.indexOf(x) === i; });
  };

  /* Message prêt à afficher, ou '' si le document peut être émis. */
  window.messageEmission = function (doc, nom) {
    var p = window.problemesEmission(doc);
    if (!p.length) return '';
    return 'Impossible d\u2019émettre ' + (nom || 'ce document') + ' : ' + p[0] +
      (p.length > 1 ? ' (et ' + (p.length - 1) + ' autre' + (p.length > 2 ? 's' : '') + ' point' + (p.length > 2 ? 's' : '') + ')' : '');
  };
})();
