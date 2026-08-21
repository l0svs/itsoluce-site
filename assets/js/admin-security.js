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
