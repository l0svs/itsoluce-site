/**
 * Prénoms et noms : chaque partie commence par une majuscule
 * (« ivana pugliesi » → « Ivana Pugliesi », « freitas de paula » → « Freitas De Paula »,
 * « jean-pierre » → « Jean-Pierre », « o'brien » → « O'Brien »).
 * Même règle que la fonction nom_propre de la base : seule la première lettre de
 * chaque partie est touchée, le reste n'est jamais mis en minuscules.
 * S'applique à tout champ portant l'attribut data-nom, quand on le quitte.
 */
(function () {
  'use strict';
  function nomPropre(s) {
    if (s == null) return s;
    var t = String(s), r = '', prec = ' ';
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      r += ' -\'\u2019'.indexOf(prec) !== -1 ? c.toUpperCase() : c;
      prec = c;
    }
    return r;
  }
  window.nomPropre = nomPropre;
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.matches || !el.matches('input[data-nom]')) return;
    var v = nomPropre(el.value);
    if (v !== el.value) {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, true);
})();
