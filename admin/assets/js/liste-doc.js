/**
 * Devis et Factures sur téléphone et tablette (≤ 900 px) : d'abord la liste
 * des documents, en colonne ; un appui ouvre le document en plein écran, le
 * bouton « ← » revient à la liste. Plus de carrousel à faire glisser.
 * Sur PC, rien ne change (les classes ne servent que sous 900 px).
 */
(function () {
  'use strict';
  var OUVRE = /ouvrir(Devis|Facture)\(|nouve(au|lle)(Devis|Facture)\(/;
  function at() { return document.querySelector('.at'); }
  function liste(on) {
    var a = at(); if (!a) return;
    a.classList.toggle('liste', !!on);
    a.scrollTop = 0; window.scrollTo(0, 0);
  }
  // Arrivée par un lien (ouvrir un document, créer depuis un client, un dossier…) : le document d'abord.
  var p = new URLSearchParams(location.search);
  var parLien = ['open', 'id', 'client', 'reparation', 'devis', 'demande', 'nouveau', 'encaisser', 'pack'].some(function (k) { return p.has(k); });
  function depart() { liste(!parLien); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', depart); else depart();
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[onclick]');
    if (el && OUVRE.test(el.getAttribute('onclick') || '')) setTimeout(function () { liste(false); }, 0);
  }, true);
  window.retourListe = function () {
    if (typeof window.confirmerAbandon === 'function' && !window.confirmerAbandon()) return;
    liste(true);
  };
})();
