-- Demandes du site : statut « En attente client » (réponse demandée au client).
-- NULL = pas en attente. La date sert à afficher « depuis N jours ».
alter table public.demandes_formulaire
  add column if not exists en_attente_depuis timestamptz;
