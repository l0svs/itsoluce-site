/**
 * Signature et modèles de mail par défaut (page Messages et Gestion › Messages).
 *
 * Utilisés tant que rien n'est enregistré dans les réglages (clés
 * mail_signature et mail_modeles de la table settings). Dès que tu les
 * modifies dans Gestion, ce sont tes versions qui s'appliquent.
 *
 * Champs remplis automatiquement quand l'information est connue :
 * {nom} {prenom} {appareil} {dossier} {devis}. Les champs {date} et {délai}
 * restent à compléter à la main : l'envoi est bloqué tant qu'il en reste un.
 */
window.MAIL_DEFAUTS = {
  signature: 'Linton Bokolomba\nIT Soluce — Réparation informatique & électronique\n+32 474 05 66 59 · itsoluce.be',
  modeles: [
    {
      cle: 'reponse_demande',
      nom: 'Réponse à votre demande',
      objet: 'Votre demande de réparation — {appareil}',
      corps: 'Bonjour {nom},\n\nMerci pour votre demande concernant votre {appareil}.\n\n\n\nN\'hésitez pas à répondre directement à ce message ou à m\'appeler pour toute question.\n\nBien à vous,'
    },
    {
      cle: 'rdv',
      nom: 'Rendez-vous confirmé',
      objet: 'Rendez-vous confirmé — {appareil}',
      corps: 'Bonjour {nom},\n\nJe vous confirme notre rendez-vous le {date} pour votre {appareil}.\n\nBien à vous,'
    },
    {
      cle: 'pret',
      nom: 'Appareil prêt à récupérer',
      objet: 'Votre {appareil} est prêt — {dossier}',
      corps: 'Bonjour {nom},\n\nLa réparation de votre {appareil} (dossier {dossier}) est terminée : vous pouvez venir le récupérer.\n\nBien à vous,'
    },
    {
      cle: 'piece',
      nom: 'Pièce commandée',
      objet: 'Pièce commandée — {appareil}',
      corps: 'Bonjour {nom},\n\nLa pièce nécessaire à la réparation de votre {appareil} est commandée. Le délai de livraison prévu est de {délai}. Je vous recontacte dès sa réception.\n\nBien à vous,'
    },
    {
      cle: 'relance',
      nom: 'Relance devis',
      objet: 'Votre devis {devis}',
      corps: 'Bonjour {nom},\n\nJe me permets de revenir vers vous au sujet du devis {devis}. Avez-vous pu en prendre connaissance ?\n\nJe reste disponible pour toute question.\n\nBien à vous,'
    }
  ]
};
