/**
 * Signature des mails de l'ERP : la même partout (Messages, Planning), et
 * identique à celle des devis et des factures.
 *
 * Elle est construite à partir de Gestion › Entreprise (nom, téléphone,
 * email, site, adresse, BCE) : il n'y a qu'un seul endroit à tenir à jour.
 */
(function () {
  'use strict';

  var DEFAUT = {
    nom: 'IT Soluce', tel: '+32 474 05 66 59', email: 'contact@itsoluce.be', site: 'itsoluce.be',
    adresse: "Chaussée d'Hondzocht 164", cp_ville: '1480 Tubize', bce: 'BE 1027.026.003',
    logo: 'https://itsoluce.be/img/logo-full.png'
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Coordonnées depuis les lignes de la table settings ({cle, valeur}). */
  window.entrepriseDepuisReglages = function (lignes) {
    var e = Object.assign({}, DEFAUT);
    (lignes || []).forEach(function (r) {
      var v = r.valeur == null ? '' : String(r.valeur).trim();
      if (!v) return;
      if (r.cle === 'entreprise_nom') e.nom = v;
      if (r.cle === 'entreprise_email') e.email = v;
      if (r.cle === 'entreprise_telephone') e.tel = v;
      if (r.cle === 'entreprise_site') e.site = v.replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (r.cle === 'entreprise_bce') e.bce = v;
      if (r.cle === 'entreprise_adresse') {
        var i = v.lastIndexOf(',');
        if (i > 0) { e.adresse = v.slice(0, i).trim(); e.cp_ville = v.slice(i + 1).trim(); }
        else { e.adresse = v; e.cp_ville = ''; }
      }
    });
    return e;
  };

  /** Signature HTML « complète » : même rendu que les devis et les factures. */
  window.signatureMailHTML = function (E) {
    E = Object.assign({}, DEFAUT, E || {});
    var telLien = String(E.tel || '').replace(/[^0-9+]/g, '');
    var site = String(E.site || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    var L = function (href, txt, coul) { return '<a href="' + href + '" style="color:' + coul + ';text-decoration:none;">' + esc(txt) + '</a>'; };
    var entete = '<tr><td style="padding:0 0 10px;"><img src="' + esc(E.logo) + '" width="78" height="32" alt="' + esc(E.nom) + '" style="display:block;border:0;"></td></tr>' +
      '<tr><td style="border-top:2px solid #0052CC;padding:9px 0 0;font-size:13px;font-weight:bold;color:#12212e;">R&eacute;parations informatiques &amp; &eacute;lectroniques</td></tr>';
    var adresse = [E.adresse, E.cp_ville].filter(Boolean).join(', ');
    var pied = [esc(adresse), E.bce ? 'BCE ' + esc(E.bce) : ''].filter(Boolean).join(' &middot; ');
    var corps = '<tr><td style="padding:8px 0 0;font-size:12.5px;line-height:1.9;color:#5a6b7b;">' +
      (E.tel ? '<span style="color:#0052CC;font-weight:bold;">T</span>&nbsp;&nbsp;' + L('tel:' + telLien, E.tel, '#5a6b7b') + '<br>' : '') +
      (E.email ? '<span style="color:#0052CC;font-weight:bold;">E</span>&nbsp;&nbsp;' + L('mailto:' + E.email, E.email, '#5a6b7b') + '<br>' : '') +
      (site ? '<span style="color:#0052CC;font-weight:bold;">W</span>&nbsp;&nbsp;' + L('https://' + site + '/', site, '#0052CC') : '') +
      '</td></tr>' +
      (pied ? '<tr><td style="padding:9px 0 0;font-size:11.5px;line-height:1.6;color:#8a97a3;">' + pied + '</td></tr>' : '');
    return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;margin:18px 0 14px;">Bien &agrave; vous,</div>' +
      '<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">' + entete + corps + '</table>';
  };

  /** Même signature en texte brut (partie texte du mail). */
  window.signatureMailTexte = function (E) {
    E = Object.assign({}, DEFAUT, E || {});
    var site = String(E.site || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return ['Bien à vous,', '', E.nom + ' — Réparations informatiques & électroniques',
      E.tel ? 'T  ' + E.tel : '', E.email ? 'E  ' + E.email : '', site ? 'W  ' + site : '',
      [[E.adresse, E.cp_ville].filter(Boolean).join(', '), E.bce ? 'BCE ' + E.bce : ''].filter(Boolean).join(' · ')
    ].filter(function (l, i) { return l !== '' || i === 1; }).join('\n');
  };
})();
