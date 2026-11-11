/**
 * Échappement HTML partagé par les pages admin.
 *
 * Beaucoup de champs affichés ici (nom client, email, téléphone, appareil,
 * description de panne...) proviennent à l'origine du formulaire public du
 * site (visiteurs non authentifiés). Ces pages les injectent via innerHTML :
 * sans échappement, un visiteur malveillant pourrait faire exécuter du code
 * dans le navigateur d'un administrateur simplement en remplissant le
 * formulaire de contact avec un "nom" contenant du HTML/JS.
 *
 * Ce script est chargé en tant que script classique (pas de type="module")
 * afin d'être exécuté avant les scripts de page (les modules sont différés
 * par le navigateur) et d'exposer ces fonctions globalement.
 */

/**
 * Échappe une valeur pour une insertion sûre en tant que texte/attribut HTML
 * (utilisation via innerHTML ou dans un attribut délimité par des guillemets
 * doubles, ex: title="${escHtml(x)}").
 */
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/**
 * Échappe une valeur destinée à être insérée dans une chaîne JavaScript
 * délimitée par des apostrophes, elle-même placée dans un attribut HTML
 * délimité par des guillemets doubles — le cas classique d'un gestionnaire
 * inline, ex: onclick="maFonction('${escJsAttr(x)}')".
 *
 * L'échappement HTML seul ne suffit pas ici : le navigateur décode les
 * entités HTML de l'attribut AVANT que le JavaScript ne soit interprété,
 * donc un simple &#39; redeviendrait une apostrophe littérale capable de
 * fermer la chaîne JS. On échappe donc d'abord au niveau JavaScript
 * (antislash, apostrophe, retours à la ligne), puis on échappe le résultat
 * au niveau HTML pour protéger l'attribut englobant.
 */
function escJsAttr(value) {
  const jsSafe = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n');
  return jsSafe.replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}

/**
 * Mise à jour automatique de l'ERP.
 *
 * GitHub Pages autorise les navigateurs à garder une copie des pages
 * (Cache-Control: max-age=600), et Safari sur iPhone la garde parfois bien
 * plus longtemps : après une mise en ligne, l'ERP pouvait continuer à
 * tourner sur l'ancienne version (ancien PDF, ancien mail).
 * À chaque ouverture, on demande au site la date de la version en ligne
 * (sans cache) et on la compare à celle de la page affichée. Si une version
 * plus récente existe, la page est rechargée une fois depuis le site.
 */
(function majAutomatique() {
  try {
    if (!window.fetch || !window.URL) return;
    var locale = Date.parse(document.lastModified);
    if (isNaN(locale)) return;
    var url = location.pathname + '?_v=' + Date.now();
    fetch(url, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
      var lm = r.ok && r.headers.get('last-modified');
      if (!lm) return;
      var enLigne = Date.parse(lm);
      if (isNaN(enLigne) || enLigne <= locale + 1000) return;
      var cle = 'erp-maj:' + location.pathname;
      try {
        if (sessionStorage.getItem(cle) === lm) return;   // une seule tentative par version
        sessionStorage.setItem(cle, lm);
      } catch (e) { /* stockage indisponible : on recharge quand même une fois */ }
      var u = new URL(location.href);
      u.searchParams.set('_maj', String(enLigne));
      location.replace(u.toString());
    }).catch(function () {});
  } catch (e) { /* jamais bloquant */ }
})();
