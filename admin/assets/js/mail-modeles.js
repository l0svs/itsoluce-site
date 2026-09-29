/**
 * Modèles de mail (page Messages et Gestion › Messages).
 *
 * Tu choisis toi-même le modèle ; son contenu se remplit selon la situation :
 * le client, sa demande, son dossier de réparation, son devis, son rendez-vous.
 * La formule de politesse et la signature sont ajoutées à l'envoi : les
 * modèles s'arrêtent donc avant « Bien à vous ».
 *
 * Champs remplis automatiquement quand l'information existe dans l'ERP :
 *   {prenom} {nom} {appareil} {panne} {dossier} {devis} {montant_devis}
 *   {validite_devis} {date_rdv} {lieu_rdv}
 * Un champ sans information (ex. {délai}) reste visible : l'envoi est bloqué
 * tant qu'il n'est pas complété à la main.
 *
 * Modifiables dans Gestion › Messages (clé de réglage mail_modeles_v2).
 */
window.MAIL_MODELES_DEFAUT = [
  { cle: 'reponse_demande', nom: 'Réponse à votre demande',
    objet: 'Votre demande de réparation — {appareil}',
    corps: 'Bonjour {prenom},\n\nMerci pour votre demande concernant votre {appareil}.\n\n\n\nN\'hésitez pas à répondre directement à ce message ou à m\'appeler pour toute question.' },
  { cle: 'recu', nom: 'Appareil bien reçu',
    objet: 'Appareil bien reçu — {dossier}',
    corps: 'Bonjour {prenom},\n\nJe vous confirme la bonne réception de votre {appareil} (dossier {dossier}).\n\nJe vous tiens informé de l\'avancement de la réparation.' },
  { cle: 'prise_en_charge', nom: 'Devis accepté, réparation lancée',
    objet: 'Votre devis {devis} — prise en charge',
    corps: 'Bonjour {prenom},\n\nMerci pour votre accord sur le devis {devis} ({montant_devis}).\n\nJe lance la réparation de votre {appareil} et je vous tiens informé.' },
  { cle: 'piece', nom: 'Pièce commandée',
    objet: 'Pièce commandée — {appareil}',
    corps: 'Bonjour {prenom},\n\nLa pièce nécessaire à la réparation de votre {appareil} (dossier {dossier}) est commandée. Le délai de livraison prévu est de {délai}.\n\nJe vous recontacte dès sa réception.' },
  { cle: 'pret', nom: 'Appareil prêt à récupérer',
    objet: 'Votre {appareil} est prêt — {dossier}',
    corps: 'Bonjour {prenom},\n\nLa réparation de votre {appareil} (dossier {dossier}) est terminée : vous pouvez venir le récupérer.' },
  { cle: 'non_reparable', nom: 'Appareil non réparable',
    objet: 'Votre {appareil} — résultat du diagnostic',
    corps: 'Bonjour {prenom},\n\nAprès diagnostic, votre {appareil} (dossier {dossier}) ne peut malheureusement pas être réparé.\n\nConformément à mes conditions, le diagnostic de 30 € reste dû. Vous pouvez venir récupérer votre appareil quand vous le souhaitez.' },
  { cle: 'rdv', nom: 'Rendez-vous confirmé',
    objet: 'Rendez-vous confirmé — {date_rdv}',
    corps: 'Bonjour {prenom},\n\nJe vous confirme notre rendez-vous le {date_rdv}.\nLieu : {lieu_rdv}' },
  { cle: 'relance', nom: 'Relance devis',
    objet: 'Votre devis {devis}',
    corps: 'Bonjour {prenom},\n\nJe me permets de revenir vers vous au sujet du devis {devis} d\'un montant de {montant_devis}, valable jusqu\'au {validite_devis}. Avez-vous pu en prendre connaissance ?\n\nJe reste disponible pour toute question.' }
];
