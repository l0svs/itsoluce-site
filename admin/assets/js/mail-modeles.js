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
 *   {validite_devis} {lien_devis} {date_rdv} {lieu_rdv}
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
    corps: 'Bonjour {prenom},\n\nJe me permets de revenir vers vous au sujet du devis {devis} d\'un montant de {montant_devis}, valable jusqu\'au {validite_devis}. Avez-vous pu en prendre connaissance ?\n\nVous pouvez l\'accepter en ligne en un clic.\n{lien_devis}\n\nJe reste disponible pour toute question.' }
];

/**
 * Mails envoyés automatiquement pour le Pack Sérénité (fonction serveur
 * « pack »). Modifiables dans Gestion › Mails (clé de réglage
 * mail_modeles_pack). Même principe : la politesse et la signature sont
 * ajoutées à l'envoi.
 *   {prenom} {pack} {date_fin} {interventions} (contenu du pack, en une phrase) {facture} {montant} {iban}
 *   {lien_espace} : bouton « Ouvrir mon espace client » (seul sur sa ligne)
 * Garder ces textes identiques aux valeurs par défaut de
 * supabase/functions/pack/index.ts.
 */
/**
 * Rappel de rendez-vous envoyé automatiquement 24 h avant (fonction serveur
 * « rappel-rdv »). Modifiable dans Gestion › Mails (clé mail_modele_rappel_rdv).
 *   {prenom} {date_rdv} {heure_rdv} {lieu_rdv} {objet_rdv}
 * Sans lieu, la ligne qui contient {lieu_rdv} disparaît.
 * Garder ce texte identique à supabase/functions/rappel-rdv/index.ts.
 */
window.MAIL_MODELE_RAPPEL_RDV_DEFAUT = {
  objet: 'Rappel : votre rendez-vous du {date_rdv}',
  corps: 'Bonjour {prenom},\n\nPetit rappel : nous avons rendez-vous le {date_rdv} à {heure_rdv}.\nLieu : {lieu_rdv}\n\nEn cas d\'empêchement, merci de me prévenir en répondant à ce mail ou par téléphone.'
};

window.MAIL_MODELES_PACK_DEFAUT = {
  pack_achat: { nom: 'Pack payé : facture et accès à l\'espace client',
    objet: 'Votre {pack} est actif — facture {facture}',
    corps: 'Bonjour {prenom},\n\nMerci pour votre confiance.\nVotre {pack} est actif jusqu\'au {date_fin} : {interventions}.\n\nVous trouverez votre facture {facture} ({montant}, payée) en pièce jointe.\n\n{lien_espace}\n\nPour votre première intervention, appelez-moi ou répondez simplement à ce mail.' },
  pack_facture: { nom: 'Pack vendu sur place, paiement à venir',
    objet: 'Votre {pack} — facture {facture}',
    corps: 'Bonjour {prenom},\n\nVous trouverez en pièce jointe la facture {facture} de votre {pack} : {montant} à régler par virement sur le compte {iban} (communication : {facture}).\n\nVotre pack s\'active dès réception du paiement.' },
  pack_lien: { nom: 'Lien de connexion à l\'espace client',
    objet: 'Votre lien de connexion — IT Soluce',
    corps: 'Bonjour,\n\nVoici votre lien pour ouvrir votre espace client IT Soluce :\n\n{lien_espace}\n\nSi vous n\'avez rien demandé, ignorez simplement ce message.' },
  pack_acces: { nom: 'Accès à l\'espace client (envoyé depuis l\'ERP)',
    objet: 'Votre espace client IT Soluce',
    corps: 'Bonjour {prenom},\n\nVotre espace client est prêt : vous y suivez votre Pack Sérénité (interventions restantes, historique) et vos factures.\n\n{lien_espace}' }
};
