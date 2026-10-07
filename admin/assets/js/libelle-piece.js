/**
 * Libellé client d'une pièce du stock, pour les lignes de devis et de facture.
 *
 * Le nom d'une pièce importée du catalogue Foneday est le titre fournisseur,
 * en anglais et contenant déjà le modèle (« Battery Samsung Galaxy S23
 * Ultra ») : y recoller le modèle donnait « … S23 Ultra Samsung Galaxy S23
 * Ultra ». Le client lit plutôt « Remplacement batterie Samsung Galaxy S23
 * Ultra ».
 *
 * Une pièce dont le type n'est pas reconnu (service, article saisi à la
 * main…) garde son nom, sans répéter le modèle s'il y figure déjà.
 */
(function () {
  'use strict';

  // Ordre important : le plus précis d'abord (« camera lens » avant « camera »).
  var TYPES = [
    [/drive laser|laser lens|optical/i, 'lentille du lecteur optique'],
    [/camera lens|lens cover|camera glass/i, 'lentille de caméra'],
    [/back cover|back glass|rear glass|backcover/i, 'vitre arrière'],
    [/battery|batterie/i, 'batterie'],
    [/display|screen|lcd|oled|écran|ecran/i, 'écran'],
    [/charging|charge port|dock connector|connecteur de charge/i, 'connecteur de charge'],
    [/hdmi/i, 'port HDMI'],
    [/joystick|thumbstick|analog/i, 'joystick'],
    [/fan|ventilateur/i, 'ventilateur'],
    [/power supply|alimentation/i, 'alimentation'],
    [/loudspeaker|speaker|haut-parleur/i, 'haut-parleur'],
    [/earpiece|ear speaker/i, 'écouteur interne'],
    [/taptic|vibrat|buzzer/i, 'vibreur'],
    [/microphone|\bmic\b/i, 'micro'],
    [/sim (card )?(tray|holder|reader)/i, 'tiroir SIM'],
    [/power.*volume|volume.*power|power button|volume button/i, 'nappe power/volume'],
    [/camera|caméra/i, 'caméra']
  ];
  var CATEGORIES = {
    'Batterie': 'batterie', 'Écran': 'écran', 'Vitre': 'vitre',
    'Connecteur': 'connecteur de charge', 'Caméra': 'caméra', 'Haut-parleur': 'haut-parleur'
  };

  function contient(texte, morceau) {
    return !!morceau && String(texte || '').toLowerCase().indexOf(String(morceau).toLowerCase()) !== -1;
  }

  /** Nom affiché dans la liste « Lier un article du stock » : sans doublon. */
  window.nomArticleStock = function (s) {
    var nom = String(s.nom || '').trim(), modele = String(s.modele || '').trim();
    return modele && !contient(nom, modele) ? (nom + ' ' + modele).trim() : nom;
  };

  /** Libellé pour le client : « Remplacement batterie Samsung Galaxy S23 Ultra ». */
  window.libellePiece = function (s) {
    var nom = String(s.nom || '').trim(), modele = String(s.modele || '').trim();
    var type = null;
    for (var i = 0; i < TYPES.length && !type; i++) if (TYPES[i][0].test(nom)) type = TYPES[i][1];
    if (!type) type = CATEGORIES[s.categorie] || null;
    if (!type) return window.nomArticleStock(s);
    if (!modele) {
      // Modèle absent : on le reprend du titre Foneday (« … For iPhone 16 Pro … »).
      var m = nom.match(/\bfor\s+(.+?)(\s+(oem|service pack|pulled|refurbished|black|white)\b.*)?$/i);
      modele = m ? m[1].replace(/\s*\(.*?\)\s*/g, ' ').trim() : '';
    }
    return ('Remplacement ' + type + (modele ? ' ' + modele : '')).trim();
  };
})();
